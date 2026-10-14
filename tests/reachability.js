'use strict';
// Needs the test Postgres.
//
//   node tests/reachability.js
//
// ── WHICH BUSINESSES TURN INTO A VERIFIED EMAIL ─────────────────────────────
// services/reachability learns, from our own history, how often each business
// type and each signal ended in a verified address for a named person -- and
// is used to RANK WITHIN A TYPE, never to filter or to push one type behind
// another.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const R = require(REPO + 'server/services/reachability.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d).slice(0, 700))); if (!c) F++; };
const AG = 'rc-agent';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await R.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM email_verification WHERE email LIKE '%@rc-%'`);
    await P.query(`DELETE FROM brand_evidence_cache WHERE lower(brand) LIKE 'rc %'`);
    await P.query(`DELETE FROM reachability_model`);
    R._resetCache();
  };
  await clean();

  console.log('\nthe pieces');
  ok(R.contactClass('Owner') === 'owner' && R.contactClass('Co-Founder') === 'owner' && R.contactClass('President') === 'owner', 'owner, founder, officer: owner');
  ok(R.contactClass('Marketing Director') === 'marketing' && R.contactClass('Brand Partnerships Lead') === 'marketing', 'marketing titles: marketing');
  ok(R.contactClass('General Manager') === 'gm' && R.contactClass('Store Manager') === 'gm', 'general manager, manager: gm');
  ok(R.contactClass('Barista') === 'other', 'anything else: other');
  ok(R.sizeBucket({ people: 2 }) === 'about 5 or fewer' && R.sizeBucket({ headcount: '1-10', people: 0 }) === 'about 5 or fewer', 'two people named, or Hunter says 1-10: about 5 or fewer');
  ok(R.sizeBucket({ people: 7 }) === '6-10' && R.sizeBucket({ headcount: '11-50', people: 1 }) === '11+' && R.sizeBucket({ people: 1, chain: true }) === '11+', 'seven people: 6-10; Hunter 11-50 or a chain: 11+');
  ok(R.sizeBucket({ people: 1, type: 'bank' }) === 'unknown' && R.sizeBucket({}) === 'unknown', 'a bank is never assumed tiny; nothing known: unknown');

  console.log('\nlearning from our history');
  // Restaurants: 6 tried, 5 verified. Salons: 6 tried, 1 verified. Gyms: 1 tried, 1 verified.
  // The three ways an attempt counts as verified are all used.
  const tried = [];
  const add = (brand, type, opts) => tried.push({ brand, result: opts.queued ? 'queued' : 'rejected', places: { found: true, hasWebsite: !!opts.placesSite, primaryType: type },
    why: { website: opts.site ? `https://${opts.site}` : null, type, person: opts.person || null, size: opts.size || 'unknown', finder: opts.finderOk ? { verifiedNamed: true } : undefined } });
  for (let i = 0; i < 4; i++) add(`RC Taco ${i}`, 'restaurant', { site: `rc-taco${i}.com`, placesSite: true, finderOk: true, person: { name: 'Ana Ruiz', title: 'Owner' }, size: 'about 5 or fewer' });
  add('RC Taco 4', 'restaurant', { site: 'rc-taco4.com', placesSite: true, queued: true, person: { name: 'Bo Lin', title: 'Owner' } });      // card + email_verified
  add('RC Taco 5', 'restaurant', { site: null, placesSite: false, person: { name: 'Cy Doe', title: 'General Manager' } });                   // not verified
  add('RC Snip 0', 'salon', { site: 'rc-snip0.com', placesSite: true, person: { name: 'Dee Fox', title: 'Owner' } });                        // a valid address at the domain carrying her name
  for (let i = 1; i < 6; i++) add(`RC Snip ${i}`, 'salon', { site: null, placesSite: false, person: { name: 'Eve Gu', title: 'Manager' } });
  add('RC Lift 0', 'gym', { site: 'rc-lift0.com', placesSite: true, finderOk: true, person: { name: 'Fay Ho', title: 'Owner' } });
  tried.push({ brand: 'RC Never', result: 'rejected', reason: 'prescreen' });                     // never reached the contact lookup: not an attempt
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details) VALUES ($1, CURRENT_DATE, 1, $2)`, [AG, JSON.stringify([{ athleteId: 'rc-ath', tried }])]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, email, email_verified, contact_name, contact_title, business_category)
    VALUES ($1, 'rc-ath', 1, 'RC Taco 4', 'RC Taco 4', 'email', 'bo@rc-taco4.com', TRUE, 'Bo Lin', 'Owner', 'restaurant')`, [AG]);
  await P.query(`INSERT INTO email_verification (email, result, source, status) VALUES ('dee.fox@rc-snip0.com', 'valid', 'hunter', 'valid') ON CONFLICT (email) DO UPDATE SET result = 'valid', checked_at = NOW()`);
  const attempts = (await R.gatherAttempts(P, { days: 7 })).filter((a) => ['restaurant', 'salon', 'gym'].includes(a.signals.type));
  const of = (t) => attempts.filter((a) => a.signals.type === t);
  ok(attempts.length === 13, 'every business taken to the contact lookup is an attempt; one never looked up is not', attempts.length);
  ok(of('restaurant').filter((a) => a.verified).length === 5 && of('salon').filter((a) => a.verified).length === 1,
    '  verified: the finder\'s own record, an email card the verifier confirmed, and a valid address at the domain carrying the person\'s name',
    [of('restaurant').filter((a) => a.verified).length, of('salon').filter((a) => a.verified).length]);
  const s0 = of('restaurant')[0].signals;
  ok(s0.website === 'yes' && s0.placesWebsite === 'yes' && s0.ownerNamed === 'yes' && s0.size === 'about 5 or fewer', '  the signals are read off the night\'s record', s0);

  const model = R.build(attempts, { windowDays: 7 });
  ok(Math.abs(model.types.restaurant.rate - 5 / 6) < 1e-9 && Math.abs(model.types.salon.rate - 1 / 6) < 1e-9, 'each type scored by how often it ended in a verified email', model.types);
  ok(model.types.gym.rate === 1 && model.types.gym.score < 0.8, '  smoothed: one gym that worked does not make gyms a sure thing', model.types.gym);
  ok(model.signals.website.yes.score > model.signals.website.no.score && model.signals.ownerNamed.yes.score > model.signals.ownerNamed.no.score,
    '  and each signal: a website and a named owner both help here', [model.signals.website, model.signals.ownerNamed]);
  const better = R.scoreOf(model, { type: 'salon', website: 'yes', ownerNamed: 'yes' });
  const worse = R.scoreOf(model, { type: 'salon', website: 'no', ownerNamed: 'no' });
  ok(better > worse, 'a salon with a website and a named owner scores above one with neither', [better, worse]);

  console.log('\nrank within type, never filter');
  const cands = [
    { brand_name: 'A salon (no site)', businessCategory: 'salon', s: 0.1 },
    { brand_name: 'B taco', businessCategory: 'restaurant', s: 0.5 },
    { brand_name: 'C salon (site)', businessCategory: 'salon', s: 0.9 },
    { brand_name: 'D unknown', businessCategory: null, s: 0.99 },
    { brand_name: 'E taco (best)', businessCategory: 'restaurant', s: 0.95 },
  ];
  const ordered = R.smartOrder(cands, (c) => c.s);
  ok(JSON.stringify(ordered.map((c) => c.businessCategory)) === JSON.stringify(cands.map((c) => c.businessCategory)), 'every type keeps exactly the positions it held: no type moves behind another', ordered.map((c) => c.businessCategory));
  ok(ordered[0].brand_name === 'C salon (site)' && ordered[2].brand_name === 'A salon (no site)' && ordered[1].brand_name === 'E taco (best)', '  within a type, the more reachable goes first', ordered.map((c) => c.brand_name));
  ok(ordered.length === cands.length && ordered[3].brand_name === 'D unknown', '  nothing is dropped, and an unknown type keeps its place');
  ok(R.smartOrder(cands, () => null).every((c, i) => c === cands[i]), '  with no model, the order is untouched');

  console.log('\nweekly, stored, and printed');
  const m1 = await R.recompute(P, { days: 7 });
  ok(m1.attempts >= 13 && (await R.latest(P)).attempts === m1.attempts, 'recompute stores the model; latest reads it');
  ok((await R.recomputeIfStale(P)).skipped === 'fresh', 'a model less than a week old is not recomputed');
  await P.query(`UPDATE reachability_model SET computed_at = NOW() - INTERVAL '8 days'`);
  const again = await R.recomputeIfStale(P);
  ok(again.model && (await P.query(`SELECT COUNT(*)::int n FROM reachability_model`)).rows[0].n === 2, 'a week old: recomputed', again.skipped);
  const text = R.format(m1);
  ok(/BY BUSINESS TYPE/.test(text) && /restaurant/.test(text) && /BY SIGNAL: a website confirmed as theirs/.test(text) && /not an employee count/.test(text)
    && /rank WITHIN a type only/.test(text), 'the report: types, signals, what size means, and how it is used');
  ok(/scheduler/.test(require('fs').readFileSync(REPO + 'server/index.js', 'utf8').split('Reachability, recomputed weekly')[1].slice(0, 600)), 'the weekly recompute is scheduled');

  console.log('\nsignals for candidates, from the cache only');
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at) VALUES
    ('rc cafe | waco, tx | manual', 'contacts', 'RC Cafe', 'https://rc-cafe.com', $1, 'OK', NOW()),
    ('rc cafe | waco, tx | v1', 'places', 'RC Cafe', 'https://rc-cafe.com', $2, 'OK', NOW())
    ON CONFLICT (brand_key, lane) DO NOTHING`, [JSON.stringify({ contacts: [{ name: 'Gil Hart', title: 'Owner' }] }), JSON.stringify({ found: true, website: 'https://rc-cafe.com' })]);
  const sig = await R.candidateSignals(P, [{ brand_name: 'RC Cafe', businessCategory: 'coffee' }, { brand_name: 'RC Unknown', businessCategory: 'gym' }]);
  ok(JSON.stringify(sig.get('rc cafe')) === JSON.stringify({ type: 'coffee', website: 'yes', placesWebsite: 'yes', ownerNamed: 'yes', size: 'about 5 or fewer' }), 'a business looked up before: its website, Places field, owner and size', sig.get('rc cafe'));
  ok(sig.get('rc unknown').type === 'gym' && sig.get('rc unknown').website === 'unknown', '  one never looked up: only its type');

  await clean();
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
