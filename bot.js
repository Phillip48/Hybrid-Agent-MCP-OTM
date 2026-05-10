#!/usr/bin/env node
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { getUser, setUser, getAllUsers, isAllowed, isRegistered } from './store.js';
import sessionManager from './sessions.js';
import { OTM_TOOLS, createCallTool } from './mcp-server.js';
import { runAgentLoop, DEFAULT_MODELS, PROVIDERS } from './providers.js';
import OpenAI from 'openai';
import { OTM_KNOWLEDGE } from './otm-knowledge.js';
import { BrowserSession } from './browser.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PROVIDER  = 'gemini';
const MODEL     = DEFAULT_MODELS[PROVIDER];

if (!TOKEN) {
  console.error('[bot] TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

// ── In-memory state ───────────────────────────────────────────────────────────

const setupState  = new Map(); // userId -> { step, data }
const activeTasks = new Set(); // userIds with a running task

// Conversation history: userId -> { messages: [{role,content},...], lastActivity: ms }
// Kept for 30 minutes of inactivity, capped at last 6 messages (3 exchanges).
const chatHistory = new Map();

function getHistory(userId) {
  const h = chatHistory.get(userId);
  if (!h) return [];
  if (Date.now() - h.lastActivity > 30 * 60 * 1000) {
    chatHistory.delete(userId);
    return [];
  }
  return h.messages;
}

function appendHistory(userId, userMsg, assistantMsg) {
  const h = chatHistory.get(userId) ?? { messages: [], lastActivity: 0 };
  h.messages.push(
    { role: 'user',      content: userMsg },
    { role: 'assistant', content: assistantMsg },
  );
  // Keep last 6 messages (3 exchanges) so context doesn't grow unbounded.
  if (h.messages.length > 6) h.messages = h.messages.slice(-6);
  h.lastActivity = Date.now();
  chatHistory.set(userId, h);
}

function clearHistory(userId) {
  chatHistory.delete(userId);
}

// ── Logging helpers ───────────────────────────────────────────────────────────

const LOG_RING = []; // circular buffer of recent log lines (newest last)
const LOG_RING_MAX = 30;

function pushLog(line) {
  LOG_RING.push(line);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}

function log(userId, ...args)  {
  const line = `[bot:${userId}] ${args.join(' ')}`;
  console.log(line);
  pushLog(line);
}
function warn(userId, ...args) { console.warn( `[bot:${userId}]`, ...args); }
function err(userId, ...args)  { console.error(`[bot:${userId}]`, ...args); }

// ── Provider probe ────────────────────────────────────────────────────────────

let geminiProbeCache = null; // { result, ts }
const GEMINI_PROBE_TTL = 60_000; // reuse result for 60s to avoid burning RPM slots

async function probeGemini() {
  if (geminiProbeCache && Date.now() - geminiProbeCache.ts < GEMINI_PROBE_TTL) {
    return { ...geminiProbeCache.result, cached: true };
  }
  const client = new OpenAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env.GEMINI_API_KEY,
  });
  const t0 = Date.now();
  let result;
  try {
    await client.chat.completions.create({
      model: DEFAULT_MODELS.gemini,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    result = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    const status = e?.status ?? e?.response?.status;
    const body   = e?.message || '';
    const isRateLimit = status === 429 || body.includes('429') || body.toLowerCase().includes('quota') || body.toLowerCase().includes('rate');
    result = { ok: false, rateLimit: isRateLimit, ms: Date.now() - t0, error: body.slice(0, 120) };
  }
  geminiProbeCache = { result, ts: Date.now() };
  return result;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

const isAdmin = (userId) => ADMIN_IDS.includes(String(userId));

function startTyping(ctx) {
  ctx.sendChatAction('typing').catch(() => {});
  const interval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
  return () => clearInterval(interval);
}

async function safeEdit(ctx, msgId, text) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text);
  } catch {
    await ctx.reply(text);
  }
}

// ── Registration wizard ───────────────────────────────────────────────────────

async function startSetup(ctx) {
  const userId = String(ctx.from.id);
  log(userId, 'Starting setup wizard');
  setupState.set(userId, { step: 'email', data: {} });
  clearHistory(userId); // fresh credentials = fresh conversation
  await ctx.reply('🔧 *OTM Setup*\n\nWhat is your OTM username?', { parse_mode: 'Markdown' });
}

async function handleSetupStep(ctx, userId, text) {
  const state = setupState.get(userId);
  if (!state) return false;

  if (state.step === 'email') {
    state.data.otmUser = text.trim();
    state.step = 'password';
    log(userId, `Setup step 1/2 — username received: ${state.data.otmUser}`);
    await ctx.reply(
      '🔑 Got it. Now send your OTM password.\n\n_I will delete your message immediately after saving it._',
      { parse_mode: 'Markdown' },
    );
    return true;
  }

  if (state.step === 'password') {
    const otmPass = text.trim();
    log(userId, 'Setup step 2/2 — password received, deleting message and testing login');

    try { await ctx.deleteMessage(); } catch (e) {
      warn(userId, 'Could not delete password message:', e.message);
    }

    setupState.delete(userId);
    const statusMsg = await ctx.reply('⏳ Testing your OTM login...');
    const stopTyping = startTyping(ctx);

    try {
      log(userId, 'Launching test browser session');
      const testSession = new BrowserSession({ userId: `test_${userId}`, otmUser: state.data.otmUser, otmPass });
      await testSession.ensureLoggedIn();
      await testSession.close();
      log(userId, 'Test login successful — saving credentials');

      await setUser(userId, { otmUser: state.data.otmUser, otmPass, registered: true });

      // Destroy any stale session, then pre-build and authenticate the real one
      // so the first task doesn't have to wait for a cold login.
      await sessionManager.destroy(userId);
      log(userId, 'Pre-authenticating real session');
      const realSession = sessionManager.getOrCreate(userId, {
        otmUser: state.data.otmUser,
        otmPass,
      });
      await realSession.ensureLoggedIn();
      log(userId, 'Pre-auth complete — session is ready');

      stopTyping();
      log(userId, 'Setup complete');
      await safeEdit(ctx, statusMsg.message_id,
        `✅ *Connected!* Your OTM account is set up.\n\nJust send me a task:\n• "Show me all available territories"\n• "Assign territory 42 to Jane Smith"\n• "Return territory 7"`,
      );
    } catch (e) {
      stopTyping();
      err(userId, 'Login test failed:', e.message);
      await safeEdit(ctx, statusMsg.message_id,
        `❌ *Login failed:* ${e.message}\n\nPlease /setup again with correct credentials.`,
      );
    }
    return true;
  }

  return false;
}

// ── Task runner ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an OTM (Online Territory Manager) automation assistant. You control a real browser to complete territory management tasks accurately.

${OTM_KNOWLEDGE}

---

## Browser Automation Rules

## OTM Site Structure
- GetStandard.php — Territory list. Left panel = table of territories. Right panel (#listter) = territory details loaded via AJAX when a territory is clicked.
- GetStandard.php?code=A — All territories. GetStandard.php?code=B — Available only.
- MyTer.php?showallmyter=1 — Checked-out admin view. Lists every currently checked-out territory with publisher and date.
- Users.php — Publisher/user list.
- Territories are color-coded: ORANGE = not worked in 6 months, RED = not worked in 1 year.
- Each territory has: number (e.g. OR-15A), description, # available addresses, last worked date, last check-in date.

## Checkout Flow (exactly how OTM works)
1. The territory list loads in the left panel. Clicking a territory loads its details in the RIGHT panel (#listter).
2. The right panel shows a "CHECK OUT" button.
3. Clicking "CHECK OUT" shows a list of ALL publishers, each with a "Yes!" link next to their name and how many territories they currently have checked out.
4. Clicking the publisher's "Yes!" button checks the territory out to them. OTM then shows "Congratulations! Territory #XX has been checked out to [name]."
5. The checkout_territory tool handles ALL of these steps automatically. Just provide the territory number and publisher name.

## Return Flow (exactly how OTM works)
1. Navigate to MyTer.php?showallmyter=1&sort=1 (Checked Out Admin view).
2. Enable Admin Options on the page (toggle/button) — this makes the check-in button appear.
3. The check-in button is an IMAGE link (no visible text) pointing to PreCheckIn.php?MyTerID=XXXX&MyTerDescr=TERRITORY_NUMBER-...
4. After clicking check-in, OTM asks about routing — always click the "No" button (input[name="No"]).
5. The return_territory tool handles all of these steps automatically.

## Tool Usage Rules
- NEVER guess territory numbers. Use search_territories or list_territories first if unsure.
- checkout_territory handles the full flow — only use it once per request.
- If checkout_territory returns availableOptions, the publisher name didn't match. Pick the closest name from availableOptions and retry.
- If checkout_territory says "already checked out", use get_territory_status to confirm, then report to the user.
- For return: use return_territory. If it returns availableLinks, use one of those link texts with click_panel_button.
- NEVER call the same tool more than twice in a row. If a tool returns the same result twice, stop and tell the user what happened.
- If the user is asking a follow-up question about data already present in this conversation (e.g. "what is the total for X and Y" after a report was already pulled), answer directly using that data WITHOUT calling any tools. Just do the math or reference the numbers already shown.
- If checkout_territory returns already_checked_out=true, stop immediately and tell the user exactly who has the territory and since when. Do NOT attempt to check it out again.
- When adding an address, ALWAYS use the add_address tool — it automatically checks for duplicates first and only adds if the address doesn't exist.
- For add_address: territory and address type are always left as default (NA / Residential) — never set them. Language always defaults to Portuguese. Only set confirmed=true if the user explicitly says to mark it confirmed. If city or zip are missing, the tool will look them up (address is always in Central Florida).
- If the user says "add 123 Main St" with no city/zip, pass what you have — the tool handles the lookup.

## Exact Workflow: Checking Out
1. search_territories to confirm exact territory number (e.g. "OR-15A")
2. checkout_territory with territory_number and publisher_name
3. If success=true → done, report it
4. If availableOptions returned → retry checkout_territory with the closest matching name from availableOptions

## Exact Workflow: Returning
1. list_checked_out to confirm it is currently out
2. return_territory with the territory number
3. If availableLinks returned → click_panel_button with the correct link text

## Exact Workflow: Listing/Querying
- All territories: list_territories
- Available only: list_territories with status_filter="available"
- Currently checked out: list_checked_out
- Find specific territory: search_territories with name or number
- Who has a territory: get_territory_status

## Publisher Names
- Publisher names in OTM follow "First Last" format.
- checkout_territory does partial matching — "Phillip" will match "Phillip Pereira" if he's the only Phillip.
- If unsure of the name, use list_publishers first to see all publishers.

## Available Reports
Use the report tools when asked about statistics, history, or exports:
- report_worked_log — when each territory was last worked and checked in/out. Use to find territories not worked in a long time.
- report_territory_list — full territory list with all details. Good for a complete overview.
- report_checkinout — official S-13 style check in/out history. Version 2 is the most useful.
- report_group_stats — territory coverage statistics per service group.
- report_stats_by_grouping — stats broken down by territory grouping/type.
- report_address_demographics — breakdown of address types across territories.
- report_territory_export — exportable full territory list.

## Territory Color Coding
- ORANGE = territory not worked in 6 months
- RED = territory not worked in 1 year
- These appear in the lastWorked column of list_territories results.

## Territory Groupings
OTM supports grouping territories by type. The GetStandard.php page has a dropdown to filter by grouping. Use navigate_page with "GetStandard.php?code=G&TerGroupID=XXXX" for a specific group.

## Custom Territories
MakeCustom.php allows checking out custom territories. Use navigate_page to access it.

## My Territory Folder
MyTer.php?showallmyter=0 shows only the logged-in user's checked-out territories.
MyTer.php?showallmyter=1 shows ALL checked-out territories (admin view).

## Today's date: ${new Date().toISOString().split('T')[0]}

## Critical Rules — READ CAREFULLY
- ALWAYS call the tools. NEVER respond with instructions for the user to follow manually. You have browser access — use it.
- If a tool returns { error: true, message: "..." }, quote the exact message back to the user. Do NOT paraphrase it as "authentication" or "login" issues — just report what the tool said.
- If a tool returns data that looks like a login page (contains "Please Login" or "username" fields), call navigate_page with "/GetStandard.php" to force a fresh login, then retry the original tool.
- NEVER say "you would need to log in" or "you would need to navigate to...". You are the one doing it. Do it.
- If a report tool fails, try list_territories or get_page_content to verify the session is active, then retry.`;

async function runTask(ctx, userId, task) {
  if (activeTasks.has(userId)) {
    log(userId, 'Task rejected — another task is already active');
    await ctx.reply('⏳ Still working on your previous task. Please wait.');
    return;
  }

  console.log('─'.repeat(60));
  log(userId, `Task received: "${task}"`);

  const history  = getHistory(userId);
  if (history.length > 0) log(userId, `Resuming conversation — ${history.length / 2} prior exchange(s) in context`);

  const user           = await getUser(userId);
  const configProvider = user.provider || process.env.AI_PROVIDER || 'anthropic';
  // Always try Gemini first (free), then Groq (free), then the user's configured fallback.
  const PROVIDER       = 'gemini';
  const MODEL          = DEFAULT_MODELS['gemini'];
  const FALLBACK_CHAIN = ['groq', configProvider !== 'gemini' && configProvider !== 'groq' ? configProvider : 'anthropic']
    .filter((v, i, a) => a.indexOf(v) === i);

  log(userId, `Provider chain: ${[PROVIDER, ...FALLBACK_CHAIN].join(' → ')}`);
  const browserSession = sessionManager.getOrCreate(userId, {
    otmUser: user.otmUser,
    otmPass: user.otmPass,
  });
  const callTool = createCallTool(browserSession);

  activeTasks.add(userId);
  const stopTyping = startTyping(ctx);
  const statusMsg  = await ctx.reply('⏳ Working on it...');

  const toolLog   = [];
  let   finalText = '';
  let   turnCount = 0;

  // Routing needs more time — Census geocoding is fast but form navigation adds overhead.
  const isRoutingTask = /\broute\b/i.test(task);
  const isLongTask    = /\bgated\b/i.test(task);
  const TIMEOUT_MS    = isRoutingTask ? 240_000 : isLongTask ? 120_000 : 75_000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Task timed out after ${TIMEOUT_MS / 1000}s. Try a simpler or more specific request.`)), TIMEOUT_MS)
  );

  // For routing tasks, send a progress update every 25s so Telegram doesn't go silent.
  let routingProgressInterval = null;
  if (isRoutingTask) {
    let progressCount = 0;
    const progressMessages = [
      '⏳ Geocoding addresses...',
      '⏳ Still geocoding — almost done...',
      '⏳ Sorting by distance from home base...',
      '⏳ Saving route to OTM...',
    ];
    routingProgressInterval = setInterval(() => {
      const msg = progressMessages[Math.min(progressCount, progressMessages.length - 1)];
      progressCount++;
      log(userId, `[routing progress] ${msg}`);
      safeEdit(ctx, statusMsg.message_id, msg).catch(() => {});
    }, 25_000);
  }

  try {
    await Promise.race([
      runAgentLoop({
        task,
        provider: PROVIDER,
        model: MODEL,
        fallbackChain: FALLBACK_CHAIN,
        systemPrompt: SYSTEM_PROMPT,
        tools: OTM_TOOLS,
        callTool,
        priorMessages: history,
        onFallback: (fallback, reason) => {
          log(userId, `Provider failed (${reason}), switching to ${fallback}`);
          // If Gemini just rate-limited, mark the probe cache so /status shows it immediately.
          if (reason.toLowerCase().includes('gemini') || (fallback !== 'gemini' && reason.toLowerCase().includes('rate'))) {
            geminiProbeCache = { result: { ok: false, rateLimit: true, ms: 0, error: reason.slice(0, 120) }, ts: Date.now() };
          }
          safeEdit(ctx, statusMsg.message_id, `⚡ Switching to ${fallback}...\n\`\`\`\n${toolLog.join('\n') || '(no tools called yet)'}\n\`\`\``).catch(() => {});
        },
        onText: (text) => {
          finalText = text;
          turnCount++;
          log(userId, `[turn ${turnCount}] Model response (${text.length} chars)`);
        },
        onToolCall: (name, input) => {
          const inputStr = JSON.stringify(input);
          log(userId, `[tool →] ${name} ${inputStr}`);
          toolLog.push(`→ ${name}`);
          if (toolLog.length <= 10) {
            safeEdit(ctx, statusMsg.message_id, `⏳ Working...\n\`\`\`\n${toolLog.join('\n')}\n\`\`\``).catch(() => {});
          }
        },
        onToolResult: (name, result) => {
          const preview = result.slice(0, 200).replace(/\n/g, ' ');
          log(userId, `[tool ←] ${name}: ${preview}${result.length > 200 ? '…' : ''}`);
        },
      }),
      timeoutPromise,
    ]);

    stopTyping();
    if (routingProgressInterval) clearInterval(routingProgressInterval);
    log(userId, `Task complete — ${toolLog.length} tool calls, ${turnCount} AI turns`);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}

    // Send tool summary (safe Markdown code block) separately from AI text (plain).
    if (toolLog.length > 0) {
      const summary = `\`\`\`\n${toolLog.slice(0, 10).join('\n')}${toolLog.length > 10 ? `\n…+${toolLog.length - 10} more` : ''}\n\`\`\``;
      await ctx.reply(summary, { parse_mode: 'Markdown' }).catch(() => ctx.reply(toolLog.join('\n')));
    }

    const responseText = finalText || '✅ Task complete.';
    // Always send AI response as plain text to avoid Markdown parse errors.
    await ctx.reply(responseText);

    // Save to conversation history so follow-up questions have context.
    appendHistory(userId, task, responseText);

  } catch (e) {
    stopTyping();
    if (routingProgressInterval) clearInterval(routingProgressInterval);
    err(userId, 'Task failed:', e.message);

    // Delete the stale "Working..." message — Telegram may reject edits on old messages.
    try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}

    const isTimeout = e.message.includes('timed out');
    const errorMsg  = isTimeout
      ? `⏱ Task timed out (75s limit reached).\n\nThe browser was still working but ran out of time. Try again with a more specific request, e.g:\n• "Return territory OR-15A"\n• "Checkout territory OR-15A to John Smith"\n\nIf it keeps timing out, send /debug to check the session.`
      : `❌ ${e.message}`;

    // Send as a fresh reply — more reliable than editing after a long delay.
    await ctx.reply(errorMsg).catch((replyErr) => {
      err(userId, 'Failed to send error reply:', replyErr.message);
    });

  } finally {
    activeTasks.delete(userId);
  }
}

// ── Access middleware ─────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  const userId   = String(ctx.from.id);
  const username = ctx.from.username || ctx.from.first_name || 'unknown';

  if (isAdmin(userId)) {
    log(userId, `Admin message from @${username}`);
    return next();
  }

  if (!(await isAllowed(userId))) {
    log(userId, `Blocked — not allowed. Username: @${username}`);
    await setUser(userId, { allowed: false, displayName: username });
    await ctx.reply(
      `👋 Hi! Your Telegram ID is \`${userId}\`.\n\nAsk the bot admin to allow you, then send /start.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  log(userId, `Message from @${username}`);
  return next();
});

// ── Commands ──────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  log(userId, '/start');
  if (await isRegistered(userId)) {
    await ctx.reply(
      `👋 Welcome back! Just send me a task:\n• "Show me all available territories"\n• "Assign territory 42 to Jane Smith"\n• "Return territory 7"\n\nType /status to check your connection or /setup to change credentials.`,
    );
  } else {
    await ctx.reply(`👋 Welcome! Let's connect your OTM account.`);
    await startSetup(ctx);
  }
});

bot.command('setup', async (ctx) => {
  log(String(ctx.from.id), '/setup');
  await startSetup(ctx);
});

bot.command('status', async (ctx) => {
  const userId = String(ctx.from.id);
  log(userId, '/status');
  const user = await getUser(userId);
  if (!user?.registered) {
    await ctx.reply('Not set up yet. Send /setup to connect your OTM account.');
    return;
  }

  const msg = await ctx.reply('⏳ Checking providers...');

  const [geminiResult] = await Promise.all([probeGemini()]);
  const cachedNote = geminiResult.cached ? ' _(cached)_' : '';
  const geminiStatus = geminiResult.ok
    ? `✅ Gemini OK (${geminiResult.ms}ms)${cachedNote}`
    : geminiResult.rateLimit
      ? `⚠️ Gemini rate-limited (429)${cachedNote}`
      : `❌ Gemini error: ${geminiResult.error}${cachedNote}`;

  const active       = activeTasks.has(userId) ? '\n🔄 A task is currently running.' : '';
  const lastFallback = user.provider || process.env.AI_PROVIDER || 'anthropic';
  const chain        = ['gemini', 'groq', lastFallback].filter((v, i, a) => a.indexOf(v) === i);
  const providerLine = `Chain: \`${chain.join(' → ')}\``;

  const recentLogs = LOG_RING.slice(-15).join('\n') || '(no recent activity)';

  const statusText = `*OTM Bot Status*\n\nAccount: \`${user.otmUser}\`\n${providerLine}\n${geminiStatus}${active}\n\n*Recent logs:*\n\`\`\`\n${recentLogs}\n\`\`\`\n\nSend /setup to update credentials or /setprovider to change fallback.`;
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, statusText, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(statusText, { parse_mode: 'Markdown' });
  }
});

bot.command('cancel', async (ctx) => {
  const userId = String(ctx.from.id);
  log(userId, '/cancel');
  if (setupState.has(userId)) {
    setupState.delete(userId);
    await ctx.reply('Setup cancelled.');
  } else {
    await ctx.reply('Nothing to cancel.');
  }
});

bot.command('myid', async (ctx) => {
  log(String(ctx.from.id), '/myid');
  await ctx.reply(`Your Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

bot.command('debug', async (ctx) => {
  const userId = String(ctx.from.id);
  log(userId, '/debug — testing session');
  const msg = await ctx.reply('⏳ Testing OTM session...');
  const stopTyping = startTyping(ctx);

  try {
    const user = await getUser(userId);
    if (!user?.registered) {
      stopTyping();
      await safeEdit(ctx, msg.message_id, '❌ Not registered. Run /setup first.');
      return;
    }

    const browserSession = sessionManager.getOrCreate(userId, {
      otmUser: user.otmUser,
      otmPass: user.otmPass,
    });

    log(userId, 'Calling ensureLoggedIn');
    await browserSession.ensureLoggedIn();
    const url = await browserSession.getCurrentUrl();
    log(userId, `Session URL after login: ${url}`);

    // Try navigating to the territory list to confirm full access.
    const landed = await browserSession.navigate('/GetStandard.php');
    const pageText = await browserSession.evaluate(() => document.title + ' | ' + document.body.innerText.slice(0, 200));

    stopTyping();
    log(userId, `Debug complete. Landed: ${landed}`);
    await safeEdit(ctx, msg.message_id,
      `✅ Session active\nURL: ${landed}\nPage: ${pageText.slice(0, 300)}`
    );
  } catch (e) {
    stopTyping();
    err(userId, 'Debug failed:', e.message);
    await safeEdit(ctx, msg.message_id, `❌ Session error: ${e.message}`);
  }
});

bot.command('setprovider', async (ctx) => {
  const userId = String(ctx.from.id);
  const parts  = ctx.message.text.trim().split(/\s+/);
  const newProvider = parts[1]?.toLowerCase();
  const newModel    = parts[2]; // optional

  log(userId, `/setprovider ${newProvider ?? '(none)'} ${newModel ?? ''}`);

  if (!newProvider) {
    const user    = await getUser(userId);
    const current = user?.provider || process.env.AI_PROVIDER || 'anthropic';
    const currentModel = user?.model || DEFAULT_MODELS[current];
    const lines = PROVIDERS.map(p =>
      `${p === current ? '✅' : '•'} *${p}* — default: \`${DEFAULT_MODELS[p]}\``
    ).join('\n');
    await ctx.reply(
      `*Current:* \`${current}\` / \`${currentModel}\`\n\n${lines}\n\nUsage:\n\`/setprovider openai\`\n\`/setprovider openai gpt-4o-mini\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (!PROVIDERS.includes(newProvider)) {
    await ctx.reply(`❌ Unknown provider. Choose from: ${PROVIDERS.join(', ')}`);
    return;
  }

  await setUser(userId, { provider: newProvider, model: newModel ?? null });
  const resolvedModel = newModel || DEFAULT_MODELS[newProvider];
  log(userId, `Provider updated to ${newProvider} / ${resolvedModel}`);
  await ctx.reply(`✅ Provider set to *${newProvider}* — model: \`${resolvedModel}\``, { parse_mode: 'Markdown' });
});

// ── Admin commands ────────────────────────────────────────────────────────────

bot.command('allow', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!isAdmin(adminId)) { await ctx.reply('❌ Admin only.'); return; }
  const targetId = ctx.message.text.split(' ')[1]?.trim();
  if (!targetId) { await ctx.reply('Usage: /allow <telegram_user_id>'); return; }
  log(adminId, `/allow ${targetId}`);
  await setUser(targetId, { allowed: true });
  await ctx.reply(`✅ User ${targetId} is now allowed.`);
  try {
    await ctx.telegram.sendMessage(targetId, '✅ You have been approved! Send /start to set up your OTM account.');
    log(adminId, `Approval notification sent to ${targetId}`);
  } catch (e) {
    warn(adminId, `Could not notify user ${targetId}:`, e.message);
  }
});

bot.command('deny', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!isAdmin(adminId)) { await ctx.reply('❌ Admin only.'); return; }
  const targetId = ctx.message.text.split(' ')[1]?.trim();
  if (!targetId) { await ctx.reply('Usage: /deny <telegram_user_id>'); return; }
  log(adminId, `/deny ${targetId}`);
  await setUser(targetId, { allowed: false });
  await ctx.reply(`✅ User ${targetId} has been denied.`);
});

bot.command('users', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!isAdmin(adminId)) { await ctx.reply('❌ Admin only.'); return; }
  log(adminId, '/users');
  const users = await getAllUsers();
  if (users.length === 0) { await ctx.reply('No users yet.'); return; }
  const lines = users.map(u =>
    `• ${u.userId}${u.displayName ? ` (${u.displayName})` : ''} — ${u.allowed ? '✅ allowed' : '🚫 pending'}${u.registered ? ' | 🔑 registered' : ''}`,
  );
  await ctx.reply(`*Users:*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.command('restart', async (ctx) => {
  const adminId = String(ctx.from.id);
  if (!isAdmin(adminId)) { await ctx.reply('❌ Admin only.'); return; }
  log(adminId, '/restart');
  await ctx.reply('🔄 Restarting bot...');
  setTimeout(() => process.exit(0), 500);
});

// ── Main message handler ──────────────────────────────────────────────────────

bot.on(message('text'), async (ctx) => {
  const userId = String(ctx.from.id);
  const text   = ctx.message.text.trim();

  if (setupState.has(userId)) {
    log(userId, `Setup wizard input at step: ${setupState.get(userId).step}`);
    await handleSetupStep(ctx, userId, text);
    return;
  }

  if (!(await isRegistered(userId))) {
    log(userId, 'Message rejected — not registered');
    await ctx.reply('Please run /setup first to connect your OTM account.');
    return;
  }

  await runTask(ctx, userId, text);
});

// ── Launch ────────────────────────────────────────────────────────────────────

bot.launch().then(async () => {
  console.log('');
  console.log('[bot] ✅ OTM Telegram Bot is running');
  console.log(`[bot]    Provider : ${PROVIDER}`);
  console.log(`[bot]    Model    : ${MODEL}`);
  console.log(`[bot]    Admins   : ${ADMIN_IDS.join(', ') || '(none set — set TELEGRAM_ADMIN_IDS in .env)'}`);
  console.log('');

  // Register user-facing commands (shown in Telegram's "/" menu).
  await bot.telegram.setMyCommands([
    { command: 'start',       description: 'Welcome message and quick-start examples' },
    { command: 'status',      description: 'Check connection, Gemini availability, and recent logs' },
    { command: 'setup',       description: 'Connect or update your OTM account credentials' },
    { command: 'setprovider', description: 'Change the last-resort AI fallback provider' },
    { command: 'debug',       description: 'Test your OTM browser session' },
    { command: 'myid',        description: 'Show your Telegram user ID' },
    { command: 'cancel',      description: 'Cancel the current setup wizard' },
  ]).catch(e => console.warn('[bot] setMyCommands failed:', e.message));

  // Register admin-only commands in each admin's private chat.
  for (const adminId of ADMIN_IDS) {
    await bot.telegram.setMyCommands([
      { command: 'start',       description: 'Welcome message and quick-start examples' },
      { command: 'status',      description: 'Check connection, Gemini availability, and recent logs' },
      { command: 'setup',       description: 'Connect or update your OTM account credentials' },
      { command: 'setprovider', description: 'Change the last-resort AI fallback provider' },
      { command: 'debug',       description: 'Test your OTM browser session' },
      { command: 'myid',        description: 'Show your Telegram user ID' },
      { command: 'cancel',      description: 'Cancel the current setup wizard' },
      { command: 'allow',       description: '[Admin] Allow a user by Telegram ID' },
      { command: 'deny',        description: '[Admin] Remove a user by Telegram ID' },
      { command: 'users',       description: '[Admin] List all registered users' },
      { command: 'restart',     description: '[Admin] Restart the bot process' },
    ], { scope: { type: 'chat', chat_id: Number(adminId) } })
      .catch(e => console.warn(`[bot] setMyCommands for admin ${adminId} failed:`, e.message));
  }
}).catch(e => {
  console.error('[bot] Failed to start:', e.message);
  process.exit(1);
});

process.once('SIGINT',  () => { console.log('\n[bot] Shutting down...'); bot.stop('SIGINT');  sessionManager.destroyAll(); });
process.once('SIGTERM', () => { console.log('\n[bot] Shutting down...'); bot.stop('SIGTERM'); sessionManager.destroyAll(); });
