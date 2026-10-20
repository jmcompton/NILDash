'use strict';
// ── A PLATFORM'S ADDRESS IS NEVER THE BUSINESS'S ────────────────────────────
//
// The email finder put ce@squareup.com on a card for "Eyebrows by Corrina".
// squareup.com is Square's own domain: the salon books through Square, and
// Square's domain was taken for hers. "ce" even read as Corrina E.'s initials,
// so the name rule alone let it through.
//
//   1. The list (services/websiteValidation): the platforms' own company
//      domains next to PLATFORM_HOSTS, exported, and platformDomainOf over all
//      three lists. A page there is not the business's site either.
//   2. The email finder: never returns or verifies an address at one, and
//      spends no Hunter credit on it (no verify, Domain Search or Email Finder).
//   3. The card's address: never offered as the email.
//   4. The send gate: "Not sent: <domain> is the platform's address, not the
//      business's. Call them instead: <phone>." Gate on or off, on every path.
//   5. Admin script platform-address-audit: print first, apply stops; never
//      anything sent, replied to or marked done.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('platformdomainstest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.SEND_GATE_ON;
delete process.env.EMAIL_FIVE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();
const fs = require('fs');
const { execSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const WV = require(REPO + 'server/services/websiteValidation');
const EF = require(REPO + 'server/services/emailFinder');
const Q = require(REPO + 'server/services/outreachQueue');
const SG = require(REPO + 'server/services/sendGate');
const NM = require(REPO + 'server/services/nameMatch');
const { checkDomain } = require(REPO + 'server/services/domainGate');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const on = () => { process.env.SEND_GATE_ON = '1'; };
const off = () => { delete process.env.SEND_GATE_ON; };

const ASKED = ['squareup.com', 'square.com', 'wix.com', 'squarespace.com', 'shopify.com', 'godaddy.com', 'weebly.com', 'vagaro.com',
  'booksy.com', 'styleseat.com', 'mindbodyonline.com', 'toasttab.com', 'clover.com', 'google.com', 'facebook.com', 'instagram.com', 'yelp.com'];
const SQUARE_PAGE = 'https://squareup.com/appointments/book/x8y2k/eyebrows-by-corrina';
const WHY = "squareup.com is the platform's address, not the business's";

// The finder's network, stubbed: every call counted.
function deps(o = {}) {
  const calls = { verify: [], domainSearch: [], emailFinder: [], resolve: [], site: [] };
  return {
    calls,
    verify: async (e) => { calls.verify.push(e); const v = (o.verdicts || {})[e] || 'invalid'; return v === 'valid' ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' }; },
    peek: async () => new Map(),
    domainSearch: async (dom) => { calls.domainSearch.push(dom); return o.hunter || null; },
    emailFinder: async (f, l, dom) => { calls.emailFinder.push(`${f} ${l} @ ${dom}`); return o.finder || { email: null }; },
    resolveDomain: async (brand) => { calls.resolve.push(brand); return o.resolved || { website: null, tried: [] }; },
    checkDomain,
    siteEmail: async (w) => { calls.site.push(w); return null; },
    corporate: (dom, brand, out) => EF.corporateDomain(dom, brand, out),
  };
}
const spent = (d) => d.calls.verify.length + d.calls.domainSearch.length + d.calls.emailFinder.length;
const corrina = (email) => ({ name: 'Corrina Ellis', title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: email || null, ...(email ? { emailKind: 'published' } : {}) });
const ladderOf = (rows, businessDomain) => ({ tiers: [{ tier: 1, rows }], ...(businessDomain ? { businessDomain } : {}) });

(async () => {
  // ── 1. THE LIST ──────────────────────────────────────────────────────────
  console.log('\n1. THE LIST');
  ok('PLATFORM_COMPANY_DOMAINS is exported and is exactly the 17 asked for',
    Array.isArray(WV.PLATFORM_COMPANY_DOMAINS) && WV.PLATFORM_COMPANY_DOMAINS.length === 17 && ASKED.every((d) => WV.PLATFORM_COMPANY_DOMAINS.includes(d)), WV.PLATFORM_COMPANY_DOMAINS);
  ok('  next to PLATFORM_HOSTS and SOCIAL_HOSTS, both still exported', Array.isArray(WV.PLATFORM_HOSTS) && Array.isArray(WV.SOCIAL_HOSTS) && WV.PLATFORM_HOSTS.includes('square.site'));
  ok('ce@squareup.com is on squareup.com', WV.platformDomainOf('ce@squareup.com') === 'squareup.com' && WV.isPlatformDomain('ce@squareup.com'));
  ok('  case and subdomains: CE@Mail.SquareUp.com, booking.vagaro.com', WV.platformDomainOf('CE@Mail.SquareUp.com') === 'squareup.com' && WV.platformDomainOf('x@booking.vagaro.com') === 'vagaro.com');
  ok('  a URL, a bare domain, a mailto: all read', WV.platformDomainOf(SQUARE_PAGE) === 'squareup.com' && WV.platformDomainOf('wix.com') === 'wix.com' && WV.platformDomainOf('mailto:hi@shopify.com') === 'shopify.com');
  ok('  every one of the 17 company domains', ASKED.every((d) => WV.platformDomainOf(`corrina@${d}`) === d), ASKED.filter((d) => WV.platformDomainOf(`corrina@${d}`) !== d));
  ok('  every PLATFORM_HOSTS domain (eyebrows.square.site, a myshopify store, a wixsite page)',
    WV.PLATFORM_HOSTS.every((d) => WV.isPlatformDomain(`corrina@${d}`)) && WV.platformDomainOf('x@eyebrowsbycorrina.square.site') === 'square.site'
      && WV.isPlatformDomain('x@corrinas.myshopify.com') && WV.isPlatformDomain('https://corrina.wixsite.com/brows'), WV.PLATFORM_HOSTS.filter((d) => !WV.isPlatformDomain(`corrina@${d}`)));
  ok('  every SOCIAL_HOSTS domain (linktr.ee, tiktok.com ...)', WV.SOCIAL_HOSTS.every((d) => WV.isPlatformDomain(`corrina@${d}`)), WV.SOCIAL_HOSTS.filter((d) => !WV.isPlatformDomain(`corrina@${d}`)));
  ok('  never a lookalike: notsquareup.com, squareup.com.example.net, mysquare.com',
    !WV.isPlatformDomain('ce@notsquareup.com') && !WV.isPlatformDomain('ce@squareup.com.example.net') && !WV.isPlatformDomain('ce@mysquare.com'));
  ok('  never the business\'s own domain, nor the owner\'s gmail', !WV.isPlatformDomain('corrina@eyebrowsbycorrina.com') && !WV.isPlatformDomain('corrina.ellis@gmail.com'));
  ok('  nothing in, nothing out', WV.platformDomainOf('') === null && WV.platformDomainOf(null) === null && WV.platformDomainOf('squareup') === null);
  const vw = WV.validateWebsite('Eyebrows by Corrina', 'Eyebrows by Corrina', SQUARE_PAGE);
  ok('a Square booking page is not the business\'s site (validateWebsite: platform)', vw.verdict === 'platform' && vw.rule === 'platform-company-domain', vw);
  ok('  Yelp stays a directory, Facebook stays social', WV.validateWebsite('Eyebrows by Corrina', 'Eyebrows by Corrina', 'https://yelp.com/biz/eyebrows-by-corrina').verdict === 'reject-domain'
    && WV.validateWebsite('Eyebrows by Corrina', 'Eyebrows by Corrina', 'https://facebook.com/eyebrowsbycorrina').verdict === 'social');
  const cd = checkDomain('Eyebrows by Corrina', SQUARE_PAGE);
  ok('  nor to the domain gate (third-party host), so no address is looked for there', !cd.ok && cd.code === 'third-party-host' && /squareup\.com is the platform's own domain/.test(cd.reason), cd);
  ok('  not even when the business is called "Square Deal Auto"', checkDomain('Square Deal Auto', 'https://squareup.com/store/square-deal-auto').code === 'third-party-host');
  ok('  the business\'s own domain still passes', checkDomain('Eyebrows by Corrina', 'https://eyebrowsbycorrina.com').ok);

  // ── 2. THE EMAIL FINDER ──────────────────────────────────────────────────
  console.log('\n2. THE EMAIL FINDER');
  {
    const d = deps({ verdicts: { 'ce@squareup.com': 'valid' } });
    const r = await EF.find({ name: 'Corrina Ellis', domain: 'squareup.com', examples: [{ email: 'ce@squareup.com', name: 'Corrina Ellis', kind: 'published' }] }, d);
    ok('find() on squareup.com: no address, and says why', r.email === null && r.stop === "squareup.com is the platform's domain, not the business's" && r.platform === true, r);
    ok('  no Hunter credit: no verification, no Domain Search, no Email Finder', spent(d) === 0 && r.credits.search === 0 && r.credits.verify === 0, d.calls);
  }
  {
    const d = deps();
    const stops = [];
    for (const dom of [...ASKED, ...WV.PLATFORM_HOSTS, 'eyebrowsbycorrina.square.site', 'https://corrina.wixsite.com/brows']) {
      const r = await EF.find({ name: 'Corrina Ellis', domain: dom, examples: [] }, d);
      if (!r.platform || r.email) stops.push(dom);
    }
    ok('  the same on every platform domain and subdomain, with nothing spent', !stops.length && spent(d) === 0, { notStopped: stops, calls: d.calls });
  }
  {
    const d = deps({ finder: { email: 'corrina@eyebrowsbycorrina.com' }, verdicts: { 'corrina@eyebrowsbycorrina.com': 'valid' } });
    const r = await EF.find({ name: 'Corrina Ellis', domain: 'eyebrowsbycorrina.com', examples: [] }, d);
    ok('  the business\'s own domain is searched as before', r.email === 'corrina@eyebrowsbycorrina.com' && d.calls.emailFinder.length === 1, r);
  }

  console.log('\n   the Eyebrows by Corrina card');
  ok('the name rule alone accepts ce@ for Corrina Ellis (initials): why the domain rule is needed', NM.match('ce@squareup.com', 'Corrina Ellis').ok);
  {
    // The night's finishing step, as on the card: the owner, ce@squareup.com
    // on her row, and her Square booking page as the "website". Hunter would
    // call ce@squareup.com valid: it is a real Square mailbox.
    const L = ladderOf([corrina('ce@squareup.com')]);
    const d = deps({ verdicts: { 'ce@squareup.com': 'valid' } });
    const r = await EF.finishLadder({ ladder: L, out: { website: SQUARE_PAGE }, ig: null, brand: 'Eyebrows by Corrina', region: 'Waco, TX', place: null, Q }, d);
    ok('finishLadder: ce@squareup.com is never verified', !d.calls.verify.includes('ce@squareup.com'), d.calls.verify);
    ok('  no Hunter search on squareup.com either', d.calls.domainSearch.length === 0 && d.calls.emailFinder.length === 0 && spent(d) === 0, d.calls);
    ok('  her Square page is treated as no website, and a site of her own is looked for', d.calls.resolve.length === 1 && /squareup\.com is the platform's domain, not the business's/.test((r.finder || {}).stop || ''), r.finder);
    ok('  the card is not an email card: a call (no phone check here, no handle)', r.after === 'call' && !Q.inboxOf(L), { after: r.after, inbox: Q.inboxOf(L) });
    ok('  and says why', /ce@squareup\.com is the platform's address, not the business's/.test(Q.emailNoteOf(L) || ''), Q.emailNoteOf(L));
    ok('  with her Instagram, a DM instead', EF.finishLadder && Q.channelFor(L, { instagram: 'eyebrowsbycorrina', instagramScope: 'business' }) === 'dm');
  }
  {
    // The same card, when a web search finds her own site: the finder looks there.
    const L = ladderOf([corrina('ce@squareup.com')]);
    const d = deps({ resolved: { website: 'https://eyebrowsbycorrina.com' }, finder: { email: 'corrina@eyebrowsbycorrina.com' }, verdicts: { 'corrina@eyebrowsbycorrina.com': 'valid', 'ce@squareup.com': 'valid' } });
    const r = await EF.finishLadder({ ladder: L, out: { website: SQUARE_PAGE }, ig: null, brand: 'Eyebrows by Corrina', region: 'Waco, TX', place: null, Q }, d);
    ok('her own site found: her address there is found and verified instead', r.after === 'email' && (Q.inboxOf(L) || {}).email === 'corrina@eyebrowsbycorrina.com', { after: r.after, finder: r.finder, inbox: Q.inboxOf(L) });
    ok('  and nothing was spent on squareup.com', !d.calls.verify.includes('ce@squareup.com') && d.calls.domainSearch.every((x) => x !== 'squareup.com') && d.calls.emailFinder.every((x) => !/squareup/.test(x)), d.calls);
  }
  {
    // A web search that answers with a platform page is not her site either.
    const L = ladderOf([corrina()]);
    const d = deps({ resolved: { website: 'https://eyebrowsbycorrina.square.site' } });
    const r = await EF.finishLadder({ ladder: L, out: { website: null }, ig: null, brand: 'Eyebrows by Corrina', region: 'Waco, TX', place: null, Q }, d);
    ok('a search that finds only eyebrowsbycorrina.square.site: no domain, nothing spent', spent(d) === 0 && /square\.site is the platform's domain/.test((r.website || {}).why || '') && r.after === 'call', { website: r.website, finder: r.finder, calls: d.calls });
  }
  {
    // A ladder that names the platform as the business's domain.
    const L = ladderOf([corrina()], 'square.site');
    const d = deps();
    const r = await EF.finishLadder({ ladder: L, out: {}, ig: null, brand: 'Eyebrows by Corrina', region: 'Waco, TX', place: null, Q }, d);
    ok('a ladder whose businessDomain is square.site: not searched', spent(d) === 0 && /square\.site is the platform's domain/.test((r.finder || {}).stop || ''), { finder: r.finder, calls: d.calls });
  }
  {
    // A role address at the platform does not name the business's domain.
    const L = ladderOf([corrina(), { name: null, email: 'bookings@vagaro.com', emailKind: 'published' }]);
    const d = deps();
    const r = await EF.finishLadder({ ladder: L, out: { website: null }, ig: null, brand: 'Eyebrows by Corrina', region: 'Waco, TX', place: null, Q }, d);
    ok('bookings@vagaro.com on the ladder does not make vagaro.com her domain', spent(d) === 0 && !(r.finder || {}).domain, { finder: r.finder, calls: d.calls });
  }

  console.log('\n3. THE CARD\'S ADDRESS');
  {
    const L = ladderOf([corrina('ce@squareup.com')]);
    ok('a ladder whose only address is ce@squareup.com has no email to offer', !Q.inboxOf(L) && Q.channelFor(L, null) === 'call' && Q.emailRowsOf(L).length === 0);
    const L2 = ladderOf([corrina('corrina@eyebrowsbycorrina.com')]);
    ok('  her own address is offered as before', (Q.inboxOf(L2) || {}).email === 'corrina@eyebrowsbycorrina.com' && Q.channelFor(L2, null) === 'email');
    const L3 = ladderOf([corrina()]);
    L3.generalInbox = { email: 'info@eyebrows.square.site', verdict: 'valid' };
    ok('  nor a general inbox at a platform', !Q.inboxOf(L3));
  }

  // ── 4. THE SEND GATE ─────────────────────────────────────────────────────
  console.log('\n4. THE SEND GATE');
  const p = (e, n, o) => SG.addressProblem(e, n, o);
  ok('ce@squareup.com for Corrina Ellis: refused, the platform\'s address', (p('ce@squareup.com', 'Corrina Ellis') || {}).code === 'platform' && p('ce@squareup.com', 'Corrina Ellis').why === WHY, p('ce@squareup.com', 'Corrina Ellis'));
  ok('  typed by hand too (the inbox composer, a free-form athlete email)', (p('ce@squareup.com', null, { typed: true }) || {}).code === 'platform');
  ok('  read before the desk rules: support@shopify.com, info@wix.com', (p('support@shopify.com', 'Corrina Ellis') || {}).code === 'platform' && (p('info@wix.com', 'Corrina Ellis') || {}).code === 'platform');
  const allLists = [...ASKED, ...WV.PLATFORM_HOSTS, ...WV.SOCIAL_HOSTS];
  ok('  every domain on the three lists', allLists.every((d) => (p(`corrina@${d}`, 'Corrina Ellis') || {}).code === 'platform'), allLists.filter((d) => (p(`corrina@${d}`, 'Corrina Ellis') || {}).code !== 'platform'));
  ok('  each saying its own domain', p('maria@vagaro.com', 'Maria Glow').why === "vagaro.com is the platform's address, not the business's");
  ok('her own address, a lookalike and her gmail are not refused for this', p('corrina@eyebrowsbycorrina.com', 'Corrina Ellis') === null
    && (p('ce@notsquareup.com', 'Corrina Ellis') || {}).code !== 'platform' && p('corrina.ellis@gmail.com', 'Corrina Ellis') === null);
  ok('platformCheck, for the paths that run with the gate off', (SG.platformCheck('ce@squareup.com') || {}).code === 'platform' && SG.platformCheck('ce@squareup.com').ok === false
    && SG.platformCheck('corrina@eyebrowsbycorrina.com') === null && SG.platformCheck('') === null);

  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SG.ensureColumns(P);
  await require(REPO + 'server/services/sendRules').ensureTable(P);   // made at boot in production
  const AG = 'pd-agent', AG2 = 'pd-agent2', ATH = 'pd-ath', ATH2 = 'pd-ath2';
  for (const [id, name, email] of [[AG, 'Gina Agent', 'gina@agency.test'], [AG2, 'Other Agent', 'other@agency.test']]) {
    await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,$2,$3,'x','agent','America/Chicago')`, [id, name, email]);
    await P.query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [id]);
  }
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`, [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-09-02' })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`, [ATH2, AG2, JSON.stringify({ name: 'Cole Rivers', school: 'Auburn', dob: '2003-01-02' })]);
  const verified = (email, result, ageDays) => P.query(
    `INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES ($1,$2,'seeded','hunter',$3, NOW() - make_interval(days => $4))
     ON CONFLICT (email) DO UPDATE SET result=EXCLUDED.result, status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`, [email, result, result, ageDays]);
  let _n = 0;
  const draft = async (o) => {
    const id = o.id || ('pd-' + (++_n));
    const approved = o.status === 'approved';
    await P.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, approved_at, scheduled_send_at,
                                  sent_to_email, touch_no, parent_id, source, contact_name, sent_at, replied_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'<p>Hi there,</p><p>A real idea for your shop and our athlete.</p>',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
      [id, o.agent || AG, o.athlete || ATH, o.brand, 'name:' + o.brand.toLowerCase(), o.subject || 'Quick idea for ' + o.brand,
        o.status || 'draft', approved ? new Date(Date.now() - 3600000) : null, o.scheduled || (approved ? new Date(Date.now() - 60000) : null),
        o.email, o.touch || 1, o.parent || null, o.source || 'nightly-queue', o.contact || null, o.sentAt || null, o.repliedAt || null]);
    await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
                   VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
      ['name:' + o.brand.toLowerCase(), o.brand, JSON.stringify({ primaryType: 'beauty_salon', types: ['beauty_salon'] })]).catch(() => {});
    return id;
  };
  let _slot = 0;
  const card = async (o) => (await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, brand_name, brand_key, channel, state, contact_name, phone, instagram, instagram_scope,
                                 outreach_log_id, slot, email, email_verified, outcome, replied_at, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [o.agent || AG, o.athlete || ATH, o.brand, 'name:' + o.brand.toLowerCase(), o.channel || 'email', o.state || 'queued', o.contact || null,
      o.phone || null, o.instagram || null, o.instagram ? 'business' : null, o.log || null, o.slot || (++_slot), o.email || null, o.verified === true,
      o.outcome || null, o.repliedAt || null, o.sentAt || null])).rows[0].id;
  const logRow = async (id) => (await P.query(`SELECT * FROM outreach_logs WHERE id=$1`, [id])).rows[0];
  const cardRow = async (id) => (await P.query(`SELECT * FROM outreach_queue WHERE id=$1`, [id])).rows[0];

  // The gate itself, with a fresh valid verification on record: Square's
  // mailbox is real, so Hunter says valid. Still refused, and nothing spent.
  await verified('ce@squareup.com', 'valid', 1);
  {
    on();
    const calls = [];
    const g = await SG.check(P, { email: 'ce@squareup.com', contactName: 'Corrina Ellis', business: 'Eyebrows by Corrina' }, { verifier: async (e) => { calls.push(e); return { status: 'valid' }; } });
    ok('SEND_GATE_ON: refused although verified valid yesterday, with no credit spent', !g.ok && g.code === 'platform' && g.why === WHY && !calls.length && !g.retry, g);
    const pk = await SG.peek(P, 'ce@squareup.com', 'Corrina Ellis');
    ok('  Home\'s label says Not verified, and why', !pk.verified && pk.label === 'Not verified' && pk.code === 'platform' && pk.why === WHY, pk);
    off();
  }
  {
    // liveDeps: whoever asks, nothing reaches Hunter for a platform address.
    const H = require(REPO + 'server/services/hunterLookup');
    const was = { verifyEmail: H.verifyEmail, findDomainEmails: H.findDomainEmails, findEmail: H.findEmail };
    const hits = [];
    H.verifyEmail = async (e) => { hits.push('verify ' + e); return { status: 'valid' }; };
    H.findDomainEmails = async (d) => { hits.push('search ' + d); return { emails: [] }; };
    H.findEmail = async (f, l, d) => { hits.push(`finder ${d}`); return { email: null }; };
    try {
      const live = EF.liveDeps(P, { agentId: AG, athleteId: ATH, business: 'Eyebrows by Corrina', source: 'test' });
      const v = await live.verify('ce@squareup.com');
      const s = await live.domainSearch('squareup.com');
      const f = await live.emailFinder('Corrina', 'Ellis', 'squareup.com');
      ok('the live finder: verify, Domain Search and Email Finder never reach Hunter for squareup.com', !hits.length && v.platform === true && v.cached === true && s === null && f === null, { hits, v });
      ok('  its answer is final, not "could not run" (the night does not try it again)', EF.verdictOf(v) === 'unknown' && !v.notRun);
      const credits = (await P.query(`SELECT COUNT(*)::int n FROM email_verify_credit_log WHERE LOWER(email) = 'ce@squareup.com'`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      ok('  and no credit is logged for it', credits === 0, credits);
      await live.domainSearch('eyebrowsbycorrina.com');
      ok('  the business\'s own domain still reaches Hunter', hits.includes('search eyebrowsbycorrina.com'), hits);
    } finally { Object.assign(H, was); }
  }
  {
    // The one source of addresses for Deal Scan, Write Outreach and the editor.
    const FA = require(REPO + 'server/services/finderAddress');
    const d = deps();
    const r = await FA.forPerson(P, { brand: 'Eyebrows by Corrina', name: 'Corrina Ellis', website: SQUARE_PAGE, force: true }, d);
    ok('finderAddress.forPerson with her Square page: no address, nothing spent', !r.email && /squareup\.com is the platform's domain/.test(r.why || '') && spent(d) === 0, { r, calls: d.calls });
  }

  // ── 5. PLATFORM-ADDRESS-AUDIT ────────────────────────────────────────────
  console.log('\n5. PLATFORM-ADDRESS-AUDIT');
  const PA = require(REPO + 'server/services/platformAudit');
  // Live, at a platform's domain:
  const e1 = await draft({ brand: 'Eyebrows by Corrina', email: 'ce@squareup.com', contact: 'Corrina Ellis' });
  const e1c = await card({ brand: 'Eyebrows by Corrina', email: 'ce@squareup.com', contact: 'Corrina Ellis', phone: '254-555-0144', log: e1 });
  const e2 = await draft({ brand: 'Glow Studio', email: 'maria@vagaro.com', contact: 'Maria Glow', status: 'approved' });
  const e2c = await card({ brand: 'Glow Studio', email: 'maria@vagaro.com', contact: 'Maria Glow', instagram: 'glowstudio', log: e2 });
  const e3p = await draft({ brand: 'Wix Nails', email: 'dee@wix.com', contact: 'Dee Nails', status: 'sent', sentAt: new Date(Date.now() - 5 * 86400000) });
  const e3 = await draft({ brand: 'Wix Nails', email: 'dee@wix.com', contact: 'Dee Nails', touch: 2, parent: e3p, source: 'follow-up', scheduled: new Date(Date.now() + 86400000) });
  const e4 = await draft({ brand: 'Lash Loft', email: 'tina@booking.styleseat.com', contact: 'Tina Loft' });
  const e5 = await draft({ brand: 'Tide Tacos', email: 'sam@toasttab.com', contact: 'Sam Tide', agent: AG2, athlete: ATH2 });
  const e5c = await card({ brand: 'Tide Tacos', email: 'sam@toasttab.com', contact: 'Sam Tide', phone: '334-555-0100', log: e5, agent: AG2, athlete: ATH2 });
  const c1 = await card({ brand: 'Brow Bar', channel: 'call', email: 'dee@browbar.square.site', contact: 'Dee Brow', phone: '205-555-0155' });
  const c2 = await card({ brand: 'Nail Nook', channel: 'dm', email: 'nailnook@instagram.com', contact: 'Nia Nook', instagram: 'nailnook' });
  // Never touched:
  const u1 = await draft({ brand: 'Sent Salon', email: 'jo@squareup.com', contact: 'Jo Sent', status: 'sent', sentAt: new Date(Date.now() - 2 * 86400000) });
  const u2p = await draft({ brand: 'Clover Cafe', email: 'al@clover.com', contact: 'Al Clover', status: 'sent', sentAt: new Date(Date.now() - 6 * 86400000), repliedAt: new Date(Date.now() - 86400000) });
  const u2 = await draft({ brand: 'Clover Cafe', email: 'al@clover.com', contact: 'Al Clover', touch: 2, parent: u2p, source: 'follow-up', scheduled: new Date(Date.now() + 86400000) });
  const u3 = await card({ brand: 'Kim Kitchen', channel: 'call', email: 'kim@clover.com', contact: 'Kim Kitchen', phone: '205-555-0166', outcome: 'called' });
  const u4 = await draft({ brand: 'Corrina Two', email: 'corrina@eyebrowsbycorrina.com', contact: 'Corrina Ellis' });
  const u4c = await card({ brand: 'Corrina Two', email: 'corrina@eyebrowsbycorrina.com', contact: 'Corrina Ellis', log: u4 });
  const u5 = await card({ brand: 'Shop Sending', channel: 'call', email: 'pat@shopify.com', contact: 'Pat Shop', phone: '205-555-0177', state: 'sending' });
  const u6 = await card({ brand: 'Replied Spa', channel: 'call', email: 'ray@booksy.com', contact: 'Ray Spa', phone: '205-555-0188', repliedAt: new Date() });
  const u7 = await card({ brand: 'Clover Cafe', channel: 'call', email: 'al@clover.com', contact: 'Al Clover', phone: '205-555-0199' });
  const snap = async () => JSON.stringify([(await P.query(`SELECT * FROM outreach_logs ORDER BY id`)).rows, (await P.query(`SELECT * FROM outreach_queue ORDER BY id`)).rows]);
  const before = await snap();

  const dry = await PA.run(P, {});
  const items = [...dry.agents.values()].flatMap((A) => A.items.map((x) => ({ ...x, agent: A.agentId })));
  const it = (id, type) => items.find((x) => String(x.id) === String(id) && x.type === type);
  ok('DRY RUN: five emails that could still leave, two cards showing the address', dry.emails === 5 && dry.cards === 2, { emails: dry.emails, cards: dry.cards, items: items.map((x) => [x.type, x.address]) });
  ok('  each email by kind: queued card, approved not sent, scheduled follow-up, draft on Home',
    (it(e1, 'email') || {}).kind === 'queued card' && (it(e2, 'email') || {}).kind === 'approved, not sent' && (it(e3, 'email') || {}).kind === 'scheduled follow-up'
      && (it(e4, 'email') || {}).kind === 'draft on Home' && (it(e5, 'email') || {}).kind === 'queued card', items.map((x) => [x.id, x.kind]));
  ok('  the cards: a call card and a DM card showing it', (it(c1, 'card') || {}).kind === 'call card showing it' && (it(c2, 'card') || {}).kind === 'DM card showing it');
  ok('  an email\'s own card is listed once, with its email', !it(e1c, 'card') && !it(e2c, 'card') && !it(e5c, 'card'));
  ok('  by agent: Gina Agent 6, Other Agent 1', dry.agents.get(AG).items.length === 6 && dry.agents.get(AG2).items.length === 1 && (it(e5, 'email') || {}).agent === AG2);
  ok('  each with the reason', (it(e1, 'email') || {}).why === WHY && (it(c1, 'card') || {}).why === "browbar.square.site is the platform's address, not the business's");
  ok('never listed: sent, a thread with a reply, marked done, being sent, replied to, a brand with a reply, the business\'s own address',
    ![u1, u2, u2p, u4].some((id) => it(id, 'email')) && ![u3, u4c, u5, u6, u7].some((id) => it(id, 'card')), items.map((x) => [x.type, x.id, x.address]));
  ok('DRY RUN: nothing changed', (await snap()) === before);
  const txt = PA.format(dry);
  ok('  the printout: dry, by agent, each one, and how to apply', /^PLATFORM ADDRESS AUDIT: 7 live card\(s\) whose email is on a platform's domain/.test(txt)
    && /DRY RUN: nothing was changed\. Add &apply=1 to stop them\./.test(txt)
    && /Gina Agent <gina@agency\.test>: 6 \(4 email\(s\), 2 card\(s\)\)/.test(txt) && /Other Agent <other@agency\.test>: 1 \(1 email\(s\), 0 card\(s\)\)/.test(txt)
    && /stop   \[queued card\] Amber Bretton -> Eyebrows by Corrina: ce@squareup\.com \(Corrina Ellis\)/.test(txt)
    && /clear  \[call card showing it\] Amber Bretton -> Brow Bar: dee@browbar\.square\.site \(Dee Brow\)/.test(txt)
    && /TOTAL: 5 email\(s\) to stop, 2 card\(s\) to clear \(/.test(txt) && /squareup\.com 1/.test(txt), txt);
  const one = await PA.run(P, { agentId: AG2 });
  ok('  agent= limits it to one agent', one.emails === 1 && one.cards === 0 && [...one.agents.keys()].join() === AG2);

  const ap = await PA.run(P, { apply: true });
  ok('APPLY: five stopped, two cleared', ap.stopped === 5 && ap.cleared === 2, { stopped: ap.stopped, cleared: ap.cleared, converted: ap.converted });
  const l1 = await logRow(e1);
  const MSG1 = "Not sent: squareup.com is the platform's address, not the business's. Call them instead: 254-555-0144.";
  ok('ce@squareup.com: stopped, saying exactly why and what to do instead', !!l1.cadence_stopped_at && !l1.sent_at && l1.gate_reason === 'platform' && l1.send_error === MSG1, { err: l1.send_error, reason: l1.gate_reason });
  const k1 = await cardRow(e1c);
  ok('  its card is a call card now, without the address, saying the same', k1.channel === 'call' && k1.state === 'queued' && !k1.outreach_log_id && k1.email === null && k1.email_note === MSG1, k1);
  const l2 = await logRow(e2);
  const MSG2 = "Not sent: vagaro.com is the platform's address, not the business's. Send them an Instagram DM instead: @glowstudio.";
  ok('maria@vagaro.com, approved and not sent: stopped, the DM offered', !!l2.cadence_stopped_at && !l2.sent_at && l2.send_error === MSG2, l2.send_error);
  const k2 = await cardRow(e2c);
  ok('  its card is a DM card with the message to send', k2.channel === 'dm' && /real idea/.test(k2.dm_text || '') && k2.email === null, { ch: k2.channel, dm: k2.dm_text, email: k2.email });
  ok('dee@wix.com, the scheduled follow-up: stopped', !!(await logRow(e3)).cadence_stopped_at && (await logRow(e3)).gate_reason === 'platform');
  ok('tina@booking.styleseat.com, the draft on Home: stopped, and says there is nothing else on file',
    /^Not sent: booking\.styleseat\.com is the platform's address, not the business's\. There is no phone or Instagram on file to use instead\.$/.test((await logRow(e4)).send_error || ''), (await logRow(e4)).send_error);
  ok('the other agent\'s sam@toasttab.com: stopped, a call card now', !!(await logRow(e5)).cadence_stopped_at && (await cardRow(e5c)).channel === 'call' && (await cardRow(e5c)).email === null);
  const k3 = await cardRow(c1), k4 = await cardRow(c2);
  ok('the call card: the address is off it, and it says why', k3.email === null && k3.channel === 'call' && k3.state === 'queued'
    && k3.email_note === "Removed dee@browbar.square.site: browbar.square.site is the platform's address, not the business's. Call them instead: 205-555-0155.", k3);
  ok('the DM card: the same, with the DM', k4.email === null && k4.channel === 'dm'
    && k4.email_note === "Removed nailnook@instagram.com: instagram.com is the platform's address, not the business's. Send them an Instagram DM instead: @nailnook.", k4);
  const sentRow = await logRow(u1), fu = await logRow(u2), own = await logRow(u4);
  ok('untouched: the sent email, the follow-up on a replied thread, the business\'s own address', !!sentRow.sent_at && !sentRow.cadence_stopped_at && !fu.cadence_stopped_at && !own.cadence_stopped_at && !own.gate_reason);
  const kept = await Promise.all([u3, u4c, u5, u6, u7].map(cardRow));
  ok('untouched: the done card, her own card, the card being sent, the replied card, the replied brand\'s card',
    kept[0].email === 'kim@clover.com' && kept[0].outcome === 'called' && kept[1].email === 'corrina@eyebrowsbycorrina.com' && kept[2].email === 'pat@shopify.com' && kept[2].state === 'sending'
      && kept[3].email === 'ray@booksy.com' && kept[4].email === 'al@clover.com', kept.map((k) => [k.id, k.email, k.state, k.outcome]));
  const txt2 = PA.format(ap);
  ok('  the printout says what was done', /APPLIED:/.test(txt2) && /STOPPED  \[queued card\] Amber Bretton -> Eyebrows by Corrina: ce@squareup\.com/.test(txt2)
    && /card says: Not sent: squareup\.com is the platform's address, not the business's\. Call them instead: 254-555-0144\./.test(txt2)
    && /Stopped 5: 2 became call cards, 1 DM cards, 2 have no phone or handle on file\. Cleared 2 card\(s\)\./.test(txt2), txt2);
  const again = await PA.run(P, { apply: true });
  ok('a second run finds nothing', again.emails === 0 && again.cards === 0 && again.stopped === 0 && /Nothing to stop/.test(PA.format(again)));

  // ── 6. EVERY SEND PATH, GATE ON OR OFF ───────────────────────────────────
  console.log('\n6. EVERY SEND PATH, GATE ON OR OFF');
  off();
  {
    const C = require(REPO + 'server/services/closer.js');
    const sentIds = [];
    const send = async (log) => { sentIds.push(log.id); return { providerMessageId: 'p-' + log.id }; };
    const r1 = await draft({ brand: 'Corrina Release', email: 'ce@squareup.com', contact: 'Corrina Ellis', status: 'approved' });
    await card({ brand: 'Corrina Release', email: 'ce@squareup.com', contact: 'Corrina Ellis', phone: '254-555-0145', log: r1 });
    await verified('riley@goodco.com', 'valid', 1);
    const r2 = await draft({ brand: 'Good Co', email: 'riley@goodco.com', contact: 'Riley Good', status: 'approved' });
    const rr = await C.releaseDue(P, { send, gateDeps: { verifier: async () => ({ status: 'unknown' }) } });
    const lr = await logRow(r1);
    ok('the Closer release, SEND_GATE_ON off: ce@squareup.com is NOT SENT', !sentIds.includes(r1) && !lr.sent_at && !!lr.cadence_stopped_at, rr.detail);
    ok('  stopped with the message, and the call offered', lr.send_error === "Not sent: squareup.com is the platform's address, not the business's. Call them instead: 254-555-0145." && lr.gate_reason === 'platform', lr.send_error);
    const rc = (await P.query(`SELECT channel, email, email_note FROM outreach_queue WHERE brand_name = 'Corrina Release'`)).rows[0];
    ok('  its card is a call card now, and the address is off it', rc.channel === 'call' && rc.email === null && rc.email_note === lr.send_error, rc);
    ok('  everything else sends as before with the gate off', sentIds.includes(r2), { sentIds, detail: rr.detail });
  }
  {
    const express = require('express');
    const router = require(REPO + 'server/routes/outreach.js');
    const sent = [];
    router._sendImpl = async (ctx, acct, to, log) => { sent.push({ to, id: log.id }); return { providerMessageId: 'm-' + log.id, messageId: '<m-' + log.id + '@x>' }; };
    router._gateDeps = { verifier: async () => ({ status: 'unknown' }) };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: AG }; next(); });
    app.use('/api/outreach', router);
    const ES = require(REPO + 'server/services/emailStore.js');
    ES.getEmailAccountWithTokens = async () => ({ user_id: AG, provider: 'gmail', email_address: 'gina@agency.test' });
    const emailRouter = require(REPO + 'server/routes/email.js');
    emailRouter._gateDeps = { verifier: async () => ({ status: 'unknown' }) };
    app.use('/api/email', emailRouter);
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (pth, body) => { const r = await fetch(base + pth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const settle = async (id) => { for (let i = 0; i < 40; i++) { const s = await (await fetch(`${base}/api/outreach/logs/${id}/send-status`)).json(); if (s.state !== 'sending') return s; await new Promise((r) => setTimeout(r, 100)); } return null; };
    try {
      const h = await draft({ brand: 'Corrina Editor', email: null, contact: 'Corrina Ellis', source: 'prewarm' });
      await card({ brand: 'Corrina Editor', contact: 'Corrina Ellis', phone: '254-555-0146' });
      const s0 = await post(`/api/outreach/logs/${h}/send`, { emailAccountId: 'acct-1', toEmail: 'ce@squareup.com', contactName: 'Corrina Ellis' });
      const s1 = await settle(h);
      ok("the editor's Send, gate off: NOT SENT", s0.status === 202 && !sent.some((x) => x.id === h) && s1 && s1.state === 'failed', { s0, s1 });
      ok('  send-status says why and offers the call', s1 && s1.error === "Not sent: squareup.com is the platform's address, not the business's. Call them instead: 254-555-0146." && s1.offer && s1.offer.channel === 'call', s1);
      const ib = await post('/api/email/send', { accountId: 'acct-1', to: 'ce@squareup.com', subject: 'An idea' });
      ok('the inbox composer, gate off: NOT SENT', ib.status === 409 && ib.body.gate === 'platform' && ib.body.error === "Not sent: squareup.com is the platform's address, not the business's.", ib);
      on();
      const ib2 = await post('/api/email/send', { accountId: 'acct-1', to: 'hello@corrina.wixsite.com', subject: 'An idea' });
      ok('  and gate on', ib2.status === 409 && ib2.body.gate === 'platform', ib2);
      off();
    } finally { off(); server.close(); }
  }
  {
    // The athlete's brand email: read from the source (index.js runs the app).
    const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    const at = idx.indexOf('async function _sendAthleteEmail(');
    const body = idx.slice(at, at + idx.slice(at).search(/gmailSend\.sendEmail\(/));
    ok("the athlete's brand email: the platform check runs with the gate off, before the send", at > -1 && /:\s*SG\.platformCheck\(to\)/.test(body) && /if \(g && !g\.ok\)/.test(body), body.slice(-900));
  }

  // ── 7. THE ADMIN SCRIPT ──────────────────────────────────────────────────
  console.log('\n7. THE ADMIN SCRIPT');
  const AS = require(REPO + 'server/services/adminScripts');
  const d = AS.registry()['platform-address-audit'];
  ok('platform-address-audit is registered, one descriptor file', !!d && d.file === 'scripts/platform-address-audit.js' && fs.existsSync(REPO + 'server/scripts/admin/platform-address-audit.js'));
  ok('  read only by default: no apply unless apply=1', JSON.stringify(d.args({})) === '[]' && JSON.stringify(d.args({ apply: '1' })) === '["--apply"]' && JSON.stringify(d.args({ apply: 'yes' })) === '[]');
  ok('  agent= is sanitized and bounded', JSON.stringify(d.args({ agent: 'gina@agency.test; rm -rf' })) === '["--agent","gina@agency.testrm-rf"]' && d.args({ agent: 'a'.repeat(400) })[1].length === 120);
  await draft({ brand: 'Script Salon', email: 'liv@squarespace.com', contact: 'Liv Script' });
  const out = execSync(`node ${REPO}scripts/platform-address-audit.js --agent gina@agency.test`, { env: { ...process.env, INIT_WAIT_MS: '2500' } }).toString();
  const rep = out.slice(Math.max(0, out.indexOf('PLATFORM ADDRESS AUDIT')));
  ok('  the script runs and prints, dry by default', /PLATFORM ADDRESS AUDIT: 1 live card/.test(rep) && /DRY RUN/.test(rep) && /liv@squarespace\.com \(Liv Script\)/.test(rep), rep.slice(0, 900));
  ok('  and changed nothing', !(await P.query(`SELECT cadence_stopped_at FROM outreach_logs WHERE sent_to_email = 'liv@squarespace.com'`)).rows[0].cadence_stopped_at);

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
