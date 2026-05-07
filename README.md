# Hybrid Browser-Agent / MCP Server for OTM

Automates [Online Territory Manager](https://onlineterritorymanager.com) using Playwright browser automation driven by an AI agent loop. Supports **Anthropic (Claude)**, **OpenAI (GPT-4o)**, and **Groq (Llama)** as interchangeable providers. Also exposes the same OTM actions as an MCP Server for Claude Desktop.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  index.js  — CLI entry point                         │
│  • --provider anthropic | openai | groq              │
│  • --model <override>                                │
│  • Reads task from args / stdin / prompt             │
│  • Dispatches tool calls → mcp-server.js             │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  providers.js  — Unified AI provider abstraction     │
│  • anthropicLoop  (Anthropic SDK)                    │
│  • openaiLoop     (OpenAI SDK)                       │
│  • groqLoop       (Groq SDK — OpenAI-compatible)     │
│  Normalizes tool formats and message history for     │
│  each provider's API.                                │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  mcp-server.js  — OTM tool implementations           │
│  • list_territories   • assign_territory             │
│  • get_territory      • return_territory             │
│  • search_territories • list_publishers              │
│  • get_territory_status • get_publisher              │
│  • navigate_page      • get_page_content             │
│  • click_element      • fill_form                    │
│  • take_screenshot                                   │
│  Also runs standalone as an MCP Server (stdio)       │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  browser.js  — Playwright session manager            │
│  • Singleton BrowserSession                          │
│  • Cookie persistence (cookies.json)                 │
│  • Auto-login when session expires                   │
│  • navigate, click, fill, scrape, evaluate…          │
└──────────────────────────────────────────────────────┘
```

## Setup

### 1. Install Node dependencies

```bash
npm install
```

### 2. Install Playwright Chromium

```bash
npm run install:browsers
```

### 3. Configure credentials

Edit `.env`:

```env
OTM_USER=your_email@example.com
OTM_PASS=your_password
HEADLESS=true                  # set to false to watch the browser

AI_PROVIDER=anthropic          # default provider

ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
```

You only need the API key for the provider(s) you intend to use.

## Usage

### Choosing a provider

```bash
# Default provider (set AI_PROVIDER in .env, defaults to anthropic)
node index.js "Show me all available territories"

# Explicit provider flag
node index.js --provider openai "Show me all available territories"
node index.js --provider groq   "Show me all available territories"

# Provider + model override
node index.js --provider openai --model gpt-4o-mini "List publishers"
node index.js --provider groq --model llama-3.3-70b-versatile "Return territory 7"

# Short flags
node index.js -p groq "Assign territory 42 to Jane Smith"
```

### Provider defaults

| Provider | Default model | Notes |
|----------|--------------|-------|
| `anthropic` | `claude-sonnet-4-20250514` | Most capable for complex multi-step tasks |
| `openai` | `gpt-4o` | Strong tool use, widely available |
| `groq` | `llama-3.3-70b-versatile` | Fastest inference; use `llama-3.3-70b-versatile` or `llama3-groq-70b-8192-tool-use-preview` |

### Example tasks

```bash
node index.js "Show me all available territories"
node index.js "What territories does Jane Smith currently have?"
node index.js "Assign territory 42 to John Doe"
node index.js "Return territory 15 — it came back today"
node index.js "List all territories checked out for more than 4 months"

# Pipe from stdin
echo "List publishers in group 3" | node index.js --provider groq

# Interactive prompt
node index.js --provider openai
# > Enter OTM task: _
```

### Debug mode (watch the browser)

```bash
HEADLESS=false node index.js "List territories in group 3"
npm run debug
```

### Help

```bash
node index.js --help
```

---

## Standalone MCP Server

Run as an MCP server for Claude Desktop or any MCP-compatible client:

```bash
node mcp-server.js
```

#### Claude Desktop configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "otm": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"],
      "env": {
        "OTM_USER": "your@email.com",
        "OTM_PASS": "yourpassword",
        "HEADLESS": "true"
      }
    }
  }
}
```

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_territories` | Lists all territories with status; optional `status_filter` |
| `get_territory` | Full details for a territory by number |
| `search_territories` | Search by number, name, or city |
| `get_territory_status` | Current checkout status of a territory |
| `assign_territory` | Check out a territory to a publisher |
| `return_territory` | Mark a territory as returned |
| `list_publishers` | List congregation publishers; optional `group_filter` |
| `get_publisher` | Details and territory history for a publisher |
| `navigate_page` | Navigate to any OTM path or URL |
| `get_page_content` | Get visible text of the current page |
| `click_element` | Click an element by CSS selector or `text=...` |
| `fill_form` | Fill an input field |
| `take_screenshot` | Returns base64 PNG of the current page |

---

## How it works

1. **On first run** the agent logs in with your OTM credentials and saves the session cookies to `cookies.json`.
2. **On subsequent runs** the saved cookies are loaded — login is skipped unless the session has expired.
3. **The agentic loop** sends your task to the chosen AI model with all 13 OTM tools available. The model reasons through the task, calls tools, reads results, and iterates until done (max 20 turns).
4. **Tool format normalization** — `providers.js` converts the OTM tool definitions to each provider's format (Anthropic `input_schema` vs OpenAI/Groq `parameters`) and translates their different message history structures transparently.
5. **Errors are surfaced gracefully** — Playwright failures are returned as tool results so the model can retry with a different approach.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Login fails | Check `OTM_USER` / `OTM_PASS`; set `HEADLESS=false` to watch |
| "Element not found" | Use `take_screenshot` or `get_page_content` to inspect the page |
| Session keeps expiring | Delete `cookies.json` to force a fresh login |
| Groq tool-use errors | Some Groq models have limited tool support — try `llama-3.3-70b-versatile` |
| OpenAI rate limits | Use `--model gpt-4o-mini` for lighter tasks |

---

## File reference

```
├── index.js          CLI entry point — parses --provider / --model flags
├── providers.js      Unified AI provider abstraction (Anthropic, OpenAI, Groq)
├── mcp-server.js     OTM tool implementations + MCP Server (stdio)
├── browser.js        Playwright session manager
├── .env              Credentials and API keys (never commit this)
├── cookies.json      Saved browser session (auto-generated, gitignored)
├── package.json      ES module config + dependencies
└── README.md         This file
```
