import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';

export const PROVIDERS = ['gemini', 'anthropic', 'openai', 'groq'];

export const DEFAULT_MODELS = {
  gemini:    'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-20250514',
  openai:    'gpt-4o',
  groq:      'llama-3.3-70b-versatile',
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

async function anthropicLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [] }) {
  const client = new Anthropic();
  const formattedTools = toAnthropicTools(tools);
  const messages = [...priorMessages, { role: 'user', content: task }];
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

async function geminiLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [] }) {
  const client = new OpenAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env.GEMINI_API_KEY,
  });
  const formattedTools = toOpenAITools(tools);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: task },
  ];
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
    // Normalize Gemini errors so the fallback chain always sees a proper Error with a clear message.
    const status  = e?.status ?? e?.response?.status;
    const body    = e?.message || e?.error?.message || '';
    if (status === 429 || body.includes('429') || body.toLowerCase().includes('quota') || body.toLowerCase().includes('rate')) {
      throw new Error(`Gemini rate limit (429) — falling back`);
    }
    throw new Error(`Gemini error${status ? ` (${status})` : ''}: ${body || 'no details'}`);
  }
}

async function openaiLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [] }) {
  const client = new OpenAI();
  const formattedTools = toOpenAITools(tools);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: task },
  ];
  const recentTools = [];

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
}

async function groqLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult, priorMessages = [] }) {
  const client = new Groq();
  const formattedTools = toOpenAITools(tools);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: task },
  ];
  const recentTools = [];

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

  function runWith(p, m) {
    const args = { ...opts, provider: p, model: m };
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

  for (let i = 0; i < sequence.length; i++) {
    const { provider: p, model: m } = sequence[i];
    try {
      return await runWith(p, m);
    } catch (e) {
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
