'use strict';
// Runs from a checkout on any machine. Pure over the budget and the writer's
// sport repair: no database, no network, no key.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/rosterstarve.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const fs = require('fs');

// ── 113 CARDS ON ONE NIGHT, 2 ON THE NEXT ──────────────────────────────────
//
// A 30-athlete agent, the night the discovery pot shipped: 28 of his 30
// athletes reported "0 tried". The lookup cap had had a per-athlete share
// since the ordering bug was fixed; the discovery pot shipped WITHOUT one, as
// a flat $2 spent first-come. Two athletes' cold-market scans drained it and
// the rest were told "the discovery pot is spent" before they were attempted.
//
// And the writer: 12 of 13 writes needed a second call and 11 were refused
// twice, almost all "says X but the stored sport is Y" -- every one of those
// a card that was never written because of one wrong word.

const Q = require(REPO + 'server/services/outreachQueue.js');
const W = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

(async () => {
  // ── THE POT IS SIZED BY THE ROSTER ────────────────────────────────────
  OUT.push('-- the discovery pot --');
  const small = Q.newBudget(8, undefined, { rosterSize: 3 });
  const big = Q.newBudget(8, undefined, { rosterSize: 30 });
  ok('a small roster keeps the flat floor', small.discoveryCap() === Q.DISCOVERY_CAP_USD, small.discoveryCap());
  ok('A 30-ATHLETE ROSTER IS NOT HANDED A 3-ATHLETE BUDGET', big.discoveryCap() > small.discoveryCap()
    && Math.abs(big.discoveryCap() - 30 * Q.DISCOVERY_PER_ATHLETE_USD) < 1e-9, big.discoveryCap());
  ok('  every athlete is guaranteed a scan\'s worth', Q.DISCOVERY_PER_ATHLETE_USD > 0 && big.discoveryCap() / 30 >= Q.DISCOVERY_PER_ATHLETE_USD - 1e-9);

  // ── AND IT IS SHARED, SO THE FIRST ATHLETE CANNOT EAT IT ──────────────
  OUT.push('', '-- the share --');
  const b = Q.newBudget(8, undefined, { rosterSize: 30 });
  const pot = b.discoveryCap();
  b.openFor(30);
  ok('the first athlete may not spend the whole pot', b.canSpendDiscovery(pot) === false, { pot, share: b.discoveryShareLeft() });
  ok('  but may spend their share of it', b.canSpendDiscovery(pot / 30) === true);
  b.spendDiscovery(pot / 30);
  ok('  and once their share is gone, they stop', b.canSpendDiscovery(pot / 30) === false, b.discoveryShareLeft());
  ok('  while the pot itself is barely touched', b.discoverySpent() < pot / 10, { spent: b.discoverySpent(), pot });

  // EVERY athlete gets a turn: walk the whole roster the way the job does.
  const walk = Q.newBudget(8, undefined, { rosterSize: 30 });
  let served = 0;
  for (let i = 0; i < 30; i++) {
    walk.openFor(30 - i);
    const want = walk.discoveryCap() / 30;
    if (walk.canSpendDiscovery(want)) { walk.spendDiscovery(want); served++; }
  }
  ok('EVERY ATHLETE ON A 30-ATHLETE ROSTER IS ATTEMPTED', served === 30, served);
  ok('  and the night stays inside its pot', walk.discoverySpent() <= walk.discoveryCap() + 1e-9, { spent: walk.discoverySpent(), cap: walk.discoveryCap() });

  // A cheap first half funds the second: the share is not a reservation.
  const carry = Q.newBudget(8, undefined, { rosterSize: 10 });
  carry.openFor(10);
  carry.spendDiscovery(0.01);
  carry.openFor(1);
  ok('an athlete who scans cheaply leaves the rest in the pot for the others',
    carry.discoveryShareLeft() > carry.discoveryCap() / 2, { left: carry.discoveryShareLeft(), cap: carry.discoveryCap() });
  ok('  and the pot is still the hard stop', carry.canSpendDiscoveryFromPot(carry.discoveryCap() * 2) === false);

  const job = src('server/jobs/outreachQueue.js');
  ok('the job sizes the pot from the roster it is about to work', /Q\.newBudget\(CAP_USD, undefined, \{ rosterSize: athletes\.length \}\)/.test(job));
  ok('  and says so in the log, so a starved roster is visible the next morning', /roster=\$\{athletes\.length\} discovery pot/.test(job));
  ok('  the per-athlete share is opened for discovery as well as for lookups', /discoveryShare = Math\.max\(0, discoveryCap - discoveryUsed\) \/ n/.test(src('server/services/outreachQueue.js')));

  // ── THE WRITER: THE RECORD'S SPORT WINS ───────────────────────────────
  OUT.push('', '-- the sport on the record is the sport in the pitch --');
  const ath = { name: 'Amari Cole', sport: 'Baseball', school: 'Auburn University', athleteType: 'college' };
  const draft = 'Hi Dana,\n\nAmari Cole is a basketball player at Auburn University and posts every week. Basketball season starts soon.\n\nJohn';
  const fixed = W.alignSport(draft, ath);
  ok('a draft that names the wrong sport is repaired to the stored value', fixed.changed === true && /baseball player/.test(fixed.text) && !/basketball/i.test(fixed.text), fixed.text);
  ok('  the draft\'s own casing is kept, so it reads like a sentence', /a baseball player/.test(fixed.text) && /Baseball season/.test(fixed.text), fixed.text);
  ok('  and it says which word it replaced', fixed.from === 'basketball', fixed.from);
  ok('a draft that already names the stored sport is left alone',
    W.alignSport('Hi Dana,\n\nAmari Cole is a baseball player at Auburn.\n\nJohn', ath).changed === false);
  ok('IT ONLY EVER REWRITES TOWARD THE RECORD: with no sport on file it changes nothing',
    W.alignSport(draft, { name: 'Amari Cole', school: 'Auburn University' }).changed === false);
  ok('  so an athlete with no sport still cannot have one invented for them',
    W.alignSport(draft, { name: 'Amari Cole', sport: '' }).text === draft);
  ok('a stored abbreviation is expanded, not echoed', /basketball/i.test(W.alignSport('Hi,\n\nAmari Cole is a football player here.\n\nJohn', { name: 'Amari Cole', sport: 'MBB' }).text));

  const pw = src('server/services/pitchWriter.js');
  ok('the writer repairs the sport BEFORE spending a second model call', pw.indexOf('THE CHEAP FIX FIRST') < pw.indexOf('ONE retry, told exactly what was wrong'));
  ok('  and again if the second draft gets it wrong, rather than losing the card', (pw.match(/alignSport\(/g) || []).length >= 3);
  ok('  the rule the model is given names the record and forbids any other sport', /this record says "\$\{label\}"\. Say "\$\{label\}" or name no sport at all/.test(pw) && /even if the position or the stats suggest one/.test(pw));
  ok('  a repair is reported on the result, so how often it fires is a count', /sportRepaired/.test(pw) && /sport repaired for/.test(pw));
  ok('THE MODEL IS UNCHANGED: still the writer\'s own model at both sites',
    /ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN(?:, \{ prose: true \})?\)/.test(src('server/jobs/outreachQueue.js')) && !/claude-opus|claude-fable/.test(pw));

  // ── THE REPORT THAT ANSWERS "WHY 0 TRIED" ─────────────────────────────
  OUT.push('', '-- the report --');
  const rep = src('scripts/nightly-run-report.js');
  ok('the run report prints athletes tried, cards written and why each untried athlete was skipped',
    /athletes tried \$\{tried\} of \$\{roster\.length\}/.test(rep) && /cards written \$\{cards\}/.test(rep) && /athlete\(s\) got no card/.test(rep));
  ok('  grouped by reason, because twenty-eight identical lines is not a report', /grouped by reason/i.test(rep) && /byWhy/.test(rep));
  ok('  and it never invents a reason it was not given', /nothing recorded for this athlete/.test(rep) && /not in the run at all/.test(rep));
  ok('it is admin-only, through the script runner', /'nightly-run-report': \{ file: 'scripts\/nightly-run-report\.js'/.test(src('server/index.js')));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('rosterstarve: FAILED', e); process.exit(1); });
