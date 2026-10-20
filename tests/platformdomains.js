'use strict';
// ── A PLATFORM'S OWN ADDRESS IS NEVER THE BUSINESS'S ────────────────────────
//
// The email finder put ce@squareup.com on the card for "Eyebrows by Corrina".
// squareup.com is Square's own domain. An address at a platform's domain is
// never the business's email.
//
//   0. The list (services/websiteValidation): the platforms' company domains,
//      exported next to PLATFORM_HOSTS, and platformDomainOf.
//   1. The email finder: never returns, verifies or builds one; no Hunter
//      credit spent on one.
//   2. The send gate: refuses one with "Not sent: <domain> is the platform's
//      address, not the business's. Call them instead: <phone>.", on every
//      send path, whether SEND_GATE_ON is set or not.
//   3. Admin script platform-address-audit: read-only by default, lists live
//      cards by agent; apply stops them.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('platformdomaintest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.SEND_GATE_ON;
delete process.env.EMAIL_FIVE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const WV = require(ROOT + 'server/services/websiteValidation.js');
const EF = require(ROOT + 'server/services/emailFinder.js');
const SG = require(ROOT + 'server/services/sendGate.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const { checkDomain } = require(ROOT + 'server/services/domainGate.js');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g) : '')); } };
const on = () => { process.env.SEND_GATE_ON = '1'; };
const off = () => { delete process.env.SEND_GATE_ON; };
const AG = 'pd-agent', AG2 = 'pd-agent2', ATH = 'pd-ath';
const SQUARE_MSG = "Not sent: squareup.com is the platform's address, not the business's. Call them instead: 205-555-0100.";

// ── 0. THE LIST ─────────────────────────────────────────────────────────────
function list() {
  console.log('\n0. THE LIST');
  const want = ['squareup.com', 'square.com', 'wix.com', 'squarespace.com', 'shopify.com', 'godaddy.com', 'weebly.com',
    'vagaro.com', 'booksy.com', 'styleseat.com', 'mindbodyonline.com', 'toasttab.com', 'clover.com', 'google.com',
    'facebook.com', 'instagram.com', 'yelp.com'];
  ok('PLATFORM_COMPANY_DOMAINS is exported', Array.isArray(WV.PLATFORM_COMPANY_DOMAINS));
  const missing = want.filter((d) => !WV.PLATFORM_COMPANY_DOMAINS.includes(d));
  ok('  it has every platform company domain asked for', !missing.length, missing);
  const src = fs.readFileSync(ROOT + 'server/services/websiteValidation.js', 'utf8');
  ok('  it sits next to PLATFORM_HOSTS', Math.abs(src.indexOf('const PLATFORM_COMPANY_DOMAINS') - src.indexOf('const PLATFORM_HOSTS')) < 2000);
  for (const d of want) ok(`  x@${d} is a platform address`, WV.platformDomainOf('x@' + d) === d, WV.platformDomainOf('x@' + d));
  ok('ce@squareup.com -> squareup.com', WV.platformDomainOf('ce@squareup.com') === 'squareup.com');
  ok('  any case, any spacing', WV.platformDomainOf('  CE@SquareUp.com ') === 'squareup.com');
  ok('  a subdomain counts (x@mail.squareup.com)', WV.platformDomainOf('x@mail.squareup.com') === 'squareup.com');
  ok('a PLATFORM_HOSTS domain counts (x@corrina.square.site)', WV.platformDomainOf('x@corrina.square.site') === 'square.site');
  ok('  and myshopify.com', WV.platformDomainOf('shop@store.myshopify.com') === 'myshopify.com');
  ok('a SOCIAL_HOSTS domain counts (x@linktr.ee)', WV.platformDomainOf('x@linktr.ee') === 'linktr.ee');
  ok('a bare domain or URL works too', WV.platformDomainOf('squareup.com') === 'squareup.com' && WV.platformDomainOf('https://www.vagaro.com/corrina') === 'vagaro.com');
  ok("the business's own domain is not one", WV.platformDomainOf('corrina@eyebrowsbycorrina.com') === null);
  ok('a name that only contains one is not one (notsquareup.com)', WV.platformDomainOf('a@notsquareup.com') === null);
  ok('gmail.com is not google.com', WV.platformDomainOf('corrina@gmail.com') === null);
  ok('nothing in, null out', WV.platformDomainOf('') === null && WV.platformDomainOf(null) === null);
}

// ── 1. THE EMAIL FINDER ─────────────────────────────────────────────────────
function stubDeps(o = {}) {
  const calls = { verify: [], domainSearch: [], emailFinder: [], resolve: [], site: [] };
  return {
    calls,
    verify: async (e) => { calls.verify.push(e); return { result: 'valid', status: 'valid', source: 'hunter' }; },
    peek: async () => new Map(),
    domainSearch: async (d) => { calls.domainSearch.push(d); return o.hunter || null; },
    emailFinder: async (f, l, d) => { calls.emailFinder.push(`${f} ${l} @ ${d}`); return o.finder || { email: null }; },
    resolveDomain: async (b) => { calls.resolve.push(b); return o.resolved || { website: null, tried: [] }; },
    checkDomain,
    siteEmail: async (w) => { calls.site.push(w); return null; },
    corporate: (d, b, out) => EF.corporateDomain(d, b, out),
  };
}
const corrina = (extra) => ({ name: 'Corrina Lane', title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: null, ...(extra || {}) });
const finish = (ladder, d, extra = {}) => EF.finishLadder({ ladder, out: extra.out || { website: null },
  ig: { instagram: 'eyebrowsbycorrina', instagramScope: 'business' }, brand: 'Eyebrows by Corrina', region: 'Tuscaloosa, AL', place: null, Q, ...extra }, d);

async function finder() {
  console.log('\n1. THE EMAIL FINDER');
  {
    const d = stubDeps({ finder: { email: 'corrina.lane@squareup.com' } });
    const r = await EF.find({ name: 'Corrina Lane', domain: 'squareup.com' }, d);
    ok('find on squareup.com: nothing returned', r.email === null && /platform/.test(r.stop || ''), r);
    ok('  no Hunter search, no Email Finder, no verification', !d.calls.domainSearch.length && !d.calls.emailFinder.length && !d.calls.verify.length, d.calls);
    ok('  no credit counted', r.credits.search === 0 && r.credits.verify === 0, r.credits);
  }
  {
    // THE BUG: Square's address on Corrina's row, as the ladder read it.
    const L = { tiers: [{ tier: 1, rows: [corrina({ email: 'ce@squareup.com', emailKind: 'published' })] }], businessDomain: null };
    ok('fixture: before the finder, the card would email ce@squareup.com', (Q.inboxOf(L) || {}).email === 'ce@squareup.com', Q.inboxOf(L));
    const d = stubDeps();
    const r = await finish(L, d);
    ok('finishLadder: ce@squareup.com is never verified', !d.calls.verify.includes('ce@squareup.com'), d.calls.verify);
    ok('  it is marked refused, saying why', r.verify && r.verify.pass === false && /squareup\.com is the platform's address, not the business's/.test(r.verify.why || ''), r.verify);
    ok('  the card no longer uses it', !Q.inboxOf(L) && r.after !== 'email', { inbox: Q.inboxOf(L), after: r.after });
    ok('  no Hunter search on squareup.com', !d.calls.domainSearch.includes('squareup.com') && !d.calls.emailFinder.some((x) => /squareup/.test(x)), d.calls);
  }
  {
    // The ladder's business domain is Square's: no search, no built guess.
    const L = { tiers: [{ tier: 1, rows: [corrina()] }], businessDomain: 'squareup.com' };
    const d = stubDeps({ hunter: { pattern: '{first}', emails: [] } });
    const r = await finish(L, d);
    ok("a platform business domain is not the business's: nothing built on it", !(r.finder && r.finder.email), r.finder);
    ok('  no credit spent on it', !d.calls.verify.some((e) => /squareup/.test(e)) && !d.calls.domainSearch.includes('squareup.com') && !d.calls.emailFinder.some((x) => /squareup/.test(x)), d.calls);
  }
  {
    // A Square site: square.site is a platform host, not the business's domain.
    const L = { tiers: [{ tier: 1, rows: [corrina()] }], businessDomain: null };
    const d = stubDeps();
    const r = await finish(L, d, { out: { website: 'https://eyebrowsbycorrina.square.site' } });
    ok('a square.site page is not a domain to build addresses on', !d.calls.verify.some((e) => /square\.site/.test(e)) && !d.calls.domainSearch.some((x) => /square/.test(x)), d.calls);
    ok('  no address comes of it', !(r.finder && r.finder.email), r.finder);
  }
  {
    // A role address at the platform does not name the business's domain.
    const L = { tiers: [{ tier: 1, rows: [corrina()] }, { tier: 4, rows: [{ name: null, email: 'support@vagaro.com', emailKind: 'published' }] }], businessDomain: null };
    const d = stubDeps();
    await finish(L, d);
    ok("support@vagaro.com does not make vagaro.com the business's domain", !d.calls.domainSearch.includes('vagaro.com') && !d.calls.verify.some((e) => /vagaro/.test(e)), d.calls);
  }
  {
    const row = corrina();
    const L = { tiers: [{ tier: 1, rows: [row] }] };
    const put = EF.attachTo(L, row, { email: 'corrina@squareup.com', kind: 'hunter', verdict: 'valid' }, Q);
    ok('attachTo refuses a platform address', put === false && !row.email, row.email);
  }
  {
    // The real deps spend nothing on a platform domain, even when called.
    const live = EF.liveDeps(store.pool, { source: 'test' });
    ok('liveDeps domainSearch(squareup.com): null, no call', (await live.domainSearch('squareup.com')) === null);
    ok('liveDeps emailFinder(.., squareup.com): null, no call', (await live.emailFinder('Corrina', 'Lane', 'squareup.com')) === null);
    const before = Number((await store.pool.query(`SELECT COUNT(*) AS n FROM email_verify_credit_log`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
    const v = await live.verify('ce@squareup.com');
    const after = Number((await store.pool.query(`SELECT COUNT(*) AS n FROM email_verify_credit_log`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
    ok('liveDeps verify(ce@squareup.com): not run, not valid', v && v.result !== 'valid' && v.notRun, v);
    ok('  and no Hunter credit logged for it', after === before, { before, after });
  }
}

// ── 2. THE SEND GATE ────────────────────────────────────────────────────────
async function seedBase(P) {
  for (const [id, email, name] of [[AG, 'pd@agency.com', 'Dana Agent'], [AG2, 'pd2@agency.com', 'Other Agent']]) {
    await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,$2,$3,'x','agent','America/Chicago')`, [id, name, email]);
    await P.query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [id]);
  }
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-09-02' })]);
}
let _n = 0;
async function draft(P, o) {
  const id = o.id || ('pd-' + (++_n));
  await P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, approved_at, scheduled_send_at,
                                sent_to_email, touch_no, parent_id, source, contact_name, sent_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'<p>Hi Corrina,</p><p>A real idea for your shop and our athlete.</p>',$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())`,
    [id, o.agent || AG, o.athlete || ATH, o.brand, 'name:' + o.brand.toLowerCase(), o.subject || 'Quick idea for ' + o.brand,
      o.status || 'approved', o.status === 'draft' ? null : new Date(Date.now() - 3600000), o.status === 'draft' ? null : new Date(Date.now() - 60000),
      o.email || null, o.touch || 1, o.parent || null, o.source || 'nightly-queue', o.contact || null, o.sentAt || null]);
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
                 VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
    ['name:' + o.brand.toLowerCase(), o.brand, JSON.stringify({ primaryType: 'beauty_salon', types: ['beauty_salon', 'store'] })]).catch(() => {});
  return id;
}
async function card(P, o) {
  const r = await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, brand_name, brand_key, channel, state, contact_name, phone, instagram, instagram_scope, outreach_log_id, slot, email, email_verified, sent_at)
     VALUES ($1,$2,$3,$12,'email',$13,$4,$5,$6,$7,$8,$9,$10,$11,$14) RETURNING id`,
    [o.agent || AG, o.athlete || ATH, o.brand, o.contact || null, o.phone || null, o.instagram || null, o.instagram ? 'business' : null,
      o.log || null, o.slot || 1, o.email || null, false, 'name:' + o.brand.toLowerCase(), o.state || 'queued', o.sentAt || null]);
  return r.rows[0].id;
}
const row = async (P, id) => (await P.query(`SELECT * FROM outreach_logs WHERE id=$1`, [id])).rows[0];
const qrow = async (P, id) => (await P.query(`SELECT * FROM outreach_queue WHERE id=$1`, [id])).rows[0];

async function gateRule() {
  console.log('\n2a. THE RULE');
  const p = SG.addressProblem('ce@squareup.com', 'Corrina Lane');
  ok('ce@squareup.com: refused as the platform\'s', p && p.code === 'platform' && p.domain === 'squareup.com', p);
  ok("  why: squareup.com is the platform's address, not the business's", p && p.why === "squareup.com is the platform's address, not the business's", p && p.why);
  ok('  refused even typed by hand', (SG.addressProblem('hello@wix.com', null, { typed: true }) || {}).code === 'platform');
  ok('  refused even with a matching name (corrina@vagaro.com)', (SG.addressProblem('corrina@vagaro.com', 'Corrina Lane') || {}).code === 'platform');
  off();
  ok('the gate runs for a platform address with SEND_GATE_ON off', SG.runsFor('ce@squareup.com') === true);
  ok('  and not for any other address with it off (unchanged)', SG.runsFor('corrina@eyebrowsbycorrina.com') === false);
  on();
  ok('  on: it runs for every address, as before', SG.runsFor('corrina@eyebrowsbycorrina.com') === true);
  off();
  const pk = await SG.peek(store.pool, 'ce@squareup.com', 'Corrina Lane');
  ok('peek says Not verified, with the reason', pk.label === 'Not verified' && pk.code === 'platform', pk);
}

async function release(P) {
  console.log("\n2b. THE CLOSER'S RELEASE");
  const C = require(ROOT + 'server/services/closer.js');
  const asked = [];
  const verifier = async (e) => { asked.push(e); return { status: 'valid' }; };
  for (const mode of ['off', 'on']) {
    if (mode === 'on') on(); else off();
    asked.length = 0;
    const brand = `Eyebrows by Corrina ${mode}`;
    const sentIds = [];
    const send = async (log) => { sentIds.push(log.id); return { providerMessageId: 'p-' + log.id }; };
    const a = await draft(P, { brand, email: 'ce@squareup.com', contact: 'Corrina Lane' });
    const aCard = await card(P, { brand, contact: 'Corrina Lane', phone: '205-555-0100', log: a, email: 'ce@squareup.com', slot: mode === 'on' ? 2 : 1 });
    const r = await C.releaseDue(P, { send, gateDeps: { verifier } });
    const ra = await row(P, a);
    ok(`SEND_GATE_ON ${mode}: ce@squareup.com is NOT SENT`, !sentIds.includes(a) && !ra.sent_at, r.detail);
    ok('  the card says exactly why, and the call instead', ra.send_error === SQUARE_MSG, ra.send_error);
    ok('  stopped, not held', !!ra.cadence_stopped_at && ra.gate_reason === 'platform', { stop: ra.cadence_stopped_at, why: ra.gate_reason });
    const qa = await qrow(P, aCard);
    ok('  its card is a call card now', qa.channel === 'call' && qa.state === 'queued' && qa.email_note === SQUARE_MSG, { ch: qa.channel, note: qa.email_note });
    ok('  no verification spent on it', !asked.includes('ce@squareup.com'), asked);
  }
  off();
  // Off, every other address sends exactly as before.
  const sentIds = [];
  const send = async (log) => { sentIds.push(log.id); return { providerMessageId: 'p-' + log.id }; };
  const b = await draft(P, { brand: 'Plain Co', email: 'pat@plainco.com', contact: 'Pat Plain' });
  await C.releaseDue(P, { send, gateDeps: { verifier } });
  ok('SEND_GATE_ON off: an ordinary address still sends as before', sentIds.includes(b), sentIds);
}

async function editor(P) {
  console.log("\n2c. THE EDITOR'S SEND AND THE INBOX COMPOSER");
  const express = require('express');
  const router = require(ROOT + 'server/routes/outreach.js');
  const sent = [];
  router._sendImpl = async (ctx, acct, to, log) => { sent.push({ to, id: log.id }); return { providerMessageId: 'm-' + log.id, messageId: '<m-' + log.id + '@x>' }; };
  const asked = [];
  router._gateDeps = { verifier: async (e) => { asked.push(e); return { status: 'valid' }; } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: AG }; next(); });
  app.use('/api/outreach', router);
  const ES = require(ROOT + 'server/services/emailStore.js');
  ES.getEmailAccountWithTokens = async () => ({ user_id: AG, provider: 'gmail', email_address: 'pd@agency.com' });
  const emailRouter = require(ROOT + 'server/routes/email.js');
  emailRouter._gateDeps = router._gateDeps;
  app.use('/api/email', emailRouter);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const settle = async (id) => { for (let i = 0; i < 40; i++) { const s = await get('/api/outreach/logs/' + id + '/send-status'); if (s.body.state !== 'sending') return s.body; await new Promise((r) => setTimeout(r, 100)); } return null; };
  try {
    off();
    const h = await draft(P, { brand: 'Eyebrows Editor', status: 'draft', source: 'prewarm' });
    await card(P, { brand: 'Eyebrows Editor', contact: 'Corrina Lane', phone: '205-555-0100', slot: 3 });
    await post('/api/outreach/logs/' + h + '/send', { emailAccountId: 'acct-1', toEmail: 'ce@squareup.com', contactName: 'Corrina Lane' });
    const s1 = await settle(h);
    ok('the editor, SEND_GATE_ON off: ce@squareup.com is NOT SENT', !sent.some((x) => x.id === h) && s1 && s1.state === 'failed', s1);
    ok('  send-status says exactly why, and the call', s1 && s1.error === SQUARE_MSG, s1 && s1.error);
    ok('  no verification spent', !asked.includes('ce@squareup.com'), asked);
    const ib = await post('/api/email/send', { accountId: 'acct-1', to: 'ce@squareup.com', subject: 'An idea' });
    ok('the inbox composer, SEND_GATE_ON off: ce@squareup.com is NOT SENT', ib.status === 409 && ib.body.gate === 'platform', ib);
    ok('  saying the platform\'s address, not the business\'s', /^Not sent: squareup\.com is the platform's address, not the business's\./.test(ib.body.error || ''), ib.body.error);
  } finally { off(); server.close(); }
  // The athlete's brand email: the same gate, always on for a platform address.
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const fn = idx.slice(idx.indexOf('async function _sendAthleteEmail('));
  const body = fn.slice(0, fn.search(/gmailSend\.sendEmail\(/));
  ok("the athlete's brand email runs the gate for a platform address with the switch off", /SG\.runsFor\(to\)/.test(body) && /SG\.check\(/.test(body) && /refusalMessage/.test(body));
  const msg = await SG.refusalMessage(store.pool, SG.platformProblem('ce@squareup.com'), { athleteId: ATH, brand: 'Eyebrows Editor' });
  ok('  its message: the same sentence, with the phone on the card', msg === SQUARE_MSG, msg);
}

// ── 3. ADMIN SCRIPT platform-address-audit ──────────────────────────────────
async function audit(P) {
  console.log('\n3. PLATFORM-ADDRESS-AUDIT');
  const PA = require(ROOT + 'server/services/platformAddressAudit.js');
  // Live: a queued card with its draft, a card with no email written yet, an
  // approved email, another agent's. Not live: a sent one. Not platform: one.
  const l1 = await draft(P, { agent: AG2, brand: 'Brows Two', status: 'draft', email: 'ce@squareup.com', contact: 'Corrina Lane' });
  const c1 = await card(P, { agent: AG2, brand: 'Brows Two', contact: 'Corrina Lane', phone: '205-555-0100', log: l1, email: 'ce@squareup.com', slot: 5 });
  const c2 = await card(P, { agent: AG2, brand: 'Lash Bar', contact: 'Lia Bar', instagram: 'lashbar', email: 'help@vagaro.com', slot: 6 });
  const l3 = await draft(P, { agent: AG2, brand: 'Wix Studio', email: 'ana@wix.com', contact: 'Ana Wix' });
  const l4 = await draft(P, { agent: AG, brand: 'Insta Shop', email: 'sam@instagram.com', contact: 'Sam Shop' });
  const sentL = await draft(P, { agent: AG2, brand: 'Sent Square', status: 'sent', email: 'ce@squareup.com', sentAt: new Date() });
  const sentC = await card(P, { agent: AG2, brand: 'Sent Square', email: 'ce@squareup.com', state: 'sent', sentAt: new Date(), slot: 7 });
  const plain = await draft(P, { agent: AG2, brand: 'Own Domain', status: 'draft', email: 'corrina@eyebrowsbycorrina.com', contact: 'Corrina Lane' });
  const plainC = await card(P, { agent: AG2, brand: 'Own Domain 2', email: 'corrina@eyebrowsbycorrina.com', slot: 8 });

  const dry = await PA.run(P, {});
  const items = [...dry.agents.values()].flatMap((A) => A.items);
  const logIds = items.map((x) => x.logId).filter(Boolean), cardIds = items.map((x) => x.cardId);
  ok('read-only by default: lists the queued card and its draft', logIds.includes(l1), items);
  ok('  the card with no email written yet', cardIds.includes(c2) && items.find((x) => x.cardId === c2).logId === null);
  ok('  the approved email', logIds.includes(l3));
  ok('  every agent\'s', logIds.includes(l4));
  ok('  the card and its draft once, not twice', items.filter((x) => x.cardId === c1).length === 1, items.filter((x) => x.cardId === c1));
  ok('  never anything sent', !logIds.includes(sentL) && !cardIds.includes(sentC));
  ok("  never the business's own domain", !logIds.includes(plain) && !cardIds.includes(plainC));
  ok('  grouped by agent', dry.agents.get(AG2).items.length === 3 && dry.agents.get(AG).items.length === 1, [...dry.agents.values()].map((A) => [A.agentId, A.items.length]));
  ok('  and changes nothing', !(await row(P, l1)).cadence_stopped_at && (await qrow(P, c2)).channel === 'email' && (await qrow(P, c1)).channel === 'email');
  const txt = PA.format(dry);
  ok('  it prints by agent, saying READ-ONLY', /Other Agent/.test(txt) && /Dana Agent/.test(txt) && /READ-ONLY/.test(txt) && /&apply=1/.test(txt), txt);
  ok('  with each address and its platform', /ce@squareup\.com/.test(txt) && /squareup\.com is the platform's address/.test(txt) && /TOTAL: 4/.test(txt), txt);
  const one = await PA.run(P, { agentId: AG });
  ok('agent= limits it to one agent', one.found === 1 && [...one.agents.keys()].join() === AG, one.found);

  const applied = await PA.run(P, { agentId: AG2, apply: true });
  ok('apply stops them', applied.stopped === 3, applied.stopped);
  const r1 = await row(P, l1);
  ok('  the draft stops with the exact reason', !!r1.cadence_stopped_at && r1.send_error === SQUARE_MSG, r1.send_error);
  const q1 = await qrow(P, c1);
  ok('  and its card is a call card', q1.channel === 'call' && q1.email_note === SQUARE_MSG, { ch: q1.channel, note: q1.email_note });
  const q2 = await qrow(P, c2);
  ok('  the card with no email yet is a DM card, saying why', q2.channel === 'dm' && /^Not sent: vagaro\.com is the platform's address, not the business's\. Send them an Instagram DM instead: @lashbar\.$/.test(q2.email_note || ''), { ch: q2.channel, note: q2.email_note });
  const r3 = await row(P, l3);
  ok('  the approved email stops too', !!r3.cadence_stopped_at && /^Not sent: wix\.com is the platform's address/.test(r3.send_error || ''), r3.send_error);
  ok('  the other agent untouched', !(await row(P, l4)).cadence_stopped_at);
  ok('  the sent one untouched', !(await row(P, sentL)).cadence_stopped_at && (await qrow(P, sentC)).state === 'sent');
  ok("  the business's own domain untouched", !(await row(P, plain)).cadence_stopped_at && (await qrow(P, plainC)).channel === 'email');
  ok('  it says APPLIED', /APPLIED/.test(PA.format(applied)));
  const again = await PA.run(P, { agentId: AG2 });
  ok('run again: nothing left for that agent', again.found === 0, again.found);

  // The descriptor.
  const reg = require(ROOT + 'server/services/adminScripts.js').discover({ strict: true });
  const d = reg['platform-address-audit'];
  ok('the admin script is registered', !!d && d.file === 'scripts/platform-address-audit.js');
  ok('  read-only unless apply=1', JSON.stringify(d.args({})) === '[]' && JSON.stringify(d.args({ apply: 'yes' })) === '[]'
    && JSON.stringify(d.args({ apply: '1' })) === '["--apply"]', [d.args({}), d.args({ apply: '1' })]);
  ok('  agent= is passed cleaned', JSON.stringify(d.args({ agent: 'a@b.com; rm -rf' })) === '["--agent","a@b.comrm-rf"]', d.args({ agent: 'a@b.com; rm -rf' }));
}

(async () => {
  list();
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SG.ensureColumns(P);
  await require(ROOT + 'server/services/sendRules.js').ensureTable(P);
  await seedBase(P);
  for (const step of [finder, gateRule, release, editor, audit]) {
    try { await step(P); } catch (e) { F++; console.log('  FAIL  ' + step.name + ' threw: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | ')); }
  }
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
