import './env.js';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUser, ensureUser, deleteUser, save, pruneCache, encrypt, decrypt, sign, unsign } from './store.js';
import * as google from './providers/google.js';
import * as microsoft from './providers/microsoft.js';
import * as mock from './providers/mock.js';
import { yahoo, mailru } from './providers/imap.js';
import { hasAI, aiProvider, classify, heuristic, answer, rewrite, suggestCategories, matchCategory, summarize, suggestFromAbout } from './ai.js';
import * as memory from './memory.js';
import { LIVE_TOOLS, liveSystemPrompt } from './live.js';

const PROVIDERS = { google, microsoft, yahoo, mailru, ...(process.env.DEV_MOCK === '1' ? { mock } : {}) };
const SLOTS = ['personal', 'university', 'startup', 'work'];
const SLOT_NAMES = { personal: 'Personal', university: 'University', startup: 'Startup', work: 'Work' };
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
process.env.APP_URL = APP_URL;
const SECURE = APP_URL.startsWith('https');
const liveItems = new Map(); // uid -> items from the last sync, used by the voice assistant's tools (never persisted)

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
  if (P.imap) return tokens; // IMAP mailboxes sign in with an app password, no token refresh
  const updated = await P.refresh(tokens);
  if (updated) { acc.tokens = encrypt(updated); save(); return updated.access_token; }
  return tokens.access_token;
}
const todayStr = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const profileHash = (p, c) => crypto.createHash('sha1').update(JSON.stringify([p || {}, c || []])).digest('hex').slice(0, 10);

// ---------- health / me ----------
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'clearday', ai: hasAI(), aiProvider: aiProvider(), voice: aiProvider() === 'gemini',
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
  memory.clearMemory();
  liveItems.delete(req.uid);
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

// ---------- Yahoo / Mail.ru: connect with an app password (IMAP) ----------
app.post('/api/imap/connect', async (req, res) => {
  const { slot, provider, email, password } = req.body || {};
  const P = PROVIDERS[provider];
  if (!P?.imap) return res.status(400).json({ error: 'Unknown mail provider' });
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'Unknown slot' });
  if (!limit('imap:' + req.uid, 2000)) return res.status(429).json({ error: 'One moment…' });
  try {
    const { email: addr, tokens } = await P.verify(String(email || ''), String(password || ''));
    const u = ensureUser(req.uid);
    for (const s of SLOTS) if (u.accounts[s]?.email === addr && s !== slot) delete u.accounts[s];
    u.accounts[slot] = { provider, email: addr, name: '', tokens: encrypt(tokens), connectedAt: Date.now(), error: null };
    save();
    res.json({ accounts: publicAccounts(u) });
  } catch (e) { res.status(e.code === 'reauth' ? 401 : 502).json({ error: e.message }); }
});

// ---------- Sync: fetch → normalise → analyse → return ----------
app.post('/api/sync', async (req, res) => {
  const u = getUser(req.uid);
  if (!u || !Object.keys(u.accounts).length) return res.status(400).json({ error: 'Connect at least one inbox first.' });
  if (!limit('sync:' + req.uid, 5000)) return res.status(429).json({ error: 'Syncing already — give it a few seconds.' });
  const { profile, categories = [], boardCats = [] } = req.body || {};
  if (profile) u.profile = profile;
  u.boardCats = (Array.isArray(boardCats) ? boardCats : []).slice(0, 20).map(c => ({ name: String(c.name || '').slice(0, 40), desc: String(c.desc || '').slice(0, 200), ids: (c.ids || []).slice(0, 500).map(String), domains: (c.domains || []).slice(0, 50).map(String), senders: (c.senders || []).slice(0, 100).map(String), auto: !!c.auto, ai: !!c.ai })).filter(c => c.name);
  const cats = categories.length ? categories : ['Personal', 'Work', 'Finance', 'Events', 'Travel', 'News', 'Notifications', 'Promotions', 'Other'];
  const max = Math.min(100, +process.env.MAX_PER_ACCOUNT || 50); // latest mails per inbox, never the whole mailbox
  const hints = (u.boardCats || []).filter(c => c.ai && c.desc).map(c => ({ name: c.name, desc: c.desc }));
  const ph = profileHash(u.profile, [cats, hints]);
  const fetched = [], errors = [];

  await Promise.all(Object.entries(u.accounts).map(async ([slot, acc]) => {
    try {
      const token = await freshToken(acc);
      const msgs = await PROVIDERS[acc.provider].fetchMessages(token, { max, selfEmail: acc.email });
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
  const analyses = await classify(todo.map(f => ({ id: f.id, inbox: SLOT_NAMES[f.slot], ...f.m })), { profile: u.profile, categories: cats, today: todayStr(), hints });
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

  // Folder each mail sits in on the Board (custom categories first, else its inbox), for the voice tools.
  const dom = e => (e.split('@')[1] || '').toLowerCase().split('.').slice(-2).join('.');
  liveItems.set(req.uid, items.map(i => {
    const c = (u.boardCats || []).find(c => c.ids.includes(i.id) || (c.ai && i.cat === c.name) || (c.auto && (c.domains.includes(dom(i.fromEmail)) || c.senders.includes(i.fromEmail))));
    return { ...i, folder: c ? c.name : SLOT_NAMES[i.acc] };
  }));
  res.json({ items, accounts: publicAccounts(u), errors, ai: hasAI(), aiProvider: aiProvider(), analysed: todo.length });
});

// ---------- Drafts (never sends) ----------
async function saveDraft(u, id, body) {
  const c = u?.cache?.[id];
  if (!c?.meta || !String(body || '').trim()) throw Object.assign(new Error('Email not found — sync again and retry.'), { status: 400 });
  const acc = u.accounts[c.meta.slot];
  if (!acc) throw Object.assign(new Error('That inbox is no longer connected.'), { status: 400 });
  try {
    const token = await freshToken(acc);
    const d = await PROVIDERS[acc.provider].createDraft(token, {
      to: c.meta.fromEmail, subject: c.meta.subject, body: String(body).slice(0, 10000), threadId: c.meta.threadId,
      inReplyTo: c.meta.messageIdHeader, providerId: c.meta.providerId, selfEmail: acc.email,
    });
    return { link: d.link, provider: PROVIDERS[acc.provider].label };
  } catch (e) {
    if (e.code === 'reauth') throw Object.assign(new Error('Reconnect this inbox to save drafts.'), { status: 401 });
    throw e;
  }
}
app.post('/api/draft', async (req, res) => {
  try { res.json({ ok: true, ...(await saveDraft(getUser(req.uid), req.body?.id, req.body?.body)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/rewrite', async (req, res) => {
  if (!hasAI()) return res.status(503).json({ error: 'AI is not configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' });
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
  if (!hasAI()) return res.status(503).json({ error: 'AI is not configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' });
  if (!limit('ai:' + req.uid, 800)) return res.status(429).json({ error: 'One moment…' });
  const { question, history, context } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Ask something' });
  try {
    const u = getUser(req.uid);
    res.json(await answer({ question: String(question).slice(0, 2000), history: Array.isArray(history) ? history : [], context: Array.isArray(context) ? context : [], profile: u?.profile, today: todayStr() }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Local memory (data/memory.json on this machine) ----------
app.get('/api/memory', (req, res) => res.json(memory.listMemory()));
app.post('/api/memory', (req, res) => {
  const f = memory.addFact(req.body?.text, 'user');
  if (!f) return res.status(400).json({ error: 'Nothing to remember' });
  res.json(f);
});
app.post('/api/memory/sender', (req, res) => { memory.setSender(req.body?.email, req.body?.note, req.body?.priority); res.json({ ok: true }); });
app.delete('/api/memory/:id', (req, res) => { memory.removeItem(req.params.id); res.json(memory.listMemory()); });
app.delete('/api/memory', (req, res) => { memory.clearMemory(); res.json(memory.listMemory()); });

// ---------- Gemini Live voice (from Pranish's branch) ----------
// The browser talks to Gemini Live directly with a short-lived ephemeral token; the real key stays on the server.
const LIVE_MODEL = () => process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
function liveConfig(u) {
  const inboxes = Object.keys(u?.accounts || {}).map(s => ({ name: SLOT_NAMES[s], hint: 'inbox' }));
  const cats = [...inboxes, ...(u?.boardCats || []).map(c => ({ name: c.name, hint: c.desc }))];
  return {
    responseModalities: ['AUDIO'],
    systemInstruction: liveSystemPrompt({ profile: u?.profile, cats, today: todayStr(), mem: memory.promptBlock() }),
    tools: [{ functionDeclarations: LIVE_TOOLS }],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Kore' } } },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    sessionResumption: {},
  };
}
app.post('/api/live/token', async (req, res) => {
  if (aiProvider() !== 'gemini') return res.status(503).json({ error: 'Live voice needs GEMINI_API_KEY on the server.' });
  if (!limit('live:' + req.uid, 2000)) return res.status(429).json({ error: 'One moment…' });
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });
    const config = liveConfig(getUser(req.uid));
    const token = await client.authTokens.create({ config: {
      uses: 3,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      liveConnectConstraints: { model: LIVE_MODEL(), config },
    } });
    res.json({ token: token.name, model: LIVE_MODEL(), config });
  } catch (e) { console.error('live token:', e.message); res.status(500).json({ error: e.message }); }
});
const PRI = { critical: 0, important: 1, normal: 2, low: 3, noise: 4 };
const brief = i => ({ id: i.id, from: i.from, subject: i.subject, received: i.receivedAt, priority: i.base, folder: i.folder || 'Other', summary: i.summary, needsReply: i.needsReply, replied: i.replied, unread: !i.seen, deadline: i.action?.deadline || null, task: i.action?.desc || null });
function findEmail(items, ref) {
  const r = String(ref || '').toLowerCase();
  return items.find(i => i.id === ref) || items.find(i => `${i.from} ${i.subject}`.toLowerCase().includes(r));
}
app.post('/api/live/tool', async (req, res) => {
  const { name, args = {} } = req.body || {};
  const u = getUser(req.uid), items = liveItems.get(req.uid) || [];
  try {
    switch (name) {
      case 'get_briefing': {
        const top = items.filter(i => PRI[i.base] <= 1 && !i.replied).sort((a, b) => PRI[a.base] - PRI[b.base]).slice(0, 6).map(brief);
        const reply = items.filter(i => i.needsReply && !i.replied).slice(0, 6).map(brief);
        const deadlines = items.filter(i => i.action?.deadline).sort((a, b) => a.action.deadline.localeCompare(b.action.deadline)).slice(0, 6).map(brief);
        const byCategory = {};
        for (const i of items) {
          const c = (byCategory[i.folder || 'Other'] ||= { total: 0, waitingOnUser: 0, unread: 0, nextDeadline: null });
          c.total++; if (!i.seen) c.unread++;
          if (i.needsReply && !i.replied) c.waitingOnUser++;
          const d = i.action?.deadline; if (d && (!c.nextDeadline || d < c.nextDeadline)) c.nextDeadline = d;
        }
        return res.json({ result: { total: items.length, unread: items.filter(i => !i.seen).length, byCategory, topPriority: top, needsReply: reply, deadlines } });
      }
      case 'list_emails': {
        const f = String(args.filter || 'all');
        let l = items.filter(i => f === 'unread' ? !i.seen : f === 'needs_reply' ? i.needsReply && !i.replied : f === 'important' ? PRI[i.base] <= 1 : true);
        if (args.category) { const c = String(args.category).toLowerCase(); l = l.filter(i => String(i.folder || 'Other').toLowerCase() === c); }
        if (args.query) { const q = String(args.query).toLowerCase(); l = l.filter(i => `${i.from} ${i.subject} ${i.summary}`.toLowerCase().includes(q)); }
        return res.json({ result: l.slice(0, Math.min(15, +args.limit || 8)).map(brief) });
      }
      case 'read_email': {
        const e = findEmail(items, args.id || args.query);
        if (!e) return res.json({ result: { error: 'No such email. Call list_emails first.' } });
        return res.json({ result: { ...brief(e), fromEmail: e.fromEmail, body: String(e.body || '').slice(0, 3000) } });
      }
      case 'draft_reply': {
        const e = findEmail(items, args.id || args.query);
        if (!e) return res.json({ result: { error: 'No such email. Call list_emails first.' } });
        if (!hasAI()) return res.json({ result: { error: 'AI is not configured on the server.' } });
        const text = await rewrite({ email: { fromName: e.from, fromEmail: e.fromEmail, subject: e.subject, body: e.body }, draft: '', instruction: String(args.instruction || 'Write a helpful, concise reply.').slice(0, 500), name: (u?.profile?.name || 'me').split(' ')[0] });
        let saved = null;
        try { saved = await saveDraft(u, e.id, text); } catch (err) { saved = { error: err.message }; }
        return res.json({ result: { id: e.id, draft: text, savedToDrafts: !!saved?.link, provider: saved?.provider, note: 'Draft only. Nothing was sent.' }, ui: { draftFor: e.id, draft: text, link: saved?.link } });
      }
      case 'remember': {
        const f = memory.addFact(args.fact, 'voice');
        return res.json({ result: f ? { remembered: f.text } : { error: 'Nothing to remember' }, ui: { memory: true } });
      }
      case 'recall': return res.json({ result: memory.recall(args.query) });
      default: return res.status(400).json({ result: { error: 'Unknown tool ' + name } });
    }
  } catch (e) { console.error('live tool', name, e.message); res.json({ result: { error: e.message } }); }
});
app.post('/api/live/summary', async (req, res) => {
  const t = String(req.body?.transcript || '').slice(0, 6000);
  if (t.length > 40 && hasAI()) { try { memory.addSummary(await summarize(t)); } catch (e) { console.error('summary:', e.message); } }
  res.json({ ok: true });
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
// Folders from "who are you and what do you want to track" (onboarding).
app.post('/api/categories/from-about', async (req, res) => {
  if (!limit('about:' + req.uid, 1500)) return res.status(429).json({ error: 'One moment…' });
  const cats = await suggestFromAbout({ about: String(req.body?.about || '').slice(0, 1500), name: String(req.body?.name || '').slice(0, 60) });
  res.json({ categories: cats, ai: hasAI() });
});
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
  console.log(`  Gmail:   ${google.configured() ? 'ready' : 'not configured'}   Outlook: ${microsoft.configured() ? 'ready' : 'not configured'}   AI: ${hasAI() ? aiProvider() + ' ready' : 'not configured'}${aiProvider() === 'gemini' ? '   Live voice: ready' : ''}${process.env.DEV_MOCK === '1' ? '   Mock provider: ON' : ''}\n`);
});
