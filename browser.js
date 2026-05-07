import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OTM_BASE = 'https://onlineterritorymanager.com';

const LOGIN_SELECTORS = {
  email:    ['#username', 'input[name="username"]', 'input[type="username"]', 'input[type="email"]', 'input[name="email"]'],
  password: ['#password', 'input[name="password"]', 'input[type="password"]'],
  submit:   ['button[name="submit-login"]', 'button[type="submit"]', 'input[type="submit"]'],
};

export class BrowserSession {
  /**
   * @param {object} [opts]
   * @param {string} [opts.userId='default']  Used to namespace the cookies file.
   * @param {string} [opts.otmUser]           OTM email — falls back to OTM_USER env var.
   * @param {string} [opts.otmPass]           OTM password — falls back to OTM_PASS env var.
   */
  constructor({ userId = 'default', otmUser, otmPass } = {}) {
    this.userId      = userId;
    this.otmUser     = otmUser ?? process.env.OTM_USER;
    this.otmPass     = otmPass ?? process.env.OTM_PASS;
    this.cookiesPath = path.join(__dirname, 'cookies', `${userId}.json`);
    this.browser     = null;
    this.context     = null;
    this.page        = null;
    this._loginInProgress = false;
  }

  async init() {
    if (this.browser) return;
    const headless = process.env.HEADLESS !== 'false';
    this.browser = await chromium.launch({ headless, slowMo: headless ? 0 : 80 });

    let storageState;
    try {
      const raw = await fs.readFile(this.cookiesPath, 'utf-8');
      storageState = JSON.parse(raw);
    } catch {}

    this.context = await this.browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);
  }

  async saveCookies() {
    try {
      await fs.mkdir(path.dirname(this.cookiesPath), { recursive: true });
      const state = await this.context.storageState();
      await fs.writeFile(this.cookiesPath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[browser:${this.userId}] Failed to save cookies:`, err.message);
    }
  }

  async isLoggedIn() {
    try {
      const url = this.page.url();
      // If we're already on a page deeper than the root we're likely logged in.
      const isRoot = url === OTM_BASE || url === OTM_BASE + '/';
      if (url.startsWith(OTM_BASE) && !isRoot) return true;
      // Otherwise probe /territories — if we get redirected back to root, session is gone.
      const resp   = await this.page.goto(`${OTM_BASE}/GetStandard.php`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const landed = this.page.url();
      const landedIsRoot = landed === OTM_BASE || landed === OTM_BASE + '/';
      return !!resp && resp.ok() && !landedIsRoot;
    } catch {
      return false;
    }
  }

  async login() {
    if (this._loginInProgress) return;
    this._loginInProgress = true;
    try {
      if (!this.otmUser || !this.otmPass) throw new Error('OTM credentials not set for this session.');
      await this.page.goto(OTM_BASE, { waitUntil: 'domcontentloaded' });

      const fillFirst = async (candidates, value) => {
        for (const sel of candidates) {
          try { await this.page.fill(sel, value, { timeout: 3000 }); return; } catch {}
        }
        throw new Error(`Could not find input among: ${candidates.join(', ')}`);
      };

      await fillFirst(LOGIN_SELECTORS.email, this.otmUser);
      await fillFirst(LOGIN_SELECTORS.password, this.otmPass);

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
      if (url === OTM_BASE || url === OTM_BASE + '/') {
        throw new Error('Login failed — still on login page. Check your OTM credentials.');
      }
      await this.saveCookies();
    } finally {
      this._loginInProgress = false;
    }
  }

  async ensureLoggedIn() {
    await this.init();
    if (!(await this.isLoggedIn())) await this.login();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async navigate(urlOrPath) {
    await this.ensureLoggedIn();
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${OTM_BASE}${urlOrPath}`;
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    return this.page.url();
  }

  async getPageContent() { return this.page.content(); }
  async getCurrentUrl()  { return this.page.url(); }

  async getElement(selector) {
    const el = await this.page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    const [text, html] = await Promise.all([el.textContent(), el.innerHTML()]);
    return { text: text?.trim(), html };
  }

  async getAllElements(selector) {
    const els = await this.page.$$(selector);
    return Promise.all(els.map(async (el) => {
      const text  = (await el.textContent())?.trim();
      const html  = await el.innerHTML();
      const attrs = await el.evaluate((node) => {
        const r = {};
        for (const a of node.attributes) r[a.name] = a.value;
        return r;
      });
      return { text, html, attrs };
    }));
  }

  async click(selector) {
    await this.page.click(selector, { timeout: 10000 });
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  async fill(selector, value)  { await this.page.fill(selector, value, { timeout: 10000 }); }
  async select(selector, value){ await this.page.selectOption(selector, value, { timeout: 10000 }); }
  async evaluate(fn, ...args)  { return this.page.evaluate(fn, ...args); }

  async waitForSelector(selector, timeout = 10000) {
    return this.page.waitForSelector(selector, { timeout });
  }

  async scrapeTable(tableSelector = 'table') {
    return this.page.evaluate((sel) => {
      const table = document.querySelector(sel);
      if (!table) return null;
      const headers = [...table.querySelectorAll('thead th, thead td')].map(th => th.textContent.trim());
      const rows    = [...table.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
      return { headers, rows };
    }, tableSelector);
  }

  async findLinks(textPattern) {
    return this.page.evaluate((pat) => {
      const re = new RegExp(pat, 'i');
      return [...document.querySelectorAll('a')]
        .filter(a => re.test(a.textContent))
        .map(a => ({ text: a.textContent.trim(), href: a.href }));
    }, textPattern);
  }

  /**
   * Navigate to a page by clicking the first nav/menu link whose text matches
   * the pattern. Throws if no matching link is found.
   * @param {string} textPattern  e.g. 'territor', 'publisher'
   */
  async navigateByLinkText(textPattern) {
    await this.ensureLoggedIn();
    const links = await this.findLinks(textPattern);
    if (links.length > 0) {
      await this.page.goto(links[0].href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return this.page.url();
    }
    throw new Error(`Could not find a "${textPattern}" link on the page. Use get_page_content to see what links are available.`);
  }

  async screenshot() {
    const buf = await this.page.screenshot({ type: 'png' });
    return buf.toString('base64');
  }

  async clearCookies() {
    try { await fs.unlink(this.cookiesPath); } catch {}
  }

  async close() {
    await this.saveCookies();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page    = null;
  }
}

// Singleton for the CLI (uses OTM_USER / OTM_PASS from env).
const session = new BrowserSession();
export default session;
