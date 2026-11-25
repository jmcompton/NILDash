'use strict';
// ── NO PRICE IN AN EMAIL THAT GOES TO A BUSINESS ────────────────────────────
//
//   node tests/priceout.js
//
// services/priceOut and offerSuggest.forPitch: the pitch is the first outreach
// and never names a figure. The writers are told no figure; a body written
// under the old rule has it taken out, in the database and again at the send;
// the card keeps its suggested offer for the agent.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('priceouttest', { schema: true });
process.env.OFFER_ON = '1';
delete process.env.OFFER_IN_PITCH;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const PO = require(REPO + 'server/services/priceOut');
  const OS = require(REPO + 'server/services/offerSuggest');
  const PW = require(REPO + 'server/services/pitchWriter');

  console.log('-- the writers are told no figure --');
  const card = { amount: 250, kind: 'cash', suggested: 250 };
  ok('the card still carries its offer, for the agent', OS.fromCard(card) && OS.fromCard(card).label === '$250', OS.fromCard(card));
  ok('a writer is handed nothing', OS.forPitch(card) === null);
  process.env.OFFER_IN_PITCH = '1';
  ok('OFFER_IN_PITCH=1 is the switch back', OS.forPitch(card) && OS.forPitch(card).label === '$250');
  delete process.env.OFFER_IN_PITCH;
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  ok('Deal Scan and AI Outreach pitches', /const _offer = require\('\.\/offerSuggest'\)\.forPitch\(/.test(src('server/services/pitchGeneration.js')));
  ok('the prewarmed draft (and the card\'s figure is still recorded on it)', /function _offerOf\(card\) \{ return require\('\.\/offerSuggest'\)\.forPitch\(/.test(src('server/services/draftPrewarm.js')) && /const o = _offerOnCard\(card\); if \(o\) await require\('\.\/offerSuggest'\)\.record/.test(src('server/services/draftPrewarm.js')));
  ok('the nightly pitch', /offer: OFFER\.IN_PITCH\(\) \? _offer : null,/.test(src('server/jobs/outreachQueue.js')) && !/\n\s+offer: _offer,\n/.test(src('server/jobs/outreachQueue.js')));

  console.log('-- taking a price out of a pitch already written --');
  // The real one, from a waiting draft on Nov 25, 2026.
  const real = '<p>Hi Dr. Radebaugh,</p><p>I wanted to call your attention to Peyton Bair, Decathlon / Heptathlon (Multi-Event) in track and field at the University of Oregon. Peyton is building out NIL partnerships for this year and is looking for local Eugene businesses that fit the kind of disciplined, whole-body approach to health that Peyton already lives and talks about publicly.</p><p>The content Peyton makes, training, track content, day in the life, speaks to an audience that cares about performance and wellbeing, which feels like a natural overlap with what you do at Healing Paws, and we\'d start the conversation at $250.</p><p>Would you like to learn more about this NIL opportunity with Peyton?</p><p>JohnMark</p>';
  let s = PO.strip(real);
  ok('the figure is gone', s.changed && s.left === null && !/\$|250/.test(s.body), s.body.slice(-330));
  ok('  the sentence it hung on ends where it should', /what you do at Healing Paws\.<\/p>/.test(s.body), s.body.slice(-330));
  ok('  nothing else moved: the greeting, the ask and the sign-off are as written', s.body.startsWith('<p>Hi Dr. Radebaugh,</p>') && /Would you like to learn more about this NIL opportunity with Peyton\?<\/p><p>JohnMark<\/p>$/.test(s.body)
    && s.body.length === real.length - ", and we'd start the conversation at $250".length, [s.body.length, real.length]);
  const cases = [
    ['a sentence of its own is dropped', 'Marcus posts training content weekly. We would open at $500 in product. Would a quick call work?', 'Marcus posts training content weekly. Would a quick call work?'],
    ['"starting at" on the end', 'We are proposing two feed posts and an appearance, starting at $250. Open to a call?', 'We are proposing two feed posts and an appearance. Open to a call?'],
    ['a curly apostrophe and a comma in the number', 'It fits your gym, and we’d start the conversation at $1,500. Thanks.', 'It fits your gym. Thanks.'],
    ['a menu item with no price stays', 'A menu item named after him, The Torres Burger, is one idea. We\'d start at $250.', 'A menu item named after him, The Torres Burger, is one idea.'],
    ['a pitch with no price is not touched', 'Marcus has 24,000 followers and 3 partnerships this year. Open to a call?', 'Marcus has 24,000 followers and 3 partnerships this year. Open to a call?'],
    ['a figure that is the heart of a sentence takes the sentence', 'Our rate is $400 per post for this. Could we talk Tuesday?', ' Could we talk Tuesday?'],
  ];
  for (const [name, input, want] of cases) { const r = PO.strip(input); ok(name, r.body.trim() === want.trim() && r.left === null, r); }
  ok('a link with a dollar sign in it is not text and is left alone', PO.strip('<p>See <a href="https://x.com/?a=$1">this</a>. We\'d start at $250.</p>').body === '<p>See <a href="https://x.com/?a=$1">this</a>.</p>', PO.strip('<p>See <a href="https://x.com/?a=$1">this</a>. We\'d start at $250.</p>').body);
  ok('what is left always passes the pitch writer\'s own price check', cases.every(([, i]) => PW.containsPrice(PO.strip(i).body) === null));
  ok('stripping twice changes nothing more', PO.strip(s.body).changed === false);

  console.log('-- at the send --');
  ok('a stored body with a figure leaves without it', !/\$/.test(PO.forSend(real)) && PO.forSend('plain') === 'plain' && PO.forSend(null) === '');
  process.env.OFFER_IN_PITCH = '1';
  ok('with the old behavior switched back on, the body is sent as stored', PO.forSend(real) === real);
  delete process.env.OFFER_IN_PITCH;
  ok('both send paths run it', /appendHtml\(require\('\.\.\/services\/priceOut'\)\.forSend\(log\.body_html\)/.test(src('server/jobs/closerRelease.js')) && /appendHtml\(require\('\.\.\/services\/priceOut'\)\.forSend\(log\.body_html\)/.test(src('server/routes/outreach.js')));

  console.log('-- the pitches already waiting --');
  const store = require(REPO + 'server/store');
  const P = store.pool;
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('ag1', 'a@x.com', 'A', 'x', 'agent')`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('at1', 'ag1', '{"name":"Peyton"}')`);
  const ins = (id, status, body, sent) => P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, body_html, sent_at) VALUES ($1,'ag1','at1','B',$2,$3,$4)`, [id, status, body, sent]);
  await ins('out_a', 'draft', real, null);
  await ins('out_b', 'draft', '<p>No figure here. Open to a call?</p>', null);
  await ins('out_c', 'sent', real, new Date());
  await ins('out_d', 'expired', real, null);
  const r1 = await PO.backfill(P);
  const body = async (id) => (await P.query(`SELECT body_html FROM outreach_logs WHERE id = $1`, [id])).rows[0].body_html;
  ok('a waiting draft with a figure is cleaned', r1.logs === 1 && !/\$/.test(await body('out_a')), r1);
  ok('a clean draft is not touched', (await body('out_b')) === '<p>No figure here. Open to a call?</p>');
  ok('what was already sent is history and is not rewritten', (await body('out_c')) === real && (await body('out_d')) === real);
  const r2 = await PO.backfill(P);
  ok('running it again finds nothing to do', r2.logs === 0 && r2.cards === 0 && r2.left === 0, r2);
  process.env.OFFER_IN_PITCH = '1';
  ok('with the old behavior on, it does nothing', !!(await PO.backfill(P)).skipped);
  delete process.env.OFFER_IN_PITCH;
  ok('the app runs it once at startup', /require\('\.\/services\/priceOut'\)\.backfill\(store\.pool\)/.test(src('server/index.js')));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
