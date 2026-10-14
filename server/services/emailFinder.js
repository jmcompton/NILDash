'use strict';
// ── A VERIFIED ADDRESS FOR THE PERSON THE PITCH OPENS TO ────────────────────
//
// Seven nights of DM and call cards in production, 177 of them, and why none
// was an email (email-finder-report):
//   70  an address at the business, but not the named person's
//   36  no website
//   32  a role address only (info@ ...)
//   31  Hunter's domain search empty
// Hunter: 357 of 2,000 searches and 5 of 4,000 verifications used. Budget was
// never the cause. Pattern guessing never ran.
//
// This runs after the contact ladder, once the business is chosen and the
// person the pitch opens to is known, and does five things:
//
//   1. SAME-DOMAIN PATTERN. A real person's address at the business's domain
//      shows how the domain spells addresses. Read the format off it (from the
//      name it belongs to, or Hunter's own pattern for the domain), build the
//      named person's address the same way, verify it.
//   2. NAME + DOMAIN, NOTHING FOUND. Hunter Email Finder for the person. Empty
//      or not valid: the common formats, cheapest first, each verified, first
//      valid wins.
//   3. ROLE ADDRESS ONLY. Step 2, on that address's domain, before giving up.
//   4. VERIFY WHAT WE SEND. The card's address gets a Hunter verification.
//      Valid passes. Catch-all passes only for an address built from a
//      confirmed pattern with a real name. Invalid never passes; neither does a
//      check that could not run.
//   5. NO WEBSITE. The Google Places record's website, then a web search for
//      the domain, before the business is treated as having none.
//
// What it never does: pick a different business, change the floor, touch the
// writer. It changes WHICH ADDRESS a chosen business is reached at, and so its
// channel. An address it cannot verify is not used.
//
// Pure where it can be. Every network call is injected (deps), so the dry run
// and the tests run the same code the night does.

const EP = require('./emailPattern');
const ET = require('./emailTier');

// ── NEVER, FOR A PITCH ──────────────────────────────────────────────────────
// Department inboxes nobody who can sign a sponsorship reads. Never built,
// never used as a pattern example, never sent to.
const NEVER_LOCAL = /^(customer[._-]?(service|services|care|support|success|relations)|cs|support|help|helpdesk|webmaster|web|legal|general[._-]?counsel|counsel|careers?|jobs?|hiring|recruit(ing|ment)?|hr|human[._-]?resources|no[._-]?reply|do[._-]?not[._-]?reply|donotreply|postmaster|mailer[._-]?daemon|abuse|privacy|compliance|security|billing|invoices?|accounts?([._-]?payable)?|unsubscribe|bounces?|returns?|warranty|claims?)$/i;
const lc = (s) => String(s || '').trim().toLowerCase();
const localOf = (e) => lc(e).split('@')[0] || '';
const domainOf = (e) => lc(e).split('@')[1] || '';
function isNever(email) {
  const l = localOf(email).replace(/\d+$/, '').split('+')[0];
  return NEVER_LOCAL.test(l) || NEVER_LOCAL.test(l.replace(/[._-]/g, '')) || NEVER_LOCAL.test(l.split(/[._-]+/)[0]);
}
// Not a person: a generic desk (Tier 4), a role word, or a department.
function isDesk(email) { return ET.isGeneric(email) || ET.isRoleMailbox(email) || isNever(email); }
const rootOf = (x) => ET.rootDomain(x);
const sameDomain = (email, domain) => !!domain && rootOf(domainOf(email)) === rootOf(domain);

// The formats tried when nothing on the domain shows its pattern, in the order
// small businesses use them. Each costs one verification unless cached.
const COMMON_FORMATS = ['{first}.{last}', '{first}', '{f}{last}', '{first}{last}'];
// A ceiling per business, so one stubborn domain cannot spend a night's checks.
const MAX_VERIFIES = parseInt(process.env.FINDER_MAX_VERIFIES, 10) || 6;
// Off by default: the rule as written lets a catch-all pass only for an
// address built from a confirmed pattern. With this on, an address FOUND
// stated for the named person (on their site, or listed by Hunter) also
// passes on a catch-all domain. The dry run counts what it would add.
const CATCHALL_STATED = process.env.FINDER_CATCHALL_STATED === '1';

// ── ONE VERDICT WORD ────────────────────────────────────────────────────────
// From emailVerify.verifyMany's entry: { result, status, notRun }.
function verdictOf(v) {
  if (!v) return 'not-run';
  if (v.notRun) return 'not-run';
  const st = lc(v.status);
  if (v.result === 'valid') return 'valid';
  if (v.result === 'invalid') return 'invalid';
  if (st === 'accept_all') return 'catch-all';
  if (v.source === 'mx' || v.source === 'deadline') return 'not-run';
  return 'unknown';
}

// ── RULE 4 ──────────────────────────────────────────────────────────────────
//   valid                                            passes
//   catch-all, built from a confirmed pattern,
//     a real name, on a domain confirmed as theirs   passes
//   everything else                                  does not
// `strictDomain`: the domain was accepted on weaker evidence (a Places record
// whose own website the domain gate could not confirm). Only valid passes there.
function passes({ verdict, built, patternConfirmed, realName, stated, strictDomain }) {
  if (verdict === 'valid') return { ok: true };
  if (verdict === 'catch-all') {
    if (strictDomain) return { ok: false, why: 'catch-all, and the domain is not confirmed as the business\'s own, so only a valid mailbox is used' };
    if (built && patternConfirmed && realName) return { ok: true, catchAll: true };
    if (CATCHALL_STATED && stated && realName) return { ok: true, catchAll: true };
    return { ok: false, why: built ? 'catch-all, and the format was a guess rather than a confirmed pattern' : 'catch-all, and not built from a confirmed pattern', heldStated: !!(stated && realName) };
  }
  if (verdict === 'invalid') return { ok: false, why: 'the verifier says the mailbox does not exist' };
  if (verdict === 'not-run') return { ok: false, why: 'could not be verified (the check did not run)' };
  return { ok: false, why: 'the verifier could not confirm the mailbox' };
}

// ── PATTERN EXAMPLES ────────────────────────────────────────────────────────
// A real person's address on the domain, with the name it belongs to when we
// know it. Only sources we trust to have seen the address count as confirming
// a pattern; a model's search result can still suggest a shape.
const TRUSTED_KINDS = new Set(['published', 'hunter', 'bio']);
function examplesOf(ladder, out, domain, hunter) {
  const ex = [];
  const seen = new Set();
  const add = (email, name, kind, sourceUrl) => {
    const e = lc(email);
    if (!e || seen.has(e) || !sameDomain(e, domain) || isDesk(e)) return;
    seen.add(e);
    ex.push({ email: e, name: name || null, kind: kind || 'published', sourceUrl: sourceUrl || null });
  };
  for (const t of ((ladder && ladder.tiers) || [])) {
    for (const r of (t.rows || [])) if (r && r.email && r.emailKind !== 'pattern') add(r.email, r.name, r.emailKind, r.emailSourceUrl);
  }
  const se = out && out.siteEmail;
  if (se && se.personalEmail) add(se.personalEmail, null, 'published', se.personalSourceUrl);
  for (const h of ((hunter && hunter.emails) || [])) {
    if (h && h.email && h.type !== 'generic') add(h.email, [h.firstName, h.lastName].filter(Boolean).join(' ') || null, 'hunter', h.sourceUrl);
  }
  return ex;
}

// The format an unnamed address suggests, when its shape says it plainly:
// "austin.mitchell@" is {first}.{last}, "a.mitchell@" is {f}.{last}. A single
// token says nothing (amitchell@ could be {f}{last} or a nickname). Never a
// CONFIRMED pattern: it names nobody.
function shapeOf(email) {
  const lp = localOf(email);
  const m = lp.match(/^([a-z]+)([._-])([a-z]+)$/);
  if (!m) return null;
  if (m[1].length === 1) return `{f}${m[2]}{last}`;
  if (m[3].length === 1) return `{first}${m[2]}{l}`;
  return `{first}${m[2]}{last}`;
}

function realNameOf(name) {
  const n = EP.splitName(name);
  if (!n || !n.first || n.first.length < 2) return null;
  return n;
}

// ── THE FINDER ──────────────────────────────────────────────────────────────
// ctx:  { name, domain, examples, strictDomain, hunter (a domain search already
//         in hand, or null), roleOnly }
// deps: { verify(email) -> verifyMany entry, peek(emails) -> Map of cached,
//         domainSearch(domain) -> Hunter domain search | null,
//         emailFinder(first, last, domain) -> { email, ... } }
// -> { email, kind, how, verdict, pattern, patternFrom, confirmed, steps,
//      credits: { search, verify }, catchAll, stop }
async function find(ctx, deps) {
  const steps = [];
  const credits = { search: 0, verify: 0 };
  const res = (extra) => ({ email: null, steps, credits, ...extra });
  const n = realNameOf(ctx.name);
  const domain = rootOf(ctx.domain);
  if (!n) return res({ stop: 'no usable name' });
  if (!domain) return res({ stop: 'no domain' });
  // Addresses already checked and refused (the card's own, in rule 4).
  const tried = new Set((ctx.skip || []).map(lc));
  let verifies = 0, catchAll = false, notRun = false;

  const attempt = async (email, how, meta) => {
    const e = lc(email);
    if (!e || tried.has(e)) return null;
    tried.add(e);
    if (!sameDomain(e, domain)) { steps.push({ how, email: e, ok: false, why: 'not at the business domain' }); return null; }
    if (isDesk(e)) { steps.push({ how, email: e, ok: false, why: 'a desk address, not a person' }); return null; }
    if (verifies >= MAX_VERIFIES) { steps.push({ how, email: e, ok: false, why: 'per-business check limit reached' }); return null; }
    const v = await deps.verify(e);
    verifies++;
    if (v && !v.cached && !v.notRun) credits.verify++;
    const verdict = verdictOf(v);
    const p = passes({ verdict, built: !!meta.built, patternConfirmed: !!meta.confirmed, realName: true,
      stated: !!meta.stated, strictDomain: !!ctx.strictDomain });
    steps.push({ how, email: e, verdict, ok: p.ok, why: p.why || null, cached: !!(v && v.cached), heldStated: !!p.heldStated });
    if (verdict === 'catch-all') catchAll = true;
    if (verdict === 'not-run') notRun = true;
    if (!p.ok) return null;
    return { email: e, how, verdict, kind: meta.kind, pattern: meta.pattern || null, patternFrom: meta.from || null,
      confirmed: !!meta.confirmed, sourceUrl: meta.sourceUrl || null, catchAllPass: !!p.catchAll };
  };
  const done = (hit) => ({ ...hit, steps, credits, catchAll });

  // ── 1. THE DOMAIN'S OWN PATTERN ────────────────────────────────────────
  let hunter = ctx.hunter || null;
  const examples = (ctx.examples || []).filter((x) => sameDomain(x.email, domain) && !isDesk(x.email));
  const confirmed = [];   // { pattern, from, example, sourceUrl }
  const shapes = [];
  const addConfirmed = (pattern, from, example, sourceUrl) => {
    const p = EP.normalizePattern(pattern);
    if (p && !confirmed.some((c) => c.pattern === p)) confirmed.push({ pattern: p, from, example: example || null, sourceUrl: sourceUrl || null });
  };
  for (const x of examples) {
    // The person's own address, found stated: no building needed.
    if (x.name && TRUSTED_KINDS.has(x.kind) && sameNameLoose(x.name, ctx.name)) {
      const hit = await attempt(x.email, 'found stated for them', { kind: x.kind, built: false, stated: true, sourceUrl: x.sourceUrl });
      if (hit) return done(hit);
      continue;
    }
    if (x.name && TRUSTED_KINDS.has(x.kind)) {
      const p = EP.inferPattern(x.email, x.name);
      if (p) addConfirmed(p, 'inferred', x.email, x.sourceUrl);
    } else {
      const s = shapeOf(x.email);
      if (s && !shapes.includes(s)) shapes.push(s);
    }
  }
  // Nothing on the domain names who an address belongs to: ask Hunter for
  // the domain's pattern (one search, cached 30 days by domain). Skipped
  // when there are no examples at all; that is step 2's case.
  if (examples.length && !confirmed.length && !hunter && typeof deps.domainSearch === 'function') {
    hunter = await deps.domainSearch(domain);
    if (hunter && !hunter.cached && !hunter.fault) credits.search++;
    steps.push({ how: 'Hunter domain search', ok: !!hunter, why: hunter ? (hunter.pattern ? `pattern ${hunter.pattern}` : `${(hunter.emails || []).length} address(es), no pattern`) : 'nothing', cached: !!(hunter && hunter.cached) });
  }
  if (hunter) {
    // Hunter listed this person.
    for (const h of (hunter.emails || [])) {
      if (!h || !h.email || h.type === 'generic') continue;
      const hn = [h.firstName, h.lastName].filter(Boolean).join(' ');
      if (hn && sameNameLoose(hn, ctx.name)) {
        const hit = await attempt(h.email, 'listed by Hunter for them', { kind: 'hunter', built: false, stated: true, sourceUrl: h.sourceUrl });
        if (hit) return done(hit);
      }
    }
    const hp = EP.patternFromHunter(hunter);
    if (hp) addConfirmed(hp.pattern, hp.from === 'hunter' ? 'hunter' : 'inferred', hp.example, hp.exampleSourceUrl);
  }
  for (const c of confirmed) {
    const built = EP.construct(c.pattern, n, domain);
    if (!built) continue;
    const hit = await attempt(built, `built from the domain's pattern (${c.pattern})`, { kind: 'pattern', built: true, confirmed: true, pattern: c.pattern, from: c.from, sourceUrl: c.sourceUrl });
    if (hit) return done(hit);
  }
  for (const s of shapes) {
    const built = EP.construct(s, n, domain);
    if (!built) continue;
    const hit = await attempt(built, `built from the shape of an address at the domain (${s})`, { kind: 'pattern', built: true, confirmed: false, pattern: s, from: 'shape' });
    if (hit) return done(hit);
  }
  // A catch-all domain accepts every guess, so no further guess can be told
  // apart from a real mailbox. Stop rather than spend checks proving nothing.
  if (catchAll) return res({ stop: 'catch-all domain, and no confirmed pattern built a passing address', catchAll });
  if (notRun) return res({ stop: 'verification could not run', notRun });

  // ── 2. HUNTER EMAIL FINDER, THEN THE COMMON FORMATS ────────────────────
  if (n.last && typeof deps.emailFinder === 'function') {
    const f = await deps.emailFinder(n.first, n.last, domain);
    if (f && !f.cached && !f.fault && !f.budget) credits.search++;
    steps.push({ how: 'Hunter Email Finder', ok: !!(f && f.email), why: f && f.email ? `${f.email}${f.score != null ? ' score ' + f.score : ''}` : ((f && (f.why || (f.fault && f.fault.reason))) || 'no address'), cached: !!(f && f.cached) });
    if (f && f.email) {
      const matches = confirmed.find((c) => EP.construct(c.pattern, n, domain) === lc(f.email));
      const hit = await attempt(f.email, 'Hunter Email Finder', { kind: 'hunter', built: true, confirmed: !!matches,
        pattern: matches ? matches.pattern : null, from: matches ? matches.from : 'hunter-finder', stated: (f.sources || 0) > 0, sourceUrl: f.sourceUrl });
      if (hit) return done(hit);
      if (catchAll) return res({ stop: 'catch-all domain', catchAll });
    }
  }
  // Cheapest first: an address already verified costs nothing to look at.
  const formats = COMMON_FORMATS.map((p) => ({ p, e: EP.construct(p, n, domain) })).filter((x) => x.e && !tried.has(x.e));
  let cachedSet = new Set();
  if (typeof deps.peek === 'function') {
    try { const m = await deps.peek(formats.map((x) => x.e)); cachedSet = new Set([...m.keys()]); } catch (_) { /* order stays */ }
  }
  formats.sort((a, b) => (cachedSet.has(b.e) ? 1 : 0) - (cachedSet.has(a.e) ? 1 : 0));
  for (const x of formats) {
    const hit = await attempt(x.e, `common format (${x.p})`, { kind: 'pattern', built: true, confirmed: false, pattern: x.p, from: 'common-format' });
    if (hit) return done(hit);
    if (catchAll) return res({ stop: 'catch-all domain: a guessed format cannot be confirmed', catchAll });
    if (notRun) return res({ stop: 'verification could not run', notRun });
  }
  return res({ stop: 'no format verified', catchAll });
}

// First and last name agree, loosely: "Tom Smith" and "Thomas Smith" are not
// assumed to be one person, but "Tom Smith" and "tom smith (owner)" are.
function sameNameLoose(a, b) {
  const x = EP.splitName(a), y = EP.splitName(b);
  if (!x || !y) return false;
  if (x.last && y.last) return x.first === y.first && x.last === y.last;
  return x.first === y.first && !x.last && !y.last;
}

// ── NO WEBSITE (5) ──────────────────────────────────────────────────────────
// place: the Google Places record the night already looked up.
// resolve: domainResolve.resolveDomain-shaped. checkDomain: the domain gate.
// -> { website, via, strict, why }
function _nameKey(s) {
  return lc(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/\b(the|llc|inc|co|company)\b/g, ' ').replace(/[^a-z0-9]/g, '');
}
function placeIsThisBusiness(brand, place) {
  if (!place || !place.name) return false;
  const a = _nameKey(brand), b = _nameKey(place.name);
  return !!a && !!b && (a === b || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b)));
}
async function findWebsite({ brand, region, place }, deps) {
  const checkDomain = deps.checkDomain;
  const tried = [];
  const placesSite = place && place.website ? place.website : null;
  if (placesSite) {
    const v = checkDomain(brand, placesSite);
    if (v.ok) return { website: placesSite, via: 'the Places record', strict: false, tried };
    tried.push({ url: placesSite, from: 'places', code: v.code });
  }
  let r = null;
  if (typeof deps.resolveDomain === 'function') {
    try { r = await deps.resolveDomain(brand, { city: region, address: (place && (place.address || place.formattedAddress)) || null }); } catch (_) { r = null; }
    if (r && r.website) return { website: r.website, via: 'a web search for the domain', strict: false, searched: !r.cached, tried };
    for (const t of ((r && r.tried) || [])) tried.push({ url: t.url, from: 'search', code: t.code });
  }
  // TWO SOURCES AGREE. Google's own record for this business and the search
  // both point at the same domain: confirmed, though the name is not in it.
  if (placesSite && r && Array.isArray(r.tried)) {
    const pr = rootOf(placesSite);
    const hit = r.tried.find((t) => t && t.url && rootOf(t.url) === pr);
    if (pr && hit) return { website: placesSite, via: 'the Places record, and the web search found the same domain', strict: false, tried };
  }
  // THE PLACES RECORD IS THIS BUSINESS. Its own website, when the record's
  // name is the business's name, even though the domain does not spell it.
  // Weaker than the gate, so only a VALID mailbox is ever used on it.
  if (placesSite && placeIsThisBusiness(brand, place)) {
    const v = checkDomain(brand, placesSite);
    if (v.code !== 'third-party-host' && v.code !== 'no-domain') {
      return { website: placesSite, via: `the Places record for "${place.name}" (domain not confirmed by name)`, strict: true, tried };
    }
  }
  return { website: null, via: null, strict: false, tried, why: placesSite ? 'the Places website is not this business\'s own and the search found none' : 'no website on the Places record and the search found none' };
}

// ── THE NIGHT'S FINISHING STEP ──────────────────────────────────────────────
// Runs on a chosen business, after the ladder, the bar and the name. Mutates
// the ladder: the address that passes goes on the greeted person's row,
// marked verified; an address that fails is marked so it is never offered.
//   args: { ladder, out, ig, brand, region, place, Q }
//   deps: verify, peek, domainSearch, emailFinder, resolveDomain, checkDomain,
//         siteEmail(website) -> findSiteEmail result, corporate(domain, brand)
// -> record for the run row: { before, after, verify, website, finder, credits }
async function finishLadder(args, deps) {
  const { ladder, out, ig, brand, region, place } = args;
  const Q = args.Q || require('./outreachQueue');
  const credits = { search: 0, verify: 0, webSearch: 0 };
  const rec = { before: Q.channelFor(ladder, ig), after: null, verify: null, website: null, finder: null, credits };
  const person = Q.greetRowOf(ladder);

  // ── 4. THE ADDRESS THE CARD WOULD USE, VERIFIED ────────────────────────
  const inbox = Q.inboxOf(ladder);
  if (inbox) {
    const row = rowWith(ladder, inbox.email);
    const v = await deps.verify(inbox.email);
    if (v && !v.cached && !v.notRun) credits.verify++;
    const verdict = verdictOf(v);
    const ep = row && row.emailPattern;
    const p = passes({ verdict, built: !!(row && row.emailKind === 'pattern'),
      patternConfirmed: !!(ep && (ep.from === 'hunter' || ep.from === 'inferred')),
      realName: !!(row && realNameOf(row.name)), stated: !!(row && TRUSTED_KINDS.has(row.emailKind || 'published')), strictDomain: false });
    if (row) row.emailVerify = { verdict, status: (v && v.status) || null, pass: p.ok, why: p.why || null, catchAll: !!p.catchAll };
    rec.verify = { email: inbox.email, kind: inbox.kind, verdict, pass: p.ok, why: p.why || null, heldStated: !!p.heldStated, cached: !!(v && v.cached) };
    if (p.ok) { rec.after = Q.channelFor(ladder, ig); return rec; }
    // Hunter is down or the month's checks are spent: nothing can pass, so
    // nothing more is spent looking.
    if (verdict === 'not-run') { rec.finder = { stop: 'verification could not run' }; rec.after = Q.channelFor(ladder, ig); return rec; }
  }
  if (!person) { rec.finder = { stop: 'nobody named to find an address for' }; rec.after = Q.channelFor(ladder, ig); return rec; }

  // ── THE DOMAIN ─────────────────────────────────────────────────────────
  let domain = (ladder && ladder.businessDomain) || (out && out.website ? rootOf(out.website) : null);
  let strict = false;
  let siteOut = out;
  if (!domain && typeof deps.checkDomain === 'function') {
    const w = await findWebsite({ brand, region, place }, deps);
    if (w.searched) credits.webSearch++;
    rec.website = { website: w.website, via: w.via, strict: w.strict, why: w.why || null };
    if (w.website) {
      domain = rootOf(w.website);
      strict = !!w.strict;
      // The site was never read: read it now (free, cached by domain).
      if (typeof deps.siteEmail === 'function') {
        try { const se = await deps.siteEmail(w.website); if (se) siteOut = { ...(out || {}), siteEmail: se }; } catch (_) { /* no site read */ }
      }
    }
  }
  // ── 3. A ROLE ADDRESS NAMES THE DOMAIN ─────────────────────────────────
  let roleOnly = false;
  if (!domain) {
    for (const t of ((ladder && ladder.tiers) || [])) {
      for (const r of (t.rows || [])) {
        if (!r || !r.email || ET.isFreeMail(r.email)) continue;
        const d = rootOf(domainOf(r.email));
        if (d && typeof deps.checkDomain === 'function' && deps.checkDomain(brand, 'https://' + d).ok) { domain = d; break; }
      }
      if (domain) break;
    }
  }
  if (domain) {
    const all = ((ladder && ladder.tiers) || []).flatMap((t) => t.rows || []).filter((r) => r && r.email && sameDomain(r.email, domain));
    roleOnly = all.length > 0 && all.every((r) => isDesk(r.email));
  }
  if (!domain) { rec.finder = { stop: rec.website ? 'no website found' : 'no domain' }; rec.after = Q.channelFor(ladder, ig); return rec; }
  if (typeof deps.corporate === 'function') {
    const corp = deps.corporate(domain, brand, siteOut);
    if (corp) { rec.finder = { stop: corp, domain }; rec.after = Q.channelFor(ladder, ig); return rec; }
  }

  // ── 1 AND 2 ────────────────────────────────────────────────────────────
  const examples = examplesOf(ladder, siteOut, domain, null);
  const r = await find({ name: person.name, domain, examples, strictDomain: strict, roleOnly,
    skip: rec.verify && !rec.verify.pass ? [rec.verify.email] : [] }, deps);
  credits.search += r.credits.search;
  credits.verify += r.credits.verify;
  rec.finder = { domain, roleOnly, examples: examples.length, email: r.email || null, how: r.how || null, verdict: r.verdict || null,
    kind: r.kind || null, pattern: r.pattern || null, patternFrom: r.patternFrom || null, catchAll: !!r.catchAll,
    catchAllPass: !!r.catchAllPass, stop: r.stop || null, heldStated: r.steps.some((s) => s.heldStated),
    steps: r.steps.map((s) => `${s.how}: ${s.email || ''}${s.verdict ? ' ' + s.verdict : ''}${s.ok ? ' OK' : (s.why ? ' (' + s.why + ')' : '')}`).slice(0, 10) };
  if (r.email) {
    const was = { email: person.email || null, emailKind: person.emailKind || null, emailPattern: person.emailPattern || null,
      emailVerify: person.emailVerify || null, emailCheck: person.emailCheck || null, emailSourceUrl: person.emailSourceUrl };
    if (person.email && lc(person.email) !== r.email) person.emailRejected = { email: person.email, verdict: person.emailVerify ? person.emailVerify.verdict : null };
    person.email = r.email;
    person.emailKind = r.kind === 'pattern' ? 'pattern' : (r.kind || 'hunter');
    person.emailPattern = r.pattern ? { pattern: r.pattern, from: r.patternFrom, example: null } : null;
    person.emailSourceUrl = r.sourceUrl || null;
    person.emailVerify = { verdict: r.verdict, pass: true, catchAll: !!r.catchAllPass, how: r.how };
    person.emailCheck = { ok: true, reason: r.verdict === 'valid' ? 'the verifier confirmed the mailbox' : 'catch-all domain, built from its confirmed pattern', source: 'hunter' };
    delete person.emailTier;
    ET.annotateLadder(ladder);
    // THE GREETING MUST SURVIVE. A person greetable only through a published
    // address would lose that standing to a built one; undo rather than end
    // up with an email card nobody can be greeted on.
    if (Q.greetRowOf(ladder) !== person) {
      Object.assign(person, was);
      delete person.emailTier;
      ET.annotateLadder(ladder);
      rec.finder.email = null;
      rec.finder.stop = 'the found address would cost the person their greeting, so it was not used';
    }
  }
  rec.after = Q.channelFor(ladder, ig);
  return rec;
}

function rowWith(ladder, email) {
  const e = lc(email);
  for (const t of ((ladder && ladder.tiers) || [])) for (const r of (t.rows || [])) if (r && lc(r.email) === e) return r;
  return null;
}

// ── THE REAL DEPENDENCIES ───────────────────────────────────────────────────
// Verification goes through emailVerify (90-day verdict cache) with Hunter as
// the verifier. Every credit is logged to email_verify_credit_log, tagged with
// the agent, the athlete, the business and `source` ('nightly', 'finder-dryrun'),
// and checked against the month's verification pool -- never against the
// per-athlete daily budget, which is Home's.
function liveDeps(pool, { agentId = null, athleteId = null, business = null, source = 'nightly', day = null } = {}) {
  const EV = require('./emailVerify');
  const H = require('./hunterLookup');
  const VB = require('./verifyBudget');
  const today = day || new Date().toISOString().slice(0, 10);
  const verifier = async (email) => {
    const wrote = await VB.record(pool, { agentId, athleteId, business, email, day: today, source });
    if (!wrote) return { ok: false, why: 'the verification credit log is not writable, so nothing is being spent' };
    return H.verifyEmail(email);
  };
  return {
    verify: async (email) => {
      const m = await EV.verifyMany(pool, [email], { verifier, concurrency: 1 });
      return m.get(EV.norm(email)) || null;
    },
    peek: (emails) => EV.cached(pool, emails),
    domainSearch: async (domain) => {
      const h = await H.findDomainEmails(domain, { withPattern: true });
      return h && !h.fault ? h : null;
    },
    emailFinder: (first, last, domain) => H.findEmail(first, last, domain),
    resolveDomain: async (brand, opts) => {
      const ai = require('../ai');
      return require('./domainResolve').resolveDomain(brand, { ...opts, webSearch: ai.webSearchJson, refreshNoneAfterDays: 7 });
    },
    checkDomain: (brand, url) => require('./domainGate').checkDomain(brand, url),
    siteEmail: (website) => require('./siteEmail').findSiteEmail(website, { brand: business }),
    corporate: (domain, brand, out) => corporateDomain(domain, brand, out),
  };
}

// A national brand's corporate domain is never where a local owner is reached.
function corporateDomain(domain, brand, out) {
  if (out && out.siteEmail && out.siteEmail.corporate) return `${domain} is a corporate site (${out.siteEmail.corporateVia || 'franchise'})`;
  try { const hit = require('./campusQuality').chainDomain(domain); if (hit) return `${domain} is ${hit}'s corporate domain`; } catch (_) { /* no list */ }
  // A chain or franchise location whose domain carries the chain's own name
  // (dominos.com for Domino's): the parent company's, not the local owner's.
  try {
    const NC = require('./nationalChains');
    const squash = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sld = squash(String(rootOf(domain) || '').split('.')[0]);
    const hit = (NC.isChainLocation && NC.isChainLocation(brand || ''))
      || (NC.NATIONAL_CHAINS || []).find((c) => String(brand || '').toLowerCase().includes(String(c).toLowerCase()));
    if (hit && squash(hit).length >= 4 && sld.includes(squash(hit))) return `${brand} is a chain location and ${domain} is the chain's corporate domain`;
  } catch (_) { /* no list */ }
  return null;
}

module.exports = {
  find, finishLadder, findWebsite, liveDeps, passes, verdictOf, examplesOf, shapeOf, isNever, isDesk,
  corporateDomain, placeIsThisBusiness, sameNameLoose, COMMON_FORMATS, MAX_VERIFIES, NEVER_LOCAL,
};
