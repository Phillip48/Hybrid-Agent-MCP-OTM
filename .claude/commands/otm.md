Run an OTM territory management task through the Claude agent loop.

## Usage

```
/otm <natural language task>
```

## What this does

Executes `node index.js "<task>"` in the project directory, which:
1. Starts a Playwright browser session (headless by default).
2. Logs in to OTM using credentials from `.env` (reuses `cookies.json` if valid).
3. Runs the Claude agentic loop — Claude picks the right tools and executes the task.
4. Prints each tool call and result, then summarizes what happened.

## Example tasks

```
/otm Show me all available territories
/otm What territories does John Smith currently have checked out?
/otm Assign territory 42 to Jane Doe
/otm Return territory 15 — it came back today
/otm List all territories checked out for more than 6 months
/otm How many territories are in group 3?
```

## Debug mode

To watch the browser window while the task runs:

```
/otm HEADLESS=false — Assign territory 7 to Mary Johnson
```

(The agent will prepend `HEADLESS=false` to the command.)

## Troubleshooting prompt

If the task fails, follow up with:

```
/otm get page content
```

to see what the browser is currently showing, or:

```
/otm take a screenshot
```

to get a visual of the current page state.
