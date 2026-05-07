#!/usr/bin/env node
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import defaultSession, { BrowserSession } from './browser.js';

// ── Tool definitions ─────────────────────────────────────────────────────────

export const OTM_TOOLS = [
  {
    name: 'list_territories',
    description: 'Lists all territories with number, description, availability, last worked, last check-in. Use status_filter="available" to show only available ones.',
    inputSchema: {
      type: 'object',
      properties: {
        status_filter: { type: 'string', description: '"available" to show only available territories, omit for all.' },
      },
    },
  },
  {
    name: 'search_territories',
    description: 'Search territories by number or name/description keyword. Returns matching rows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Territory number (e.g. "OR-15A") or keyword (e.g. "Lake Nona").' },
      },
      required: ['query'],
    },
  },
  {
    name: 'load_territory',
    description: 'Loads a territory into the right panel by number. MUST be called before checkout, return, or viewing details. Returns the panel content so you know what buttons/forms are available.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: { type: 'string', description: 'Exact territory number, e.g. "OR-15A".' },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'get_panel',
    description: 'Returns the current content of the right panel (#listter). Call this after load_territory or after clicking a panel button to see what changed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'checkout_territory',
    description: 'Completes the full checkout flow: loads territory, clicks the checkout button, selects the publisher, fills the date, and confirms. Use this for assigning a territory to a publisher.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: { type: 'string', description: 'Territory number, e.g. "OR-15A".' },
        publisher_name:   { type: 'string', description: 'Full or partial name of the publisher as it appears in OTM.' },
        date:             { type: 'string', description: 'Checkout date MM/DD/YYYY or YYYY-MM-DD. Defaults to today.' },
      },
      required: ['territory_number', 'publisher_name'],
    },
  },
  {
    name: 'return_territory',
    description: 'Returns a checked-out territory. Navigates to the checked-out admin list, finds the territory, and clicks the return/check-in link.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: { type: 'string', description: 'Territory number, e.g. "OR-15A".' },
        date:             { type: 'string', description: 'Return date MM/DD/YYYY or YYYY-MM-DD. Defaults to today.' },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'get_territory_status',
    description: 'Checks whether a territory is currently checked out (and by whom) or available.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: { type: 'string', description: 'Territory number, e.g. "OR-15A".' },
      },
      required: ['territory_number'],
    },
  },
  {
    name: 'list_checked_out',
    description: 'Lists ALL currently checked-out territories with publisher name and checkout date. Use this to see what is currently out.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_publishers',
    description: 'Lists all publishers/users in the congregation.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional name filter.' },
      },
    },
  },
  {
    name: 'click_panel_button',
    description: 'Clicks a button or link inside the right panel by its visible text. Use after get_panel shows you what buttons exist.',
    inputSchema: {
      type: 'object',
      properties: {
        button_text: { type: 'string', description: 'Exact or partial visible text of the button/link to click.' },
      },
      required: ['button_text'],
    },
  },
  {
    name: 'get_page_content',
    description: 'Returns the full visible text of the current page. Use to understand the page when lost.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate_page',
    description: 'Navigates to a specific OTM page path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. "/GetStandard.php" or "/MyTer.php?showallmyter=1".' },
      },
      required: ['path'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Takes a screenshot. Use when other approaches fail to understand the page state.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Reports ────────────────────────────────────────────────────────────────
  {
    name: 'report_worked_log',
    description: 'Territory Worked Log — shows when each territory was last worked and checked in/out. Use to find territories not worked recently.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_territory_list',
    description: 'Full territory list report — all territories with their details, addresses, and status. Printable format.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_checkinout',
    description: 'Check In/Out S-13 report — the official S-13 style report showing territory assignment history.',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Report version: "1", "2", or "3". Defaults to "2".' },
      },
    },
  },
  {
    name: 'report_group_stats',
    description: 'Group Statistics — shows territory coverage stats per service group.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_stats_by_grouping',
    description: 'Stats By Groupings — territory statistics broken down by territory grouping/type.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_address_demographics',
    description: 'Address Demographics — breakdown of address types and counts across territories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_territory_export',
    description: 'Territory List Export — exportable list of all territories with full details.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool implementation factory ───────────────────────────────────────────────

export function createCallTool(session) {

  async function withBrowser(fn) {
    try {
      await session.ensureLoggedIn();
      return await fn();
    } catch (err) {
      return { error: true, message: err.message };
    }
  }

  const PAGES = {
    all:              '/GetStandard.php?code=A',
    available:        '/GetStandard.php?code=B',
    checkedOut:       '/MyTer.php?showallmyter=1&sort=1',
    publishers:       '/Users.php',
    workedLog:        '/TerrWrkLog.php',
    territoryList:    '/TerrListRpt.php',
    territoryExport:  '/TerListExp.php',
    checkinV1:        '/TerrWrkLogRptV1.php',
    checkinV2:        '/TerrWrkLogRptV2.php',
    checkinV3:        '/TerrWrkLogRptV3_Blank.php',
    groupStats:       '/GroupStats.php',
    statsByGrouping:  '/RptStatsByGrouping.php',
    addrDemographics: '/RptStatsAddrDemo.php',
  };

  // ── Core helpers ────────────────────────────────────────────────────────────

  async function scrapePanel() {
    const text = await session.evaluate(() =>
      (document.getElementById('listter')?.innerText ?? '').trim()
    );
    const html = await session.evaluate(() =>
      (document.getElementById('listter')?.innerHTML ?? '').trim()
    );
    return { text: text.slice(0, 4000), html: html.slice(0, 6000) };
  }

  // Find territory by number text or title attribute, return its OTM JS id.
  async function findTerritoryId(number) {
    return session.evaluate((num) => {
      const links = [...document.querySelectorAll('a[onclick*="getTerList"]')];
      const link  = links.find(a => {
        const txt   = a.textContent.trim();
        const title = a.title ?? '';
        return txt === num || title.startsWith(num + '-') || title.includes('-' + num + '-');
      });
      if (!link) return null;
      const m = link.getAttribute('onclick').match(/getTerList\((\d+)/);
      return m ? m[1] : null;
    }, number);
  }

  // Load a territory into the right panel by actually clicking its link in the DOM.
  async function loadPanel(number) {
    await session.navigate(PAGES.all);
    const id = await findTerritoryId(number);
    if (!id) throw new Error(`Territory "${number}" not found in list. Use list_territories to find the exact number.`);

    // Use a real DOM click so the onclick handler fires naturally and triggers the AJAX load.
    await session.page.locator(`a[onclick*="getTerList(${id}"]`).click({ timeout: 5000 });

    // Wait for #listter to change from the default placeholder text.
    await session.page.waitForFunction(
      () => {
        const t = (document.getElementById('listter')?.innerText ?? '').trim();
        return t.length > 30 && !t.startsWith('Please select');
      },
      { timeout: 10000 }
    ).catch(() => {});

    return scrapePanel();
  }

  // Click something inside #listter by text.
  async function clickInPanel(text) {
    const clicked = await session.evaluate((txt) => {
      const panel = document.getElementById('listter');
      if (!panel) return false;
      const el = [...panel.querySelectorAll('a, button, input[type="submit"], input[type="button"]')]
        .find(e => e.textContent.trim().toLowerCase().includes(txt.toLowerCase()) ||
                   e.value?.toLowerCase().includes(txt.toLowerCase()));
      if (!el) return false;
      el.click();
      return el.textContent.trim() || el.value || true;
    }, text);
    return clicked;
  }

  // Format a date to MM/DD/YYYY which OTM uses in its date inputs.
  function formatDate(d) {
    if (!d) {
      const n = new Date();
      return `${String(n.getMonth()+1).padStart(2,'0')}/${String(n.getDate()).padStart(2,'0')}/${n.getFullYear()}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y,m,day] = d.split('-');
      return `${m}/${day}/${y}`;
    }
    return d;
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleListTerritories({ status_filter } = {}) {
    return withBrowser(async () => {
      const url = status_filter?.toLowerCase().includes('avail') ? PAGES.available : PAGES.all;
      await session.navigate(url);
      const territories = await session.evaluate(() =>
        [...document.querySelectorAll('table tbody tr')].map(row => {
          const link  = row.querySelector('a[onclick]');
          const cells = [...row.querySelectorAll('td')];
          const m     = link?.getAttribute('onclick')?.match(/getTerList\((\d+)/);
          return {
            id:          m?.[1] ?? null,
            number:      cells[0]?.textContent.trim(),
            description: cells[1]?.textContent.trim(),
            available:   cells[2]?.textContent.trim(),
            lastWorked:  cells[5]?.textContent.trim(),
            lastCheckIn: cells[6]?.textContent.trim(),
          };
        }).filter(t => t.number)
      );
      return { territories, count: territories.length };
    });
  }

  async function handleSearchTerritories({ query }) {
    return withBrowser(async () => {
      await session.navigate(PAGES.all);
      const results = await session.evaluate((q) => {
        const re = new RegExp(q, 'i');
        return [...document.querySelectorAll('table tbody tr')].map(row => {
          const link  = row.querySelector('a[onclick]');
          const cells = [...row.querySelectorAll('td')];
          const m     = link?.getAttribute('onclick')?.match(/getTerList\((\d+)/);
          return {
            id:          m?.[1] ?? null,
            number:      cells[0]?.textContent.trim(),
            description: cells[1]?.textContent.trim(),
            available:   cells[2]?.textContent.trim(),
            lastWorked:  cells[5]?.textContent.trim(),
          };
        }).filter(t => t.number && (re.test(t.number) || re.test(t.description)));
      }, query);
      return { territories: results, count: results.length };
    });
  }

  async function handleLoadTerritory({ territory_number }) {
    return withBrowser(() => loadPanel(territory_number));
  }

  async function handleGetPanel() {
    return withBrowser(() => scrapePanel());
  }

  async function handleCheckoutTerritory({ territory_number, publisher_name, date }) {
    return withBrowser(async () => {
      // Step 1: Load territory into right panel.
      console.log(`[checkout] Loading territory ${territory_number}`);
      const panel = await loadPanel(territory_number);

      // Step 2: Click the Check Out button.
      console.log('[checkout] Clicking Check Out button');
      const checkoutClicked = await clickInPanel('check out');
      if (!checkoutClicked) {
        return {
          error: false,
          message: 'Could not find a "Check Out" button in the panel. The territory may already be checked out.',
          panelText: panel.text,
        };
      }

      // Wait for the checkout form to appear.
      await session.page.waitForTimeout(1500);
      const formPanel = await scrapePanel();
      console.log('[checkout] Panel after clicking Check Out:', formPanel.text.slice(0, 300));

      // Step 3: Find the publisher's row and click their specific "Yes!" button.
      // OTM shows a list of publishers each with their own "Yes!" link next to their name.
      const checkoutDate = formatDate(date);
      const publisherResult = await session.evaluate((name) => {
        const panel = document.getElementById('listter');
        if (!panel) return { error: 'No panel found' };

        const nameLower = name.toLowerCase().trim();

        // Collect all clickable "Yes!" elements in the panel.
        const yesEls = [...panel.querySelectorAll('a, button, input[type="submit"]')]
          .filter(el => /yes/i.test((el.textContent + (el.value || '')).trim()));

        if (yesEls.length === 0) {
          return { error: 'No Yes! buttons found in panel', panelText: panel.innerText.slice(0, 500) };
        }

        // For each Yes! button, read the text of the closest containing block.
        for (const el of yesEls) {
          const container = el.closest('tr, li, p, div') ?? el.parentElement;
          const containerText = (container?.innerText ?? '').toLowerCase();
          if (containerText.includes(nameLower)) {
            el.click();
            return { method: 'yes_button', matched: container.innerText.trim() };
          }
        }

        // Name not found — return available options so the AI knows what's there.
        const options = yesEls.map(el => {
          const container = el.closest('tr, li, p, div') ?? el.parentElement;
          return (container?.innerText ?? '').trim();
        });
        return { error: `Publisher "${name}" not found in checkout list`, availableOptions: options };
      }, publisher_name);

      console.log('[checkout] Publisher result:', JSON.stringify(publisherResult).slice(0, 300));

      if (publisherResult.error) {
        return {
          error: false,
          message: publisherResult.error,
          panelText: formPanel.text,
          availableOptions: publisherResult.availableOptions,
          hint: 'Check the publisher name spelling against availableOptions.',
        };
      }

      await session.page.waitForTimeout(2000);
      const finalPanel = await scrapePanel();
      return {
        success: true,
        publisherMatched: publisherResult.matched,
        date: checkoutDate,
        result: finalPanel.text.slice(0, 1000),
      };
    });
  }

  async function handleReturnTerritory({ territory_number, date }) {
    return withBrowser(async () => {
      console.log(`[return] Navigating to checked-out list`);
      await session.navigate(PAGES.checkedOut);

      // Find the row for this territory.
      const rowFound = await session.evaluate((num) => {
        const re   = new RegExp(num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const rows = [...document.querySelectorAll('table tbody tr')];
        const row  = rows.find(r => re.test(r.textContent));
        return row ? row.innerText.trim() : null;
      }, territory_number);

      if (!rowFound) {
        return { error: false, message: `Territory "${territory_number}" is not in the checked-out list. It may already be returned.` };
      }

      console.log(`[return] Found row: ${rowFound.slice(0, 100)}`);

      // Click the return/check-in link in that row.
      const returnClicked = await session.evaluate((num) => {
        const re   = new RegExp(num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const rows = [...document.querySelectorAll('table tbody tr')];
        const row  = rows.find(r => re.test(r.textContent));
        if (!row) return null;
        const link = [...row.querySelectorAll('a')].find(a =>
          /return|check.?in|checkin|yes/i.test(a.textContent.trim())
        );
        if (link) { link.click(); return link.textContent.trim(); }
        // Log all links found for debugging.
        return { noLink: true, links: [...row.querySelectorAll('a')].map(a => a.textContent.trim()) };
      }, territory_number);

      if (!returnClicked || returnClicked.noLink) {
        const allLinks = returnClicked?.links ?? [];
        return {
          error: false,
          message: 'Found the territory row but no return link.',
          rowText: rowFound,
          availableLinks: allLinks,
          hint: 'Use click_panel_button with one of the availableLinks to return it manually.',
        };
      }

      console.log(`[return] Clicked: ${returnClicked}`);
      await session.page.waitForTimeout(2000);

      // Fill date if provided.
      if (date) {
        const checkoutDate = formatDate(date);
        await session.evaluate((dt) => {
          const inp = document.querySelector('input[type="date"], input[name*="date" i]');
          if (inp) { inp.value = dt; inp.dispatchEvent(new Event('change', { bubbles: true })); }
        }, checkoutDate);
      }

      // Submit any confirmation form.
      await session.evaluate(() => {
        const btn = document.querySelector('input[type="submit"], button[type="submit"]');
        if (btn) btn.click();
      });

      await session.page.waitForTimeout(2000);
      const bodyText = await session.evaluate(() => document.body.innerText);
      return { success: true, clicked: returnClicked, result: bodyText.slice(0, 500) };
    });
  }

  async function handleGetTerritoryStatus({ territory_number }) {
    return withBrowser(async () => {
      await session.navigate(PAGES.checkedOut);
      const row = await session.evaluate((num) => {
        const re   = new RegExp(num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const rows = [...document.querySelectorAll('table tbody tr')];
        const found = rows.find(r => re.test(r.textContent));
        return found ? found.innerText.replace(/\s+/g, ' ').trim() : null;
      }, territory_number);

      if (row) return { status: 'checked_out', details: row };

      const panel = await loadPanel(territory_number);
      return { status: 'available', panelText: panel.text };
    });
  }

  async function handleListCheckedOut() {
    return withBrowser(async () => {
      await session.navigate(PAGES.checkedOut);
      const table = await session.evaluate(() => {
        const headers = [...document.querySelectorAll('table thead th, table thead td')].map(th => th.textContent.trim());
        const rows    = [...document.querySelectorAll('table tbody tr')].map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
        ).filter(r => r.some(c => c));
        return { headers, rows };
      });
      return { ...table, count: table.rows.length };
    });
  }

  async function handleListPublishers({ filter } = {}) {
    return withBrowser(async () => {
      await session.navigate(PAGES.publishers);
      const table = await session.evaluate(() => {
        const headers = [...document.querySelectorAll('table thead th')].map(h => h.textContent.trim());
        const rows    = [...document.querySelectorAll('table tbody tr')].map(tr =>
          [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
        ).filter(r => r.some(c => c));
        return { headers, rows };
      });
      if (filter) {
        const lc = filter.toLowerCase();
        table.rows = table.rows.filter(r => r.some(c => c.toLowerCase().includes(lc)));
      }
      return { ...table, count: table.rows.length };
    });
  }

  // ── Report helpers ──────────────────────────────────────────────────────────

  // Scrape any report page — tries all tables and returns text + structured data.
  async function scrapeReportPage(path) {
    await session.navigate(path);
    const title = await session.evaluate(() => document.title);
    const url   = await session.getCurrentUrl();

    // Scrape all tables on the page.
    const tables = await session.evaluate(() => {
      return [...document.querySelectorAll('table')].map(tbl => {
        const headers = [...tbl.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')]
          .map(h => h.textContent.trim()).filter(Boolean);
        const rows = [...tbl.querySelectorAll('tbody tr, tr:not(:first-child)')]
          .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))
          .filter(r => r.some(c => c));
        return { headers, rows, rowCount: rows.length };
      }).filter(t => t.rows.length > 0);
    });

    // Also grab all visible text for pages that aren't pure tables.
    const text = await session.evaluate(() => document.body.innerText);

    return { title, url, tables, text: text.slice(0, 8000) };
  }

  async function handleReportWorkedLog() {
    return withBrowser(() => scrapeReportPage(PAGES.workedLog));
  }

  async function handleReportTerritoryList() {
    return withBrowser(() => scrapeReportPage(PAGES.territoryList));
  }

  async function handleReportCheckinOut({ version = '2' } = {}) {
    const pageMap = { '1': PAGES.checkinV1, '2': PAGES.checkinV2, '3': PAGES.checkinV3 };
    const path = pageMap[version] ?? PAGES.checkinV2;
    return withBrowser(() => scrapeReportPage(path));
  }

  async function handleReportGroupStats() {
    return withBrowser(() => scrapeReportPage(PAGES.groupStats));
  }

  async function handleReportStatsByGrouping() {
    return withBrowser(() => scrapeReportPage(PAGES.statsByGrouping));
  }

  async function handleReportAddressDemographics() {
    return withBrowser(() => scrapeReportPage(PAGES.addrDemographics));
  }

  async function handleReportTerritoryExport() {
    return withBrowser(() => scrapeReportPage(PAGES.territoryExport));
  }

  // ── Generic tools ───────────────────────────────────────────────────────────

  async function handleClickPanelButton({ button_text }) {
    return withBrowser(async () => {
      const result = await clickInPanel(button_text);
      if (!result) return { error: true, message: `No button/link matching "${button_text}" found in the panel.` };
      await session.page.waitForTimeout(1500);
      const panel = await scrapePanel();
      return { clicked: result, panel };
    });
  }

  async function handleGetPageContent() {
    return withBrowser(async () => {
      const url  = await session.getCurrentUrl();
      const text = await session.evaluate(() => document.body.innerText);
      return { url, text: text.slice(0, 6000) };
    });
  }

  async function handleNavigatePage({ path }) {
    return withBrowser(async () => ({ navigated_to: await session.navigate(path) }));
  }

  async function handleTakeScreenshot() {
    return withBrowser(async () => ({
      screenshot_base64: await session.screenshot(),
      note: 'Base64 PNG of current page.',
    }));
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  return async function callTool(name, args = {}) {
    switch (name) {
      case 'list_territories':    return handleListTerritories(args);
      case 'search_territories':  return handleSearchTerritories(args);
      case 'load_territory':      return handleLoadTerritory(args);
      case 'get_panel':           return handleGetPanel();
      case 'checkout_territory':  return handleCheckoutTerritory(args);
      case 'return_territory':    return handleReturnTerritory(args);
      case 'get_territory_status':return handleGetTerritoryStatus(args);
      case 'list_checked_out':    return handleListCheckedOut();
      case 'list_publishers':     return handleListPublishers(args);
      case 'click_panel_button':       return handleClickPanelButton(args);
      case 'get_page_content':         return handleGetPageContent();
      case 'navigate_page':            return handleNavigatePage(args);
      case 'take_screenshot':          return handleTakeScreenshot();
      case 'report_worked_log':        return handleReportWorkedLog();
      case 'report_territory_list':    return handleReportTerritoryList();
      case 'report_checkinout':        return handleReportCheckinOut(args);
      case 'report_group_stats':       return handleReportGroupStats();
      case 'report_stats_by_grouping': return handleReportStatsByGrouping();
      case 'report_address_demographics': return handleReportAddressDemographics();
      case 'report_territory_export':  return handleReportTerritoryExport();
      default:
        return { error: true, message: `Unknown tool: ${name}` };
    }
  };
}

// Pre-built callTool using the singleton session (CLI / MCP server).
export const callTool = createCallTool(defaultSession);

// ── Standalone MCP Server ────────────────────────────────────────────────────

async function startMcpServer() {
  const server = new Server(
    { name: 'otm-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OTM_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const result = await callTool(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
  await server.connect(new StdioServerTransport());
  console.error('[OTM MCP Server] Running on stdio.');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startMcpServer().catch(err => { console.error('[OTM MCP Server] Fatal:', err); process.exit(1); });
}
