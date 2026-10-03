// Run: node server/providers/discover.test.mjs [--net]
import assert from 'node:assert/strict';
import { discover, isPrivateIp, resolveSafe, parseAutoconfig, parseEmail, cleanHost } from './discover.js';

const mx = list => async () => list.map((e, i) => ({ exchange: e, priority: (i + 1) * 10 }));
const pub = async () => [{ address: '93.184.216.34', family: 4 }];
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

const XML = `<?xml version="1.0"?><clientConfig><emailProvider id="x"><incomingServer type="pop3"><hostname>pop.%EMAILDOMAIN%</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
<incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
<incomingServer type="imap"><hostname>mx.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer></emailProvider></clientConfig>`;

await t('known consumer: gmail -> google oauth', async () => assert.deepEqual((await discover('a@gmail.com')).provider, 'google'));
await t('known consumer: hotmail -> microsoft oauth', async () => assert.equal((await discover('a@hotmail.com')).provider, 'microsoft'));
await t('known imap: yahoo', async () => { const r = await discover('a@yahoo.com'); assert.equal(r.kind, 'imap'); assert.equal(r.host, 'imap.mail.yahoo.com'); assert.equal(r.providerKey, 'yahoo'); });
await t('known imap: icloud', async () => assert.equal((await discover('a@icloud.com')).host, 'imap.mail.me.com'));
await t('Google Workspace MX', async () => { const r = await discover('me@startup.io', { resolveMx: mx(['aspmx.l.google.com.', 'alt1.aspmx.l.google.com.']) }); assert.equal(r.kind, 'oauth'); assert.equal(r.provider, 'google'); });
await t('Google MX (smtp.google.com)', async () => assert.equal((await discover('me@startup.io', { resolveMx: mx(['smtp.google.com']) })).provider, 'google'));
await t('Microsoft 365 MX', async () => { const r = await discover('me@startup.io', { resolveMx: mx(['startup-io.mail.protection.outlook.com']) }); assert.equal(r.provider, 'microsoft'); });
await t('lookalike MX is NOT google', async () => { const r = await discover('me@startup.io', { resolveMx: mx(['aspmx.l.google.com.evil.net']), fetchText: async () => null, probeImap: async () => false, lookup: pub }); assert.equal(r.kind, 'manual'); });
await t('autoconfig XML (prefers SSL 993)', async () => {
  const urls = [];
  const r = await discover('me@acme.dev', { resolveMx: mx(['mail.acme.dev']), lookup: pub, fetchText: async u => { urls.push(u); return u.includes('thunderbird') ? null : XML; }, probeImap: async () => { throw new Error('should not probe'); } });
  assert.deepEqual([r.kind, r.host, r.port, r.secure, r.source], ['imap', 'mx.acme.dev', 993, true, 'autoconfig']);
  assert.match(urls[0], /^https:\/\/autoconfig\.thunderbird\.net\/v1\.1\/acme\.dev$/);
  assert.ok(urls.every(u => u.startsWith('https://')));
});
await t('parseAutoconfig ignores plain/odd ports', async () => assert.equal(parseAutoconfig('<incomingServer type="imap"><hostname>h.example.com</hostname><port>143</port><socketType>plain</socketType></incomingServer>', 'example.com', 'a@example.com'), null));
await t('guess + probe', async () => {
  const probed = [];
  const r = await discover('me@acme.dev', { resolveMx: mx([]), lookup: pub, fetchText: async () => null, probeImap: async h => { probed.push(h); return h === 'mail.acme.dev'; } });
  assert.deepEqual([r.kind, r.host, r.source], ['imap', 'mail.acme.dev', 'guess']); assert.deepEqual(probed, ['imap.acme.dev', 'mail.acme.dev']);
});
await t('manual fallback', async () => { const r = await discover('me@acme.dev', { resolveMx: mx([]), lookup: pub, fetchText: async () => null, probeImap: async () => false }); assert.equal(r.kind, 'manual'); });
await t('MX lookup failure still falls through', async () => { const r = await discover('me@acme.dev', { resolveMx: async () => { throw new Error('ENOTFOUND'); }, lookup: pub, fetchText: async () => null, probeImap: async () => false }); assert.equal(r.kind, 'manual'); });

// SSRF
for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.9', '172.20.0.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe'])
  await t('private ip blocked ' + ip, async () => assert.equal(isPrivateIp(ip), true));
for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) await t('public ip allowed ' + ip, async () => assert.equal(isPrivateIp(ip), false));
for (const addr of ['127.0.0.1', '10.0.0.5', '169.254.169.254']) {
  await t('DNS rebinding style host -> ' + addr + ' rejected', async () => await assert.rejects(resolveSafe('evil.example.com', async () => [{ address: addr, family: 4 }]), /private/));
  await t('mixed public+private answers rejected ' + addr, async () => await assert.rejects(resolveSafe('evil.example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: addr, family: 4 }]), /private/));
}
await t('IP literal host rejected', async () => await assert.rejects(resolveSafe('169.254.169.254'), /private/));
await t('autoconfig host resolving privately is skipped -> manual', async () => {
  const r = await discover('me@acme.dev', { resolveMx: mx([]), lookup: async () => [{ address: '10.0.0.8', family: 4 }], fetchText: async () => XML, probeImap: async () => true });
  assert.equal(r.kind, 'manual');
});
await t('MX pointing at private host never probed', async () => {
  const r = await discover('me@acme.dev', { resolveMx: mx(['mx.internal.corp']), lookup: async () => [{ address: '127.0.0.1', family: 4 }], fetchText: async () => null, probeImap: async () => { throw new Error('probed'); } });
  assert.equal(r.kind, 'manual');
});

// validation
for (const bad of ['', 'nope', 'a@b', 'a@localhost', 'a@-x.com', 'a b@x.com', 'a@x..com', 'a@@x.com', 'a@127.0.0.1', 'a@[::1]', 'a@x.com\r\nBcc: z@z.com', 'a@' + 'x'.repeat(300) + '.com', null, 42])
  await t('bad email rejected ' + JSON.stringify(bad)?.slice(0, 30), async () => { assert.equal(parseEmail(bad), null); assert.equal((await discover(bad)).kind, 'manual'); });
await t('cleanHost', async () => { assert.equal(cleanHost('IMAP.Acme.dev.'), 'imap.acme.dev'); assert.equal(cleanHost('localhost'), null); assert.equal(cleanHost('a_b.com'), null); });

if (process.argv.includes('--net')) {
  const g = await discover('someone@google.com'); console.log('net google.com ->', g.kind, g.provider || g.host); assert.equal(g.provider, 'google');
  const m = await discover('someone@microsoft.com'); console.log('net microsoft.com ->', m.kind, m.provider || m.host); assert.equal(m.provider, 'microsoft');
  const f = await discover('someone@fastmail.com'); console.log('net fastmail.com ->', f.kind, f.host, f.source);
  const p = await discover('someone@posteo.de'); console.log('net posteo.de ->', p.kind, p.host, p.source);
}
console.log(`\n${n} checks passed`);
