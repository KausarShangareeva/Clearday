import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUser, ensureUser, deleteUser, save, pruneCache, encrypt, decrypt, sign, unsign } from './store.js';
import * as google from './providers/google.js';
import * as microsoft from './providers/microsoft.js';
import * as mock from './providers/mock.js';
import { hasAI, classify, heuristic, answer, rewrite, suggestCategories, matchCategory } from './ai.js';

const PROVIDERS = { google, microsoft, ...(process.env.DEV_MOCK === '1' ? { mock } : {}) };
const SLOTS = ['personal', 'university', 'startup', 'work'];
const SLOT_NAMES = { personal: 'Personal', university: 'University', startup: 'Startup', work: 'Work' };
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
process.env.APP_URL = APP_URL;
const SECURE = APP_URL.startsWith('https');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
  next();
});

// ---------- session cookie ----------
function readCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function setCookie(res, name, value, maxAge = 60 * 60 * 24 * 180) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${SECURE ? '; Secure' : ''}`);
}
app.use((req, res, next) => {
  req.cookies = readCookies(req);
  let uid = unsign(req.cookies.cd_sid);
  if (!uid) { uid = crypto.randomUUID(); setCookie(res, 'cd_sid', sign(uid)); }
  req.uid = uid;
  next();
});
// Basic CSRF protection for JSON APIs: require same-origin requests.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.headers.origin;
  if (origin && origin !== APP_URL && !origin.startsWith('http://localhost')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  next();
});

// ---------- tiny rate limiter ----------
const hits = new Map();
const limit = (key, ms) => { const now = Date.now(), last = hits.get(key) || 0; if (now - last < ms) return false; hits.set(key, now); return true; };

// ---------- helpers ----------
const publicAccounts = u => SLOTS.filter(s => u?.accounts?.[s]).map(s => {
  const a = u.accounts[s];
  return { slot: s, name: SLOT_NAMES[s], provider: PROVIDERS[a.provider]?.label || a.provider, providerKey: a.provider, email: a.email, connectedAt: a.connectedAt, lastSync: a.lastSync || null, error: a.error || null };
});

async function freshToken(acc) {
  const P = PROVIDERS[acc.provider];
  const tokens = decrypt(acc.tokens);
  const updated = await P.refresh(tokens);
  if (updated) { acc.tokens = encrypt(updated); save(); return updated.access_token; }
  return tokens.access_token;
}
const todayStr = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const profileHash = (p, c) => crypto.createHash('sha1').update(JSON.stringify([p || {}, c || []])).digest('hex').slice(0, 10);

// ---------- health / me ----------
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'clearday', ai: hasAI(),
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, P]) => [k, P.configured()])),
}));
app.get('/api/me', (req, res) => {
  const u = getUser(req.uid);
  res.json({ accounts: publicAccounts(u), profile: u?.profile || null });
});
app.put('/api/profile', (req, res) => {
  const u = ensureUser(req.uid);
  u.profile = req.body?.profile || null;
  save();
  res.json({ ok: true });
});
app.delete('/api/me', async (req, res) => {
  const u = getUser(req.uid);
  if (u) for (const a of Object.values(u.accounts)) { try { await PROVIDERS[a.provider]?.revoke(decrypt(a.tokens)); } catch {} }
  deleteUser(req.uid);
  res.json({ ok: true });
});

// ---------- OAuth ----------
app.get('/auth/:provider/start', (req, res) => {
  const P = PROVIDERS[req.params.provider];
  const slot = SLOTS.includes(req.query.slot) ? req.query.slot : 'personal';
  if (!P) return res.status(404).send('Unknown provider');
  if (!P.configured()) return res.redirect(`/?auth_error=${encodeURIComponent(`${P.label} is not configured on the server yet (missing client ID/secret in .env)`)}`);
  const nonce = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'cd_oauth', sign(`${req.params.provider}:${slot}:${nonce}`), 600);
  res.redirect(P.authUrl(nonce));
});

app.get('/auth/:provider/callback', async (req, res) => {
  const P = PROVIDERS[req.params.provider];
  try {
    if (!P) throw new Error('Unknown provider');
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    const st = unsign(req.cookies.cd_oauth);
    const [prov, slot, nonce] = (st || '').split(':');
    if (!st || prov !== req.params.provider || nonce !== req.query.state) throw new Error('Sign-in session expired. Please try again.');
    setCookie(res, 'cd_oauth', '', 0);
    const { email, name, tokens } = await P.exchange(String(req.query.code || ''));
    const u = ensureUser(req.uid);
    // Replace whatever was in the slot (and remove the same address from another slot).
    for (const s of SLOTS) if (u.accounts[s]?.email === email && s !== slot) delete u.accounts[s];
    u.accounts[slot] = { provider: req.params.provider, email, name, tokens: encrypt(tokens), connectedAt: Date.now(), error: null };
    if (u.profile && !u.profile.name && name) u.profile.name = name.split(' ')[0];
    save();
    res.redirect(`/?connected=${slot}`);
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect(`/?auth_error=${encodeURIComponent(e.message)}`);
  }
});

app.delete('/api/accounts/:slot', async (req, res) => {
  const u = getUser(req.uid);
  const a = u?.accounts?.[req.params.slot];
  if (!a) return res.status(404).json({ error: 'Not connected' });
  try { await PROVIDERS[a.provider]?.revoke(decrypt(a.tokens)); } catch {}
  delete u.accounts[req.params.slot];
  for (const k of Object.keys(u.cache)) if (k.startsWith(req.params.slot + '_')) delete u.cache[k];
  save();
  res.json({ accounts: publicAccounts(u) });
});

// ---------- Sync: fetch → normalise → analyse → return ----------
app.post('/api/sync', async (req, res) => {
  const u = getUser(req.uid);
  if (!u || !Object.keys(u.accounts).length) return res.status(400).json({ error: 'Connect at least one inbox first.' });
  if (!limit('sync:' + req.uid, 5000)) return res.status(429).json({ error: 'Syncing already — give it a few seconds.' });
  const { profile, categories = [] } = req.body || {};
  if (profile) u.profile = profile;
  const cats = categories.length ? categories : ['Personal', 'Work', 'Finance', 'Events', 'Travel', 'News', 'Notifications', 'Promotions', 'Other'];
  const hours = +process.env.SYNC_HOURS || 72, max = Math.min(100, +process.env.MAX_PER_ACCOUNT || 25);
  const ph = profileHash(u.profile, cats);
  const fetched = [], errors = [];

  await Promise.all(Object.entries(u.accounts).map(async ([slot, acc]) => {
    try {
      const token = await freshToken(acc);
      const msgs = await PROVIDERS[acc.provider].fetchMessages(token, { hours, max, selfEmail: acc.email });
      msgs.forEach(m => fetched.push({ slot, acc, m, id: `${slot}_${m.providerId}`.replace(/[^\w-]/g, '').slice(0, 120) }));
      acc.lastSync = Date.now(); acc.error = null;
    } catch (e) {
      acc.error = e.code === 'reauth' ? 'reauth' : e.message;
      errors.push({ slot, error: acc.error });
      console.error(`sync ${slot}:`, e.message);
    }
  }));

  // Only analyse what's new (or everything if the profile changed).
  const todo = [];
  for (const f of fetched) {
    const c = u.cache[f.id];
    if (c && c.ph === ph) continue;
    if (f.m.providerCategory) { u.cache[f.id] = { a: heuristic(f.m, `Filed under ${f.m.providerCategory} by ${PROVIDERS[f.acc.provider].label}`), ph, t: Date.now() }; continue; }
    if (!hasAI()) { u.cache[f.id] = { a: heuristic(f.m, 'Basic rules (AI key not configured)'), ph, t: Date.now() }; continue; }
    todo.push(f);
  }
  const analyses = await classify(todo.map(f => ({ id: f.id, inbox: SLOT_NAMES[f.slot], ...f.m })), { profile: u.profile, categories: cats, today: todayStr() });
  for (const f of todo) u.cache[f.id] = { a: analyses[f.id] || heuristic(f.m), ph, t: Date.now() };
  for (const f of fetched) {
    // keep what the draft endpoint needs (no body stored)
    u.cache[f.id].meta = { slot: f.slot, providerId: f.m.providerId, threadId: f.m.threadId, fromEmail: f.m.fromEmail, fromName: f.m.fromName, subject: f.m.subject, messageIdHeader: f.m.messageIdHeader, unsub: f.m.unsub || '', unsubPost: f.m.unsubPost || '' };
  }
  pruneCache(u);
  save();

  const items = fetched.map(({ slot, m, id }) => {
    const a = u.cache[id].a;
    return {
      id, acc: slot, receivedAt: m.date, from: m.fromName || m.fromEmail, org: a.org || '', fromEmail: m.fromEmail,
      subject: m.subject, body: m.body || m.snippet, cat: a.category, kind: a.kind, base: a.priority, reasons: a.reasons,
      summary: a.summary, catch: a.catchLine, needsReply: a.needsReply,
      action: a.action ? { desc: a.action.task, deadline: a.action.deadline, how: a.action.how } : null,
      event: a.event, draft: a.draft, topics: a.newsletter?.topics || null, sums: a.newsletter?.sums || null, why: a.newsletter?.why || null, readMin: a.newsletter?.readMin || null,
      seen: !m.unread, replied: m.replied, link: m.link,
    };
  }).sort((x, y) => new Date(y.receivedAt) - new Date(x.receivedAt));

  res.json({ items, accounts: publicAccounts(u), errors, ai: hasAI(), analysed: todo.length });
});

// ---------- Drafts (never sends) ----------
app.post('/api/draft', async (req, res) => {
  const u = getUser(req.uid);
  const c = u?.cache?.[req.body?.id];
  const body = String(req.body?.body || '').slice(0, 10000);
  if (!c?.meta || !body.trim()) return res.status(400).json({ error: 'Email not found — sync again and retry.' });
  const acc = u.accounts[c.meta.slot];
  if (!acc) return res.status(400).json({ error: 'That inbox is no longer connected.' });
  try {
    const token = await freshToken(acc);
    const d = await PROVIDERS[acc.provider].createDraft(token, {
      to: c.meta.fromEmail, subject: c.meta.subject, body, threadId: c.meta.threadId,
      inReplyTo: c.meta.messageIdHeader, providerId: c.meta.providerId, selfEmail: acc.email,
    });
    res.json({ ok: true, link: d.link, provider: PROVIDERS[acc.provider].label });
  } catch (e) {
    res.status(e.code === 'reauth' ? 401 : 500).json({ error: e.code === 'reauth' ? 'Reconnect this inbox to save drafts.' : e.message });
  }
});

app.post('/api/rewrite', async (req, res) => {
  if (!hasAI()) return res.status(503).json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' });
  if (!limit('ai:' + req.uid, 800)) return res.status(429).json({ error: 'One moment…' });
  const { email, draft = '', instruction = 'Write a helpful reply.' } = req.body || {};
  if (!email?.body) return res.status(400).json({ error: 'Missing email' });
  try {
    const u = getUser(req.uid);
    const text = await rewrite({ email, draft: String(draft).slice(0, 5000), instruction: String(instruction).slice(0, 500), name: (u?.profile?.name || 'me').split(' ')[0] });
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  if (!hasAI()) return res.status(503).json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' });
  if (!limit('ai:' + req.uid, 800)) return res.status(429).json({ error: 'One moment…' });
  const { question, history, context } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Ask something' });
  try {
    const u = getUser(req.uid);
    res.json(await answer({ question: String(question).slice(0, 2000), history: Array.isArray(history) ? history : [], context: Array.isArray(context) ? context : [], profile: u?.profile, today: todayStr() }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Unsubscribe (RFC 8058 one-click when offered, otherwise hand the link to the user) ----------
app.post('/api/unsubscribe', async (req, res) => {
  const c = getUser(req.uid)?.cache?.[req.body?.id];
  if (!c?.meta) return res.status(400).json({ error: 'Email not found — sync again and retry.' });
  const links = [...String(c.meta.unsub || '').matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const http = links.find(l => /^https:\/\//i.test(l));
  const mailto = links.find(l => /^mailto:/i.test(l));
  if (http && /one-click/i.test(c.meta.unsubPost || '')) {
    try {
      const r = await fetch(http, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (r.ok) return res.json({ done: true });
    } catch { /* fall back to opening the page */ }
  }
  if (http) return res.json({ open: http });
  if (mailto) return res.json({ mailto });
  res.json({ none: true });
});

// ---------- Categories: analyse the whole mailbox, suggest folders, match emails ----------
const scanCache = new Map();
async function scanMailbox(u, uid) {
  const hit = scanCache.get(uid);
  if (hit && Date.now() - hit.t < 15 * 60e3) return hit.items;
  const max = Math.min(1000, +process.env.SCAN_MAX || 300);
  const items = [];
  await Promise.all(Object.entries(u.accounts).map(async ([slot, acc]) => {
    try {
      const token = await freshToken(acc);
      const list = await PROVIDERS[acc.provider].fetchIndex(token, { max, selfEmail: acc.email });
      list.forEach(m => items.push({ id: `${slot}_${m.providerId}`.replace(/[^\w-]/g, '').slice(0, 120), inbox: SLOT_NAMES[slot], from: m.fromName || m.fromEmail, fromEmail: m.fromEmail, subject: m.subject, snippet: m.snippet, date: m.date }));
    } catch (e) { console.error(`scan ${slot}:`, e.message); }
  }));
  scanCache.set(uid, { t: Date.now(), items });
  return items;
}
function keywordMatch(items, name, description) {
  const terms = `${name} ${description}`.toLowerCase().match(/[\p{L}\d]{4,}/gu) || [];
  return items.filter(i => terms.some(t => `${i.from} ${i.fromEmail} ${i.subject} ${i.snippet}`.toLowerCase().includes(t))).map(i => ({ id: i.id, reason: 'Matches your keywords' }));
}
app.post('/api/categories/suggest', async (req, res) => {
  const u = getUser(req.uid);
  if (!u || !Object.keys(u.accounts).length) return res.status(400).json({ error: 'Connect an inbox first.' });
  if (!limit('cat:' + req.uid, 2000)) return res.status(429).json({ error: 'One moment…' });
  try {
    const items = await scanMailbox(u, req.uid);
    const suggestions = hasAI() && items.length ? await suggestCategories(items, req.body?.existing || [], u.profile) : [];
    res.json({ total: items.length, suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/categories/match', async (req, res) => {
  const u = getUser(req.uid);
  const name = String(req.body?.name || '').slice(0, 60), description = String(req.body?.description || '').slice(0, 600);
  if (!u || !Object.keys(u.accounts).length) return res.status(400).json({ error: 'Connect an inbox first.' });
  if (!name || !description) return res.status(400).json({ error: 'Name and description are required.' });
  try {
    const items = await scanMailbox(u, req.uid);
    const found = hasAI() ? await matchCategory(items, name, description) : keywordMatch(items, name, description);
    const byId = new Map(items.map(i => [i.id, i]));
    res.json({ total: items.length, matches: found.map(f => ({ ...f, from: byId.get(f.id).from, fromEmail: byId.get(f.id).fromEmail, subject: byId.get(f.id).subject })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Sender logos (organisation site icons, proxied + cached) ----------
// Fetched server-side so the user's browser doesn't leak which senders they have to third parties.
const logoCache = new Map();
app.get('/api/logo', async (req, res) => {
  const d = String(req.query.d || '').toLowerCase();
  if (!/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,24}$/.test(d) || d.length > 120) return res.status(400).end();
  let hit = logoCache.get(d);
  if (hit === undefined) {
    hit = null;
    for (const url of [`https://${d}/apple-touch-icon.png`, `https://icons.duckduckgo.com/ip3/${d}.ico`, `https://${d}/favicon.ico`]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3500), redirect: 'follow' });
        const type = (r.headers.get('content-type') || '').split(';')[0];
        if (!r.ok || !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|ico)$/.test(type)) continue; // no SVG (could carry script)
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 300 && buf.length < 400000) { hit = { buf, type }; break; }
      } catch { /* try next source */ }
    }
    logoCache.set(d, hit);
    if (logoCache.size > 3000) logoCache.delete(logoCache.keys().next().value);
  }
  if (!hit) return res.status(404).end();
  res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=604800', 'Content-Security-Policy': "default-src 'none'" });
  res.send(hit.buf);
});

// ---------- static frontend ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const port = +process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n✦ Clearday running at ${APP_URL}`);
  console.log(`  Gmail:   ${google.configured() ? 'ready' : 'not configured'}   Outlook: ${microsoft.configured() ? 'ready' : 'not configured'}   AI: ${hasAI() ? 'ready' : 'not configured'}${process.env.DEV_MOCK === '1' ? '   Mock provider: ON' : ''}\n`);
});
