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
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// A PERSON MUST BE TIED TO THIS LOCATION, NOT TO THE PARENT.
//
//   Hog Heaven Team Store  -> Follett's CEO
//   Rally House Fayetteville -> Rally House corporate
//
// Phones were locality-checked. People were not checked at all: every name any
// source returned was merged, ranked by title and served. A parent's CEO ranks 0,
// so it went straight to Tier 1 -- and satisfied the fan-out's early exit, which
// stopped the search on the wrong person.
//
// THE JUDGEMENT CALL, decided by the product owner and asserted here because it is
// the thing most likely to be broken by a later "tighten it up": chamber is the
// highest-yield source (24 people across 14 of 20 businesses) and almost none of
// those listings state a street address. Failing closed on 'unclear' would delete
// the source that works to fix a problem that only occurs on chains. So:
//
//   parent-or-brand -> REJECTED, surfaced in notAffiliated, never a contact
//   unclear         -> KEPT, demoted out of Tier 1, never rejected
//   this-location   -> unchanged
//
// The SHIPPED _searchContactSource and _fetchBrandContacts are lifted and run.
const fs = require('fs');
const R = REPO;
let f = 0;
const ok = (n, c, got) => {
  if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); }
  else console.log('  PASS ' + n);
};
const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');

function liftFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN: ' + sig);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) { i++; break; } }
  }
  let j = src.indexOf('{', i), d = 0, end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return src.slice(start, end + 1);
}
const lift = (sig, names, vals) => new Function(...names, liftFn(AI, sig) + '\n return ' + sig.replace(/^(async )?function /, '').split('(')[0] + ';')(...vals);

const _cleanStr = (v) => (v == null ? null : String(v).trim() || null);
const _safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u.trim() : null);
const _normalizePhone = (p) => (p == null ? null : String(p));
const _validEmail = (e) => (typeof e === 'string' && e.includes('@') ? e : null);
const _isGenericInbox = (e) => /^(info|contact|hello|sales|admin|office)@/i.test(String(e || ''));
const rankOf = new Function(liftFn(AI, 'function _contactAuthorityRank(title) {') + '\n return _contactAuthorityRank;')();
const labelTitle = new Function(liftFn(AI, 'function _labelTitle(source, title) {') + '\n return _labelTitle;')(); // eslint-disable-line

// ── the shipped per-source extractor, with the model's answer injected ───────
function searchSource(payloadObj, { source = 'site', brand = 'Biz', loc = 'Birmingham, AL', domain = null } = {}) {
  const fn = lift('async function _searchContactSource(',
    ['_sourceLead', '_CONTACT_JSON_TAIL', '_contactSearchImpl', '_contactWebSearchRaw', '_parseContactsPayload',
     '_extractContactsFromProse', '_cleanStr', '_labelTitle', '_safeUrl', 'resolveEmail', '_isGenericInbox',
     '_validEmail', '_normalizePhone', '_extractCitationUrls', 'console', '_scopeOf'],
    [(s, b, l, d) => `lead:${s}:${d || 'nodomain'}`, TAIL, null,
     async () => ({ text: JSON.stringify(payloadObj), citations: [], searches: 1, outTokens: 10, apiMs: 5 }),
     parsePayload, () => [], _cleanStr, (s, t) => t, _safeUrl,
     async (n, d, pub) => ({ email: _validEmail(pub), emailSource: pub ? 'published' : null }),
     _isGenericInbox, _validEmail, _normalizePhone, () => [], { log() {}, warn() {} },
     SCOPE_FN]);
  return fn(source, brand, loc, domain, 'AL');
}
const TAIL = (AI.match(/const _CONTACT_JSON_TAIL = `([\s\S]*?)`;/) || [])[1] || '';
const parsePayload = new Function(liftFn(AI, 'function _parseContactsPayload(text) {') + '\n return _parseContactsPayload;')();
// _scopeOf is the deterministic backstop this change introduces. Absent until built.
// It leans on module-level constants (_CORPORATE_TITLE, _nameTokens,
// _hasLocationQualifier), so the whole block is lifted, not just the function --
// lifting the function alone threw ReferenceError, which is a harness gap and not
// a product defect.
const SCOPE_FN = (() => {
  if (!/function _scopeOf\(/.test(AI)) return null;
  const from = AI.indexOf('const _CORPORATE_TITLE');
  if (from === -1) throw new Error('FIXTURE BROKEN: _CORPORATE_TITLE');
  const body = AI.slice(from, AI.indexOf(liftFn(AI, 'function _scopeOf(')) + liftFn(AI, 'function _scopeOf(').length);
  return new Function(body + '\n return _scopeOf;')();
})();

// ── real payloads, in the shape the model returns ────────────────────────────
const FOLLETT = { contacts: [
  { name: 'Ray Griffith', title: 'Chief Executive Officer', confidence: 'high',
    sourceUrl: 'https://www.follett.com/leadership',
    affiliationScope: 'parent-or-brand', affiliationEvidence: 'CEO, Follett Corporation' },
], businessEmail: null, businessPhone: null, city: null, state: null };

// The model ASSERTS this-location for a corporate officer. The backstop must not
// believe it: a C-suite title plus an entity mismatch is parent scope whatever the
// model says. This is the greeting-guard lesson applied to affiliation.
const FOLLETT_LIES = { contacts: [
  { name: 'Ray Griffith', title: 'Chief Executive Officer', confidence: 'high',
    sourceUrl: 'https://www.follett.com/leadership',
    affiliationScope: 'this-location', affiliationEvidence: 'runs the store' },
], businessEmail: null, businessPhone: null };

const RALLY_CORP = { contacts: [
  { name: 'Blaine Rowley', title: 'Chief Marketing Officer', confidence: 'high',
    sourceUrl: 'https://www.rallyhouse.com/about-us',
    affiliationScope: 'parent-or-brand', affiliationEvidence: 'CMO, Rally House (national)' },
], businessEmail: null, businessPhone: null };

// CHAMBER: a named owner, no street address anywhere in the listing. The shape
// that produces 24 of the sample's people. Must survive.
const CHAMBER = { contacts: [
  { name: 'Bryan Hembree', title: 'Owner', confidence: 'medium',
    sourceUrl: 'https://fayettevillechamber.example/directory/packrat',
    affiliationScope: 'unclear', affiliationEvidence: 'listed as owner in the chamber directory' },
], businessEmail: null, businessPhone: null };

const LOCAL_SITE = { contacts: [
  { name: 'Dawn Mercer', title: 'Owner', confidence: 'high', email: 'dawn@natstate.example',
    sourceUrl: 'https://natstate.example/about',
    affiliationScope: 'this-location', affiliationEvidence: 'Dawn Mercer opened our Fayetteville clinic in 2016' },
], businessEmail: null, businessPhone: null };

(async () => {
  console.log('-- THE CONTRACT ASKS FOR THE EVIDENCE --');
  ok('the shared JSON contract requires affiliationScope', /affiliationScope/.test(TAIL));
  ok('  and a verbatim affiliationEvidence quote', /affiliationEvidence/.test(TAIL));
  ok('  and names the three scopes', /this-location/.test(TAIL) && /parent-or-brand/.test(TAIL) && /unclear/.test(TAIL));
  ok('  the deterministic backstop exists', !!SCOPE_FN);

  console.log('\n-- A PARENT COMPANY OFFICER IS NOT A CONTACT --');
  {
    const r = await searchSource(FOLLETT, { brand: 'Hog Heaven Team Store', domain: 'bkstr.com' });
    ok('Follett\'s CEO does not survive extraction', (r.contacts || []).length === 0, r.contacts);
    ok('  and is reported, not silently binned',
      (r.notAffiliated || []).some((c) => c.name === 'Ray Griffith'), r.notAffiliated);
    ok('  with a reason on the record',
      ((r.notAffiliated || [])[0] || {}).affiliationScope === 'parent-or-brand', r.notAffiliated);
  }
  {
    const r = await searchSource(FOLLETT_LIES, { brand: 'Hog Heaven Team Store', domain: 'bkstr.com' });
    ok('a corporate title claiming "this-location" is overruled', (r.contacts || []).length === 0, r.contacts);
  }
  {
    // THE CASE FIX 1 CANNOT REACH: the domain genuinely IS Rally House's.
    const r = await searchSource(RALLY_CORP, { brand: 'Rally House Fayetteville', domain: 'rallyhouse.com' });
    ok('Rally House corporate is rejected even on their OWN domain',
      (r.contacts || []).length === 0, r.contacts);
  }

  console.log('\n-- CHAMBER SURVIVES. THIS IS THE ONE THAT MATTERS. --');
  {
    const r = await searchSource(CHAMBER, { source: 'chamber', brand: 'Pack Rat Outdoor Center' });
    ok('an unclear chamber owner IS still a contact', (r.contacts || []).length === 1, r.contacts);
    ok('  he keeps his name and title',
      r.contacts[0].name === 'Bryan Hembree' && r.contacts[0].title === 'Owner', r.contacts[0]);
    ok('  and carries his scope forward for the ladder to act on',
      r.contacts[0].affiliationScope === 'unclear', r.contacts[0]);
    ok('  he is NOT in the rejected bucket', !(r.notAffiliated || []).length, r.notAffiliated);
  }
  {
    const r = await searchSource(LOCAL_SITE, { brand: 'Natural State Aesthetics', domain: 'natstate.example' });
    ok('a local owner on her own about page is untouched', (r.contacts || []).length === 1, r.contacts);
    ok('  and is scoped to this location', r.contacts[0].affiliationScope === 'this-location', r.contacts[0]);
  }

  console.log('\n-- THE LADDER DEMOTES UNCLEAR, IT DOES NOT DROP IT --');
  {
    const { buildContactLadder } = require(R + 'server/services/contactLadder');
    const mk = (contacts, extra) => buildContactLadder(
      Object.assign({ contacts, businessPhone: '(479) 521-6340' }, extra || {}),
      { rankOf, rootDomain: (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0], category: null, brand: 'X' });

    const L = mk([{ name: 'Bryan Hembree', title: 'Owner', email: 'bryan@packrat.example', affiliationScope: 'unclear' }]);
    const t1 = (L.tiers.find((t) => t.tier === 1) || { rows: [] }).rows;
    const t2 = (L.tiers.find((t) => t.tier === 2) || { rows: [] }).rows;
    ok('an unclear owner is NOT in Tier 1', !t1.some((r) => r.name === 'Bryan Hembree'), t1.map((r) => r.name));
    ok('  he IS in Tier 2, still reachable', t2.some((r) => r.name === 'Bryan Hembree'), t2.map((r) => r.name));
    ok('  hasTier1 is honest about it', L.hasTier1 === false, L.hasTier1);
    ok('  and his source note says why',
      /not confirmed|this location/i.test((t2[0] || {}).sourceNote || ''), (t2[0] || {}).sourceNote);

    const L2 = mk([{ name: 'Dawn Mercer', title: 'Owner', email: 'dawn@x.example', affiliationScope: 'this-location' }]);
    ok('a this-location owner still reaches Tier 1', L2.hasTier1 === true, L2.tiers.map((t) => t.tier));

    // Absent scope must behave like today, or every cached row breaks.
    const L3 = mk([{ name: 'Legacy Person', title: 'Owner', email: 'l@x.example' }]);
    ok('a contact with NO scope field is unchanged (cached rows)', L3.hasTier1 === true, L3.hasTier1);
  }

  console.log('\n-- THE FAN-OUT MUST NOT EXIT EARLY ON A REJECTED PERSON --');
{
  // A parent CEO ranks 0, which is Tier 1, so it used to satisfy hasWin and
  // isSatisfied instantly -- the search STOPPED on the wrong person and the real
  // local owner in wave 2 was never looked for.
  //
  // Asserted through BEHAVIOUR, not through the shape of the predicate. Both exit
  // rules read r.contacts, so what matters is what r.contacts now holds; an
  // assertion on the text of hasWin would pass or fail on a refactor that changed
  // nothing.
  const isT1 = (c) => [0, 1, 2, 4, 5].indexOf(rankOf(c.title)) !== -1;
  const exitFires = (r) => (r.contacts || []).some(isT1);

  const parent = await searchSource(FOLLETT, { brand: 'Hog Heaven Team Store', domain: 'bkstr.com' });
  ok('a parent CEO does not satisfy the early exit', exitFires(parent) === false, parent.contacts);
  ok('  even though that title ranks Tier 1 on its own',
    isT1({ title: 'Chief Executive Officer' }) === true, rankOf('Chief Executive Officer'));

  // COST IS DELIBERATELY UNCHANGED. Making an unclear owner fail the exit would
  // run all seven sources on nearly every business and roughly double the bill,
  // to demote someone the ladder already demotes.
  const chamber = await searchSource(CHAMBER, { source: 'chamber', brand: 'Pack Rat Outdoor Center' });
  ok('an unclear owner DOES still satisfy it, so the source count is unchanged',
    exitFires(chamber) === true, chamber.contacts);
}

console.log('\n-- CACHED PRE-CHECK ROWS MUST NOT BE SERVED --');
  {
    const v = parseInt((AI.match(/const _CONTACTS_CACHE_VERSION = (\d+);/) || [])[1], 10);
    ok('the contacts cache version was bumped past 4', v >= 5, v);
    ok('  and notAffiliated is carried in the cached evidence',
      /evidence = \{ kind: 'contacts'[^}]*notAffiliated/.test(AI),
      (AI.match(/const evidence = \{ kind: 'contacts'.*/) || [])[0]);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => {
  console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 5).join('\n'));
  console.log('\nfailures: ' + (f + 1));
  process.exit(1);
});
