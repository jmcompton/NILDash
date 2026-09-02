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

// ── "Hi Ronda," NOT "Hi," ───────────────────────────────────────────────────
//
// The contact ladder finds these people. greetableContacts then required
// `c.email` -- the contact's OWN published address -- so a named owner found
// through a chamber listing, reachable on a business line and a general inbox,
// opened "Hi,". That is most of the local lane: the ladder did the work and the
// last step threw the name away.
//
// A NAME IS GREETABLE; AN ADDRESS IS HOW WE REACH THEM. Those are two questions
// and only one of them decides the greeting.
//
// This is a safety surface, so the suite is built around what must NOT change.
// The David Griner case -- an Adweek editor named once, in an article, as the
// "owner" of a bakery -- must still open "Hi,", and it is asserted by name.

const fs = require('fs');
const ROOT = REPO;
const GG = require(ROOT + 'server/services/greetingGuard');
const Q = require(ROOT + 'server/services/outreachQueue');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const greets = (c) => {
  const g = GG.greetableContacts([c]);
  return g.length ? GG.salutationName(g[0].name) : '';
};

function main() {
  // ── THE CASE THE CHANGE EXISTS FOR ────────────────────────────────────────
  const ronda = { name: 'Ronda Perkins', title: 'Owner', source: 'chamber',
    sources: ['chamber', 'website'], confidence_score: 0.9 };
  ok('A NAMED OWNER WITH NO PERSONAL EMAIL IS GREETED BY NAME',
    greets(ronda) === 'Ronda', greets(ronda));
  const daniel = { name: 'Daniel Eggers', title: 'Owner', source: 'website',
    selfAttested: true, confidence_score: 0.9 };
  ok('  and one named by their own website is too', greets(daniel) === 'Daniel', greets(daniel));
  ok('  a guessed ADDRESS does not disqualify a confirmed NAME',
    greets({ ...ronda, email: 'ronda@x.com', emailKind: 'guessed' }) === 'Ronda', null);
  ok('  nor does having no address at all',
    greets({ ...ronda, email: undefined }) === 'Ronda', null);

  // ── EVERY NAME GUARD STILL HOLDS ──────────────────────────────────────────
  ok('THE ADWEEK EDITOR STILL GETS "Hi,"',
    greets({ name: 'David Griner', title: 'Owner (per news)', source: 'news' }) === '', null);
  ok('  and so does a single third-party source with no hedge',
    greets({ name: 'David Griner', title: 'Owner', source: 'news' }) === '', null);
  ok('a placeholder title is not a person to greet',
    greets({ name: 'Ronda Perkins', title: 'Manager on duty', source: 'chamber' }) === '', null);
  ok('a contact the model invented is never greeted',
    greets({ ...ronda, source: 'ai_inference', unconfirmed: false }) === '', null);
  ok('nor one the source could not tie to this business',
    greets({ ...ronda, affiliationScope: 'unclear', unconfirmed: false }) === '', null);
  ok('nor one below the confidence floor',
    greets({ ...ronda, confidence_score: 0.3, unconfirmed: false }) === '', null);
  ok('and a row with no name at all is not a greeting',
    greets({ title: 'Owner', unconfirmed: false }) === '', null);
  // "Dr. Dawn Mercer" must not become "Hi Dr.,".
  ok('an honorific keeps its surname rather than becoming the greeting',
    GG.salutationName('Dr. Dawn Mercer') === 'Dr. Mercer', GG.salutationName('Dr. Dawn Mercer'));

  // ── ONE ANSWER, SHARED BY THE PROMPT AND THE ENFORCEMENT ──────────────────
  const ladder = { tiers: [{ tier: 1, rows: [ronda] }] };
  ok('greetNameOf reads the ladder and returns the verified name',
    Q.greetNameOf(ladder) === 'Ronda', Q.greetNameOf(ladder));
  ok('  and returns empty rather than throwing on a ladder with nobody',
    Q.greetNameOf({ tiers: [] }) === '' && Q.greetNameOf(null) === '', null);
  ok('  an unverifiable ladder yields no name',
    Q.greetNameOf({ tiers: [{ tier: 1, rows: [{ name: 'David Griner', title: 'Owner', source: 'news' }] }] }) === '',
    null);

  // ── THE FALLBACK WRITER ───────────────────────────────────────────────────
  const named = Q.writeDm('Amari Allen', 'Pack Rat Outdoor Center', 'They sponsor local teams.', 'Ronda');
  ok('THE PLAIN FALLBACK OPENS WITH THE NAME TOO', /^Hi Ronda,/.test(named), named.slice(0, 30));
  const anon = Q.writeDm('Amari Allen', 'Pack Rat Outdoor Center', 'They sponsor local teams.', '');
  ok('  and still opens "Hi," when there is nobody to name', /^Hi, /.test(anon), anon.slice(0, 30));
  ok('  never inventing one from the business', !/Pack/.test(anon.split(',')[0]), anon.slice(0, 30));

  // ── THE WRITER IS TOLD, NOT LEFT TO GUESS ─────────────────────────────────
  const pw = fs.readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
  ok('the prompt DICTATES the greeting when a name is verified',
    /OPEN THE MESSAGE WITH: "Hi ' \+ b\.greetFirstName/.test(pw), null);
  ok('  and dictates "Hi," when it is not',
    /No verified name\. Open with "Hi," exactly/.test(pw), null);
  ok('  telling the model a name it was not given is one it invented',
    /name you were not given is a name you[\s\n]+invented/.test(pw), null);
  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the job passes the VERIFIED name, not the top row blindly',
    /greetFirstName: Q\.greetNameOf\(ladder\)/.test(job), null);
  const svc = fs.readFileSync(ROOT + 'server/services/outreachQueue.js', 'utf8');
  ok('the card records who it opens to, so "Hi," is visibly a decision',
    /greetName: _greet \|\| null/.test(svc), null);

  // The guard that used to reject on the address is gone, and gone on purpose --
  // not left as a filter that looks like it is still protecting something.
  const gg = fs.readFileSync(ROOT + 'server/services/greetingGuard.js', 'utf8');
  const ggCode = gg.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('greetability no longer requires the contact\'s own address',
    !/if \(!c \|\| !c\.name \|\| !c\.email\) return false;/.test(ggCode), null);
  // A guessed address is not a guessed name -- but it is not EVIDENCE of the
  // name either. Identity is now asked positively: corroborated, self-attested,
  // or published. A Hunter-derived address is none of the three.
  ok('  and asks for positive evidence of identity instead of an address',
    /const corroborated = CRid\.corroborationOf\(c\) >= 2/.test(ggCode)
      && /if \(!corroborated && !publishedAddress\) return false;/.test(ggCode), null);
  ok('  while the corroboration rule that catches the Adweek case remains',
    /isUnconfirmed\(c\) : c\.unconfirmed\) return false;/.test(ggCode), null);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
