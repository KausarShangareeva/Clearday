// Local assistant memory: a plain JSON file on this machine (DATA_DIR/memory.json).
// Nothing here is synced anywhere; only the short promptBlock() text is included in Gemini prompts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const FILE = path.join(DATA_DIR, 'memory.json');
const MAX_FACTS = 200, MAX_SUMMARIES = 30;

let mem = { facts: [], senders: {}, summaries: [] };
try { mem = { ...mem, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(mem, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 100);
}

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export const listMemory = () => ({ facts: mem.facts, senders: mem.senders, summaries: mem.summaries });

export function addFact(text, source = 'user') {
  const t = clean(text, 300);
  if (!t) return null;
  const dup = mem.facts.find(f => f.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  const f = { id: crypto.randomUUID().slice(0, 8), text: t, source, createdAt: Date.now() };
  mem.facts.push(f);
  if (mem.facts.length > MAX_FACTS) mem.facts.shift();
  persist();
  return f;
}

// Remember how the user wants a given sender treated (e.g. from a priority correction).
export function setSender(email, note, priority) {
  const k = clean(email, 120).toLowerCase();
  if (!k) return;
  mem.senders[k] = { note: clean(note, 200), priority: priority || mem.senders[k]?.priority || null, updatedAt: Date.now() };
  persist();
}

export function addSummary(text) {
  const t = clean(text, 600);
  if (!t) return;
  mem.summaries.push({ date: new Date().toISOString().slice(0, 10), text: t });
  if (mem.summaries.length > MAX_SUMMARIES) mem.summaries.shift();
  persist();
}

export function removeItem(id) {
  mem.facts = mem.facts.filter(f => f.id !== id);
  if (mem.senders[id]) delete mem.senders[id];
  mem.summaries = mem.summaries.filter(s => `${s.date}:${s.text.slice(0, 12)}` !== id);
  persist();
}

export function clearMemory() { mem = { facts: [], senders: {}, summaries: [] }; persist(); }

// Simple keyword recall so a tool call can ask "what do I know about Anna?".
export function recall(query) {
  const words = clean(query, 200).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const hit = text => !words.length || words.some(w => text.toLowerCase().includes(w));
  return {
    facts: mem.facts.filter(f => hit(f.text)).map(f => f.text).slice(-20),
    senders: Object.entries(mem.senders).filter(([e, v]) => hit(`${e} ${v.note}`)).map(([e, v]) => ({ email: e, ...v })).slice(0, 20),
    summaries: mem.summaries.filter(s => hit(s.text)).slice(-5),
  };
}

// Compact text block added to Gemini prompts.
export function promptBlock() {
  const lines = [];
  if (mem.facts.length) lines.push('Things the user told me to remember:', ...mem.facts.slice(-40).map(f => `- ${f.text}`));
  const s = Object.entries(mem.senders);
  if (s.length) lines.push('Sender preferences:', ...s.slice(-30).map(([e, v]) => `- ${e}: ${v.priority ? `treat as ${v.priority}. ` : ''}${v.note}`));
  if (mem.summaries.length) lines.push('Recent conversations:', ...mem.summaries.slice(-3).map(x => `- ${x.date}: ${x.text}`));
  return lines.join('\n');
}
