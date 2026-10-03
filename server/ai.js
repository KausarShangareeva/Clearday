// AI service layer: EmailClassifier + PriorityEngine + ActionDetector + SummarizationService
// + ReplyDraftService in one structured Claude call per batch, plus InboxAssistant and rewrites.
import { pMap, clip } from './util.js';

import { promptBlock } from './memory.js';

// Two interchangeable AI backends. Gemini is used when GEMINI_API_KEY is set (it also powers live voice);
// otherwise Claude via ANTHROPIC_API_KEY.
const PROVIDER = () => (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : null);
export const hasAI = () => !!PROVIDER();
export const aiProvider = () => PROVIDER();
const FAST = () => process.env.AI_MODEL || (PROVIDER() === 'gemini' ? 'gemini-3.5-flash-lite' : 'claude-haiku-4-5-20251001');
const SMART = () => process.env.AI_SMART_MODEL || (PROVIDER() === 'gemini' ? 'gemini-3.8-flash' : 'claude-sonnet-5-5');

async function anthropic({ system, prompt, model, maxTokens = 4000 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${j.error?.message || 'request failed'}`);
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// One Gemini generateContent call. `json` asks for application/json output.
// If the model rejects the thinking setting we retry once without it.
async function gemini({ system, prompt, model, maxTokens = 4000, json = true, thinking = 'low' }) {
  const call = async withThinking => {
    const generationConfig = { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}), ...(withThinking && thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
    });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  let { r, j } = await call(true);
  if (!r.ok && r.status === 400 && thinking && /think/i.test(j.error?.message || '')) ({ r, j } = await call(false));
  if (!r.ok) throw new Error(`Gemini API ${r.status}: ${j.error?.message || 'request failed'}`);
  return (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
}

const llm = opts => (PROVIDER() === 'gemini' ? gemini(opts) : anthropic(opts));
const memoryNote = () => { const m = promptBlock(); return m ? `\nLocal memory about the user (honour it):\n${m}\n` : ''; };

function parseJSON(text) {
  const s = text.replace(/```json|```/g, '').trim();
  const starts = [s.indexOf('['), s.indexOf('{')].filter(i => i >= 0);
  if (!starts.length) throw new Error('No JSON in model output');
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  return JSON.parse(s.slice(start, end + 1));
}

const PRIORITIES = ['critical', 'important', 'normal', 'low', 'noise'];
const KINDS = ['personal', 'newsletter', 'alert', 'event', 'receipt', 'promo', 'notice', 'social'];
export const OTHER_TAGS = ['Security codes', 'Receipts', 'Notifications', 'Promotions', 'Social', 'Misc'];
const CODE_RE = /(verification|security|confirmation|login|log-?in|sign-?in|one[- ]time|auth(entication)?|access)\s+(code|pin|password)|\botp\b|one[- ]time (pass(word|code)|code|pin)|(your|use|enter|the)\s+(\w+\s+)?code\s+(is|:)|\bcode:?\s*\d{4,8}\b|\b\d{6}\b.{0,40}(code|verify|verification)|(code|verify|verification).{0,40}\b\d{6}\b|two-?factor|2fa|\bmfa\b|new sign-?in|sign-?in (attempt|from)|suspicious (login|activity)|password reset|reset your password|security alert|unusual activity/i;
const RECEIPT_RE = /\b(receipt|invoice|order (confirmation|#?\d+)|payment (received|confirmation|successful)|your order|billing|subscription renewal|has shipped|shipping (confirmation|update)|out for delivery|delivered|tracking number|refund)\b/i;
const PROMO_RE = /\b(\d{1,2}% off|sale|discount|deal|offer ends|limited time|coupon|free shipping|exclusive|don'?t miss|black friday|save up to|promo(tion)?)\b/i;
const SOCIAL_RE = /linkedin|facebook|instagram|twitter|x\.com|tiktok|pinterest|reddit|youtube|snapchat|meetup\.com|discord/i;
// Strong rule-based tag for mail that is not for the user's own folders. Used as fallback and as a safety net over the model.
export function guessTag(e) {
  const text = `${e.subject || ''}\n${String(e.body || e.snippet || '').slice(0, 1200)}`;
  if (CODE_RE.test(text)) return 'Security codes';
  if (e.providerCategory === 'social' || SOCIAL_RE.test(e.fromEmail || '')) return 'Social';
  if (RECEIPT_RE.test(text)) return 'Receipts';
  if (e.providerCategory === 'promotions' || PROMO_RE.test(e.subject || '')) return 'Promotions';
  if (/no-?reply|notifications?@|alerts?@|mailer|donotreply|do-not-reply|automated|support@/i.test(e.fromEmail || '')) return 'Notifications';
  return 'Misc';
}
const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(new Date(v)) ? v.slice(0, 10) : null);
const str = (v, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '');

function sanitize(a, e, categories) {
  const kind = KINDS.includes(a?.kind) ? a.kind : 'personal';
  const out = {
    priority: PRIORITIES.includes(a?.priority) ? a.priority : 'normal',
    category: categories.includes(a?.category) ? a.category : 'Other',
    otherTag: OTHER_TAGS.includes(a?.otherTag) ? a.otherTag : guessTag(e),
    kind,
    org: str(a?.org, 80),
    reasons: (Array.isArray(a?.reasons) ? a.reasons : []).map(r => str(r, 90)).filter(Boolean).slice(0, 4),
    summary: str(a?.summary, 400) || e.snippet,
    catchLine: str(a?.catchLine, 240) || str(a?.summary, 240) || e.snippet,
    needsReply: !!a?.needsReply,
    action: a?.action && str(a.action.task) ? { task: str(a.action.task, 120), deadline: isoDate(a.action.deadline), how: str(a.action.how, 200) } : null,
    event: a?.event && isoDate(a.event.date) ? { title: str(a.event.title, 100) || e.subject, date: isoDate(a.event.date), time: str(a.event.time, 20), place: str(a.event.place, 100) } : null,
    newsletter: null,
    draft: a?.needsReply && str(a?.draft, 3000) ? str(a.draft, 3000) : null,
  };
  if (kind === 'newsletter' && a?.newsletter?.sums) {
    const s = a.newsletter.sums;
    const TOPICS = ['IT','AI','Web dev','Career','Marketing','Events','Design','Business','Science'];
    out.newsletter = { topics: (Array.isArray(a.newsletter.topics) ? a.newsletter.topics : []).filter(t => TOPICS.includes(t)).slice(0, 2), readMin: Math.max(1, Math.min(60, parseInt(a.newsletter.readMin) || 3)), why: str(a.newsletter.why, 400), sums: { one: str(s.one, 300) || out.summary, s30: str(s.s30, 800) || out.summary, m2: str(s.m2, 1500) || out.summary, detailed: str(s.detailed, 2500) || out.summary } };
  }
  if (!out.reasons.length) out.reasons = ['Analysed by Clearday'];
  // Login codes / OTPs / security alerts never belong in a user folder.
  if (CODE_RE.test(`${e.subject || ''}\n${String(e.body || '').slice(0, 800)}`)) { out.category = 'Other'; out.otherTag = 'Security codes'; }
  if (out.category !== 'Other') out.otherTag = null;
  return out;
}

// Cheap rules used for obvious promotions/social mail and when no API key is set.
export function heuristic(e, reason, hints = []) {
  const auto = /no-?reply|notifications?@|mailer|newsletter|news@|info@|updates?@|marketing|hello@/i.test(e.fromEmail);
  const promo = e.providerCategory === 'promotions', social = e.providerCategory === 'social';
  const tag = guessTag(e);
  const kind = tag === 'Security codes' ? 'alert' : promo ? 'promo' : social ? 'social' : e.listUnsubscribe ? 'newsletter' : tag === 'Receipts' ? 'receipt' : auto ? 'notice' : 'personal';
  const asks = /\?|please|could you|can you|kan du|skulle du/i.test(`${e.subject} ${e.body.slice(0, 1500)}`);
  const priority = tag === 'Security codes' ? 'low' : promo || social ? 'noise' : kind === 'personal' ? (asks ? 'important' : 'normal') : 'low';
  // Without AI: a user folder is chosen only for a person's mail whose text clearly contains the folder's own name.
  let category = 'Other';
  if (kind === 'personal' || kind === 'event') {
    const hay = `${e.subject} ${e.fromName} ${e.fromEmail} ${String(e.body || '').slice(0, 600)}`.toLowerCase();
    const hit = hints.find(h => h.name && hay.includes(String(h.name).toLowerCase()));
    if (hit) category = hit.name;
  }
  return {
    priority, category, otherTag: category === 'Other' ? tag : null,
    kind, org: '', reasons: [reason || (kind === 'personal' ? 'Written by a person' : 'Automated sender')],
    summary: e.snippet || e.subject, catchLine: e.snippet || e.subject, needsReply: kind === 'personal' && asks,
    action: null, event: null, newsletter: null, draft: null,
  };
}

const SYSTEM = `You are the analysis engine of Clearday, an AI chief of staff for email. You read emails and return strict JSON.
Be accurate and conservative: never invent deadlines, meetings, amounts or facts that are not in the email. Write summaries in English unless the user's profile says otherwise; write reply drafts in the language of the email.`;

const BATCH = () => Math.max(4, +process.env.CLASSIFY_BATCH || 10);
const CONCURRENCY = () => Math.max(1, +process.env.CLASSIFY_CONCURRENCY || 6);
// `hints` = ALL of the user's categories [{name, desc}] (authoritative); `categories` = their names.
export async function classify(emails, { profile, categories, today, hints = [] }) {
  if (!emails.length) return {};
  const name = (profile?.name || 'me').split(' ')[0];
  const batches = [];
  for (let i = 0; i < emails.length; i += BATCH()) batches.push(emails.slice(i, i + BATCH()));
  const results = {};
  const runBatch = async (batch, depth = 0) => {
    const payload = batch.map(e => ({
      id: e.id, inbox: e.inbox, from: e.fromName, fromEmail: e.fromEmail, subject: e.subject,
      date: e.date, unread: e.unread, alreadyReplied: e.replied, bulk: e.listUnsubscribe, body: clip(e.body, 2500),
    }));
    const prompt = `Today is ${today}. The user is ${name}.
User profile: ${JSON.stringify(profile || {})}${memoryNote()}
The user's own folders (authoritative list, exact names). Every email goes into EXACTLY ONE of these folders, or "Other" if none clearly fits:
${hints.length ? hints.map(h => `- "${h.name}"${h.desc ? ': ' + h.desc : ''}`).join('\n') : '(the user has no folders yet: use "Other" for everything)'}
Never invent a folder. Login or verification codes, one-time passwords, security/sign-in alerts, receipts, shipping notices, automated notifications and promotions must go to "Other" unless one of the user's folders clearly covers that kind of mail (for example a "Bills" folder may take receipts and invoices).

For EACH email return an object:
{"id": the same id,
 "priority": "critical" | "important" | "normal" | "low" | "noise",
 "category": exactly one of the user's folder names above, or "Other",
 "otherTag": when category is "Other": one of "Security codes" (verification codes, OTP, login/security alerts) | "Receipts" (receipts, invoices, orders, shipping) | "Notifications" (automated notifications) | "Promotions" (marketing, offers) | "Social" (social network updates) | "Misc"; otherwise null,
 "kind": "personal" (a person writing to the user) | "newsletter" | "alert" (security/account/bank) | "event" | "receipt" | "promo" | "notice" (automated notification) | "social",
 "org": the sender's role or company if clear from the signature or domain, else "",
 "reasons": 2-4 short reasons (max 9 words each) for the priority, referring to the user's profile when relevant,
 "summary": 1-2 specific sentences on what matters (names, dates, amounts),
 "catchLine": one sentence suitable for a spoken briefing,
 "needsReply": true only if a person expects a reply from the user,
 "action": {"task": short imperative task, "deadline": "YYYY-MM-DD" or null, "how": short hint} or null — only if the user is asked to do something,
 "event": {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" or "", "place": string} or null — only for a specific dated event or meeting,
 "newsletter": when kind is "newsletter": {"topics": 1-2 of ["IT","AI","Web dev","Career","Marketing","Events","Design","Business","Science"], "readMin": estimated minutes to read the original, "sums": {"one": one sentence, "s30": about 60 words, "m2": about 150 words, "detailed": about 250 words covering the key points}, "why": 1-2 sentences on why this matters to this specific user, or ""}; otherwise null,
 "draft": when needsReply is true: a ready-to-edit reply signed "${name}", concise, never committing to things the user hasn't said — use placeholders like [time] where needed; otherwise null}

Priority guide: critical = action needed within about 24 hours or serious consequences (deadline tomorrow, confirmed security problem, legal). important = should be read today (sender the profile marks important, direct request, money, meeting request). normal = useful, no urgency. low = automated or routine. noise = marketing, social notifications, or what the profile says to ignore. Do not rely on words like "urgent" alone. Already-replied emails are rarely critical.

Emails:
${JSON.stringify(payload)}

Return ONLY a JSON array with one object per email, no markdown.`;
    try {
      const arr = parseJSON(await llm({ system: SYSTEM, prompt, model: FAST(), maxTokens: 8000 }));
      const byId = new Map((Array.isArray(arr) ? arr : []).map(a => [a?.id, a]));
      batch.forEach(e => { results[e.id] = byId.has(e.id) ? sanitize(byId.get(e.id), e, categories) : heuristic(e, 'AI skipped this email', hints); });
    } catch (err) {
      if (batch.length > 1 && depth < 3) { // malformed/oversized reply: retry in two smaller halves
        const mid = Math.ceil(batch.length / 2);
        await Promise.all([runBatch(batch.slice(0, mid), depth + 1), runBatch(batch.slice(mid), depth + 1)]);
        return;
      }
      console.error('classify batch failed:', err.message);
      batch.forEach(e => { results[e.id] = heuristic(e, 'AI unavailable, basic rules used', hints); });
    }
  };
  await pMap(batches, b => runBatch(b), CONCURRENCY());
  return results;
}

export async function answer({ question, history = [], context = [], profile, today }) {
  const prompt = `You are Clearday, an AI chief of staff for email. Answer the user's question using ONLY the emails below. Be concise, warm and specific, like a sharp personal assistant speaking. Use numbered lines ("1. ...") for lists. Never claim to have sent an email: you only write drafts that the user reviews and sends.

Today is ${today}.
User profile: ${JSON.stringify(profile || {})}${memoryNote()}
Emails (JSON):
${JSON.stringify(context).slice(0, 120000)}

${history.length ? 'Conversation so far:\n' + history.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Clearday'}: ${String(m.text).slice(0, 1500)}`).join('\n') + '\n' : ''}
User: ${question}

Respond with JSON only, no markdown:
{"answer": string, "refs": [ids of emails you relied on], "draftFor": an email id or null, "draft": reply text signed "${(profile?.name || 'me').split(' ')[0]}" or null (only when the user asks for a reply or draft)}`;
  const r = parseJSON(await llm({ system: 'You return strict JSON.', prompt, model: SMART(), maxTokens: 2500 }));
  return { text: str(r.answer, 4000), refs: Array.isArray(r.refs) ? r.refs.map(String) : [], draftFor: r.draftFor || null, draft: r.draft ? str(r.draft, 3000) : null };
}

export async function rewrite({ email, draft, instruction, name }) {
  const prompt = `${draft ? 'Rewrite this email reply.' : 'Write a reply to this email.'} Instruction: ${instruction}
${memoryNote()}Keep facts consistent with the email, do not invent commitments, write in the email's language, sign it "${name}". Return ONLY the reply text, no preamble.

Email being replied to (from ${email.fromName} <${email.fromEmail}>, subject "${email.subject}"):
${clip(email.body, 5000)}
${draft ? `\nCurrent draft:\n${draft}` : ''}`;
  return (await llm({ system: 'You write clear, natural email replies.', prompt, model: SMART(), maxTokens: 1500, json: false })).trim();
}

const CAT_ICONS = ['star', 'coin', 'users', 'calendar', 'plane', 'heart', 'tag', 'book'];
const indexLines = items => items.map(i => `${i.id} | ${i.from} <${i.fromEmail}> | ${String(i.subject).slice(0, 110)} | ${String(i.snippet || '').slice(0, 110).replace(/\s+/g, ' ')}`).join('\n');

// Reads the whole mailbox index and proposes folders the user doesn't have yet.
export async function suggestCategories(items, existing = [], profile) {
  const valid = new Set(items.map(i => i.id));
  const prompt = `You organise someone's email into folders. Below is an index of their mailbox (one email per line: id | sender | subject | preview).
User profile: ${JSON.stringify(profile || {})}
Folders they already have (do not repeat these): ${JSON.stringify(existing)}

Propose 4 to 6 NEW folders that would genuinely help this person, each grounded in emails that are really in the list (at least 2 per folder). Prefer concrete groupings (e.g. a specific client, investors, bills, a course, travel) over vague ones.
Return JSON only: {"suggestions":[{"name": short folder name, "description": one sentence saying which emails belong, "icon": one of ${JSON.stringify(CAT_ICONS)}, "ids": [ids of matching emails]}]}

Mailbox:
${indexLines(items).slice(0, 150000)}`;
  const r = parseJSON(await llm({ system: 'You return strict JSON.', prompt, model: SMART(), maxTokens: 4000 }));
  return (r.suggestions || []).map(sg => {
    const ids = (sg.ids || []).filter(id => valid.has(id));
    const senders = [...new Set(ids.map(id => items.find(i => i.id === id)?.from).filter(Boolean))].slice(0, 3);
    return { name: str(sg.name, 40), description: str(sg.description, 200), desc: str(sg.description, 200), icon: CAT_ICONS.includes(sg.icon) ? sg.icon : 'tag', count: ids.length, examples: senders };
  }).filter(sg => sg.name && sg.count > 0).slice(0, 6);
}

// Finds every email in the mailbox index that belongs to a user-described folder.
export async function matchCategory(items, name, description) {
  const valid = new Set(items.map(i => i.id));
  const prompt = `A user is creating an email folder.
Folder name: ${name}
What belongs in it, in the user's words: ${description}

From the mailbox index below (id | sender | subject | preview), select EVERY email that belongs in this folder and nothing that doesn't. Give a short reason (max 9 words) for each.
Return JSON only: {"matches":[{"id": id, "reason": string}]}

Mailbox:
${indexLines(items).slice(0, 150000)}`;
  const r = parseJSON(await llm({ system: 'You return strict JSON.', prompt, model: SMART(), maxTokens: 6000 }));
  const seen = new Set();
  return (r.matches || []).filter(x => valid.has(x?.id) && !seen.has(x.id) && seen.add(x.id)).map(x => ({ id: x.id, reason: str(x.reason, 90) }));
}

// One-sentence note of a voice conversation, kept in local memory.
export async function summarize(text) {
  return (await llm({ system: 'You write one-sentence memory notes.', prompt: `Summarise this voice conversation between a user and their email assistant in one sentence (max 40 words), keeping names, decisions and open follow-ups:\n${String(text).slice(0, 6000)}`, model: FAST(), maxTokens: 200, json: false, thinking: null })).trim();
}

// Onboarding: turn "who I am and what I want to track" into up to 6 folders (adapted from Pranish's branch).
const ABOUT_ICONS = ['star', 'coin', 'users', 'calendar', 'plane', 'heart', 'tag', 'book'];
const DEFAULT_FOLDERS = [
  { name: 'Work', icon: 'users', hint: 'Colleagues, clients, projects and deadlines' },
  { name: 'Money', icon: 'coin', hint: 'Bills, invoices, bank and payments' },
  { name: 'Events', icon: 'calendar', hint: 'Meetings, invitations and things happening soon' },
  { name: 'Friends & family', icon: 'heart', hint: 'Personal messages and plans' },
];
export async function suggestFromAbout({ about, name }) {
  if (!hasAI() || !String(about || '').trim()) return DEFAULT_FOLDERS;
  try {
    const prompt = `The user${name ? ' (' + name + ')' : ''} describes themselves: """${String(about).slice(0, 1500)}"""
Create between 3 and 6 email folders that fit THEIR life and what they want to keep track of. Folders must be distinct and concrete (e.g. "Thesis", "Investors", "Clients", "Rent & bills", not "Misc"), with a short name (max 2 words), an icon from ${JSON.stringify(ABOUT_ICONS)}, and a one-line hint (max 14 words) saying what belongs in it. Do not include "Other", "Promotions" or "Newsletters".
Return ONLY JSON: [{"name": string, "icon": string, "hint": string}]`;
    const arr = parseJSON(await llm({ system: 'You design email folders. You return strict JSON.', prompt, model: SMART(), maxTokens: 1200 }));
    const seen = new Set();
    const out = (Array.isArray(arr) ? arr : []).map(c => ({ name: str(c?.name, 30).trim(), icon: ABOUT_ICONS.includes(c?.icon) ? c.icon : 'star', hint: str(c?.hint, 160).trim() }))
      .filter(c => c.name && !/^(other|misc|promotions|newsletters)$/i.test(c.name) && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase())).slice(0, 6);
    return out.length ? out : DEFAULT_FOLDERS;
  } catch (e) { console.error('suggestFromAbout:', e.message); return DEFAULT_FOLDERS; }
}
