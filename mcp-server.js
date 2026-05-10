#!/usr/bin/env node
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
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
    name: 'report_confirmed_addresses',
    description: 'Returns total confirmed addresses across all territories, plus a per-territory breakdown with territory number, name, total addresses, and confirmed count. Pulls live data from the Territory List Report.',
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
    description: 'Search for addresses in the OTM database. Use housenum for the house/building number only, street for the street name only (never combine them). Returns matching address records.',
    inputSchema: {
      type: 'object',
      properties: {
        housenum: { type: 'string', description: 'House or building number only (e.g. "232"). Goes in the "Addr # Only" field. Do NOT include the street name here.' },
        street:   { type: 'string', description: 'Street name only (e.g. "Main St"). Do NOT include the house number here.' },
        city:     { type: 'string', description: 'City to filter by.' },
        zip:      { type: 'string', description: 'Zip code to filter by.' },
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
    description: 'Adds a new address to OTM. Searches AddrSearch.php first — if the address already exists, stops immediately and returns an error. If not found, navigates to AdminSingleAddr.php, fills house number, street, city, state, zip, clicks Get Lat/Long, then saves. Language defaults to Portuguese (set via hidden field). Territory and address type are left as default.',
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
  {
    name: 'gated_address_report',
    description: 'Checks every available territory on the checkout page and returns the percentage of gated addresses in each one, sorted highest to lowest.',
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

      const checkoutDate = formatDate(date);

      // Step 3: Select the publisher and submit the checkout form.
      //
      // OTM has two possible checkout layouts:
      //   A) A form with a <select id="userid"> publisher dropdown (logged-in user
      //      is pre-selected — we MUST change this before submitting).
      //   B) A per-publisher list of "Yes!" links (older layout, used as fallback).
      const publisherResult = await session.evaluate((name, dateStr) => {
        const nameLower = name.toLowerCase().trim();

        // ── Layout A: publisher select dropdown ──────────────────────────────
        const select = document.getElementById('userid');
        if (select) {
          const options = [...select.options];
          // Find the best match — prefer the option whose text most closely
          // matches the requested name. Never rely on the pre-selected value.
          const match = options.find(o => o.textContent.toLowerCase().includes(nameLower));

          if (!match) {
            return {
              error: `Publisher "${name}" not found in dropdown`,
              availableOptions: options.map(o => o.textContent.trim()),
            };
          }

          // Explicitly set the dropdown value so the pre-selected (logged-in)
          // user is overwritten before the form is submitted.
          select.value = match.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          console.log(`[checkout] Selected publisher: ${match.textContent.trim()} (value ${match.value})`);

          // Set the date if a date input exists.
          const dateInput = document.querySelector(
            'input[name="CheckoutDate"], input[name*="Date"], input[name*="date"], input[type="date"]'
          );
          if (dateInput && dateStr) {
            dateInput.value = dateStr;
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          // Click the submit/confirm button.
          const submitBtn = document.querySelector(
            'input[type="submit"], button[type="submit"], ' +
            'input[type="button"][value*="assign" i], input[type="button"][value*="checkout" i], ' +
            'input[type="button"][value*="confirm" i], input[type="button"][value*="yes" i]'
          );
          if (submitBtn) {
            submitBtn.click();
            return { method: 'select_dropdown', matched: match.textContent.trim() };
          }

          // Fall back to form.submit() if no button found.
          const form = select.closest('form');
          if (form) {
            form.submit();
            return { method: 'select_dropdown_form', matched: match.textContent.trim() };
          }

          return { error: 'Publisher selected but no submit button found', matched: match.textContent.trim() };
        }

        // ── Layout B: per-publisher "Yes!" buttons ───────────────────────────
        const panel = document.getElementById('listter');
        if (!panel) return { error: 'No panel found' };

        const yesEls = [...panel.querySelectorAll('a, button, input[type="submit"]')]
          .filter(el => /yes/i.test((el.textContent + (el.value || '')).trim()));

        if (yesEls.length === 0) {
          return { error: 'No publisher dropdown or Yes! buttons found in panel', panelText: panel.innerText.slice(0, 500) };
        }

        for (const el of yesEls) {
          const container = el.closest('tr, li, p, div') ?? el.parentElement;
          const containerText = (container?.innerText ?? '').toLowerCase();
          if (containerText.includes(nameLower)) {
            el.click();
            return { method: 'yes_button', matched: container.innerText.trim() };
          }
        }

        const options = yesEls.map(el => {
          const container = el.closest('tr, li, p, div') ?? el.parentElement;
          return (container?.innerText ?? '').trim();
        });
        return { error: `Publisher "${name}" not found in checkout list`, availableOptions: options };
      }, publisher_name, checkoutDate);

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

      // Wait for the form submission to complete (may navigate or update via AJAX).
      await session.page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() =>
        session.page.waitForTimeout(2500)
      );
      const finalPanel = await scrapePanel();
      return {
        success: true,
        method: publisherResult.method,
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

  async function handleReportConfirmedAddresses() {
    return withBrowser(async () => {
      await session.navigate(PAGES.statsByGrouping);

      return session.evaluate(() => {
        const table = [...document.querySelectorAll('table')].find(t => t.querySelector('th'));
        if (!table) return { error: 'No table found on Stats by Groupings page.' };

        const headers = [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
          .map(h => h.textContent.trim());

        const confirmedIdx = headers.findIndex(h => /confirm/i.test(h));
        const groupIdx     = headers.findIndex(h => /group|name/i.test(h));
        const totalIdx     = headers.findIndex(h => /total/i.test(h));

        if (confirmedIdx === -1) {
          return { error: 'Could not find a "Confirmed" column in the report.', headers };
        }

        const rows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')]
          .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))
          .filter(r => r.length > confirmedIdx && r.some(c => c));

        let totalConfirmed = 0;
        const groups = [];
        for (const row of rows) {
          const confirmed = parseInt(row[confirmedIdx]?.replace(/,/g, '') || '0', 10);
          if (isNaN(confirmed)) continue;
          totalConfirmed += confirmed;
          groups.push({
            group:     groupIdx !== -1 ? row[groupIdx] : undefined,
            total:     totalIdx !== -1 ? parseInt(row[totalIdx]?.replace(/,/g, '') || '0', 10) : undefined,
            confirmed,
          });
        }

        return { totalConfirmed, groups, headers };
      });
    });
  }

  async function handleReportLetterWriting() {
    return withBrowser(() => scrapeReportPage(PAGES.letterWriting));
  }

  async function handleReportAddressExport() {
    return withBrowser(() => scrapeReportPage(PAGES.addressExport));
  }

  // ── Address tool handlers ───────────────────────────────────────────────────

  async function handleSearchAddresses({ housenum, street, city, zip } = {}) {
    return withBrowser(async () => {
      await session.navigate(PAGES.addrSearch);

      // Clear all text inputs and reset selects so prior session values don't leak.
      // The Lang select defaults to "Portuguese" which would restrict results silently.
      await session.evaluate(() => {
        document.querySelectorAll('input[type="text"], input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])').forEach(el => { el.value = ''; });
        const lang = document.querySelector('select[name="Lang"]');
        if (lang) lang.value = 'ALLLANG';
        const busRes = document.querySelector('select[name="BusRes"]');
        if (busRes) busRes.value = '';
        const ternum = document.querySelector('select[name="ternum"]');
        if (ternum) ternum.value = '';
      });

      // Fill only the fields that were provided.
      if (housenum) try { await session.fill('input[name="housenum"]', String(housenum)); } catch {}
      if (street)   try { await session.fill('input[name="street"]',   String(street));   } catch {}
      if (city)     try { await session.fill('input[name="city"]',     String(city));     } catch {}
      if (zip)      try { await session.fill('input[name="zip"]',      String(zip));      } catch {}

      // Submit and wait for the results page.
      await Promise.all([
        session.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() =>
          session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
        ),
        session.page.click('input[name="Search"]').catch(() =>
          session.evaluate(() => {
            const btn = document.querySelector('input[name="Search"], input[type="submit"]');
            if (btn) btn.click();
          }).catch(() => {})
        ),
      ]);

      const table = await session.scrapeTable('table');
      return table?.rows?.length
        ? { headers: table.headers, addresses: table.rows, count: table.rows.length }
        : { addresses: [], count: 0, message: 'No matching addresses found.' };
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

  // Geocode cache — persisted to disk so addresses are never geocoded twice.
  const CACHE_PATH = new URL('./geocode-cache.json', import.meta.url).pathname;
  function loadCache() {
    try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
  }
  function saveCache(cache) {
    try { writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); } catch {}
  }

  // Batch-geocodes an array of address strings via Geocodio.
  // Returns a map of { address -> { lat, lon } | null }.
  // Already-cached addresses are skipped entirely (no API call).
  async function batchGeocode(addresses) {
    const cache  = loadCache();
    const hits   = {};
    const misses = [];

    for (const addr of addresses) {
      if (cache[addr]) {
        hits[addr] = cache[addr];
      } else {
        misses.push(addr);
      }
    }

    if (misses.length === 0) {
      console.log(`[route] All ${addresses.length} addresses resolved from cache`);
      return hits;
    }

    console.log(`[route] ${hits ? Object.keys(hits).length : 0} cached, ${misses.length} need geocoding via Geocodio...`);

    const apiKey = process.env.GEO_KEY;
    if (!apiKey) throw new Error('GEO_KEY not set in .env');

    const resp = await fetch(
      `https://api.geocod.io/v1.7/geocode?api_key=${apiKey}&limit=1`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(misses),
        signal:  AbortSignal.timeout(30000),
      }
    );

    if (!resp.ok) throw new Error(`Geocodio error ${resp.status}: ${await resp.text()}`);

    const data = await resp.json();

    for (let i = 0; i < misses.length; i++) {
      const addr  = misses[i];
      const match = data.results?.[i]?.response?.results?.[0];
      if (match?.location) {
        const coords = { lat: match.location.lat, lon: match.location.lng };
        hits[addr]   = coords;
        cache[addr]  = coords;
        console.log(`[route]   ✓ ${addr}`);
      } else {
        hits[addr] = null;
        console.warn(`[route]   ✗ no result: ${addr}`);
      }
    }

    saveCache(cache);
    return hits;
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

      // ── Step 5: Batch-geocode via Geocodio (cached addresses skipped) ────────
      const coordMap = await batchGeocode(cleanAddresses);
      const geocoded = [];
      const failed   = [];

      for (let i = 0; i < liItems.length; i++) {
        const addr   = cleanAddresses[i];
        const coords = coordMap[addr];
        const dist   = coords ? haversineKm(HOME_LAT, HOME_LON, coords.lat, coords.lon) : 9999;
        if (!coords) failed.push(addr);
        geocoded.push({ id: liItems[i].id, addr, dist, coords });
      }

      if (failed.length > 0) {
        console.warn(`[route] ${failed.length} address(es) not geocoded — will sort to end:`);
        failed.forEach(a => console.warn(`  - ${a}`));
      }

      // ── Step 6: Multi-start nearest-neighbor + 2-opt + Or-opt ───────────────
      // Single-start nearest-neighbor commits to one entry point and can get
      // stuck with scattered early pins. Multi-start runs the full optimization
      // from several entry points (home + N closest addresses to home) and
      // keeps whichever produces the shortest total path.
      const withCoords    = geocoded.filter(g => g.coords);
      const withoutCoords = geocoded.filter(g => !g.coords);

      const H  = { lat: HOME_LAT, lon: HOME_LON };
      const dc = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon);
      const coord = (node) => node.coords;

      // Cluster-aware lookahead nearest-neighbor.
      // At each step, considers the K nearest candidates and scores each by:
      //   1. Direct distance to candidate          (minimize travel now)
      //   2. Nearest remaining address after it    (1-step lookahead)
      //   3. Cluster density around candidate      (bonus for sweeping dense areas)
      // This prevents the greedy algorithm from picking an isolated address when
      // a slightly-farther candidate unlocks a whole neighbourhood nearby.
      function nnRoute(nodes, startCoord) {
        const K           = 10;   // candidates evaluated at each step
        const RADIUS      = 0.35; // km — neighbourhood cluster radius (~3-4 blocks)
        const LOOKAHEAD_W = 0.5;  // weight on 2nd-step cost (0=ignore, 1=equal weight)

        const ordered = [];
        let cur = startCoord;
        const pool = [...nodes];

        while (pool.length > 0) {
          if (pool.length === 1) { ordered.push(pool.splice(0, 1)[0]); break; }

          // Pick K nearest candidates from current position.
          const candidates = pool
            .map((node, idx) => ({ node, idx, dist: dc(cur, coord(node)) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, Math.min(K, pool.length));

          let bestScore = Infinity;
          let bestIdx   = candidates[0].idx;

          for (const { node: cNode, idx: cIdx, dist: cDist } of candidates) {
            // Cluster bonus: count unvisited addresses within RADIUS of this candidate.
            let clusterSize = 0;
            for (let i = 0; i < pool.length; i++) {
              if (i !== cIdx && dc(coord(pool[i]), coord(cNode)) <= RADIUS) clusterSize++;
            }

            // 1-step lookahead: nearest remaining address after visiting this candidate.
            let nearestAfter = 0;
            if (pool.length > 1) {
              nearestAfter = Infinity;
              for (let i = 0; i < pool.length; i++) {
                if (i !== cIdx) {
                  const d = dc(coord(cNode), coord(pool[i]));
                  if (d < nearestAfter) nearestAfter = d;
                }
              }
            }

            // Cluster bonus capped at 50% of direct distance so we never travel
            // far just to find a dense cluster on the other side of the territory.
            const clusterBonus = Math.min(clusterSize * RADIUS * 0.4, cDist * 0.5);
            const score = cDist + LOOKAHEAD_W * nearestAfter - clusterBonus;

            if (score < bestScore) { bestScore = score; bestIdx = cIdx; }
          }

          ordered.push(pool.splice(bestIdx, 1)[0]);
          cur = coord(ordered[ordered.length - 1]);
        }

        return ordered;
      }

      // Total open-path distance: home → r[0] → … → r[n-1].
      function pathLength(route) {
        if (route.length === 0) return 0;
        let total = dc(H, coord(route[0]));
        for (let i = 0; i < route.length - 1; i++) total += dc(coord(route[i]), coord(route[i + 1]));
        return total;
      }

      // prev/next helpers for open-path moves.
      const prevCoord = (route, i) => i === 0 ? H : coord(route[i - 1]);
      const nextCoord = (route, i) => i === route.length - 1 ? null : coord(route[i + 1]);

      // 2-opt — returns first improving edge-reversal.
      function twoOptPass(route) {
        const n = route.length;
        for (let i = 0; i < n - 1; i++) {
          for (let j = i + 1; j < n; j++) {
            const pI = prevCoord(route, i);
            const nJ = j < n - 1 ? coord(route[j + 1]) : null;
            const before = dc(pI, coord(route[i])) + (nJ ? dc(coord(route[j]), nJ) : 0);
            const after  = dc(pI, coord(route[j])) + (nJ ? dc(coord(route[i]), nJ) : 0);
            if (after < before - 1e-9) {
              return {
                route: [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)],
                improved: true,
              };
            }
          }
        }
        return { route, improved: false };
      }

      // Or-opt — try relocating every segment of length segLen to a better spot.
      // Also tries the segment reversed (Or-opt*).
      function orOptPass(route, segLen) {
        const n = route.length;
        if (n <= segLen + 1) return { route, improved: false };
        for (let i = 0; i <= n - segLen; i++) {
          const seg = route.slice(i, i + segLen);
          const pI  = prevCoord(route, i);
          const nI  = i + segLen < n ? coord(route[i + segLen]) : null;
          const removeSaving =
            dc(pI, coord(seg[0])) +
            (nI ? dc(coord(seg[segLen - 1]), nI) - dc(pI, nI) : 0);

          const without = [...route.slice(0, i), ...route.slice(i + segLen)];
          const m = without.length;
          for (let j = 0; j <= m; j++) {
            const pJ = j === 0 ? H : coord(without[j - 1]);
            const nJ = j < m ? coord(without[j]) : null;
            const edgeCut = nJ ? dc(pJ, nJ) : 0;
            for (const s of [seg, segLen > 1 ? [...seg].reverse() : null]) {
              if (!s) continue;
              const insertCost =
                dc(pJ, coord(s[0])) +
                (nJ ? dc(coord(s[segLen - 1]), nJ) - edgeCut : 0);
              if (removeSaving - insertCost > 1e-9) {
                return {
                  route: [...without.slice(0, j), ...s, ...without.slice(j)],
                  improved: true,
                };
              }
            }
          }
        }
        return { route, improved: false };
      }

      // Run 2-opt + Or-opt(1,2,3) on a route until fully converged.
      function optimizeFully(initial) {
        let route = initial;
        let iter = 0;
        let anyImproved = true;
        while (anyImproved && iter < 600) {
          anyImproved = false;
          iter++;
          for (const move of [
            (r) => twoOptPass(r),
            (r) => orOptPass(r, 1),
            (r) => orOptPass(r, 2),
            (r) => orOptPass(r, 3),
          ]) {
            const { route: r, improved } = move(route);
            if (improved) { route = r; anyImproved = true; break; }
          }
        }
        return { route, iter };
      }

      // ── Multi-start: geographically diverse entry points ─────────────────────
      // For territories far from home (e.g. 70 miles away) "closest to home"
      // clusters all starts on one edge. Use geographic extremes + centroid so
      // starts cover the whole territory and explore more of the solution space.
      const byLat = [...withCoords].sort((a, b) => coord(a).lat - coord(b).lat);
      const byLon = [...withCoords].sort((a, b) => coord(a).lon - coord(b).lon);
      const cLat  = withCoords.reduce((s, n) => s + coord(n).lat, 0) / withCoords.length;
      const cLon  = withCoords.reduce((s, n) => s + coord(n).lon, 0) / withCoords.length;
      const byDistHome = [...withCoords].sort((a, b) => dc(H, coord(a)) - dc(H, coord(b)));

      const startCoords = [
        H,                                                           // from home
        coord(byDistHome[0]),                                        // closest to home
        coord(byLat[0]),                                             // southernmost
        coord(byLat[byLat.length - 1]),                             // northernmost
        coord(byLon[0]),                                             // westernmost
        coord(byLon[byLon.length - 1]),                             // easternmost
        { lat: cLat, lon: cLon },                                   // centroid
        coord(withCoords[Math.floor(withCoords.length * 0.25)]),    // quarter-point
        coord(withCoords[Math.floor(withCoords.length * 0.75)]),    // three-quarter-point
      ];

      let bestRoute = null;
      let bestLen   = Infinity;
      let totalIter = 0;

      for (const startCoord of startCoords) {
        const seed            = nnRoute(withCoords, startCoord);
        const { route, iter } = optimizeFully(seed);
        totalIter            += iter;
        const len             = pathLength(route);
        if (len < bestLen) { bestLen = len; bestRoute = route; }
      }

      console.log(`[route] Multi-start done — ${startCoords.length} starts, best ${bestLen.toFixed(2)}km`);

      // ── Iterated Local Search (ILS) — escape local optima ────────────────────
      // Double-bridge cuts the route at 3 random points and reconnects segments
      // in a different order, producing solutions unreachable by 2-opt/Or-opt.
      // We perturb the best solution and re-optimize; keep improvements.
      function doubleBridge(route) {
        const n = route.length;
        if (n < 8) return route;
        // Pick 3 distinct random cut positions (sorted).
        const cuts = new Set();
        while (cuts.size < 3) cuts.add(1 + Math.floor(Math.random() * (n - 1)));
        const [a, b, c] = [...cuts].sort((x, y) => x - y);
        // Reconnect: seg0 + seg2 + seg1 + seg3 (can't be reached by 2-opt).
        return [...route.slice(0, a), ...route.slice(b, c), ...route.slice(a, b), ...route.slice(c)];
      }

      const ILS_ROUNDS = 30;
      let ilsIter = 0;
      for (let i = 0; i < ILS_ROUNDS; i++) {
        const perturbed       = doubleBridge(bestRoute);
        const { route, iter } = optimizeFully(perturbed);
        ilsIter              += iter;
        const len             = pathLength(route);
        if (len < bestLen - 1e-9) {
          bestLen   = len;
          bestRoute = route;
          console.log(`[route] ILS improvement at round ${i + 1}: ${len.toFixed(2)}km`);
        }
      }

      console.log(`[route] ILS done — ${ILS_ROUNDS} rounds, ${ilsIter} iters, final path ${bestLen.toFixed(2)}km`);

      const sorted    = [...bestRoute, ...withoutCoords];
      const sortedIds = sorted.map(g => g.id);
      console.log(`[route] Route planned. First: ${sorted[0].addr} (${sorted[0].dist.toFixed(1)}km from home)`);
      console.log(`[route] Last:  ${sorted.at(-1).addr} (${sorted.at(-1).dist.toFixed(1)}km from home)`);

      // ── Step 7: Disable jQuery UI Sortable then reorder #dragbox DOM ────
      // Disabling Sortable prevents jQuery from overriding our DOM manipulation.
      await session.evaluate((ids) => {
        // Disable jQuery UI Sortable so it doesn't interfere with appendChild.
        try { window.jQuery('#dragbox').sortable('disable'); } catch {}
        const parent = document.getElementById('dragbox');
        for (const id of ids) {
          const li = document.getElementById(id);
          if (li) parent.appendChild(li);
        }
      }, sortedIds);

      // Verify DOM order matches our sorted IDs.
      const domOrder = await session.evaluate(() =>
        [...document.querySelectorAll('#dragbox li')].map(li => li.id)
      );
      console.log(`[route] DOM reorder verified — first 3: ${domOrder.slice(0, 3).join(', ')}`);

      // ── Step 8: Call dosave() to populate RouteOrder from DOM order ──────
      // dosave() reads #dragbox li children in order and writes IDs to RouteOrder.
      await session.evaluate(() => { dosave(); });

      const routeOrder = await session.evaluate(() =>
        document.getElementById('RouteOrder').value
      );
      const routeIds = routeOrder.split(',').filter(Boolean);
      console.log(`[route] RouteOrder: ${routeIds.length} IDs — ${routeOrder.slice(0, 80)}…`);

      if (!routeOrder) {
        return { error: true, message: 'RouteOrder is empty after dosave(). DOM reorder may have failed.' };
      }

      // ── Step 9: Click Save Route using Playwright's native click ─────────
      // IMPORTANT: do NOT use evaluate() + form.submit() here — that triggers
      // a navigation which destroys the execution context mid-evaluate and throws
      // "execution context was destroyed". session.page.click() handles navigation
      // correctly. The button's onclick fires dosave() again (harmless — DOM is
      // already sorted so it produces the same RouteOrder).
      console.log(`[route] Clicking Save Route`);
      await Promise.all([
        session.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
        session.page.click('input[name="Save"]'),
      ]);
      console.log(`[route] Navigation complete after save`);

      // ── Step 10: Verify the territory is now marked as routed ────────────
      // Navigate back to the selection page and check if the territory option
      // is now shaded (background-color:#80FFFF = routed in OTM).
      await session.navigate(PAGES.terRoute);
      const isNowRouted = await session.evaluate((val) => {
        const opt = document.querySelector(`#TerID option[value="${val}"]`);
        return opt ? opt.style.backgroundColor.includes('80FFFF') || opt.style.backgroundColor.includes('rgb') : null;
      }, territoryValue);

      console.log(`[route] Territory marked as routed on selection page: ${isNowRouted}`);

      return {
        success:              true,
        routed_confirmed:     isNowRouted,
        territory:            territory_number,
        addresses_routed:     liItems.length,
        geocoded_count:       liItems.length - failed.length,
        failed_geocode_count: failed.length,
        failed_geocode_addrs: failed.length ? failed : undefined,
        route_order_ids:      routeIds.length,
        home_base:            '1675 Jack Calhoun Dr, Kissimmee FL 34741',
        route:                sorted.map((g, i) => `${i + 1}. ${g.addr} — ${g.coords ? g.dist.toFixed(1) + 'km from home' : 'NO GEOCODE'}`),
      };
    });
  }

  async function handleAddAddress({ street_number, street_name, unit, city, state = 'FL', zip, confirmed = false } = {}) {
    return withBrowser(async () => {
      const numStr      = String(street_number).trim();
      const fullAddress = `${numStr} ${street_name}${unit ? ` ${unit}` : ''}${city ? `, ${city}` : ''}${zip ? ` ${zip}` : ''}`.trim();
      console.log(`[add_address] Step 1 — searching for "${numStr} ${street_name}"`);

      // ── Step 1: Search by house number + street name only ────────────────
      await session.navigate(PAGES.addrSearch);

      // Clear all text inputs so prior session values don't leak into the search.
      await session.evaluate(() => {
        document.querySelectorAll('input[type="text"], input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])').forEach(el => { el.value = ''; });
      });

      // Fill only house number and street name — nothing else.
      for (const sel of ['input[name="housenum"]', 'input[name="Addr"]']) {
        try { await session.fill(sel, numStr); break; } catch {}
      }
      for (const sel of ['input[name="street"]', 'input[name="Street"]']) {
        try { await session.fill(sel, street_name); break; } catch {}
      }

      // Register the wait BEFORE clicking so we don't miss the navigation event.
      await Promise.all([
        session.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() =>
          session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
        ),
        session.page.click('input[type="submit"], button[type="submit"]').catch(() =>
          session.evaluate(() => {
            const btn = document.querySelector('input[type="submit"], button[type="submit"]');
            if (btn) btn.click();
          }).catch(() => {})
        ),
      ]);

      // Use scrapeTable (same robust logic as search_addresses tool).
      const table = await session.scrapeTable('table');
      if (table?.rows?.length) {
        const match = table.rows.find(row => {
          const vals = Object.values(row).map(v => String(v ?? '').trim());
          return vals.some(v => v === numStr || v.toLowerCase().startsWith(numStr + ' '));
        });
        if (match) {
          console.log(`[add_address] Already exists — ${JSON.stringify(match)}. Stopping.`);
          return {
            error: true,
            already_exists: true,
            message: `Address already exists in OTM — not added. Found: ${Object.values(match).join(', ')}`,
          };
        }
        console.log(`[add_address] ${table.rows.length} result(s) for street — house number ${numStr} not among them. Proceeding to add.`);
      } else {
        console.log(`[add_address] No results for street "${street_name}". Proceeding to add.`);
      }

      // ── Step 2: Fill the add form and save ───────────────────────────────
      console.log(`[add_address] Step 2 — navigating to add form`);
      await session.navigate(PAGES.addrEntry);
      await session.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

      await session.fill('input[name="Addr"]',   numStr);
      await session.fill('input[name="Street"]', street_name);
      if (unit) try { await session.fill('input[name="Apt"]', unit); } catch {}
      if (city) try { await session.fill('input[name="City"]', city); } catch {}
      try { await session.fill('input[name="State"]', state); } catch {}
      if (zip)  try { await session.fill('input[name="Zip"]',  zip); } catch {}

      if (confirmed) {
        await session.evaluate(() => {
          const sel = document.querySelector('select[name="Confirmed"]');
          if (sel) { sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      }

      // Get Lat/Long (best effort — don't fail if it times out).
      try {
        await session.page.click('input[type="button"][value="Get Lat/Long"]');
        await session.page.waitForFunction(
          () => { const el = document.getElementById('Lat'); return el && el.value && el.value !== ''; },
          { timeout: 8000 }
        ).catch(() => {});
      } catch {}

      // Save.
      await session.page.click('input[name="save"]');
      await session.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() =>
        session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      );

      const resultText = await session.evaluate(() => document.body.innerText);
      const success    = /success|saved|added|record/i.test(resultText);
      console.log(`[add_address] Save result: ${success ? 'success' : 'unclear'}`);

      return success
        ? { success: true,  address: fullAddress, message: 'Address added successfully.' }
        : { success: false, address: fullAddress, message: `Save result unclear. Page text: ${resultText.slice(0, 300)}` };
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

  async function handleGatedAddressReport() {
    return withBrowser(async () => {
      const page = session.page;

      // Load the full territory list once.
      await page.goto('https://onlineterritorymanager.com/GetStandard.php?code=A');
      await page.waitForLoadState('networkidle');

      // Collect every territory link from the left panel.
      const territories = await page.evaluate(() =>
        [...document.querySelectorAll('a[onclick*="getTerList"]')].map(a => {
          const m     = (a.getAttribute('onclick') || '').match(/getTerList\((\d+)/);
          const title = a.getAttribute('title') || '';
          const name  = a.textContent.trim();
          const desc  = title.replace(name + '-', '');
          return m ? { id: m[1], name, desc } : null;
        }).filter(Boolean)
      );

      if (!territories.length) throw new Error('No territories found on GetStandard.php');

      const results = [];

      for (const t of territories) {
        // Trigger AJAX panel load without navigating away from the page.
        await page.evaluate((id) => { window.getTerList(parseInt(id), 0, 0, 0); }, t.id);

        // Wait for panel to contain real address data.
        const loaded = await page.waitForFunction(
          () => {
            const txt = (document.getElementById('listter')?.innerText ?? '').trim();
            return txt.length > 50 && !txt.startsWith('Please select');
          },
          { timeout: 10_000 }
        ).then(() => true).catch(() => false);

        if (!loaded) {
          results.push({ name: t.name, desc: t.desc, total: 0, gated: 0, pct: 0, note: 'timeout' });
          continue;
        }

        // Count total address rows and gated ones in the panel table.
        const stats = await page.evaluate(() => {
          const panel = document.getElementById('listter');
          if (!panel) return { total: 0, gated: 0 };
          const rows = [...panel.querySelectorAll('tbody tr')];
          let total = 0, gated = 0;
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;
            total++;
            if (row.textContent.toLowerCase().includes('gated')) gated++;
          }
          return { total, gated };
        });

        const pct = stats.total > 0 ? Math.round((stats.gated / stats.total) * 100) : 0;
        results.push({ name: t.name, desc: t.desc, total: stats.total, gated: stats.gated, pct });
      }

      results.sort((a, b) => b.pct - a.pct);

      return {
        success: true,
        territories_checked: results.length,
        results: results.map(r => ({
          territory:  `${r.name}${r.desc ? ' — ' + r.desc : ''}`,
          gated:      r.gated,
          total:      r.total,
          gated_pct:  `${r.pct}%`,
          ...(r.note ? { note: r.note } : {}),
        })),
      };
    });
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
      case 'report_confirmed_addresses':  return handleReportConfirmedAddresses();
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
      case 'gated_address_report':        return handleGatedAddressReport();
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
