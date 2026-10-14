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
async function oneCard(pool, card, deps) {
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
  const rec = await EF.finishLadder({ ladder, out, ig, brand: card.brand_name, region, place, Q },
    deps.finderDeps(card));
  const person = Q.greetRowOf(ladder);
  const inbox = Q.inboxOf(ladder);
  const verifiedNamed = rec.after === 'email' && !!inbox && !!person && lc(person.email) === lc(inbox.email)
    && !!(person.emailVerify && person.emailVerify.pass);
  return {
    id: card.id, agent: card.agent_name || card.agent_id, night: card.night, brand: card.brand_name, channelBefore: card.channel,
    reason: card.reason || null, person: person ? person.name : null, sameperson: !!(person && card.contact_name && lc(person.name) === lc(card.contact_name)),
    rebuiltBefore: before, after: rec.after, verifiedNamed, email: verifiedNamed ? inbox.email : null,
    how: verifiedNamed ? (rec.verify && rec.verify.pass ? 'the card\'s own address, verified' : (rec.finder && rec.finder.how) || null) : null,
    verdict: verifiedNamed ? (person.emailVerify.verdict || null) : null,
    websiteFound: !!(rec.website && rec.website.website), websiteVia: rec.website ? rec.website.via : null,
    stop: verifiedNamed ? null : ((rec.finder && rec.finder.stop) || (rec.verify && !rec.verify.pass ? `own address ${rec.verify.verdict}` : 'no address found')),
    heldStated: !!((rec.verify && rec.verify.heldStated) || (rec.finder && rec.finder.heldStated)),
    credits: rec.credits, lookupUsd: meter ? require('./outreachQueue').priceOf(meter) : 0,
    lookupCached: !!(out && out.cached), ms: Date.now() - t0,
    steps: rec.finder && rec.finder.steps ? rec.finder.steps : [],
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

// opts: { days, limit, concurrency, deadlineMs, maxVerify, deps }
async function run(pool, opts = {}) {
  const days = opts.days || 7;
  const R = require('./emailFinderReport');
  const report = await R.gather(pool, { days });
  // Region for a card is read per card; the athlete's market is the fallback.
  let rows = report.rows.slice().sort((a, b) => String(a.night).localeCompare(String(b.night)));
  if (opts.limit) rows = rows.slice(0, opts.limit);
  const deps = opts.deps || {
    rebuild: liveRebuild(pool),
    finderDeps: (card) => require('./emailFinder').liveDeps(pool, { agentId: card.agent_id, athleteId: card.athlete_id, business: card.brand_name, source: 'finder-dryrun' }),
  };
  const deadline = Date.now() + (opts.deadlineMs || 13 * 60 * 1000);
  const maxVerify = opts.maxVerify || 900;
  const results = [];
  const errors = [];
  let spentVerify = 0, next = 0, stoppedFor = null;
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) { stoppedFor = stoppedFor || 'the 13-minute limit'; return; }
      if (spentVerify >= maxVerify) { stoppedFor = stoppedFor || `the ${maxVerify}-verification limit for this run`; return; }
      const i = next++;
      if (i >= rows.length) return;
      try {
        const r = await oneCard(pool, rows[i], deps);
        spentVerify += r.credits.verify;
        results.push(r);
      } catch (e) {
        errors.push({ brand: rows[i].brand_name, error: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 4) }, worker));
  return { days, cards: report.cards, mix: report.mix, total: rows.length, results, errors, stoppedFor, budget: report.budget };
}

function format(r) {
  const L = [];
  const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
  const done = r.results.length;
  const yes = r.results.filter((x) => x.verifiedNamed);
  L.push(`EMAIL FINDER DRY RUN: the DM and call cards of the last ${r.days} nights. No card changed, nothing sent.`);
  if (r.stoppedFor) L.push(`STOPPED EARLY at ${done} of ${r.total} cards: ${r.stoppedFor}. Run it again; what was checked is cached.`);
  L.push('', `BEFORE: 0 of ${r.total} had a verified email for the named person (every one was a DM or a call card).`);
  L.push(`AFTER:  ${yes.length} of ${done} checked (${pct(yes.length, done)}) now have one, and would be email cards.`);
  const valid = yes.filter((x) => x.verdict === 'valid').length;
  L.push(`        ${valid} verified valid, ${yes.length - valid} catch-all built from a confirmed pattern.`);

  L.push('', 'BY WHY THEY WERE NOT EMAIL (from email-finder-report), before -> after:');
  const by = {};
  for (const x of r.results) { const k = x.reason || '(unclassified)'; (by[k] = by[k] || { n: 0, yes: 0 }).n++; if (x.verifiedNamed) by[k].yes++; }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) L.push(`  ${String(v.n).padStart(4)} -> ${String(v.yes).padStart(4)} email  ${k}`);

  L.push('', 'HOW THE ADDRESS WAS FOUND:');
  const how = {};
  for (const x of yes) { const k = String(x.how || '?').replace(/\s*\([^)]*\)$/, ''); how[k] = (how[k] || 0) + 1; }
  for (const [k, v] of Object.entries(how).sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(4)}  ${k}`);
  const site = r.results.filter((x) => x.websiteFound);
  L.push(`  ${String(site.length).padStart(4)}  had no website and one was found (${site.filter((x) => x.verifiedNamed).length} of them now email)`);

  L.push('', 'STILL NO VERIFIED ADDRESS, BY WHY:');
  const stop = {};
  for (const x of r.results.filter((y) => !y.verifiedNamed)) { const k = String(x.stop || '?').replace(/ \(.*$/, '').slice(0, 90); stop[k] = (stop[k] || 0) + 1; }
  for (const [k, v] of Object.entries(stop).sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(4)}  ${k}`);
  const held = r.results.filter((x) => !x.verifiedNamed && x.heldStated).length;
  L.push('', `HELD BACK BY THE CATCH-ALL RULE: ${held} card(s) had an address FOUND STATED for the named person (on their site, or listed`);
  L.push('  by Hunter) at a catch-all domain. The rule as written passes catch-all only for a pattern-built address, so these');
  L.push('  stay DM/call. FINDER_CATCHALL_STATED=1 would let them through.');

  const sum = r.results.reduce((a, x) => ({ search: a.search + x.credits.search, verify: a.verify + x.credits.verify, web: a.web + x.credits.webSearch, usd: a.usd + (x.lookupUsd || 0) }), { search: 0, verify: 0, web: 0, usd: 0 });
  L.push('', 'WHAT THIS RUN SPENT:');
  L.push(`  Hunter: ${sum.search} search credit(s), ${sum.verify} verification credit(s). Domain web searches: ${sum.web}. Contact lookups re-run (cache misses): $${sum.usd.toFixed(2)}.`);
  const perCard = done ? { s: sum.search / done, v: sum.verify / done } : { s: 0, v: 0 };
  const nights = Math.max(1, r.days);
  const cardsPerNight = r.cards / nights;
  const dmCallPerNight = r.total / nights;
  const emailPerNight = (r.mix.email || 0) / nights;
  const vNight = perCard.v * dmCallPerNight + emailPerNight;
  const sNight = perCard.s * dmCallPerNight;
  L.push('', 'EXPECTED HUNTER CREDITS PER NIGHT (before caching makes repeats free):');
  L.push(`  ${cardsPerNight.toFixed(1)} cards a night: ${dmCallPerNight.toFixed(1)} that were DM/call x ${perCard.v.toFixed(2)} verifications each, plus ${emailPerNight.toFixed(1)} email cards x 1.`);
  L.push(`  ~${Math.round(vNight)} verifications and ~${Math.round(sNight)} searches a night; ~${Math.round(vNight * 30)} and ~${Math.round(sNight * 30)} a month,`);
  L.push(`  against pools of ${require('./hunterLookup').VERIFY_MONTHLY_BUDGET} verifications and ${require('./hunterLookup').MONTHLY_BUDGET} searches.`);
  if (r.budget) L.push(`  Used so far this month: ${r.budget.verifyUsed} verifications, ${r.budget.ladderUsed} searches (before this run).`);

  L.push('', 'EXAMPLES:');
  for (const x of yes.slice(0, 12)) L.push(`  EMAIL  ${String(x.brand).slice(0, 30).padEnd(30)} ${String(x.person || '').slice(0, 22).padEnd(22)} ${x.email}  (${x.how}; ${x.verdict})`);
  for (const x of r.results.filter((y) => !y.verifiedNamed).slice(0, 12)) L.push(`  ${String(x.after).toUpperCase().padEnd(5)}  ${String(x.brand).slice(0, 30).padEnd(30)} ${String(x.person || '').slice(0, 22).padEnd(22)} ${String(x.stop).slice(0, 110)}`);
  if (r.errors.length) { L.push('', `ERRORS (${r.errors.length}):`); for (const e of r.errors.slice(0, 10)) L.push(`  ${e.brand}: ${e.error}`); }
  return L.join('\n');
}

module.exports = { run, format, oneCard, regionOf, liveRebuild };
