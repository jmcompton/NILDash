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

// ── AN AGE THE AGENT CAN ANSWER ─────────────────────────────────────────────
//
// The compliance gate needs to know whether an athlete is a minor. It did not
// need a BIRTHDAY to know that, but it demanded one -- so every new athlete was
// held on every restricted category until somebody went and found a date, which
// on a 45-client roster is a wall between signing a client and working for them.
//
// This is a compliance surface, so the suite is written around what must NOT
// change: a real date of birth still wins, an unanswered athlete is still
// unknown rather than assumed adult, and the hard categories still reach a human.

const fs = require('fs');
const ROOT = REPO;
const C = require(ROOT + 'server/services/compliance');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const NOW = new Date('2026-09-02T00:00:00Z');

function main() {
  // ── THE DATE STILL WINS ───────────────────────────────────────────────────
  // The attestation is the agent's word; a date is checkable. Where both exist
  // the date decides, in BOTH directions -- including against the attestation.
  const kid = C.ageFrom('2010-05-01', NOW, { over18: true });
  ok('A REAL DATE OF BIRTH OVERRIDES THE CHECKBOX',
    kid.known === true && kid.minor === true && kid.years === 16, kid);
  ok('  and says the answer came from a date', kid.source === 'dob', kid);
  const adult = C.ageFrom('2004-05-01', NOW, { over18: false });
  ok('  in both directions', C.ageFrom('2004-05-01', NOW, { over18: false }).minor === false, adult);

  // ── THE ATTESTATION FILLS THE GAP ─────────────────────────────────────────
  const att = C.ageFrom('', NOW, { over18: true });
  ok('WITH NO DATE, A TICKED BOX IS AN ADULT',
    att.known === true && att.minor === false, att);
  ok('  labelled as attested, never as a verified age',
    att.source === 'attested' && att.years === null, att);
  const minor = C.ageFrom('', NOW, { over18: false });
  ok('an unticked box is a KNOWN MINOR, which is stronger than silence',
    minor.known === true && minor.minor === true, minor);

  // ── SILENCE IS STILL SILENCE ──────────────────────────────────────────────
  // Every athlete on every existing roster is this case. If it ever resolved to
  // adult, the whole gate would have quietly opened on the deploy that shipped
  // the checkbox.
  for (const v of [undefined, null]) {
    const u = C.ageFrom('', NOW, { over18: v });
    ok('an unanswered athlete is UNKNOWN, never an adult (' + String(v) + ')',
      u.known === false && u.minor === null && u.reason === 'absent', u);
  }
  ok('and an unreadable athlete record is still its own fault, not an age',
    C.ageFrom('', NOW, { over18: true, sourceUnreadable: true }).reason === 'unreadable',
    C.ageFrom('', NOW, { over18: true, sourceUnreadable: true }));
  ok('a junk date is still unreadable, not silently replaced by the checkbox',
    C.ageFrom('banana', NOW, { over18: true }).reason === 'unreadable',
    C.ageFrom('banana', NOW, { over18: true }));

  // ── THE HARD CATEGORIES STILL REACH A HUMAN ───────────────────────────────
  // This is the claim that makes the change safe: the attestation moves a
  // restricted category from BLOCK to HOLD, never to a send. If any adult
  // severity were 'pass', ticking a box would put an athlete's name on an
  // alcohol pitch with nobody looking.
  for (const c of C.CATEGORIES) {
    ok('  "' + c.key + '" never passes on age alone',
      c.adult === 'hold' || c.adult === 'block', { key: c.key, adult: c.adult });
  }
  const attAge = C.ageFrom('', NOW, { over18: true });
  ok('an attested adult still only HOLDS alcohol, never sends it',
    C.severityFor('alcohol', attAge) === 'hold', C.severityFor('alcohol', attAge));
  ok('  and gambling is still blocked outright at any age',
    C.severityFor('gambling', attAge) === 'block');
  ok('an attested MINOR is blocked on alcohol, not merely held',
    C.severityFor('alcohol', C.ageFrom('', NOW, { over18: false })) === 'block');

  // ── THE WIRING ────────────────────────────────────────────────────────────
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('the create path validates and stores the answer', /over18: _validOver18\(over18\)/.test(idx), null);
  ok('  reading it off the request body', /transferReason, gpa, over18,/.test(idx), null);
  ok('  AND AN UNANSWERED PATCH NEVER OVERWRITES AN ANSWER ON FILE',
    /if \(o === undefined\) delete patch\.over18;/.test(idx), null);
  const closer = fs.readFileSync(ROOT + 'server/services/closer.js', 'utf8');
  ok('the gate is handed the answer at send time', /over18: log\.over18 === true/.test(closer), null);
  ok('  loaded from the athlete row', /a\.data->>'over18' AS over18/.test(closer), null);
  const comp = fs.readFileSync(ROOT + 'server/services/compliance.js', 'utf8');
  ok('  and the compliance log records WHICH evidence decided it',
    /age: ageFrom\(ctx\.dob, ctx\.now, \{ over18: ctx\.over18 \}\)/.test(comp), null);

  // ── THE FORM ──────────────────────────────────────────────────────────────
  const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  ok('THE CHECKBOX EXISTS ON ADD CLIENT', /id="a_over18"/.test(html), null);
  ok('  defaulted from class year', /function acOver18Default/.test(html)
    && /onchange="acYearChanged\(\)"/.test(html), null);
  ok('  and sent on both the create and the update path',
    (html.match(/over18: document\.getElementById\('a_over18'\)/g) || []).length === 2, null);
  ok('THE SCHOOL-RESTRICTIONS SECTION IS GONE FROM THE FORM',
    !/a_school_restrictions/.test(html) && !/Categories this school restricts/.test(html), null);
  ok('  but the server still reads anything already stored, rather than wiping it',
    /schoolRestrictions: _validRestrictions\(schoolRestrictions\)/.test(idx), null);
  ok('  and the date of birth survives as an optional field',
    /id="a_dob"/.test(html), null);

  // The default rule itself, which decides a click on most of a roster.
  const dflt = (y) => {
    const m = html.match(/function acOver18Default\(year\) \{[\s\S]*?\n\}/);
    // eslint-disable-next-line no-new-func
    return new Function(m[0] + '\nreturn acOver18Default(' + JSON.stringify(y) + ');')();
  };
  ok('sophomore and above default to 18+',
    dflt('Sophomore') && dflt('Junior') && dflt('Senior') && dflt('Grad Transfer'));
  ok('  a FRESHMAN does not, because that one is a coin toss', dflt('Freshman') === false);
  ok('  and an unknown year does not either', dflt('') === false && dflt(null) === false);

  // ── BUG: THE FORM KEPT THE LAST ATHLETE'S NUMBERS ─────────────────────────
  // showView only ever showed the pane; editAthlete filled every field and
  // nothing cleared them, so opening Add Client after an edit offered the
  // previous athlete's engagement rate as the new one's default.
  ok('OPENING ADD CLIENT CLEARS THE FORM FIRST',
    /onclick="resetAthleteForm\(\);showView\('add-athlete'/.test(html), null);
  const reset = (html.match(/function resetAthleteForm\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('  clearing the engagement rate', /a_eng/.test(reset), null);
  ok('  the followers and the handle with it',
    /a_ig/.test(reset) && /a_handle/.test(reset), null);
  ok('  the selects too, not only the text inputs', /selectedIndex = 0/.test(reset), null);
  ok('  AND THE PROVENANCE LABELS, which otherwise caption an empty box',
    /a-eng-src/.test(reset) && /_statFetchedSource = null/.test(reset), null);
  ok('  putting the button back into create mode',
    /addAthlete\(\)/.test(reset) && /_editingAthleteId = null/.test(reset), null);

  // ── BUG: STATS CAME BACK A SEASON SHORT ───────────────────────────────────
  // The example format in the prompt was hardcoded "2023 | 2024 | 2025", so the
  // model anchored on it and the athlete's current season -- the only one a
  // brand cares about -- was missing from every lookup.
  ok('THE STATS PROMPT NO LONGER HARDCODES THE SEASON YEARS',
    !/"2023: \[stats\] \| 2024: \[stats\] \| 2025: \[stats if available\]"/.test(idx)
      && !/2023: X \| 2024: X \| 2025: X/.test(idx), null);
  ok('  it computes the current season instead', /const _seasonYear = _now\.getMonth/.test(idx), null);
  ok('  names it in the prompt as the one that matters',
    /THE CURRENT SEASON IS \$\{_seasonYear\}/.test(idx), null);
  ok('  and demands an honest gap rather than a stale season presented as current',
    /no \$\{_seasonYear\} data available/.test(idx), null);
  // A season is named for the year it starts, so spring is still last year's.
  const seasonOf = (iso) => {
    const d = new Date(iso);
    return d.getMonth() + 1 >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  };
  ok('September 2026 is the 2026 season', seasonOf('2026-09-02') === 2026);
  ok('  March 2026 is still the 2025 season, mid-year', seasonOf('2026-03-02') === 2025);
  ok('  and July rolls to the new one only in August',
    seasonOf('2026-07-31') === 2025 && seasonOf('2026-08-01') === 2026);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
