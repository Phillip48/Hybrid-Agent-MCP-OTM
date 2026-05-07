import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
export const OTM_BASE = 'https://onlineterritorymanager.com';

// Candidate selectors tried in order for each login field.
const LOGIN_SELECTORS = {
  email: ['#user_email', 'input[name="user[email]"]', 'input[type="email"]', 'input[name="email"]'],
  password: ['#user_password', 'input[name="user[password]"]', 'input[type="password"]', 'input[name="password"]'],
  submit: ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Log in")'],
};

class BrowserSession {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this._loginInProgress = false;
  }

  async init() {
    if (this.browser) return;
    const headless = process.env.HEADLESS !== 'false';
    this.browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });

    let storageState;
    try {
      const raw = await fs.readFile(COOKIES_PATH, 'utf-8');
      storageState = JSON.parse(raw);
    } catch {
      // No saved session — start fresh.
    }

    this.context = await this.browser.newContext({
      storageState,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
  }

  async saveCookies() {
    try {
      const state = await this.context.storageState();
      await fs.writeFile(COOKIES_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[browser] Failed to save cookies:', err.message);
    }
  }

  // Returns true when the current page looks like a logged-in dashboard.
  async isLoggedIn() {
    try {
      const url = this.page.url();
      // If we're already on a non-login page assume logged in.
      if (!url.includes('sign_in') && !url.includes('login') && url.includes(OTM_BASE)) {
        return true;
      }
      // Do a lightweight probe of the territories path.
      const resp = await this.page.goto(`${OTM_BASE}/territories`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const landed = this.page.url();
      return !!resp && resp.ok() && !landed.includes('sign_in') && !landed.includes('login');
    } catch {
      return false;
    }
  }

  async login() {
    if (this._loginInProgress) return;
    this._loginInProgress = true;
    try {
      await this.page.goto(`${OTM_BASE}/users/sign_in`, { waitUntil: 'domcontentloaded' });

      // Try each candidate selector in order.
      const fillFirst = async (candidates, value) => {
        for (const sel of candidates) {
          try {
            await this.page.fill(sel, value, { timeout: 3000 });
            return;
          } catch {}
        }
        throw new Error(`Could not find input field among: ${candidates.join(', ')}`);
      };

      await fillFirst(LOGIN_SELECTORS.email, process.env.OTM_USER);
      await fillFirst(LOGIN_SELECTORS.password, process.env.OTM_PASS);

      for (const sel of LOGIN_SELECTORS.submit) {
        try {
          await Promise.all([
            this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }),
            this.page.click(sel, { timeout: 3000 }),
          ]);
          break;
        } catch {}
      }

      const url = this.page.url();
      if (url.includes('sign_in') || url.includes('login')) {
        throw new Error('Login failed — still on login page. Check OTM_USER / OTM_PASS.');
      }
      await this.saveCookies();
    } finally {
      this._loginInProgress = false;
    }
  }

  async ensureLoggedIn() {
    await this.init();
    if (!(await this.isLoggedIn())) {
      await this.login();
    }
  }

  // ── High-level actions used by MCP tools ────────────────────────────────────

  async navigate(urlOrPath) {
    await this.ensureLoggedIn();
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${OTM_BASE}${urlOrPath}`;
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    return this.page.url();
  }

  async getPageContent() {
    return this.page.content();
  }

  async getCurrentUrl() {
    return this.page.url();
  }

  // Returns { text, html } for the first matching element.
  async getElement(selector) {
    const el = await this.page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    const [text, html] = await Promise.all([el.textContent(), el.innerHTML()]);
    return { text: text?.trim(), html };
  }

  // Returns array of { text, html, attrs } for all matching elements.
  async getAllElements(selector) {
    const els = await this.page.$$(selector);
    return Promise.all(
      els.map(async (el) => {
        const text = (await el.textContent())?.trim();
        const html = await el.innerHTML();
        const attrs = await el.evaluate((node) => {
          const result = {};
          for (const attr of node.attributes) result[attr.name] = attr.value;
          return result;
        });
        return { text, html, attrs };
      }),
    );
  }

  async click(selector) {
    await this.page.click(selector, { timeout: 10000 });
    // Brief settle after click to let any navigation or re-render finish.
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  async fill(selector, value) {
    await this.page.fill(selector, value, { timeout: 10000 });
  }

  async select(selector, value) {
    await this.page.selectOption(selector, value, { timeout: 10000 });
  }

  // Run arbitrary JS in the page context.
  async evaluate(fn, ...args) {
    return this.page.evaluate(fn, ...args);
  }

  async waitForSelector(selector, timeout = 10000) {
    return this.page.waitForSelector(selector, { timeout });
  }

  async waitForText(text, timeout = 10000) {
    return this.page.waitForSelector(`text=${text}`, { timeout });
  }

  // Returns base64 PNG screenshot (useful for debugging via MCP).
  async screenshot() {
    const buf = await this.page.screenshot({ type: 'png' });
    return buf.toString('base64');
  }

  // Extract structured table data from the page.
  async scrapeTable(tableSelector = 'table') {
    return this.page.evaluate((sel) => {
      const table = document.querySelector(sel);
      if (!table) return null;
      const headers = [...table.querySelectorAll('thead th, thead td')].map((th) => th.textContent.trim());
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
      );
      return { headers, rows };
    }, tableSelector);
  }

  // Find all links whose text matches a pattern.
  async findLinks(textPattern) {
    return this.page.evaluate((pat) => {
      const re = new RegExp(pat, 'i');
      return [...document.querySelectorAll('a')]
        .filter((a) => re.test(a.textContent))
        .map((a) => ({ text: a.textContent.trim(), href: a.href }));
    }, textPattern);
  }

  async close() {
    await this.saveCookies();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

// Singleton — shared across all tool invocations in a process.
const session = new BrowserSession();
export default session;
