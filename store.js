/**
 * store.js — Encrypted per-user credential store
 *
 * Credentials are encrypted with AES-256-GCM using STORE_KEY from .env.
 * Generate a key:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Data is persisted to data/users.json.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'data', 'users.json');
const ALGORITHM  = 'aes-256-gcm';

function getKey() {
  const hex = process.env.STORE_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) return plaintext; // unencrypted fallback

  const iv       = crypto.randomBytes(16);
  const cipher   = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag      = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(value) {
  if (!value.startsWith('enc:')) return value; // plaintext fallback

  const key = getKey();
  if (!key) throw new Error('STORE_KEY not set — cannot decrypt stored credentials.');

  const [, ivHex, tagHex, encHex] = value.split(':');
  const iv        = Buffer.from(ivHex, 'hex');
  const tag       = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher  = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeStore(data) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a user record or null if not found.
 * { otmUser, otmPass, allowed, registered }
 */
export async function getUser(userId) {
  const store = await readStore();
  const entry = store[String(userId)];
  if (!entry) return null;
  return {
    ...entry,
    otmUser: entry.otmUser ? decrypt(entry.otmUser) : null,
    otmPass: entry.otmPass ? decrypt(entry.otmPass) : null,
  };
}

/** Save or update a user record. Pass only the fields you want to change. */
export async function setUser(userId, fields) {
  const store = await readStore();
  const id    = String(userId);
  const existing = store[id] ?? {};

  const updated = { ...existing };
  if ('otmUser'     in fields) updated.otmUser     = fields.otmUser ? encrypt(fields.otmUser) : null;
  if ('otmPass'     in fields) updated.otmPass     = fields.otmPass ? encrypt(fields.otmPass) : null;
  if ('allowed'     in fields) updated.allowed     = fields.allowed;
  if ('registered'  in fields) updated.registered  = fields.registered;
  if ('displayName' in fields) updated.displayName = fields.displayName;
  if ('provider'         in fields) updated.provider         = fields.provider;
  if ('model'            in fields) updated.model            = fields.model;
  if ('congregationName' in fields) updated.congregationName = fields.congregationName;

  store[id] = updated;
  await writeStore(store);
}

export async function deleteUser(userId) {
  const store = await readStore();
  delete store[String(userId)];
  await writeStore(store);
}

export async function getAllUsers() {
  const store = await readStore();
  return Object.entries(store).map(([id, entry]) => ({
    userId: id,
    allowed:      entry.allowed ?? false,
    registered:   entry.registered ?? false,
    displayName:  entry.displayName ?? null,
    hasOtmUser:   !!entry.otmUser,
    hasOtmPass:   !!entry.otmPass,
  }));
}

export async function isAllowed(userId) {
  const user = await getUser(userId);
  return user?.allowed === true;
}

export async function isRegistered(userId) {
  const user = await getUser(userId);
  return user?.registered === true && !!user.otmUser && !!user.otmPass;
}
