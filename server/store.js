// Tiny encrypted JSON store + cookie signing. Good enough for a hackathon deployment
// on a single server; swap for Postgres/Supabase in production.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const secret = process.env.SESSION_SECRET || '';
if (secret.length < 16) {
  console.error('\n✖ SESSION_SECRET is missing or too short. Copy .env.example to .env and set it.\n');
  process.exit(1);
}
const KEY = crypto.createHash('sha256').update(secret).digest();
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const FILE = path.join(DATA_DIR, 'db.json');

let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 150);
}

// Server-wide counters (e.g. Condense totals), persisted in the same db.json.
export const getGlobal = () => (db.global ||= {});
export const getUser = uid => db.users[uid] || null;
export function ensureUser(uid) {
  if (!db.users[uid]) db.users[uid] = { profile: null, accounts: {}, cache: {}, createdAt: Date.now() };
  return db.users[uid];
}
export function deleteUser(uid) { delete db.users[uid]; save(); }
export const userCount = () => Object.keys(db.users).length;
export const allUsers = () => Object.entries(db.users);
// Small append-only audit trail of admin actions (last 200).
export function auditPush(entry) { (db.audit ||= []).push({ at: Date.now(), ...entry }); if (db.audit.length > 200) db.audit.splice(0, db.audit.length - 200); save(); }
export const getAudit = () => db.audit || [];
// A mailbox identifies its owner: the same provider+address always maps back to the same user record.
export function findUserByAccount(provider, email, exceptUid) {
  const want = String(email || '').toLowerCase();
  if (!want) return null;
  for (const [uid, u] of Object.entries(db.users)) {
    if (uid === exceptUid) continue;
    if (Object.values(u.accounts || {}).some(a => a.provider === provider && String(a.email || '').toLowerCase() === want)) return uid;
  }
  return null;
}

export function pruneCache(u, max = 1500) {
  const keys = Object.keys(u.cache);
  if (keys.length <= max) return;
  keys.sort((a, b) => (u.cache[a].t || 0) - (u.cache[b].t || 0));
  for (const k of keys.slice(0, keys.length - max)) delete u.cache[k];
}

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(str) {
  const b = Buffer.from(str, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

const mac = v => crypto.createHmac('sha256', KEY).update(v).digest('base64url');
export const sign = v => `${v}.${mac(v)}`;
export function unsign(s) {
  if (!s) return null;
  const i = s.lastIndexOf('.');
  if (i < 1) return null;
  const v = s.slice(0, i), m = Buffer.from(s.slice(i + 1)), exp = Buffer.from(mac(v));
  return m.length === exp.length && crypto.timingSafeEqual(m, exp) ? v : null;
}
