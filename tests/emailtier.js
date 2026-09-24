'use strict';
// Runs against the local test Postgres. No network: Hunter and every website
// are stubbed.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/emailtier.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── EVERY ADDRESS HAS A TIER, AND TIER 4 IS NEVER AN EMAIL CARD ─────────────
// Tier 1 found at the business domain, Tier 2 built from the domain's pattern,
// Tier 3 a personal address tied to the business, Tier 4 a generic mailbox.
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const ET = require(REPO + 'server/services/emailTier.js');
const EP = require(REPO + 'server/services/emailPattern.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const { buildContactLadder, TIER1_RANKS } = require(REPO + 'server/services/contactLadder.js');
const S = require(REPO + 'server/services/siteEmail.js');
const DA = require(REPO + 'server/services/draftAddress.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const rankOf = (t) => (/owner|founder/i.test(t || '') ? TIER1_RANKS[0] : 7);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE CLASSIFIER ─────────────────────────────────────────────────────
  OUT.push('-- the four tiers --');
  const all14 = ['info', 'contact', 'hello', 'hi', 'team', 'admin', 'office', 'support', 'sales',
    'orders', 'bookings', 'inquiries', 'general', 'frontdesk'];
  ok('every one of the fourteen generic mailboxes is Tier 4',
    all14.every((l) => ET.classify({ email: `${l}@kessler.com`, businessDomain: 'kessler.com' }).tier === 4),
    all14.filter((l) => ET.classify({ email: `${l}@kessler.com`, businessDomain: 'kessler.com' }).tier !== 4));
  ok('  and so is a variant of one (info.austin@, sales2@)',
    ET.classify({ email: 'info.austin@kessler.com' }).tier === 4 && ET.classify({ email: 'sales2@kessler.com' }).tier === 4);
  ok('  and a generic mailbox on gmail is still generic, not "personal"',
    ET.classify({ email: 'info@gmail.com' }).tier === 4);
  ok('a named person at the business domain, stated on a page, is Tier 1',
    ET.classify({ email: 'dana@kessler.com', emailKind: 'published', businessDomain: 'https://www.kessler.com/' }).tier === 1);
  ok('  and found by Hunter is Tier 1 too (found, not built)',
    ET.classify({ email: 'dana.whit@kessler.com', emailKind: 'hunter', businessDomain: 'kessler.com' }).tier === 1);
  ok('a named person at the business domain BUILT from the pattern is Tier 2',
    ET.classify({ email: 'dana.whitfield@kessler.com', emailKind: 'pattern', businessDomain: 'kessler.com' }).tier === 2);
  ok('a named person on gmail tied to the business is Tier 3',
    ET.classify({ email: 'danawhitfield@gmail.com', emailKind: 'published', businessDomain: 'kessler.com' }).tier === 3);
  ok('  and a named address on another domain is Tier 3, not Tier 1',
    ET.classify({ email: 'dana@whitfieldholdings.com', emailKind: 'published', businessDomain: 'kessler.com' }).tier === 3);

  // ── 2. THE PATTERN ────────────────────────────────────────────────────────
  OUT.push('', '-- the domain pattern --');
  ok('Hunter\'s pattern builds the owner\'s address',
    EP.construct('{first}.{last}', 'Dana Whitfield', 'kessler.com') === 'dana.whitfield@kessler.com'
    && EP.construct('{f}{last}', 'Dana Whitfield', 'kessler.com') === 'dwhitfield@kessler.com'
    && EP.construct('{first}', 'José Núñez', 'kessler.com') === 'jose@kessler.com');
  ok('  a pattern that needs a last name refuses a one-word name', EP.construct('{first}.{last}', 'Dana', 'kessler.com') === null);
  ok('  a pattern we do not understand is refused, not guessed at', EP.normalizePattern('{first}+{department}') === null);
  ok('with no pattern, one real address and its owner\'s name give the pattern',
    EP.inferPattern('mfranklin@kessler.com', { first: 'Mark', last: 'Franklin' }) === '{f}{last}'
    && EP.inferPattern('mark_franklin@kessler.com', 'Mark Franklin') === '{first}_{last}');
  ok('  an address that fits no shape infers nothing', EP.inferPattern('bigboss@kessler.com', 'Mark Franklin') === null);
  const inferred = EP.patternFromHunter({ pattern: null, emails: [
    { email: 'info@kessler.com', type: 'generic', confidence: 99 },
    { email: 'mfranklin@kessler.com', type: 'personal', firstName: 'Mark', lastName: 'Franklin', confidence: 90, sourceUrl: 'https://kessler.com/team' }] });
  ok('patternFromHunter reads it off the named address and keeps where that was stated',
    inferred && inferred.pattern === '{f}{last}' && inferred.from === 'inferred' && inferred.exampleSourceUrl === 'https://kessler.com/team', inferred);
  ok('  and prefers Hunter\'s own pattern when it gives one',
    EP.patternFromHunter({ pattern: '{first}', emails: [] }).from === 'hunter');

  // ── 3. HUNTER KEEPS THE PATTERN AND THE SOURCE PAGE ───────────────────────
  OUT.push('', '-- Hunter --');
  const H = require(REPO + 'server/services/hunterLookup.js');
  const realFetch = global.fetch;
  const oldKey = process.env.HUNTER_API_KEY;
  process.env.HUNTER_API_KEY = 'test-key-not-real';
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane='hunter' AND brand_key LIKE 'et-%'`).catch(() => {});
  H._resetBudgetCache();
  global.fetch = async (url) => {
    const dom = new URL(url).searchParams.get('domain');
    const body = dom === 'et-pattern.com'
      ? { data: { pattern: '{first}.{last}', emails: [{ value: 'jo.ruiz@et-pattern.com', type: 'personal', confidence: 91,
        first_name: 'Jo', last_name: 'Ruiz', sources: [{ uri: 'https://et-pattern.com/staff' }] }] } }
      : { data: { pattern: '{f}{last}', emails: [] } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const h = await H.findDomainEmails('et-pattern.com', { force: true });
    ok('the pattern comes back with the addresses', h && h.pattern === '{first}.{last}', h);
    ok('  and each address carries the page Hunter saw it on', h && h.emails[0].sourceUrl === 'https://et-pattern.com/staff', h && h.emails[0]);
    const z = await H.findDomainEmails('et-nobody.com', { force: true, withPattern: true });
    ok('a domain with no listed addresses still yields its pattern when asked', z && z.pattern === '{f}{last}' && z.emails.length === 0, z);
    const legacy = await H.findDomainEmails('et-nobody.com');
    ok('  and older callers still read null for "no addresses"', legacy === null, legacy);
  } finally {
    global.fetch = realFetch;
    if (oldKey === undefined) delete process.env.HUNTER_API_KEY; else process.env.HUNTER_API_KEY = oldKey;
    await P.query(`DELETE FROM brand_evidence_cache WHERE lane='hunter' AND brand_key LIKE 'et-%'`).catch(() => {});
  }

  // ── 4. ROUTING: TIER 4 IS NEVER THE EMAIL ─────────────────────────────────
  OUT.push('', '-- routing --');
  const ladderOf = (r) => buildContactLadder({ website: 'https://kessler.com', ...r }, { rankOf, brand: 'Kessler Auto' });
  const owner = { name: 'Dana Whitfield', title: 'Owner', source: 'site', sources: ['site'], confidence: 'high', sourceUrl: 'https://kessler.com/about' };

  const onlyInboxPhone = ladderOf({ contacts: [owner], genericInbox: 'info@kessler.com', businessPhone: '(205) 555-0100' });
  ok('only info@ and a phone: a CALL card, not an email', Q.channelFor(onlyInboxPhone, {}) === 'call');
  const r1 = Q.routeOf(onlyInboxPhone, {});
  ok('  recorded as Tier 4 routed to phone', r1.emailTier === 4 && r1.route === 'call' && r1.tier4Only, r1);
  const c1 = Q.buildCard({ brand: 'Kessler Auto' }, onlyInboxPhone, {});
  ok('  the card carries no address and says why', c1.email === null && c1.channel === 'call' && c1.emailTier === 4
    && /generic mailbox \(Tier 4\)/.test(c1.emailNote || ''), c1);

  const onlyInboxIg = ladderOf({ contacts: [], genericInbox: 'hello@kessler.com', instagram: 'kesslerauto', instagramScope: 'business' });
  const ig = { instagram: 'kesslerauto', instagramScope: 'business' };
  ok('only hello@ and an Instagram handle: a DM card', Q.channelFor(onlyInboxIg, ig) === 'dm' && Q.routeOf(onlyInboxIg, ig).route === 'dm');

  const onlyInbox = ladderOf({ contacts: [], genericInbox: 'contact@kessler.com' });
  const bar = Q.passesBar(onlyInbox, {});
  ok('only contact@ and nothing else: the business is DROPPED', !bar.ok && bar.tier4Only, bar);
  ok('  with the reason in words', /only a generic mailbox \(contact@kessler\.com\)/.test(bar.reason || ''), bar.reason);
  ok('  and recorded as dropped', Q.routeOf(onlyInbox, {}).route === 'dropped');

  const siteGeneric = ladderOf({ contacts: [], siteEmail: { email: 'office@kessler.com', type: 'role', sourceUrl: 'https://kessler.com/contact' } });
  ok('a role address scraped off the website is Tier 4 too, and not a way in', !Q.passesBar(siteGeneric, {}).ok);

  const t1 = ladderOf({ contacts: [{ ...owner, email: 'dana@kessler.com', emailSource: 'published', emailSourceUrl: 'https://kessler.com/about' }],
    genericInbox: 'info@kessler.com' });
  const c2 = Q.buildCard({ brand: 'Kessler Auto' }, t1, {});
  ok('a named owner\'s published address wins over the inbox, as Tier 1', c2.channel === 'email' && c2.email === 'dana@kessler.com' && c2.emailTier === 1, c2);
  ok('  and the card carries the page it was stated on', c2.emailSourceUrl === 'https://kessler.com/about', c2.emailSourceUrl);

  const t2 = ladderOf({ contacts: [{ ...owner, email: 'dana.whitfield@kessler.com', emailSource: 'pattern',
    emailPattern: { pattern: '{first}.{last}', from: 'hunter' } }] });
  const c3 = Q.buildCard({ brand: 'Kessler Auto' }, t2, {});
  ok('a built address is sendable and marked Tier 2', c3.channel === 'email' && c3.emailTier === 2 && c3.emailKind === 'pattern', c3);
  const GG = require(REPO + 'server/services/greetingGuard.js');
  const builtRow = t2.tiers[0].rows[0];
  ok('  and never counts as a published address for the greeting',
    builtRow.emailKind === 'pattern' && GG.hasPublishedAddress(builtRow) === false, builtRow);

  const t3 = ladderOf({ contacts: [{ ...owner, email: 'danawhit@gmail.com', emailSource: 'published' }] });
  ok('a named owner on gmail is an email card at Tier 3', Q.buildCard({ brand: 'Kessler Auto' }, t3, {}).emailTier === 3);

  // ── 5. THE OWNER'S NAME, FROM THE SITE'S OWN ABOUT PAGE ───────────────────
  OUT.push('', '-- names from the About / Team / Staff page --');
  const people = S.extractPeople(`<h2>Our Team</h2><div>Dana Whitfield, Owner</div><p>Founder: Marcus O'Neil</p>
    <p>Family owned and operated by Tom Hardy since 1990.</p><p>Our Story - Owner</p><p>our owner dana said hi</p>`,
  'https://kessler.com/about', 'Kessler Auto');
  const names = people.map((p) => p.name + '|' + p.title);
  ok('"Name, Owner", "Founder: Name" and "owned and operated by Name" are read',
    names.includes('Dana Whitfield|Owner') && names.includes("Marcus O'Neil|Founder") && names.includes('Tom Hardy|Owner'), names);
  ok('  headings and prose are not names', !names.some((n) => /Our Story|dana said/i.test(n)), names);
  ok('  each carries the page it came from', people.every((p) => p.sourceUrl === 'https://kessler.com/about'));

  const SITE = {
    'https://etbakery.com/': '<a href="/contact">Contact</a><a href="/contact-us">Contact us</a><a href="/about">About</a>',
    'https://etbakery.com/contact': '<p>Write to info@etbakery.com</p>',
    'https://etbakery.com/contact-us': '<p>Call us</p>',
    'https://etbakery.com/about': '<p>Priya Shah, Owner</p>',
  };
  const fetched = [];
  const fakeFetch = async (u) => {
    fetched.push(u);
    const html = SITE[u];
    return html ? { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => html } : { ok: false, status: 404 };
  };
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail' AND brand_key LIKE 'site:etbakery.com%'`).catch(() => {});
  const se = await S.findSiteEmail('https://etbakery.com', { brand: 'ET Bakery', fetchImpl: fakeFetch, force: true });
  ok('one of the two page slots goes to the About page, even with two contact pages linked',
    fetched.includes('https://etbakery.com/about') && fetched.filter((u) => /\/contact/.test(u)).length === 1, fetched);
  ok('  and the owner it names comes back', se && (se.people || []).some((p) => p.name === 'Priya Shah' && p.title === 'Owner'), se && se.people);
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail' AND brand_key LIKE 'site:etbakery.com%'`).catch(() => {});

  // ── 6. THE NEW SOURCE, AND THE WIRING ─────────────────────────────────────
  OUT.push('', '-- wiring --');
  const AI = read('server/ai.js');
  ok('owner replies to reviews are a nightly source, alongside Facebook', /const LEAN_SOURCE_ORDER = \['chamber', 'site', 'facebook', 'reviews'\]/.test(AI));
  ok('  with its own search, which says why it is not the Places API', /case 'reviews':/.test(AI) && /PLACES API DOES NOT RETURN OWNER REPLIES/.test(AI));
  ok('  and a name signed on a reply can be greeted', /'maps', 'reviews', 'owner_search'/.test(read('server/services/greetingGuard.js')));
  ok('Facebook About was already a nightly source and still is', /case 'facebook':[\s\S]{0,300}About/.test(AI) && /'facebook'/.test(AI.match(/const LEAN_SOURCE_ORDER = [^;]+;/)[0]));
  ok('names read off the site join the contact list before Hunter runs',
    AI.indexOf('_se.people') > 0 && AI.indexOf('_se.people') < AI.indexOf('const _hunterEligible'));
  ok('a generic-only site no longer stops Hunter when someone named has no address', /_seGenericOnly && _namedNoEmail/.test(AI));
  ok('Hunter is asked for its pattern, and a built address is marked pattern',
    /findDomainEmails\(_dom, \{ withPattern: true \}\)/.test(AI) && /c\.emailSource = 'pattern'/.test(AI));
  const JOB = read('server/jobs/outreachQueue.js');
  ok('a name found late by the owner search is given a built address too', /out\.hunterPattern/.test(JOB) && /emailKind = 'pattern'/.test(JOB));
  ok('the card and the draft both store the tier and the source page',
    (JOB.match(/email_tier, email_source_url/g) || []).length === 2);
  const cols = (await P.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name IN ('email_tier','email_source_url') AND table_name IN ('outreach_queue','outreach_logs')`)).rows;
  ok('  and the columns exist on both tables', cols.length === 4, cols);

  // ── 7. A GENERIC ADDRESS IS NEVER ATTACHED TO A DRAFT ─────────────────────
  OUT.push('', '-- draft addresses --');
  const AG = 'et-agent', ATH = 'et-ath';
  const cleanDb = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id=$1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail' AND brand IN ('ET Desk Only','ET Named Too')`).catch(() => {});
    await P.query(`DELETE FROM email_verification WHERE email LIKE '%@et-%.example'`).catch(() => {});
  };
  await cleanDb();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'E','et@x.com','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,'{"name":"Eli Test"}')`, [ATH, AG]);
  const seRow = (key, brand, ev) => P.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
     VALUES ($1,'siteemail',$2,NULL,$3::jsonb,'OK',NOW())`, [key, brand, JSON.stringify(ev)]);
  await seRow('site:et-desk.example | v3', 'ET Desk Only', { email: 'info@et-desk.example', type: 'role', siteRoot: 'et-desk.example', sourceUrl: 'https://et-desk.example/contact' });
  await seRow('site:et-named.example | v3', 'ET Named Too', { email: 'info@et-named.example', type: 'role', personalEmail: 'rosa@et-named.example',
    personalSourceUrl: 'https://et-named.example/team', siteRoot: 'et-named.example' });
  await P.query(`INSERT INTO email_verification (email, result, detail, source, checked_at)
    VALUES ('rosa@et-named.example','valid','ok','test',NOW()) ON CONFLICT (email) DO UPDATE SET result='valid', checked_at=NOW()`);
  for (const [id, brand] of [['et-l1', 'ET Desk Only'], ['et-l2', 'ET Named Too']]) {
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status)
      VALUES ($1,$2,$3,$4,'Hi','<p>x</p>','draft')`, [id, AG, ATH, brand]);
  }
  const att = await DA.attach(P, { agentId: AG });
  const rows = (await P.query(`SELECT id, sent_to_email, email_tier, email_source_url FROM outreach_logs WHERE agent_id=$1 ORDER BY id`, [AG])).rows;
  ok('a site whose only address is info@ attaches nothing, and says why',
    rows[0].sent_to_email === null && att.details.some((d) => d.result === 'generic-mailbox' && d.email === 'info@et-desk.example'), [rows[0], att.details]);
  ok('a site with a named address as well attaches the named one, with tier and page',
    rows[1].sent_to_email === 'rosa@et-named.example' && rows[1].email_tier === 1 && rows[1].email_source_url === 'https://et-named.example/team', rows[1]);

  // ── 8. THE NIGHTLY REPORT ─────────────────────────────────────────────────
  OUT.push('', '-- the nightly report --');
  const route = (emailTier, r, tier4Only) => ({ why: { emailRoute: { emailTier, route: r, tier4Only: !!tier4Only } } });
  const details = [{ athleteId: ATH, filled: 4, tried: [
    { brand: 'A', result: 'queued', ...route(1, 'email') },
    { brand: 'B', result: 'queued', ...route(2, 'email') },
    { brand: 'C', result: 'queued', ...route(3, 'email') },
    { brand: 'D', result: 'queued', ...route(4, 'call', true) },
    { brand: 'E', result: 'queued', ...route(4, 'dm', true) },
    { brand: 'F', result: 'rejected', ...route(4, 'dropped', true) },
    // Queued, then the writer refused it: not a card, so not counted.
    { brand: 'G', result: 'queued', ...route(1, 'email') }, { brand: 'G', result: 'no_angle' },
    { brand: 'H', result: 'queued', ...route(1, 'email') },
  ] }];
  const tt = ET.routeTally(details);
  ok('the tally counts each business once, by its last result',
    tt.tier1 === 2 && tt.tier2 === 1 && tt.tier3 === 1 && tt.toPhone === 1 && tt.toDm === 1 && tt.dropped === 1, tt);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at) VALUES ($1, CURRENT_DATE, 4, $2::jsonb, NOW())`,
    [AG, JSON.stringify(details)]);
  let rep = '';
  try {
    rep = execFileSync(process.execPath, [REPO + 'scripts/nightly-run-report.js', '--agent', 'et@x.com', '--nights', '1'],
      { encoding: 'utf8', env: { ...process.env, INIT_WAIT_MS: '5000' }, timeout: 90000 });
  } catch (e) { rep = String(e.stdout || '') + String(e.stderr || ''); }
  ok('the nightly run report prints the tier breakdown',
    /email tiers: Tier 1 2   Tier 2 1   Tier 3 1   \|   generic mailbox only: routed to phone 1, routed to DM 1, dropped 1/.test(rep),
    (rep.match(/email tiers.*/) || [rep.slice(-400)])[0]);

  await cleanDb();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('emailtier: FAILED', e); process.exit(1); });
