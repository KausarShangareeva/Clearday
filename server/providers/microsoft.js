// Outlook / Microsoft 365 via Microsoft identity platform + Microsoft Graph.
import { htmlToText, stripQuoted, clip, ReauthError } from '../util.js';

const tenant = () => process.env.MICROSOFT_TENANT || 'common';
const AUTH = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`;
const TOKEN = () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.ReadWrite']; // ReadWrite only to create reply drafts
export const label = 'Outlook';
export const configured = () => !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
const redirectUri = () => `${process.env.APP_URL}/auth/microsoft/callback`;

export function authUrl(state, { loginHint } = {}) {
  return `${AUTH()}?${new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(),
    response_mode: 'query', scope: SCOPES.join(' '), state, prompt: 'select_account', ...(loginHint ? { login_hint: loginHint } : {}),
  })}`;
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID, client_secret: process.env.MICROSOFT_CLIENT_SECRET, scope: SCOPES.join(' '), ...params }),
  });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant' || j.error === 'interaction_required') throw new ReauthError();
    throw new Error(`Microsoft: ${j.error_description?.split('\r\n')[0] || j.error || r.status}`);
  }
  return j;
}

export async function exchange(code) {
  const j = await tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  const me = await (await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${j.access_token}` } })).json();
  return {
    email: (me.mail || me.userPrincipalName || '').toLowerCase(), name: me.displayName || '',
    tokens: { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 },
  };
}

export async function refresh(tokens) {
  if (tokens.expires_at > Date.now()) return null;
  if (!tokens.refresh_token) throw new ReauthError();
  const j = await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
  return { access_token: j.access_token, refresh_token: j.refresh_token || tokens.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

// Microsoft has no token-revocation endpoint for this flow; we delete tokens and the
// user can remove the app at https://account.live.com/consent/Manage or https://myapps.microsoft.com
export async function revoke() {}

async function m(path, token, opts = {}) {
  const r = await fetch(GRAPH + path, {
    ...opts, headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"', ...(opts.headers || {}) },
  });
  if (r.status === 401) throw new ReauthError();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Outlook ${r.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

export async function fetchMessages(token, { max, selfEmail }) {
  const inbox = await m(`/me/mailFolders/inbox/messages?${new URLSearchParams({
    $top: String(max), $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,isRead,body,bodyPreview,conversationId,webLink,internetMessageId,inferenceClassification',
  })}`, token);
  // Only look at sent mail back to the oldest inbox message we fetched.
  const since = (inbox.value || []).reduce((a, x) => (x.receivedDateTime < a ? x.receivedDateTime : a), new Date().toISOString());
  const sent = await m(`/me/mailFolders/sentitems/messages?${new URLSearchParams({
    $top: '100', $orderby: 'sentDateTime desc', $filter: `sentDateTime ge ${since}`, $select: 'conversationId,sentDateTime',
  })}`, token).catch(() => ({ value: [] }));
  const lastSent = new Map();
  for (const s of sent.value || []) {
    const t = +new Date(s.sentDateTime);
    if (t > (lastSent.get(s.conversationId) || 0)) lastSent.set(s.conversationId, t);
  }
  return (inbox.value || []).map(x => {
    const body = x.body?.contentType === 'html' ? htmlToText(x.body.content) : (x.body?.content || '');
    const received = +new Date(x.receivedDateTime);
    return {
      providerId: x.id, threadId: x.conversationId,
      fromName: x.from?.emailAddress?.name || x.from?.emailAddress?.address || 'Unknown',
      fromEmail: (x.from?.emailAddress?.address || '').toLowerCase(),
      subject: x.subject || '(no subject)',
      date: new Date(received).toISOString(),
      body: clip(stripQuoted(body), 6000),
      snippet: x.bodyPreview || '',
      unread: !x.isRead,
      replied: (lastSent.get(x.conversationId) || 0) > received,
      listUnsubscribe: false,
      providerCategory: null,
      messageIdHeader: x.internetMessageId,
      link: x.webLink,
    };
  }).filter(x => x.fromEmail !== selfEmail);
}

// Lightweight index of the whole mailbox for category analysis.
export async function fetchIndex(token, { max, selfEmail }) {
  const out = []; let url = `/me/messages?${new URLSearchParams({ $top: String(Math.min(max, 200)), $orderby: 'receivedDateTime desc', $select: 'id,subject,from,bodyPreview,receivedDateTime' })}`;
  while (url && out.length < max) {
    const j = await m(url, token);
    (j.value || []).forEach(x => out.push({ providerId: x.id, fromName: x.from?.emailAddress?.name || '', fromEmail: (x.from?.emailAddress?.address || '').toLowerCase(), subject: x.subject || '(no subject)', snippet: x.bodyPreview || '', date: x.receivedDateTime }));
    url = j['@odata.nextLink'] ? j['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return out.slice(0, max).filter(x => x.fromEmail && x.fromEmail !== selfEmail);
}

// Creates a reply DRAFT in Outlook. Never sends.
export async function createDraft(token, { providerId, body }) {
  const d = await m(`/me/messages/${encodeURIComponent(providerId)}/createReply`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment: body }),
  });
  return { id: d.id, link: d.webLink || 'https://outlook.office.com/mail/drafts' };
}
