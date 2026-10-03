// Work-email discovery: given name@startup.com, work out how Clearday should connect it.
//   { kind:'oauth', provider:'google'|'microsoft', note }
//   { kind:'imap', host, port, secure, source, note }
//   { kind:'manual', note }
// Every host we resolve, fetch or connect to goes through the SSRF guard below (no private, loopback,
// link-local or metadata addresses), so this endpoint can't be used to poke at the server's own network.
import dns from 'node:dns';
import { promises as dnsp } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { domainToASCII } from 'node:url';

// ---------- SSRF guard ----------
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['2001::', 32], ['100::', 64]]) blocked.addSubnet(a, p, 'ipv6');

export function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {
    const m = ip.toLowerCase().match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped / compatible
    if (m) return isPrivateIp(m[1]);
    const h = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (h) { const n = (parseInt(h[1], 16) << 16) | parseInt(h[2], 16); return isPrivateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z][a-z0-9-]{1,23}$/;
export function cleanHost(h) {
  const s = domainToASCII(String(h || '').trim().toLowerCase().replace(/\.$/, ''));
  if (!s || s.length > 253 || !HOST_RE.test(s)) return null;
  return s;
}

// Resolve a hostname (or IP literal) and require EVERY address to be public. Returns the first address to pin the connection to.
export async function resolveSafe(host, lookup = dnsp.lookup) {
  const h = String(host || '').trim().toLowerCase();
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new Error('That address is on a private network and cannot be used.'); return { address: h, family: net.isIP(h) }; }
  const name = cleanHost(h);
  if (!name) throw new Error('That does not look like a valid mail server name.');
  let addrs;
  try { addrs = await lookup(name, { all: true, verbatim: true }); }
  catch { throw new Error(`Could not find a server called ${name}.`); }
  if (!Array.isArray(addrs)) addrs = [addrs];
  if (!addrs.length) throw new Error(`Could not find a server called ${name}.`);
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('That server name points to a private network address and cannot be used.');
  return { address: addrs[0].address, family: addrs[0].family };
}

// dns.lookup-compatible callback that refuses private addresses (used by https.request so redirects/rebinding can't escape).
function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return cb(new Error('blocked address'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// https GET with short timeout, size cap, no redirects. Injectable in tests.
export function fetchText(url, { timeout = 4000, maxBytes = 64 * 1024 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return resolve(null);
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', lookup: guardedLookup, timeout, headers: { 'user-agent': 'Clearday-autoconfig', accept: 'application/xml,text/xml,*/*' } }, r => {
      if (r.statusCode !== 200) { r.resume(); return fin(null); }
      let n = 0; const chunks = [];
      r.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(); return fin(null); } chunks.push(c); });
      r.on('end', () => fin(Buffer.concat(chunks).toString('utf8')));
      r.on('error', () => fin(null));
    });
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
    setTimeout(() => { req.destroy(); fin(null); }, timeout + 1000).unref();
    req.end();
  });
}

// Quick TLS connect + IMAP greeting check on a safely-resolved address.
export async function probeImap(host, port = 993, { lookup, timeout = 3000 } = {}) {
  let r; try { r = await resolveSafe(host, lookup); } catch { return false; }
  return new Promise(resolve => {
    let done = false; const fin = v => { if (!done) { done = true; try { s.destroy(); } catch { /* */ } resolve(v); } };
    const s = tls.connect({ host: r.address, port, servername: host, timeout, rejectUnauthorized: true });
    s.setTimeout(timeout, () => fin(false));
    s.on('error', () => fin(false));
    s.on('data', d => fin(/^\* (OK|PREAUTH)/i.test(d.toString('latin1'))));
  });
}

// ---------- parsing / tables ----------
export function parseEmail(email) {
  const s = String(email || '').trim();
  if (s.length > 254) return null;
  const m = s.match(/^([A-Za-z0-9._%+'-]{1,64})@([^@\s]+)$/);
  if (!m) return null;
  const domain = cleanHost(m[2]);
  if (!domain) return null;
  return { local: m[1], domain, email: `${m[1]}@${domain}`.toLowerCase() };
}

const GOOGLE_MX = /(^|\.)(aspmx\.l\.google\.com|googlemail\.com|google\.com|googlemail\.l\.google\.com)$/;
const M365_MX = /\.mail\.protection\.outlook\.com$|\.mail\.protection\.outlook\.de$|\.protection\.outlook\.com$/;
const CONSUMER = {
  'gmail.com': 'google', 'googlemail.com': 'google',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft',
};
const IMAP_HOSTS = {
  'yahoo.com': ['yahoo', 'imap.mail.yahoo.com'], 'ymail.com': ['yahoo', 'imap.mail.yahoo.com'], 'rocketmail.com': ['yahoo', 'imap.mail.yahoo.com'],
  'icloud.com': ['icloud', 'imap.mail.me.com'], 'me.com': ['icloud', 'imap.mail.me.com'], 'mac.com': ['icloud', 'imap.mail.me.com'],
  'gmx.com': ['gmx', 'imap.gmx.com'], 'gmx.net': ['gmx', 'imap.gmx.net'], 'gmx.de': ['gmx', 'imap.gmx.net'],
  'aol.com': ['aol', 'imap.aol.com'], 'zoho.com': ['zoho', 'imap.zoho.com'], 'zohomail.eu': ['zoho', 'imap.zoho.eu'],
  'mail.ru': ['mailru', 'imap.mail.ru'], 'inbox.ru': ['mailru', 'imap.mail.ru'], 'list.ru': ['mailru', 'imap.mail.ru'], 'bk.ru': ['mailru', 'imap.mail.ru'],
};
// Hosts recognised from the MX record when the domain itself isn't a known mail brand.
const MX_HOSTS = [
  [/(^|\.)zoho\.(com|eu|in|com\.au|jp)$/, m => `imap.zoho.${m[2]}`, 'Zoho Mail'],
  [/(^|\.)messagingengine\.com$/, () => 'imap.fastmail.com', 'Fastmail'],
  [/(^|\.)privateemail\.com$/, () => 'mail.privateemail.com', 'Namecheap Private Email'],
  [/(^|\.)mxrouting\.net$/, null, null],
];
const APP_PW = 'Create an app password in your mail provider; some hosts need your normal password.';

const imapRes = (host, port, source, note, extra = {}) => ({ kind: 'imap', host, port, secure: port === 993, source, note, ...extra });

export function parseAutoconfig(xml, domain, email) {
  const txt = String(xml || '');
  const block = txt.match(/<incomingServer\b[^>]*type=["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/gi);
  if (!block) return null;
  const local = String(email || '').split('@')[0];
  const out = [];
  for (const b of block) {
    const tag = n => { const m = b.match(new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`, 'i')); return m ? m[1] : ''; };
    const host = cleanHost(tag('hostname').replace(/%EMAILDOMAIN%/gi, domain).replace(/%EMAILLOCALPART%/gi, local).replace(/%EMAILADDRESS%/gi, email || ''));
    const port = +tag('port'); const sock = tag('socketType').toUpperCase();
    if (!host || !(port === 993 || port === 143)) continue;
    if (sock === 'SSL' && port === 993) out.push({ host, port, rank: 0 });
    else if (sock === 'STARTTLS' && port === 143) out.push({ host, port, rank: 1 });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out[0] || null;
}

// ---------- main ----------
export async function discover(email, deps = {}) {
  const resolveMx = deps.resolveMx || (d => dnsp.resolveMx(d));
  const fetchImpl = deps.fetchText || fetchText;
  const probe = deps.probeImap || probeImap;
  const lookup = deps.lookup || dnsp.lookup;
  const p = parseEmail(email);
  if (!p) return { kind: 'manual', error: 'invalid', note: 'That does not look like a valid email address.' };
  const { domain } = p;

  // (a) well-known consumer providers
  if (CONSUMER[domain]) {
    const g = CONSUMER[domain] === 'google';
    return { kind: 'oauth', provider: CONSUMER[domain], source: 'known', note: g ? 'This is a Google account.' : 'This is a Microsoft account.' };
  }
  if (IMAP_HOSTS[domain]) {
    const [key, host] = IMAP_HOSTS[domain];
    return imapRes(host, 993, 'known', APP_PW, { providerKey: key });
  }

  // (b) MX records
  let mx = [];
  try { mx = (await resolveMx(domain)) || []; } catch { mx = []; }
  const mxHosts = mx.slice().sort((a, b) => a.priority - b.priority).map(m => String(m.exchange || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (mxHosts.some(h => GOOGLE_MX.test(h))) return { kind: 'oauth', provider: 'google', source: 'mx', note: 'Looks like Google Workspace.' };
  if (mxHosts.some(h => M365_MX.test(h))) return { kind: 'oauth', provider: 'microsoft', source: 'mx', note: 'Looks like Microsoft 365.' };

  // MX-based known hosts
  for (const h of mxHosts) for (const [re, fn, name] of MX_HOSTS) {
    const m = h.match(re); if (!m || !fn) continue;
    const host = fn(m);
    try { await resolveSafe(host, lookup); } catch { continue; }
    return imapRes(host, 993, 'mx', `Looks like ${name}. ${APP_PW}`);
  }

  // (c) Mozilla-style autoconfig
  const urls = [`https://autoconfig.thunderbird.net/v1.1/${domain}`, `https://autoconfig.${domain}/mail/config-v1.1.xml`, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`];
  for (const url of urls) {
    let xml = null; try { xml = await fetchImpl(url); } catch { /* next */ }
    const cfg = xml && parseAutoconfig(xml, domain, p.email);
    if (!cfg) continue;
    try { await resolveSafe(cfg.host, lookup); } catch { continue; }
    return imapRes(cfg.host, cfg.port, 'autoconfig', `Found your mail server settings. ${APP_PW}`);
  }

  // (d) guess common names and probe
  const bases = new Set([domain]);
  for (const h of mxHosts.slice(0, 2)) { const parts = h.split('.'); if (parts.length >= 2) bases.add(parts.slice(-2).join('.')); }
  const guesses = [];
  for (const b of bases) for (const pre of ['imap', 'mail']) guesses.push(`${pre}.${b}`);
  for (const host of guesses.slice(0, 6)) {
    try { await resolveSafe(host, lookup); } catch { continue; }
    if (await probe(host, 993, { lookup })) return imapRes(host, 993, 'guess', `Found a mail server at ${host}. ${APP_PW}`);
  }

  return { kind: 'manual', source: 'none', note: "We couldn't detect your mail server automatically. Ask your email host for the IMAP server name (usually imap.yourdomain.com) and port 993." };
}
