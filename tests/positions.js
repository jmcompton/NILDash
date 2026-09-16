'use strict';
// Needs no database.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/positions.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;

// ── "SAYS CORNERBACK BUT THE STORED POSITION IS CB" ──────────────────────────
//
// 71 of 73 writes on one agent's night needed a second Sonnet call, and 37
// were refused twice and produced nothing, almost all on that one rule. The
// roster lookup stores ESPN's abbreviation ("CB"), the athlete block handed
// the letters to the model, the model wrote the word, and the fact check knew
// five abbreviations. Now:
//   1. the check resolves abbreviations THROUGH THE ATHLETE'S SPORT, because C
//      is a center in football and basketball and a catcher in baseball, P is
//      a punter or a pitcher, F and G differ by sport, SS is a shortstop or a
//      strong safety, CB/RB/LB are football positions or soccer backs;
//   2. the athlete block hands the model the WORD, and says to use it;
//   3. a wrong position is still refused: "linebacker" for a stored "CB" is
//      not an expansion, it is a different job.

const PW = require(REPO + 'server/services/pitchWriter.js');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const k = PW.positionKey;

// ── 1. THE 48 PAIRS: what a roster stores, what the model writes ────────────
OUT.push('-- the 48 abbreviation / word pairs, by sport --');
const PAIRS = [
  ['football', 'CB', 'cornerback'], ['football', 'S', 'safety'], ['football', 'FS', 'free safety'], ['football', 'SS', 'strong safety'],
  ['football', 'DB', 'defensive back'], ['football', 'DE', 'defensive end'], ['football', 'DT', 'defensive tackle'], ['football', 'DL', 'defensive lineman'],
  ['football', 'OL', 'offensive lineman'], ['football', 'OT', 'offensive tackle'], ['football', 'OG', 'guard'], ['football', 'C', 'center'],
  ['football', 'LB', 'linebacker'], ['football', 'OLB', 'outside linebacker'], ['football', 'ILB', 'inside linebacker'], ['football', 'EDGE', 'edge rusher'],
  ['football', 'K', 'kicker'], ['football', 'P', 'punter'], ['football', 'LS', 'long snapper'], ['football', 'QB', 'quarterback'],
  ['football', 'WR', 'wide receiver'], ['football', 'RB', 'running back'], ['football', 'TE', 'tight end'], ['football', 'KR', 'returner'],
  ["men's basketball", 'PG', 'point guard'], ["men's basketball", 'SG', 'shooting guard'], ["women's basketball", 'SF', 'small forward'], ['Basketball', 'PF', 'power forward'],
  ['Basketball', 'G', 'guard'], ['Basketball', 'F', 'forward'], ['Basketball', 'C', 'center'],
  ['baseball', 'RHP', 'pitcher'], ['baseball', 'LHP', 'pitcher'], ['baseball', 'P', 'pitcher'], ['softball', '1B', 'first baseman'], ['baseball', '2B', 'second baseman'],
  ['baseball', '3B', 'third baseman'], ['baseball', 'OF', 'outfielder'], ['baseball', 'CF', 'center fielder'], ['baseball', 'IF', 'infielder'],
  ['baseball', 'DH', 'designated hitter'], ['baseball', 'C', 'catcher'], ['baseball', 'SS', 'shortstop'],
  ["women's soccer", 'GK', 'goalkeeper'], ['soccer', 'MF', 'midfielder'], ['soccer', 'CM', 'midfielder'], ['soccer', 'ST', 'striker'], ['soccer', 'FW', 'forward'],
  ['soccer', 'D', 'defender'], ['soccer', 'CB', 'center back'],
  ["women's volleyball", 'OH', 'outside hitter'], ['volleyball', 'MB', 'middle blocker'], ['volleyball', 'DS', 'defensive specialist'], ['volleyball', 'S', 'setter'],
];
let accepted = 0;
for (const [sport, stored, written] of PAIRS) {
  const same = k(stored, sport) && k(written, sport) && k(stored, sport) === k(written, sport);
  if (same) accepted++;
  ok(`  ${sport}: "${stored}" = "${written}"`, same, [k(stored, sport), k(written, sport)]);
}
ok(`ALL ${PAIRS.length} PAIRS ACCEPTED`, accepted === PAIRS.length, accepted);

// ── 2. THE COLLISIONS: one abbreviation, several sports ─────────────────────
OUT.push('', '-- the same letters mean different things by sport --');
const COLL = [
  ['C', 'football', 'center'], ['C', 'basketball', 'center'], ['C', 'baseball', 'catcher'], ['C', 'hockey', 'center'],
  ['P', 'football', 'punter'], ['P', 'baseball', 'pitcher'],
  ['F', 'basketball', 'forward'], ['F', 'soccer', 'forward'], ['F', 'hockey', 'forward'],
  ['G', 'basketball', 'guard'], ['G', 'football', 'offensive lineman'], ['G', 'soccer', 'goalkeeper'], ['G', 'hockey', 'goalkeeper'], ['G', 'lacrosse', 'goalkeeper'],
  ['SS', 'baseball', 'shortstop'], ['SS', 'football', 'safety'],
  ['CB', 'football', 'cornerback'], ['CB', 'soccer', 'defender'],
  ['RB', 'football', 'running back'], ['RB', 'soccer', 'defender'],
  ['LB', 'football', 'linebacker'], ['LB', 'soccer', 'defender'],
  ['D', 'soccer', 'defender'], ['D', 'hockey', 'defenseman'], ['D', 'lacrosse', 'defender'],
  ['S', 'football', 'safety'], ['S', 'volleyball', 'setter'],
  ['M', 'soccer', 'midfielder'], ['M', 'lacrosse', 'midfielder'],
  ['W', 'basketball', 'wing'], ['W', 'soccer', 'winger'], ['W', 'hockey', 'winger'],
  ['FB', 'football', 'fullback'], ['FB', 'soccer', 'defender'],
];
for (const [abbr, sport, expect] of COLL) ok(`  ${abbr} in ${sport} is ${expect}`, k(abbr, sport) === expect, k(abbr, sport));

// A letter that differs by sport is NOT guessed when the sport is unknown.
OUT.push('', '-- without a sport, only the unambiguous resolve --');
ok('C with no sport resolves to nothing', k('C') === null, k('C'));
ok('P with no sport resolves to nothing', k('P') === null, k('P'));
ok('G with no sport resolves to nothing', k('G') === null, k('G'));
ok('SS with no sport resolves to nothing', k('SS') === null, k('SS'));
ok('CB with no sport resolves to nothing', k('CB') === null, k('CB'));
ok('  but WR with no sport is a wide receiver everywhere', k('WR') === 'wide receiver', k('WR'));
ok('  and QB, PG, DH, GK too', k('QB') === 'quarterback' && k('PG') === 'point guard' && k('DH') === 'designated hitter' && k('GK') === 'goalkeeper');
ok('  a word needs no sport', k('cornerback') === 'cornerback' && k('catcher') === 'catcher');

// Words that shift meaning by sport.
OUT.push('', '-- words that change job by sport --');
ok('"guard" in football is a lineman, in basketball a guard', k('guard', 'football') === 'offensive lineman' && k('guard', 'basketball') === 'guard');
ok('"striker" and "forward" are one job in soccer', k('striker', 'soccer') === k('forward', 'soccer'));
ok('"fullback" in soccer is a defender, in football a back', k('fullback', 'soccer') === 'defender' && k('fullback', 'football') === 'fullback');
ok('"WR/KR" is a wide receiver first', k('WR/KR', 'football') === 'wide receiver', k('WR/KR', 'football'));
ok('"Jr WR" and "starting quarterback" still resolve', k('Jr WR', 'football') === 'wide receiver' && k('starting quarterback', 'football') === 'quarterback');
ok('an unknown value is null, so the string compare still applies', k('slotback', 'football') === null && k('ATH', 'football') === null);

// ── 3. THE ATHLETE BLOCK HANDS OVER THE WORD ─────────────────────────────────
OUT.push('', '-- the prompt says the word, and says to use it --');
const line = (a) => PW.describeAthlete(a).split('\n').find((l) => /^Plays:/.test(l)) || '';
ok('a stored "CB" on a football player reads cornerback',
  /^Plays: Junior cornerback football at Auburn/.test(line({ name: 'Pat', year: 'Junior', position: 'CB', sport: 'football', school: 'Auburn' })), line({ name: 'Pat', year: 'Junior', position: 'CB', sport: 'football', school: 'Auburn' }));
ok('  and tells the model to say that or nothing', /\(position: say "cornerback" or nothing; do not rename or abbreviate it\)/.test(line({ position: 'CB', sport: 'football' })));
ok('a stored "C" on a baseball player reads catcher', /catcher baseball/.test(line({ position: 'C', sport: 'baseball' })), line({ position: 'C', sport: 'baseball' }));
ok('  and on a basketball player reads center', /center basketball/.test(line({ position: 'C', sport: 'basketball' })));
ok('a stored word is kept as the agent typed it', /Plays: Wide Receiver football/.test(line({ position: 'Wide Receiver', sport: 'football' })), line({ position: 'Wide Receiver', sport: 'football' }));
ok('an unresolvable value is handed over verbatim', /Plays: slotback football/.test(line({ position: 'slotback', sport: 'football' })) && /say "slotback" or nothing/.test(line({ position: 'slotback', sport: 'football' })));
ok('the pro block does the same', /Plays: cornerback football for the Denver Broncos/.test(line({ athleteType: 'pro', position: 'CB', sport: 'football', team: 'Denver Broncos' })), line({ athleteType: 'pro', position: 'CB', sport: 'football', team: 'Denver Broncos' }));
ok('no position, no rule', !/position: say/.test(PW.describeAthlete({ name: 'X', sport: 'football' })));
ok('positionLabel is exported and agrees', PW.positionLabel('CB', 'football') === 'cornerback' && PW.positionLabel('C', 'baseball') === 'catcher' && PW.positionLabel('', 'football') === null);

// ── 4. THE CHECK, END TO END ─────────────────────────────────────────────────
OUT.push('', '-- the fact check: an expansion passes, a different job is refused --');
const probs = (msg, a) => PW.verifyAthleteFacts(msg, a).problems;
const cb = { name: 'Pat Surtain', position: 'CB', sport: 'football', school: 'Auburn' };
ok('"cornerback" for a stored CB passes', probs('Pat Surtain, a cornerback on the Auburn football team, posts training.', cb).length === 0, probs('Pat Surtain, a cornerback on the Auburn football team, posts training.', cb));
ok('"linebacker" for a stored CB is still refused', probs('Pat Surtain, a linebacker on the Auburn football team, posts training.', cb).some((p) => /stored position is "CB"/.test(p)));
ok('"defensive back" for a stored CB is refused: a different group, not an expansion', probs('Pat Surtain, a defensive back at Auburn, posts training.', cb).length === 1);
const c = { name: 'Sam Lee', position: 'C', sport: 'baseball', school: 'Auburn' };
ok('"catcher" for a stored C on a baseball player passes', probs('Sam Lee, a catcher for the Tigers, posts game days.', c).length === 0);
ok('  "center" for the same player is refused', probs('Sam Lee, a center for the Tigers, posts game days.', c).length === 1);
const cbb = { name: 'Sam Lee', position: 'C', sport: 'basketball', school: 'Auburn' };
ok('  and "center" for a stored C on a basketball player passes', probs('Sam Lee, a center for the Tigers, posts game days.', cbb).length === 0);
const p = { name: 'Kim Park', position: 'P', sport: 'softball', school: 'Auburn' };
ok('"pitcher" for a stored P on a softball player passes', probs('Kim Park, a pitcher for the Tigers, posts practice.', p).length === 0);
ok('  "punter" for her is refused', probs('Kim Park, a punter for the Tigers, posts practice.', p).length === 1);
const g = { name: 'Jo Ann', position: 'G', sport: "women's basketball", school: 'Auburn' };
ok('"guard" for a stored G on a basketball player passes', probs('Jo Ann, a guard for the Tigers, posts practice.', g).length === 0);
const og = { name: 'Big Mike', position: 'OG', sport: 'football', school: 'Auburn' };
ok('"guard" for a stored OG on a football player passes too', probs('Big Mike, a guard on the Auburn offensive line, posts training.', og).length === 0, probs('Big Mike, a guard on the Auburn offensive line, posts training.', og));
ok('"offensive lineman" for him passes', probs('Big Mike, an offensive lineman at Auburn, posts training.', og).length === 0);
ok('a message with no position claim is untouched', probs('Pat Surtain at Auburn posts training and game days.', cb).length === 0);
ok('a stored position we do not know still matches itself', probs('Amari Allen is a slotback at Auburn.', { name: 'Amari Allen', position: 'slotback', sport: 'football', school: 'Auburn' }).length === 0);

// ── 5. THE SOURCE OF THE PROBLEM IS NAMED ────────────────────────────────────
const src = require('fs').readFileSync(REPO + 'server/services/university/ESPNRosterService.js', 'utf8');
ok('the roster lookup still stores the abbreviation first, which is why the resolver exists', /position: a\.position\?\.abbreviation \|\| a\.position\?\.name/.test(src));

// ── 6. SPORT: THE SAME FIX AS POSITIONS ─────────────────────────────────────
OUT.push('', '-- sport abbreviations expand, and the check compares by sport --');
{
  const SP = [['MBB', 'basketball'], ['WBB', 'basketball'], ["Women's Soccer", 'soccer'], ['WSOC', 'soccer'], ['Ice Hockey', 'ice hockey'], ['hockey', 'ice hockey'],
    ['T&F', 'track and field'], ['track', 'track and field'], ['XC', 'cross country'], ['BSB', 'baseball'], ['SB', 'softball'], ['Softball', 'softball'],
    ['FB', 'football'], ['cfb', 'football'], ['mens golf', 'golf'], ['womens ice hockey', 'ice hockey'], ['D1 Softball', 'softball'], ['VB', 'volleyball'], ['LAX', 'lacrosse']];
  for (const [raw, want] of SP) ok(`${raw} -> ${want}`, PW.sportKey(raw) === want, PW.sportKey(raw));
  ok('an unknown sport is not guessed: key null, label as typed', PW.sportKey('Esports') === null && PW.sportLabel('Esports') === 'Esports');
  ok('baseball and softball are different sports', PW.sportKey('BSB') !== PW.sportKey('SB'));
  ok('"basketball" against a stored MBB passes the fact check', PW.verifyAthleteFacts('As a basketball player at Auburn, Jo brings', { name: 'Jo', sport: 'MBB', position: 'G', school: 'Auburn' }).problems.length === 0);
  ok('"hockey" against a stored "womens ice hockey" passes', PW.verifyAthleteFacts('Jo plays hockey at St. Thomas', { name: 'Jo', sport: 'womens ice hockey', school: 'St. Thomas' }).problems.length === 0);
  ok('"soccer" against a stored WSOC passes', PW.verifyAthleteFacts('Jo, a soccer player', { name: 'Jo', sport: 'WSOC' }).problems.length === 0);
  const sb = PW.verifyAthleteFacts('As a softball player, Jo', { name: 'Jo', sport: 'Baseball', position: 'P' }).problems;
  ok('"softball" against a stored Baseball is still refused', sb.length === 1 && /says "softball" but the stored sport is "Baseball"/.test(sb[0]), sb);
  const d1 = PW.describeAthlete({ name: 'Jo', sport: 'MBB', school: 'Auburn' });
  ok('the writer is handed the expanded sport and told what to say', /Plays: basketball at Auburn/.test(d1) && /sport: say "basketball" or nothing/.test(d1), d1.split('\n')[1]);
  const d2 = PW.describeAthlete({ name: 'Max', sport: 'WSOC', position: 'F', team: 'New York City FC', athleteType: 'pro' });
  ok('  a pro too', /Plays: forward soccer for the New York City FC/.test(d2) && /sport: say "soccer"/.test(d2), d2.split('\n')[2]);

  // ── 7. NO POSITION ON FILE: THE WRITER IS TOLD, NOT LEFT TO GUESS ──────────
  OUT.push('', '-- no position on file --');
  const noPos = PW.describeAthlete({ name: 'Jo', sport: 'football', school: 'Auburn' });
  ok('with no position the prompt says so', /\(no position on file: do not name, guess or imply one\)/.test(noPos), noPos.split('\n')[1]);
  ok('  and with only a school on file, still says so', /no position on file/.test(PW.describeAthlete({ name: 'Jo', school: 'Auburn' })));
  ok('an unrecognised stored position is still the only one allowed', /position: say "Xyzzy" or nothing/.test(PW.describeAthlete({ name: 'Jo', sport: 'football', position: 'Xyzzy', school: 'Auburn' })));
  ok('a recognised one is still the expanded label', /position: say "cornerback" or nothing/.test(PW.describeAthlete({ name: 'Jo', sport: 'football', position: 'CB', school: 'Auburn' })));
  const np = PW.verifyAthleteFacts('As a quarterback at Auburn, Jo', { name: 'Jo', sport: 'football', school: 'Auburn' }).problems;
  ok('the check still refuses a position we do not hold', np.length === 1 && /claims a position \("quarterback"\) and we hold none/.test(np[0]), np);
}

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
