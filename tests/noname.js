'use strict';
// No database, no network: the web search is a stub. Runs anywhere.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/noname.js           just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const fs = require('fs');

// ── A BUSINESS REACHES THE WRITER ONLY WITH A REAL PERSON'S NAME ────────────
//
// The ladder names someone most of the time. When it does not, one last
// door: "[business] [city] owner" and "[business] [city] marketing director"
// on Haiku. A person found there joins the ladder; nothing found means the
// business is skipped, logged, and counted on the run row as 'no_name'.

const ONS = require(REPO + 'server/services/ownerNameSearch.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

async function main() {
  // ── 1. THE SEARCH, AND WHAT IT REFUSES ───────────────────────────────────
  OUT.push('-- the last door --');
  const calls = [];
  const stub = (answers) => { let i = 0; return async (prompt, sys) => { calls.push({ prompt, sys }); const a = answers[i++]; if (a instanceof Error) throw a; return typeof a === 'string' ? a : JSON.stringify(a); }; };
  calls.length = 0;
  const f1 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: 'Dana Roberts', title: 'Owner', sourceUrl: 'https://maxiepizza.com/about', confidence: 'high' }]) });
  ok('the owner search names a person', f1 && f1.name === 'Dana Roberts' && f1.title === 'Owner' && f1.query === 'owner' && f1.sourceUrl === 'https://maxiepizza.com/about', f1);
  ok('  with the query as asked: "[business] [city] owner"', /Search for: Maxie Pizza Auburn, AL owner/.test(calls[0].prompt) && /only what the pages say/.test(calls[0].prompt));
  ok('  and the system prompt forbids a guess', /never a guess/.test(calls[0].sys) && /return \{"name": null\}/.test(calls[0].sys));
  ok('  one search when the first finds someone', calls.length === 1);
  calls.length = 0;
  const f2 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: null }, { name: 'Lee Park', title: 'Director of Marketing', confidence: 'medium' }]) });
  ok('the marketing search runs when the owner search finds nobody', f2 && f2.name === 'Lee Park' && f2.query === 'marketing' && calls.length === 2 && /marketing director/.test(calls[1].prompt), f2);
  calls.length = 0;
  const f3 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: null }, { name: null }]) });
  ok('nothing from either search is null, after exactly two searches', f3 === null && calls.length === 2);
  for (const [bad, why] of [['Owner', 'a role word'], ['Maxie Pizza', 'the business itself'], ['Dana', 'one word'], ['The Team', 'a role phrase'], ['Dana Roberts Smith Jones Lee', 'too many words'], ['dana@maxie.com', 'an address']]) {
    const r = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: bad, title: 'Owner' }, { name: null }]) });
    ok(`"${bad}" is refused (${why})`, r === null, r);
  }
  const f4 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: 'Sam Reed', title: 'Registered agent' }, { name: null }]) });
  ok('a placeholder title is refused', f4 === null, f4);
  const f5 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([{ name: 'Sam Reed' }]) });
  ok('a missing title becomes the role searched for', f5 && f5.title === 'Owner', f5);
  const f6 = await ONS.findOwnerName({ brand: 'Maxie Pizza', city: 'Auburn, AL', search: stub([new Error('search down'), { name: 'Lee Park', title: 'Marketing Manager' }]) });
  ok('a failed search falls through to the next', f6 && f6.name === 'Lee Park', f6);
  ok('junk text is not a name', (await ONS.findOwnerName({ brand: 'M', city: 'A', search: stub(['I could not find anyone.', '```json\n{"name": null}\n```']) })) === null);
  ok('a fenced JSON answer is read', (await ONS.findOwnerName({ brand: 'M', city: 'A', search: stub(['```json\n{"name": "Ava Chen", "title": "Founder"}\n```']) })).name === 'Ava Chen');

  // ── 2. ONTO THE LADDER, WHERE THE GREETING GUARD CAN SEE IT ──────────────
  OUT.push('', '-- the ladder --');
  const ladder = { tiers: [{ tier: 3, label: 'Business channels', rows: [{ title: 'General inbox', email: 'info@maxie.com', emailKind: 'published' }] }] };
  ok('before: nobody to greet', Q.greetNameOf(ladder) === '');
  ONS.attachToLadder(ladder, f1);
  ok('the owner lands on tier 1', ladder.tiers[0].tier === 1 && ladder.tiers[0].rows[0].name === 'Dana Roberts' && ladder.tiers[0].rows[0].source === 'owner-search');
  ok('  and the greeting guard will open with them', Q.greetNameOf(ladder) === 'Dana', Q.greetNameOf(ladder));
  ok('  the row says where the name came from', /Named by a web search for "owner" at https:\/\/maxiepizza\.com\/about/.test(ladder.tiers[0].rows[0].sourceNote));
  const l2 = { tiers: [] };
  ONS.attachToLadder(l2, { name: 'Lee Park', title: 'Marketing Manager', query: 'marketing', confidence: 'low' });
  ok('a manager lands on tier 2, marked Likely', l2.tiers[0].tier === 2 && l2.tiers[0].rows[0].confidence === 'Likely');
  ok('  and is still greetable', Q.greetNameOf(l2) === 'Lee');
  ok('the card built from it carries the name', Q.buildCard({ brand: 'Maxie Pizza' }, ladder, { instagram: null }).contactName === 'Dana Roberts');

  // ── 3. THE JOB ───────────────────────────────────────────────────────────
  OUT.push('', '-- the job --');
  const job = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  const site = job.slice(job.indexOf("if (!bar.ok) {"), job.indexOf('// ── THE WRITER ──'));
  ok('the name check sits after the bar and before the writer', /if \(NAME_REQUIRED && !Q\.greetNameOf\(ladder\)\)/.test(site) && site.indexOf('greetNameOf') < site.indexOf("result: 'queued'"));
  ok('  the last door runs under the contacts.finalname label with the metered search', /site: 'contacts\.finalname'/.test(site) && /search: ai\.webSearchJson/.test(site));
  ok('  a person found joins the ladder and is recorded on the attempt', /ONS\.attachToLadder\(ladder, found\)/.test(site) && /_why\.finalName = \{ name: found\.name/.test(site));
  ok('  nothing found: the business is skipped, logged, and counted as no_name', /result: 'no_name', reason/.test(site) && /skipped, no name found/.test(site) && /continue;\s*\}\s*\}\s*tried\.push\(\{ brand: cand\.brand_name, result: 'queued'/.test(site));
  ok('  the reason is one sentence, fixed', ONS.NO_NAME_REASON === 'no contact name found after all sources, including the final owner and marketing-director search');
  ok('on by default, OUTREACH_NAME_REQUIRED=0 turns it off', /const NAME_REQUIRED = process\.env\.OUTREACH_NAME_REQUIRED !== '0';/.test(job));
  const sb = fs.readFileSync(REPO + 'scripts/spend-breakdown.js', 'utf8');
  ok('spend-breakdown reports the skip rate and the rescues', /no name found: \$\{noName\.length\} of \$\{localTried\.length\} local businesses skipped/.test(sb) && /rescued  \$\{t\.brand\}: \$\{t\.why\.finalName\.name\}/.test(sb));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
