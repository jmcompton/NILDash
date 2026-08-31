'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// END TO END, THROUGH THE REAL fillAthlete. Real Postgres, real schema, real
// Scout, real insert. Only the two things that cost money are stubbed:
// lookupPlace and ai.getBrandContacts. The question this answers is the one the
// unit tests cannot: does a mixed slate actually turn into rows in
// outreach_queue, with the lane, the program page and the sponsor note on them.
'use strict';
const Module = require('module');
const originalLoad = Module._load;
const stub = { places: () => ({ businessStatus: 'OPERATIONAL', website: 'https://x.com', phone: '(334) 555-1212' }),
  placesCalls: [], contactCalls: [] };
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    return { ...m, lookupPlace: async (b, loc) => { stub.placesCalls.push({ b, loc }); return stub.places(b); } };
  }
  return m;
};

const ROOT = REPO;
const store = require(ROOT + 'server/store');
const ai = require(ROOT + 'server/ai');
const PW = require(ROOT + 'server/services/pitchWriter');

ai.getBrandContacts = async (brand, site, region, ctx) => {
  stub.contactCalls.push({ brand, region, ctx });
  return { contacts: [{ name: 'Dana Reed', title: 'Owner', phone: '(334) 555-9999',
    affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
    businessPhone: '(334) 555-1212', cached: true, instagram: 'danasshop', instagramScope: 'this-location' };
};
// The writer is exercised for real in writer.js; here it must not reach a model.
PW.writePitch = async () => ({ message: 'Two feed posts and an appearance at your location.',
  angle: 'campus traffic', angleKey: 'campus', categoryKey: 'retail', ask: '2 posts + appearance' });

const job = require(ROOT + 'server/jobs/outreachQueue');
const Q = require(ROOT + 'server/services/outreachQueue');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'e2e-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1 OR id='e2e-sib'`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'E2E %'`).catch(() => {});
    await P.query(`DELETE FROM social_brands WHERE brand LIKE 'E2E%'`).catch(() => {});
    await P.query(`DELETE FROM deal_comps WHERE source='e2e'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','e2e@x.com','x','agent')
                 ON CONFLICT DO NOTHING`, [AG]);

  // ── 1. AN ATHLETE WITH A MARKET GETS A MIXED SLATE ───────────────────────
  const A1 = 'e2e-a1';
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [A1, AG, JSON.stringify({ name: 'Marcus Hall', school: 'Auburn University', sport: 'Football', instagram: 24000 })]);
  for (let i = 0; i < 6; i++) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, first_seen_at, last_seen_at)
                   VALUES ('auburn, al',$1,NOW(),NOW()) ON CONFLICT DO NOTHING`, ['E2E Local ' + i]);
  }
  await P.query(`INSERT INTO social_brands
      (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
      VALUES ('E2E Apparel','apparel','https://e2e.example',ARRAY['all'],0,999999,'cash_code',
              'https://e2e.example/athletes','2026-01-01',true) ON CONFLICT (brand) DO NOTHING`);
  // WHAT BOOSTS A LOCAL BUSINESS: one that answered us for another athlete at
  // this school. A scraped news comp deliberately does NOT -- it is national
  // press evidence about collectives and big brands, and it is asserted below
  // that it stays out of the local lane.
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('e2e-sib',$1,$2::jsonb)
                 ON CONFLICT (id) DO NOTHING`,
    [AG, JSON.stringify({ name: 'Sibling', school: 'Auburn University' })]);
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,'e2e-sib','sib-k','E2E Local 2','responded')
                 ON CONFLICT DO NOTHING`, [AG]);
  await P.query(`INSERT INTO deal_comps (id, sport, school, brand, deal_value, source)
                 VALUES (990101,'Football','Auburn University','E2E Local 4',4000,'e2e')`);

  const budget = Q.newBudget(job.CAP_USD);
  const r1 = await job.fillAthlete(P, {
    agentId: AG, athleteId: A1, athleteName: 'Marcus Hall', budget,
    region: 'Auburn, AL',
    athleteProfile: require(ROOT + 'server/services/athleteRecord')
      .resolveAthlete({ id: A1, data: { name: 'Marcus Hall', school: 'Auburn University', sport: 'Football', instagram: 24000 } },
        { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool }),
  });
  ok('the night fills slots for an athlete with a market', r1.filled > 0, r1);

  const rows1 = (await P.query(
    `SELECT brand_name, lane, channel, program_url, sponsor_signal, sponsor_note
       FROM outreach_queue WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [A1])).rows;
  ok('  the rows carry the lane they came from', rows1.every((x) => !!x.lane), rows1.map((x) => x.lane));
  const boosted = rows1.find((x) => x.brand_name === 'E2E Local 2');
  ok('  the school boost survives all the way to the row',
    boosted && boosted.sponsor_signal === 'replied-at-school', boosted);
  ok('  and the row can say WHY in words',
    boosted && /another Auburn University athlete/.test(boosted.sponsor_note || ''),
    boosted && boosted.sponsor_note);
  const scrapedRow = rows1.find((x) => x.brand_name === 'E2E Local 4');
  ok('  a SCRAPED news comp does not boost a local business',
    !scrapedRow || !scrapedRow.sponsor_signal, scrapedRow);

  // ── 2. NO SCHOOL: THE LOCAL LANE IS SILENT, THE ATHLETE IS NOT ───────────
  // This is the case that used to return before the Scout ever ran.
  const A2 = 'e2e-a2';
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [A2, AG, JSON.stringify({ name: 'No School', hometown: 'Knoxville, TN', sport: 'Football', instagram: 18000 })]);
  stub.placesCalls.length = 0; stub.contactCalls.length = 0;
  const r2 = await job.fillAthlete(P, {
    agentId: AG, athleteId: A2, athleteName: 'No School', budget: Q.newBudget(job.CAP_USD),
    region: '',
    athleteProfile: require(ROOT + 'server/services/athleteRecord')
      .resolveAthlete({ id: A2, data: { name: 'No School', hometown: 'Knoxville, TN', sport: 'Football', instagram: 18000 } },
        { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool }),
  });
  ok('AN ATHLETE WITH NO SCHOOL IS NO LONGER BLANKED', r2.filled > 0, r2);
  const rows2 = (await P.query(
    `SELECT brand_name, lane, channel, program_url FROM outreach_queue
      WHERE athlete_id=$1 AND state='queued'`, [A2])).rows;
  ok('  and NOTHING it got is local', rows2.every((x) => x.lane !== 'local'), rows2.map((x) => x.lane));
  ok('  THE HOMETOWN WAS NOT SUBSTITUTED: no Knoxville lookup happened',
    !stub.placesCalls.some((c) => /Knoxville/i.test(c.loc || '')), stub.placesCalls);
  ok('  no Places call at all, because there was no local lane to run',
    stub.placesCalls.length === 0, stub.placesCalls);
  ok('  and no paid contact lookup either',
    stub.contactCalls.length === 0, stub.contactCalls);
  ok('  the card is routed to the program page, not a phone',
    rows2.every((x) => x.channel === 'program' && !!x.program_url), rows2);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
