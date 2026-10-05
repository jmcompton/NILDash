'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/signingevidence.js  just this one
//
// ── A NATIONAL OR SOCIAL BRAND ONLY IF IT SIGNS ATHLETES LIKE THIS ONE ────
// Nike came up 10 times in one night. The definition of done, as a test:
//   household incumbents are refused, evidence or not
//   no sourced evidence of a comparable signing in 12 months: no card
//   evidence that is too old, unsourced, or with a star does not count
//   a program to apply to ranks first, then DTC / growth, then the same sport
//   every card records its size band and its evidence; reply rate reads by band
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const SE = require(REPO + 'server/services/signingEvidence.js');
const Scout = require(REPO + 'server/services/scout.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const B = (x) => 'SE Test ' + x;     // every brand this test writes
const ATH = { id: 'se-ath', sport: 'softball', instagram: 4000, tiktok: 1000 };   // reach 5,000

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM deal_comps WHERE brand LIKE 'SE Test %' OR brand = 'Nike'`);
    await P.query(`DELETE FROM social_brands WHERE brand LIKE 'SE Test %' OR brand = 'Nike'`);
  };
  await clean();
  const deal = (brand, followers, sport, { source = 'https://news.example/deal', months = 2, draft = null, name = 'Jo Player' } = {}) =>
    P.query(`INSERT INTO deal_comps (brand, followers, sport, source, draft_status, athlete_name, created_at)
             VALUES ($1,$2,$3,$4,$5,$6, NOW() - ($7 || ' months')::interval)`, [brand, followers, sport, source, draft, name, String(months)]);
  // NIKE: lots of logged deals, several with athletes of this very size.
  for (let i = 0; i < 25; i++) await deal('Nike', i < 5 ? 5000 : 2000000, 'softball', { name: 'Nike Athlete ' + i });
  await deal(B('Comparable Softball'), 6000, 'softball', { name: 'Ava Reyes' });                 // a real lead
  await deal(B('Comparable Hoops'), 3000, 'basketball', { name: 'Mia Cole' });                   // comparable, other sport
  await deal(B('Unsourced'), 5000, 'softball', { source: null });                                  // no source
  await deal(B('Stale'), 5000, 'softball', { months: 20 });                                        // too old
  await deal(B('Stars Only'), 2500000, 'softball', { name: 'A Star' });                            // not comparable
  await deal(B('Draft Pick'), 5000, 'softball', { draft: '1st round' });                           // not comparable
  const prog = (brand, min, max, { stated = true, months = 3, size = 'small', sports = ['softball'] } = {}) =>
    P.query(`INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, tier_stated, brand_size, active, offer_summary)
             VALUES ($1,'apparel','https://x.example',$2,$3,$4,'cash_code',$5,(NOW() - ($6 || ' months')::interval)::date,$7,$8,true,'Free gear and a code')`,
      [brand, sports, min, max, 'https://' + brand.toLowerCase().replace(/\s+/g, '') + '.example/ambassadors', String(months), stated, size]);
  await prog(B('DTC Program'), 1000, 20000);                          // a program that takes her: the best find
  await prog(B('Big Range Unstated'), 0, 10000000, { stated: false }); // no stated range: not evidence
  await prog(B('Old Program'), 1000, 20000, { months: 18 });          // verified too long ago
  await prog(B('Too Small For Them'), 50000, 500000);                 // a range she is not in

  // ── 1. THE BAR ───────────────────────────────────────────────────────────
  OUT.push('-- the bar --');
  ok('NIKE IS REFUSED as a household incumbent, though it has deals with athletes her size', SE.incumbent('Nike') === 'nike' && SE.incumbent('Nike Store Tempe') === 'nike');
  ok('  so are Adidas, Under Armour, Gatorade, Powerade', ['Adidas', 'Under Armour', 'Gatorade', 'Powerade'].every((b) => SE.incumbent(b)));
  ok('  but not a brand that merely contains one ("Applebee\'s", "Nikes Bikes" are not Apple / Nike)', !SE.incumbent("Applebee's") && SE.incumbent('Nikes Bikes') !== 'apple');
  const ev = async (x) => SE.forBrand(P, x, ATH);
  const cs = await ev(B('Comparable Softball'));
  ok('a sourced deal with an athlete of comparable reach in the last 12 months is evidence', cs.ok && cs.evidence[0].kind === 'deal' && cs.evidence[0].athlete === 'Ava Reyes' && cs.sameSport, cs);
  ok('  no source: not evidence', !(await ev(B('Unsourced'))).ok);
  ok('  20 months old: not evidence', !(await ev(B('Stale'))).ok);
  ok('  only a 2.5M-follower star: not comparable', !(await ev(B('Stars Only'))).ok);
  ok('  a draft pick: not comparable', !(await ev(B('Draft Pick'))).ok);
  const dp = await ev(B('DTC Program'));
  ok('a program verified in the last 12 months whose stated range takes her is evidence', dp.ok && dp.program && dp.evidence[0].kind === 'program' && /ambassadors/.test(dp.evidence[0].source), dp);
  ok('  an unstated range is not', !(await ev(B('Big Range Unstated'))).ok);
  ok('  an 18-month-old verification is not', !(await ev(B('Old Program'))).ok);
  ok('  a range she is not in is not', !(await ev(B('Too Small For Them'))).ok);

  // ── 2. THE RANKING ───────────────────────────────────────────────────────
  OUT.push('', '-- once the bar is met --');
  const cands = ['Nike', B('Comparable Hoops'), B('Comparable Softball'), B('DTC Program'), B('Unsourced'), B('Stars Only')].map((b) => ({ brand_name: b, lane: 'national' }));
  const { kept, refused } = await SE.filterAndRank(P, cands, ATH, { bar: true });
  ok('kept: only the three with evidence', kept.map((c) => c.brand_name).sort().join('|') === [B('Comparable Hoops'), B('Comparable Softball'), B('DTC Program')].sort().join('|'), kept.map((c) => c.brand_name));
  ok('  ranked: the program first, then the same sport, then the other sport', kept.map((c) => c.brand_name).join('|') === [B('DTC Program'), B('Comparable Softball'), B('Comparable Hoops')].join('|'), kept.map((c) => [c.brand_name, c.evidenceScore]));
  ok('  each carries its band, its evidence and a sentence the agent can read', kept.every((c) => c.sizeBand && Array.isArray(c.signingEvidence) && c.signingEvidence.length && /https?:\/\//.test(c.evidenceNote)), kept.map((c) => c.evidenceNote));
  ok('refused, each with why: Nike as an incumbent, the rest for no comparable evidence', /incumbent/.test((refused.find((r) => r.brand === 'Nike') || {}).why || '')
    && /no evidence/.test((refused.find((r) => r.brand === B('Unsourced')) || {}).why || '') && refused.length === 3, refused);
  ok('size bands: 20+ deals is national, a small brand with a program is growth', SE.bandOf({ brand: 'X', deals: 25 }) === 'national' && SE.bandOf({ brand: 'X', size: 'small', program: true }) === 'growth' && SE.bandOf({ brand: 'Nike' }) === 'incumbent');

  // ── 2b. THE FLAG: DEFAULT OFF ────────────────────────────────────────────
  OUT.push('', '-- the flag (default off) --');
  delete process.env.SIGNING_EVIDENCE_BAR;
  await P.query(`DELETE FROM feature_flags WHERE key = 'signing_evidence_bar'`).catch(() => {});
  SE._resetFlagCache();
  ok('the bar is OFF by default', (await SE.barOn(P)) === false);
  const off = await SE.filterAndRank(P, cands, ATH);
  ok('  OFF: Nike is still refused (the incumbent list always applies)', off.refused.length === 1 && off.refused[0].brand === 'Nike' && /incumbent/.test(off.refused[0].why), off.refused);
  ok('  OFF: every other brand is kept, in its original order', off.kept.map((c) => c.brand_name).join('|') === cands.filter((c) => c.brand_name !== 'Nike').map((c) => c.brand_name).join('|'), off.kept.map((c) => c.brand_name));
  ok('  OFF: band and evidence still recorded where found, nothing invented where not', off.kept.every((c) => c.sizeBand) && !!off.kept.find((c) => c.brand_name === B('DTC Program')).signingEvidence && off.kept.find((c) => c.brand_name === B('Unsourced')).signingEvidence === null && off.kept.every((c) => c.evidenceScore === 0));
  await SE.setBar(P, true); SE._resetFlagCache();
  ok('turned on in the table (no deploy): the bar applies', (await SE.barOn(P)) === true && (await SE.filterAndRank(P, cands, ATH)).refused.length === 3);
  process.env.SIGNING_EVIDENCE_BAR = '0';
  ok('  the environment overrides the table', (await SE.barOn(P)) === false);
  delete process.env.SIGNING_EVIDENCE_BAR;
  await SE.setBar(P, false);

  // ── 3. IN THE SLATE ──────────────────────────────────────────────────────
  OUT.push('', '-- the slate --');
  const src = fs.readFileSync(REPO + 'server/services/scout.js', 'utf8');
  ok('the slate runs both lanes through it, social exactly as national', /const sF = await SE\.filterAndRank\(pool, social, athlete\);/.test(src) && /const nF = await SE\.filterAndRank\(pool, national, athlete\);/.test(src));
  ok('  and the evidence score counts in the fit ranking', /fit \+= c\.evidenceScore/.test(src));
  const job = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('a national brand: a founder / CEO / corporate office is never the contact; social too once the bar is on', /large: cand\.lane === 'national' \|\| cand\.brandSize === 'national' \|\| \(cand\.lane === 'social' && !!ctx\._evidenceBar\)/.test(job));
  ok('EVERY CARD records its size band and its evidence', /size_band, signing_evidence\)/.test(job) && /card\.sizeBand \|\| \(card\.lane === 'local' \? 'local' : null\)/.test(job));
  const ONS = require(REPO + 'server/services/ownerNameSearch.js');
  ok('  a national brand\'s founder or CEO is refused; its partnerships lead is not', !!ONS.titleProblem('Founder & CEO', { large: true }) && !ONS.titleProblem('Head of Athlete Partnerships', { large: true }));

  // ── 4. MEASURED ──────────────────────────────────────────────────────────
  OUT.push('', '-- measured --');
  const { spawnSync } = require('child_process');
  const rep = spawnSync(process.execPath, [REPO + 'scripts/lane-band-report.js', '--days', '30'], { env: { ...process.env, INIT_WAIT_MS: '3000' }, encoding: 'utf8', timeout: 120000 });
  ok('the reply-rate report runs and reads by lane and band', rep.status === 0 && /REPLY RATE BY LANE AND SIZE BAND/.test(rep.stdout) && /reply rate/.test(rep.stdout), (rep.stdout || '') + (rep.stderr || ''));

  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
