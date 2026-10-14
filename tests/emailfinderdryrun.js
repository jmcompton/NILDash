'use strict';
// Needs the test Postgres. No network: the contact rebuild and Hunter are stubbed.
//
//   node tests/emailfinderdryrun.js
//
// ── THE DRY RUN: BEFORE AND AFTER, AND NOTHING CHANGED ──────────────────────
// services/emailFinderDryRun re-runs the email finder over the last nights' DM
// and call cards. It must count before and after honestly, add up what it
// spent, and leave every card and draft exactly as it found them.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const D = require(REPO + 'server/services/emailFinderDryRun.js');
const { checkDomain } = require(REPO + 'server/services/domainGate.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d))); if (!c) F++; };

const AG = 'efd-agent';
const owner = (name, extra) => ({ name, title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: null, ...(extra || {}) });
// Three businesses, three outcomes:
//   Alder Pizza    a named example on the site shows the format; tom.smith@ verifies
//   Birch Cycles   no addresses; Hunter Email Finder's answer verifies
//   Cedar Barber   nothing verifies (every format invalid)
const LADDERS = {
  'Alder Pizza': () => ({ tiers: [{ tier: 1, rows: [owner('Tom Smith'), { name: 'Sara Lee', title: 'Manager', source: 'site', sources: ['site'], email: 'sara.lee@alderpizza.com', emailKind: 'published' }] }], businessDomain: 'alderpizza.com' }),
  'Birch Cycles': () => ({ tiers: [{ tier: 1, rows: [owner('Ann Bee')] }], businessDomain: 'birchcycles.com' }),
  'Cedar Barber': () => ({ tiers: [{ tier: 1, rows: [owner('Cal Dee')] }], businessDomain: 'cedarbarber.com' }),
};
const VALID = new Set(['tom.smith@alderpizza.com', 'ann@birchcycles.com']);
const verified = [];
const deps = {
  regionOf: async () => 'Waco, TX',
  rebuild: async (card) => ({ ladder: LADDERS[card.brand_name](), out: { website: 'https://' + LADDERS[card.brand_name]().businessDomain },
    ig: { instagram: 'handle_' + card.id, instagramScope: 'business' }, place: null, meter: null }),
  finderDeps: () => ({
    verify: async (e) => { verified.push(e); return VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' }; },
    peek: async () => new Map(),
    domainSearch: async () => null,
    emailFinder: async (f, l, dom) => (dom === 'birchcycles.com' ? { email: 'ann@birchcycles.com', score: 90 } : { email: null }),
    resolveDomain: async () => ({ website: null, tried: [] }),
    checkDomain,
    siteEmail: async () => null,
    corporate: () => null,
  }),
};

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => {});
  let slot = 7100;
  const why = (site) => ({ channel: 'dm', website: 'https://' + site, ladderEmails: [], refusedKinds: [], addressSteps: ['1:website, named person=miss (fetched-empty)', '2:Hunter=miss (no surname match and no pattern)'] });
  const tried = [];
  for (const [b, site, ch, who] of [['Alder Pizza', 'alderpizza.com', 'dm', 'Tom Smith'], ['Birch Cycles', 'birchcycles.com', 'call', 'Ann Bee'], ['Cedar Barber', 'cedarbarber.com', 'dm', 'Cal Dee']]) {
    await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, lane, contact_name, contact_title, instagram)
      VALUES ($1, 'efd-ath', $2, $3, $3, $4, 'local', $5, 'Owner', 'h')`, [AG, slot++, b, ch, who]);
    tried.push({ brand: b, result: 'queued', why: why(site) });
  }
  // One email card the same night, so the channel mix and the projection have one.
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, lane, contact_name, email)
    VALUES ($1, 'efd-ath', $2, 'Dogwood Deli', 'Dogwood Deli', 'email', 'local', 'Dee Dog', 'dee@dogwooddeli.com')`, [AG, slot++]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details) VALUES ($1, CURRENT_DATE, 4, $2)
    ON CONFLICT (agent_id, run_date) DO UPDATE SET details = EXCLUDED.details`, [AG, JSON.stringify([{ athleteId: 'efd-ath', tried }])]);
  const snapshot = async () => (await P.query(`SELECT id, channel, email, state, updated_at FROM outreach_queue WHERE agent_id = $1 ORDER BY id`, [AG])).rows;
  const before = await snapshot();

  const out = await D.run(P, { days: 7, deps, concurrency: 2 });
  const mine = out.results.filter((x) => /Alder|Birch|Cedar/.test(x.brand));
  ok(mine.length === 3, 'every DM and call card was re-run', out.results.map((x) => x.brand));
  const by = Object.fromEntries(mine.map((x) => [x.brand, x]));
  ok(by['Alder Pizza'].verifiedNamed && by['Alder Pizza'].email === 'tom.smith@alderpizza.com', 'Alder Pizza: the site\'s pattern builds Tom\'s address, verified', by['Alder Pizza']);
  ok(by['Birch Cycles'].verifiedNamed && /Email Finder/.test(by['Birch Cycles'].how), 'Birch Cycles: Hunter Email Finder, verified', by['Birch Cycles']);
  ok(!by['Cedar Barber'].verifiedNamed && by['Cedar Barber'].after === 'dm', 'Cedar Barber: nothing verifies, stays a DM', by['Cedar Barber']);
  ok(mine.every((x) => x.reason), 'each carries its reason from the report', mine.map((x) => x.reason));

  const text = D.format(out);
  if (process.env.SHOW) console.log(text);
  ok(/BEFORE: 0 of \d+ had a verified email/.test(text), 'BEFORE line', text.split('\n')[2]);
  ok(/AFTER: +\d+ of \d+ checked/.test(text) && text.includes('now have one'), 'AFTER line');
  ok(/EXPECTED HUNTER CREDITS PER NIGHT/.test(text) && /verifications and ~\d+ searches a night/.test(text), 'expected Hunter credits per night');
  ok(/HELD BACK BY THE CATCH-ALL RULE/.test(text), 'the catch-all question is put to the reader');
  ok(/WHAT THIS RUN SPENT/.test(text), 'what it spent');
  const spent = mine.reduce((a, x) => a + x.credits.verify, 0);
  ok(spent === verified.length && spent > 0, 'every verification made is counted as a credit (none were cached here)', { spent, verified: verified.length });

  const after = await snapshot();
  ok(JSON.stringify(after) === JSON.stringify(before), 'no card changed: channel, email, state, updated_at all as they were');
  const logs = (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  ok(logs === 0, 'no draft or send written');

  // A deadline stops it and says so.
  const cut = await D.run(P, { days: 7, deps, concurrency: 1, deadlineMs: -1 });
  ok(cut.stoppedFor && /limit/.test(cut.stoppedFor) && /STOPPED EARLY/.test(D.format(cut)), 'a run that hits its time limit stops and says so', cut.stoppedFor);

  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
