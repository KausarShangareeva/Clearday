// Offline rehearsal provider (DEV_MOCK=1). Pretends to be a mailbox so the live code path
// can be tested without Google/Microsoft credentials.
export const label = 'Mock';
export const configured = () => process.env.DEV_MOCK === '1';
export const authUrl = state => `/auth/mock/callback?code=mock&state=${encodeURIComponent(state)}`;
export const exchange = async () => ({ email: `you+${Math.random().toString(36).slice(2, 6)}@example.com`, name: 'Mock User', tokens: { access_token: 'x', expires_at: Date.now() + 1e9 } });
export const refresh = async () => null;
export const revoke = async () => {};
const h = n => new Date(Date.now() - n * 3600e3).toISOString();

// Compact definition: T(from name, from email, subject, body, hoursAgo, { unsub, cat, rep, unread })
const T = (n, e, s, b, hrs, o = {}) => ({ n, e, s, b, hrs, ...o });
const BASE = [
  T('Jana Novak', 'jana@acme.io', 'Contract review by Thursday?', 'Hi! Could you review the attached contract and send comments by Thursday? Thanks, Jana', 2),
  T('Tech Weekly', 'news@techweekly.io', 'This week in AI agents', 'Agents everywhere. Three launches this week...', 5, { unsub: true }),
  T('Shop', 'deals@shop.com', '50% off today only', 'Sale!', 7, { unsub: true, cat: 'promotions', unread: false }),
  T('Leo', 'leo@gmail.com', 'Lunch?', 'Lunch tomorrow at 12?', 20, { rep: true, unread: false }),
  T('Prof. Lindqvist', 'lindqvist@kth.se', 'Thesis meeting moved to Friday 10:00', 'Hi, can we move our thesis meeting to Friday at 10:00 in room D2? Please confirm and send me your latest draft beforehand.', 3),
  T('Nordbank', 'security@nordbank.se', 'New sign-in to your account', 'We noticed a sign-in from a new device in Stockholm. If this was not you, block your card in the app.', 4),
  T('Maria (Startup)', 'maria@pitchlab.co', 'Investor intro - are you free next week?', 'An investor friend wants to meet you. Are you free Tuesday or Wednesday afternoon? Let me know and I will connect you.', 9),
  T('Invoice Bot', 'noreply@cloudhost.com', 'Invoice #4821: 49 EUR due Oct 10', 'Your invoice of 49 EUR is due on 2026-10-10.', 11, { unread: false }),
  T('Agentic AI Meetup', 'events@agentic.ai', 'Founders meetup Thursday 18:00', 'Join us Thursday at 18:00 at Epicenter, Stockholm. Talks, then demos and drinks.', 13, { unsub: true, unread: false }),
  T('Anna', 'anna@gmail.com', 'Dinner Saturday?', 'Are you coming to dinner on Saturday? We eat at 19:00.', 26),
  // login codes, OTPs and security alerts
  T('Google', 'no-reply@accounts.google.com', 'Your Google verification code is 482913', 'Your verification code is 482913. Do not share this code with anyone. It expires in 10 minutes.', 1),
  T('GitHub', 'noreply@github.com', 'Your GitHub login code: 771204', 'Use the one-time password 771204 to sign in to GitHub. If you did not request this, change your password.', 2),
  T('Microsoft account', 'account-security-noreply@accountprotection.microsoft.com', 'Security code for your Microsoft account', 'Your security code is 305518. Enter this code to verify your sign-in.', 6),
  T('Stripe', 'notifications@stripe.com', 'Your Stripe sign-in OTP', 'Your OTP is 918273. It is valid for 5 minutes.', 8),
  T('Nordbank', 'security@nordbank.se', 'One-time password for your card payment', 'Your one-time password is 640019. Never share it with anyone, the bank will not ask for it.', 12),
  T('LinkedIn', 'security-noreply@linkedin.com', 'Here is your LinkedIn verification code 224488', 'Your verification code is 224488. Enter it to confirm your sign-in.', 15),
  T('Apple', 'no_reply@email.apple.com', 'Apple ID sign-in attempt from a new device', 'Someone tried to sign in to your Apple ID from a new device. Your Apple ID code is 553120.', 18),
  T('Dropbox', 'no-reply@dropbox.com', 'Security alert: new login to your account', 'We noticed a new login from Chrome on Linux. If this was not you, reset your password.', 30),
  T('Slack', 'feedback@slack.com', 'Your Slack confirmation code: 903-776', 'Confirmation code: 903776. Enter it in your browser to join the workspace.', 40),
  // orders, receipts, shipping
  T('Amazon', 'auto-confirm@amazon.com', 'Your order #114-77231 has shipped', 'Your order has shipped. Tracking number SE88231977. Estimated delivery Friday.', 3),
  T('PostNord', 'noreply@postnord.se', 'Package out for delivery today', 'Your package is out for delivery today between 14:00 and 18:00. Tracking number PN55120.', 5),
  T('Spotify', 'no-reply@spotify.com', 'Your receipt from Spotify', 'Thanks for your payment. Receipt: Premium 1 month, 119 SEK, paid with Visa ending 4242.', 24),
  T('Apple', 'no_reply@email.apple.com', 'Your receipt from Apple', 'Receipt for your purchase: iCloud+ 50 GB, 9 SEK. Order ID MQ8213.', 36),
  T('Uber', 'uber.us@uber.com', 'Your Thursday trip receipt', 'Thanks for riding. Total 142 SEK. Trip receipt attached.', 50),
  T('Klarna', 'noreply@klarna.com', 'Invoice due in 3 days', 'Your Klarna invoice of 899 SEK is due on 2026-10-06.', 10),
  T('Vattenfall', 'noreply@vattenfall.se', 'Your electricity invoice for September', 'Invoice 2026-09: 412 SEK, due 2026-10-15. Pay in the app.', 22),
  T('IKEA', 'ikea@email.ikea.se', 'Your order is ready for pick-up', 'Your order 77123 is ready to collect at IKEA Kungens Kurva.', 25),
  // promos and social
  T('Zalando', 'info@mail.zalando.se', '30% off sneakers this weekend only', 'Save up to 30% on sneakers. Limited time offer. Free shipping over 499 SEK.', 4, { unsub: true, cat: 'promotions' }),
  T('H&M', 'hello@email.hm.com', 'Big sale: up to 50% off', 'The summer sale continues. Discount codes inside. Do not miss it!', 7, { unsub: true, cat: 'promotions' }),
  T('Booking.com', 'customer.service@mail.booking.com', 'Deal alert: Stockholm hotels from 79 EUR', 'Exclusive deals for your next trip. Offer ends Sunday.', 14, { unsub: true, cat: 'promotions' }),
  T('Wolt', 'hello@wolt.com', 'Free delivery on your next order', 'Use coupon FREEDEL for free shipping this week.', 28, { unsub: true, cat: 'promotions' }),
  T('Adobe', 'mail@mail.adobe.com', 'Save 40% on Creative Cloud', 'Limited time promo: save 40% for the first year.', 33, { unsub: true, cat: 'promotions' }),
  T('LinkedIn', 'notifications-noreply@linkedin.com', 'You appeared in 12 searches this week', 'See who is looking at your profile. 3 new connection suggestions.', 9, { cat: 'social' }),
  T('Facebook', 'notification@facebookmail.com', 'Leo tagged you in a photo', 'Leo Nilsson tagged you in a photo.', 11, { cat: 'social' }),
  T('Instagram', 'no-reply@mail.instagram.com', 'anna_k and 4 others liked your post', 'You have 5 new likes.', 17, { cat: 'social' }),
  T('Reddit', 'noreply@redditmail.com', 'Trending in r/startups', 'Top posts you may like.', 25, { cat: 'social' }),
  // newsletters
  T('Hacker Newsletter', 'kale@hackernewsletter.com', 'Hacker Newsletter #712', 'The best of Hacker News this week: a database written in Rust, why SQLite is everywhere, and more.', 12, { unsub: true }),
  T('Stratechery', 'email@stratechery.com', 'The AI Agent Layer', 'This week: where value accrues as agents start using software on our behalf. Reading time 9 minutes.', 16, { unsub: true }),
  T('Morning Brew', 'crew@morningbrew.com', 'Markets rally as rates hold', 'Your daily business newsletter. Markets rally as central bank holds rates.', 20, { unsub: true }),
  T('TLDR', 'dan@tldrnewsletter.com', 'TLDR 2026-10-01: new open model, Postgres 19', 'Big tech and programming news in 5 minutes.', 26, { unsub: true }),
  T('The Pragmatic Engineer', 'pragmaticengineer@substack.com', 'How Big Tech runs incident reviews', 'A deep dive into incident review culture across big tech companies.', 44, { unsub: true }),
  T('Product Hunt', 'hello@producthunt.com', 'Today on Product Hunt', 'The top 10 launches of the day.', 48, { unsub: true }),
  T('Notion', 'team@makenotion.com', 'New features in Notion', 'Meet the new Notion AI. Read more on our blog.', 55, { unsub: true }),
  // university
  T('Prof. Lindqvist', 'lindqvist@kth.se', 'Re: Thesis draft feedback', 'Thanks for the draft. Chapter 3 needs a clearer research question. Can we discuss it on Friday?', 8),
  T('KTH Registrar', 'noreply@kth.se', 'Exam registration closes Oct 12', 'Register for the January exams before 2026-10-12 in the student portal. Please confirm that your course choices are correct.', 19),
  T('Course team', 'course-ds@kth.se', 'Lab 2 deadline extended to Monday', 'The deadline for Lab 2 is extended to Monday 23:59. Please submit via Canvas.', 29),
  T('Mika', 'mika.j@student.kth.se', 'Study group tonight?', 'Are you coming to the study group at 18:00? We meet in the library.', 21),
  // work
  T('Jonas Ek', 'jonas.ek@haldengroup.se', 'Q3 report: need your numbers by Wednesday', 'Hi, please send me your section of the Q3 report by Wednesday noon. Thanks.', 6),
  T('Petra Lund', 'petra.lund@haldengroup.se', 'Meeting notes from yesterday', 'Notes attached. Action: you own the dashboard prototype. No rush this week.', 27, { rep: true }),
  T('HR Halden', 'hr@haldengroup.se', 'Reminder: submit your timesheet', 'Please submit your timesheet before Friday 16:00.', 35),
  T('Omar Haddad', 'omar.haddad@haldengroup.se', 'Customer call Tuesday 14:00', 'Can you join the customer call on Tuesday at 14:00? Let me know.', 13),
  // startup
  T('Maria Okafor', 'maria@northwind.vc', 'Following up on our intro call', 'Great talking last week. Could you send the updated deck and your metrics before next Tuesday?', 5),
  T('Sam Lee', 'sam@clinicflow.io', 'Staging build is up', 'The new onboarding is on staging. Can you check the step 2 copy?', 10),
  T('Helena Strand', 'helena.strand@brightside.se', 'Pilot feedback: two bugs', 'The pilot is going well but we hit two bugs in the booking flow. Can you take a look this week?', 31),
  T('Erik Sandberg', 'erik@sandberg.vc', 'Intro to a seed investor', 'I would like to introduce you to a seed investor. Are you free Thursday afternoon?', 23),
  // personal
  T('Mum', 'helen.morgan@gmail.com', 'Sunday lunch?', 'Are you coming for lunch on Sunday? Dad is making his famous soup.', 9),
  T('Leo Nilsson', 'leo.nilsson@gmail.com', 'Climbing on Saturday?', 'Want to go climbing on Saturday morning? Let me know.', 14),
  T('Anna', 'anna@gmail.com', 'Photos from the weekend', 'Here are the photos from the weekend, they turned out great!', 52, { unread: false }),
  T('Nordrail', 'booking@nordrail.se', 'Your ticket to Gothenburg', 'Booking confirmed: Stockholm to Gothenburg, Friday 07:12. Booking ref NR4421.', 37),
  T('Stockholm AI Founders', 'events@stockholmaifounders.se', 'Meetup: agents in production, Oct 14', 'Join us on 2026-10-14 at 18:00 for a meetup on agents in production.', 18, { unsub: true }),
  // automated notifications
  T('Figma', 'noreply@figma.com', 'Maria commented on Clinicflow UI', 'Maria left a comment on the file Clinicflow UI: "can we try a larger button here?"', 15),
  T('Calendar', 'calendar-notification@google.com', 'Reminder: Thesis meeting at 10:00', 'Event reminder: Thesis meeting, Friday 10:00 to 11:00.', 41),
  T('Vercel', 'notifications@vercel.com', 'Deployment failed for clinicflow-web', 'The latest deployment failed. Open the build log to see the error.', 2),
  T('Sentry', 'noreply@md.getsentry.com', '12 new errors in clinicflow-api', 'New issue: TypeError in booking handler. 12 events in the last hour.', 3),
  T('Cloudflare', 'noreply@notify.cloudflare.com', 'Your certificate renews in 7 days', 'Automatic renewal of your SSL certificate is scheduled.', 46),
  T('Skatteverket', 'noreply@skatteverket.se', 'You have a new message in your inbox', 'A new document is available in your tax account. Log in to read it.', 60),
];

// Dev helper (see /api/dev/mock/add in server/index.js): simulate brand-new mail arriving after the first sync.
let added = 0;
export const addMail = n => { added += Math.max(0, Math.min(50, +n || 0)); return added; };
export const resetMail = () => { added = 0; };

const COUNT = () => Math.min(200, Math.max(BASE.length, +process.env.MOCK_COUNT || BASE.length));
function mk(t, i, subject, hrs) {
  return {
    providerId: `m${i + 1}`, threadId: `t${i + 1}`, fromName: t.n, fromEmail: t.e, subject, date: h(hrs), body: t.b,
    snippet: t.b.slice(0, 90), unread: t.unread ?? i % 3 !== 0, replied: !!t.rep, listUnsubscribe: !!t.unsub,
    providerCategory: t.cat || null, link: 'https://example.com',
  };
}
function all() {
  const out = [];
  for (let i = 0; i < COUNT(); i++) {
    const t = BASE[i % BASE.length], round = Math.floor(i / BASE.length);
    out.push(mk(t, i, round ? `${t.s} (${round + 1})` : t.s, t.hrs + round * 70));
  }
  for (let k = 0; k < added; k++) { // newest mail, always on top
    const t = BASE[(k * 7 + 10) % BASE.length];
    out.push({ ...mk(t, 1000 + k, `${t.s} [new ${k + 1}]`, 0.05 + k * 0.01), unread: true, replied: false });
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}
// `known`: Map(providerId -> cached record from the user's snapshot). Known ids are rebuilt from the cache
// (only unread / replied are refreshed), mirroring what the real providers do to skip the body download.
export async function fetchMessages(token, { max = 200, known = new Map() } = {}) {
  return all().slice(0, Math.min(200, max)).map(m => {
    const k = known.get(m.providerId);
    return k ? { ...k, providerId: m.providerId, unread: m.unread, replied: k.replied || m.replied } : m;
  });
}
export async function createDraft() { return { id: 'd1', link: 'https://example.com/drafts' }; }
export async function fetchIndex() { return all().map(m => ({ providerId: m.providerId, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, snippet: m.snippet, date: m.date })); }
