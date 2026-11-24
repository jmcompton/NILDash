'use strict';
// ── THE ATHLETE'S TRACK RECORD, THE NAME ON THE KIT, AND THE $99 PROMISE ───
//
//   node tests/trackrecord.js
//
// services/trackRecord: closed deals, gifted product and delivered posts become
// the kit's track record; amounts and paid/unpaid never reach it; the agent
// can hide a brand or the whole section.
// services/agentName: "john compton" is written "John Compton" everywhere a
// person's name is shown, and "JohnMark" when that is the sign-off name.
// services/priceOffers: an email or a whole domain can be promised $99.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('trackrecordtest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store');
  const P = store.pool;
  const AN = require(REPO + 'server/services/agentName');
  const TR = require(REPO + 'server/services/trackRecord');
  const MKP = require(REPO + 'server/services/mediaKitPayload');
  const PO = require(REPO + 'server/services/priceOffers');
  const AB = require(REPO + 'server/services/agencyBrand');

  console.log('-- names as people write them --');
  ok('all-lowercase signup name is capitalized', AN.agentFullName({ name: 'john compton', email: 'j@x.com' }) === 'John Compton');
  ok('a name with capitals is left exactly as typed', AN.agentFullName({ name: 'Burns McNeill', email: 'b@x.com' }) === 'Burns McNeill' && AN.agentFullName({ name: 'DeAndre Whitlock' }) === 'DeAndre Whitlock');
  ok('hyphen and apostrophe parts', AN.properCase("mary-jo o'neil") === "Mary-Jo O'Neil");
  ok('display name uses the sign-off first name', AN.displayName({ name: 'john compton', sign_first_name: 'JohnMark' }) === 'JohnMark Compton');
  ok('no sign-off name: the full name, cased', AN.displayName({ name: 'john compton' }) === 'John Compton');
  ok('a placeholder is still not a name', AN.agentFullName({ name: 'Agent' }) === null && AN.displayName({ name: 'agent' }) === null);
  ok('first name for a string is cased too', AN.firstNameOrNull('john compton') === 'John');
  const brand = await AB.brandForUser({ name: 'john compton', sign_first_name: 'JohnMark', email: 'john@comptongroupllc.com' });
  ok('the kit\'s "from" line with no agency set reads JohnMark Compton', brand.name === 'JohnMark Compton' && brand.contactName === 'JohnMark Compton', brand);

  console.log('-- the track record, from what the agent recorded --');
  await P.query(`INSERT INTO users (id, email, name, role) VALUES ('ag1', 'ag1@x.com', 'jane agent', 'agent') ON CONFLICT DO NOTHING`).catch(() => {});
  await store.saveAthlete('ath-tr', { id: 'ath-tr', agentId: 'ag1', name: 'Peyton Bair', sport: 'track', school: 'University of Oregon' }).catch(async () => {
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ath-tr', 'ag1', $1)`, [{ name: 'Peyton Bair', sport: 'track', school: 'University of Oregon' }]);
  });
  let rec = await TR.forAthlete(P, 'ath-tr');
  ok('nothing recorded: an empty record, not an error (no gift table yet)', rec.partners.length === 0 && rec.delivered.total === 0, rec);
  ok('  and the kit shows no section', (await TR.forKit(P, { athlete_id: 'ath-tr' })) === null);

  await store.saveDeal('d-closed', { athleteId: 'ath-tr', agentId: 'ag1', brand: 'Farmers Union Coffee Roasters', stage: 'Closed', value: 750, closedAt: '2026-10-04T15:00:00Z' });
  await store.saveDeal('d-open', { athleteId: 'ath-tr', agentId: 'ag1', brand: 'Tomlin Health Insurance', stage: 'Prospecting', value: 250 });
  const GD = require(REPO + 'server/services/giftedDeals');
  const g1 = await GD.add(P, 'ag1', { athleteId: 'ath-tr', brand: 'Lola Blankets', retailValue: 120, receivedOn: '2026-11-02', platform: 'instagram story', postUrl: 'https://instagram.com/p/abc' });
  ok('a gift logs', g1.ok, g1);
  await GD.add(P, 'ag1', { athleteId: 'ath-tr', brand: 'farmers union coffee roasters', retailValue: 20, receivedOn: '2026-09-01', platform: 'not posted yet' });
  await P.query(`INSERT INTO athlete_calendar_events (id, athlete_id, agent_id, title, event_date, status, completed_at) VALUES
    ('e1', 'ath-tr', 'ag1', 'Post 1', '2026-10-10', 'completed', '2026-10-09T18:00:00Z'),
    ('e2', 'ath-tr', 'ag1', 'Post 2', '2026-10-20', 'completed', '2026-10-24T18:00:00Z'),
    ('e3', 'ath-tr', 'ag1', 'Post 3', '2026-11-20', 'pending', NULL)`);
  rec = await TR.forAthlete(P, 'ath-tr');
  const names = rec.partners.map((p) => p.brand);
  ok('a closed deal and a gift are partners; an open deal is not', names.length === 2 && names.includes('Farmers Union Coffee Roasters') && names.includes('Lola Blankets') && !names.includes('Tomlin Health Insurance'), rec.partners);
  ok('the same brand from a deal and a gift is one partner, with the latest month', rec.partners.find((p) => p.key === 'farmers union coffee roasters').month === '2026-10', rec.partners);
  ok('newest first', rec.partners[0].brand === 'Lola Blankets', names);
  const lola = rec.partners.find((p) => p.brand === 'Lola Blankets');
  ok('where it was posted and the link to the post', lola.platform === 'Instagram story' && lola.postUrl === 'https://instagram.com/p/abc', lola);
  ok('delivered posts and on time counted from done deliverables', rec.delivered.total === 2 && rec.delivered.onTime === 1, rec.delivered);

  console.log('-- what the business sees --');
  await MKP.ensureColumns(P);
  await P.query(`INSERT INTO media_kits (athlete_id, slug) VALUES ('ath-tr', 'peyton-bair-tr')`);
  let mk = (await P.query(`SELECT * FROM media_kits WHERE athlete_id = 'ath-tr'`)).rows[0];
  ok('new kits show the track record by default', mk.show_track_record === true, mk.show_track_record);
  let pay = await MKP.payloadFor(P, mk);
  const tr = pay.track_record;
  ok('the kit carries the track record', tr && tr.partnerCount === 2 && tr.delivered.total === 2, tr);
  ok('never an amount or a value', !/750|120|retail|value/i.test(JSON.stringify(tr)), tr);
  ok('the hidden list and the switch are not in the public payload', !('track_hidden' in pay) && !('show_track_record' in pay));
  ok('the track record carries no notes or contacts from the deal or gift', !/contact|notes|product/i.test(JSON.stringify(tr)), tr);

  const st = MKP.storyFromBody({ track_hidden: ['Lola Blankets'], show_track_record: true, worked_with: ['Dreamland BBQ'] });
  ok('the builder body: hidden brands lowercased', JSON.stringify(st.track_hidden) === '["lola blankets"]' && st.show_track_record === true, st);
  pay = await MKP.payloadFor(P, MKP.draftKit(mk, { track_hidden: ['Lola Blankets'], worked_with: ['Dreamland BBQ'] }, 'ath-tr'));
  const shown = pay.track_record.partners.map((p) => p.brand);
  ok('a hidden brand is left off; a typed "worked with" name joins, undated', !shown.includes('Lola Blankets') && shown.includes('Dreamland BBQ') && pay.track_record.partners.find((p) => p.brand === 'Dreamland BBQ').month === null, pay.track_record);
  pay = await MKP.payloadFor(P, MKP.draftKit(mk, { show_track_record: false }, 'ath-tr'));
  ok('turned off: no section', pay.track_record === null, pay.track_record);
  ok('only typed names and nothing recorded: no track record (the "worked with" line shows instead)', (await TR.forKit(P, { athlete_id: 'ath-none', worked_with: ['Dreamland BBQ'] })) === null);
  ok('"false" from a form also turns it off', MKP.storyFromBody({ show_track_record: 'false' }).show_track_record === false);
  ok('JSON columns include the hidden list', MKP.JSON_COLUMNS.includes('track_hidden') && MKP.STORY_COLUMNS.includes('show_track_record'));

  console.log('-- the $99 promise --');
  ok('a domain in any shape becomes @domain', PO.normalizeMatch('https://www.PropointAthlete.com/about') === '@propointathlete.com' && PO.normalizeMatch('@propointathlete.com') === '@propointathlete.com');
  ok('an email stays an email', PO.normalizeMatch('Joyce@PropointAthlete.com') === 'joyce@propointathlete.com');
  ok('junk is refused', PO.normalizeMatch('not a domain') === null && (await PO.add(P, { match: 'nope' })).ok === false);
  const a = await PO.add(P, { match: 'propointathlete.com', note: 'Joyce, Nov 23 call' });
  ok('an offer saves with a 14-day trial by default', a.ok && a.offer.match === '@propointathlete.com' && a.offer.trial_days === 14 && a.offer.plan === 'legacy99', a);
  ok('anyone at that domain matches', (await PO.forEmail(P, 'cofounder@propointathlete.com')).match === '@propointathlete.com');
  ok('another domain does not', (await PO.forEmail(P, 'agent@other.com')) === null);
  await PO.add(P, { match: 'joyce@propointathlete.com', trialDays: 30 });
  ok('an exact email wins over its domain', (await PO.forEmail(P, 'joyce@propointathlete.com')).trial_days === 30);
  ok('only the $99 plan can be offered', (await PO.add(P, { match: 'x.com', plan: 'free' })).ok === false);
  ok('trial days are bounded', (await PO.add(P, { match: 'x.com', trialDays: 365 })).ok === false);
  const rm = await PO.remove(P, 'joyce@propointathlete.com');
  ok('an offer can be removed', rm.ok && rm.removed === 1 && (await PO.forEmail(P, 'joyce@propointathlete.com')).match === '@propointathlete.com');

  console.log('-- the checkout honors it --');
  const src = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  const i0 = src.indexOf('async function createAgentCheckoutSession');
  const body = src.slice(i0, src.indexOf("app.post('/api/agent/create-checkout'", i0));
  const iOffer = body.indexOf("require('./services/priceOffers').forEmail");
  const iTier = body.indexOf('if (Pricing.ON()) {\n    const sp');
  ok('the offer is checked before the tier is sold', iOffer > 0 && iTier > iOffer);
  ok('the offer sells the one $99 price with the offer\'s trial', /line_items: \[\{ price: agentPrice, quantity: 1 \}\][\s\S]{0,400}trial_period_days: days/.test(body));
  ok('no $99 price set: it logs and sells the tier instead of failing', /STRIPE_AGENT_PRICE_ID is not set; selling the tier instead/.test(body));
  ok('the offer checkout writes no tier, so the agent is not limited by one', !/metadata: \{ user_id: user\.id, offer: offer\.match, tier/.test(body));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
