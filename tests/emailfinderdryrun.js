'use strict';
// Needs the test Postgres. No network: the contact rebuild and Hunter are stubbed.
//
//   node tests/emailfinderdryrun.js
//
// ── THE DRY RUN: BEFORE AND AFTER, AND NOTHING CHANGED ──────────────────────
// services/emailFinderDryRun re-runs the email finder over the last nights'
// cards -- DM and call cards, and the email cards too -- and prints emails per
// athlete per night, before and after. It must count honestly, retry a check
// that could not run, name the likely chains, add up what it spent, and leave
// every card and draft exactly as it found them.
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
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d).slice(0, 700))); if (!c) F++; };

const AG = 'efd-agent';
const owner = (name, extra) => ({ name, title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: null, ...(extra || {}) });
// Six businesses on one athlete's night:
//   Alder Pizza    DM: a named example on the site shows the format; tom.smith@ verifies
//   Birch Cycles   call: no addresses; Hunter Email Finder's answer verifies
//   Cedar Barber   DM: nothing verifies for the owner; the GM's address does (MORE)
//   Elm Grill      DM: the check could not run the first time; verifies on the retry (MORE)
//   Buckle         DM: a chain, named for the chain list
//   Dogwood Deli   an email card already: its own address verifies
const LADDERS = {
  'Alder Pizza': () => ({ tiers: [{ tier: 1, rows: [owner('Tom Smith'), { name: 'Sara Lee', title: 'Manager', source: 'site', sources: ['site'], email: 'sara.lee@alderpizza.com', emailKind: 'published' }] }], businessDomain: 'alderpizza.com' }),
  'Birch Cycles': () => ({ tiers: [{ tier: 1, rows: [owner('Ann Bee')] }], businessDomain: 'birchcycles.com' }),
  'Cedar Barber': () => ({ tiers: [{ tier: 1, rows: [owner('Cal Dee'), { name: 'Gina Moore', title: 'General Manager', source: 'site', sources: ['site'], email: null }] }], businessDomain: 'cedarbarber.com' }),
  'Elm Grill': () => ({ tiers: [{ tier: 1, rows: [owner('Eve Lin')] }], businessDomain: 'elmgrill.com' }),
  Buckle: () => ({ tiers: [{ tier: 1, rows: [owner('Bo Kay')] }], businessDomain: 'buckle.com' }),
  'Dogwood Deli': () => ({ tiers: [{ tier: 1, rows: [owner('Dee Dog', { email: 'dee@dogwooddeli.com', emailKind: 'published' })] }], businessDomain: 'dogwooddeli.com' }),
};
const VALID = new Set(['tom.smith@alderpizza.com', 'ann@birchcycles.com', 'gina.moore@cedarbarber.com', 'eve.lin@elmgrill.com', 'dee@dogwooddeli.com']);
let elmNotRun = 1;
const verified = [];
const deps = {
  regionOf: async () => 'Waco, TX',
  rebuild: async (card) => ({ ladder: LADDERS[card.brand_name](), out: { website: 'https://' + LADDERS[card.brand_name]().businessDomain },
    ig: { instagram: 'handle_' + card.id, instagramScope: 'business' }, place: null, meter: null }),
  finderDeps: () => ({
    verify: async (e) => {
      verified.push(e);
      if (/@elmgrill\.com$/.test(e) && elmNotRun > 0) { elmNotRun--; return { result: 'unknown', status: null, notRun: true, source: 'hunter' }; }
      return VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' };
    },
    peek: async () => new Map(), domainSearch: async () => null, hunterCached: async () => null,
    emailFinder: async (f, l, dom) => (dom === 'birchcycles.com' ? { email: 'ann@birchcycles.com', score: 90 } : { email: null }),
    resolveDomain: async () => ({ website: null, tried: [] }), checkDomain, siteEmail: async () => null,
    placeLookup: async () => null, facebookPage: async () => null, corporate: () => null,
  }),
};

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id = 'efd-ath'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('efd-ath', $1, '{"name":"Efd Athlete"}'::jsonb) ON CONFLICT (id) DO NOTHING`, [AG]).catch(() => {});
  let slot = 7100;
  const why = (site) => ({ channel: 'dm', website: 'https://' + site, ladderEmails: [], refusedKinds: [], addressSteps: ['1:website, named person=miss (fetched-empty)', '2:Hunter=miss (no surname match and no pattern)'] });
  const tried = [];
  for (const [b, ch, who] of [['Alder Pizza', 'dm', 'Tom Smith'], ['Birch Cycles', 'call', 'Ann Bee'], ['Cedar Barber', 'dm', 'Cal Dee'], ['Elm Grill', 'dm', 'Eve Lin'], ['Buckle', 'dm', 'Bo Kay']]) {
    await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, lane, contact_name, contact_title, instagram)
      VALUES ($1, 'efd-ath', $2, $3, $3, $4, 'local', $5, 'Owner', 'h')`, [AG, slot++, b, ch, who]);
    tried.push({ brand: b, result: 'queued', why: why(LADDERS[b]().businessDomain) });
  }
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, lane, contact_name, email)
    VALUES ($1, 'efd-ath', $2, 'Dogwood Deli', 'Dogwood Deli', 'email', 'local', 'Dee Dog', 'dee@dogwooddeli.com')`, [AG, slot++]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details) VALUES ($1, CURRENT_DATE, 6, $2)
    ON CONFLICT (agent_id, run_date) DO UPDATE SET details = EXCLUDED.details`, [AG, JSON.stringify([{ athleteId: 'efd-ath', tried }])]);
  const snapshot = async () => (await P.query(`SELECT id, channel, email, state, email_verified, updated_at FROM outreach_queue WHERE agent_id = $1 ORDER BY id`, [AG])).rows;
  const before = await snapshot();

  const out = await D.run(P, { days: 7, deps, concurrency: 2, retryGapMs: 0 });
  const mine = out.results.filter((x) => x.athleteId === 'efd-ath');
  const by = Object.fromEntries(mine.map((x) => [x.brand, x]));
  ok(mine.length === 6, 'every card of the night was re-run, the email card too', mine.map((x) => x.brand));
  ok(by['Alder Pizza'].verifiedNamed && by['Alder Pizza'].email === 'tom.smith@alderpizza.com', 'Alder Pizza: the site\'s pattern builds Tom\'s address, verified', by['Alder Pizza']);
  ok(by['Birch Cycles'].verifiedNamed && /Email Finder/.test(by['Birch Cycles'].how), 'Birch Cycles: Hunter Email Finder, verified', by['Birch Cycles']);
  ok(by['Cedar Barber'].verifiedNamed && by['Cedar Barber'].switchedTo && by['Cedar Barber'].person === 'Gina Moore', 'Cedar Barber: the owner cannot be verified; the GM can, and the card goes to her', by['Cedar Barber']);
  ok(by['Elm Grill'].verifiedNamed && by['Elm Grill'].tries === 2 && out.recovered >= 1, 'Elm Grill: the check could not run, was asked again, and verified', by['Elm Grill']);
  ok(by['Dogwood Deli'].verifiedNamed && by['Dogwood Deli'].channelBefore === 'email', 'Dogwood Deli: an email card already, its address verified', by['Dogwood Deli']);
  ok(mine.every((x) => x.reason), 'each carries its reason from the report', mine.map((x) => x.reason));

  const text = D.format(out);
  if (process.env.SHOW) console.log(text);
  const row = text.split('\n').find((l) => /Efd Athlete/.test(l));
  ok(/EMAILS PER ATHLETE PER NIGHT, BEFORE AND AFTER/.test(text) && row && /\s6\s+1\s+5\s*$/.test(row), 'emails per athlete per night: 6 placed, 1 email before, 5 verified after', row);
  ok(/Average per athlete-night: before [\d.]+, after [\d.]+/.test(text) && /is a floor/.test(text), '  with the average, and the honest note that "after" is a floor under the five rule');
  ok(/DM AND CALL CARDS: before 0 of \d+ had a verified email/.test(text) && /EMAIL CARDS: \d+ of \d+ checked carry a verified address/.test(text), 'DM/call and email card lines');
  ok(/switched to another named decision maker/.test(text) && /checks that could not run were retried; \d+ then verified/.test(text), 'what the extra steps found');
  ok(/LIKELY NATIONAL CHAINS AMONG THESE CARDS/.test(text) && /Buckle\s+on the chain list \(buckle\)/.test(text), 'the likely chains, for the chain list: Buckle', text.split('\n').filter((l) => /CHAIN|Buckle/.test(l)));
  ok(/EXPECTED HUNTER CREDITS PER NIGHT/.test(text) && /WHAT THIS RUN SPENT/.test(text), 'the credits it spent and expects');
  const spent = mine.reduce((a, x) => a + x.credits.verify, 0);
  // Every check made is a credit, except the one that could not run (Elm
  // Grill's first): Hunter charges nothing for it.
  ok(spent === verified.length - 1 && spent > 0, 'every verification made is counted as a credit; the one that could not run is not', { spent, verified: verified.length });

  const base = await D.run(P, { days: 7, deps, concurrency: 2, retryGapMs: 0, more: false });
  const bc = base.results.find((x) => x.brand === 'Cedar Barber');
  ok(bc && !bc.verifiedNamed && /base finder only/.test(D.format(base)), 'base=1 runs the finder without the extra steps, for comparison', bc);

  const after = await snapshot();
  ok(JSON.stringify(after) === JSON.stringify(before), 'no card changed: channel, email, state, verified flag, updated_at all as they were');
  const logs = (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  ok(logs === 0, 'no draft or send written');

  const cut = await D.run(P, { days: 7, deps, concurrency: 1, deadlineMs: -1 });
  ok(cut.stoppedFor && /limit/.test(cut.stoppedFor) && /STOPPED EARLY/.test(D.format(cut)), 'a run that hits its time limit stops and says so', cut.stoppedFor);

  await clean();
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
