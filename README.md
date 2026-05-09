# Hybrid Browser-Agent / MCP Server for OTM

Automates [Online Territory Manager](https://onlineterritorymanager.com) using Playwright browser automation driven by an AI agent loop. Supports **Anthropic (Claude)**, **OpenAI (GPT-4o)**, and **Groq (Llama)** as interchangeable providers, with **automatic Groq-first fallback** to keep costs low. Also exposes the same OTM actions as an MCP Server for Claude Desktop.

## How it's currently used

The bot runs 24/7 on a server managed by **PM2**. Congregation members interact with it entirely through **Telegram** — no app, no website, no technical knowledge required.

**Typical workflow:**
1. A user opens Telegram and messages the bot
2. They type a plain-English request: `"Assign territory OR-15A to John Smith"`
3. The bot opens a real Chrome browser in the background, logs into OTM, navigates the site, and completes the action
4. Within seconds, the bot replies with a confirmation

**Access is invite-only.** New users message the bot, receive their Telegram ID, and an admin runs `/allow <id>` to grant access. The user then runs `/setup` to link their OTM credentials. Everything after that is just plain conversation.

**PM2** keeps the bot alive across crashes and server reboots:

```bash
pm2 start bot.js --name otm-bot   # start
pm2 logs otm-bot                   # watch live output
pm2 restart otm-bot                # restart after code changes
pm2 save && pm2 startup            # survive reboots
```

Admins can also restart the bot directly from Telegram with `/restart` without needing server access.

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
│  • groqLoop       (tried first — free tier)          │
│  • anthropicLoop  (fallback if Groq fails)           │
│  • openaiLoop     (fallback if Groq fails)           │
│  Normalizes tool formats and message history for     │
│  each provider's API. Automatic provider fallback.   │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  mcp-server.js  — OTM tool implementations           │
│  • list_territories   • assign_territory             │
│  • get_territory      • return_territory             │
│  • search_territories • list_publishers              │
│  • get_territory_status • route_territory            │
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

## Provider Strategy

Every task runs through a three-tier free-first chain. Gemini and Groq are both free-tier; Anthropic is only reached if both fail.

```
Every task → Gemini (gemini-2.0-flash)        ← free, tried first
                │
                ├─ success → done
                └─ failure → Groq (llama-3.3-70b-versatile)  ← free fallback
                                │
                                ├─ success → done
                                └─ failure → Anthropic / OpenAI  ← last resort
```

- Set your last-resort fallback in Telegram with `/setprovider anthropic`
- Set the default last-resort in `.env` with `AI_PROVIDER=anthropic`
- `GEMINI_API_KEY` is required — get a free key at [aistudio.google.com](https://aistudio.google.com)
- `GROQ_API_KEY` is required — free at [console.groq.com](https://console.groq.com)

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

AI_PROVIDER=anthropic          # last-resort fallback (gemini → groq → this)

GEMINI_API_KEY=AIza...         # required — free at aistudio.google.com
GROQ_API_KEY=gsk_...           # required — free at console.groq.com
ANTHROPIC_API_KEY=sk-ant-...   # last-resort fallback key
OPENAI_API_KEY=sk-...          # alternative last-resort

GEO_KEY=your_geocodio_api_key  # required for route_territory
```

You need `GROQ_API_KEY` for all tasks. Add a fallback provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) for reliability on complex tasks.

## Usage

### Choosing a provider (CLI)

```bash
# Default: tries Groq first, falls back to AI_PROVIDER from .env
node index.js "Show me all available territories"

# Explicit provider (no fallback)
node index.js --provider openai "Show me all available territories"
node index.js --provider groq   "Show me all available territories"

# Provider + model override
node index.js --provider openai --model gpt-4o-mini "List publishers"
node index.js --provider groq --model llama-3.3-70b-versatile "Return territory 7"

# Short flags
node index.js -p anthropic "Assign territory 42 to Jane Smith"
```

### Provider defaults

| Provider | Default model | Notes |
|----------|--------------|-------|
| `gemini` | `gemini-2.0-flash` | Always tried first — free tier |
| `groq` | `llama-3.3-70b-versatile` | Second attempt — free tier |
| `anthropic` | `claude-sonnet-4-20250514` | Last-resort fallback — best for complex tasks |
| `openai` | `gpt-4o` | Alternative last-resort — strong tool use |

### Example tasks

```bash
node index.js "Show me all available territories"
node index.js "What territories does Jane Smith currently have?"
node index.js "Assign territory 42 to John Doe"
node index.js "Return territory 15 — it came back today"
node index.js "List all territories checked out for more than 4 months"
node index.js "Route territory OR-15A"

# Pipe from stdin
echo "List publishers in group 3" | node index.js

# Interactive prompt
node index.js
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
| `route_territory` | Routes a territory's addresses in optimal driving order from home base using Geocodio + nearest-neighbor |
| `navigate_page` | Navigate to any OTM path or URL |
| `get_page_content` | Get visible text of the current page |
| `click_element` | Click an element by CSS selector or `text=...` |
| `fill_form` | Fill an input field |
| `take_screenshot` | Returns base64 PNG of the current page |

---

## How it works

1. **On first run** the agent logs in with your OTM credentials and saves the session cookies to `cookies.json`.
2. **On subsequent runs** the saved cookies are loaded — login is skipped unless the session has expired.
3. **The agentic loop** sends your task to Gemini first (free). If Gemini fails, it retries with Groq (also free). If Groq fails, it falls back to your configured last-resort provider (Anthropic by default).
4. **Tool format normalization** — `providers.js` converts the OTM tool definitions to each provider's format (Anthropic `input_schema` vs OpenAI/Groq `parameters`) and translates their different message history structures transparently.
5. **Errors are surfaced gracefully** — Playwright failures are returned as tool results so the model can retry with a different approach.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Login fails | Check `OTM_USER` / `OTM_PASS`; set `HEADLESS=false` to watch |
| "Element not found" | Use `take_screenshot` or `get_page_content` to inspect the page |
| Session keeps expiring | Delete `cookies.json` to force a fresh login |
| Gemini keeps failing | Check `GEMINI_API_KEY`; Groq will take over automatically |
| Groq keeps failing | Check `GROQ_API_KEY`; Anthropic will take over automatically |
| Task fails on all providers | Check all API keys in `.env`; try `--provider anthropic` directly |

---

## File reference

```
├── index.js              CLI entry point — parses --provider / --model flags
├── providers.js          Unified AI provider abstraction (Groq-first + fallback)
├── mcp-server.js         OTM tool implementations + MCP Server (stdio)
├── browser.js            Playwright session manager
├── .env                  Credentials and API keys (never commit this)
├── cookies.json          Saved browser session (auto-generated, gitignored)
├── geocode-cache.json    Persistent address → coordinates cache (auto-generated, gitignored)
├── package.json          ES module config + dependencies
└── README.md             This file
```
