// AI service layer: EmailClassifier + PriorityEngine + ActionDetector + SummarizationService
// + ReplyDraftService in one structured Claude call per batch, plus InboxAssistant and rewrites.
import { pMap, clip } from './util.js';

const API = 'https://api.anthropic.com/v1/messages';
export const hasAI = () => !!process.env.ANTHROPIC_API_KEY;
const FAST = () => process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const SMART = () => process.env.AI_SMART_MODEL || 'claude-sonnet-5-5';

async function claude({ system, prompt, model, maxTokens = 4000 }) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${j.error?.message || 'request failed'}`);
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

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
const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(new Date(v)) ? v.slice(0, 10) : null);
const str = (v, n = 600) => (typeof v === 'string' ? v.slice(0, n) : '');

function sanitize(a, e, categories) {
  const kind = KINDS.includes(a?.kind) ? a.kind : 'personal';
  const out = {
    priority: PRIORITIES.includes(a?.priority) ? a.priority : 'normal',
    category: categories.includes(a?.category) ? a.category : 'Other',
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
    out.newsletter = { readMin: Math.max(1, Math.min(60, parseInt(a.newsletter.readMin) || 3)), why: str(a.newsletter.why, 400), sums: { one: str(s.one, 300) || out.summary, s30: str(s.s30, 800) || out.summary, m2: str(s.m2, 1500) || out.summary, detailed: str(s.detailed, 2500) || out.summary } };
  }
  if (!out.reasons.length) out.reasons = ['Analysed by Clearday'];
  return out;
}

// Cheap rules used for obvious promotions/social mail and when no API key is set.
export function heuristic(e, reason) {
  const auto = /no-?reply|notifications?@|mailer|newsletter|news@|info@|updates?@|marketing|hello@/i.test(e.fromEmail);
  const promo = e.providerCategory === 'promotions', social = e.providerCategory === 'social';
  const kind = promo ? 'promo' : social ? 'social' : e.listUnsubscribe ? 'newsletter' : auto ? 'notice' : 'personal';
  const asks = /\?|please|could you|can you|kan du|skulle du/i.test(`${e.subject} ${e.body.slice(0, 1500)}`);
  const priority = promo || social ? 'noise' : kind === 'personal' ? (asks ? 'important' : 'normal') : 'low';
  return {
    priority, category: promo ? 'Promotions' : social || kind === 'notice' ? 'Notifications' : kind === 'newsletter' ? 'News' : 'Other',
    kind, org: '', reasons: [reason || (kind === 'personal' ? 'Written by a person' : 'Automated sender')],
    summary: e.snippet || e.subject, catchLine: e.snippet || e.subject, needsReply: kind === 'personal' && asks,
    action: null, event: null, newsletter: null, draft: null,
  };
}

const SYSTEM = `You are the analysis engine of Clearday, an AI chief of staff for email. You read emails and return strict JSON.
Be accurate and conservative: never invent deadlines, meetings, amounts or facts that are not in the email. Write summaries in English unless the user's profile says otherwise; write reply drafts in the language of the email.`;

export async function classify(emails, { profile, categories, today }) {
  if (!emails.length) return {};
  const name = (profile?.name || 'me').split(' ')[0];
  const batches = [];
  for (let i = 0; i < emails.length; i += 8) batches.push(emails.slice(i, i + 8));
  const results = {};
  await pMap(batches, async batch => {
    const payload = batch.map(e => ({
      id: e.id, inbox: e.inbox, from: e.fromName, fromEmail: e.fromEmail, subject: e.subject,
      date: e.date, unread: e.unread, alreadyReplied: e.replied, bulk: e.listUnsubscribe, body: clip(e.body, 3500),
    }));
    const prompt = `Today is ${today}. The user is ${name}.
User profile: ${JSON.stringify(profile || {})}
Categories you may use (exact strings): ${JSON.stringify(categories)}

For EACH email return an object:
{"id": the same id,
 "priority": "critical" | "important" | "normal" | "low" | "noise",
 "category": one of the categories,
 "kind": "personal" (a person writing to the user) | "newsletter" | "alert" (security/account/bank) | "event" | "receipt" | "promo" | "notice" (automated notification) | "social",
 "org": the sender's role or company if clear from the signature or domain, else "",
 "reasons": 2-4 short reasons (max 9 words each) for the priority, referring to the user's profile when relevant,
 "summary": 1-2 specific sentences on what matters (names, dates, amounts),
 "catchLine": one sentence suitable for a spoken briefing,
 "needsReply": true only if a person expects a reply from the user,
 "action": {"task": short imperative task, "deadline": "YYYY-MM-DD" or null, "how": short hint} or null — only if the user is asked to do something,
 "event": {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" or "", "place": string} or null — only for a specific dated event or meeting,
 "newsletter": when kind is "newsletter": {"readMin": estimated minutes to read the original, "sums": {"one": one sentence, "s30": about 60 words, "m2": about 150 words, "detailed": about 250 words covering the key points}, "why": 1-2 sentences on why this matters to this specific user, or ""}; otherwise null,
 "draft": when needsReply is true: a ready-to-edit reply signed "${name}", concise, never committing to things the user hasn't said — use placeholders like [time] where needed; otherwise null}

Priority guide: critical = action needed within about 24 hours or serious consequences (deadline tomorrow, confirmed security problem, legal). important = should be read today (sender the profile marks important, direct request, money, meeting request). normal = useful, no urgency. low = automated or routine. noise = marketing, social notifications, or what the profile says to ignore. Do not rely on words like "urgent" alone. Already-replied emails are rarely critical.

Emails:
${JSON.stringify(payload)}

Return ONLY a JSON array with one object per email, no markdown.`;
    try {
      const arr = parseJSON(await claude({ system: SYSTEM, prompt, model: FAST(), maxTokens: 8000 }));
      const byId = new Map((Array.isArray(arr) ? arr : []).map(a => [a?.id, a]));
      batch.forEach(e => { results[e.id] = byId.has(e.id) ? sanitize(byId.get(e.id), e, categories) : heuristic(e, 'AI skipped this email'); });
    } catch (err) {
      console.error('classify batch failed:', err.message);
      batch.forEach(e => { results[e.id] = heuristic(e, 'AI unavailable, basic rules used'); });
    }
  }, 4);
  return results;
}

export async function answer({ question, history = [], context = [], profile, today }) {
  const prompt = `You are Clearday, an AI chief of staff for email. Answer the user's question using ONLY the emails below. Be concise, warm and specific, like a sharp personal assistant speaking. Use numbered lines ("1. ...") for lists. Never claim to have sent an email: you only write drafts that the user reviews and sends.

Today is ${today}.
User profile: ${JSON.stringify(profile || {})}

Emails (JSON):
${JSON.stringify(context).slice(0, 120000)}

${history.length ? 'Conversation so far:\n' + history.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Clearday'}: ${String(m.text).slice(0, 1500)}`).join('\n') + '\n' : ''}
User: ${question}

Respond with JSON only, no markdown:
{"answer": string, "refs": [ids of emails you relied on], "draftFor": an email id or null, "draft": reply text signed "${(profile?.name || 'me').split(' ')[0]}" or null (only when the user asks for a reply or draft)}`;
  const r = parseJSON(await claude({ system: 'You return strict JSON.', prompt, model: SMART(), maxTokens: 2500 }));
  return { text: str(r.answer, 4000), refs: Array.isArray(r.refs) ? r.refs.map(String) : [], draftFor: r.draftFor || null, draft: r.draft ? str(r.draft, 3000) : null };
}

export async function rewrite({ email, draft, instruction, name }) {
  const prompt = `${draft ? 'Rewrite this email reply.' : 'Write a reply to this email.'} Instruction: ${instruction}
Keep facts consistent with the email, do not invent commitments, write in the email's language, sign it "${name}". Return ONLY the reply text, no preamble.

Email being replied to (from ${email.fromName} <${email.fromEmail}>, subject "${email.subject}"):
${clip(email.body, 5000)}
${draft ? `\nCurrent draft:\n${draft}` : ''}`;
  return (await claude({ system: 'You write clear, natural email replies.', prompt, model: SMART(), maxTokens: 1500 })).trim();
}
