// Yahoo Mail, Mail.ru and other IMAP mailboxes, signed in with an app password.
// Reads the latest inbox mail and saves reply drafts into the Drafts folder. Never sends.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { clip, stripQuoted, htmlToText, ReauthError } from '../util.js';

const headerLine = (parsed, key) => {
  const l = (parsed?.headerLines || []).find(h => h.key === key);
  return l ? l.line.replace(/^[^:]+:\s*/, '').replace(/\r?\n\s+/g, ' ').trim() : '';
};
const encodeHeader = s => (/^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function makeImapProvider({ key, label, host, port = 993, webmail, draftsWeb }) {
  async function withClient(creds, fn) {
    const c = new ImapFlow({ host, port, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 45000 });
    try { await c.connect(); }
    catch (e) {
      const msg = `${e.message} ${e.responseText || ''}`;
      if (e.authenticationFailed || /auth|login|credential|password|invalid/i.test(msg)) throw new ReauthError(`${label} sign-in failed. Check the email address and use an app password, not your normal password.`);
      throw new Error(`${label}: couldn't reach the mail server (${e.message})`);
    }
    try { return await fn(c); } finally { try { await c.logout(); } catch { /* ignore */ } }
  }

  return {
    key, label, imap: true,
    configured: () => true,
    async verify(user, pass) {
      const email = String(user || '').trim().toLowerCase();
      if (!email || !pass) throw new Error('Enter your email address and app password.');
      await withClient({ user: email, pass }, c => c.mailboxOpen('INBOX', { readOnly: true }));
      return { email, name: '', tokens: { user: email, pass } };
    },
    refresh: async () => null,
    revoke: async () => {},

    // `known`: Map(uid -> cached message record). Envelope + flags are fetched for the latest `max` messages;
    // the full source (body) is downloaded only for uids that are not known yet.
    async fetchMessages(creds, { max, selfEmail, known = new Map() }) {
      max = Math.min(200, max || 200);
      return withClient(creds, async c => {
        const box = await c.mailboxOpen('INBOX', { readOnly: true });
        if (!box.exists) return [];
        const from = Math.max(1, box.exists - max + 1);
        const heads = [];
        for await (const m of c.fetch(`${from}:*`, { uid: true, flags: true, envelope: true, internalDate: true })) heads.push(m);
        const fresh = heads.filter(m => !known.has(String(m.uid)));
        const parsedBy = new Map();
        if (fresh.length) {
          for await (const m of c.fetch(fresh.map(m => m.uid).join(','), { uid: true, source: true }, { uid: true })) {
            try { parsedBy.set(String(m.uid), await simpleParser(m.source)); } catch { /* keep going */ }
          }
        }
        const out = heads.map(m => {
          const flags = m.flags || new Set();
          const k = known.get(String(m.uid));
          if (k) return { ...k, providerId: String(m.uid), unread: !flags.has('\\Seen'), replied: flags.has('\\Answered') };
          const parsed = parsedBy.get(String(m.uid)) || null;
          const f = m.envelope?.from?.[0] || {};
          const text = parsed ? (parsed.text || htmlToText(parsed.html || '')) : '';
          return {
            providerId: String(m.uid), threadId: m.envelope?.messageId || String(m.uid),
            fromName: f.name || f.address || 'Unknown', fromEmail: String(f.address || '').toLowerCase(),
            subject: m.envelope?.subject || '(no subject)',
            date: new Date(m.internalDate || m.envelope?.date || Date.now()).toISOString(),
            body: clip(stripQuoted(text), 6000), snippet: text.replace(/\s+/g, ' ').trim().slice(0, 160),
            unread: !flags.has('\\Seen'), replied: flags.has('\\Answered'),
            listUnsubscribe: !!headerLine(parsed, 'list-unsubscribe'),
            unsub: headerLine(parsed, 'list-unsubscribe'), unsubPost: headerLine(parsed, 'list-unsubscribe-post'),
            providerCategory: null, messageIdHeader: m.envelope?.messageId || '', link: webmail,
          };
        });
        return out.reverse().filter(x => x.fromEmail && x.fromEmail !== selfEmail);
      });
    },

    async fetchIndex(creds, { max, selfEmail }) {
      return withClient(creds, async c => {
        const box = await c.mailboxOpen('INBOX', { readOnly: true });
        if (!box.exists) return [];
        const from = Math.max(1, box.exists - max + 1);
        const out = [];
        for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, internalDate: true })) {
          const f = m.envelope?.from?.[0] || {};
          out.push({ providerId: String(m.uid), fromName: f.name || f.address || '', fromEmail: String(f.address || '').toLowerCase(), subject: m.envelope?.subject || '(no subject)', snippet: '', date: new Date(m.internalDate || Date.now()).toISOString() });
        }
        return out.reverse().filter(x => x.fromEmail && x.fromEmail !== selfEmail);
      });
    },

    // Latest Junk/Spam folder mail (read-only, for the spam memory).
    async fetchSpam(creds, { max = 30, selfEmail }) {
      return withClient(creds, async c => {
        const boxes = await c.list();
        const junk = boxes.find(b => b.specialUse === '\\Junk')?.path || boxes.find(b => /^(junk|spam|bulk)|нежелат|спам/i.test(b.name))?.path;
        if (!junk) return [];
        const box = await c.mailboxOpen(junk, { readOnly: true });
        if (!box.exists) return [];
        const from = Math.max(1, box.exists - max + 1), out = [];
        for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, internalDate: true, source: true })) {
          let parsed = null; try { parsed = await simpleParser(m.source); } catch { /* keep going */ }
          const f = m.envelope?.from?.[0] || {};
          const text = parsed ? (parsed.text || htmlToText(parsed.html || '')) : '';
          out.push({ providerId: String(m.uid), fromName: f.name || f.address || '', fromEmail: String(f.address || '').toLowerCase(), subject: m.envelope?.subject || '(no subject)', date: new Date(m.internalDate || Date.now()).toISOString(), body: clip(stripQuoted(text), 1500), snippet: text.replace(/\s+/g, ' ').trim().slice(0, 160), link: webmail });
        }
        return out.reverse().filter(x => x.fromEmail && x.fromEmail !== selfEmail);
      });
    },

    // Appends a reply to the Drafts folder. Never sends.
    async createDraft(creds, { to, subject, body, inReplyTo, selfEmail }) {
      return withClient(creds, async c => {
        const boxes = await c.list();
        const drafts = boxes.find(b => b.specialUse === '\\Drafts')?.path || boxes.find(b => /draft|черновик/i.test(b.name))?.path || 'Drafts';
        const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
        const lines = [`From: ${selfEmail}`, `To: ${to}`, `Subject: ${encodeHeader(subj)}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];
        if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
        await c.append(drafts, Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'utf8'), ['\\Draft', '\\Seen']);
        return { id: 'draft', link: draftsWeb || webmail };
      });
    },
  };
}

export const yahoo = makeImapProvider({ key: 'yahoo', label: 'Yahoo', host: 'imap.mail.yahoo.com', webmail: 'https://mail.yahoo.com/', draftsWeb: 'https://mail.yahoo.com/d/folders/3' });
export const mailru = makeImapProvider({ key: 'mailru', label: 'Mail.ru', host: 'imap.mail.ru', webmail: 'https://e.mail.ru/inbox/', draftsWeb: 'https://e.mail.ru/drafts/' });
export const icloud = makeImapProvider({ key: 'icloud', label: 'iCloud', host: 'imap.mail.me.com', webmail: 'https://www.icloud.com/mail' });
export const gmx = makeImapProvider({ key: 'gmx', label: 'GMX', host: 'imap.gmx.com', webmail: 'https://www.gmx.com/' });
export const aol = makeImapProvider({ key: 'aol', label: 'AOL', host: 'imap.aol.com', webmail: 'https://mail.aol.com/' });
export const zoho = makeImapProvider({ key: 'zoho', label: 'Zoho', host: 'imap.zoho.com', webmail: 'https://mail.zoho.com/' });
