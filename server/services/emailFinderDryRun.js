'use strict';
// ── THE EMAIL FINDER, RE-RUN OVER CARDS ALREADY PLACED. NOTHING IS SENT. ────
//
// Takes the DM and call cards of the last N nights (the same set
// email-finder-report counts), rebuilds each one's contact ladder the way the
// night did (ai.getBrandContacts and the contact ladder, mostly from cache),
// and runs the night's new finishing step on it (services/emailFinder).
// Before and after: how many have a verified address for the person the pitch
// opens to.
//
// WHAT IT TOUCHES. No card is changed, no draft written, nothing sent. It does
// spend: Hunter verifications and searches (logged to email_verify_credit_log
// with source 'finder-dryrun', and counted against the month's pools), and a
// web search for any business whose contacts are no longer cached. Every
// answer it buys is cached, so the first real night after deploy reads it free.

const lc = (s) => String(s || '').trim().toLowerCase();

// The region the night used for this business: the contacts cache is keyed
// `${brand} | ${region} | manual`, and the latest key for the brand is the
// one the night wrote or read.
async function regionOf(pool, card) {
  try {
    const r = await pool.query(
      `SELECT brand_key FROM brand_evidence_cache WHERE lane = 'contacts' AND lower(brand) = lower($1)
        ORDER BY refreshed_at DESC LIMIT 1`, [card.brand_name]);
    const k = r.rows[0] && r.rows[0].brand_key;
    if (k) { const parts = String(k).split(' | '); if (parts.length >= 3) return parts[parts.length - 2]; }
  } catch (_) { /* fall back */ }
  // No contacts row: the athlete's own market, as the night computes it
  // (a hometown card's region is the hometown).
  try {
    const J = require('../jobs/outreachQueue');
    const ath = (await J.loadAthletesForQueue(pool, card.agent_id, card.athlete_id))[0];
    if (ath) {
      if (card.lane === 'hometown' && ath.hometown) return ath.hometown;
      const c = await J.localContextFor(ath);
      if (c && c.region) return c.region;
    }
  } catch (_) { /* no region */ }
  return '';
}

// One card: rebuild, finish, judge. deps.rebuild is injected by the tests.
// opts.more: the finder's extra steps (EMAIL_FINDER_MORE) -- on in the dry run
// whatever the switch says, so it measures what turning it on would do.
async function oneCard(pool, card, deps, opts = {}) {
  const t0 = Date.now();
  const region = await (deps.regionOf || regionOf)(pool, card);
  const built = await deps.rebuild(card, region);
  const { ladder, out, ig, place, meter } = built;
  const Q = require('./outreachQueue');
  const EF = require('./emailFinder');
  // The person on the card. When the rebuilt ladder has no greetable person
  // (the night found them with its last owner search), they are put back.
  if (!Q.greetNameOf(ladder) && card.contact_name) {
    require('./ownerNameSearch').attachToLadder(ladder, { name: card.contact_name, title: card.contact_title || 'Owner', query: 'the card', sourceUrl: null });
  }
  const before = Q.channelFor(ladder, ig);
  const rec = await EF.finishLadder({ ladder, out, ig, brand: card.brand_name, region, place, Q, more: opts.more !== false },
    deps.finderDeps(card));
  const person = Q.greetRowOf(ladder);
  const inbox = Q.inboxOf(ladder);
  const verifiedNamed = rec.after === 'email' && !!inbox && !!person && lc(person.email) === lc(inbox.email)
    && !!(person.emailVerify && person.emailVerify.pass);
  const f = rec.finder || {};
  const notRun = !verifiedNamed && ((rec.verify && rec.verify.verdict === 'not-run') || /could not run/.test(String(f.stop || '')));
  return {
    id: card.id, agent: card.agent_name || card.agent_id, athleteId: card.athlete_id, athlete: card.athlete_name || card.athlete_id,
    night: String(card.night || '').slice(0, 10), brand: card.brand_name, channelBefore: card.channel,
    reason: card.channel === 'email' ? 'an email card already' : (card.reason || null),
    person: person ? person.name : null, sameperson: !!(person && card.contact_name && lc(person.name) === lc(card.contact_name)),
    rebuiltBefore: before, after: rec.after, verifiedNamed, email: verifiedNamed ? inbox.email : null,
    how: verifiedNamed ? (rec.verify && rec.verify.pass ? 'the card\'s own address, verified' : (f.how || null)) : null,
    verdict: verifiedNamed ? (person.emailVerify.verdict || null) : null,
    switchedTo: f.switchedTo || null,
    websiteFound: !!(rec.website && rec.website.website), websiteVia: rec.website ? rec.website.via : null,
    domain: f.domain || (out && out.website ? require('./emailTier').rootDomain(out.website) : null),
    stop: verifiedNamed ? null : (f.stop || (rec.verify && !rec.verify.pass ? `own address ${rec.verify.verdict}` : 'no address found')),
    notRun, heldStated: !!((rec.verify && rec.verify.heldStated) || f.heldStated),
    credits: rec.credits, lookupUsd: meter ? require('./outreachQueue').priceOf(meter) : 0,
    lookupCached: !!(out && out.cached), ms: Date.now() - t0, tries: 1,
    steps: f.steps || [],
  };
}

// The real rebuild: what the night did between "looking up X" and the bar.
function liveRebuild(pool) {
  return async (card, region) => {
    const ai = require('../ai');
    const scanMeter = require('../scanMeter');
    const { buildContactLadder } = require('./contactLadder');
    const ONS = require('./ownerNameSearch');
    const EVAL = require('./emailValidation');
    const m = await scanMeter.run(() => scanMeter.label({ site: 'contacts', agentId: card.agent_id, athleteId: card.athlete_id, brand: card.brand_name },
      () => ai.getBrandContacts(card.brand_name, null, region, ai.deepContactCtx({ market: null, lean: true }))));
    const out = m.result;
    const ladder = buildContactLadder(out, { rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
      category: null, brand: card.brand_name, instagramScope: out.instagramScope || null });
    for (const t of (ladder.tiers || [])) {
      if (!Array.isArray(t.rows)) continue;
      t.rows = t.rows.filter((r) => !(r && r.name && r.title && ONS.titleProblem(r.title, { brand: card.brand_name, city: String(region || '').split(',')[0], sourceUrl: r.sourceUrl || r.emailSourceUrl || null })));
    }
    try { await EVAL.validateLadder(pool, ladder); } catch (_) { /* unchecked */ }
    let place = null;
    try { place = (await require('./placesLookup').lookupPlaceResult(card.brand_name, region)).place; } catch (_) { place = null; }
    const ig = { instagram: out.instagram || card.instagram || null, instagramScope: out.instagramScope || card.instagram_scope || null };
    return { ladder, out, ig, place, meter: m.meter };
  };
}

// opts: { days, limit, concurrency, deadlineMs, maxVerify, deps, more, retryGapMs, includeEmail }
async function run(pool, opts = {}) {
  const days = opts.days || 7;
  const R = require('./emailFinderReport');
  const report = await R.gather(pool, { days });
  // The DM and call cards first (the cards the finder exists to convert), then
  // the nights' email cards (each verified, as the night now would).
  let rows = report.rows.slice().sort((a, b) => String(a.night).localeCompare(String(b.night)));
  const emailRows = opts.includeEmail === false ? [] : (report.emailCards || []).slice().sort((a, b) => String(a.night).localeCompare(String(b.night)));
  let all = rows.concat(emailRows);
  if (opts.limit) all = all.slice(0, opts.limit);
  const deps = opts.deps || {
    rebuild: liveRebuild(pool),
    finderDeps: (card) => require('./emailFinder').liveDeps(pool, { agentId: card.agent_id, athleteId: card.athlete_id, business: card.brand_name, source: 'finder-dryrun' }),
  };
  const deadline = Date.now() + (opts.deadlineMs || 13 * 60 * 1000);
  const maxVerify = opts.maxVerify || 900;
  const more = opts.more !== false;
  const results = [];
  const errors = [];
  let spentVerify = 0, next = 0, stoppedFor = null;
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) { stoppedFor = stoppedFor || 'the 13-minute limit'; return; }
      if (spentVerify >= maxVerify) { stoppedFor = stoppedFor || `the ${maxVerify}-verification limit for this run`; return; }
      const i = next++;
      if (i >= all.length) return;
      try {
        const r = await oneCard(pool, all[i], deps, { more });
        spentVerify += r.credits.verify;
        results.push(r);
      } catch (e) {
        errors.push({ brand: all[i].brand_name, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 4) }, worker));

  // ── A CHECK THAT COULD NOT RUN IS ASKED AGAIN (EMAIL_FINDER_MORE) ────────
  // As the night would: after a gap, up to three tries in all.
  const gap = opts.retryGapMs != null ? opts.retryGapMs : 90 * 1000;
  let retried = 0, recovered = 0;
  if (more) {
    for (let t = 2; t <= 3; t++) {
      const again = results.filter((x) => x.notRun && x.tries === t - 1);
      if (!again.length || stoppedFor) break;
      if (Date.now() + gap + 30000 > deadline) { stoppedFor = 'the 13-minute limit, before every retry'; break; }
      if (gap > 0) await new Promise((res) => setTimeout(res, gap));
      for (const x of again) {
        const card = all.find((c) => c.id === x.id);
        if (!card) continue;
        try {
          const r = await oneCard(pool, card, deps, { more });
          r.tries = t;
          r.credits = { search: x.credits.search + r.credits.search, verify: x.credits.verify + r.credits.verify, webSearch: x.credits.webSearch + r.credits.webSearch };
          spentVerify += r.credits.verify - x.credits.verify;
          results[results.indexOf(x)] = r;
          retried++;
          if (r.verifiedNamed) recovered++;
        } catch (e) { errors.push({ brand: card.brand_name, error: 'retry: ' + e.message }); }
      }
    }
  }
  return { days, cards: report.cards, mix: report.mix, total: rows.length, totalEmail: emailRows.length, totalAll: all.length,
    results, errors, stoppedFor, budget: report.budget, more, retried, recovered, nightsRecord: report.nights };
}

// ── LIKELY NATIONAL CHAINS AMONG THESE CARDS ────────────────────────────────
// For the chain list (services/nationalChains): a name the list already knows,
// a domain the finder refused as a chain's, or one website shared by several
// differently named businesses.
function likelyChains(results) {
  const NC = require('./nationalChains');
  const out = new Map();
  const add = (k, why) => { const e = out.get(k) || { name: k, why: new Set(), n: 0 }; e.why.add(why); e.n++; out.set(k, e); };
  for (const x of results) {
    const hit = NC.isChainLocation(x.brand, { always: true });
    if (hit) add(x.brand, `on the chain list (${hit})`);
    if (/chain|corporate/.test(String(x.stop || ''))) add(x.brand, String(x.stop).slice(0, 80));
  }
  const byDomain = new Map();
  for (const x of results) if (x.domain) { const s = byDomain.get(x.domain) || new Set(); s.add(String(x.brand).toLowerCase().replace(/\s*[-(#@].*$/, '').trim()); byDomain.set(x.domain, s); }
  for (const [d, names] of byDomain) if (names.size >= 2) add(d, `one website for ${names.size} businesses: ${[...names].slice(0, 4).join(', ')}`);
  return [...out.values()].sort((a, b) => b.n - a.n);
}

function format(r) {
  const L = [];
  const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
  const dmc = r.results.filter((x) => x.channelBefore !== 'email');
  const em = r.results.filter((x) => x.channelBefore === 'email');
  const yes = dmc.filter((x) => x.verifiedNamed);
  L.push(`EMAIL FINDER DRY RUN: the cards of the last ${r.days} nights. No card changed, nothing sent.`);
  L.push(`Finder steps: ${r.more ? 'all, including EMAIL_FINDER_MORE (retries, another decision maker, Places and Facebook for a missing website)' : 'the base finder only'}.`);
  if (r.stoppedFor) L.push(`STOPPED EARLY at ${r.results.length} of ${r.totalAll} cards: ${r.stoppedFor}. Run it again; what was checked is cached.`);

  // ── EMAILS PER ATHLETE PER NIGHT ─────────────────────────────────────────
  const by = new Map();
  for (const x of r.results) {
    const k = `${x.night}|${x.athleteId}`;
    const e = by.get(k) || { night: x.night, athlete: x.athlete, agent: x.agent, placed: 0, before: 0, after: 0 };
    e.placed++;
    if (x.channelBefore === 'email') e.before++;
    if (x.verifiedNamed) e.after++;
    by.set(k, e);
  }
  const rowsAN = [...by.values()].sort((a, b) => b.night.localeCompare(a.night) || String(a.athlete).localeCompare(String(b.athlete)));
  const sumB = rowsAN.reduce((n, e) => n + e.before, 0), sumA = rowsAN.reduce((n, e) => n + e.after, 0);
  L.push('', 'EMAILS PER ATHLETE PER NIGHT, BEFORE AND AFTER:');
  L.push(`  before = email cards placed that night; after = cards with a verified address for the named person.`);
  L.push(`  Average per athlete-night: before ${(sumB / Math.max(1, rowsAN.length)).toFixed(2)}, after ${(sumA / Math.max(1, rowsAN.length)).toFixed(2)}`
    + ` over ${rowsAN.length} athlete-night(s). At five or more: before ${rowsAN.filter((e) => e.before >= 5).length}, after ${rowsAN.filter((e) => e.after >= 5).length}.`);
  L.push('  "after" counts only the businesses that night placed. With EMAIL_FIVE_ON the night keeps pulling businesses');
  L.push('  until five verified or a stop, so it is a floor; the first real night is in email-finder-report BY NIGHT.');
  L.push('  night       athlete                    agent                placed  before  after');
  for (const e of rowsAN) L.push(`  ${e.night}  ${String(e.athlete).slice(0, 25).padEnd(25)}  ${String(e.agent).slice(0, 18).padEnd(18)}  ${String(e.placed).padStart(6)}  ${String(e.before).padStart(6)}  ${String(e.after).padStart(5)}`);

  L.push('', `DM AND CALL CARDS: before 0 of ${r.total} had a verified email for the named person; after ${yes.length} of ${dmc.length} checked (${pct(yes.length, dmc.length)}).`);
  const valid = yes.filter((x) => x.verdict === 'valid').length;
  L.push(`  ${valid} verified valid, ${yes.length - valid} catch-all built from a confirmed pattern.`);
  const emOk = em.filter((x) => x.verifiedNamed).length;
  L.push(`EMAIL CARDS: ${emOk} of ${em.length} checked carry a verified address for the named person; ${em.length - emOk} would not pass today.`);

  L.push('', 'BY WHY THEY WERE NOT EMAIL (from email-finder-report), before -> after:');
  const byR = {};
  for (const x of dmc) { const k = x.reason || '(unclassified)'; (byR[k] = byR[k] || { n: 0, yes: 0 }).n++; if (x.verifiedNamed) byR[k].yes++; }
  for (const [k, v] of Object.entries(byR).sort((a, b) => b[1].n - a[1].n)) L.push(`  ${String(v.n).padStart(4)} -> ${String(v.yes).padStart(4)} email  ${k}`);

  L.push('', 'HOW THE ADDRESS WAS FOUND:');
  const how = {};
  for (const x of r.results.filter((y) => y.verifiedNamed)) { const k = String(x.how || '?').replace(/\s*\([^)]*\)/g, '').replace(/, for .*$/, ', for another decision maker'); how[k] = (how[k] || 0) + 1; }
  for (const [k, v] of Object.entries(how).sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(4)}  ${k}`);
  const site = r.results.filter((x) => x.websiteFound);
  L.push(`  ${String(site.length).padStart(4)}  had no website and one was found (${site.filter((x) => x.verifiedNamed).length} of them now email; ${site.filter((x) => /facebook/i.test(String(x.websiteVia || ''))).length} via Facebook)`);
  const sw = r.results.filter((x) => x.switchedTo && x.verifiedNamed);
  L.push(`  ${String(sw.length).padStart(4)}  switched to another named decision maker (greeted by name)`);
  if (r.more) L.push(`  ${String(r.retried).padStart(4)}  checks that could not run were retried; ${r.recovered} then verified`);

  L.push('', 'STILL NO VERIFIED ADDRESS, BY WHY:');
  const stop = {};
  for (const x of r.results.filter((y) => !y.verifiedNamed)) { const k = String(x.stop || '?').replace(/ \(.*$/, '').slice(0, 90); stop[k] = (stop[k] || 0) + 1; }
  for (const [k, v] of Object.entries(stop).sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(4)}  ${k}`);
  const held = r.results.filter((x) => !x.verifiedNamed && x.heldStated).length;
  L.push('', `HELD BACK BY THE CATCH-ALL RULE: ${held} card(s) had an address FOUND STATED for the named person at a catch-all`);
  L.push('  domain. FINDER_CATCHALL_STATED=1 would let them through.');

  const chains = likelyChains(r.results);
  L.push('', `LIKELY NATIONAL CHAINS AMONG THESE CARDS (${chains.length}) -- for the chain list:`);
  for (const c of chains.slice(0, 25)) L.push(`  ${String(c.name).slice(0, 40).padEnd(40)} ${[...c.why].join('; ').slice(0, 110)}`);

  const sum = r.results.reduce((a, x) => ({ search: a.search + x.credits.search, verify: a.verify + x.credits.verify, web: a.web + x.credits.webSearch, usd: a.usd + (x.lookupUsd || 0) }), { search: 0, verify: 0, web: 0, usd: 0 });
  L.push('', 'WHAT THIS RUN SPENT:');
  L.push(`  Hunter: ${sum.search} search credit(s), ${sum.verify} verification credit(s). Web searches (domain, Facebook): ${sum.web}. Contact lookups re-run (cache misses): $${sum.usd.toFixed(2)}.`);
  const done = Math.max(1, r.results.length);
  const nights = Math.max(1, r.days);
  const vNight = (sum.verify / done) * (r.cards / nights), sNight = (sum.search / done) * (r.cards / nights);
  L.push('', 'EXPECTED HUNTER CREDITS PER NIGHT (before caching makes repeats free):');
  L.push(`  ${(r.cards / nights).toFixed(1)} cards a night x ${(sum.verify / done).toFixed(2)} verifications and ${(sum.search / done).toFixed(2)} searches each:`);
  L.push(`  ~${Math.round(vNight)} verifications and ~${Math.round(sNight)} searches a night; ~${Math.round(vNight * 30)} and ~${Math.round(sNight * 30)} a month,`);
  L.push(`  against pools of ${require('./hunterLookup').VERIFY_MONTHLY_BUDGET} verifications and ${require('./hunterLookup').MONTHLY_BUDGET} searches.`);
  L.push('  With EMAIL_FIVE_ON the night tries more businesses per card placed, so expect more than this; the first real night says how many.');
  if (r.budget) L.push(`  Used so far this month: ${r.budget.verifyUsed} verifications, ${r.budget.ladderUsed} searches (before this run).`);

  L.push('', 'EXAMPLES:');
  for (const x of r.results.filter((y) => y.verifiedNamed && y.channelBefore !== 'email').slice(0, 12)) L.push(`  EMAIL  ${String(x.brand).slice(0, 30).padEnd(30)} ${String(x.person || '').slice(0, 22).padEnd(22)} ${x.email}  (${x.how}; ${x.verdict})`);
  for (const x of r.results.filter((y) => !y.verifiedNamed).slice(0, 12)) L.push(`  ${String(x.after).toUpperCase().padEnd(5)}  ${String(x.brand).slice(0, 30).padEnd(30)} ${String(x.person || '').slice(0, 22).padEnd(22)} ${String(x.stop).slice(0, 110)}`);
  if (r.errors.length) { L.push('', `ERRORS (${r.errors.length}):`); for (const e of r.errors.slice(0, 10)) L.push(`  ${e.brand}: ${e.error}`); }
  return L.join('\n');
}

module.exports = { run, format, oneCard, regionOf, liveRebuild, likelyChains };
