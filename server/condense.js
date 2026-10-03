// Condense integration (https://condense.chat): compresses mail text BEFORE it is sent to the LLM.
//
// Why it is safe to use on email: Condense prunes tokens, and pruning can drop facts ("Thursday",
// "no longer available"). So every compression goes through a FIDELITY GUARD: protected facts (dates, times,
// amounts, ids, codes, contacts, negations) are extracted from the original and verified in the output. If any
// is lost we retry at half the rate, then fall back to the original text. Condense can never make an answer worse
// silently, and it can never block or fail a sync/chat: every failure path returns the original text.
//
// Self-contained. Per-user numbers live on `u.condense` (the ledger), totals in the global store.
import crypto from 'node:crypto';
import { save, getGlobal } from './store.js';

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
export const estTokens = s => Math.ceil(String(s || '').length / 4); // chars/4, used everywhere so numbers are consistent

// ---------- policy ----------
const BULK = new Set(['newsletter', 'promo', 'social', 'notice', 'spam']);
export const policy = () => ({
  minChars: num('CONDENSE_MIN_CHARS', 400),
  rates: {
    bulk: num('CONDENSE_RATE_BULK', 0.6),       // newsletters, promos, social, notices, spam
    receipt: num('CONDENSE_RATE_RECEIPT', 0.4), // receipts and invoices
    personal: num('CONDENSE_RATE_PERSONAL', 0.25), // people, alerts, events: conservative
    chat: num('CONDENSE_RATE_CHAT', 0.5),       // older chat turns
  },
  never: ['system prompts', 'JSON schemas', 'the current question', 'drafts you wrote'],
});
const bucketOf = kind => (BULK.has(kind) ? 'bulk' : kind === 'receipt' ? 'receipt' : kind === 'chat' ? 'chat' : 'personal');
export const rateFor = kind => policy().rates[bucketOf(kind)];

// Cheap rules run BEFORE the model, so we know how aggressively an email may be compressed.
export function kindOf(e = {}) {
  if (e.kind) return e.kind;
  const from = String(e.fromEmail || ''), head = `${e.subject || ''} ${String(e.body || '').slice(0, 600)}`;
  if (e.providerCategory === 'promotions') return 'promo';
  if (e.providerCategory === 'social') return 'social';
  if (e.listUnsubscribe) return /% off|sale|deal|discount|offer|coupon/i.test(head) ? 'promo' : 'newsletter';
  if (/% off|discount code|limited time|unsubscribe/i.test(head)) return 'promo';
  if (/invoice|receipt|order (?:confirmation|#)|payment received/i.test(head)) return 'receipt';
  if (/sign-?in|password|verification code|security alert/i.test(head)) return 'alert';
  if (/no-?reply|notifications?@|mailer|newsletter|news@|updates?@|marketing/i.test(from)) return 'notice';
  return 'personal';
}

// ---------- fidelity guard ----------
const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const NEG = "no longer|cancell?ed|not|cannot|can't|won't|don't|doesn't|isn't|never|unless|postponed|rescheduled|instead";
const norm = s => String(s).toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
const digitsOnly = s => String(s).replace(/\D/g, '');

export function extractFacts(text) {
  const t = String(text || '').replace(/[’]/g, "'");
  const facts = new Map();
  const add = (type, v) => { v = String(v).trim().replace(/[.,;:]+$/, ''); if (v) facts.set(type + '|' + norm(v), { type, value: v }); };
  const all = (re, type, fn) => { for (const m of t.matchAll(re)) add(type, fn ? fn(m) : m[0]); };
  all(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, 'email');
  all(/\b\d{4}-\d{2}-\d{2}\b/g, 'date');
  all(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, 'date');
  all(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'), 'date');
  all(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b`, 'gi'), 'date');
  all(new RegExp(`\\b(?:${DAYS})\\b`, 'gi'), 'weekday');
  all(/\b\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?|\b\d{1,2}\s?[ap]m\b/gi, 'time');
  all(/[$€£]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:EUR|USD|SEK|GBP|NOK|DKK|kr|€|\$|£)(?![A-Za-z])/gi, 'amount');
  all(/\+\d[\d\s().-]{7,}\d|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g, 'phone');
  all(/(?:#|\b(?:invoice|order|ref(?:erence)?|booking|ticket|confirmation|tracking)\s*(?:no\.?|number|id)?[\s:#-]*)([A-Z0-9][A-Z0-9-]{3,})/gi, 'id', m => m[1]);
  all(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{4,}\b/g, 'code');
  const known = [...facts.values()].map(f => norm(f.value));
  for (const m of t.matchAll(/\b\d{3,}\b/g)) if (!known.some(k => k.includes(m[0]))) add('number', m[0]);
  const negs = new Map();
  for (const m of t.matchAll(new RegExp(`\\b(${NEG})\\b`, 'gi'))) negs.set(m[1].toLowerCase(), (negs.get(m[1].toLowerCase()) || 0) + 1);
  for (const [v, n] of negs) facts.set('negation|' + v, { type: 'negation', value: v, need: Math.min(n, 2) });
  return [...facts.values()];
}
const countOf = (hay, needle) => (hay.match(new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length;
export function checkFacts(facts, compressed) {
  const c = norm(compressed), cd = digitsOnly(compressed);
  return facts.map(f => {
    const kept = f.type === 'negation' ? countOf(c, f.value) >= f.need
      : f.type === 'phone' ? cd.includes(digitsOnly(f.value))
      : c.includes(norm(f.value));
    return { type: f.type, value: f.value, kept };
  });
}

// ---------- state, resilience ----------
const S = { failures: 0, pausedUntil: 0, noAccessUntil: 0, lastError: '', inflight: 0, queue: [] };
const cache = new Map(); // LRU: sha1(model|rate|text) -> compressed text
const CACHE_MAX = 800;
const key = (model, rate, text) => crypto.createHash('sha1').update(`${model}|${rate ?? ''}|${text}`).digest('hex');
const cacheGet = k => { const v = cache.get(k); if (v !== undefined) { cache.delete(k); cache.set(k, v); } return v; };
const cacheSet = (k, v) => { cache.set(k, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

const hasKey = () => !!env('CONDENSE_API_KEY', '');
const apiUrl = () => env('CONDENSE_API_URL', 'https://api.condense.chat/v1/compress');
export const globalStatus = () => {
  if (env('CONDENSE_DISABLED', '') === '1') return 'disabled';
  if (!hasKey()) return 'no_key';
  const now = Date.now();
  if (S.noAccessUntil > now) return 'no_access';
  if (S.pausedUntil > now) return 'paused';
  return 'active';
};
// Status as one user sees it (their own toggle wins).
export const statusFor = u => (globalStatus() === 'active' && u?.settings?.condense === false ? 'off' : globalStatus());
export const isEnabled = u => u?.settings?.condense !== false;
export const health = () => ({ status: globalStatus(), model: env('CONDENSE_MODEL', 'helene-1'), consecutiveFailures: S.failures, pausedForMs: Math.max(0, S.pausedUntil - Date.now()), lastError: S.lastError || null, cacheEntries: cache.size });
export function _reset() { S.failures = 0; S.pausedUntil = 0; S.noAccessUntil = 0; S.lastError = ''; cache.clear(); }

const slot = async () => {
  const max = num('CONDENSE_CONCURRENCY', 4);
  if (S.inflight >= max) await new Promise(r => S.queue.push(r));
  S.inflight++;
};
const release = () => { S.inflight--; S.queue.shift()?.(); };

// One /v1/compress request. Resolves to an array of strings (same order) or throws {kind}.
async function callAPI(model, rate, texts) {
  await slot();
  try {
    const body = { model, messages: texts.map(content => ({ role: 'user', content })) };
    if (model === 'helene-1' && rate != null) body.compression_rate = rate;
    let r;
    try {
      r = await fetch(apiUrl(), { method: 'POST', headers: { 'X-Condense-Auth-Token': env('CONDENSE_API_KEY', ''), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(num('CONDENSE_TIMEOUT_MS', 6000)) });
    } catch (e) { throw Object.assign(new Error(e.name === 'TimeoutError' ? 'timeout' : e.message), { kind: 'net' }); }
    if (r.status === 401 || r.status === 403) { S.noAccessUntil = Date.now() + 30 * 60e3; S.lastError = r.status === 401 ? 'API key rejected' : 'Account lacks the compress capability'; throw Object.assign(new Error(S.lastError), { kind: 'no_access' }); }
    if (r.status === 429) {
      const ra = Math.min(120, Math.max(1, parseFloat(r.headers.get('retry-after')) || 10));
      S.pausedUntil = Date.now() + ra * 1000; S.lastError = `rate limited, retry in ${ra}s`;
      throw Object.assign(new Error(S.lastError), { kind: 'rate' });
    }
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { kind: 'http' });
    const j = await r.json().catch(() => null);
    const out = (j?.messages || []).map(m => m?.content);
    if (out.length !== texts.length || out.some(x => typeof x !== 'string')) throw Object.assign(new Error('bad response shape'), { kind: 'http' });
    S.failures = 0;
    return out;
  } catch (e) {
    if (e.kind === 'net' || e.kind === 'http') {
      S.lastError = e.message;
      if (++S.failures >= 3) { S.pausedUntil = Date.now() + 60e3; S.failures = 0; }
    }
    throw e;
  } finally { release(); }
}

// ---------- ledger ----------
function ledger(u) {
  return (u.condense ||= { since: Date.now(), calls: 0, cacheHits: 0, inTokens: 0, outTokens: 0, saved: 0, byKind: {}, fallbacks: 0, guardRejects: 0, lastStatus: 'active', llmCalls: 0, llmPromptTokens: 0 });
}
const gledger = () => { const g = getGlobal(); return (g.condense ||= { since: Date.now(), calls: 0, cacheHits: 0, inTokens: 0, outTokens: 0, saved: 0, fallbacks: 0, guardRejects: 0, llmCalls: 0, llmPromptTokens: 0 }); };
function recordLedger(u, kind, inT, outT, o = {}) {
  for (const L of [u && ledger(u), gledger()].filter(Boolean)) {
    L.calls += o.cached ? 0 : 1; L.cacheHits += o.cached ? 1 : 0;
    L.inTokens += inT; L.outTokens += outT; L.saved += Math.max(0, inT - outT);
    if (o.fallback) L.fallbacks++; if (o.guardReject) L.guardRejects++;
    if (L.byKind) { const k = (L.byKind[kind] ||= { calls: 0, in: 0, out: 0 }); k.calls++; k.in += inT; k.out += outT; }
    L.lastStatus = globalStatus();
  }
  save();
}
// Real prompt tokens as reported by the LLM (Gemini usageMetadata), for honest before/after numbers.
export function noteLLM(u, promptTokens) {
  const n = +promptTokens; if (!n) return;
  for (const L of [u && ledger(u), gledger()].filter(Boolean)) { L.llmCalls++; L.llmPromptTokens += n; }
  save();
}
export const moneyPerMTok = () => num('LLM_PRICE_PER_MTOK_IN', 0.30);
export function summary(u) {
  const L = u?.condense || null, G = gledger();
  const wrap = x => x && { ...x, pctSaved: x.inTokens ? Math.round(1000 * x.saved / x.inTokens) / 10 : 0, estUsdSaved: +(x.saved * moneyPerMTok() / 1e6).toFixed(6) };
  return { ledger: wrap(L), global: wrap(G), usdPerMTokIn: moneyPerMTok(), usdLabel: 'estimate: tokens saved x LLM input price' };
}

// ---------- core ----------
// items: [{text, kind, rate?, model?}] -> [{text, inT, outT, action, ...}]. NEVER throws; failure returns the original.
// action: skipped | compressed | cached | retried | fallback | unavailable
export async function compress(items, u = null, opts = {}) {
  const out = items.map(it => ({ text: String(it.text ?? ''), inT: estTokens(it.text), outT: estTokens(it.text), action: 'skipped', facts: null, lost: [] }));
  try {
    const st = opts.preview ? globalStatus() : statusFor(u);
    const record = opts.preview ? () => {} : recordLedger; // the live demo never touches the ledger
    const minChars = opts.minChars ?? policy().minChars;
    const work = [];
    items.forEach((it, i) => {
      const text = out[i].text;
      if (st !== 'active' || !text || text.length < minChars) { out[i].action = st === 'active' ? 'skipped' : st; return; }
      const kind = it.kind || 'personal';
      const model = it.model || env('CONDENSE_MODEL', 'helene-1');
      const rate = model === 'helene-1' ? (it.rate ?? rateFor(kind)) : null;
      work.push({ i, text, kind, model, rate, facts: extractFacts(text) });
    });
    // one request per (model, rate): each message is compressed independently, so batching is lossless
    const groups = new Map();
    for (const w of work) { const g = `${w.model}|${w.rate}`; (groups.get(g) || groups.set(g, []).get(g)).push(w); }
    await Promise.all([...groups.values()].flatMap(ws => {
      const chunks = []; for (let k = 0; k < ws.length; k += 8) chunks.push(ws.slice(k, k + 8));
      return chunks.map(async chunk => {
        const fresh = chunk.filter(w => cacheGet(key(w.model, w.rate, w.text)) === undefined);
        let batchErr = null;
        if (fresh.length) {
          try { (await callAPI(chunk[0].model, chunk[0].rate, fresh.map(w => w.text))).forEach((c, n) => cacheSet(key(fresh[n].model, fresh[n].rate, fresh[n].text), c)); }
          catch (e) { batchErr = e; }
        }
        for (const w of chunk) {
          const o = out[w.i], k0 = key(w.model, w.rate, w.text);
          const wasCached = !fresh.includes(w);
          let cand = cacheGet(k0);
          if (cand === undefined) { o.action = 'unavailable'; o.error = batchErr?.message; record(u, w.kind, o.inT, o.inT, { fallback: true }); continue; }
          o.raw = cand; o.rawLost = checkFacts(w.facts, cand).filter(f => !f.kept);
          let guard = checkFacts(w.facts, cand), action = wasCached ? 'cached' : 'compressed', rejected = false;
          const bad = (c, g = guard) => !c.trim() || estTokens(c) >= o.inT || g.some(f => !f.kept);
          if (bad(cand) && w.model === 'helene-1' && w.rate > 0.05) {
            rejected = true;
            const r2 = w.rate / 2, k2 = key(w.model, r2, w.text);
            let c2 = cacheGet(k2);
            if (c2 === undefined) { try { c2 = (await callAPI(w.model, r2, [w.text]))[0]; cacheSet(k2, c2); } catch { c2 = undefined; } }
            if (c2 !== undefined) { cand = c2; guard = checkFacts(w.facts, c2); action = 'retried'; }
          }
          if (bad(cand)) { // stage 3: fact-aware salvage. Sentences holding a protected fact stay verbatim, only fact-free runs are compressed
            const sv = await salvage(w).catch(() => null);
            if (sv && !bad(sv, checkFacts(w.facts, sv))) { cand = sv; guard = checkFacts(w.facts, sv); action = 'salvaged'; }
          }
          if (bad(cand)) { // fall back to the original text, never ship a lossy version
            Object.assign(o, { text: w.text, outT: o.inT, action: 'fallback', facts: guard, lost: guard.filter(f => !f.kept), rate: w.rate });
            record(u, w.kind, o.inT, o.inT, { fallback: true, guardReject: true });
          } else {
            Object.assign(o, { text: cand, outT: estTokens(cand), action, facts: guard, lost: [], rate: action === 'retried' ? w.rate / 2 : w.rate });
            record(u, w.kind, o.inT, o.outT, { cached: wasCached && action !== 'retried', guardReject: rejected });
          }
          o.model = w.model; o.kind = w.kind;
        }
      });
    }));
  } catch (e) { console.error('condense:', e.message); }
  return out;
}

// Stage 3 of the guard. Sentences that carry a protected fact stay verbatim; only runs of fact-free prose are sent to
// Condense (each message is compressed independently, so the facts are safe by construction).
async function salvage(w) {
  const segs = w.text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)\s*/g) || [];
  const runs = []; let cur = null;
  segs.forEach((sg, i) => {
    if (extractFacts(sg).length) { cur = null; return; }
    if (!cur) runs.push(cur = { from: i, parts: [] });
    cur.parts.push(sg);
  });
  const big = runs.filter(r => r.parts.join('').length >= 150);
  if (!big.length) return null;
  const texts = big.map(r => r.parts.join(''));
  const missing = [...new Set(texts.filter(t => cacheGet(key(w.model, w.rate, t)) === undefined))];
  if (missing.length) (await callAPI(w.model, w.rate, missing)).forEach((c, n) => cacheSet(key(w.model, w.rate, missing[n]), c));
  const rebuilt = segs.slice();
  big.forEach((r, n) => { const c = cacheGet(key(w.model, w.rate, texts[n])); r.parts.forEach((_, k) => { rebuilt[r.from + k] = k ? '' : c.trimEnd() + ' '; }); });
  return rebuilt.join('').trim();
}

// ---------- helpers the AI layer calls (all return plain strings, all fail open) ----------
// Mail bodies for the classifier: clip first, then compress by heuristic kind.
export async function mails(emails, u, clipTo = 3500) {
  const clipped = emails.map(e => { const b = String(e.body || ''); return b.length > clipTo ? b.slice(0, clipTo) + '\n[…truncated]' : b; });
  const r = await compress(emails.map((e, i) => ({ text: clipped[i], kind: kindOf(e) })), u);
  return r.map(x => x.text);
}
// Older chat turns (everything except the last `keep`) are compressed; the newest turns and the question never are.
export async function history(turns, u, keep = 2) {
  const old = turns.slice(0, Math.max(0, turns.length - keep));
  if (!old.length) return turns;
  const total = old.reduce((n, m) => n + String(m.text).length, 0);
  const r = await compress(old.map(m => ({ text: String(m.text), kind: 'chat', model: total > 8000 ? env('CONDENSE_HISTORY_MODEL', 'adeline-1') : undefined })), u);
  return [...old.map((m, i) => ({ ...m, text: r[i].text })), ...turns.slice(old.length)];
}
// Email context for the assistant: compress long `body` fields.
export async function context(items, u) {
  const idx = items.map((it, i) => (typeof it?.body === 'string' && it.body.length >= policy().minChars ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return items;
  const r = await compress(idx.map(i => ({ text: items[i].body, kind: kindOf(items[i]) })), u);
  const copy = items.slice(); idx.forEach((i, n) => { copy[i] = { ...items[i], body: r[n].text }; });
  return copy;
}
export async function one(text, kind, u) { return (await compress([{ text, kind }], u))[0].text; }

// ---------- live preview (powers the "See it work" demo) ----------
export async function preview(text, kind, u, rateOverride) {
  const t = String(text || '').slice(0, 6000), facts = extractFacts(t);
  const res = (await compress([{ text: t, kind, rate: rateOverride }], u, { preview: true, minChars: 0 }))[0];
  const checked = checkFacts(facts, res.text);
  return {
    status: globalStatus(), kind, model: res.model || env('CONDENSE_MODEL', 'helene-1'), rate: res.rate ?? rateOverride ?? rateFor(kind), action: res.action,
    original: t, condensed: res.text, inTokens: res.inT, outTokens: res.outT, saved: Math.max(0, res.inT - res.outT),
    pctSaved: res.inT ? Math.round(1000 * (res.inT - res.outT) / res.inT) / 10 : 0,
    guard: { checked: checked.slice(0, 60), total: checked.length, kept: checked.filter(f => f.kept).length, lost: res.lost, rawLost: res.rawLost || [], rawCondensed: res.raw ?? null, rejectedRaw: !!(res.rawLost && res.rawLost.length) },
  };
}
