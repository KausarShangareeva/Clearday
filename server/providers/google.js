// Gmail via Google OAuth 2.0 + Gmail REST API (no SDK needed).
import { pMap, htmlToText, stripQuoted, parseAddress, clip, ReauthError } from '../util.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.readonly', // read mail
  'https://www.googleapis.com/auth/gmail.compose',  // create drafts (the app never calls send)
];
export const label = 'Gmail';
export const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => `${process.env.APP_URL}/auth/google/callback`;

export function authUrl(state) {
  return `${AUTH}?${new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  })}`;
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant') throw new ReauthError();
    throw new Error(`Google: ${j.error_description || j.error || r.status}`);
  }
  return j;
}

export async function exchange(code) {
  const j = await tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  const scopes = (j.scope || '').split(' ');
  if (!scopes.includes('https://www.googleapis.com/auth/gmail.readonly')) {
    throw new Error('Gmail permission was not granted. Tick the Gmail checkboxes on the consent screen.');
  }
  const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${j.access_token}` } })).json();
  return {
    email: me.email, name: me.name || '',
    tokens: { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 },
  };
}

export async function refresh(tokens) {
  if (tokens.expires_at > Date.now()) return null;
  if (!tokens.refresh_token) throw new ReauthError();
  const j = await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
  return { ...tokens, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

export async function revoke(tokens) {
  const t = tokens.refresh_token || tokens.access_token;
  if (t) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
}

async function g(path, token, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 401) throw new ReauthError();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

const header = (payload, name) => (payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const decode = data => Buffer.from(data || '', 'base64url').toString('utf8');
function extractBody(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  return plain || htmlToText(html);
}

export async function fetchMessages(token, { max, selfEmail }) {
  // Only the most recent `max` inbox messages (newest first), never the whole mailbox.
  const list = await g(`/messages?${new URLSearchParams({ q: 'in:inbox', maxResults: String(max) })}`, token);
  const ids = (list.messages || []).map(m => m.id);
  const msgs = (await pMap(ids, id => g(`/messages/${id}?format=full`, token).catch(() => null), 8)).filter(Boolean);

  // A message counts as "replied" if its thread contains something the user SENT after it.
  const threadIds = [...new Set(msgs.map(m => m.threadId))];
  const threads = await pMap(threadIds, id => g(`/threads/${id}?format=minimal`, token).catch(() => null), 8);
  const lastSent = new Map();
  threads.forEach(t => {
    if (!t) return;
    const sent = (t.messages || []).filter(m => (m.labelIds || []).includes('SENT')).map(m => +m.internalDate);
    lastSent.set(t.id, sent.length ? Math.max(...sent) : 0);
  });

  return msgs.map(m => {
    const from = parseAddress(header(m.payload, 'From'));
    const labels = m.labelIds || [];
    const date = +m.internalDate;
    return {
      providerId: m.id, threadId: m.threadId,
      fromName: from.name, fromEmail: from.email,
      subject: header(m.payload, 'Subject') || '(no subject)',
      date: new Date(date).toISOString(),
      body: clip(stripQuoted(extractBody(m.payload)), 6000),
      snippet: (m.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      unread: labels.includes('UNREAD'),
      replied: (lastSent.get(m.threadId) || 0) > date,
      listUnsubscribe: !!header(m.payload, 'List-Unsubscribe'),
      providerCategory: labels.includes('CATEGORY_PROMOTIONS') ? 'promotions' : labels.includes('CATEGORY_SOCIAL') ? 'social' : null,
      messageIdHeader: header(m.payload, 'Message-ID') || header(m.payload, 'Message-Id'),
      link: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(selfEmail)}#all/${m.threadId}`,
    };
  }).filter(m => m.fromEmail !== selfEmail);
}

const encodeHeader = s => (/^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// Creates a DRAFT in the same thread. Never sends.
export async function createDraft(token, { to, subject, body, threadId, inReplyTo, selfEmail }) {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [`To: ${to}`, `Subject: ${encodeHeader(subj)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  const raw = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
  const d = await g('/drafts', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { raw, threadId } }) });
  return { id: d.id, link: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(selfEmail)}#drafts` };
}
