// Unit tests for server/condense.js against a local fake Condense API. Run: node test/condense.test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.SESSION_SECRET = 'x'.repeat(32);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-'));
process.env.CONDENSE_API_KEY = 'ck_api_test';

let mode = 'ok', hits = 0, lastBody = null, lastHeaders = null;
// the fake "compressor": drops filler words; mode 'lossy' also drops weekday + 'no longer'; 'dropdate' drops dates/amounts
const FILLER = /\b(the|a|an|really|very|just|that|is|are|to|of|and|so|quite|please|kindly)\b\s*/gi;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
    hits++; lastHeaders = req.headers; lastBody = JSON.parse(b || '{}');
    if (mode === '401') { res.statusCode = 401; return res.end('{}'); }
    if (mode === '403') { res.statusCode = 403; return res.end('{}'); }
    if (mode === '429') { res.statusCode = 429; res.setHeader('Retry-After', '2'); return res.end('{}'); }
    if (mode === '500') { res.statusCode = 500; return res.end('{}'); }
    const rate = lastBody.compression_rate;
    const messages = lastBody.messages.map(m => {
      let c = m.content.replace(FILLER, '');
      if (mode === 'lossy' && rate >= 0.5) c = c.replace(/\b(Thursday|no longer|\d{4}-\d{2}-\d{2}|49 EUR)\b\s*/g, ''); // lossy only at the aggressive rate; half rate is clean
      if (mode === 'alwayslossy') c = c.replace(/\b(Thursday|no longer|\d{4}-\d{2}-\d{2}|49 EUR)\b\s*/g, '');
      if (mode === 'longer') c = c + ' ' + c;
      return { role: m.role, content: c };
    });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: lastBody.model, messages }));
  });
});
await new Promise(r => server.listen(0, r));
process.env.CONDENSE_API_URL = `http://127.0.0.1:${server.address().port}/v1/compress`;

const C = await import('../server/condense.js');
let n = 0; const ok = (name) => console.log('  ok', ++n, name);

const long = 'Hello, this is really just a very long message that you should please read. '.repeat(6)
  + 'The meeting is on Thursday 2026-10-08 at 10:00 in room D2, and the fee is 49 EUR. Invoice #INV-4821. The offer is no longer available. Contact anna@x.com or +46 70 123 45 67.';

// --- facts
const facts = C.extractFacts(long);
const types = new Set(facts.map(f => f.type));
for (const t of ['weekday', 'date', 'time', 'amount', 'email', 'phone', 'id', 'negation']) assert(types.has(t), 'fact type ' + t);
ok('extractFacts finds dates, weekdays, times, amounts, emails, phones, ids, negations');
assert(C.checkFacts(facts, long).every(f => f.kept)); ok('original keeps all its own facts');

// --- happy path, ledger math, header/body contract
const u = { settings: {} };
let r = (await C.compress([{ text: long, kind: 'newsletter' }], u))[0];
assert.equal(r.action, 'compressed'); assert(r.outT < r.inT); assert(r.text.includes('Thursday') && r.text.includes('no longer'));
assert.equal(lastHeaders['x-condense-auth-token'], 'ck_api_test'); assert.equal(lastBody.model, 'helene-1'); assert.equal(lastBody.compression_rate, 0.6);
assert.equal(lastBody.messages[0].role, 'user');
ok('compress ok, auth header + model + bulk rate 0.6 sent');
assert.equal(u.condense.calls, 1); assert.equal(u.condense.inTokens, r.inT); assert.equal(u.condense.outTokens, r.outT);
assert.equal(u.condense.saved, r.inT - r.outT); assert.equal(u.condense.byKind.newsletter.in, r.inT);
ok('ledger math');
const s = C.summary(u).ledger; assert.equal(s.pctSaved, Math.round(1000 * (r.inT - r.outT) / r.inT) / 10);
assert(s.estUsdSaved > 0); ok('summary pct + estimated USD');

// --- cache
const before = hits;
r = (await C.compress([{ text: long, kind: 'newsletter' }], u))[0];
assert.equal(hits, before); assert.equal(r.action, 'cached'); assert.equal(u.condense.cacheHits, 1);
ok('LRU cache: no second API call');

// --- short text skipped
r = (await C.compress([{ text: 'Lunch tomorrow at 12?', kind: 'personal' }], u))[0];
assert.equal(r.action, 'skipped'); assert.equal(hits, before); ok('short text skipped (<400 chars)');

// --- guard: lossy at full rate -> retry at half rate succeeds
C._reset(); mode = 'lossy';
const u2 = { settings: {} };
r = (await C.compress([{ text: long, kind: 'newsletter' }], u2))[0];
assert.equal(r.action, 'retried'); assert(r.text.includes('Thursday') && r.text.includes('2026-10-08') && r.text.includes('no longer'));
assert.equal(r.rate, 0.3); assert.equal(u2.condense.guardRejects, 1); assert(r.rawLost.length >= 2);
ok('guard: dropped weekday/date/negation -> retried at half rate (0.3), facts intact, guardReject counted');

// --- guard: always lossy -> fallback to original
C._reset(); mode = 'alwayslossy';
const u3 = { settings: {} };
const dense = 'The meeting on Thursday is at 10:00 and costs 49 EUR, it is really very important. '.repeat(8) + 'The offer is no longer available.';
r = (await C.compress([{ text: dense, kind: 'personal' }], u3))[0];
assert.equal(r.action, 'fallback'); assert.equal(r.text, dense); assert.equal(u3.condense.fallbacks, 1); assert.equal(u3.condense.guardRejects, 1);
assert.equal(u3.condense.saved, 0); assert(r.lost.length);
ok('guard: fact-dense text that stays lossy after retry+salvage -> ORIGINAL text returned');
C._reset(); const u3b = { settings: {} };
r = (await C.compress([{ text: long, kind: 'personal' }], u3b))[0];
assert.equal(r.action, 'salvaged'); assert(r.outT < r.inT); assert(C.checkFacts(C.extractFacts(long), r.text).every(f => f.kept));
ok('guard: lossy compressor on mixed text -> SALVAGED (fact sentences verbatim, only fact-free prose compressed), facts intact, still saves tokens');

// --- never longer
C._reset(); mode = 'longer';
r = (await C.compress([{ text: long, kind: 'newsletter' }], { settings: {} }))[0];
assert.equal(r.text, long); assert.equal(r.action, 'fallback'); ok('output longer than input -> original');

// --- 401 / 403 => no_access, stop calling
for (const m of ['401', '403']) {
  C._reset(); mode = m; const h0 = hits;
  r = (await C.compress([{ text: long, kind: 'newsletter' }], { settings: {} }))[0];
  assert.equal(r.text, long); assert.equal(C.globalStatus(), 'no_access');
  const h1 = hits; await C.compress([{ text: long + m, kind: 'newsletter' }], { settings: {} });
  assert.equal(hits, h1, 'no further calls after ' + m); assert(h1 > h0);
}
ok('401/403 -> status no_access, original returned, calls stop');

// --- 429 honours Retry-After
C._reset(); mode = '429';
r = (await C.compress([{ text: long, kind: 'newsletter' }], { settings: {} }))[0];
assert.equal(r.text, long); assert.equal(C.globalStatus(), 'paused'); assert(C.health().pausedForMs > 1000 && C.health().pausedForMs <= 2000);
ok('429 -> paused for Retry-After (2s), original returned');

// --- circuit breaker: 3 consecutive failures -> pause 60s
C._reset(); mode = '500'; const hb = hits;
for (let i = 0; i < 4; i++) await C.compress([{ text: long + i, kind: 'newsletter' }], { settings: {} });
assert.equal(hits - hb, 3); assert.equal(C.globalStatus(), 'paused'); assert(C.health().pausedForMs > 50000);
ok('circuit breaker opens after 3 failures (4th call never leaves the process), pause ~60s');

// --- per-user opt out + no key + disabled
C._reset(); mode = 'ok'; const hc = hits;
r = (await C.compress([{ text: long + 'x', kind: 'newsletter' }], { settings: { condense: false } }))[0];
assert.equal(r.text, long + 'x'); assert.equal(hits, hc); assert.equal(r.action, 'off'); ok('per-user toggle off -> pass-through');
process.env.CONDENSE_DISABLED = '1'; assert.equal(C.globalStatus(), 'disabled'); delete process.env.CONDENSE_DISABLED;
const k = process.env.CONDENSE_API_KEY; delete process.env.CONDENSE_API_KEY; assert.equal(C.globalStatus(), 'no_key');
r = (await C.compress([{ text: long, kind: 'newsletter' }], null))[0]; assert.equal(r.text, long); process.env.CONDENSE_API_KEY = k;
ok('CONDENSE_DISABLED / no key -> pass-through with status');

// --- kind heuristic
assert.equal(C.kindOf({ listUnsubscribe: true, subject: 'weekly', body: '' }), 'newsletter');
assert.equal(C.kindOf({ listUnsubscribe: true, subject: '50% off', body: '' }), 'promo');
assert.equal(C.kindOf({ fromEmail: 'anna@gmail.com', subject: 'hi', body: 'dinner?' }), 'personal');
ok('kindOf heuristics');

server.close(); console.log(`\nall ${n} condense checks passed`); process.exit(0);
