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
  const BC = require('./businessCategory');
  const type = (place && BC.categoryOf(place).category) || card.business_category || null;
  const rec = await EF.finishLadder({ ladder, out, ig, brand: card.brand_name, region, place, Q, more: opts.more !== false,
    smart: !!opts.smart, allowGeneral: true, type },
    deps.finderDeps(card));
  const person = Q.greetRowOf(ladder);
  const inbox = Q.inboxOf(ladder);
  const verifiedNamed = rec.after === 'email' && !!inbox && !inbox.general && !!person && lc(person.email) === lc(inbox.email)
    && !!(person.emailVerify && person.emailVerify.pass);
  const general = rec.after === 'email' && !!(inbox && inbox.general);
  const R = require('./reachability');
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
    // SMART PICK: what kind of business, who the email goes to, and where it
    // sat in the night's order.
    type, general, fillsSlot: verifiedNamed || general,
    cls: general ? 'general' : (verifiedNamed && person ? R.contactClass(person.title) : null),
    generalWhy: f.generalInbox && !f.generalInbox.used ? f.generalInbox.why : null,
    candidate: !!card._candidate, seq: card._seq == null ? 9999 : card._seq,
    ownerNamed: person ? (R.contactClass(person.title) === 'owner' ? 'yes' : 'no') : 'no name',
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

// opts: { days, limit, concurrency, deadlineMs, maxVerify, deps, more, smart,
//         candidates, maxCandidates, retryGapMs, includeEmail, model }
async function run(pool, opts = {}) {
  const days = opts.days || 7;
  const R = require('./emailFinderReport');
  const report = await R.gather(pool, { days });
  // The DM and call cards first (the cards the finder exists to convert), then
  // the nights' email cards (each verified, as the night now would).
  let rows = report.rows.slice().sort((a, b) => String(a.night).localeCompare(String(b.night)));
  const emailRows = opts.includeEmail === false ? [] : (report.emailCards || []).slice().sort((a, b) => String(a.night).localeCompare(String(b.night)));
  // ── WHERE EACH BUSINESS SAT IN ITS NIGHT, AND WHAT ELSE WAS TRIED ────────
  // SMART PICK picks among everything the night actually looked up, not only
  // what it placed: the businesses it tried and passed over are candidates.
  const runs = (await pool.query(`SELECT agent_id, run_date, details FROM outreach_queue_runs WHERE run_date >= CURRENT_DATE - $1::int`, [days + 1])).rows;
  const triedBy = new Map();
  for (const r of runs) {
    const night = r.run_date instanceof Date ? `${r.run_date.getFullYear()}-${String(r.run_date.getMonth() + 1).padStart(2, '0')}-${String(r.run_date.getDate()).padStart(2, '0')}` : String(r.run_date).slice(0, 10);
    for (const d of (Array.isArray(r.details) ? r.details : [])) {
      if (d && d.athleteId) triedBy.set(`${r.agent_id}|${d.athleteId}|${night}`, { tried: Array.isArray(d.tried) ? d.tried : [], athleteName: d.athleteName || null });
    }
  }
  const seqOf = (c) => {
    const t = triedBy.get(`${c.agent_id}|${c.athlete_id}|${String(c.night).slice(0, 10)}`);
    if (!t) return null;
    const i = t.tried.findIndex((x) => x && lc(x.brand) === lc(c.brand_name));
    return i < 0 ? null : i;
  };
  for (const c of rows.concat(emailRows)) c._seq = seqOf(c);
  const placedKey = new Set(rows.concat(emailRows).map((c) => `${c.agent_id}|${c.athlete_id}|${String(c.night).slice(0, 10)}|${lc(c.brand_name)}`));
  const BC = require('./businessCategory');
  let cands = [];
  if (opts.candidates !== false && opts.smart !== false) {
    for (const [k, v] of triedBy) {
      const [agentId, athleteId, night] = k.split('|');
      v.tried.forEach((t, i) => {
        if (!t || !t.brand || !t.why || t.result === 'queued' || t.result === 'deferred') return;
        if (t.stage === 'selection' || t.stage === 'variety') return;
        if (placedKey.has(`${agentId}|${athleteId}|${night}|${lc(t.brand)}`)) return;
        const who = (t.why.person && t.why.person.name) || (t.why.finalName && t.why.finalName.name) || null;
        cands.push({ id: `tried:${k}:${lc(t.brand)}`, agent_id: agentId, athlete_id: athleteId, athlete_name: v.athleteName, night, brand_name: t.brand,
          channel: null, lane: t.lane || 'local', contact_name: who, contact_title: (t.why.person && t.why.person.title) || (t.why.finalName && t.why.finalName.title) || null,
          business_category: t.why.type || BC.categoryOf({ primaryType: t.places && t.places.primaryType }).category || null,
          reason: `tried that night and not placed (${t.result}${t.reason ? ': ' + String(t.reason).slice(0, 60) : ''})`, _candidate: true, _seq: i });
      });
    }
    cands = cands.slice(0, opts.maxCandidates || 400);
  }
  // Whether each placed email card's address was verified: before.
  const emails = emailRows.map((c) => lc(c.email)).filter(Boolean);
  const valid = new Set(emails.length ? (await pool.query(`SELECT email FROM email_verification WHERE result = 'valid' AND email = ANY($1::text[])`, [emails])
    .catch(() => ({ rows: [] }))).rows.map((r) => r.email) : []);
  for (const c of emailRows) c._verifiedBefore = !!(c.email_verified || valid.has(lc(c.email)));
  let all = rows.concat(emailRows, cands);
  if (opts.limit) all = all.slice(0, opts.limit);
  const deps = opts.deps || {
    rebuild: liveRebuild(pool),
    finderDeps: (card) => require('./emailFinder').liveDeps(pool, { agentId: card.agent_id, athleteId: card.athlete_id, business: card.brand_name, source: 'finder-dryrun' }),
  };
  const deadline = Date.now() + (opts.deadlineMs || 13 * 60 * 1000);
  const maxVerify = opts.maxVerify || 900;
  const more = opts.more !== false;
  const smart = opts.smart !== false;
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
        const r = await oneCard(pool, all[i], deps, { more, smart });
        spentVerify += r.credits.verify;
        r.verifiedBefore = !!all[i]._verifiedBefore;
        r.contactTitleBefore = all[i].contact_title || null;
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
          const r = await oneCard(pool, card, deps, { more, smart });
          r.tries = t;
          r.verifiedBefore = !!card._verifiedBefore;
          r.contactTitleBefore = card.contact_title || null;
          r.credits = { search: x.credits.search + r.credits.search, verify: x.credits.verify + r.credits.verify, webSearch: x.credits.webSearch + r.credits.webSearch };
          spentVerify += r.credits.verify - x.credits.verify;
          results[results.indexOf(x)] = r;
          retried++;
          if (r.verifiedNamed) recovered++;
        } catch (e) { errors.push({ brand: card.brand_name, error: 'retry: ' + e.message }); }
      }
    }
  }
  const model = opts.model !== undefined ? opts.model : await require('./reachability').latest(pool).catch(() => null);
  return { days, cards: report.cards, mix: report.mix, total: rows.length, totalEmail: emailRows.length, totalAll: all.length,
    totalCandidates: cands.length, results, errors, stoppedFor, budget: report.budget, more, smart, retried, recovered,
    nightsRecord: report.nights, model, smartPicks: smart ? pickPerNight(results, model) : null };
}

// ── THE NIGHT, PICKED AGAIN UNDER SMART PICK ────────────────────────────────
// For each athlete-night: everything the night looked up, in the order it
// came, re-ranked within type by reachability (services/reachability), then
// up to five taken with the night's rules -- a verified email for a named
// person, or one verified general inbox; no more than two of one type.
// BEFORE is what the night actually placed.
function pickPerNight(results, model) {
  const R = require('./reachability');
  const groups = new Map();
  for (const x of results) {
    const k = `${x.night}|${x.athleteId}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(x);
  }
  const out = [];
  for (const [k, list] of groups) {
    const ordered = R.smartOrder(list.slice().sort((a, b) => a.seq - b.seq).map((x) => ({ ...x, businessCategory: x.type })),
      (x) => R.scoreOf(model, { type: x.type || 'unknown', ownerNamed: x.ownerNamed, website: x.domain ? 'yes' : 'unknown' }));
    const picked = [];
    const perType = new Map();
    let general = 0;
    for (const x of ordered) {
      if (picked.length >= 5) break;
      if (!x.fillsSlot) continue;
      if (x.type && (perType.get(x.type) || 0) >= 2) continue;
      if (x.general && general >= 1) continue;
      picked.push(x);
      if (x.type) perType.set(x.type, (perType.get(x.type) || 0) + 1);
      if (x.general) general++;
    }
    const placed = list.filter((x) => !x.candidate);
    const before = placed.filter((x) => x.channelBefore === 'email' && x.verifiedBefore);
    out.push({ key: k, night: list[0].night, athlete: list[0].athlete, agent: list[0].agent,
      looked: list.length, placed: placed.length,
      before: before.length, beforeCls: before.map((x) => require('./reachability').contactClass(x.contactTitleBefore)),
      beforeTypes: placed.map((x) => x.type || 'unknown'),
      after: picked.length, afterCls: picked.map((x) => x.cls || 'other'), afterTypes: picked.map((x) => x.type || 'unknown'),
      general });
  }
  return out.sort((a, b) => b.night.localeCompare(a.night) || String(a.athlete).localeCompare(String(b.athlete)));
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
  // The cards the nights placed. Candidates (tried, not placed) are only in
  // the SMART PICK sections.
  const placedRes = r.results.filter((x) => !x.candidate);
  const dmc = placedRes.filter((x) => x.channelBefore !== 'email');
  const em = placedRes.filter((x) => x.channelBefore === 'email');
  const yes = dmc.filter((x) => x.verifiedNamed);
  L.push(`EMAIL FINDER DRY RUN: the cards of the last ${r.days} nights. No card changed, nothing sent.`);
  L.push(`Finder steps: ${r.more ? 'all, including EMAIL_FINDER_MORE (retries, another decision maker, Places and Facebook for a missing website)' : 'the base finder only'}`
    + `${r.smart ? ', and EMAIL_SMART_PICK (contact order owner > marketing > GM, general inbox for the smallest, ranking within type, two per type at most)' : ''}.`);
  if (r.stoppedFor) L.push(`STOPPED EARLY at ${r.results.length} of ${r.totalAll} cards: ${r.stoppedFor}. Run it again; what was checked is cached.`);

  if (r.smartPicks) {
    const P = r.smartPicks;
    const avg = (f) => (P.reduce((n, e) => n + f(e), 0) / Math.max(1, P.length)).toFixed(2);
    L.push('', 'SMART PICK (EMAIL_SMART_PICK): VERIFIED EMAILS PER ATHLETE-NIGHT, BEFORE AND AFTER');
    L.push('  before = what that night placed: email cards whose address verified. after = the same night\'s businesses (every one it');
    L.push('  looked up, placed or not), ranked within type by reachability, up to five: a verified email for a named person, or one');
    L.push('  verified general inbox; no more than two of one type.');
    L.push(`  Average per athlete-night: before ${avg((e) => e.before)}, after ${avg((e) => e.after)} over ${P.length} athlete-night(s).`
      + ` At five: before ${P.filter((e) => e.before >= 5).length}, after ${P.filter((e) => e.after >= 5).length}.`);
    L.push(`  ${r.totalCandidates} business(es) tried and not placed were looked at as candidates.`);
    L.push('  night       athlete                    looked  placed  before  after  types before -> after  general');
    for (const e of P) {
      const tb = new Set(e.beforeTypes).size, ta = new Set(e.afterTypes).size;
      L.push(`  ${e.night}  ${String(e.athlete).slice(0, 25).padEnd(25)}  ${String(e.looked).padStart(6)}  ${String(e.placed).padStart(6)}  ${String(e.before).padStart(6)}  ${String(e.after).padStart(5)}  ${String(tb).padStart(12)} -> ${String(ta).padEnd(5)}  ${String(e.general).padStart(7)}`);
    }
    const share = (cls) => {
      const n = cls.length || 1;
      const c = (k) => cls.filter((x) => (Array.isArray(k) ? k.includes(x) : x === k)).length;
      return `owner or marketing ${c(['owner', 'marketing'])} (${Math.round(100 * c(['owner', 'marketing']) / n)}%), GM or manager ${c('gm')} (${Math.round(100 * c('gm') / n)}%), general inbox ${c('general')} (${Math.round(100 * c('general') / n)}%)`
        + (c('other') ? `, other ${c('other')}` : '');
    };
    L.push('', 'WHO THE VERIFIED EMAILS GO TO:');
    L.push(`  before: ${share(P.flatMap((e) => e.beforeCls))}`);
    L.push(`  after:  ${share(P.flatMap((e) => e.afterCls))}`);
    L.push('', 'BUSINESS-TYPE MIX (before: every card placed; after: the picks)');
    const tb = {}, ta = {};
    for (const e of P) { for (const t of e.beforeTypes) tb[t] = (tb[t] || 0) + 1; for (const t of e.afterTypes) ta[t] = (ta[t] || 0) + 1; }
    const keys = [...new Set([...Object.keys(tb), ...Object.keys(ta)])].sort((a, b) => ((ta[b] || 0) + (tb[b] || 0)) - ((ta[a] || 0) + (tb[a] || 0)));
    for (const k of keys) L.push(`  ${String(k).padEnd(16)} ${String(tb[k] || 0).padStart(5)} -> ${String(ta[k] || 0).padStart(5)}`);
    const over2 = (types) => Object.values(types.reduce((m, t) => { m[t] = (m[t] || 0) + 1; return m; }, {})).some((n) => n > 2);
    L.push(`  athlete-nights with more than 2 of one type: before ${P.filter((e) => over2(e.beforeTypes)).length}, after ${P.filter((e) => over2(e.afterTypes)).length};`
      + ` with 3+ types among five: after ${P.filter((e) => e.after >= 5 && new Set(e.afterTypes).size >= 3).length} of ${P.filter((e) => e.after >= 5).length}`);
    const gw = {};
    for (const x of r.results.filter((y) => y.generalWhy)) { const k = String(x.generalWhy).replace(/\(.*$/, '').trim(); gw[k] = (gw[k] || 0) + 1; }
    if (Object.keys(gw).length) {
      L.push('', 'GENERAL INBOX NOT USED, WHY:');
      for (const [k, v] of Object.entries(gw).sort((a, b) => b[1] - a[1]).slice(0, 8)) L.push(`  ${String(v).padStart(4)}  ${k}`);
    }
    if (!r.model) L.push('', '  (No reachability model yet: within-type ranking left the night\'s order as it was. reachability-report?recompute=1 builds one.)');
  }

  // ── EMAILS PER ATHLETE PER NIGHT ─────────────────────────────────────────
  const by = new Map();
  for (const x of placedRes) {
    const k = `${x.night}|${x.athleteId}`;
    const e = by.get(k) || { night: x.night, athlete: x.athlete, agent: x.agent, placed: 0, before: 0, after: 0 };
    e.placed++;
    if (x.channelBefore === 'email') e.before++;
    if (x.verifiedNamed) e.after++;
    by.set(k, e);
  }
  const rowsAN = [...by.values()].sort((a, b) => b.night.localeCompare(a.night) || String(a.athlete).localeCompare(String(b.athlete)));
  const sumB = rowsAN.reduce((n, e) => n + e.before, 0), sumA = rowsAN.reduce((n, e) => n + e.after, 0);
  L.push('', 'PLACED CARDS ONLY, PER ATHLETE PER NIGHT (the finder on what each night placed), BEFORE AND AFTER:');
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
