// Assistant memory, stored per user inside that user's record (DATA_DIR/db.json).
// Holds: facts the user told us, sender preferences, conversation summaries and the spam digest.
// Only short text snippets from here are ever put into Gemini prompts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { save } from './store.js';

const MAX_FACTS = 200, MAX_SUMMARIES = 30, MAX_SPAM = 150, SPAM_TTL = 30 * 24 * 3600e3;
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const noUrls = s => String(s || '').replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link removed]');

// One-time upgrade: the old single-user build kept memory in DATA_DIR/memory.json. The first user to
// open the app after upgrading inherits it; it is never shared with anyone else.
let legacy;
function legacyMemory() {
  if (legacy !== undefined) return legacy;
  try { legacy = JSON.parse(fs.readFileSync(path.join(path.resolve(process.env.DATA_DIR || './data'), 'memory.json'), 'utf8')); } catch { legacy = null; }
  return legacy;
}

export function mem(u) {
  if (!u.memory) {
    const l = legacyMemory();
    u.memory = { facts: l?.facts || [], senders: l?.senders || {}, summaries: l?.summaries || [], spam: [] };
    legacy = null; // hand the old data to one user only
  }
  u.memory.spam ||= [];
  return u.memory;
}

export const listMemory = u => { const m = mem(u); return { facts: m.facts, senders: m.senders, summaries: m.summaries, spamCount: m.spam.length }; };

export function addFact(u, text, source = 'user') {
  const m = mem(u), t = clean(text, 300);
  if (!t) return null;
  const dup = m.facts.find(f => f.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  const f = { id: crypto.randomUUID().slice(0, 8), text: t, source, createdAt: Date.now() };
  m.facts.push(f);
  if (m.facts.length > MAX_FACTS) m.facts.shift();
  save();
  return f;
}

// Remember how the user wants a given sender treated (e.g. from a priority correction).
export function setSender(u, email, note, priority) {
  const m = mem(u), k = clean(email, 120).toLowerCase();
  if (!k) return;
  m.senders[k] = { note: clean(note, 200), priority: priority || m.senders[k]?.priority || null, updatedAt: Date.now() };
  save();
}

export function addSummary(u, text) {
  const m = mem(u), t = clean(text, 600);
  if (!t) return;
  m.summaries.push({ date: new Date().toISOString().slice(0, 10), text: t });
  if (m.summaries.length > MAX_SUMMARIES) m.summaries.shift();
  save();
}

export function removeItem(u, id) {
  const m = mem(u);
  m.facts = m.facts.filter(f => f.id !== id);
  if (m.senders[id]) delete m.senders[id];
  m.summaries = m.summaries.filter(s => `${s.date}:${s.text.slice(0, 12)}` !== id);
  save();
}

export function clearMemory(u) { u.memory = { facts: [], senders: {}, summaries: [], spam: [] }; save(); }

// ---- spam digest (compact, link-free, never full bodies) ----
export function knownSpamIds(u) { return new Set(mem(u).spam.map(s => s.id)); }
export function addSpam(u, entries) {
  const m = mem(u), now = Date.now();
  for (const e of entries) {
    if (m.spam.some(s => s.id === e.id)) continue;
    m.spam.push({ id: e.id, slot: e.slot, from: clean(e.from, 80), fromEmail: clean(e.fromEmail, 120), subject: clean(noUrls(e.subject), 140), date: e.date, gist: clean(noUrls(e.gist), 240), type: e.type || 'unknown', important: !!e.important, facts: clean(noUrls(e.facts), 200), link: e.link || '', addedAt: now });
  }
  m.spam = m.spam.filter(s => now - s.addedAt < SPAM_TTL).sort((a, b) => b.addedAt - a.addedAt).slice(0, MAX_SPAM);
  save();
}
export const listSpam = u => mem(u).spam;
export const importantSpam = u => mem(u).spam.filter(s => s.important);
export function removeSpam(u, id) { const m = mem(u); m.spam = m.spam.filter(s => s.id !== id); save(); }
export function clearSpam(u) { mem(u).spam = []; save(); }
export function searchSpam(u, query, limit = 8) {
  const words = clean(query, 200).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const all = mem(u).spam;
  const scored = all.map(s => {
    const hay = `${s.from} ${s.fromEmail} ${s.subject} ${s.gist} ${s.facts}`.toLowerCase();
    return { s, n: words.filter(w => hay.includes(w)).length + (s.important ? 0.5 : 0) };
  }).filter(x => !words.length || x.n >= 1).sort((a, b) => b.n - a.n);
  return scored.slice(0, limit).map(x => x.s);
}

// Simple keyword recall so a tool call can ask "what do I know about Anna?".
export function recall(u, query) {
  const m = mem(u);
  const words = clean(query, 200).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const hit = text => !words.length || words.some(w => text.toLowerCase().includes(w));
  return {
    facts: m.facts.filter(f => hit(f.text)).map(f => f.text).slice(-20),
    senders: Object.entries(m.senders).filter(([e, v]) => hit(`${e} ${v.note}`)).map(([e, v]) => ({ email: e, ...v })).slice(0, 20),
    summaries: m.summaries.filter(s => hit(s.text)).slice(-5),
    spam: words.length ? searchSpam(u, query, 5).map(s => ({ from: s.from, subject: s.subject, gist: s.gist, folder: 'spam' })) : [],
  };
}

// Compact text block added to Gemini prompts (spam excluded: only on demand).
export function promptBlock(u) {
  const m = mem(u), lines = [];
  if (m.facts.length) lines.push('Things the user told me to remember:', ...m.facts.slice(-40).map(f => `- ${f.text}`));
  const s = Object.entries(m.senders);
  if (s.length) lines.push('Sender preferences:', ...s.slice(-30).map(([e, v]) => `- ${e}: ${v.priority ? `treat as ${v.priority}. ` : ''}${v.note}`));
  if (m.summaries.length) lines.push('Recent conversations:', ...m.summaries.slice(-3).map(x => `- ${x.date}: ${x.text}`));
  return lines.join('\n');
}

// Spam digest for chat/voice answers. Treated as untrusted data by the prompts that include it.
export function spamDigest(u, question, limit = 10) {
  const hits = searchSpam(u, question, limit), seen = new Set(hits.map(h => h.id));
  const extra = importantSpam(u).filter(s => !seen.has(s.id)).slice(0, 4);
  return [...hits, ...extra].slice(0, limit).map(s => ({ id: s.id, from: s.from, subject: s.subject, received: s.date?.slice(0, 10), gist: s.gist, looks: s.type, mayBeLegit: s.important }));
}
