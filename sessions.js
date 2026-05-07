/**
 * sessions.js — Per-user browser session pool
 *
 * Each Telegram user gets their own BrowserSession instance with their own
 * OTM credentials and their own cookies file (cookies/<userId>.json).
 */

import { BrowserSession } from './browser.js';

class SessionManager {
  constructor() {
    this._pool = new Map(); // userId (string) -> BrowserSession
  }

  /**
   * Get or create the session for a user.
   * @param {string|number} userId
   * @param {{ otmUser: string, otmPass: string }} credentials
   */
  getOrCreate(userId, { otmUser, otmPass }) {
    const id = String(userId);
    if (!this._pool.has(id)) {
      this._pool.set(id, new BrowserSession({ userId: id, otmUser, otmPass }));
    }
    return this._pool.get(id);
  }

  has(userId) {
    return this._pool.has(String(userId));
  }

  /** Force-close and remove a user's session (e.g. after credential change). */
  async destroy(userId) {
    const id = String(userId);
    const s  = this._pool.get(id);
    if (s) {
      await s.close().catch(() => {});
      this._pool.delete(id);
    }
  }

  async destroyAll() {
    for (const id of this._pool.keys()) await this.destroy(id);
  }
}

export default new SessionManager();
