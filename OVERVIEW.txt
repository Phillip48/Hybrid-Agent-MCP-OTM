# Hybrid Browser-Agent / MCP Server for OTM — Complete Overview

> **What this is:** A Node.js system that lets you control Online Territory Manager (OTM) at https://onlineterritorymanager.com using plain-English messages sent through a Telegram bot. You type "Assign territory OR-15A to John Smith" and a real browser logs in, navigates OTM, clicks the checkout button, finds John Smith in the publisher list, and confirms — automatically.

---

## Table of Contents

1. [Architecture](#architecture)
2. [File Reference](#file-reference)
3. [AI Providers](#ai-providers)
4. [Telegram Bot Commands](#telegram-bot-commands)
5. [All OTM Tools — Step by Step](#all-otm-tools--step-by-step)
6. [Setup & Running](#setup--running)
7. [Environment Variables](#environment-variables)
8. [Multi-User / Multi-Congregation](#multi-user--multi-congregation)
9. [How the Agent Loop Works](#how-the-agent-loop-works)
10. [Reliability Features](#reliability-features)

---

## Architecture

```
You (Telegram) ──► bot.js ──► runAgentLoop() ──► AI Model (Claude/GPT/Llama)
                                  │                        │
                                  │◄────── tool calls ─────┘
                                  │
                             mcp-server.js
                          (30+ OTM tool handlers)
                                  │
                             browser.js
                        (Playwright / Chromium)
                                  │
                    https://onlineterritorymanager.com
```

**Data flow for every message:**

1. You send a message to the Telegram bot (e.g. "Return territory OR-15A")
2. `bot.js` receives it, loads conversation history (last 3 exchanges), and calls `runAgentLoop()`
3. The AI model reads the task + system prompt + all tool definitions
4. The model calls tools (e.g. `return_territory`) in sequence
5. Each tool call goes to `mcp-server.js` → `browser.js` → the live OTM website
6. Results come back to the AI, which reasons about them and calls more tools if needed
7. The AI writes a final response, which is sent back to you in Telegram

---

## File Reference

| File | Purpose |
|------|---------|
| `bot.js` | Telegram bot — user registration, session management, task runner, bot commands |
| `mcp-server.js` | All 30+ OTM tool implementations. Also runs as a standalone MCP Server |
| `browser.js` | Playwright session manager — login, cookie persistence, all browser actions |
| `providers.js` | AI provider abstraction — Anthropic, OpenAI, Groq. Loop detection, turn limits |
| `sessions.js` | Per-user browser session pool (one Chromium instance per registered user) |
| `store.js` | AES-256-GCM encrypted credential storage per user in `data/users.json` |
| `otm-knowledge.js` | OTM knowledge base injected into every AI system prompt |
| `index.js` | CLI entry point — run tasks without Telegram, supports `--provider` flag |
| `.env` | All credentials and API keys (never committed) |
| `COMMANDS.txt` | Quick command reference |
| `geocode-cache.json` | Persistent address → coordinates cache for `route_territory` (auto-generated, gitignored) |
| `data/users.json` | Encrypted user credentials (auto-generated, gitignored) |
| `cookies/<userId>.json` | Per-user browser sessions (auto-generated, gitignored) |

---

## AI Providers

Three AI providers are supported and can be switched per user at any time.

| Provider | Default Model | Notes |
|----------|--------------|-------|
| `anthropic` | `claude-sonnet-4-20250514` | Best for complex multi-step tasks |
| `openai` | `gpt-4o` | Reliable tool use, recommended for production |
| `groq` | `llama-3.3-70b-versatile` | Fast but less reliable tool use |

**Switching providers:**
- In Telegram: `/setprovider openai`
- In CLI: `node index.js --provider openai "your task"`
- Default: set `AI_PROVIDER=openai` in `.env`

---

## Telegram Bot Commands

### User Commands

#### `/start`
- If registered: shows welcome message and usage examples
- If not registered: launches the `/setup` wizard automatically

#### `/setup`
Registers your OTM credentials with the bot.

**Steps:**
1. Bot asks for your OTM username (email)
2. You send your username
3. Bot asks for your OTM password
4. You send your password — bot **immediately deletes** the message from Telegram chat
5. Bot launches a test browser session to verify login
6. If login succeeds: credentials are encrypted and saved, real session is pre-authenticated
7. Bot replies "✅ Connected!" — you're ready to send tasks

#### `/status`
Shows your current OTM account (username), whether a task is running, and your current AI provider/model.

#### `/debug`
Tests your OTM session without running a full task.

**Steps:**
1. Bot calls `ensureLoggedIn()` on your browser session
2. Navigates to `GetStandard.php`
3. Reports the page title and URL — if it shows the territory list, session is healthy
4. If it fails, shows the exact error message

#### `/myid`
Returns your Telegram numeric user ID (needed when asking an admin to allow you).

#### `/cancel`
Cancels an active `/setup` wizard. Has no effect on running tasks.

#### `/setprovider`
View or change your AI provider.

**Usage:**
```
/setprovider                        — show current provider and options
/setprovider openai                 — switch to OpenAI (GPT-4o)
/setprovider anthropic              — switch to Anthropic (Claude)
/setprovider groq                   — switch to Groq (Llama)
/setprovider openai gpt-4o-mini     — switch provider AND override the model
```

Each user's provider preference is saved independently in the encrypted store.

### Admin Commands

Admin IDs are set in `.env` as `TELEGRAM_ADMIN_IDS`.

#### `/allow <telegram_id>`
Grants a user access to the bot.

**Steps:**
1. When a new user messages the bot, bot replies with their Telegram ID and blocks them
2. You run `/allow 123456789` in your chat with the bot
3. Store is updated — user is marked as allowed
4. Bot sends the user a notification: "You have been approved! Send /start"
5. User can now run `/setup`

#### `/deny <telegram_id>`
Revokes a user's access. Their credentials remain in the store but they cannot use the bot.

#### `/users`
Lists all users who have ever messaged the bot, their allowed/pending status, and whether they are registered.

---

## All OTM Tools — Step by Step

### Territory Tools

#### `list_territories`
Lists all territories with number, description, availability, last worked date, last check-in date.

**Steps:**
1. Navigates to `GetStandard.php?code=A` (all territories) or `?code=B` (available only)
2. Scrapes the territory table — extracts ID (from onclick attribute), number, description, # available, last worked, last check-in
3. Returns structured array of territory objects

**Example:** *"Show me all available territories"* → `list_territories` with `status_filter="available"`

---

#### `search_territories`
Searches for territories matching a number or keyword.

**Steps:**
1. Navigates to `GetStandard.php?code=A`
2. Runs a regex match against each row's territory number and description
3. Returns only matching rows

**Example:** *"Find territories with Lake Nona"* → `search_territories` with `query="Lake Nona"`

---

#### `load_territory`
Loads a specific territory into the right panel (#listter) so its details appear.

**Steps:**
1. Navigates to `GetStandard.php?code=A`
2. Finds the `<a onclick="getTerList(ID, 0, 0, 0)">` link matching the territory number (by text or title attribute)
3. Playwright clicks the link — this triggers the AJAX call that loads territory details into `#listter`
4. Waits for `#listter` to update (content changes from placeholder to real data)
5. Returns the panel text and HTML

---

#### `get_panel`
Returns the current content of the right panel (#listter).

**Steps:**
1. Reads `document.getElementById('listter').innerText` and `.innerHTML`
2. Returns both text and HTML (truncated to 4000/6000 chars)

Use this after `load_territory` or after clicking a panel button to see what changed.

---

#### `checkout_territory`
Checks out a territory to a publisher — full automated flow.

**Steps:**
1. Calls `loadPanel(territory_number)` — navigates to territory list, clicks the territory link, waits for right panel
2. Searches `#listter` for a button/link containing "check out" text — clicks it
3. If no check-out button found: navigates to the checked-out admin list, finds who has the territory, returns an error like *"Territory OR-15A is already checked out to John Smith since 05/07/2026"*
4. Waits 1.5 seconds for the publisher list to load in the panel
5. Panel now shows: "Who would you like this territory checked out to? : [Publisher Name] (X checked out) ... Yes!"
6. Finds all "Yes!" buttons in the panel, reads the surrounding container text for each, clicks the one whose container text includes the publisher name
7. Waits 2 seconds for confirmation
8. Returns success with the panel text (should contain "Congratulations!")

**Example:** *"Assign territory OR-15A to Phillip Pereira"*

---

#### `return_territory`
Returns (checks in) a territory — full automated flow.

**Steps:**
1. Navigates to `MyTer.php?showallmyter=1&sort=1` (Checked Out Admin)
2. Looks for an "Admin Options" toggle button on the page and clicks it — this reveals the check-in image buttons
3. Waits 1.5 seconds for the buttons to appear
4. Searches for `<a href="PreCheckIn.php?MyTerID=XXXX&MyTerDescr=TERRITORY_NUMBER-...">` — matches territory number in the URL's `MyTerDescr` parameter
5. If not found: checks if the territory appears in the list at all; returns appropriate error
6. Navigates to the `PreCheckIn.php` URL
7. Fills the date field if a date was provided (format: MM/DD/YYYY)
8. Clicks `<input name="No" value="No">` — answers "No" to the routing question
9. Waits for confirmation page and returns result text

**Example:** *"Return territory OR-15A"*

---

#### `get_territory_status`
Checks if a territory is currently checked out and who has it.

**Steps:**
1. Navigates to `MyTer.php?showallmyter=1&sort=1`
2. Searches all table rows for the territory number using regex
3. If found: returns `status: "checked_out"` with the full row text (publisher, date, percentage worked)
4. If not found in checked-out list: calls `loadPanel()` to load the territory and returns `status: "available"`

---

#### `list_checked_out`
Lists every territory currently checked out across the congregation.

**Steps:**
1. Navigates to `MyTer.php?showallmyter=1&sort=1`
2. Scrapes the full table — headers and all rows
3. Returns structured data with count

---

### Publisher Tools

#### `list_publishers`
Lists all publishers/users in the congregation.

**Steps:**
1. Navigates to `Users.php`
2. Scrapes the table of all users
3. Optionally filters rows by a name keyword
4. Returns headers, rows, and count

---

### Report Tools

All report tools share the same scraping approach: navigate → scrape all tables → return text + structured data.

#### `report_worked_log`
Territory Worked Log (`TerrWrkLog.php`) — when each territory was last worked and checked in/out.

**Use for:** *"Which territories haven't been worked in over a year?"*

#### `report_territory_list`
Full Territory List (`TerrListRpt.php`) — printable list with all territory details.

#### `report_checkinout`
S-13 Check In/Out Report (`TerrWrkLogRptV2.php`) — official S-13 format history.

**Versions:** 1, 2 (default), or 3. Example: *"Pull the S-13 report version 2"*

#### `report_group_stats`
Group Statistics (`GroupStats.php`) — coverage stats per service group.

#### `report_stats_by_grouping`
Stats By Groupings (`RptStatsByGrouping.php`) — territory stats by grouping/type.

#### `report_address_demographics`
Address Demographics (`RptStatsAddrDemo.php`) — address counts by city, zip, type. Used for *"total confirmed addresses"* queries.

#### `report_territory_export`
Territory List Export (`TerListExp.php`) — exportable territory data.

#### `report_letter_writing`
Letter Writing Stats (`LetterWritingStats.php`) — letter writing activity.

#### `report_address_export`
Address List Export with Return Visits (`Backup.php?what=L`) — full address list including RV notes.

---

### Address Tools

#### `search_addresses`
Searches OTM's address database.

**Steps:**
1. Navigates to `AddrSearch.php`
2. Fills available search fields: street, city, zip, name (tries multiple selector patterns)
3. Submits the form
4. Scrapes result table and returns matching addresses

**Example:** *"Search for addresses on Main Street in Kissimmee"*

---

#### `find_duplicate_addresses`
Runs OTM's built-in duplicate checker.

**Steps:**
1. Navigates to `DupChecker.php`
2. Clicks any submit button to run the check
3. Waits for results and scrapes the table
4. Returns duplicate address records with count

---

#### `add_address`
Adds a new address to OTM — with duplicate check first.

**Steps:**
1. **Partial address lookup** (if city or zip missing): queries OpenStreetMap Nominatim API with the street + "Florida, USA" to resolve city and zip
2. **Duplicate check**: navigates to `AddrSearch.php`, fills street number + name + city, submits. If results found → returns `already_exists: true` with the existing records. Does NOT add.
3. **Navigate to entry form**: opens `AdminSingleAddr.php`
4. **Fill fields**: street number, street name, unit (if provided), city, state (default FL), zip — tries multiple selector patterns for each field
5. **Set language to Portuguese**: finds the language `<select>` and selects the Portuguese option
6. **Mark confirmed** (only if `confirmed: true` was passed): finds the confirmed checkbox and checks it
7. **Click Get Lat/Long**: finds the geocoding button and clicks it, waits up to 10 seconds for lat/lon fields to populate
8. **Save**: clicks the Save button (avoids re-clicking Lat/Long button)
9. Returns success, filled fields, and the page response text

**Rules:** Territory and address type are always left as default (NA / Residential). Language always defaults to Portuguese.

**Example:** *"Add 123 Main St, Apt 4B, Kissimmee FL 34744, mark as confirmed"*

---

### Territory Admin Tools

#### `list_territory_groups`
Lists all territory groupings configured in OTM (`TerGroupAdmin.php`).

#### `list_territory_types`
Lists all territory types (Residential, Business, Letter Writing, etc.) (`TerTypeAdmin.php`).

#### `list_campaigns`
Lists all campaigns (`CampaignAdmin.php`).

---

### Route Territory

#### `route_territory`
Automatically routes a territory's addresses in a logical driving order starting from the congregation home base (1675 Jack Calhoun Dr, Kissimmee FL 34741) using Geocodio batch geocoding and a nearest-neighbor path algorithm.

**Steps:**
1. Navigates to `TerRoute.php`
2. Finds the territory in the `<select id="TerID">` dropdown by matching the territory number in the option text
3. Sets the select value and clicks `Edit Route` (`input[name="Route"]`)
4. Waits for the routing page to load — this shows `#dragbox` with `<li id="ADDRESS_ID">` elements
5. Reads all address IDs and text from `#dragbox` plus cleaner text from the `copypaste` textarea
6. **Geocoding (batch, with cache):** Checks `geocode-cache.json` for previously resolved addresses. Any unknown addresses are sent in a single POST to the Geocodio batch API (`GEO_KEY`). Results are merged with cache hits and the cache is updated — addresses are never geocoded twice
7. **Nearest-neighbor routing:** Starting at the home base, greedily selects the closest unvisited address at each step using the Haversine formula. Produces a logical driving path (no zigzagging). Addresses that failed to geocode are appended at the end
8. Reorders the `#dragbox` DOM by calling `parent.appendChild(li)` for each address in sorted order — no drag simulation needed
9. Clicks `Save Route` — the button's `onclick="dosave()"` fires first, which reads all `<li>` IDs in current DOM order into the `RouteOrder` hidden field, then the form submits
10. Returns the sorted route order with distances

**Note:** First run geocodes all addresses in one Geocodio batch request (~2–5 seconds total). Subsequent runs for the same territory are instant thanks to the cache. Tasks with "route" in the message automatically get a 4-minute timeout.

**Requires:** `GEO_KEY` (Geocodio API key) in `.env`.

**Example:** *"Route territory OR-15A"*

---

### Admin Tools

#### `list_announcements`
Lists current announcements posted to OTM users (`AnnounceAdmin.php`).

#### `get_congregation_options`
Returns congregation-wide settings (`GroupPref.php`) — scrapes all form inputs with their current values.

#### `get_user_preferences`
Returns the current user's OTM preferences (`UserPref.php`) — scrapes all form inputs.

---

### Generic / Debug Tools

#### `click_panel_button`
Clicks a button or link inside the right panel (#listter) by visible text.

**Steps:**
1. Searches `#listter` for all `<a>`, `<button>`, and `<input>` elements
2. Finds the first one whose text/value contains the given string (case-insensitive)
3. Clicks it, waits 1.5 seconds
4. Returns the new panel content

**Use when:** The AI needs to click something specific inside the panel after `load_territory` or `checkout_territory`.

---

#### `get_page_content`
Returns the full visible text of the current page plus the URL. Used when the AI needs to understand the current page state before acting.

#### `navigate_page`
Navigates to any OTM path or full URL. Example: `navigate_page` with `/GetStandard.php?code=B`

#### `take_screenshot`
Takes a PNG screenshot of the current page and returns it as base64. Used for visual debugging when other approaches fail.

---

## Setup & Running

### First Time Setup

**1. Install Node.js** — download LTS from nodejs.org

**2. Install dependencies:**
```bash
npm install
npx playwright install chromium
```

**3. Create `.env`** — copy the template and fill in:
- OTM credentials
- At least one AI API key
- Telegram bot token and your admin ID
- Generate `STORE_KEY`: `node -e "import('crypto').then(m => console.log(m.randomBytes(32).toString('hex')))"`

**4. Run the bot:**
```bash
node bot.js
```

**5. Message your bot on Telegram** — send `/start` to begin setup

### Keeping the Bot Running (PM2)

```bash
npm install -g pm2
pm2 start bot.js --name otm-bot
pm2 save
pm2-windows-startup install    # Windows auto-start on reboot
```

### CLI Usage (without Telegram)

```bash
node index.js "Show me all available territories"
node index.js --provider openai "Assign territory OR-15A to John Smith"
node index.js --provider groq --model llama-3.3-70b-versatile "Return territory OR-02"
node index.js --help
```

### MCP Server (Claude Desktop)

```bash
node mcp-server.js
```

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OTM_USER` | CLI/MCP only | OTM login username |
| `OTM_PASS` | CLI/MCP only | OTM login password |
| `HEADLESS` | No | `true` (invisible) or `false` (visible browser for debugging) |
| `AI_PROVIDER` | No | Default provider: `anthropic`, `openai`, or `groq` |
| `ANTHROPIC_API_KEY` | If using Anthropic | From console.anthropic.com |
| `OPENAI_API_KEY` | If using OpenAI | From platform.openai.com |
| `GROQ_API_KEY` | If using Groq | From console.groq.com |
| `GEO_KEY` | For `route_territory` | Geocodio API key — get one at geocod.io |
| `TELEGRAM_BOT_TOKEN` | Bot only | From @BotFather on Telegram |
| `TELEGRAM_ADMIN_IDS` | Bot only | Your Telegram numeric ID (comma-separated for multiple) |
| `STORE_KEY` | Bot only | 64-char hex key for AES-256-GCM credential encryption |

---

## Multi-User / Multi-Congregation

The bot supports multiple users, each with their own OTM credentials and browser session.

**How credentials are stored:**
- Each user's OTM username and password are encrypted with AES-256-GCM using `STORE_KEY`
- Stored in `data/users.json`
- Each user has their own browser session with cookies at `cookies/<userId>.json`

**How sessions work:**
- One Chromium browser instance per registered user
- Sessions are pre-authenticated during `/setup` so the first task is fast
- If a session expires mid-task, `navigate()` detects the login page and re-authenticates automatically

**All users use the same `https://onlineterritorymanager.com` URL — only credentials differ.**

**Onboarding a new user:**
1. They message the bot → bot replies with their Telegram ID and blocks them
2. You run `/allow 123456789` — they get notified
3. They run `/setup` → enter their OTM username then password
4. Bot verifies login, saves credentials, they're ready

---

## How the Agent Loop Works

1. Your message → `bot.js` loads your stored credentials + conversation history (last 3 exchanges, expires after 30 minutes)
2. `runAgentLoop()` in `providers.js` sends to the AI with: system prompt + OTM knowledge base + tool definitions + history + your message
3. AI responds with a tool call (e.g. `checkout_territory`)
4. Tool is executed by `mcp-server.js` → `browser.js` → live OTM site
5. Result returned to AI (truncated to 8000 chars if very large)
6. AI decides what to do next — more tools, or final answer
7. Loop continues up to **12 turns** maximum
8. Final AI text sent back to Telegram as two messages: tool summary (code block) + plain text response
9. Exchange saved to conversation history so follow-up questions have context

**Conversation history:** If you ask "What is the total for Melbourne and Palm Bay?" right after a demographics report, the AI uses the numbers already in the conversation without calling any tools again.

---

## Reliability Features

| Feature | How it works |
|---------|-------------|
| **Session auto-recovery** | Every `navigate()` call checks if OTM redirected to the login page. If it did, `login()` is called automatically before retrying |
| **Loop detection** | If the same tool is called 3+ times in the last 5 turns, it's flagged as a loop and the AI gets an error message |
| **Task timeout** | Regular tasks: 75 seconds. Routing tasks: 4 minutes. On timeout, old "Working..." message is deleted and a clear error is sent |
| **Turn limit** | Maximum 12 AI turns per task. Prevents runaway loops |
| **Already checked out guard** | If `checkout_territory` finds no Check Out button, it looks up who has the territory and returns a specific error |
| **Error as data** | All tool errors are returned as `{ error: true, message: "..." }` so the AI can reason about them rather than crashing |
| **Per-user sessions** | Each user has an isolated browser — one user's session expiring doesn't affect others |
| **Pre-authentication** | After `/setup`, the real browser session is immediately logged in. First task doesn't cold-start |
| **Cookie persistence** | Login session is saved to `cookies/<userId>.json` and reloaded on restart |

---

## OTM Site Map

| Page | URL | Tool(s) |
|------|-----|---------|
| Territory List | `GetStandard.php` | `list_territories`, `search_territories`, `load_territory`, `checkout_territory` |
| Available Only | `GetStandard.php?code=B` | `list_territories` with filter |
| Checked Out Admin | `MyTer.php?showallmyter=1&sort=1` | `list_checked_out`, `return_territory`, `get_territory_status` |
| My Territory Folder | `MyTer.php?showallmyter=0` | — |
| Users/Publishers | `Users.php` | `list_publishers` |
| Address Search | `AddrSearch.php` | `search_addresses`, `add_address` (step 2) |
| Address Entry | `AdminSingleAddr.php` | `add_address` (step 3–8) |
| Duplicate Checker | `DupChecker.php` | `find_duplicate_addresses` |
| Route Setup | `TerRoute.php` | `route_territory` |
| Territory Groups | `TerGroupAdmin.php` | `list_territory_groups` |
| Territory Types | `TerTypeAdmin.php` | `list_territory_types` |
| Campaigns | `CampaignAdmin.php` | `list_campaigns` |
| Announcements | `AnnounceAdmin.php` | `list_announcements` |
| Congregation Options | `GroupPref.php` | `get_congregation_options` |
| User Preferences | `UserPref.php` | `get_user_preferences` |
| Territory Worked Log | `TerrWrkLog.php` | `report_worked_log` |
| Territory List Report | `TerrListRpt.php` | `report_territory_list` |
| S-13 v2 | `TerrWrkLogRptV2.php` | `report_checkinout` |
| Group Stats | `GroupStats.php` | `report_group_stats` |
| Stats By Grouping | `RptStatsByGrouping.php` | `report_stats_by_grouping` |
| Address Demographics | `RptStatsAddrDemo.php` | `report_address_demographics` |
| Territory Export | `TerListExp.php` | `report_territory_export` |
| Letter Writing Stats | `LetterWritingStats.php` | `report_letter_writing` |
| Address Export w/RV | `Backup.php?what=L` | `report_address_export` |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | `pm2 logs otm-bot` — check the console |
| Login fails in /setup | Double-check OTM username/password. Set `HEADLESS=false` to watch |
| Session keeps dropping | Run `/debug` — if it fails, run `/setup` again |
| Territory not found | Use `list_territories` to find the exact number (e.g. "OR-15A" not "OR15A") |
| Wrong publisher checked out | Provide the full name exactly as it appears in OTM. Use `list_publishers` first |
| Task times out | Break into smaller steps. Routing tasks always get 4 minutes automatically |
| Loop error message | The AI tried the same tool 3+ times. Rephrase the task more specifically |
| Already checked out error | The territory is out — use `get_territory_status` to see who has it |
| Address already exists | `add_address` found it in `AddrSearch.php` — it won't add a duplicate |
| Lat/Long not populating | OTM's geocoding API may be slow. The tool waits 10 seconds then saves anyway |
