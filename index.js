#!/usr/bin/env node
/**
 * OTM Agent CLI
 *
 * Accepts a plain-English task and runs an agentic loop using the AI provider
 * of your choice to complete multi-step OTM territory management workflows.
 *
 * Usage:
 *   node index.js "Show me all available territories"
 *   node index.js --provider openai "Assign territory 42 to Jane Smith"
 *   node index.js --provider groq --model llama-3.3-70b-versatile "Return territory 7"
 *   echo "List publishers" | node index.js --provider openai
 */

import 'dotenv/config';
import readline from 'readline';
import { OTM_TOOLS, callTool } from './mcp-server.js';
import { runAgentLoop, PROVIDERS, DEFAULT_MODELS } from './providers.js';
import session from './browser.js';

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let provider = process.env.AI_PROVIDER ?? 'anthropic';
  let model;
  const taskParts = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' || args[i] === '-p') {
      provider = args[++i];
    } else if (args[i] === '--model' || args[i] === '-m') {
      model = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      taskParts.push(args[i]);
    }
  }

  return { provider, model, taskArg: taskParts.join(' ').trim() };
}

function printHelp() {
  console.log(`
OTM Agent CLI — automates Online Territory Manager with AI

Usage:
  node index.js [options] "<task>"

Options:
  --provider, -p  AI provider to use: anthropic | openai | groq
                  (default: anthropic, or AI_PROVIDER env var)
  --model, -m     Override the model (default per provider shown below)
  --help, -h      Show this help

Default models:
${PROVIDERS.map((p) => `  ${p.padEnd(12)} ${DEFAULT_MODELS[p]}`).join('\n')}

Examples:
  node index.js "Show me all available territories"
  node index.js --provider openai "Assign territory 42 to Jane Smith"
  node index.js --provider groq "What territories does John Doe have?"
  node index.js --provider openai --model gpt-4o-mini "List publishers"
  node index.js --provider groq --model moonsong-coder-32b "Return territory 15"
  HEADLESS=false node index.js "Take a screenshot"
  echo "List territories" | node index.js --provider groq
`);
}

// ── Task input ───────────────────────────────────────────────────────────────

async function getTask(taskArg) {
  if (taskArg) return taskArg;

  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let input = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => (input += chunk));
      process.stdin.on('end', () => resolve(input.trim()));
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter OTM task: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert territory management assistant for a Jehovah's Witness congregation using Online Territory Manager (OTM) at https://onlineterritorymanager.com.

You have access to browser automation tools that let you interact with OTM directly. Use them to complete the user's request accurately and efficiently.

Guidelines:
- Always verify the current state before making changes (check status before assigning/returning).
- If a tool returns an error, analyze it and try an alternative approach (different selector, different navigation path).
- If you need more information about the page structure, use get_page_content or take_screenshot.
- Summarize what you did clearly at the end, including any territory numbers, publisher names, and dates involved.
- If you cannot complete a step, explain exactly why and what the user should do manually.
- Today's date is ${new Date().toISOString().split('T')[0]}.`;

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const { provider, model, taskArg } = parseArgs(process.argv);

  if (!PROVIDERS.includes(provider)) {
    console.error(`Unknown provider "${provider}". Choose from: ${PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const task = await getTask(taskArg);
  if (!task) {
    console.error('No task provided. Pass a task as a CLI argument or via stdin.');
    printHelp();
    process.exit(1);
  }

  const resolvedModel = model ?? DEFAULT_MODELS[provider];

  console.log(`\n[Agent] Provider : ${provider}`);
  console.log(`[Agent] Model    : ${resolvedModel}`);
  console.log(`[Agent] Task     : ${task}`);
  console.log('─'.repeat(60));

  try {
    await runAgentLoop({
      task,
      provider,
      model: resolvedModel,
      systemPrompt: SYSTEM_PROMPT,
      tools: OTM_TOOLS,
      callTool,
      onText: (text) => console.log(`\n[${provider}] ${text}`),
      onToolCall: (name, input) =>
        console.log(`\n[Tool] → ${name}`, JSON.stringify(input, null, 2)),
      onToolResult: (name, result) =>
        console.log(`[Tool] ← ${name}:`, result.slice(0, 500), result.length > 500 ? '...' : ''),
    });

    console.log('\n[Agent] Task complete.');
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
