'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── "Hi," ON A CARD WITH THE OWNER'S NAME PRINTED ON IT ─────────────────────
//
// Flat Pennies Kitchen showed Laura Pineo. Studio Seven6 showed Monica Pettus.
// Both pitches opened "Hi,".
//
// The bar was: two sources agree, OR the business's own website names them, OR
// we hold their published address. A chamber listing naming the owner clears
// none of the three -- one source, not the site, no personal address -- and a
// chamber listing is most of the local lane. The ladder was finding these
// people and the last step was throwing the name away.
//
// The bar is now PROVENANCE: did a source we recognise publish this name against
// this business. Only a name with no source behind it -- a model guess, which is
// the original bug -- still gets "Hi,".
//
// THIS SUITE IS MOSTLY ABOUT WHAT DID NOT MOVE. Loosening a guard whose entire
// job is refusing to address a stranger by name is only safe if the specific
// wrong greetings that have already shipped stay refused.

const fs = require('fs');
const ROOT = REPO;
const GG = require(ROOT + 'server/services/greetingGuard');
const CR = require(ROOT + 'server/services/contactRank');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

// End to end: greetable -> the name the prompt is given -> the guard leaving the
// generated greeting alone. A contact is only really greetable if all three hold.
function greeting(c) {
  const okc = GG.greetableContacts([c]);
  if (!okc.length) return 'Hi,';
  const first = GG.salutationName(okc[0].name);
  const body = GG.enforceGreeting(`Hi ${first},\n\nI wanted to call your attention to Amari.`, okc);
  return body.changed ? 'Hi,' : `Hi ${first},`;
}

function main() {
  console.log('\n-- THE TWO CARDS FROM THE RUN --');
  {
    ok('FLAT PENNIES: Laura Pineo, chamber, Owner',
      greeting({ name: 'Laura Pineo', title: 'Owner', source: 'chamber' }) === 'Hi Laura,',
      greeting({ name: 'Laura Pineo', title: 'Owner', source: 'chamber' }));
    ok('STUDIO SEVEN6: Monica Pettus, facebook, Owner',
      greeting({ name: 'Monica Pettus', title: 'Owner', source: 'facebook' }) === 'Hi Monica,',
      greeting({ name: 'Monica Pettus', title: 'Owner', source: 'facebook' }));
    // Neither carries a personal address, which is exactly why they failed
    // before: the old rule wanted one, or a second source, or the site itself.
    ok('  neither needed a personal address to earn it',
      GG.greetableContacts([{ name: 'Laura Pineo', title: 'Owner', source: 'chamber' }]).length === 1);
    ok('  nor a second source agreeing',
      CR.corroborationOf({ name: 'Laura Pineo', source: 'chamber' }) === 1);
  }

  console.log('\n-- EVERY SOURCE THAT PUBLISHES WHO RUNS A BUSINESS --');
  {
    for (const s of ['site', 'chamber', 'facebook', 'registry', 'linkedin', 'maps']) {
      ok(`  ${s} greets`, greeting({ name: 'Dana Hall', title: 'Owner', source: s }) === 'Hi Dana,');
    }
    // The AI Outreach path uses a different source vocabulary. It is aliased onto
    // the same scale, and without that every contact on that path loses its name.
    ok('  company_website is aliased to site',
      greeting({ name: 'Ann Lee', title: 'Founder', source: 'company_website' }) === 'Hi Ann,');
    ok('  public_record is aliased to registry',
      greeting({ name: 'Ann Lee', title: 'Founder', source: 'public_record' }) === 'Hi Ann,');
    ok('  and a sources[] array counts, not just a single source',
      greeting({ name: 'Ann Lee', title: 'Owner', sources: ['news', 'chamber'] }) === 'Hi Ann,');
  }

  console.log('\n-- THE WRONG GREETINGS THAT ALREADY SHIPPED, STILL REFUSED --');
  {
    // fbf5865. A paid domain lookup matched an address to a person BY SURNAME and
    // the guard approved it. This is the regression two suites caught the last
    // time this rule was loosened.
    ok('HUNTER: a surname-matched address earns nothing',
      greeting({ name: 'Dana Kessler', title: 'Owner', source: 'hunter',
        email: 'd@x.com', emailKind: 'hunter' }) === 'Hi,');
    ok('  not even with the placeholder title it really carried',
      greeting({ name: 'Dana Kessler', title: 'Company contact (not confirmed owner)',
        source: 'hunter', email: 'd@x.com', emailKind: 'hunter' }) === 'Hi,');
    // THE ORDER IS LOAD-BEARING. A weak source can arrive WITH a real published
    // address, and the address must not buy a name the source cannot support.
    ok('  AND NOT EVEN WITH A PUBLISHED ADDRESS ALONGSIDE IT',
      greeting({ name: 'Dana Kessler', title: 'Owner', source: 'hunter',
        email: 'd@x.com', emailKind: 'published' }) === 'Hi,');

    // The Adweek editor named once, in an article, as a bakery's "owner".
    ok('NEWS: a story that mentions a business does not name its owner',
      greeting({ name: 'David Griner', title: 'Owner', source: 'news' }) === 'Hi,');
    ok('  nor with his real published address on file',
      greeting({ name: 'David Griner', title: 'Owner', source: 'news',
        email: 'dg@adweek.com', emailKind: 'published' }) === 'Hi,');
    ok('  and the hedge in the title refuses it independently of the source',
      greeting({ name: 'David Griner', title: 'Owner (per news report)',
        source: 'chamber' }) === 'Hi,');

    ok('INSTAGRAM: a name read out of a bio is not a job title',
      greeting({ name: 'Jo Fox', title: 'Owner', source: 'instagram' }) === 'Hi,');

    // The original bug: nothing discovered Dawn.
    ok('A MODEL GUESS WITH NO SOURCE IS STILL "Hi,"',
      greeting({ name: 'Dawn Mercer', title: 'Owner' }) === 'Hi,');
    ok('  and an explicitly inferred contact is too',
      greeting({ name: 'Dawn Mercer', title: 'Owner', source: 'ai_inference' }) === 'Hi,');
  }

  console.log('-- AND EVERY OTHER REFUSAL, UNCHANGED --');
  {
    ok('a placeholder title, however good the source',
      greeting({ name: 'X Y', title: 'Company contact (not confirmed owner)',
        source: 'site' }) === 'Hi,');
    ok('a rota rather than a job — "Manager on duty"',
      greeting({ name: 'Ronda Perkins', title: 'Manager on duty', source: 'chamber' }) === 'Hi,',
      greeting({ name: 'Ronda Perkins', title: 'Manager on duty', source: 'chamber' }));
    ok('  and hasRoleTitle refuses it on its own',
      GG.hasRoleTitle('Manager on duty') === false);
    ok('  while a real manager is untouched', GG.hasRoleTitle('General Manager') === true);
    ok('a source that could not tie them to this business',
      greeting({ name: 'X Y', title: 'Owner', source: 'chamber',
        affiliationScope: 'unclear' }) === 'Hi,');
    ok('a contact below the confidence floor',
      greeting({ name: 'X Y', title: 'Owner', source: 'chamber',
        confidence_score: 0.3 }) === 'Hi,');
    ok('no title at all', greeting({ name: 'X Y', title: '', source: 'chamber' }) === 'Hi,');
    ok('the fabricated default title',
      greeting({ name: 'X Y', title: 'Marketing / Partnerships', source: 'chamber' }) === 'Hi,');
    ok('no name at all', greeting({ title: 'Owner', source: 'site' }) === 'Hi,');
    ok('a landlord or former owner',
      greeting({ name: 'X Y', title: 'Building owner', source: 'chamber' }) === 'Hi,');
  }

  console.log('-- THE ROUTE THAT CARRIES A ROW WITH NO READABLE PROVENANCE --');
  {
    // Removing this would have been a TIGHTENING dressed as a loosening: 29
    // assertions in greetguard.js are a real role title plus a published address
    // with no source recorded, and so is every legacy row.
    ok('A PUBLISHED ADDRESS STILL EARNS A FIRST NAME',
      greeting({ name: 'Dana Kessler', title: 'Owner', email: 'd@x.com' }) === 'Hi Dana,');
    ok('  a legacy row with no emailKind counts as published, as it always did',
      GG.hasPublishedAddress({ email: 'd@x.com' }) === true);
    ok('  a guessed one does not', GG.hasPublishedAddress({ email: 'd@x.com', emailKind: 'hunter' }) === false);
    ok('  and neither does having no address at all', GG.hasPublishedAddress({}) === false);
  }

  console.log('-- THE SHAPE OF THE RULE --');
  {
    ok('news, hunter and instagram are OFF the greetable list',
      !GG.GREETABLE_SOURCES.has('news') && !GG.GREETABLE_SOURCES.has('hunter')
        && !GG.GREETABLE_SOURCES.has('instagram'), [...GG.GREETABLE_SOURCES]);
    ok('  and the three the rule names are on it',
      ['site', 'chamber', 'facebook'].every((s) => GG.GREETABLE_SOURCES.has(s)));
    ok('an unrecognised source is not "weak", it is unknown',
      GG.weakSourceOnly({ source: 'something_new' }) === false);
    ok('  so it falls through to the published-address route rather than being refused',
      greeting({ name: 'Ann Lee', title: 'Owner', source: 'something_new',
        email: 'a@x.com' }) === 'Hi Ann,');
    ok('  while a recognised-but-weak source IS a refusal on its own',
      GG.weakSourceOnly({ source: 'news' }) === true);
    ok('  and one good source among weak ones is enough',
      GG.weakSourceOnly({ sources: ['news', 'site'] }) === false);

    const gg = fs.readFileSync(ROOT + 'server/services/greetingGuard.js', 'utf8');
    const code = gg.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('the weak-source refusal is checked BEFORE the positive tests',
      code.indexOf('weakSourceOnly(c)') < code.indexOf('!greetableFromSource(c)'), null);
    ok('  and the title rules are still checked at all',
      /authorityOf\(c\.title\)\.rank >= CR\.RANK\.PLACEHOLDER/.test(code)
        && /hedgeOf\(c\.title\) !== CR\.HEDGE\.NONE/.test(code)
        && /return hasRoleTitle\(c\.title\);/.test(code), null);
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
