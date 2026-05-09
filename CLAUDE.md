# OTM Hybrid Agent — Claude Code Context

## What this project does

This is a Node.js hybrid that combines a **Playwright browser agent** with an
**MCP Server** to automate [Online Territory Manager](https://onlineterritorymanager.com),
a congregation territory management web app. A Claude AI agentic loop (in
`index.js`) accepts plain-English tasks and uses browser-automation tools to
carry them out.

## File map

| File | Role |
|------|------|
| `bot.js` | Telegram bot — user allow-list, `/setup`, `/restart`, task dispatch, PM2 entry point |
| `browser.js` | Singleton `BrowserSession` — all Playwright interactions live here |
| `mcp-server.js` | OTM tool implementations + MCP Server wiring (stdio) |
| `providers.js` | Unified AI provider abstraction (Gemini → Groq → Anthropic/OpenAI fallback chain) |
| `index.js` | CLI entry point; parses `--provider` / `--model`; runs agentic loop |
| `.env` | `OTM_USER`, `OTM_PASS`, `AI_PROVIDER`, all API keys, `HEADLESS`, Telegram tokens |
| `cookies.json` | Auto-generated saved Playwright session (gitignored) |
| `geocode-cache.json` | Persistent address → coordinates cache for `route_territory` (gitignored) |

## Architecture rules

- **ES modules only** (`"type": "module"` in `package.json`). Use `.js`
  extensions in all imports. No CommonJS (`require`).
- **`browser.js` exports a singleton** — import `session` (default) and call
  `session.ensureLoggedIn()` before every browser operation. Never create a
  second `BrowserSession`.
- **`mcp-server.js` exports two things**: `OTM_TOOLS` (array of tool defs) and
  `callTool(name, args)` (async dispatch). Both `index.js` and `providers.js`
  can import these.
- **`providers.js` exports `runAgentLoop(opts)`**, `PROVIDERS` (string array),
  and `DEFAULT_MODELS` (object). Add new providers here only — `index.js` stays
  provider-agnostic.
- Tool handlers in `mcp-server.js` are wrapped with `withBrowser(fn)` which
  catches all errors and returns `{ error: true, message }` — never throw out
  of a tool handler.
- The MCP Server only starts (`startMcpServer()`) when `mcp-server.js` is the
  direct entry point (`process.argv[1]`). When imported by `index.js` it is
  just a module.

## Key patterns

### Adding a new AI provider

1. Install the provider's SDK: `npm install <sdk>`.
2. Add the provider name to `PROVIDERS` and its default model to `DEFAULT_MODELS` in `providers.js`.
3. Write a `xxxLoop(opts)` function (see `openaiLoop` or `groqLoop` as templates — OpenAI-compatible providers are essentially identical).
4. Add a `case 'xxx':` to the `switch` in `runAgentLoop`.
5. Add the API key to `.env`.

### Adding a new OTM tool

1. Add the tool definition object to the `OTM_TOOLS` array in `mcp-server.js`.
2. Write the `handleXxx(args)` async function — wrap it with `withBrowser`.
3. Add a `case 'xxx':` to the `callTool` switch.
4. That's it — `index.js` picks up new tools automatically from `OTM_TOOLS`.

### Debugging selector failures

If a Playwright selector stops working:
1. Run `HEADLESS=false node index.js "take a screenshot"` to see the page.
2. Add the new selector to the candidate array in the relevant helper
   (e.g. `checkoutSelectors`, `publisherSelectors`).
3. Selectors are tried in order; the first that works wins.

### Cookie / session management

- `browser.js` auto-saves cookies after login and on `session.close()`.
- Delete `cookies.json` to force a fresh login.
- `isLoggedIn()` does a lightweight probe of `/territories` — it does **not**
  make a full network round-trip every tool call; it's only called once per
  process via `ensureLoggedIn()` (which short-circuits after the first success).

## Environment flags

| Variable | Default | Effect |
|----------|---------|--------|
| `HEADLESS` | `true` | Set to `false` to show the browser window |
| `OTM_USER` | — | OTM login email |
| `OTM_PASS` | — | OTM login password |
| `AI_PROVIDER` | `gemini` | Primary provider; fallback chain is `gemini → groq → this` |
| `GEMINI_API_KEY` | — | Required — free at [aistudio.google.com](https://aistudio.google.com) |
| `GROQ_API_KEY` | — | Required — free at [console.groq.com](https://console.groq.com) |
| `ANTHROPIC_API_KEY` | — | Last-resort fallback key |
| `OPENAI_API_KEY` | — | Alternative last-resort key |
| `GEO_KEY` | — | Geocodio API key — required for `route_territory` |
| `TELEGRAM_BOT_TOKEN` | — | Required for `bot.js` |
| `TELEGRAM_ADMIN_IDS` | — | Comma-separated admin Telegram user IDs |

## Running locally

```bash
npm install
npx playwright install chromium
node index.js "Show me all available territories"
```

## Common gotchas

- OTM is a Rails app — expect Turbo Drive navigation. Always `waitForLoadState`
  after clicks rather than assuming `waitForNavigation`.
- Territory numbers can be plain integers ("42") or prefixed ("S-42"). The
  `findLinks` and search helpers handle both.
- The `take_screenshot` tool returns base64 PNG — useful for Claude to reason
  about the visual state of the page when selectors fail.
