'use strict';
// ── A NAME AND A WAY TO REACH THEM, FOR EVERY BUSINESS IN TOWN ──────────────
//
// "Rather than me trying to figure out who's the owner of Wava Grill down the
// street, being able to just pull that information." The pool is the town; this
// makes it a call list. Platform-wide we had an owner for 40% of businesses,
// and that number is the difference between a product and an empty table.
//
// One business, the same ladder the agent side runs -- not a second one:
//   1. ai.getBrandContacts: Places (website, phone), the site scrape, Hunter,
//      the person-email search, Instagram (bio, owner, DM handle), and the
//      web-search sources (chamber, site, Facebook About, Google reviews
//      replies, LinkedIn, registry, news).
//   2. ownerNameSearch.findOwnerName: a plain owner / marketing-director web
//      search, when the ladder found no named person.
//   3. One search for athlete or NIL sponsorship history (cited, or nothing).
// A public Instagram handle counts as a way to reach: a business is never
// discarded for lacking an email when there is a DM path.
//
// REACHABLE = a named human AND (email OR phone OR Instagram handle).
// A failure on our side (services/ourFault) is status 'error' and retried; it
// is never written down as "unreachable".
//
// Long-running (a thousand businesses), so it runs inside the server as a
// background job, resumable: rows are 'pending' until resolved, and a restart
// picks up where it stopped.
const CAMPUS_CONCURRENCY = parseInt(process.env.CAMPUS_CONTACTS_CONCURRENCY, 10) || 4;
const MAX_ATTEMPTS = 3;

// ── WHICH OF THE TEAMS A BUSINESS PLAUSIBLY FITS, AND WHY ───────────────────
// Deterministic, no model call. Every team gets the general local-sponsor
// fit; a sport-specific business adds weight to its sport.
const SPORT_WORDS = {
  basketball: /basketball|hoops|\bcourt\b|sneaker|shoe|foot locker|athletic/i,
  soccer: /soccer|futbol|football club|\bfc\b|cleats/i,
  'water polo': /swim|aquatic|pool|water polo|surf|beach/i,
  swimming: /swim|aquatic|pool|surf|beach|spa\b|physical therapy|physio/i,
  baseball: /baseball|batting|cage|little league|diamond|dugout/i,
  softball: /softball|batting|cage|diamond|dugout/i,
  volleyball: /volleyball|\bcourt\b|athletic/i,
  'beach volleyball': /beach|volleyball|surf|sand|sunscreen|smoothie|juice/i,
  tennis: /tennis|racquet|racket|pickleball|country club/i,
  'flag football': /football|flag football|\bnfl\b|cleats|turf/i,
  golf: /golf|country club|driving range|putt|caddie|pro shop/i,
};
const EVERY_TEAM = /gym|fitness|training|sports|athletic|physical therapy|chiropract|orthopedic|nutrition|smoothie|juice|sporting goods|dick'?s|big 5|uniform|screen print|embroider|trophy/i;
const CATEGORY_ALL = { gym: 18, health: 16, wellness: 14, restaurant: 10, food: 10, coffee: 8, bank: 10, dealership: 10, insurance: 8,
  apparel: 10, retail: 6, auto: 8, education: 6, entertainment: 6, realestate: 6, services: 4, salon: 4, medspa: 4, pet: 3 };
function teamFit(business, teams) {
  const text = `${business.brand || ''} ${(business.types || []).join(' ')} ${business.primary_type_label || ''} ${business.category || ''}`;
  const base = CATEGORY_ALL[business.category] || 3;
  const everyone = EVERY_TEAM.test(text);
  const d = Number(business.distance_m);
  const near = Number.isFinite(d) ? (d <= 3000 ? 8 : d <= 8000 ? 4 : 0) : 0;
  const out = [];
  for (const t of teams) {
    const why = [];
    let score = base + near;
    if (base >= 10) why.push(`${business.category} businesses back local teams`);
    if (near) why.push(`${(d / 1609.34).toFixed(1)} mi from campus`);
    if (everyone) { score += 12; why.push('sports or fitness business'); }
    const re = SPORT_WORDS[String(t.sport || '').toLowerCase()];
    if (re && re.test(text)) { score += 25; why.unshift(`a ${t.sport} business`); }
    out.push({ team_id: t.id, team: t.name, score, why: why.slice(0, 3).join('; ') || 'local business near campus' });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── ONE BUSINESS ────────────────────────────────────────────────────────────
function pickPerson(res) {
  const ONS = require('./ownerNameSearch');
  const QC = require('./campusQuality');
  // Never a sponsored athlete, a spokesperson or a creative as "the decision
  // maker" (Daniel Suarez at Freeway Insurance, a videographer at a cafe).
  const people = (res && res.contacts || []).filter((c) => c && c.name && ONS.looksLikePerson(c.name) && c.affiliationScope !== 'corporate'
    && !QC.refusedName(c.name) && !QC.refusedTitle(c.title));
  const rank = (c) => (c.email ? 4 : 0) + (c.phone ? 2 : 0) + (/owner|founder|president|ceo|general manager|gm\b|marketing/i.test(c.title || '') ? 1 : 0)
    + (c.confidence === 'high' ? 1 : 0);
  return people.sort((a, b) => rank(b) - rank(a))[0] || null;
}

// ── FREE FIRST, PAID LAST ───────────────────────────────────────────────────
// Every lookup used to open with the paid contact ladder ($0.10 to $0.24),
// including for businesses whose website we already had and never opened:
// Cypress had 46 named people without an email, 30 of them with a website on
// file. Now, in order, stopping as soon as there is a named person and a way
// to reach them:
//   1. Google Places details (by place id, cached a month): the website, the phone
//   2. the business website (siteEmail: homepage plus up to two contact/about/
//      team pages it links to, mailto: links and the footer; plain HTTP, free,
//      cached by domain): a named person's address first, info@ over nothing,
//      and the owners named on the site
//   3. the Instagram handle linked from that website (instagramLookup, scrape
//      only: free)
//   4. the owner by name, from search including the state business filing
//      (ownerNameSearch: one or two web searches) -- only when 1 to 3 found
//      a way to reach them but no person
//   5. the paid contact ladder -- only when there is still no person or no way
//      to reach them
// deps (tests): { places: { lookupPlaceById }, site: { findSiteEmail }, ig: { findInstagram } }
async function freeContact(row, ctx = {}) {
  const deps = ctx.deps || {};
  const out = { website: row.website || null, phone: row.phone || null, email: null, genericEmail: null, instagram: row.instagram || null,
    person: null, people: [], steps: [], placesCalls: 0 };
  // 1. Places details: the website and the phone, if we do not hold them.
  if ((!out.website || !out.phone) && row.place_id) {
    try {
      const P = deps.places || require('./placesLookup');
      const d = await P.lookupPlaceById(row.place_id);
      out.placesCalls++;
      if (d) { out.website = out.website || d.website || null; out.phone = out.phone || d.phone || null; }
      out.steps.push(`places details: ${d ? `${d.website ? 'website' : 'no website'}, ${d.phone ? 'phone' : 'no phone'}` : 'nothing'}`);
    } catch (e) { out.steps.push('places details failed: ' + e.message); }
  }
  // 2. The website.
  if (out.website) {
    try {
      const SE = deps.site || require('./siteEmail');
      const r = await SE.findSiteEmail(out.website, { brand: row.brand });
      if (r && !r.corporate) {
        out.email = r.personalEmail || null;
        out.genericEmail = r.roleEmail || null;
        out.people = Array.isArray(r.people) ? r.people : [];
        out.siteOutcome = r.outcomeKind || null;
      }
      out.steps.push(`website: ${r ? (r.personalEmail ? 'a person\'s address' : r.roleEmail ? 'a shared inbox' : (r.outcomeKind || 'nothing')) : 'not read'}`);
    } catch (e) { out.steps.push('website failed: ' + e.message); }
    // 3. The Instagram handle the website links to (never searched for here).
    if (!out.instagram) {
      try {
        const IG = deps.ig || require('./instagramLookup');
        const h = await IG.findInstagram(out.website, { brand: row.brand, loc: ctx.city });
        if (h && h.handle && h.scope !== 'brand') out.instagram = String(h.handle).replace(/^@/, '');
        if (h && h.bookingEmail && !out.email && !out.genericEmail) out.genericEmail = h.bookingEmail;
        out.steps.push(`instagram: ${out.instagram ? '@' + out.instagram : 'none linked'}`);
      } catch (e) { out.steps.push('instagram failed: ' + e.message); }
    }
  }
  // The person: one already on file, or an owner the website names.
  const QC = require('./campusQuality');
  if (row.contact_name && !QC.refusedName(row.contact_name)) out.person = { name: row.contact_name, title: row.contact_title || null, source: 'on file' };
  if (!out.person) {
    const ONS = require('./ownerNameSearch');
    const p = out.people.find((x) => x && x.name && ONS.looksLikePerson(x.name) && !QC.refusedName(x.name) && !QC.refusedTitle(x.title));
    if (p) out.person = { name: p.name, title: p.title || null, source: 'website', sourceUrl: p.sourceUrl || null };
  }
  out.reach = !!(out.email || out.genericEmail || out.phone || out.instagram);
  return out;
}

async function resolveOne(row, ctx) {
  const ai = ctx.ai || require('../ai');
  const ONS = require('./ownerNameSearch');
  const city = ctx.city;
  const sources = [];
  // 1 to 3: free.
  const free = ctx.free === false ? null : await freeContact(row, ctx).catch((e) => ({ steps: ['free steps failed: ' + e.message], placesCalls: 0 }));
  const freeDone = (f) => f && f.person && f.reach;
  const shape = (f, extra = {}) => {
    const QCq = require('./campusQuality');
    const email = f.email && !QCq.isGenericInbox(f.email) ? f.email : null;
    const generic = f.genericEmail || (f.email && QCq.isGenericInbox(f.email) ? f.email : null);
    return { contact_name: f.person ? f.person.name : null, contact_title: f.person ? f.person.title || null : null,
      email, email_source: email ? (f.emailSource || 'website') : null, phone: f.phone || null, instagram: f.instagram || null, website: f.website || null,
      facebook: null, linkedin: null, sources: [f.person && f.person.source, email || generic ? 'website' : null, f.instagram ? 'instagram' : null].filter(Boolean),
      athlete_history: null, athlete_history_note: null, generic_email: generic, free: true, steps: f.steps, placesCalls: f.placesCalls || 0,
      // A named person AND a way to reach them: their address, a shared inbox
      // (a send path, though not their address), a phone or an Instagram DM.
      reachable: !!(f.person && f.person.name && (email || generic || f.phone || f.instagram)), ...extra };
  };
  if (freeDone(free)) return shape(free);
  // FREE ONLY (the night, services/ownerLookup): what the free steps found and
  // nothing bought. The owner search and the ladder run when a person on the
  // department's staff asks for this business ("Find the owner").
  if (ctx.free === 'only') return shape(free || { steps: [], placesCalls: 0 }, { freeOnly: true });
  // 4. A way to reach them but no person: the owner by name (search, state filings).
  if (free && free.reach && !free.person) {
    try {
      const found = await ONS.findOwnerName({ brand: row.brand, city, search: ai.webSearchJson });
      if (found && found.name) { free.person = { name: found.name, title: found.title || null, source: 'owner-search' }; return shape(free, { paidStep: 'owner search' }); }
    } catch (_) { /* on to the ladder */ }
  }
  // 5. Paid: the contact ladder.
  let res = null;
  try {
    res = await ai.getBrandContacts(row.brand, (free && free.website) || null, city, ai.deepContactCtx({ market: 'school' }));
  } catch (e) {
    return { error: 'contact ladder: ' + e.message, fault: true };
  }
  if (res && res.outcome === 'ERROR') return { error: 'contact ladder failed on our side', fault: true };
  let person = pickPerson(res);
  if (person) sources.push(person.source || 'ladder');
  if (!person) {
    try {
      const found = await ONS.findOwnerName({ brand: row.brand, city, search: ai.webSearchJson });
      if (found && found.name) { person = { name: found.name, title: found.title || null, sourceUrl: found.sourceUrl || null }; sources.push('owner-search'); }
    } catch (e) {
      if (!(res && (res.businessPhone || res.instagram))) return { error: 'owner search: ' + e.message, fault: true };
    }
  }
  const ladder = (res && res.addressLadder) || {};
  const anyEmail = (person && person.email) || (ladder.email && (ladder.kind === 'person' || ladder.kind === 'personal' || ladder.kind === 'role') ? ladder.email : null)
    || (res && res.personalInbox) || (res && res.genericInbox) || null;
  // A SHARED INBOX IS NOT THE PERSON (campusQuality.isGenericInbox): kept
  // apart as generic_email, never shown beside their name, never "reachable".
  const QCq = require('./campusQuality');
  const email = (free && free.email && !QCq.isGenericInbox(free.email) ? free.email : null) || (anyEmail && !QCq.isGenericInbox(anyEmail) ? anyEmail : null);
  const genericEmail = (anyEmail && QCq.isGenericInbox(anyEmail) ? anyEmail : null) || (free && free.genericEmail) || null;
  const emailSource = person && person.email ? (person.emailSource || person.source || 'ladder') : email ? (ladder.label || 'inbox') : null;
  // What the free steps found stands; the ladder fills what they did not.
  if (!person && free && free.person) person = free.person;
  const phone = (person && person.phone) || (res && res.businessPhone) || (free && free.phone) || null;
  const instagram = res && res.instagram ? String(res.instagram).replace(/^@/, '') : (free && free.instagram) || null;
  const all = (res && res.contacts) || [];
  const urlLike = (re) => (all.map((c) => [c.sourceUrl, c.linkedinUrl]).flat().find((u) => u && re.test(u))) || null;
  // ── ATHLETE OR NIL HISTORY: cited, or nothing ─────────────────────────────
  let history = null, historyNote = null;
  if (ctx.history !== false) {
    try {
      const h = await ai.webSearchJson(`Search for: has "${row.brand}" in ${city} sponsored local athletes, college or high school sports teams, or signed NIL deals?\n`
        + 'Answer ONLY JSON: {"history": true|false, "note": "one sentence naming the team or athlete, or empty", "url": "the source page or empty"}. '
        + 'true only if a source you found says so about THIS business.',
        'You check whether a local business has sponsored athletes or school sports. Answer only with the JSON asked for.');
      const j = JSON.parse(String((h && h.text) || '').replace(/^[^{]*/, '').replace(/[^}]*$/, '') || '{}');
      const cited = j.url && (h.citations || []).some((c) => String(c).includes(String(j.url).replace(/^https?:\/\//, '').split('/')[0]));
      history = j.history === true && cited ? true : false;
      historyNote = history ? String(j.note || '').slice(0, 240) || null : null;
    } catch (_) { history = null; }
  }
  return {
    contact_name: person ? person.name : null, contact_title: person ? person.title || null : null,
    email, email_source: emailSource, phone, instagram, website: (res && (res.website || res.websiteResolved)) || (free && free.website) || null,
    facebook: urlLike(/facebook\.com/i), linkedin: (person && person.linkedinUrl) || urlLike(/linkedin\.com/i),
    sources: sources.concat(all.map((c) => c.source).filter(Boolean)).filter((v, i, a) => a.indexOf(v) === i),
    athlete_history: history, athlete_history_note: historyNote, generic_email: genericEmail,
    // A named person AND a way to reach them: their address, a shared inbox
    // (a send path, though not their address), a phone, or an Instagram DM.
    reachable: !!(person && person.name && (email || genericEmail || phone || instagram)),
    free: false, steps: (free && free.steps) || [], placesCalls: (free && free.placesCalls) || 0, paidStep: 'contact ladder',
  };
}

// ── WHAT A RUN WILL COST, BEFORE IT RUNS ────────────────────────────────────
// Modelled from the calls resolveOne makes, priced the way the run's own meter
// prices them (outreachQueue.priceOf), so the estimate and the report's actual
// are in the same units:
//   Places details  1 call (lookupPlace, cached a month)
//   the ladder      3 to 8 source calls (deepContactCtx: 8 sources, waves of
//                   3, stops at a decision maker), about 2 web searches each
//   owner search    only when the ladder named no one: 1 call, up to 2 searches
//   history search  1 call, about 2 searches (history=0 skips it)
// The meter does not price search-result input tokens. On the Anthropic path
// that is about 6,000 Haiku input tokens a search ($0.006), reported apart.
const PER_BIZ = {
  low: { places: 1, calls: 3, searches: 6, owner: 0 },
  high: { places: 1, calls: 8, searches: 16, owner: 1 },
};
const INPUT_TOKENS_USD_PER_SEARCH = 0.006;
function perBusinessUsd(which, history) {
  const Q = require('./outreachQueue');
  const m = PER_BIZ[which];
  const calls = m.calls + m.owner + (history ? 1 : 0);
  const searches = m.searches + m.owner * 2 + (history ? 2 : 0);
  return { metered: Q.priceOf({ placesCalls: m.places, aiCalls: calls, webSearches: searches }),
    tokens: Math.round(searches * INPUT_TOKENS_USD_PER_SEARCH * 10000) / 10000, searches };
}

async function estimate(pool, universityId, opts = {}) {
  const CP = require('./campusPool');
  await CP.ensureTables(pool);
  const u = await CP.universityOf(pool, universityId);
  if (!u) return { ok: false, error: `no university "${universityId}"` };
  const history = opts.history !== false;
  const n = (await pool.query(
    `SELECT COUNT(*)::int n FROM university_market_seen m
      WHERE m.market_key = $2 AND m.blocked_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM university_contacts c WHERE c.university_id = $1 AND c.brand = m.brand
                          AND (c.status IN ('reachable','unreachable') OR (c.status = 'error' AND c.attempts >= $3)))`,
    [universityId, u.marketKey, MAX_ATTEMPTS])).rows[0].n;
  const businesses = opts.limit ? Math.min(n, Number(opts.limit)) : n;
  const lo = perBusinessUsd('low', history), hi = perBusinessUsd('high', history);
  const r2 = (x) => Math.round(x * 100) / 100;
  let hunter = null;
  try { hunter = await require('./hunterLookup').budgetStatus(); } catch (_) { hunter = null; }
  let routing = null;
  try { routing = require('./deepseek').describeRouting(); } catch (_) { routing = null; }
  return { ok: true, dryRun: true, university: u.name, businesses, history,
    perBusiness: { meteredUsd: [lo.metered, hi.metered], withInputTokensUsd: [r2(lo.metered + lo.tokens), r2(hi.metered + hi.tokens)], webSearches: [lo.searches, hi.searches] },
    totalUsd: { metered: [r2(businesses * lo.metered), r2(businesses * hi.metered)],
      withInputTokens: [r2(businesses * (lo.metered + lo.tokens)), r2(businesses * (hi.metered + hi.tokens))] },
    hunter: hunter && { creditsUsedThisMonth: hunter.used, monthlyBudget: hunter.budget, remaining: hunter.remaining,
      note: "Hunter runs last, only where the site and the ladder found no address: up to 1 credit a business, from the same monthly budget the agents' nightly uses" },
    routing,
    note: 'pass budget=<usd> on the real run to cap it; it stops there and the rest stay pending' };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────
const _running = new Map();   // universityId -> promise, one run per university per process

async function seedRows(pool, u) {
  const teams = (await pool.query(`SELECT id, name, sport FROM university_teams WHERE university_id = $1`, [u.id])).rows;
  const rows = (await pool.query(
    `SELECT m.brand, m.place_id, m.category, m.types, m.distance_m, m.primary_type_label FROM university_market_seen m
      WHERE m.market_key = $1 AND m.blocked_reason IS NULL`, [u.marketKey])).rows;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO university_contacts (university_id, market_key, brand, place_id, team_fit) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (university_id, brand) DO UPDATE SET team_fit = EXCLUDED.team_fit, place_id = COALESCE(university_contacts.place_id, EXCLUDED.place_id)`,
      [u.id, u.marketKey, r.brand, r.place_id, JSON.stringify(teamFit(r, teams))]);
  }
  return rows.length;
}

// ONE BUSINESS: the full ladder, stored on its university_contacts row (made
// if missing). Used by the bulk run and by the team night, which resolves only
// the businesses it has already picked as worth pitching.
// -> { reachable, costUsd, error, out }
async function resolveAndStore(pool, universityId, row, opts = {}) {
  await require('./campusQuality').ensureColumns(pool);
  const scanMeter = require('../scanMeter');
  const Q = require('./outreachQueue');
  // The row exists for a business the bulk run seeded; the team night may
  // pick one that was never seeded, and makes its row here.
  if (opts.marketKey) {
    await pool.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, team_fit)
                      VALUES ($1,$2,$3,$4,COALESCE($5::jsonb,'[]'::jsonb)) ON CONFLICT (university_id, brand) DO NOTHING`,
      [universityId, opts.marketKey, row.brand, row.place_id || null, opts.teamFit ? JSON.stringify(opts.teamFit) : null]);
  }
  // What is already on file goes to the free steps first (resolveOne).
  const onFile = (await pool.query(`SELECT website, phone, instagram, contact_name, contact_title, place_id FROM university_contacts WHERE university_id = $1 AND brand = $2`,
    [universityId, row.brand]).catch(() => ({ rows: [] }))).rows[0] || {};
  const full = { ...row, place_id: row.place_id || onFile.place_id || null, website: row.website || onFile.website || null, phone: row.phone || onFile.phone || null,
    instagram: row.instagram || onFile.instagram || null, contact_name: row.contact_name || onFile.contact_name || null, contact_title: row.contact_title || onFile.contact_title || null };
  let out, meter;
  try {
    ({ result: out, meter } = await scanMeter.run(() => scanMeter.label({ site: 'campus.contacts', brand: row.brand },
      () => resolveOne(full, { city: opts.city, ai: opts.ai, history: opts.history, deps: opts.deps, free: opts.free }))));
  } catch (e) { out = { error: e.message, fault: true }; meter = null; }
  // Places details (step 1) is a Places request the meter does not see: counted
  // at list price, though a cached answer costs nothing.
  const c = (meter ? Q.priceOf(meter) : 0) + ((out && out.placesCalls) || 0) * Q.USD_PER_PLACES_REQUEST;
  if (out.error) {
    await pool.query(`UPDATE university_contacts SET status = 'error', last_error = $3, attempts = attempts + 1, cost_usd = cost_usd + $4, updated_at = NOW()
                       WHERE university_id = $1 AND brand = $2`, [universityId, row.brand, String(out.error).slice(0, 400), c]);
    require('./ourFault').record('campus-contacts', `${row.brand}: ${out.error}`, 'campusContacts ' + universityId).catch(() => {});
    return { reachable: false, costUsd: c, error: out.error, out };
  }
  await pool.query(
    `UPDATE university_contacts SET contact_name = $3, contact_title = $4, email = $5, email_source = $6, phone = $7, instagram = $8,
       website = $9, facebook = $10, linkedin = $11, sources = $12::jsonb, athlete_history = $13, athlete_history_note = $14,
       reachable = $15, status = $16, last_error = NULL, attempts = attempts + 1, cost_usd = cost_usd + $17, resolved_at = NOW(), updated_at = NOW(),
       generic_email = $18, withdrawn_reason = NULL
     WHERE university_id = $1 AND brand = $2`,
    [universityId, row.brand, out.contact_name, out.contact_title, out.email, out.email_source, out.phone, out.instagram, out.website,
      out.facebook, out.linkedin, JSON.stringify(out.sources || []), out.athlete_history, out.athlete_history_note, out.reachable,
      out.reachable ? 'reachable' : out.freeOnly ? 'free-checked' : 'unreachable', c, out.generic_email || null]);
  return { reachable: !!out.reachable, costUsd: c, error: null, out, free: !!out.free };
}

async function run(pool, universityId, opts = {}) {
  if (_running.has(universityId)) return { ok: false, error: 'already running', running: true };
  const p = (async () => {
    const CP = require('./campusPool');
    await CP.ensureTables(pool);
    const u = await CP.universityOf(pool, universityId);
    if (!u) return { ok: false, error: `no university "${universityId}"` };
    const city = require('./teamScan').cityOf(u.location) || u.location;
    const seeded = await seedRows(pool, u);
    const budgetUsd = Number(opts.budgetUsd) > 0 ? Number(opts.budgetUsd) : null;
    const runId = (await pool.query(`INSERT INTO university_market_runs (university_id, kind, summary) VALUES ($1,'contacts',$2) RETURNING id`,
      [universityId, { budgetUsd, history: opts.history !== false }])).rows[0].id;
    const todo = (await pool.query(
      `SELECT brand, place_id FROM university_contacts WHERE university_id = $1
         AND (status = 'pending' OR (status = 'error' AND attempts < $2)) ORDER BY brand ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`,
      [universityId, MAX_ATTEMPTS])).rows;
    const scanMeter = require('../scanMeter');
    const Q = require('./outreachQueue');
    let done = 0, reachable = 0, errors = 0, cost = 0, i = 0, stoppedFor = null;
    const worker = async () => {
      while (i < todo.length) {
        // THE CAP. Workers stop taking businesses once the spend reaches it;
        // the rest stay pending, and a capped run is finished (never resumed
        // on boot). Lookups already in flight (up to `concurrency`) complete.
        if (budgetUsd && cost >= budgetUsd) { stoppedFor = 'budget'; break; }
        const row = todo[i++];
        const r = await resolveAndStore(pool, universityId, row, { city, ai: opts.ai, history: opts.history, marketKey: u.marketKey });
        cost += r.costUsd;
        if (r.error) errors++; else if (r.reachable) reachable++;
        done++;
        if (done % 5 === 0) {
          console.log(`[campus-contacts] ${u.name}: ${done}/${todo.length} resolved, ${reachable} reachable, ${errors} errors, $${cost.toFixed(2)}`);
          await pool.query(`UPDATE university_market_runs SET summary = $2 WHERE id = $1`, [runId, { seeded, todo: todo.length, done, reachable, errors, costUsd: cost, budgetUsd, history: opts.history !== false }]).catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || CAMPUS_CONCURRENCY) }, worker));
    const summary = { seeded, todo: todo.length, done, reachable, errors, costUsd: Math.round(cost * 100) / 100, budgetUsd, stoppedFor,
      history: opts.history !== false };
    await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [runId, summary]);
    console.log(`[campus-contacts] ${u.name}: run complete ${JSON.stringify(summary)}`);
    return { ok: true, ...summary };
  })().finally(() => _running.delete(universityId));
  _running.set(universityId, p);
  return opts.wait === false ? { ok: true, started: true } : p;
}
const isRunning = (universityId) => _running.has(universityId);

// ── THE THREE NUMBERS ───────────────────────────────────────────────────────
async function report(pool, universityId) {
  const CP = require('./campusPool');
  await CP.ensureTables(pool);
  const u = await CP.universityOf(pool, universityId);
  const pc = u ? await CP.poolCount(pool, u.marketKey) : { usable: 0, total: 0 };
  const c = (await pool.query(
    `SELECT COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE status IN ('reachable','unreachable'))::int AS resolved,
            COUNT(*) FILTER (WHERE reachable)::int AS reachable,
            COUNT(*) FILTER (WHERE contact_name IS NOT NULL)::int AS named,
            COUNT(*) FILTER (WHERE reachable AND email IS NOT NULL)::int AS with_email,
            COUNT(*) FILTER (WHERE reachable AND phone IS NOT NULL)::int AS with_phone,
            COUNT(*) FILTER (WHERE reachable AND email IS NULL AND phone IS NULL AND instagram IS NOT NULL)::int AS dm_only,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
            COUNT(*) FILTER (WHERE athlete_history)::int AS history,
            COALESCE(SUM(cost_usd), 0)::float AS contacts_cost
       FROM university_contacts WHERE university_id = $1`, [universityId])).rows[0];
  const poolRuns = (await pool.query(`SELECT summary FROM university_market_runs WHERE university_id = $1 AND kind = 'pool' AND finished_at IS NOT NULL`, [universityId])).rows;
  const poolCost = poolRuns.reduce((s, r) => s + (Number(r.summary && r.summary.costUsd) || 0), 0);
  const teams = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  // THE NIGHTLY ESTIMATE. Contacts are resolved once, so a card costs the
  // writer: one ask, sometimes a lint retry, on the team writer's model.
  const perAsk = parseFloat(process.env.UNIVERSITY_ASK_USD) || 0.02;
  const asksPerCard = 1.3;
  const perTeam = require('./campusNightly').PER_TEAM;
  const nightly = Math.round(teams * perTeam * asksPerCard * perAsk * 100) / 100;
  return {
    university: u && u.name, marketKey: u && u.marketKey, pool: pc, contacts: c, teams,
    hitRate: c.resolved ? c.reachable / c.resolved : null,
    poolCostUsd: Math.round(poolCost * 100) / 100, contactsCostUsd: Math.round(c.contacts_cost * 100) / 100,
    nightly: { cards: teams * perTeam, perTeam, usd: nightly, assumes: `${asksPerCard} writer calls a card at $${perAsk} (contacts already resolved, so no lookup cost)` },
    running: isRunning(universityId),
  };
}

function formatReport(r) {
  const c = r.contacts;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  return [
    `${r.university} (${r.marketKey})${r.running ? '  CONTACT RESOLUTION STILL RUNNING' : ''}`,
    `POOL: ${r.pool.usable} usable businesses (${r.pool.total} incl. blocked)`,
    `1. CONTACT HIT RATE: ${c.reachable} of ${c.resolved} resolved have a named human AND a way to reach them = ${r.hitRate === null ? '-' : pct(c.reachable, c.resolved)}`
      + `${c.pending ? `  (${c.pending} still pending)` : ''}${c.errors ? `  (${c.errors} failed on our side, will retry)` : ''}`,
    `   with email ${c.with_email}, with phone ${c.with_phone}, Instagram DM only ${c.dm_only}; named but no way to reach ${c.named - c.reachable}; athlete/NIL history ${c.history}`,
    `2. COST OF THE DEEP BUILD: pool $${r.poolCostUsd.toFixed(2)} + contacts $${r.contactsCostUsd.toFixed(2)} = $${(r.poolCostUsd + r.contactsCostUsd).toFixed(2)}`,
    `3. NIGHTLY ESTIMATE: ${r.nightly.cards} cards (${r.teams} teams x ${r.nightly.perTeam}) about $${r.nightly.usd.toFixed(2)} a night; ${r.nightly.assumes}`,
    r.hitRate !== null && r.hitRate < 0.6 ? 'UNDER 60%: this is the product problem; stop before the UI.' : '',
  ].filter(Boolean).join('\n');
}

module.exports = { freeContact, resolveAndStore, estimate, perBusinessUsd, PER_BIZ, run, report, formatReport, resolveOne, teamFit, pickPerson, seedRows, isRunning, MAX_ATTEMPTS };
