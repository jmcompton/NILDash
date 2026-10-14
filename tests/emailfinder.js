'use strict';
// No database needed.
//
//   node tests/emailfinder.js
//
// ── A VERIFIED ADDRESS FOR THE PERSON THE PITCH OPENS TO ────────────────────
// services/emailFinder, with every network call stubbed: Hunter's verifier,
// Domain Search and Email Finder, the domain resolver, the site scrape. One
// section per fix:
//   1. same-domain pattern         2. name + domain, nothing found
//   3. role address only           4. verify what we send
//   5. no website
// and the rules around them: never a desk, never a corporate domain, catch-all
// only for a confirmed pattern, cheapest first, a check limit per business.
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
const EF = require(REPO + 'server/services/emailFinder.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const { checkDomain } = require(REPO + 'server/services/domainGate.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d))); if (!c) F++; };

// ── stubs ───────────────────────────────────────────────────────────────────
// verdicts: email -> 'valid' | 'invalid' | 'accept_all' | 'unknown' | 'notrun'
function deps(o = {}) {
  const calls = { verify: [], domainSearch: [], emailFinder: [], resolve: [], site: [] };
  const verdicts = o.verdicts || {};
  const cachedSet = new Set(o.cached || []);
  const d = {
    calls,
    verify: async (e) => {
      calls.verify.push(e);
      const v = verdicts[e] || o.defaultVerdict || 'invalid';
      if (v === 'notrun') return { result: 'unknown', status: null, notRun: true, source: 'hunter' };
      if (v === 'valid') return { result: 'valid', status: 'valid', source: 'hunter', cached: cachedSet.has(e) };
      if (v === 'invalid') return { result: 'invalid', status: 'invalid', source: 'hunter', cached: cachedSet.has(e) };
      return { result: 'unknown', status: v, source: 'hunter', cached: cachedSet.has(e) };
    },
    peek: async (emails) => new Map(emails.filter((e) => cachedSet.has(e)).map((e) => [e, {}])),
    domainSearch: async (dom) => { calls.domainSearch.push(dom); return o.hunter === undefined ? null : o.hunter; },
    emailFinder: async (f, l, dom) => { calls.emailFinder.push(`${f} ${l} @ ${dom}`); return o.finder || { email: null }; },
    resolveDomain: async (brand) => { calls.resolve.push(brand); return o.resolved || { website: null, tried: [] }; },
    checkDomain,
    siteEmail: async (w) => { calls.site.push(w); return o.site || null; },
    corporate: (dom, brand, out) => EF.corporateDomain(dom, brand, out),
  };
  return d;
}
// A person the greeting guard accepts: named on the business's own site.
const owner = (extra) => ({ name: 'Tom Smith', title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: null, ...(extra || {}) });
const ladderOf = (rows, businessDomain = 'joespizza.com') => ({ tiers: [{ tier: 1, rows }], businessDomain });
const run = (ladder, d, extra) => EF.finishLadder({ ladder, out: (extra && extra.out) || { website: ladder.businessDomain ? 'https://' + ladder.businessDomain : null },
  ig: (extra && extra.ig) || { instagram: 'joespizza', instagramScope: 'business' }, brand: (extra && extra.brand) || "Joe's Pizza", region: 'Waco, TX', place: (extra && extra.place) || null, Q }, d);

(async () => {
  console.log('\nthe greeted person is the one the address is found for');
  {
    const L = ladderOf([owner()]);
    ok(Q.greetRowOf(L) && Q.greetRowOf(L).name === 'Tom Smith', 'fixture: Tom Smith is greetable');
    ok(Q.channelFor(L, { instagram: 'joespizza', instagramScope: 'business' }) === 'dm', 'fixture: with no address the card is a DM');
  }

  console.log('\n1. SAME-DOMAIN PATTERN');
  {
    // Sara Lee's address on the site shows the format; Tom's is built from it.
    const L = ladderOf([owner(), { name: 'Sara Lee', title: 'Manager', source: 'site', sources: ['site'], email: 'sara.lee@joespizza.com', emailKind: 'published' }]);
    const d = deps({ verdicts: { 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.after === 'email', 'a named example gives the format; the built address verifies; email card', r);
    ok(r.finder.email === 'tom.smith@joespizza.com' && r.finder.kind === 'pattern' && r.finder.patternFrom === 'inferred', '  tom.smith@, built from the pattern read off sara.lee@', r.finder);
    ok(d.calls.domainSearch.length === 0 && d.calls.emailFinder.length === 0, '  no Hunter search spent when the site already shows the pattern', d.calls);
    ok(Q.inboxOf(L).email === 'tom.smith@joespizza.com', '  the card\'s address is Tom\'s');
    ok(/Email verified/.test(Q.emailNoteOf(L)), '  the card says it was verified', Q.emailNoteOf(L));
  }
  {
    // An address with no name on it: Hunter gives the domain's pattern.
    const L = ladderOf([owner()]);
    const d = deps({ hunter: { emails: [], pattern: '{f}{last}' }, verdicts: { 'tsmith@joespizza.com': 'valid' } });
    const r = await run(L, d, { out: { website: 'https://joespizza.com', siteEmail: { personalEmail: 'mike@joespizza.com' } } });
    ok(r.finder.email === 'tsmith@joespizza.com' && r.finder.patternFrom === 'hunter', 'an unnamed example: Hunter\'s pattern for the domain builds tsmith@', r.finder);
    ok(d.calls.domainSearch.length === 1 && r.credits.search === 1, '  one domain search spent', r.credits);
  }
  {
    // Hunter listed the person themselves.
    const L = ladderOf([owner()]);
    const d = deps({ hunter: { emails: [{ email: 'tom@joespizza.com', type: 'personal', firstName: 'Tom', lastName: 'Smith' }], pattern: null }, verdicts: { 'tom@joespizza.com': 'valid' } });
    const r = await run(L, d, { out: { website: 'https://joespizza.com', siteEmail: { personalEmail: 'mike@joespizza.com' } } });
    ok(r.finder.email === 'tom@joespizza.com' && r.finder.kind === 'hunter', 'Hunter listed Tom by name: his address is used once it verifies', r.finder);
  }
  {
    // The shape of an unnamed address, when Hunter has no pattern.
    const L = ladderOf([owner()]);
    const d = deps({ hunter: { emails: [], pattern: null }, verdicts: { 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d, { out: { website: 'https://joespizza.com', siteEmail: { personalEmail: 'austin.mitchell@joespizza.com' } } });
    ok(r.finder.email === 'tom.smith@joespizza.com' && r.finder.patternFrom === 'shape', 'austin.mitchell@ suggests first.last; valid, so it is used', r.finder);
  }

  console.log('\n2. NAME + DOMAIN, NO ADDRESSES FOUND');
  {
    const L = ladderOf([owner()]);
    const d = deps({ finder: { email: 'tom@joespizza.com', score: 91, sources: 0 }, verdicts: { 'tom@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.after === 'email' && r.finder.email === 'tom@joespizza.com' && r.finder.how === 'Hunter Email Finder', 'Hunter Email Finder\'s answer, verified valid: email card', r.finder);
    ok(d.calls.emailFinder[0] === 'tom smith @ joespizza.com', '  asked by first name, last name and domain', d.calls.emailFinder);
    ok(d.calls.domainSearch.length === 0, '  no domain search when nothing on the domain needs reading');
  }
  {
    const L = ladderOf([owner()]);
    const d = deps({ finder: { email: null }, verdicts: { 'tom.smith@joespizza.com': 'invalid', 'tom@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.finder.email === 'tom@joespizza.com', 'Email Finder empty: the common formats, first valid wins', r.finder);
    ok(JSON.stringify(d.calls.verify) === JSON.stringify(['tom.smith@joespizza.com', 'tom@joespizza.com']), '  first.last@ then first@, and it stops at the first valid', d.calls.verify);
    ok(r.credits.verify === 2, '  two verification credits', r.credits);
  }
  {
    const L = ladderOf([owner()]);
    const d = deps({ cached: ['tsmith@joespizza.com'], verdicts: { 'tsmith@joespizza.com': 'invalid', 'tom.smith@joespizza.com': 'valid' } });
    await run(L, d);
    ok(d.calls.verify[0] === 'tsmith@joespizza.com', 'cheapest first: a format already verified is looked at before one that costs a credit', d.calls.verify);
  }
  {
    const L = ladderOf([owner()]);
    const d = deps({ defaultVerdict: 'invalid' });
    const r = await run(L, d);
    ok(r.after === 'dm' && !r.finder.email, 'nothing verifies: the card stays a DM', r.finder);
    ok(d.calls.verify.length === EF.COMMON_FORMATS.length, '  every common format was tried once', d.calls.verify);
  }
  {
    const L = ladderOf([owner({ name: 'Tom' })]);
    const d = deps({ verdicts: { 'tom@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(d.calls.emailFinder.length === 0 && r.finder.email === 'tom@joespizza.com', 'a first name only: no Email Finder (it needs a surname), first@ still tried', r.finder);
  }

  {
    // Hunter's domain search already ran on the ladder and came back with no
    // addresses but a pattern: free to read, and a confirmed pattern.
    const L = ladderOf([owner()]);
    const d = deps({ defaultVerdict: 'accept_all' });
    d.hunterCached = async () => ({ found: false, emails: [], pattern: '{first}.{last}', cached: true });
    const r = await run(L, d);
    ok(r.finder.email === 'tom.smith@joespizza.com' && r.finder.patternFrom === 'hunter' && r.finder.catchAllPass, 'Hunter empty but with a pattern (cached): Tom\'s address is built from it, catch-all passes as a confirmed pattern', r.finder);
    ok(d.calls.domainSearch.length === 0 && d.calls.emailFinder.length === 0 && r.credits.search === 0, '  no search credit: the cached answer is read, not bought', r.credits);
  }
  {
    // A cached verdict is free and does not count toward the per-business limit.
    const L = ladderOf([owner()]);
    const all = EF.COMMON_FORMATS.map((p) => require(REPO + 'server/services/emailPattern.js').construct(p, 'Tom Smith', 'joespizza.com'));
    const d = deps({ cached: all, defaultVerdict: 'invalid', finder: { email: 'thomas@joespizza.com' } });
    await run(L, d);
    ok(d.calls.verify.length === all.length + 1, 'cached checks do not use up the limit', d.calls.verify);
  }

  console.log('\n3. ROLE ADDRESS ONLY');
  {
    // No website on file; info@ at the business's domain names it.
    const L = ladderOf([owner(), { name: null, title: 'General inbox', email: 'info@joespizza.com', emailKind: 'published' }], null);
    const d = deps({ verdicts: { 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d, { out: { website: null } });
    ok(r.finder.domain === 'joespizza.com' && r.finder.email === 'tom.smith@joespizza.com', 'info@ gives the domain; step 2 finds Tom\'s address', r.finder);
    ok(!d.calls.verify.includes('info@joespizza.com'), '  info@ itself is never verified or used');
  }
  {
    const L = ladderOf([owner(), { name: null, title: 'General inbox', email: 'info@joespizza.com', emailKind: 'published' }]);
    const d = deps({ verdicts: { 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.finder.roleOnly === true && r.after === 'email', 'with a website and only info@: step 2 runs before giving up', r.finder);
  }

  console.log('\n4. VERIFY WHAT WE SEND');
  {
    const L = ladderOf([owner({ email: 'tom@joespizza.com', emailKind: 'published' })]);
    const d = deps({ verdicts: { 'tom@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.verify && r.verify.verdict === 'valid' && r.verify.pass && r.after === 'email', 'the card\'s own address is verified: valid passes', r.verify);
    ok(d.calls.verify.length === 1 && !r.finder, '  nothing else is spent');
  }
  {
    const L = ladderOf([owner({ email: 'tom@joespizza.com', emailKind: 'published' })]);
    const d = deps({ verdicts: { 'tom@joespizza.com': 'invalid', 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.verify.pass === false && r.verify.verdict === 'invalid', 'invalid never passes', r.verify);
    ok(r.finder.email === 'tom.smith@joespizza.com' && r.after === 'email', '  and the finder looks for the address that does work', r.finder);
    ok(d.calls.verify.filter((e) => e === 'tom@joespizza.com').length === 1, '  the refused address is not checked twice', d.calls.verify);
  }
  {
    const L = ladderOf([owner({ email: 'tom@joespizza.com', emailKind: 'published' })]);
    const d = deps({ verdicts: { 'tom@joespizza.com': 'invalid' }, defaultVerdict: 'invalid' });
    const r = await run(L, d, { ig: { instagram: null } });
    const bar = Q.passesBar(L, { instagram: null });
    ok(r.after === 'call' && Q.inboxOf(L) === null, 'an invalid address is never the card\'s email', r.after);
    ok(!bar.ok, '  and with no phone or handle the business has no way through (the night skips it)', bar);
    ok(/did not pass verification/.test(Q.emailNoteOf(L)), '  the card says why', Q.emailNoteOf(L));
  }
  {
    // CATCH-ALL. Built from a confirmed pattern: passes. A guess: does not.
    const L = ladderOf([owner(), { name: 'Sara Lee', title: 'Manager', source: 'site', sources: ['site'], email: 'sara.lee@joespizza.com', emailKind: 'published' }]);
    const d = deps({ defaultVerdict: 'accept_all' });
    const r = await run(L, d);
    ok(r.after === 'email' && r.finder.verdict === 'catch-all' && r.finder.catchAllPass, 'catch-all passes for an address built from a confirmed pattern with a real name', r.finder);
  }
  {
    const L = ladderOf([owner()]);
    const d = deps({ defaultVerdict: 'accept_all' });
    const r = await run(L, d);
    ok(r.after === 'dm' && !r.finder.email && r.finder.catchAll, 'catch-all never passes for a guessed format', r.finder);
    ok(d.calls.verify.length === 1, '  and the guessing stops at the first catch-all: nothing more to learn', d.calls.verify);
  }
  {
    const L = ladderOf([owner({ email: 'tom@joespizza.com', emailKind: 'published' })]);
    const d = deps({ defaultVerdict: 'accept_all' });
    const r = await run(L, d);
    ok(r.verify.pass === false && r.verify.heldStated, 'a published address for the person on a catch-all domain: held back under the rule as written, and counted', r.verify);
  }
  {
    const L = ladderOf([owner({ email: 'tom@joespizza.com', emailKind: 'published' })]);
    const d = deps({ verdicts: { 'tom@joespizza.com': 'notrun' } });
    const r = await run(L, d);
    ok(r.verify.pass === false && r.verify.verdict === 'not-run', 'a check that could not run is not a pass', r.verify);
    ok(r.finder && r.finder.stop === 'verification could not run', '  and the finder stops rather than spend into an outage', r.finder);
  }

  console.log('\n5. NO WEBSITE');
  {
    const L = ladderOf([owner()], null);
    const d = deps({ resolved: { website: 'https://joespizzawaco.com', tried: [] }, verdicts: { 'tom.smith@joespizzawaco.com': 'valid' } });
    const r = await run(L, d, { out: { website: null } });
    ok(r.website && r.website.website === 'https://joespizzawaco.com' && /web search/.test(r.website.via), 'no website: a web search for the domain', r.website);
    ok(d.calls.site.length === 1, '  and the newly found site is read for addresses', d.calls.site);
    ok(r.finder.email === 'tom.smith@joespizzawaco.com' && r.after === 'email', '  then the finder runs on it', r.finder);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    const r = await run(L, d, { out: { website: null }, place: { name: "Joe's Pizza", website: 'https://joespizza.com' } });
    ok(r.website.website === 'https://joespizza.com' && r.website.strict === false && d.calls.resolve.length === 0, 'the Places website, when the gate confirms it, without a search', r.website);
  }
  {
    // The domain does not spell the name, but the Places record IS this business.
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'accept_all' });
    const r = await run(L, d, { out: { website: null }, place: { name: "Joe's Pizza", website: 'https://bestpiewaco.com' } });
    ok(r.website.website === 'https://bestpiewaco.com' && r.website.strict === true, 'a Places record named for this business: its website is used, marked unconfirmed', r.website);
    ok(r.after === 'dm' && !r.finder.email, '  on an unconfirmed domain a catch-all never passes, even from a pattern', r.finder);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    const r = await run(L, d, { out: { website: null }, place: { name: 'Davenport Pizza Palace', website: 'https://davenportspizza.com' } });
    ok(!r.website.website && r.after === 'dm', 'a Places record for a different business is not used (Post Office Pies -> davenportspizza.com)', r.website);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid', resolved: { website: null, tried: [{ url: 'https://bestpiewaco.com', ok: false, code: 'name-absent' }] } });
    const r = await run(L, d, { out: { website: null }, place: { name: 'Something Else', website: 'https://bestpiewaco.com' } });
    ok(r.website.website === 'https://bestpiewaco.com' && r.website.strict === false, 'the Places record and the web search agree on a domain: confirmed', r.website);
  }

  console.log('\nTHE RULES AROUND IT');
  {
    for (const e of ['customerservice@x.com', 'support@x.com', 'webmaster@x.com', 'legal@x.com', 'general.counsel@x.com', 'careers@x.com', 'noreply@x.com', 'no-reply@x.com']) {
      ok(EF.isNever(e), `never: ${e}`);
    }
    ok(!EF.isNever('tom.smith@x.com') && !EF.isNever('jess@x.com'), 'a person\'s address is not a desk');
  }
  {
    const L = ladderOf([owner(), { name: 'Pat Doe', title: 'Recruiter', source: 'site', sources: ['site'], email: 'careers@joespizza.com', emailKind: 'published' }]);
    const d = deps({ hunter: null, defaultVerdict: 'invalid' });
    await run(L, d);
    ok(!d.calls.verify.includes('careers@joespizza.com') && !d.calls.verify.some((e) => /^careers/.test(e)), 'careers@ is never a pattern example nor checked', d.calls.verify);
  }
  {
    const L = ladderOf([owner()], 'dominos.com');
    const d = deps({ defaultVerdict: 'valid' });
    const r = await run(L, d, { brand: "Domino's", out: { website: 'https://dominos.com' } });
    ok(r.after === 'dm' && /national chain|corporate/.test(r.finder.stop) && d.calls.verify.length === 0, 'a national chain\'s corporate domain is never where a local owner is reached', r.finder);
  }
  {
    const L = ladderOf([owner()]);
    const d = deps({ defaultVerdict: 'valid' });
    const r = await run(L, d, { out: { website: 'https://joespizza.com', siteEmail: { corporate: true, corporateVia: 'this website serves 4 different businesses' } } });
    ok(/corporate/.test(r.finder.stop) && d.calls.verify.length === 0, 'a site flagged corporate (franchise) is skipped', r.finder);
  }
  {
    // The greeting must survive: a person greetable only through a published
    // address is not handed a built one in its place.
    const row = { name: 'Tom Smith', title: 'Owner', email: 'tom@joespizza.com', emailKind: 'published', sources: [] };
    const L = ladderOf([row]);
    ok(Q.greetRowOf(L) === row, 'fixture: greetable only through the published address');
    const d = deps({ verdicts: { 'tom@joespizza.com': 'invalid', 'tom.smith@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(!r.finder.email && /greeting/.test(r.finder.stop) && row.email === 'tom@joespizza.com', 'a built address that would cost the greeting is undone', r.finder);
  }
  {
    ok(EF.passes({ verdict: 'valid' }).ok, 'passes: valid');
    ok(!EF.passes({ verdict: 'invalid', built: true, patternConfirmed: true, realName: true }).ok, 'passes: invalid never');
    ok(!EF.passes({ verdict: 'unknown', built: true, patternConfirmed: true, realName: true }).ok, 'passes: unknown never');
    ok(EF.passes({ verdict: 'catch-all', built: true, patternConfirmed: true, realName: true }).ok, 'passes: catch-all + confirmed pattern + real name');
    ok(!EF.passes({ verdict: 'catch-all', built: true, patternConfirmed: false, realName: true }).ok, 'passes: catch-all + guessed format, no');
    ok(!EF.passes({ verdict: 'catch-all', built: true, patternConfirmed: true, realName: true, strictDomain: true }).ok, 'passes: catch-all on an unconfirmed domain, no');
  }
  {
    // A check limit per business.
    const L = ladderOf([owner(),
      { name: 'Ann Bee', title: 'Manager', source: 'site', sources: ['site'], email: 'ann.bee@joespizza.com', emailKind: 'published' },
      { name: 'Cal Dee', title: 'Manager', source: 'site', sources: ['site'], email: 'cdee@joespizza.com', emailKind: 'published' },
      { name: 'Eve Fox', title: 'Manager', source: 'site', sources: ['site'], email: 'eve_fox@joespizza.com', emailKind: 'published' }]);
    const d = deps({ defaultVerdict: 'invalid', finder: { email: 'tsmith2@joespizza.com' } });
    await run(L, d);
    ok(d.calls.verify.length <= EF.MAX_VERIFIES, `no more than ${EF.MAX_VERIFIES} checks for one business`, d.calls.verify.length);
  }

  console.log('\nMORE (EMAIL_FINDER_MORE): ANOTHER NAMED DECISION MAKER');
  const gm = (extra) => ({ name: 'Gina Moore', title: 'General Manager', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: null, ...(extra || {}) });
  const runMore = (ladder, d, extra) => EF.finishLadder({ ladder, out: (extra && extra.out) || { website: ladder.businessDomain ? 'https://' + ladder.businessDomain : null },
    ig: (extra && extra.ig) || { instagram: 'joespizza', instagramScope: 'business' }, brand: (extra && extra.brand) || "Joe's Pizza", region: 'Waco, TX', place: (extra && extra.place) || null, Q, more: true }, d);
  {
    const tom = owner(); const gina = gm();
    const L = ladderOf([tom, gina]);
    const d = deps({ verdicts: { 'gina.moore@joespizza.com': 'valid' } });
    const r = await runMore(L, d);
    ok(r.after === 'email' && r.finder.switchedTo && r.finder.switchedTo.name === 'Gina Moore', 'Tom cannot be verified; the general manager Gina can: the card goes to her', r.finder);
    ok(Q.greetRowOf(L) === gina && Q.greetNameOf(L) === 'Gina' && Q.inboxOf(L).email === 'gina.moore@joespizza.com', '  and she is the person greeted by name, at her verified address', [Q.greetNameOf(L), Q.inboxOf(L)]);
    ok(Q.buildCard({ brand: "Joe's Pizza", pitch: { message: 'Hi Gina,\nx' } }, L, { instagram: 'joespizza' }).contactName === 'Gina Moore', '  the card names her');
    ok(d.calls.verify.filter((e) => /gina/.test(e)).length <= EF.ALT_MAX_VERIFIES, `  no more than ${EF.ALT_MAX_VERIFIES} checks spent on the other people`, d.calls.verify);
  }
  {
    const L = ladderOf([owner(), gm()]);
    const d = deps({ verdicts: { 'gina.moore@joespizza.com': 'valid' } });
    const r = await run(L, d);
    ok(r.after === 'dm' && !r.finder.switchedTo, 'with EMAIL_FINDER_MORE off, nobody else is tried', r.finder);
  }
  {
    const L = ladderOf([owner(), gm({ name: 'Al Barista', title: 'Barista' }), gm({ name: 'Amy Assistant', title: 'Assistant Manager' })]);
    const d = deps({ defaultVerdict: 'valid' });
    d.verify = async (e) => { d.calls.verify.push(e); return /tom|smith/.test(e) ? { result: 'invalid', status: 'invalid' } : { result: 'valid', status: 'valid' }; };
    const r = await runMore(L, d);
    ok(!r.finder.switchedTo && r.after === 'dm', 'a barista or an assistant manager is never the fallback: not a decision maker', r.finder);
  }
  {
    // Someone the guard would not greet (no source it trusts) is not used.
    const L = ladderOf([owner(), gm({ source: 'news', sources: ['news'] })]);
    const d = deps({ verdicts: { 'gina.moore@joespizza.com': 'valid' } });
    const r = await runMore(L, d);
    ok(!r.finder.switchedTo, 'a manager the greeting guard would not open to is not used', r.finder);
  }
  {
    const L = ladderOf([owner(), gm()]);
    const d = deps({ defaultVerdict: 'accept_all' });
    const r = await runMore(L, d);
    ok(!r.finder.switchedTo && d.calls.verify.length === 1, 'a catch-all domain: no other name can be confirmed either, so nobody else is tried', d.calls.verify);
  }

  console.log('\nMORE: NO WEBSITE -- THE PLACES FIELD AND THE FACEBOOK PAGE');
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    d.placeLookup = async () => ({ name: "Joe's Pizza", website: 'https://joespizza.com' });
    const r = await runMore(L, d, { out: { website: null }, place: null });
    ok(r.website.website === 'https://joespizza.com' && r.after === 'email', 'no Places record on the night: the website field is asked for', r.website);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    d.facebookPage = async () => ({ facebookUrl: 'https://www.facebook.com/joespizzawaco', website: 'https://joespizzawaco.com', email: null, cached: false, searches: 1 });
    const r = await runMore(L, d, { out: { website: null } });
    ok(r.website.website === 'https://joespizzawaco.com' && /Facebook/.test(r.website.via) && r.website.strict === false, 'the website the Facebook page lists, confirmed by the gate', r.website);
    ok(r.after === 'email' && r.credits.webSearch >= 1, '  then the finder runs on it; the search is counted', r.credits);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'accept_all' });
    d.facebookPage = async () => ({ facebookUrl: 'https://www.facebook.com/x', website: 'https://bestpiewaco.com', email: null });
    const r = await runMore(L, d, { out: { website: null } });
    ok(r.website.strict === true && r.after === 'dm', 'a Facebook website the gate cannot confirm: only a valid mailbox would count there', r.website);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ verdicts: { 'tomsmith.pizza@gmail.com': 'valid' } });
    d.facebookPage = async () => ({ facebookUrl: 'https://www.facebook.com/x', website: null, email: 'tomsmith.pizza@gmail.com' });
    const r = await runMore(L, d, { out: { website: null } });
    ok(r.after === 'email' && Q.inboxOf(L).email === 'tomsmith.pizza@gmail.com' && /Facebook/.test(r.finder.how), 'the owner\'s own mailbox, listed on the page and carrying his name, verified: used', r.finder);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    d.facebookPage = async () => ({ facebookUrl: 'https://www.facebook.com/x', website: null, email: 'joespizzawaco@gmail.com' });
    const r = await runMore(L, d, { out: { website: null } });
    ok(r.after === 'dm' && !d.calls.verify.includes('joespizzawaco@gmail.com'), 'an unnamed gmail on the page is the shop\'s desk, not a person: not used', r.finder);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ verdicts: { 'tom.smith@joespizza.biz': 'valid' } });
    d.facebookPage = async () => ({ facebookUrl: 'https://www.facebook.com/x', website: null, email: 'hello@joespizza.biz' });
    const r = await runMore(L, d, { out: { website: null } });
    ok(r.website.website === 'https://joespizza.biz' && r.after === 'email', 'an email at a domain of its own names the domain; the finder runs on it', [r.website, r.finder && r.finder.email]);
  }
  {
    const L = ladderOf([owner()], null);
    const d = deps({ defaultVerdict: 'valid' });
    let fbAsked = 0, placeAsked = 0;
    d.facebookPage = async () => { fbAsked++; return null; };
    d.placeLookup = async () => { placeAsked++; return null; };
    await run(L, d, { out: { website: null } });
    ok(fbAsked === 0 && placeAsked === 0, 'with EMAIL_FINDER_MORE off, neither Places nor Facebook is asked');
  }
  {
    const FB = require(REPO + 'server/services/facebookPage.js');
    ok(FB.clean({ facebookUrl: 'https://www.yelp.com/biz/x', website: 'https://x.com' }).facebookUrl === null, 'facebookPage: a page that is not on Facebook is no page');
    const c = FB.clean({ facebookUrl: 'https://www.facebook.com/joes', website: 'https://www.instagram.com/joes', email: 'not an email' });
    ok(c.facebookUrl && c.website === null && c.email === null, '  a "website" that is another social page, and a non-address, are dropped', c);
    ok(FB.clean({ facebookUrl: 'https://m.facebook.com/joes', website: 'joespizza.com', email: 'Tom@JoesPizza.com' }).website === 'https://joespizza.com', '  a bare domain is read as a website');
  }

  console.log('\nCHAINS: BUCKLE');
  {
    const NC = require(REPO + 'server/services/nationalChains.js');
    const was = process.env.EMAIL_FIVE_ON;
    delete process.env.EMAIL_FIVE_ON; delete process.env.EMAIL_FINDER_MORE;
    ok(!NC.isChainLocation('Buckle'), 'Buckle is not on the list until a switch is on (merging changes nothing)');
    process.env.EMAIL_FIVE_ON = '1';
    ok(['Buckle', 'The Buckle', 'Buckle - Waco Mall', 'Buckle (Central Texas Marketplace)', 'Buckle #213'].every((n) => NC.isChainLocation(n) === 'buckle'), 'Buckle, in every store-name form, is a chain location');
    ok(!NC.isChainLocation('Swashbuckler Pub') && !NC.isChainLocation('Buckle Up Saloon') && !NC.isNationalChain('Swashbuckler Pub'), '  and Swashbuckler Pub or Buckle Up Saloon is not');
    ok(/chain/.test(EF.corporateDomain('buckle.com', 'Buckle', null) || ''), '  buckle.com is its corporate domain');
    if (was === undefined) delete process.env.EMAIL_FIVE_ON; else process.env.EMAIL_FIVE_ON = was;
  }

  console.log('\nTHE NIGHT\'S WIRING (jobs/outreachQueue)');
  {
    const job = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
    const iName = job.indexOf('if (NAME_REQUIRED && !Q.greetNameOf(ladder))');
    const iFin = job.indexOf('EF.finishLadder(');
    const iQueued = job.indexOf("tried.push({ brand: cand.brand_name, result: 'queued', reason: null, lane: cand.lane,");
    const iWriter = job.indexOf('\n        pitch = await PW.writePitch(', iQueued);
    ok(iName > 0 && iFin > iName && iQueued > iFin && iWriter > iQueued, 'after the bar and the name, before the card is queued and the writer runs', { iName, iFin, iQueued, iWriter });
    ok(/EF\.liveDeps\(pool, \{ agentId, athleteId, business: cand\.brand_name, source: 'nightly' \}\)/.test(job), 'credits are charged to the agent, the athlete and the business, tagged nightly');
    ok(/on: \(\) => process\.env\.EMAIL_FINDER_ON === '1' \|\| process\.env\.EMAIL_FIVE_ON === '1'/.test(job)
      && /more: \(\) => process\.env\.EMAIL_FINDER_MORE === '1'/.test(job) && /five: \(\) => process\.env\.EMAIL_FIVE_ON === '1'/.test(job)
      && /if \(FINDER\.on\(\)\) \{/.test(job) && !/EMAIL_FINDER_OFF/.test(job), 'off by default: the night runs it only with EMAIL_FINDER_ON=1 (or EMAIL_FIVE_ON=1)');
    // The dry run calls the same step with no switch in the way.
    const dry = require('fs').readFileSync(REPO + 'server/services/emailFinderDryRun.js', 'utf8');
    const efSrc = require('fs').readFileSync(REPO + 'server/services/emailFinder.js', 'utf8');
    ok(/EF\.finishLadder\(/.test(dry) && !/EMAIL_FINDER_ON/.test(dry) && !/EMAIL_FINDER_ON/.test(efSrc), 'the dry run works whether the switch is on or off');
    ok(/channel = Q\.channelFor\(ladder, ig\);\s*_why\.channel = channel;/.test(job.slice(iFin)), 'the channel the writer is told is the one after the finder');
    ok(/_why\.finder = \{/.test(job), 'what it did is recorded on the run row (email-finder-report reads it)');
    ok(/stage: 'verify', reason: why/.test(job), 'no way through after verification: the business is not a card');
    // Never the per-athlete daily budget: the night's verifier is not wrapped in it.
    const ef = require('fs').readFileSync(REPO + 'server/services/emailFinder.js', 'utf8');
    ok(!/VB\.limiter|spentToday|PER_ATHLETE_DAY/.test(ef), 'the night\'s verification is never held to Home\'s per-athlete daily budget');
  }

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
