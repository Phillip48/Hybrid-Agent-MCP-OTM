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
  {
    name: 'report_letter_writing',
    description: 'Letter Writing Stats — statistics on letter writing activity across territories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_address_export',
    description: 'Address List Export with Return Visits — full address list including RV notes.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Address Tools ──────────────────────────────────────────────────────────
  {
    name: 'search_addresses',
    description: 'Search for addresses in the OTM database by street, city, zip, or name. Returns matching address records.',
    inputSchema: {
      type: 'object',
      properties: {
        street:  { type: 'string', description: 'Street name or number to search for.' },
        city:    { type: 'string', description: 'City to filter by.' },
        zip:     { type: 'string', description: 'Zip code to filter by.' },
        name:    { type: 'string', description: 'Householder name to search for.' },
      },
    },
  },
  {
    name: 'find_duplicate_addresses',
    description: 'Runs the duplicate address checker to find addresses that appear more than once in the database.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Territory Admin Tools ──────────────────────────────────────────────────
  {
    name: 'list_territory_groups',
    description: 'Lists all territory groupings/categories configured in OTM.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_territory_types',
    description: 'Lists all territory types defined in OTM (e.g. Residential, Business, Letter Writing).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description: 'Lists all campaigns configured in OTM.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Admin Tools ────────────────────────────────────────────────────────────
  {
    name: 'list_announcements',
    description: 'Lists current announcements posted to OTM users.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_congregation_options',
    description: 'Returns congregation/group settings and preferences configured in OTM.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_user_preferences',
    description: 'Returns the current user\'s OTM preferences and settings.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Route territory ────────────────────────────────────────────────────────
  {
    name: 'route_territory',
    description: 'Routes a territory by sorting its addresses from closest to farthest from the congregation home base (1675 Jack Calhoun Dr, Kissimmee FL). Navigates to TerRoute.php, selects the territory, clicks Edit Route, geocodes each address, reorders them by distance, and saves.',
    inputSchema: {
      type: 'object',
      properties: {
        territory_number: { type: 'string', description: 'Territory number to route, e.g. "OR-15A".' },
      },
      required: ['territory_number'],
    },
  },

  // ── Address entry ──────────────────────────────────────────────────────────
  {
    name: 'add_address',
    description: 'Adds a new address to OTM. Checks for duplicates in AddrSearch.php first. If not found, fills AdminSingleAddr.php with the address details, sets language to Portuguese, clicks Get Lat/Long, then saves. Territory and address type are left as default (NA / Residential).',
    inputSchema: {
      type: 'object',
      properties: {
        street_number: { type: 'string', description: 'House/building number, e.g. "123".' },
        street_name:   { type: 'string', description: 'Street name, e.g. "Main St".' },
        unit:          { type: 'string', description: 'Apt/unit number (optional).' },
        city:          { type: 'string', description: 'City name. If not provided, the tool will attempt to look it up.' },
        state:         { type: 'string', description: 'State abbreviation. Defaults to "FL".' },
        zip:           { type: 'string', description: 'Zip code. If not provided, the tool will attempt to look it up.' },
        confirmed:     { type: 'boolean', description: 'Mark the address as confirmed. Default false.' },
      },
      required: ['street_number', 'street_name'],
    },
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
    // Territory checkout
    all:              '/GetStandard.php?code=A',
    available:        '/GetStandard.php?code=B',
    checkedOut:       '/MyTer.php?showallmyter=1&sort=1',
    myFolder:         '/MyTer.php?showallmyter=0',
    // Reports
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
    letterWriting:    '/LetterWritingStats.php',
    addressExport:    '/Backup.php?what=L',
    // Address tools
    addrSearch:       '/AddrSearch.php',
    addrEntry:        '/AdminSingleAddr.php',
    dupChecker:       '/DupChecker.php',
    // Territory admin
    terRoute:         '/TerRoute.php',
    terGroups:        '/TerGroupAdmin.php',
    terTypes:         '/TerTypeAdmin.php',
    campaigns:        '/CampaignAdmin.php',
    // Admin tools
    announcements:    '/AnnounceAdmin.php',
    congOptions:      '/GroupPref.php',
    userPrefs:        '/UserPref.php',
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
        // Territory has no CHECK OUT button — it is already checked out.
        // Look up who has it so we can return a useful error.
        console.log('[checkout] No checkout button — checking who has it');
        await session.navigate(PAGES.checkedOut);
        const holder = await session.evaluate((num) => {
          const re   = new RegExp(num.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
          const rows = [...document.querySelectorAll('table tbody tr')];
          const row  = rows.find(r => re.test(r.textContent));
          return row ? row.innerText.replace(/\s+/g, ' ').trim() : null;
        }, territory_number);

        return {
          error: true,
          already_checked_out: true,
          message: holder
            ? `Territory ${territory_number} is already checked out. Details: ${holder}`
            : `Territory ${territory_number} is not available for checkout (no Check Out button found in the panel).`,
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
      // ── Step 1: Navigate to checked-out admin view ────────────────────────
      console.log(`[return] Navigating to checked-out admin view`);
      await session.navigate(PAGES.checkedOut);

      // ── Step 2: Enable Admin Options so check-in buttons appear ──────────
      // The check-in image button (PreCheckIn.php link) only shows when
      // admin options are turned on. Click the toggle if it exists.
      const adminToggled = await session.evaluate(() => {
        const els = [...document.querySelectorAll('a, button, input[type="button"]')];
        const toggle = els.find(el =>
          /admin.?option|show.?admin|turn.?on.?admin/i.test(el.textContent + el.value + el.title)
        );
        if (toggle) { toggle.click(); return true; }
        return false;
      });
      if (adminToggled) {
        console.log(`[return] Admin options toggled — waiting for page to update`);
        await session.page.waitForTimeout(1500);
      }

      // ── Step 3: Find the PreCheckIn.php link for this territory ──────────
      // The link looks like: <a href="PreCheckIn.php?MyTerID=XXXX&MyTerDescr=OR-15A-...">
      // Territory number appears in MyTerDescr URL param.
      const checkInHref = await session.evaluate((num) => {
        const re    = new RegExp(num.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
        const links = [...document.querySelectorAll('a[href*="PreCheckIn.php"]')];
        const link  = links.find(a => re.test(decodeURIComponent(a.href)));
        return link ? link.href : null;
      }, territory_number);

      if (!checkInHref) {
        // If no PreCheckIn link found, check whether territory is even listed.
        const listed = await session.evaluate((num) => {
          const re = new RegExp(num.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
          return re.test(document.body.innerText);
        }, territory_number);

        return {
          error: false,
          message: listed
            ? `Found territory "${territory_number}" on the page but no check-in button. Admin options may not be enabled, or the territory is not checked out to your account.`
            : `Territory "${territory_number}" was not found in the checked-out list. It may already be returned.`,
        };
      }

      console.log(`[return] Found check-in link: ${checkInHref}`);

      // ── Step 4: Navigate to the check-in page ────────────────────────────
      await session.page.goto(checkInHref, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // ── Step 5: Fill date if provided (before answering the routing question) ──
      if (date) {
        const fmt = formatDate(date);
        await session.evaluate((dt) => {
          const inp = document.querySelector('input[type="date"], input[name*="date" i]');
          if (inp) { inp.value = dt; inp.dispatchEvent(new Event('change', { bubbles: true })); }
        }, fmt);
        console.log(`[return] Date set to ${fmt}`);
      }

      // ── Step 6: Click "No" to the routing question ────────────────────────
      // OTM asks "Do you want to route this territory?" — always click No.
      const noClicked = await session.evaluate(() => {
        const btn = document.querySelector('input[name="No"], input[value="No"]');
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (!noClicked) {
        // No routing question found — try a generic submit.
        await session.evaluate(() => {
          const btn = document.querySelector('input[type="submit"], button[type="submit"]');
          if (btn) btn.click();
        });
      }

      console.log(`[return] Routing question answered (No) — waiting for confirmation`);
      await session.page.waitForLoadState('networkidle').catch(() => {});

      const resultText = await session.evaluate(() => document.body.innerText);
      return { success: true, result: resultText.slice(0, 1000) };
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

  async function handleReportLetterWriting() {
    return withBrowser(() => scrapeReportPage(PAGES.letterWriting));
  }

  async function handleReportAddressExport() {
    return withBrowser(() => scrapeReportPage(PAGES.addressExport));
  }

  // ── Address tool handlers ───────────────────────────────────────────────────

  async function handleSearchAddresses({ street, city, zip, name } = {}) {
    return withBrowser(async () => {
      await session.navigate(PAGES.addrSearch);

      // Fill whichever search fields were provided.
      const fieldMap = [
        ['input[name*="street" i], input[placeholder*="street" i]', street],
        ['input[name*="city"   i], input[placeholder*="city"   i]', city],
        ['input[name*="zip"    i], input[placeholder*="zip"    i]', zip],
        ['input[name*="name"   i], input[placeholder*="name"   i]', name],
      ];
      for (const [sel, val] of fieldMap) {
        if (!val) continue;
        try { await session.fill(sel, val); } catch {}
      }

      // Submit the search form.
      try {
        await session.evaluate(() => {
          const btn = document.querySelector('input[type="submit"], button[type="submit"]');
          if (btn) btn.click();
        });
        await session.page.waitForLoadState('domcontentloaded');
      } catch {}

      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, addresses: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 4000) };
    });
  }

  async function handleFindDuplicateAddresses() {
    return withBrowser(async () => {
      await session.navigate(PAGES.dupChecker);
      // The duplicate checker may need a button click to run the check.
      try {
        await session.evaluate(() => {
          const btn = document.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
          if (btn) btn.click();
        });
        await session.page.waitForLoadState('networkidle').catch(() => {});
      } catch {}
      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, duplicates: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 5000) };
    });
  }

  // ── Territory admin handlers ────────────────────────────────────────────────

  async function handleListTerritoryGroups() {
    return withBrowser(async () => {
      await session.navigate(PAGES.terGroups);
      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, groups: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 4000) };
    });
  }

  async function handleListTerritoryTypes() {
    return withBrowser(async () => {
      await session.navigate(PAGES.terTypes);
      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, types: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 4000) };
    });
  }

  async function handleListCampaigns() {
    return withBrowser(async () => {
      await session.navigate(PAGES.campaigns);
      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, campaigns: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 4000) };
    });
  }

  // ── Admin tool handlers ─────────────────────────────────────────────────────

  async function handleListAnnouncements() {
    return withBrowser(async () => {
      await session.navigate(PAGES.announcements);
      const table = await session.scrapeTable('table');
      const text  = await session.evaluate(() => document.body.innerText);
      return table?.rows?.length
        ? { headers: table.headers, announcements: table.rows, count: table.rows.length }
        : { raw: text.slice(0, 4000) };
    });
  }

  async function handleGetCongregationOptions() {
    return withBrowser(async () => {
      await session.navigate(PAGES.congOptions);
      const text = await session.evaluate(() => document.body.innerText);
      // Also grab all form input values as key-value pairs.
      const settings = await session.evaluate(() => {
        return [...document.querySelectorAll('input, select, textarea')]
          .filter(el => el.name && el.type !== 'submit' && el.type !== 'button')
          .map(el => ({
            name:  el.name,
            type:  el.type || el.tagName.toLowerCase(),
            value: el.type === 'checkbox' ? el.checked : el.value,
            label: el.closest('tr, div, p')?.querySelector('label, th, td')?.textContent?.trim() || el.name,
          }));
      });
      return { settings, text: text.slice(0, 4000) };
    });
  }

  // ── Route territory ──────────────────────────────────────────────────────────

  // Home base coordinates — 1675 Jack Calhoun Dr, Kissimmee FL 34741
  const HOME_LAT = 28.307192;
  const HOME_LON = -81.422605;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  async function nominatimGeocode(address) {
    try {
      const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'OTM-Bot/1.0 (territory routing)' } });
      const data = await resp.json();
      if (data.length > 0) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    } catch {}
    return null;
  }

  async function handleRouteTerritory({ territory_number }) {
    return withBrowser(async () => {
      console.log(`[route] Starting route for territory ${territory_number}`);

      // ── Step 1: Navigate to TerRoute.php ─────────────────────────────
      await session.navigate(PAGES.terRoute);

      // Find the option value matching the territory number.
      const territoryValue = await session.evaluate((num) => {
        const sel = document.getElementById('TerID');
        if (!sel) return null;
        const re  = new RegExp(num.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
        const opt = [...sel.options].find(o => re.test(o.text));
        return opt ? opt.value : null;
      }, territory_number);

      if (!territoryValue) {
        return { error: true, message: `Territory "${territory_number}" not found in the routing list. Use list_territories to confirm the exact number.` };
      }

      // ── Step 2: Select territory using Playwright's native selectOption ──
      // <select id="TerID" name="TerID">
      console.log(`[route] Selecting territory ${territory_number} (value: ${territoryValue})`);
      await session.page.selectOption('#TerID', territoryValue);

      // ── Step 3: Click "Edit Route" — <input type="submit" name="Route" value="Edit Route">
      console.log(`[route] Clicking Edit Route button`);
      await session.page.click('input[name="Route"]');
      await session.page.waitForLoadState('domcontentloaded');
      console.log(`[route] Route editing page loaded`);

      // ── Step 4: Read addresses from #dragbox and copypaste textarea ───
      // Each <li id="ADDRESS_ID">N: street, city*</li>
      // Textarea has clean addresses in the same order (better for geocoding).
      const { liItems, copypasteLines } = await session.evaluate(() => {
        const liItems = [...document.querySelectorAll('#dragbox li')].map(li => ({
          id:   li.id,
          text: li.textContent.trim(),
        }));
        const textarea      = document.getElementById('copypaste');
        const copypasteLines = textarea
          ? textarea.value.split('\n').map(l => l.trim()).filter(Boolean)
          : [];
        return { liItems, copypasteLines };
      });

      if (!liItems.length) {
        return { error: true, message: 'No addresses found in the routing list. The territory may have no addresses.' };
      }

      console.log(`[route] ${liItems.length} addresses to geocode and sort`);

      // Prefer the copypaste textarea text (cleaner); fallback to stripping "N: " from li text.
      const cleanAddresses = liItems.map((li, i) => {
        if (copypasteLines[i]) return copypasteLines[i];
        return li.text.replace(/^\d+:\s*/, '').replace(/[\s,]*\*?\s*$/, '').trim();
      });

      // ── Step 5: Geocode each address server-side (700ms between requests) ──
      const sleep    = (ms) => new Promise(r => setTimeout(r, ms));
      const geocoded = [];

      for (let i = 0; i < liItems.length; i++) {
        const addr  = cleanAddresses[i];
        const query = addr.toLowerCase().includes('fl') ? addr : `${addr}, FL`;
        console.log(`[route] Geocoding ${i + 1}/${liItems.length}: ${addr}`);
        const coords = await nominatimGeocode(query);
        const dist   = coords ? haversineKm(HOME_LAT, HOME_LON, coords.lat, coords.lon) : 9999;
        geocoded.push({ id: liItems[i].id, addr, dist, coords });
        if (i < liItems.length - 1) await sleep(700);
      }

      // ── Step 6: Sort closest → farthest from home base ───────────────
      geocoded.sort((a, b) => a.dist - b.dist);
      const sortedIds = geocoded.map(g => g.id);
      console.log(`[route] Closest: ${geocoded[0].addr} (${geocoded[0].dist.toFixed(1)}km)`);
      console.log(`[route] Farthest: ${geocoded.at(-1).addr} (${geocoded.at(-1).dist.toFixed(1)}km)`);

      // ── Step 7: Reorder #dragbox DOM in sorted order ──────────────────
      // appendChild() moves each <li> to the end — result is the sorted sequence.
      await session.evaluate((ids) => {
        const parent = document.getElementById('dragbox');
        for (const id of ids) {
          const li = document.getElementById(id);
          if (li) parent.appendChild(li);
        }
      }, sortedIds);

      // ── Step 8: Populate RouteOrder hidden field directly ─────────────
      // RouteOrder = comma-separated address IDs in display order.
      // Setting it directly is more reliable than calling dosave() via evaluate.
      // <input type="hidden" name="RouteOrder" id="RouteOrder" value="">
      await session.evaluate((ids) => {
        document.getElementById('RouteOrder').value = ids.join(',');
      }, sortedIds);
      console.log(`[route] RouteOrder set to ${sortedIds.length} IDs`);

      // ── Step 9: Click "Save Route" — <input type="submit" name="Save" value="Save Route">
      // Using Playwright's native click so the form submits properly.
      console.log(`[route] Clicking Save Route button`);
      await session.page.click('input[name="Save"]');
      await session.page.waitForLoadState('networkidle').catch(() => {});

      const resultText = await session.evaluate(() => document.body.innerText);

      return {
        success:          true,
        territory:        territory_number,
        addresses_routed: liItems.length,
        home_base:        '1675 Jack Calhoun Dr, Kissimmee FL 34741',
        route:            geocoded.map((g, i) => `${i + 1}. ${g.addr} — ${g.dist.toFixed(1)}km`),
        page_result:      resultText.slice(0, 300),
      };
    });
  }

  async function handleAddAddress({ street_number, street_name, unit, city, state = 'FL', zip, confirmed = false } = {}) {
    return withBrowser(async () => {
      const fullStreet = `${street_number} ${street_name}${unit ? ` ${unit}` : ''}`.trim();
      console.log(`[add_address] Checking if "${fullStreet}, ${city ?? 'Central FL'}" already exists`);

      // ── Step 0: Look up city/zip if not provided ───────────────────────────
      // Address is always in Central FL — use OTM's geocoding page or search.
      if (!city || !zip) {
        console.log(`[add_address] Partial address — looking up city/zip for "${fullStreet}, FL"`);
        try {
          await session.page.goto(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${fullStreet}, Florida, USA`)}&format=json&limit=1&addressdetails=1`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          const geoData = await session.evaluate(() => {
            try { return JSON.parse(document.body.innerText); } catch { return null; }
          });
          if (geoData?.length > 0) {
            const addr = geoData[0].address;
            city = city || addr.city || addr.town || addr.village || addr.hamlet || addr.county || city;
            zip  = zip  || addr.postcode || zip;
            console.log(`[add_address] Resolved city="${city}" zip="${zip}"`);
          }
        } catch (e) {
          console.warn(`[add_address] Geocode lookup failed: ${e.message}`);
        }
        // Navigate back to OTM after geocoding lookup.
        await session.navigate(PAGES.addrSearch);
      }

      // ── Step 1: Search for the address in AddrSearch.php ─────────────────
      await session.navigate(PAGES.addrSearch);

      // Try to fill whatever search fields exist on the page.
      const searchFields = [
        ['input[name*="housenum" i], input[name*="streetnum" i], input[name*="addr" i]', street_number],
        ['input[name*="streetname" i], input[name*="street" i]', street_name],
        ['input[name*="city" i]', city ?? ''],
        ['input[name*="zip" i]', zip ?? ''],
      ];
      for (const [sel, val] of searchFields) {
        if (!val) continue;
        try { await session.fill(sel, val); } catch {}
      }

      await session.evaluate(() => {
        const btn = document.querySelector('input[type="submit"], button[type="submit"]');
        if (btn) btn.click();
      });
      await session.page.waitForLoadState('domcontentloaded');

      const searchResults = await session.evaluate(() =>
        [...document.querySelectorAll('table tbody tr')]
          .map(r => r.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean)
      );

      if (searchResults.length > 0) {
        console.log(`[add_address] Already exists — ${searchResults.length} record(s)`);
        return {
          already_exists: true,
          message: `Address already exists in OTM (${searchResults.length} matching record(s) found). Not added.`,
          existing_records: searchResults.slice(0, 10),
        };
      }

      console.log(`[add_address] Not found — opening entry form`);

      // ── Step 2: Navigate to entry form (AdminSingleAddr.php) ─────────────
      await session.navigate(PAGES.addrEntry);

      // Read the form HTML so we can see the actual field names.
      const formFields = await session.evaluate(() =>
        [...document.querySelectorAll('input, select, textarea')]
          .map(el => ({ tag: el.tagName, name: el.name, id: el.id, type: el.type, placeholder: el.placeholder }))
          .filter(el => el.name)
      );
      console.log(`[add_address] Form fields found:`, JSON.stringify(formFields.map(f => f.name)));

      // ── Step 3: Fill address fields ───────────────────────────────────────
      // Helper: fill a field by trying multiple selector candidates.
      const fillField = async (candidates, value) => {
        if (!value) return;
        for (const sel of candidates) {
          try {
            const tag = await session.evaluate(s => document.querySelector(s)?.tagName?.toLowerCase(), sel);
            if (!tag) continue;
            if (tag === 'select') {
              await session.page.selectOption(sel, { label: value }).catch(async () => {
                // Fallback: match by value text
                await session.evaluate((s, v) => {
                  const el  = document.querySelector(s);
                  if (!el) return;
                  const opt = [...el.options].find(o => o.text.toLowerCase().includes(v.toLowerCase()));
                  if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }, sel, value);
              });
            } else {
              await session.fill(sel, value);
            }
            return;
          } catch {}
        }
      };

      // Street number
      await fillField(['input[name="HouseNum"]', 'input[name="housenum"]', 'input[name="StreetNum"]', 'input[name="Addr1"]', 'input[id*="house" i]', 'input[id*="num" i]'], street_number);
      // Street name
      await fillField(['input[name="StreetName"]', 'input[name="streetname"]', 'input[name="Street"]', 'input[id*="street" i]'], street_name);
      // Unit/apt
      if (unit) await fillField(['input[name="Apt"]', 'input[name="apt"]', 'input[name="Unit"]', 'input[name="unit"]', 'input[id*="apt" i]', 'input[id*="unit" i]'], unit);
      // City
      await fillField(['input[name="City"]', 'input[name="city"]', 'input[id*="city" i]'], city ?? '');
      // State (always FL)
      await fillField(['input[name="State"]', 'input[name="state"]', 'select[name="State"]', 'select[name="state"]', 'input[id*="state" i]'], state);
      // Zip
      await fillField(['input[name="Zip"]', 'input[name="zip"]', 'input[name="ZipCode"]', 'input[id*="zip" i]'], zip ?? '');

      // ── Step 4: Set language to Portuguese ────────────────────────────────
      await session.evaluate(() => {
        const langSels = ['select[name="Lang"]', 'select[name="lang"]', 'select[name="Language"]', 'select[name*="lang" i]'];
        for (const s of langSels) {
          const el = document.querySelector(s);
          if (!el) continue;
          const opt = [...el.options].find(o => /portug|por\b/i.test(o.text + o.value));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return; }
        }
      });
      console.log(`[add_address] Language set to Portuguese`);

      // ── Step 5: Mark confirmed if requested ───────────────────────────────
      if (confirmed) {
        await session.evaluate(() => {
          const cb = document.querySelector('input[type="checkbox"][name*="confirm" i], input[type="checkbox"][id*="confirm" i]');
          if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        console.log(`[add_address] Marked as confirmed`);
      }

      // ── Step 6: Click Get Lat/Long ────────────────────────────────────────
      console.log(`[add_address] Clicking Get Lat/Long`);
      const latLongClicked = await session.evaluate(() => {
        const btn = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
          .find(el => /lat.?long|geocod|get.?coord|get.?loc/i.test(el.textContent + el.value + el.title));
        if (btn) { btn.click(); return btn.textContent?.trim() || btn.value || true; }
        return false;
      });

      if (latLongClicked) {
        // Wait for lat/long fields to populate (geocoding API call).
        await session.page.waitForFunction(() => {
          const lat = document.querySelector('input[name="Lat"], input[name="lat"], input[id*="lat" i]');
          return lat && lat.value && lat.value !== '0' && lat.value !== '';
        }, { timeout: 10000 }).catch(() => {
          console.warn(`[add_address] Lat/long did not populate within 10s — saving anyway`);
        });
        console.log(`[add_address] Lat/Long populated`);
      } else {
        console.warn(`[add_address] Get Lat/Long button not found — saving without coordinates`);
      }

      // ── Step 7: Save ──────────────────────────────────────────────────────
      console.log(`[add_address] Saving`);
      await session.evaluate(() => {
        // Click Save — prefer a button explicitly labelled Save, not Get Lat/Long.
        const btn = [...document.querySelectorAll('input[type="submit"], button[type="submit"]')]
          .find(el => !/lat|geo|coord/i.test(el.value + el.textContent));
        if (btn) btn.click();
      });
      await session.page.waitForLoadState('networkidle').catch(() => {});

      const resultText = await session.evaluate(() => document.body.innerText);
      const success    = /success|saved|added|record/i.test(resultText);

      return {
        success,
        address: [fullStreet, city, state, zip].filter(Boolean).join(', '),
        confirmed,
        language: 'Portuguese',
        latLongClicked: !!latLongClicked,
        result: resultText.slice(0, 500),
      };
    });
  }

  async function handleGetUserPreferences() {
    return withBrowser(async () => {
      await session.navigate(PAGES.userPrefs);
      const text = await session.evaluate(() => document.body.innerText);
      const settings = await session.evaluate(() => {
        return [...document.querySelectorAll('input, select, textarea')]
          .filter(el => el.name && el.type !== 'submit' && el.type !== 'button')
          .map(el => ({
            name:  el.name,
            type:  el.type || el.tagName.toLowerCase(),
            value: el.type === 'checkbox' ? el.checked : el.value,
            label: el.closest('tr, div, p')?.querySelector('label, th, td')?.textContent?.trim() || el.name,
          }));
      });
      return { settings, text: text.slice(0, 4000) };
    });
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
      case 'report_worked_log':           return handleReportWorkedLog();
      case 'report_territory_list':       return handleReportTerritoryList();
      case 'report_checkinout':           return handleReportCheckinOut(args);
      case 'report_group_stats':          return handleReportGroupStats();
      case 'report_stats_by_grouping':    return handleReportStatsByGrouping();
      case 'report_address_demographics': return handleReportAddressDemographics();
      case 'report_territory_export':     return handleReportTerritoryExport();
      case 'report_letter_writing':       return handleReportLetterWriting();
      case 'report_address_export':       return handleReportAddressExport();
      // Address tools
      case 'search_addresses':            return handleSearchAddresses(args);
      case 'find_duplicate_addresses':    return handleFindDuplicateAddresses();
      // Territory admin
      case 'list_territory_groups':       return handleListTerritoryGroups();
      case 'list_territory_types':        return handleListTerritoryTypes();
      case 'list_campaigns':              return handleListCampaigns();
      // Admin tools
      case 'list_announcements':          return handleListAnnouncements();
      case 'get_congregation_options':    return handleGetCongregationOptions();
      case 'get_user_preferences':        return handleGetUserPreferences();
      case 'route_territory':             return handleRouteTerritory(args);
      case 'add_address':                 return handleAddAddress(args);
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
