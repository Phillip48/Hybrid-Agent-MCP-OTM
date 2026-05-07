import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';

export const PROVIDERS = ['anthropic', 'openai', 'groq'];

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
};

const MAX_TURNS = 20;

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

async function executeToolCalls(toolCalls, callTool, onToolCall, onToolResult) {
  return Promise.all(
    toolCalls.map(async ({ id, name, input }) => {
      onToolCall?.(name, input);
      const result = await callTool(name, input);
      const resultText = truncate(JSON.stringify(result, null, 2));
      onToolResult?.(name, resultText);
      return { id, name, resultText };
    }),
  );
}

async function anthropicLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult }) {
  const client = new Anthropic();
  const formattedTools = toAnthropicTools(tools);
  const messages = [{ role: 'user', content: task }];

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
    const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult);

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

async function openaiLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult }) {
  const client = new OpenAI();
  const formattedTools = toOpenAITools(tools);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

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

    // Push the assistant message (with any tool_calls) into history.
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];

    if (response.choices[0].finish_reason === 'stop' || toolCalls.length === 0) break;

    const pending = toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    }));

    const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult);

    for (const { id, name, resultText } of results) {
      messages.push({ role: 'tool', tool_call_id: id, name, content: resultText });
    }

    if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
  }
}

async function groqLoop({ task, model, systemPrompt, tools, callTool, onText, onToolCall, onToolResult }) {
  const client = new Groq();
  const formattedTools = toOpenAITools(tools);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

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

    const results = await executeToolCalls(pending, callTool, onToolCall, onToolResult);

    for (const { id, name, resultText } of results) {
      messages.push({ role: 'tool', tool_call_id: id, name, content: resultText });
    }

    if (turn === MAX_TURNS - 1) console.warn('[Agent] Warning: reached maximum turn limit.');
  }
}

/**
 * Run the full agentic loop for a given provider.
 *
 * @param {object} opts
 * @param {string}   opts.task         Plain-English task string.
 * @param {string}   opts.provider     'anthropic' | 'openai' | 'groq'
 * @param {string}  [opts.model]       Model override. Defaults to DEFAULT_MODELS[provider].
 * @param {string}   opts.systemPrompt System prompt text.
 * @param {Array}    opts.tools        OTM_TOOLS array from mcp-server.js.
 * @param {Function} opts.callTool     async (name, args) => result
 * @param {Function} [opts.onText]     Called with each text chunk from the model.
 * @param {Function} [opts.onToolCall] Called with (name, input) before execution.
 * @param {Function} [opts.onToolResult] Called with (name, resultText) after execution.
 */
export async function runAgentLoop(opts) {
  const provider = opts.provider ?? 'anthropic';
  const model = opts.model ?? DEFAULT_MODELS[provider];

  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Choose from: ${PROVIDERS.join(', ')}`);
  }

  const args = { ...opts, model };

  switch (provider) {
    case 'anthropic': return anthropicLoop(args);
    case 'openai':    return openaiLoop(args);
    case 'groq':      return groqLoop(args);
  }
}
