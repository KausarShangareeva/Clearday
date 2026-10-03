// End-to-end check of the Board sorting model. Needs a server on PORT (default 3301) started with
//   DEV_MOCK=1 MOCK_COUNT=200 APP_URL=http://localhost:3301 PORT=3301 DATA_DIR=<tmp> node server/index.js
// and puppeteer-core (set PUPPETEER to its path).   Run: node tests/sorting-e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER || 'puppeteer-core');
const BASE = process.env.BASE || 'http://localhost:3301';
const SHOT = process.env.SHOT || '/tmp';
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log(cond ? 'PASS' : 'FAIL', msg); if (!cond) fails++; };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new', protocolTimeout: 900000 });
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('clearday:mode', JSON.stringify('live')); localStorage.setItem('clearday:liveProfile', JSON.stringify({ name: 'Alex', roles: ['Student', 'Founder'], focus: [], responsibilities: '', people: [], ignore: [], speed: 'Within a day', news: ['AI & technology'], about: 'Master student and founder' })); });
await page.goto(`${BASE}/auth/mock/start?slot=personal&email=t${Date.now()}@x.com`, { waitUntil: 'networkidle0' });
const sync = (boardCats = []) => page.evaluate(async bc => { const t = performance.now(); const r = await api('/api/sync', { method: 'POST', body: { profile: S.profile, boardCats: bc } }); return { ...r, ms: Math.round(performance.now() - t) }; }, boardCats);

// 1. first sign-in: the app runs the first 200-mail sync itself, then (no categories) routes to the "Who are you?" onboarding
const t0 = Date.now();
await page.evaluate(() => analyze());
for (let i = 0; i < 180 && !['onboarding', 'app'].includes(await page.evaluate(() => S.view)); i++) await wait(500);
console.log('first sync + analysis wall time ms', Date.now() - t0);
const gate0 = await page.evaluate(() => ({ view: S.view, cats: S.cats.length, mails: S.emails.length }));
ok(gate0.view === 'onboarding' && gate0.cats === 0, 'new live user with no categories goes to onboarding: ' + JSON.stringify(gate0));
ok(gate0.mails === 200, 'first sync loaded 200 mails');
await wait(1800);
let r = await sync([]);
ok(r.items.length === 200 && r.analysed === 0, 'immediate re-sync analyses nothing (snapshot reuse)');
ok(r.items.every(i => i.cat === 'Other'), 'with no categories every mail has category Other');
const codes = r.items.filter(i => /verification code|OTP|one-time|login code|security code|confirmation code/i.test(i.subject));
ok(codes.length > 5 && codes.every(i => i.cat === 'Other' && i.otherTag === 'Security codes'), `login-code mails (${codes.length}) are Other / Security codes`);

// 2. second sync: only new mail analysed, and fast
await wait(1800);
await page.evaluate(() => fetch('/api/dev/mock/add?n=4', { method: 'POST' }));
r = await sync([]);
console.log('second sync: analysed', r.analysed, 'fresh', r.stats.fresh, 'ms', r.ms, 'fetchMs', r.stats.fetchMs);
ok(r.stats.fresh === 4 && r.analysed <= 4 && r.ms < 8000, 'second sync analyses only the 4 new mails (promo/social ones use rules)');
await wait(1800);
r = await sync([]);
ok(r.analysed === 0, 'third sync analyses nothing');
console.log('no-change sync ms', r.ms);

// 3. onboarding gating: a live user without categories is sent to "Who are you?"
await wait(5500);
await page.reload({ waitUntil: 'networkidle0' });
for (let i = 0; i < 60 && (await page.evaluate(() => S.view)) === 'analyzing'; i++) await wait(500);
await wait(300);
const gate = await page.evaluate(() => ({ view: S.view, step: S.step, cats: S.cats.length }));
ok(gate.view === 'onboarding' && gate.cats === 0, 'user with no categories is routed to onboarding: ' + JSON.stringify(gate));
await page.screenshot({ path: `${SHOT}/sorting-onboarding.png` });

// 4. create categories through the onboarding commit, then check the board
await page.evaluate(() => { S.whoCats = [
  { name: 'Thesis', hint: 'Thesis supervision, university courses, exams, lab deadlines', icon: 'book', color: '#8B5CF6' },
  { name: 'Investors', hint: 'Investors, VCs and advisors: intro calls, decks, fundraising', icon: 'coin', color: '#0EA5A4' },
  { name: 'Bills', hint: 'Receipts, invoices, payments and bills', icon: 'tag', color: '#F59E0B' },
  { name: 'Friends & family', hint: 'Personal messages and plans with friends and family', icon: 'heart', color: '#F43F5E' }]; ACT.whoDone(); });
await wait(1500);
for (let i = 0; i < 90 && (await page.evaluate(() => S.view)) !== 'app'; i++) await wait(1000);
await wait(500);
const board = await page.evaluate(() => {
  const names = boardCats().map(c => c.name);
  const counts = Object.fromEntries(boardCats().map(c => [c.name, boardEmails(c.id).length]));
  const tiles = [...document.querySelectorAll('.board-grid .f-name')].map(e => e.textContent.trim());
  const codeIn = S.emails.filter(e => /verification code|OTP|one-time/i.test(e.subject)).map(e => [e.boardCat, e.otherTag]);
  const ids = S.emails.map(e => e.id);
  return { names, counts, tiles, total: S.emails.length, sum: Object.values(counts).reduce((a, b) => a + b, 0), uniq: new Set(ids).size, codeIn };
});
console.log('board', JSON.stringify(board.counts), 'total', board.total);
ok(!board.tiles.some(t => ['Personal', 'University', 'Startup', 'Work'].includes(t)), 'no Personal/University/Startup/Work inbox folders: ' + board.tiles.join(' | '));
ok(JSON.stringify(board.names.slice(-2)) === JSON.stringify(['Newsletters', 'Other']) && board.names.length === 6, 'folders = 4 user categories + Newsletters + Other');
ok(board.sum === board.total && board.uniq === board.total && board.total >= 200, `every mail in exactly one folder (sum ${board.sum} == total ${board.total})`);
ok(board.codeIn.length > 5 && board.codeIn.every(([c, t]) => c === 'other' && t === 'Security codes'), 'login-code mails sit in Other tagged Security codes');
ok(Object.entries(board.counts).filter(([k]) => !['Newsletters', 'Other'].includes(k)).some(([, n]) => n > 0), 'user categories received mail');
await page.screenshot({ path: `${SHOT}/sorting-board.png` });

// 5. open Other: tabs and tag chips
await page.evaluate(() => { S.boardOpen = 'other'; S.catTab = 'all'; render({ top: true, noFocus: true }); });
await wait(300);
const other = await page.evaluate(() => ({ chips: [...document.querySelectorAll('.other-tags .chip')].map(c => c.textContent.trim()), tabs: [...document.querySelectorAll('.cat-tabs button')].map(c => c.textContent.trim()), n: document.querySelectorAll('.letters > li').length }));
console.log('other view', JSON.stringify(other));
ok(other.chips.some(c => c.startsWith('Security codes')) && other.tabs.length === 2, 'Other shows tag chips and Needs attention/All tabs');
await page.evaluate(() => { ACT.otherTag({ dataset: { v: 'Security codes' } }); });
await wait(300);
const filt = await page.evaluate(() => [...document.querySelectorAll('.letters .l-subj')].map(e => e.textContent));
ok(filt.length > 5 && filt.every(t => /code|OTP|one-time|password|sign-in|login|Security|Apple ID/i.test(t)), `Security codes chip filters to code mails (${filt.length})`);
await page.screenshot({ path: `${SHOT}/sorting-other.png` });

// 6. categories change -> regroup
const before = board.counts;
await page.evaluate(async () => { S.cats = S.cats.filter(c => c.name !== 'Bills'); saveCats(); S.otherTag = 'all'; S.boardOpen = null; });
await wait(1800);
await page.evaluate(() => liveSync({ quiet: true }));
const after = await page.evaluate(() => ({ counts: Object.fromEntries(boardCats().map(c => [c.name, boardEmails(c.id).length])), total: S.emails.length }));
console.log('after removing Bills', JSON.stringify(after.counts));
ok(!('Bills' in after.counts) && Object.values(after.counts).reduce((a, b) => a + b, 0) === after.total, 'removing a category regroups its mail, still exactly one folder each');
ok(after.counts.Other >= before.Other, 'Bills mail moved to Other/Newsletters');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await browser.close();
process.exit(fails ? 1 : 0);
