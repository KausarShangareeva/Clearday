export async function pMap(items, fn, concurrency = 5) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export function htmlToText(html = '') {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Drop quoted history ("On ... wrote:") so the AI sees the new part of a reply.
export function stripQuoted(text = '') {
  const cut = text.search(/\n(On .{5,120}wrote:|-----Original Message-----|From: .+\nSent: |Den .{5,80}skrev)/i);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export function parseAddress(v = '') {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() };
  return { name: v.trim(), email: v.trim().toLowerCase() };
}

export const clip = (s = '', n = 4000) => (s.length > n ? s.slice(0, n) + '\n[…truncated]' : s);

export class ReauthError extends Error {
  constructor(msg = 'Account needs to be reconnected') { super(msg); this.code = 'reauth'; }
}
