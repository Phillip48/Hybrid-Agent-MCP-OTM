# Hybrid Browser-Agent / MCP Server for OTM

Automates [Online Territory Manager](https://onlineterritorymanager.com) using Playwright browser automation driven by an AI agent loop. Supports **Gemini**, **Groq (Llama)**, **Anthropic (Claude)**, and **OpenAI (GPT-4o)** as interchangeable providers, with an automatic **Gemini → Groq → Anthropic** free-first fallback chain to keep costs low. Also exposes the same OTM actions as an MCP Server for Claude Desktop.

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
│  bot.js  — Telegram bot (24/7, managed by PM2)       │
│  • User allow-list, /setup, /restart, /debug         │
│  • Queues tasks and dispatches to providers.js       │
│  • 75s timeout (240s for routing tasks)              │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  index.js  — CLI entry point                         │
│  • --provider gemini | anthropic | openai | groq     │
│  • --model <override>                                │
│  • Reads task from args / stdin / prompt             │
│  • Dispatches tool calls → mcp-server.js             │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  providers.js  — Unified AI provider abstraction     │
│  • geminiLoop     (tried first — free tier)          │
│  • groqLoop       (free fallback)                    │
│  • anthropicLoop  (last-resort fallback)             │
│  • openaiLoop     (alternative last-resort)          │
│  Normalizes tool formats and message history for     │
│  each provider's API. Carries conversation history   │
│  across fallbacks so context is never lost.          │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  mcp-server.js  — OTM tool implementations           │
│  • list_territories   • checkout_territory           │
│  • search_territories • return_territory             │
│  • get_territory_status • list_publishers            │
│  • search_addresses   • add_address                  │
│  • find_duplicate_addresses • route_territory        │
│  • report_* (8 reports)  • take_screenshot           │
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
Every task → Gemini (gemini-2.0-flash-lite)    ← free, tried first
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
HEADLESS=true                    # set to false to watch the browser

AI_PROVIDER=anthropic            # last-resort fallback (gemini → groq → this)

GEMINI_API_KEY=AIza...           # required — free at aistudio.google.com
GROQ_API_KEY=gsk_...             # required — free at console.groq.com
ANTHROPIC_API_KEY=sk-ant-...     # last-resort fallback key
OPENAI_API_KEY=sk-...            # alternative last-resort

GEO_KEY=your_geocodio_api_key    # required for route_territory

TELEGRAM_BOT_TOKEN=...           # required for bot.js
TELEGRAM_ADMIN_IDS=123456,789012 # comma-separated admin Telegram user IDs
```

You need `GEMINI_API_KEY` and `GROQ_API_KEY` for the free-first chain. Add a fallback provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) for reliability when both free tiers are rate-limited.

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
| `gemini` | `gemini-2.0-flash-lite` | Always tried first — free tier (30 RPM) |
| `groq` | `llama-3.3-70b-versatile` | Second attempt — free tier |
| `anthropic` | `claude-haiku-4-5-20251001` | Last-resort fallback — cheapest Claude with tool use |
| `openai` | `gpt-4o-mini` | Alternative last-resort — ~15x cheaper than gpt-4o |

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
| `search_territories` | Search by number, name, or keyword |
| `load_territory` | Loads a territory into the panel (required before checkout/return) |
| `checkout_territory` | Full checkout flow — loads territory, selects publisher, sets date |
| `return_territory` | Mark a territory as returned |
| `get_territory_status` | Whether a territory is checked out and by whom |
| `list_checked_out` | All currently checked-out territories with publisher and date |
| `list_publishers` | List congregation publishers; optional name filter |
| `get_panel` | Returns current right-panel content |
| `click_panel_button` | Clicks a button inside the panel by visible text |
| `search_addresses` | Search OTM addresses by house number, street, city, or zip |
| `add_address` | Add a new address to OTM (checks for duplicates first) |
| `find_duplicate_addresses` | Runs the built-in duplicate address checker |
| `route_territory` | Routes a territory's addresses in optimal driving order using Geocodio |
| `report_worked_log` | Territory worked log — last worked and check-in/out history |
| `report_territory_list` | Full territory list with addresses and status |
| `report_checkinout` | S-13 style check-in/out assignment history report |
| `report_group_stats` | Territory coverage stats per service group |
| `report_stats_by_grouping` | Territory statistics by grouping/type |
| `report_address_demographics` | Address type breakdown across territories |
| `report_territory_export` | Exportable territory list with full details |
| `report_letter_writing` | Letter writing activity statistics |
| `report_address_export` | Full address list with return visit notes |
| `list_territory_groups` | All territory groups/service groups |
| `list_territory_types` | All territory types defined in OTM |
| `list_campaigns` | Active campaigns |
| `list_announcements` | Congregation announcements |
| `get_congregation_options` | Congregation-level settings and options |
| `get_user_preferences` | Current user preferences |
| `navigate_page` | Navigate to any OTM path or URL |
| `get_page_content` | Get visible text of the current page |
| `take_screenshot` | Returns base64 PNG of the current page |

---

## How it works

1. **On first run** the agent logs in with your OTM credentials and saves the session cookies to `cookies.json`.
2. **On subsequent runs** the saved cookies are loaded — login is skipped unless the session has expired.
3. **The agentic loop** sends your task to Gemini first (free). On a 429 rate-limit error it retries twice (8s then 20s) before giving up. If Gemini fails, it tries Groq (also free), then falls back to your configured last-resort provider (Anthropic by default). Conversation history is carried across fallbacks so context is never lost.
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
├── bot.js                Telegram bot — user management, task dispatch, PM2 entry point
├── index.js              CLI entry point — parses --provider / --model flags
├── providers.js          Unified AI provider abstraction (Gemini-first + fallback chain)
├── mcp-server.js         OTM tool implementations + MCP Server (stdio)
├── browser.js            Playwright session manager
├── .env                  Credentials and API keys (never commit this)
├── cookies.json          Saved browser session (auto-generated, gitignored)
├── geocode-cache.json    Persistent address → coordinates cache (auto-generated, gitignored)
├── package.json          ES module config + dependencies
└── README.md             This file
```
