'use strict';
// Runs from a checkout on any machine against the local test Postgres. DNS is
// a stub: four domains with four answers, no network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/emailcheck.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── AN ADDRESS IS CHECKED BEFORE IT IS A CONTACT, AND THE CARD SAYS WHY ─────
//
// Syntax, then an MX lookup on the domain. Fails are undeliverable: kept on
// the record with the reason, never offered as the email channel, so the
// business becomes a DM or a call if it has one. A lookup that could not run
// is unverified, not a no. Every card carries the verdict in words.

// The resolver stand-in, installed before anything requires emailVerify.
// Seven domains:
//   good      MX                         deliverable
//   nomx      no MX, no A, no AAAA       undeliverable (nothing to deliver to)
//   implicit  no MX, an A record         unverified (RFC 5321 implicit MX)
//   implicit6 no MX (ENODATA), AAAA only unverified (RFC 5321 implicit MX)
//   nullmx    one MX with exchange "."   undeliverable (RFC 7505 null MX)
//   gone      NXDOMAIN                   undeliverable
//   slow      resolver timeout           unverified (could not check)
const dnsp = require('dns').promises;
const MX = {
  'good.example.com': [{ exchange: 'mx.good.example.com', priority: 10 }],
  'nomx.example.com': [],
  'implicit.example.com': [],
  'nullmx.example.com': [{ exchange: '.', priority: 0 }],
};
const A = { 'implicit.example.com': ['192.0.2.10'], 'good.example.com': ['192.0.2.1'] };
const AAAA = { 'implicit6.example.com': ['2001:db8::10'] };
const DNS_CALLS = [];
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
dnsp.resolveMx = async (domain) => {
  DNS_CALLS.push('MX ' + domain);
  if (domain in MX) return MX[domain];
  if (domain === 'implicit6.example.com') fail('ENODATA');
  if (domain === 'slow.example.com') fail('ETIMEOUT');
  fail('ENOTFOUND');
};
dnsp.resolve4 = async (domain) => {
  DNS_CALLS.push('A ' + domain);
  if (domain in A) return A[domain];
  if (domain === 'gone.example.com') fail('ENOTFOUND');
  fail('ENODATA');
};
dnsp.resolve6 = async (domain) => {
  DNS_CALLS.push('AAAA ' + domain);
  if (domain in AAAA) return AAAA[domain];
  if (domain === 'gone.example.com') fail('ENOTFOUND');
  fail('ENODATA');
};

const store = require(REPO + 'server/store.js');
const EVAL = require(REPO + 'server/services/emailValidation.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'ec-agent', ATH = 'ec-ath';

function ladderWith(rows3, rows1) {
  return { tiers: [
    ...(rows1 ? [{ tier: 1, label: 'Owner', rows: rows1 }] : []),
    { tier: 3, label: 'Business channels', rows: rows3 },
  ] };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await P().query(`DELETE FROM email_verification WHERE email LIKE '%example.com'`).catch(() => {});

  // ── 1. SYNTAX ────────────────────────────────────────────────────────────
  OUT.push('-- syntax --');
  for (const good of ['owner@good.example.com', 'first.last+tag@sub.good.example.com', "o'neil@good.example.com"]) ok(`valid: ${good}`, EVAL.checkSyntax(good).ok, EVAL.checkSyntax(good));
  for (const bad of ['', 'owner', 'owner@', '@good.example.com', 'owner@good', 'owner @good.example.com', 'ow..ner@good.example.com', '.owner@good.example.com', 'owner@@good.example.com', 'owner@-good.example.com', 'info@example.com', 'x@localhost']) {
    ok(`invalid: ${JSON.stringify(bad)}`, !EVAL.checkSyntax(bad).ok, EVAL.checkSyntax(bad));
  }

  // ── 2. MX ────────────────────────────────────────────────────────────────
  OUT.push('', '-- the MX lookup --');
  const m = await EVAL.validateMany(P(), ['Owner@Good.example.com', 'info@nomx.example.com', 'hi@gone.example.com', 'x@slow.example.com', 'not an address',
    'shop@implicit.example.com', 'shop@implicit6.example.com', 'shop@nullmx.example.com']);
  ok('a domain with a mail exchanger is deliverable', m.get('owner@good.example.com').deliverable === true && /MX record found/.test(m.get('owner@good.example.com').reason), m.get('owner@good.example.com'));
  ok('  and its address records are never looked up', !DNS_CALLS.includes('A good.example.com') && !DNS_CALLS.includes('AAAA good.example.com'), DNS_CALLS);
  ok('  a domain with no MX, no A and no AAAA is undeliverable', m.get('info@nomx.example.com').deliverable === false && /no MX, A or AAAA record/.test(m.get('info@nomx.example.com').reason), m.get('info@nomx.example.com'));
  ok('  a domain that does not exist (NXDOMAIN) is undeliverable', m.get('hi@gone.example.com').deliverable === false && /does not exist/.test(m.get('hi@gone.example.com').reason));
  ok('  a resolver timeout is unverified, not a no', m.get('x@slow.example.com').deliverable === null && /did not complete/.test(m.get('x@slow.example.com').reason) && !m.get('x@slow.example.com').note, m.get('x@slow.example.com'));
  ok('  bad syntax never reaches the resolver', m.get('not an address').deliverable === false && m.get('not an address').source === 'syntax');
  const cachedRows = (await P().query(`SELECT email, result FROM email_verification WHERE email IN ('info@nomx.example.com','hi@gone.example.com','x@slow.example.com')`)).rows;
  ok('the two failures are cached as invalid; the timeout is not cached', cachedRows.length === 2 && cachedRows.every((r) => r.result === 'invalid'), cachedRows);

  // ── 2b. RFC 5321 IMPLICIT MX, RFC 7505 NULL MX ───────────────────────────
  OUT.push('', '-- implicit MX and null MX --');
  const imp = m.get('shop@implicit.example.com');
  ok('no MX but an A record: unverified, never undeliverable', imp.deliverable === null && imp.source === 'mx' && /no MX record but resolves/.test(imp.reason), imp);
  ok('  with the card line word for word', imp.note === 'Email unverified: implicit.example.com has no MX record but resolves, may still accept mail.', imp.note);
  ok('  the A and AAAA lookups both ran', DNS_CALLS.includes('A implicit.example.com') && DNS_CALLS.includes('AAAA implicit.example.com'), DNS_CALLS);
  const imp6 = m.get('shop@implicit6.example.com');
  ok('no MX (ENODATA) but an AAAA record: the same, IPv6 counts', imp6.deliverable === null && imp6.note === 'Email unverified: implicit6.example.com has no MX record but resolves, may still accept mail.', imp6);
  const nul = m.get('shop@nullmx.example.com');
  ok('a null MX (single MX, exchange ".") is undeliverable', nul.deliverable === false && /null MX record/.test(nul.reason), nul);
  ok('  and its address records are not consulted: the record itself said no', !DNS_CALLS.includes('A nullmx.example.com'), DNS_CALLS);
  const cached2 = (await P().query(`SELECT email, result FROM email_verification WHERE email IN ('shop@implicit.example.com','shop@implicit6.example.com','shop@nullmx.example.com') ORDER BY email`)).rows;
  ok('null MX is cached as invalid; implicit MX is not cached (an MX record may appear)', cached2.length === 1 && cached2[0].email === 'shop@nullmx.example.com' && cached2[0].result === 'invalid', cached2);
  const EV = require(REPO + 'server/services/emailVerify.js');
  ok('hasMx reads Node\'s "" root exchange as null MX too', EV._isNullMx([{ exchange: '', priority: 0 }]) === true && EV._isNullMx([{ exchange: '.', priority: 0 }, { exchange: 'mx.real.example.com', priority: 10 }]) === false && EV._isNullMx([]) === false);

  const LI = ladderWith([{ title: 'General inbox', email: 'shop@implicit.example.com', emailKind: 'published', channel: 'email' }, { title: 'Role email from their website', email: 'sales@nullmx.example.com', emailKind: 'published', channel: 'email' }]);
  await EVAL.validateLadder(P(), LI);
  ok('validateLadder counts implicit MX as unverified and carries the note on the row', LI.emailCheck.unverified.length === 1 && LI.emailCheck.undeliverable.length === 1 && LI.tiers[0].rows[0].emailCheck.note === EVAL.implicitNote('shop@implicit.example.com'), LI.emailCheck);
  const cI = Q.buildCard({ brand: 'Implicit Shop' }, LI, { instagram: null });
  ok('the implicit-MX address is still the email channel, and the card says the exact line', cI.channel === 'email' && cI.email === 'shop@implicit.example.com' && cI.emailNote === 'Email unverified: implicit.example.com has no MX record but resolves, may still accept mail.; 1 other address undeliverable', cI.emailNote);
  const LN = ladderWith([{ title: 'General inbox', email: 'info@nullmx.example.com', emailKind: 'published', channel: 'email' }]);
  await EVAL.validateLadder(P(), LN);
  ok('a null-MX address alone is a DM or a call, and the card says why', Q.emailRowsOf(LN).length === 0 && Q.emailNoteOf(LN) === 'Email not offered: info@nullmx.example.com is undeliverable (the domain declines all mail (null MX record))', Q.emailNoteOf(LN));

  // ── 3. THE LADDER, THE CHANNEL, THE CARD ─────────────────────────────────
  OUT.push('', '-- the ladder, the channel, the card --');
  const L1 = ladderWith([{ title: 'General inbox', email: 'info@nomx.example.com', emailKind: 'published', channel: 'email' }],
    [{ name: 'Dana Roberts', title: 'Owner', source: 'chamber', email: null, phone: null }]);
  const s1 = await EVAL.validateLadder(P(), L1);
  ok('validateLadder marks the row and summarises', s1.checked === 1 && s1.undeliverable.length === 1 && L1.tiers[1].rows[0].emailCheck.ok === false && L1.emailCheck === s1, s1);
  ok('  the undeliverable address is no longer a sendable row', Q.emailRowsOf(L1).length === 0 && Q.inboxOf(L1) === null);
  ok('  so the channel falls to the DM when there is a handle', Q.channelFor(L1, { instagram: 'nomxshop', instagramScope: 'this-location' }) === 'dm');
  ok('  and to a call when there is not', Q.channelFor(L1, { instagram: null }) === 'call');
  const bar1 = Q.passesBar(L1, { instagram: null });
  ok('  with nothing else, the bar says unreachable rather than counting a dead inbox', bar1.ok === false, bar1);
  const c1 = Q.buildCard({ brand: 'NoMX Shop', athleteName: 'Peyton' }, L1, { instagram: 'nomxshop', instagramScope: 'this-location' });
  ok('the card is a DM card with no email, and says why', c1.channel === 'dm' && c1.email === null && c1.emailNote === 'Email not offered: info@nomx.example.com is undeliverable (the domain publishes no mail server and no address (no MX, A or AAAA record))', c1.emailNote);

  const L2 = ladderWith([{ title: 'General inbox', email: 'info@good.example.com', emailKind: 'published', channel: 'email' }, { title: 'Role email from their website', email: 'sales@gone.example.com', emailKind: 'published', channel: 'email' }],
    [{ name: 'Dana Roberts', title: 'Owner', source: 'chamber' }]);
  await EVAL.validateLadder(P(), L2);
  const c2 = Q.buildCard({ brand: 'Good Shop' }, L2, { instagram: null });
  ok('a deliverable address is the email channel, and the card says it was checked', c2.channel === 'email' && c2.email === 'info@good.example.com' && /^Email checked: info@good\.example\.com \(the domain accepts mail \(MX record found\)\); 1 other address undeliverable$/.test(c2.emailNote), c2.emailNote);

  const L3 = ladderWith([{ title: 'General inbox', email: 'hello@slow.example.com', emailKind: 'published', channel: 'email' }]);
  await EVAL.validateLadder(P(), L3);
  const c3 = Q.buildCard({ brand: 'Slow Shop' }, L3, { instagram: null });
  ok('an unverified address (resolver blip) is still offered, marked unverified', c3.channel === 'email' && /^Email unverified: hello@slow\.example\.com \(the MX lookup did not complete/.test(c3.emailNote), c3.emailNote);
  const L4 = ladderWith([{ title: 'General inbox', email: 'info@nomx.example.com', emailKind: 'published', channel: 'email' }], [{ name: 'A B', title: 'Owner', source: 'chamber', email: 'ab@good.example.com', emailKind: 'searched' }]);
  await EVAL.validateLadder(P(), L4);
  ok('a good address of unsendable provenance is explained beside the dead one', /ab@good\.example\.com was not published by a source we send to \(searched\)/.test(Q.emailNoteOf(L4)) && /info@nomx\.example\.com is undeliverable/.test(Q.emailNoteOf(L4)), Q.emailNoteOf(L4));
  ok('no address at all: nothing to explain', Q.emailNoteOf(ladderWith([{ title: 'Business line', phone: '(334) 555-1212' }])) === null);

  // ── 4. THE CARD ROW CARRIES THE NOTE ─────────────────────────────────────
  OUT.push('', '-- the card row --');
  await P().query(`DELETE FROM outreach_queue WHERE athlete_id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'E','ec@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [ATH, AG, JSON.stringify({ name: 'Ec Athlete', school: 'Auburn University', sport: 'football' })]);
  const job = require(REPO + 'server/jobs/outreachQueue.js');
  const wrote = await job.insertCard(P(), { agentId: AG, athleteId: ATH, slot: 1, card: { ...c1, brandKey: 'nomx-shop', lane: 'local' } });
  const row = (await P().query(`SELECT channel, email, email_note FROM outreach_queue WHERE athlete_id = $1`, [ATH])).rows[0];
  ok('insertCard writes email_note', wrote && row && row.channel === 'dm' && row.email === null && row.email_note === c1.emailNote, row);
  const q = (await P().query(`SELECT q.email_note FROM outreach_queue q WHERE q.state = 'queued' AND q.athlete_id = $1`, [ATH])).rows;
  ok('  and it reads back as written', q.length === 1 && q[0].email_note === c1.emailNote, q);

  // ── 5. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const jobSrc = src('server/jobs/outreachQueue.js');
  ok('the job checks every address right after the ladder is built, before the bar', /const ev = await EVAL\.validateLadder\(pool, ladder\);/.test(jobSrc) && jobSrc.indexOf('EVAL.validateLadder(pool, ladder)') < jobSrc.indexOf('const bar = Q.passesBar(ladder, ig);'));
  ok('  the attempt on the run row carries the verdicts', (jobSrc.match(/emailCheck: ladder\.emailCheck \|\| null/g) || []).length === 2);
  ok('emailRowsOf refuses an undeliverable row', /if \(r\.emailCheck && r\.emailCheck\.ok === false\) continue;/.test(src('server/services/outreachQueue.js')));
  ok('the contact merge checks addresses before the evidence is stored, and the cache carries the verdicts', /EVAL\.validateMany\(store\.pool, addrs\)/.test(src('server/ai.js')) && /genericInboxCheck, personalInboxCheck, businessPhone, phoneUnconfirmed \}/.test(src('server/ai.js')) && /genericInboxCheck: ev\.genericInboxCheck \|\| null/.test(src('server/ai.js')));
  ok('  the ladder copies the verdict onto its rows', /emailCheck: c\.email \? \(c\.emailCheck \|\| null\) : null/.test(src('server/services/contactLadder.js')) && /emailCheck: r\.genericInboxCheck \|\| null/.test(src('server/services/contactLadder.js')) && /emailCheck: r\.personalInboxCheck \|\| null/.test(src('server/services/contactLadder.js')));
  ok('the AI Outreach path stores a failed address as no address, with the reason', /r\.email_check = `undeliverable: \$\{v\.reason\} \(\$\{r\.email\}\)`;\s*r\.email = null;/.test(src('server/services/contactDiscovery.js')) && /priority_rank, email_check, created_at/.test(src('server/services/contactDiscovery.js')));
  ok('the columns exist', /ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS email_note TEXT/.test(src('server/store.js')) && /ALTER TABLE brand_contacts ADD COLUMN IF NOT EXISTS email_check TEXT/.test(src('server/store.js')));
  ok('Home carries the note on every card and the page shows it', /emailNote: c\.emailNote \|\| null,/.test(src('server/services/homeQueue.js')) && /q\.email_note/.test(src('server/services/actionable.js')) && /c\.emailNote \? '<p class="hq-note">' \+ hqEscape\(c\.emailNote\)/.test(src('public/index.html')));

  await P().query(`DELETE FROM outreach_queue WHERE athlete_id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM email_verification WHERE email LIKE '%example.com'`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
