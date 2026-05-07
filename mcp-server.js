#!/usr/bin/env node
/**
 * OTM MCP Server
 *
 * Exposes Online Territory Manager actions as MCP tools so any MCP-compatible
 * client (Claude Desktop, VS Code extension, etc.) can drive OTM through
 * plain-English requests.
 *
 * Run standalone:  node mcp-server.js
 * Or add to claude_desktop_config.json → mcpServers.
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import session, { OTM_BASE } from './browser.js';

// ── Tool definitions ────────────────────────────────────────────────────────

export const OTM_TOOLS = [
  {
    name: 'list_territories',
    description:
      'Lists all territories in the congregation with their number, name, and current status (Available, Checked Out, etc.). Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          description:
            'Optional. Filter by status keyword, e.g. "available", "checked out", "do not call".',
        },
      },
    },
  },
  {
    name: 'get_territory',
    description:
      'Gets full details of a single territory by its number or ID, including assignment history and contact notes.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: {
          type: 'string',
          description: 'The territory number or ID (e.g. "42" or "S-42").',
        },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'search_territories',
    description:
      'Searches territories by number, name, city, or description. Returns a list of matching territories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — territory number, partial name, city, etc.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_territory_status',
    description:
      'Returns the current checkout status of a territory: who has it, when it was checked out, and how long it has been out.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: {
          type: 'string',
          description: 'The territory number or ID.',
        },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'assign_territory',
    description:
      'Checks out (assigns) a territory to a publisher. The territory must currently be available.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: {
          type: 'string',
          description: 'The territory number or ID to assign.',
        },
        publisher_name: {
          type: 'string',
          description: 'Full name of the publisher to assign the territory to.',
        },
        date: {
          type: 'string',
          description: 'Checkout date in YYYY-MM-DD format. Defaults to today.',
        },
      },
      required: ['territory_number', 'publisher_name'],
    },
  },
  {
    name: 'return_territory',
    description:
      'Marks a checked-out territory as returned. Records the return date.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: {
          type: 'string',
          description: 'The territory number or ID to return.',
        },
        date: {
          type: 'string',
          description: 'Return date in YYYY-MM-DD format. Defaults to today.',
        },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'list_publishers',
    description:
      'Lists all publishers in the congregation with their name, group, and any currently assigned territories.',
    inputSchema: {
      type: 'object',
      properties: {
        group_filter: {
          type: 'string',
          description: 'Optional. Filter by group or service group name/number.',
        },
      },
    },
  },
  {
    name: 'get_publisher',
    description:
      'Gets details for a specific publisher: their territory history, currently held territories, and contact info.',
    inputSchema: {
      type: 'object',
      properties: {
        publisher_name: {
          type: 'string',
          description: 'Full or partial name of the publisher.',
        },
      },
      required: ['publisher_name'],
    },
  },
  {
    name: 'navigate_page',
    description:
      'Navigates the browser to a specific OTM page path or URL. Useful for exploring sections not covered by other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path (e.g. "/territories", "/publishers") or full URL.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_page_content',
    description:
      'Returns the visible text and URL of the current page. Use this to understand the page before clicking or filling forms.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'click_element',
    description:
      'Clicks an element on the current page identified by a CSS selector or visible text (prefix with "text=").',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector OR text content prefixed with "text=" (e.g. "text=Submit", "button.btn-primary").',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill_form',
    description:
      'Fills a form input field identified by a CSS selector with the given value.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input field.',
        },
        value: {
          type: 'string',
          description: 'Value to type into the field.',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Takes a screenshot of the current browser page and returns it as a base64-encoded PNG. Use this to verify page state or debug visual issues.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── Shared helpers ───────────────────────────────────────────────────────────

async function withBrowser(fn) {
  try {
    await session.ensureLoggedIn();
    return await fn();
  } catch (err) {
    return {
      error: true,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 5).join('\n'),
    };
  }
}

// Scrape the territory list page.
async function scrapeTerritoryList(statusFilter) {
  await session.navigate('/territories');

  const tableData = await session.scrapeTable('table');
  if (tableData && tableData.rows.length > 0) {
    let rows = tableData.rows;
    if (statusFilter) {
      const lc = statusFilter.toLowerCase();
      rows = rows.filter((r) => r.some((cell) => cell.toLowerCase().includes(lc)));
    }
    return { headers: tableData.headers, territories: rows };
  }

  // Fallback: card layout.
  const cards = await session.getAllElements('.territory-card, .card, [class*="territory"]');
  if (cards.length > 0) return { territories: cards.map((c) => ({ text: c.text })) };

  const body = await session.evaluate(() => document.body.innerText);
  return { raw: body.slice(0, 5000) };
}

// Navigate to a territory detail page by number.
async function navigateToTerritory(number) {
  await session.navigate('/territories');

  const links = await session.findLinks(number);
  if (links.length > 0) {
    await session.page.goto(links[0].href, { waitUntil: 'domcontentloaded' });
    return;
  }

  // Try search input.
  try {
    await session.fill(
      'input[name="q"], input[placeholder*="search" i], input[type="search"]',
      number,
    );
    await session.page.keyboard.press('Enter');
    await session.page.waitForLoadState('domcontentloaded');
    const afterLinks = await session.findLinks(number);
    if (afterLinks.length > 0) {
      await session.page.goto(afterLinks[0].href, { waitUntil: 'domcontentloaded' });
    }
  } catch {}
}

// ── Tool handlers ────────────────────────────────────────────────────────────

async function handleListTerritories({ status_filter } = {}) {
  return withBrowser(() => scrapeTerritoryList(status_filter));
}

async function handleGetTerritory({ territory_number }) {
  return withBrowser(async () => {
    await navigateToTerritory(territory_number);
    const url = await session.getCurrentUrl();
    const table = await session.scrapeTable('table');
    const body = await session.evaluate(() => document.body.innerText);
    return { url, table, text: body.slice(0, 4000) };
  });
}

async function handleSearchTerritories({ query }) {
  return withBrowser(async () => {
    await session.navigate(`/territories?q=${encodeURIComponent(query)}`);
    const table = await session.scrapeTable('table');
    if (table && table.rows.length > 0) return { headers: table.headers, territories: table.rows };
    return scrapeTerritoryList(query);
  });
}

async function handleGetTerritoryStatus({ territory_number }) {
  return withBrowser(async () => {
    await navigateToTerritory(territory_number);
    const url = await session.getCurrentUrl();
    const body = await session.evaluate(() => document.body.innerText);
    const keywords = ['checked out', 'available', 'assigned', 'returned', 'publisher', 'date'];
    const relevant = body
      .split('\n')
      .filter((l) => keywords.some((k) => l.toLowerCase().includes(k)))
      .join('\n');
    return { url, status_text: relevant || body.slice(0, 3000) };
  });
}

async function handleAssignTerritory({ territory_number, publisher_name, date }) {
  return withBrowser(async () => {
    await navigateToTerritory(territory_number);

    const checkoutSelectors = [
      'a:has-text("Check Out")',
      'a:has-text("Assign")',
      'button:has-text("Check Out")',
      'button:has-text("Assign")',
      '[href*="checkout"]',
      '[href*="assign"]',
      '[href*="new_assignment"]',
    ];

    let clicked = false;
    for (const sel of checkoutSelectors) {
      try { await session.click(sel); clicked = true; break; } catch {}
    }
    if (!clicked) {
      const html = (await session.getPageContent()).slice(0, 3000);
      return { error: false, message: 'No checkout/assign button found — page HTML returned.', html };
    }

    await session.page.waitForLoadState('domcontentloaded');

    const publisherSelectors = [
      'select[name*="publisher"]',
      '#assignment_publisher_id',
      'input[name*="publisher"]',
      'input[placeholder*="publisher" i]',
      'input[placeholder*="name" i]',
    ];

    for (const sel of publisherSelectors) {
      try {
        const tag = await session.evaluate(
          (s) => document.querySelector(s)?.tagName?.toLowerCase(),
          sel,
        );
        if (tag === 'select') {
          await session.page.selectOption(sel, { label: publisher_name });
        } else {
          await session.fill(sel, publisher_name);
        }
        break;
      } catch {}
    }

    if (date) {
      for (const sel of ['input[name*="date"]', 'input[type="date"]', '#assignment_date']) {
        try { await session.fill(sel, date); break; } catch {}
      }
    }

    for (const sel of ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Save")', 'button:has-text("Assign")']) {
      try { await session.click(sel); break; } catch {}
    }

    await session.page.waitForLoadState('networkidle').catch(() => {});
    const resultUrl = await session.getCurrentUrl();
    const resultBody = await session.evaluate(() => document.body.innerText);
    return { success: true, url: resultUrl, message: resultBody.slice(0, 1000) };
  });
}

async function handleReturnTerritory({ territory_number, date }) {
  return withBrowser(async () => {
    await navigateToTerritory(territory_number);

    const returnSelectors = [
      'a:has-text("Return")',
      'button:has-text("Return")',
      '[href*="return"]',
      'a:has-text("Mark Returned")',
      'a:has-text("Complete")',
    ];

    let clicked = false;
    for (const sel of returnSelectors) {
      try { await session.click(sel); clicked = true; break; } catch {}
    }
    if (!clicked) {
      const html = (await session.getPageContent()).slice(0, 3000);
      return { error: false, message: 'No return button found — page HTML returned.', html };
    }

    await session.page.waitForLoadState('domcontentloaded');

    if (date) {
      for (const sel of ['input[name*="date"]', 'input[type="date"]', '#return_date']) {
        try { await session.fill(sel, date); break; } catch {}
      }
    }

    for (const sel of ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Save")', 'button:has-text("Return")']) {
      try { await session.click(sel); break; } catch {}
    }

    await session.page.waitForLoadState('networkidle').catch(() => {});
    const resultUrl = await session.getCurrentUrl();
    const resultBody = await session.evaluate(() => document.body.innerText);
    return { success: true, url: resultUrl, message: resultBody.slice(0, 1000) };
  });
}

async function handleListPublishers({ group_filter } = {}) {
  return withBrowser(async () => {
    await session.navigate('/publishers');
    const table = await session.scrapeTable('table');
    if (table && table.rows.length > 0) {
      let rows = table.rows;
      if (group_filter) {
        const lc = group_filter.toLowerCase();
        rows = rows.filter((r) => r.some((c) => c.toLowerCase().includes(lc)));
      }
      return { headers: table.headers, publishers: rows };
    }
    const body = await session.evaluate(() => document.body.innerText);
    return { raw: body.slice(0, 4000) };
  });
}

async function handleGetPublisher({ publisher_name }) {
  return withBrowser(async () => {
    await session.navigate(`/publishers?q=${encodeURIComponent(publisher_name)}`);
    const links = await session.findLinks(publisher_name);
    if (links.length > 0) {
      await session.page.goto(links[0].href, { waitUntil: 'domcontentloaded' });
    }
    const url = await session.getCurrentUrl();
    const table = await session.scrapeTable('table');
    const body = await session.evaluate(() => document.body.innerText);
    return { url, table, text: body.slice(0, 4000) };
  });
}

async function handleNavigatePage({ path }) {
  return withBrowser(async () => {
    const url = await session.navigate(path);
    return { navigated_to: url };
  });
}

async function handleGetPageContent() {
  return withBrowser(async () => {
    const url = await session.getCurrentUrl();
    const title = await session.evaluate(() => document.title);
    const text = await session.evaluate(() => document.body.innerText);
    return { url, title, text: text.slice(0, 6000) };
  });
}

async function handleClickElement({ selector }) {
  return withBrowser(async () => {
    await session.click(selector);
    const url = await session.getCurrentUrl();
    return { clicked: selector, current_url: url };
  });
}

async function handleFillForm({ selector, value }) {
  return withBrowser(async () => {
    await session.fill(selector, value);
    return { filled: selector, value };
  });
}

async function handleTakeScreenshot() {
  return withBrowser(async () => {
    const b64 = await session.screenshot();
    return { screenshot_base64: b64, note: 'Base64-encoded PNG of the current page.' };
  });
}

// ── Public dispatch ──────────────────────────────────────────────────────────

export async function callTool(name, args = {}) {
  switch (name) {
    case 'list_territories':     return handleListTerritories(args);
    case 'get_territory':        return handleGetTerritory(args);
    case 'search_territories':   return handleSearchTerritories(args);
    case 'get_territory_status': return handleGetTerritoryStatus(args);
    case 'assign_territory':     return handleAssignTerritory(args);
    case 'return_territory':     return handleReturnTerritory(args);
    case 'list_publishers':      return handleListPublishers(args);
    case 'get_publisher':        return handleGetPublisher(args);
    case 'navigate_page':        return handleNavigatePage(args);
    case 'get_page_content':     return handleGetPageContent();
    case 'click_element':        return handleClickElement(args);
    case 'fill_form':            return handleFillForm(args);
    case 'take_screenshot':      return handleTakeScreenshot();
    default:
      return { error: true, message: `Unknown tool: ${name}` };
  }
}

// ── MCP Server bootstrap ─────────────────────────────────────────────────────

async function startMcpServer() {
  const server = new Server(
    { name: 'otm-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OTM_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await callTool(name, args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[OTM MCP Server] Running on stdio — ready for connections.');
}

// Only start the server when run directly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startMcpServer().catch((err) => {
    console.error('[OTM MCP Server] Fatal:', err);
    process.exit(1);
  });
}
