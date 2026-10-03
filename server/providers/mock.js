// Offline rehearsal provider (DEV_MOCK=1). Pretends to be a mailbox so the live code path
// can be tested without Google/Microsoft credentials.
export const label = 'Mock';
export const configured = () => process.env.DEV_MOCK === '1';
export const authUrl = state => `/auth/mock/callback?code=mock&state=${encodeURIComponent(state)}`;
export const exchange = async () => ({ email: `you+${Math.random().toString(36).slice(2, 6)}@example.com`, name: 'Mock User', tokens: { access_token: 'x', expires_at: Date.now() + 1e9 } });
export const refresh = async () => null;
export const revoke = async () => {};
const h = n => new Date(Date.now() - n * 3600e3).toISOString();
export async function fetchMessages() {
  return [
    { providerId: 'm1', threadId: 't1', fromName: 'Jana Novak', fromEmail: 'jana@acme.io', subject: 'Contract review by Thursday?', date: h(2), body: 'Hi! Could you review the attached contract and send comments by Thursday? Thanks, Jana', snippet: 'Could you review the attached contract', unread: true, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm2', threadId: 't2', fromName: 'Tech Weekly', fromEmail: 'news@techweekly.io', subject: 'This week in AI agents', date: h(5), body: 'Agents everywhere. Three launches this week...', snippet: 'Agents everywhere', unread: true, replied: false, listUnsubscribe: true, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm3', threadId: 't3', fromName: 'Shop', fromEmail: 'deals@shop.com', subject: '50% off today only', date: h(7), body: 'Sale!', snippet: 'Sale!', unread: false, replied: false, listUnsubscribe: true, providerCategory: 'promotions', link: 'https://example.com' },
    { providerId: 'm4', threadId: 't4', fromName: 'Leo', fromEmail: 'leo@gmail.com', subject: 'Lunch?', date: h(20), body: 'Lunch tomorrow at 12?', snippet: 'Lunch tomorrow at 12?', unread: false, replied: true, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm5', threadId: 't5', fromName: 'Prof. Lindqvist', fromEmail: 'lindqvist@kth.se', subject: 'Thesis meeting moved to Friday 10:00', date: h(3), body: 'Hi, can we move our thesis meeting to Friday at 10:00 in room D2? Please confirm and send me your latest draft beforehand.', snippet: 'Thesis meeting moved to Friday', unread: true, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm6', threadId: 't6', fromName: 'Nordbank', fromEmail: 'security@nordbank.se', subject: 'New sign-in to your account', date: h(4), body: 'We noticed a sign-in from a new device in Stockholm. If this was not you, block your card in the app.', snippet: 'New sign-in', unread: true, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm7', threadId: 't7', fromName: 'Maria (Startup)', fromEmail: 'maria@pitchlab.co', subject: 'Investor intro - are you free next week?', date: h(9), body: 'An investor friend wants to meet you. Are you free Tuesday or Wednesday afternoon? Let me know and I will connect you.', snippet: 'Investor intro', unread: true, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm8', threadId: 't8', fromName: 'Invoice Bot', fromEmail: 'noreply@cloudhost.com', subject: 'Invoice #4821: 49 EUR due Oct 10', date: h(11), body: 'Your invoice of 49 EUR is due on 2026-10-10.', snippet: 'Invoice due Oct 10', unread: false, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm9', threadId: 't9', fromName: 'Agentic AI Meetup', fromEmail: 'events@agentic.ai', subject: 'Founders meetup Thursday 18:00', date: h(13), body: 'Join us Thursday at 18:00 at Epicenter, Stockholm. Talks, then demos and drinks.', snippet: 'Founders meetup Thursday', unread: false, replied: false, listUnsubscribe: true, providerCategory: null, link: 'https://example.com' },
    { providerId: 'm10', threadId: 't10', fromName: 'Anna', fromEmail: 'anna@gmail.com', subject: 'Dinner Saturday?', date: h(26), body: 'Are you coming to dinner on Saturday? We eat at 19:00.', snippet: 'Dinner Saturday?', unread: true, replied: false, listUnsubscribe: false, providerCategory: null, link: 'https://example.com' },
  ];
}
export async function createDraft() { return { id: 'd1', link: 'https://example.com/drafts' }; }
export async function fetchIndex() { return (await fetchMessages()).map(m => ({ providerId: m.providerId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, snippet: m.snippet, date: m.date })); }
