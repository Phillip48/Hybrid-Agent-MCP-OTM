import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';

export const PROVIDERS = ['gemini', 'anthropic', 'openai', 'groq'];

export const DEFAULT_MODELS = {
  gemini:    'gemini-2.0-flash',        // free tier, already the lightweight model
  anthropic: 'claude-haiku-4-5-20251001', // Haiku 4.5 — cheapest Claude with tool use
  openai:    'gpt-4o-mini',             // ~15x cheaper than gpt-4o, reliable tool use
  groq:      'llama-3.3-70b-versatile', // free; smaller models are unreliable for tool use
};

const MAX_TURNS = 12; // If not done in 12 turns something is wrong.

// ── Tool format converters ────────────────────────────────────────────────────

function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// Helpers

/**
 * Convert OpenAI-format message history to Anthropic format.
 * Used when falling back from Gemini/Groq to Anthropic so the conversation
 * context carries over rather than starting from scratch.
 */
function openAIHistoryToAnthropic(history) {
  const result = [];
  let i = 0;
  while (i < history.length) {
    const msg = history[i];
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      i++;
    } else if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of (msg.tool_calls ?? [])) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      result.push({ role: 'assistant', content });
      i++;
      // Collect consecutive tool results into one user message (Anthropic requires this).
      const toolResults = [];
      while (i < history.length && history[i].role === 'tool') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: history[i].tool_call_id,
          content: history[i].content,
        });
        i++;
      }
      if (toolResults.length) result.push({ role: 'user', content: toolResults });
    } else {
      i++;
    }
  }
  return result;
}

function truncate(text, max = 8000) {
  return text.length > max ? text.slice(0, max) + '\n... [truncated]' : text;
}

async function executeToolCalls(toolCalls, callTool, onToolCall, onToolResult, recentTools) {
  return Promise.all(
    toolCalls.map(async ({ id, name, input }) => {
      // Loop detection: if the same tool has been called 3 times in the last 5 calls, abort.
      recentTools.push(name);
      if (recentTools.length > 5) recentTools.shift();
      const repeatCount = recentTools.filter(t => t === name).length;
      if (repeatCount >= 3) {
        const msg = `Loop detected: "${name}" called ${repeatCount} times in the last ${recentTools.length} turns. Stopping to avoid infinite loop.`;
        onToolCall?.(name, input);
        onToolResult?.(name, msg);
        return { id, name, resultText: JSON.stringify({ error: true, message: msg }) };
      }

      onToolCall?.(name, input);
      const result = await callTool(name, input);
      const resultText = truncate(JSON.stringify(result, null, 2));
      onToolResult?.(name, resultText);
      return { id, name, resultText };
    }),
  );
}

async function anthropicLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [], priorHistory = null }) {
  const client = new Anthropic();
  const formattedTools = toAnthropicTools(tools);
  // priorHistory is in Anthropic format when resuming after a fallback from Gemini/Groq.
  const messages = priorHistory ? [...priorHistory] : [...priorMessages, { role: 'user', content: task }];
  const recentTools = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: formattedTools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text') onText?.(block.text);
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) break;

    const pending = toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult, recentTools);

    messages.push({
      role: 'user',
      content: results.map(({ id, resultText }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: resultText,
      })),
    });

    if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
  }
}

async function geminiLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [], priorHistory = null }) {
  const client = new OpenAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env.GEMINI_API_KEY,
  });
  const formattedTools = toOpenAITools(tools);
  // priorHistory (OpenAI format, no system msg) is set when resuming after a fallback.
  const messages = priorHistory
    ? [{ role: 'system', content: systemPrompt }, ...priorHistory]
    : [{ role: 'system', content: systemPrompt }, ...priorMessages, { role: 'user', content: task }];
  const recentTools = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        tools: formattedTools,
        tool_choice: 'auto',
        messages,
      });

      const choice = response.choices?.[0];
      if (!choice) throw new Error('Gemini returned empty choices — likely a quota or auth error');

      const msg = choice.message;
      if (msg.content) onText?.(msg.content);

      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];
      if (choice.finish_reason === 'stop' || toolCalls.length === 0) break;

      const pending = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));

      const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult, recentTools);

      for (const { id, name, resultText } of results) {
        messages.push({ role: 'tool', tool_call_id: id, name, content: resultText });
      }

      if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
    }
  } catch (e) {
    const status  = e?.status ?? e?.response?.status;
    const body    = e?.message || e?.error?.message || '';
    const isRateLimit = status === 429 || body.includes('429') || body.toLowerCase().includes('quota') || body.toLowerCase().includes('rate');
    const err = new Error(isRateLimit
      ? `Gemini rate limit (429) — falling back`
      : `Gemini error${status ? ` (${status})` : ''}: ${body || 'no details'}`);
    // Carry the conversation history forward so the next provider picks up where this one left off.
    err.openAIHistory = messages.filter(m => m.role !== 'system');
    throw err;
  }
}

async function openaiLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [], priorHistory = null }) {
  const client = new OpenAI();
  const formattedTools = toOpenAITools(tools);
  const messages = priorHistory
    ? [{ role: 'system', content: systemPrompt }, ...priorHistory]
    : [{ role: 'system', content: systemPrompt }, ...priorMessages, { role: 'user', content: task }];
  const recentTools = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        tools: formattedTools,
        tool_choice: 'auto',
        messages,
      });

      const msg = response.choices[0].message;

      if (msg.content) onText?.(msg.content);

      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];

      if (response.choices[0].finish_reason === 'stop' || toolCalls.length === 0) break;

      const pending = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));

      const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult, recentTools);

      for (const { id, name, resultText } of results) {
        messages.push({ role: 'tool', tool_call_id: id, name, content: resultText });
      }

      if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
    }
  } catch (e) {
    const err = new Error(`OpenAI error: ${e?.message || 'no details'}`);
    err.openAIHistory = messages.filter(m => m.role !== 'system');
    throw err;
  }
}

async function groqLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [], priorHistory = null }) {
  const client = new Groq();
  const formattedTools = toOpenAITools(tools);
  const messages = priorHistory
    ? [{ role: 'system', content: systemPrompt }, ...priorHistory]
    : [{ role: 'system', content: systemPrompt }, ...priorMessages, { role: 'user', content: task }];
  const recentTools = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 4096,
        tools: formattedTools,
        tool_choice: 'auto',
        messages,
      });

      const msg = response.choices[0].message;

      if (msg.content) onText?.(msg.content);

      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];

      if (response.choices[0].finish_reason === 'stop' || toolCalls.length === 0) break;

      const pending = toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));

      const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult, recentTools);

      for (const { id, name, resultText } of results) {
        messages.push({ role: 'tool', tool_call_id: id, name, content: resultText });
      }

      if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
    }
  } catch (e) {
    const status = e?.status ?? e?.response?.status;
    const isRateLimit = status === 429 || (e?.message || '').toLowerCase().includes('rate');
    const err = new Error(isRateLimit
      ? `Groq rate limit (429) — falling back`
      : `Groq error${status ? ` (${status})` : ''}: ${e?.message || 'no details'}`);
    err.openAIHistory = messages.filter(m => m.role !== 'system');
    throw err;
  }
}

/**
 * Run the full agentic loop for a given provider, with an optional fallback chain.
 *
 * @param {object}   opts
 * @param {string}   opts.task              Plain-English task string.
 * @param {string}   opts.provider          'gemini' | 'anthropic' | 'openai' | 'groq'
 * @param {string}  [opts.model]            Model override. Defaults to DEFAULT_MODELS[provider].
 * @param {string[]} [opts.fallbackChain]   Ordered list of providers to try if primary fails.
 * @param {string}   opts.systemPrompt      System prompt text.
 * @param {Array}    opts.tools             OTM_TOOLS array from mcp-server.js.
 * @param {Function} opts.callTool          async (name, args) => result
 * @param {Function} [opts.onText]          Called with each text chunk from the model.
 * @param {Function} [opts.onToolCall]      Called with (name, input) before execution.
 * @param {Function} [opts.onToolResult]    Called with (name, resultText) after execution.
 * @param {Function} [opts.onFallback]      Called with (provider, errorMessage) when falling back.
 */
export async function runAgentLoop(opts) {
  const primary = opts.provider ?? 'gemini';
  const model   = opts.model ?? DEFAULT_MODELS[primary];
  const chain   = opts.fallbackChain ?? [];

  if (!PROVIDERS.includes(primary)) {
    throw new Error(`Unknown provider "${primary}". Choose from: ${PROVIDERS.join(', ')}`);
  }

  const OPENAI_COMPAT = new Set(['gemini', 'groq', 'openai']);

  function runWith(p, m, extra = {}) {
    const args = { ...opts, ...extra, provider: p, model: m };
    switch (p) {
      case 'gemini':    return geminiLoop(args);
      case 'anthropic': return anthropicLoop(args);
      case 'openai':    return openaiLoop(args);
      case 'groq':      return groqLoop(args);
    }
  }

  const sequence = [
    { provider: primary, model },
    ...chain.map((p) => ({ provider: p, model: DEFAULT_MODELS[p] })),
  ];

  // OpenAI-format history accumulated by the last failed provider.
  let savedHistory = null;

  for (let i = 0; i < sequence.length; i++) {
    const { provider: p, model: m } = sequence[i];
    try {
      const extra = {};
      if (savedHistory) {
        // Pass history in the format the next provider expects.
        extra.priorHistory = OPENAI_COMPAT.has(p)
          ? savedHistory
          : openAIHistoryToAnthropic(savedHistory);
      }
      return await runWith(p, m, extra);
    } catch (e) {
      if (e.openAIHistory) savedHistory = e.openAIHistory;
      const next = sequence[i + 1];
      if (next) {
        console.warn(`[Agent] ${p} failed (${e.message}) — falling back to ${next.provider}`);
        opts.onFallback?.(next.provider, e.message);
      } else {
        throw e;
      }
    }
  }
}
