'use strict';
// Five cards a team here, not the night's default two: these fixtures climb
// every rung (from file, social, bought for the card, new ground), and two
// cards a team stops after the first two. tests/univperteam.js checks two.
process.env.UNIVERSITY_CARDS_PER_TEAM = '5';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/campusmarket.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A DEPARTMENT'S TOWN: THE DEEP POOL AND A NAME AT EVERY BUSINESS ─────────
// Part 1 of the Cypress product: the pool pushed past 1,000 businesses ring by
// ring, then the full contact ladder on every one, and the report's three
// numbers. Places and the contact sources are stubbed.
const store = require(REPO + 'server/store.js');
const CP = require(REPO + 'server/services/campusPool.js');
const CC = require(REPO + 'server/services/campusContacts.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const UNI = 'univ-cmtest', MK = 'cmtown, ca';
const place = (name, i, extra) => ({ name, place_id: 'cm-' + i, types: ['restaurant'], category: 'restaurant', address: i + ' Main St, Cmtown',
  lat: 33.8 + i * 0.0001, lng: -118.0, rating: 4.4, user_ratings_total: 100, chain: false, market: 'school', ...(extra || {}) });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await CP.ensureTables(P);
  await require(REPO + 'server/services/teamScan.js').ensureTables(P);
  const clean = async () => {
    for (const t of ['university_contacts', 'university_market_runs', 'university_crm', 'university_touches']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [UNI]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [UNI]);
    await P.query(`DELETE FROM universities WHERE id = $1`, [UNI]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Cm Test College','CMT','1 College Way, Cmtown, CA 90000')`, [UNI]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES
    ('cm:wbb',$1,'Women''s Basketball','basketball',$2), ('cm:sb',$1,'Softball','softball',$2), ('cm:mwp',$1,'Men''s Water Polo','water polo',$2)`, [UNI, MK]);

  // ── 1. THE DEEP POOL ──────────────────────────────────────────────────────
  OUT.push('-- the pool, ring by ring --');
  // 8 km: 40 businesses; 12 km: 90; 16 km: 140 (target 120 here).
  const rings = [];
  const fakePlaces = { buildMarketPoolFromPlaces: async (q, opts) => {
    const r = opts.radiusM; rings.push(r);
    const n = r >= 16000 ? 140 : r >= 12000 ? 90 : 40;
    const list = Array.from({ length: n }, (_, i) => place(`Cm Biz ${i}`, i));
    list.push(place('Cm Lucky Casino', 999, { types: ['casino'], category: 'entertainment' }));
    return { ok: true, candidates: list, placesCalls: 30, geocoded: { lat: 33.8, lng: -118.0 } };
  } };
  const d = await CP.deepen(P, UNI, { places: fakePlaces, target: 120, rings: [8000, 12000, 16000, 24000] });
  ok('it widens ring by ring until the target and stops there', d.ok && JSON.stringify(rings) === '[8000,12000,16000]' && d.after.usable === 140 && d.reached, { rings, d: d.after });
  ok('  a blocked business is kept in the pool, marked, and not counted as usable', d.after.total === 141, d.after);
  ok('  the cost is recorded: 90 Places requests', d.placesCalls === 90 && d.costUsd === 2.88, d);
  const runRow = (await P.query(`SELECT summary FROM university_market_runs WHERE university_id = $1 AND kind = 'pool'`, [UNI])).rows[0];
  ok('  on university_market_runs', runRow && runRow.summary.placesCalls === 90);

  // ── 2. THE CONTACTS ───────────────────────────────────────────────────────
  OUT.push('', '-- a named human and a way to reach them --');
  // Biz 0-99: a named owner with email. 100-119: no named person in the ladder,
  // the owner search finds one, business phone. 120-129: Instagram only + owner
  // search. 130-134: nothing at all. 135-139: our failure.
  const calls = { ladder: 0, owner: 0, history: 0 };
  const ai = {
    deepContactCtx: (o) => ({ ...o }),
    getBrandContacts: async (brand) => {
      calls.ladder++;
      const i = Number(brand.split(' ').pop());
      if (i >= 135) throw new Error('Places timed out');
      if (i < 100) return { contacts: [{ name: 'Dana Reed', title: 'Owner', email: `dana${i}@biz.test`, source: 'site', sourceUrl: 'https://biz.test/about' }],
        businessPhone: '(714) 555-0100', website: 'https://biz.test', instagram: null, addressLadder: {} };
      if (i < 120) return { contacts: [], businessPhone: '(714) 555-0101', website: 'https://biz.test', addressLadder: {} };
      if (i < 130) return { contacts: [], businessPhone: null, instagram: '@cmbiz' + i, addressLadder: {} };
      return { contacts: [], businessPhone: null, instagram: null, addressLadder: {} };
    },
    webSearchJson: async (prompt) => {
      if (/sponsored local athletes/.test(prompt)) {
        calls.history++;
        const yes = /Cm Biz 7"/.test(prompt);
        return { text: JSON.stringify(yes ? { history: true, note: 'Sponsors Cypress High football', url: 'https://news.test/cm7' } : { history: false, note: '', url: '' }),
          citations: yes ? ['https://news.test/cm7'] : [] };
      }
      calls.owner++;
      const i = Number((prompt.match(/Cm Biz (\d+)/) || [])[1]);
      if (i >= 130) return { text: '{"name": null}', citations: [] };
      return { text: JSON.stringify({ name: 'Sam Ortiz', title: 'Owner', confidence: 'high' }), citations: ['https://chamber.test/x'], searches: 1 };
    },
  };
  const r = await CC.run(P, UNI, { ai, concurrency: 3 });
  ok('every usable business was worked; the blocked one never was', r.ok && r.seeded === 140 && r.done === 140, r);
  const row = async (b) => (await P.query(`SELECT * FROM university_contacts WHERE university_id = $1 AND brand = $2`, [UNI, b])).rows[0];
  const a = await row('Cm Biz 5');
  ok('a named owner with an email: reachable, everything stored', a.reachable && a.contact_name === 'Dana Reed' && a.contact_title === 'Owner'
    && a.email === 'dana5@biz.test' && a.phone === '(714) 555-0100' && a.website === 'https://biz.test' && a.status === 'reachable', a);
  const b = await row('Cm Biz 110');
  ok('no person in the ladder: the plain owner search finds one, with the business phone: reachable', b.reachable && b.contact_name === 'Sam Ortiz' && b.phone && !b.email, b);
  const c = await row('Cm Biz 125');
  ok('an Instagram DM handle is a way to reach: reachable without email or phone', c.reachable && c.instagram === 'cmbiz125' && !c.email && !c.phone, c);
  const n = await row('Cm Biz 132');
  ok('nothing found anywhere: unreachable, after every source was tried', !n.reachable && n.status === 'unreachable', n);
  const e = await row('Cm Biz 137');
  ok('our failure is an error to retry, never "unreachable"', e.status === 'error' && /timed out/.test(e.last_error) && e.attempts === 1, e);
  ok('athlete or NIL history is recorded only when a source says so', (await row('Cm Biz 7')).athlete_history === true && /Cypress High/.test((await row('Cm Biz 7')).athlete_history_note)
    && (await row('Cm Biz 8')).athlete_history === false);
  ok('the blocked casino has no contact row at all', !(await row('Cm Lucky Casino')));
  const fit = (await row('Cm Biz 5')).team_fit;
  ok('every business carries which teams it fits and why', Array.isArray(fit) && fit.length === 3 && fit.every((f) => f.team_id && f.why), fit);
  const fitSwim = CC.teamFit({ brand: 'Cypress Swim Shop', category: 'retail', types: [], distance_m: 2000 }, [{ id: 'a', name: 'Softball', sport: 'softball' }, { id: 'b', name: "Men's Water Polo", sport: 'water polo' }]);
  ok('  a swim shop fits water polo ahead of softball, saying why', fitSwim[0].team === "Men's Water Polo" && /water polo business/.test(fitSwim[0].why), fitSwim);

  // ── 3. RESUMABLE, AND THE REPORT ──────────────────────────────────────────
  OUT.push('', '-- resumable, and the three numbers --');
  const before = calls.ladder;
  const r2 = await CC.run(P, UNI, { ai, concurrency: 2 });
  ok('a second run only retries the errors, not the resolved', r2.todo === 5 && calls.ladder - before === 5, r2);
  const rep = await CC.report(P, UNI);
  ok('hit rate = reachable / resolved: 130 of 135', rep.contacts.resolved === 135 && rep.contacts.reachable === 130 && Math.abs(rep.hitRate - 130 / 135) < 1e-9, rep.contacts);
  ok('  with email 100, with phone 120, DM only 10', rep.contacts.with_email === 100 && rep.contacts.with_phone === 120 && rep.contacts.dm_only === 10, rep.contacts);
  ok('the build cost is reported: the pool runs and the contact lookups', rep.poolCostUsd === 2.88 && typeof rep.contactsCostUsd === 'number');
  ok('the nightly estimate is 5 cards a team', rep.nightly.cards === 15 && rep.nightly.usd > 0, rep.nightly);
  const text = CC.formatReport(rep);
  ok('the text report says the three numbers', /1\. CONTACT HIT RATE: 130 of 135/.test(text) && /2\. COST OF THE DEEP BUILD/.test(text) && /3\. NIGHTLY ESTIMATE: 15 cards/.test(text), text);
  ok('  and says to stop when the rate is under 60%', /UNDER 60%/.test(CC.formatReport({ ...rep, hitRate: 0.4 })));
  const IDX = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the admin can deepen the pool and read the report; there is no bulk contact route and nothing resumes one on boot',
    /app\.post\('\/api\/admin\/campus\/:universityId\/pool'/.test(IDX) && !/\/api\/admin\/campus\/:universityId\/contacts'/.test(IDX)
    && /app\.get\('\/api\/admin\/campus\/:universityId\/report'/.test(IDX) && !/resuming the contact run/.test(IDX) && !/campusContacts'\)\.run\(/.test(IDX));

  // ── 4. THE PRICE BEFORE THE RUN, AND A CAP THAT HOLDS ─────────────────────
  OUT.push('', '-- the price before the run, and a cap that holds --');
  const pe = await CP.estimate(P, UNI, { target: 1000 });
  ok('the pool estimate spends nothing and says what each ring costs', pe.ok && pe.dryRun && pe.usableNow === 140 && pe.perRing.minCalls === 31
    && pe.perRing.maxCalls === 151 && pe.perRing.maxUsd === 4.83 && pe.worstCaseUsd === Math.round(pe.ringsKm.length * 4.83 * 100) / 100, pe);
  ok('  a ring the pool already covers is never bought again', JSON.stringify(CP.ringsToRun([8000, 12000, 16000], 8000)) === '[12000,16000]'
    && JSON.stringify(CP.ringsToRun([8000, 12000], 0)) === '[8000,12000]');
  rings.length = 0;
  const capped = await CP.deepen(P, UNI, { places: fakePlaces, target: 100000, rings: [8000, 12000, 16000], budgetUsd: 5 });
  ok('  a pool cap stops before a ring that could cross it', capped.stoppedFor === 'budget' && rings.length === 1 && capped.costUsd <= 5, { rings, capped: capped.costUsd });
  const ce = await CC.estimate(P, UNI);
  ok('the contacts estimate counts only what is left to resolve, and prices it', ce.ok && ce.dryRun && ce.businesses === 5
    && ce.perBusiness.meteredUsd[0] === 0.124 && ce.perBusiness.meteredUsd[1] === 0.262
    && ce.totalUsd.metered[0] === 0.62 && ce.totalUsd.metered[1] === 1.31 && ce.perBusiness.withInputTokensUsd[1] > ce.perBusiness.meteredUsd[1], ce);
  ok('  without the history search it is cheaper', (await CC.estimate(P, UNI, { history: false })).perBusiness.meteredUsd[1] < 0.262);
  // Ten pending, each lookup metering $0.10: a $0.30 cap stops at about three.
  // Nothing on file for them, so each needs the paid lookup (a person and a
  // phone on file are finished by the free steps for nothing).
  await P.query(`UPDATE university_contacts SET status = 'pending', attempts = 0, contact_name = NULL, email = NULL, generic_email = NULL, phone = NULL,
                   instagram = NULL, website = NULL WHERE university_id = $1 AND brand IN (SELECT brand FROM university_contacts
                   WHERE university_id = $1 AND status = 'reachable' ORDER BY brand LIMIT 10)`, [UNI]);
  const scanMeter = require(REPO + 'server/scanMeter.js');
  const paid = { ...ai, getBrandContacts: async (brand, w, c, x) => { scanMeter.bumpWeb(10); return ai.getBrandContacts(brand, w, c, x); } };
  const cr = await CC.run(P, UNI, { ai: paid, concurrency: 1, budgetUsd: 0.3, history: false });
  const left = (await P.query(`SELECT COUNT(*)::int n FROM university_contacts WHERE university_id = $1 AND status = 'pending'`, [UNI])).rows[0].n;
  ok('a contacts cap stops the run there; the rest stay pending', cr.stoppedFor === 'budget' && cr.done === 3 && left === 7 && cr.costUsd >= 0.3, { cr, left });
  const runRow2 = (await P.query(`SELECT finished_at, summary FROM university_market_runs WHERE university_id = $1 AND kind = 'contacts' ORDER BY id DESC LIMIT 1`, [UNI])).rows[0];
  ok('  a capped run is finished, so boot never resumes it past the cap', runRow2.finished_at && runRow2.summary.stoppedFor === 'budget' && runRow2.summary.budgetUsd === 0.3);
  ok('the admin can read both estimates without spending, and pass dryRun and budget',
    /app\.get\('\/api\/admin\/campus\/:universityId\/estimate'/.test(IDX) && /req\.query\.dryRun === '1'/.test(IDX) && /parseFloat\(req\.query\.budget\)/.test(IDX));
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
