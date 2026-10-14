'use strict';
// ── WHY DIDN'T THIS CARD GET AN EMAIL ───────────────────────────────────────
//
// Last 7 nights in production: 49% of cards DM, 27% email, 20% call, 4%
// program. This reads every DM and call card the overnight fill placed and
// says why it was not an email card, from what the night recorded:
//
//   outreach_queue                 the card (channel, email_note, email_tier)
//   outreach_queue_runs.details    the night's per-candidate record:
//                                  tried[].why.addressSteps (each rung of the
//                                  address ladder: HIT / miss / skipped, with
//                                  its detail), website, websiteDropped,
//                                  ladderEmails, refusedKinds, emailRoute;
//                                  tried[].emailCheck (undeliverable addresses)
//   brand_evidence_cache           'hunter' (Domain Search by hostname: OK /
//                                  NONE), 'siteemail' (the site scrape: found /
//                                  fetched-empty, rejected[] with why)
//   service_faults                 Hunter timeouts and errors
//
// ONE REASON PER CARD, the first that explains it, in this order:
//   never tried            no record of an address search for the business
//   timed out              a lookup step timed out
//   no website or domain   no confirmed website, so neither the site nor
//                          Hunter could be asked
//   verification: invalid  an address was found and its domain cannot receive mail
//   role address           the only address was a desk (info@, careers@...)
//   domain mismatch        the address was not on the business's domain
//   not the named person's an address was found, but not the greeted person's
//   found by web search    an address was found by search: a kind never sent to
//   owner name missing     Hunter knew the domain's pattern, nobody was named to build for
//   Hunter budget hit      Hunter was due to be asked and nothing was recorded,
//                          on a night the month's count may have been at the cap
//                          (inferred: a budget refusal writes nothing)
//   Hunter not asked       the same, on a night this month while the count is
//                          still under the cap, so the budget was not the cause
//   Hunter search empty    Hunter answered: no address at the domain
//   site scrape found nothing  the site was read (or could not be) and Hunter
//                          was not the step that missed
// One of the asked-for reasons cannot be the cause on a nightly card, and the
// report says so rather than print a zero that reads as "measured": the
// per-athlete verification budget, which applies only to drafts opened on
// Home. Before the email finder shipped, no mailbox verifier ran at night, so
// an unknown / catch-all verdict appears only on nights after it.

const REASONS = [
  'never tried', 'timed out', 'no website or domain found', 'email found but verification said invalid',
  'rejected as a role address', 'rejected as domain mismatch', "an address was found, but not the named person's",
  'found by web search (a kind never sent to)', 'owner name missing so no pattern guess', 'Hunter monthly budget hit (inferred)',
  'Hunter not asked, with no record why', 'Hunter domain search empty', 'site scrape found nothing',
  // Nights after the email finder shipped (services/emailFinder), read from
  // the finder's own record on the card.
  'verification said unknown / catch-all', 'verification could not run', 'every likely address tried, none verified',
  "a chain's corporate domain",
];
const NOT_POSSIBLE = {
  'per-athlete daily verify budget hit': 'cannot cause a DM or call card: that budget applies only to drafts opened on Home; the overnight fill verifies against the month\'s pool',
};

// "1:website, named person=miss (fetched-empty)" -> { n, label, state, detail }
function parseStep(s) {
  const m = String(s || '').match(/^(\d+):([^=]+)=(HIT|miss|skipped)(?:\s*\((.*)\))?$/);
  return m ? { n: Number(m[1]), label: m[2].trim(), state: m[3], detail: (m[4] || '').trim() } : null;
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; }
}
function rootOf(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  return /^(co|com|org|net)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
}

// One card -> { reason, detail, site }. Pure: lookups injected.
//   card: { channel, email_note, email_tier, lane }
//   tried: the night's queued entry for this business, or null
//   look: { hunter: Map(host -> {outcome, evidence}), site: Map(root -> evidence), hunterTimeouts: Set(host) }
function classify(card, tried, look = {}) {
  const why = tried && tried.why;
  const steps = (why && Array.isArray(why.addressSteps) ? why.addressSteps : []).map(parseStep).filter(Boolean);
  const step = (n) => steps.find((s) => s.n === n) || null;
  const s1 = step(1), s2 = step(2), s3 = step(3);
  const host = why && why.website ? hostOf(why.website) : null;
  const site = host ? (look.site && look.site.get(rootOf(host))) || null : null;
  const hunter = host ? (look.hunter && (look.hunter.get(host) || look.hunter.get(rootOf(host)))) || null : null;
  const siteOutcome = s1 ? (s1.state === 'HIT' ? 'found a person' : s1.detail || s1.state) : 'not run';
  const out = (reason, detail) => ({ reason, detail: detail || null, site: siteOutcome, host });

  if (!tried) return out('never tried', card.lane === 'program' ? 'a program card: no address search is made for it' : 'no record of this business in the night\'s run (an on-demand fill, or the run record is missing)');
  if (!why) return out('never tried', 'the run recorded the card with no address search');
  if (!steps.length && !why.finder) return out('never tried', 'the address ladder did not run for this business');
  // ── AFTER THE EMAIL FINDER: ITS OWN RECORD SAYS WHY ───────────────────
  const fin = why.finder;
  if (fin) {
    const ff = fin.finder || {};
    const st = String(ff.stop || '');
    if (/no website|no domain/.test(st)) return out('no website or domain found', st + (fin.website && fin.website.why ? `: ${fin.website.why}` : ''));
    if (/corporate|chain/.test(st)) return out("a chain's corporate domain", st);
    if (/could not run/.test(st)) return out('verification could not run', st);
    if (/catch-all/.test(st)) return out('verification said unknown / catch-all', st);
    if (/nobody named|no usable name/.test(st)) return out('owner name missing so no pattern guess', st);
    if (/no format verified/.test(st)) return out('every likely address tried, none verified', (ff.steps || []).slice(0, 4).join('; '));
    if (/greeting/.test(st)) return out("an address was found, but not the named person's", st);
    if (fin.verify && !fin.verify.pass) {
      const v = fin.verify.verdict;
      if (v === 'invalid') return out('email found but verification said invalid', `${fin.verify.email}: ${fin.verify.why || v}`);
      if (v === 'not-run') return out('verification could not run', `${fin.verify.email}: ${fin.verify.why || v}`);
      return out('verification said unknown / catch-all', `${fin.verify.email}: ${fin.verify.why || v}`);
    }
  }
  if (!steps.length) return out('never tried', 'the address ladder did not run for this business');
  if (steps.some((s) => /TIMEOUT|timed out/i.test(s.detail)) || (host && look.hunterTimeouts && look.hunterTimeouts.has(host))) {
    return out('timed out', (steps.find((s) => /TIMEOUT|timed out/i.test(s.detail)) || {}).detail || 'Hunter timed out for this domain');
  }
  if (!host || (s1 && /no confirmed website/i.test(s1.detail)) || why.websiteDropped) {
    return out('no website or domain found', why.websiteDropped ? `the website was dropped: ${why.websiteDropped.reason || why.websiteDropped.code}` : 'no confirmed website');
  }
  const undeliverable = (tried.emailCheck && tried.emailCheck.undeliverable) || [];
  if (undeliverable.length && !(why.ladderEmails || []).length) {
    return out('email found but verification said invalid', undeliverable.map((u) => `${u.email}: ${u.reason}`).join('; '));
  }
  const tier4 = (why.emailRoute && why.emailRoute.tier4Only) || Number(card.email_tier) === 4 || /generic mailbox/i.test(card.email_note || '');
  const roleRejected = site && Array.isArray(site.rejected) && site.rejected.some((r) => /never a NIL contact|role|generic/i.test(r.reason || ''));
  if (tier4 || (roleRejected && !(why.ladderEmails || []).length)) {
    return out('rejected as a role address', tier4 ? (card.email_note || 'the only address was a generic mailbox') : site.rejected.map((r) => `${r.raw}: ${r.reason}`).join('; '));
  }
  const mismatch = site && Array.isArray(site.rejected) && site.rejected.find((r) => /does not match/i.test(r.reason || ''));
  if (mismatch && !(why.ladderEmails || []).length) return out('rejected as domain mismatch', `${mismatch.raw}: ${mismatch.reason}`);
  if ((why.ladderEmails || []).length) return out("an address was found, but not the named person's", `${why.ladderEmails.length} sendable address(es) on the ladder, none on the greeted person's row or carrying their name`);
  if ((why.refusedKinds || []).includes('searched') || (s3 && s3.state === 'HIT')) return out('found by web search (a kind never sent to)', s3 ? s3.detail : 'a searched address');
  if (s2 && /nobody named to build/i.test(s2.detail)) return out('owner name missing so no pattern guess', hunter && hunter.evidence && hunter.evidence.pattern ? `Hunter's pattern for ${host}: ${hunter.evidence.pattern}` : s2.detail);
  if (s2 && s2.state === 'miss' && /no surname match and no pattern/i.test(s2.detail)) {
    // A budget refusal writes nothing. The month's count only rises, so a night
    // in this month while the count is still under the cap was not refused.
    if (!hunter) {
      if (look.underBudgetThisMonth && card.thisMonth) return out('Hunter not asked, with no record why', `Hunter was due to be asked for ${host}, nothing was recorded, and this month's count never reached the cap`);
      return out('Hunter monthly budget hit (inferred)', `Hunter was due to be asked for ${host} and nothing was recorded: a budget refusal writes nothing`);
    }
    const n = hunter.evidence && Array.isArray(hunter.evidence.emails) ? hunter.evidence.emails.length : 0;
    if (hunter.outcome === 'NONE' || !n) return out('Hunter domain search empty', `Hunter has no address at ${host}`);
    return out('Hunter domain search empty', `Hunter had ${n} address(es) at ${host}, none matching anyone named and no pattern to build from`);
  }
  if (s2 && /Hunter failed/i.test(s2.detail)) return out('timed out', s2.detail);
  return out('site scrape found nothing', `site: ${siteOutcome}${s2 ? `; Hunter: ${s2.state}${s2.detail ? ' (' + s2.detail + ')' : ''}` : ''}`);
}

// ── GATHER ──────────────────────────────────────────────────────────────────
async function gather(pool, { days = 7 } = {}) {
  const cards = (await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.brand_key, q.channel, q.lane, q.email_note, q.email_tier, q.created_at,
            q.contact_name, q.contact_title, q.instagram, q.instagram_scope, q.phone, q.business_category, q.email_verified, q.email,
            to_char((q.created_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS night,
            date_trunc('month', q.created_at) = date_trunc('month', NOW()) AS "thisMonth", u.name AS agent_name,
            a.data->>'name' AS athlete_name
       FROM outreach_queue q LEFT JOIN users u ON u.id = q.agent_id LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.created_at > NOW() - make_interval(days => $1)`, [days])).rows;
  const runs = (await pool.query(
    `SELECT agent_id, run_date, details FROM outreach_queue_runs WHERE run_date >= CURRENT_DATE - $1::int`, [days + 1])).rows;
  // agent|athlete|brand(lower) -> latest queued tried entry
  const triedOf = new Map();
  // ── PER NIGHT: EMAIL CARDS WITH A VERIFIED ADDRESS FOR THE NAMED PERSON ──
  // From the night's own record. A night before the email finder shipped has
  // no `why.finder` on its cards, so its email cards read "not verified".
  const nights = {};
  for (const r of runs) {
    const night = r.run_date instanceof Date ? r.run_date.toISOString().slice(0, 10) : String(r.run_date).slice(0, 10);
    for (const d of (Array.isArray(r.details) ? r.details : [])) {
      for (const t of (d && Array.isArray(d.tried) ? d.tried : [])) {
        if (!t || t.result !== 'queued' || !t.brand) continue;
        triedOf.set(`${r.agent_id}|${d.athleteId}|${String(t.brand).toLowerCase()}`, t);
        const n = (nights[night] = nights[night] || { cards: 0, emailVerified: 0, emailUnverified: 0, dm: 0, call: 0, other: 0, finderFound: 0, finderRan: 0 });
        n.cards++;
        const ch = t.why && t.why.channel;
        const f = t.why && t.why.finder;
        if (f) n.finderRan++;
        if (f && f.finder && f.finder.email && ch === 'email') n.finderFound++;
        if (ch === 'email') {
          const ok = f && ((f.verify && f.verify.pass) || (f.finder && f.finder.email));
          if (ok) n.emailVerified++; else n.emailUnverified++;
        } else if (ch === 'dm') n.dm++; else if (ch === 'call') n.call++; else n.other++;
      }
    }
  }
  const mine = cards.filter((c) => c.channel === 'dm' || c.channel === 'call');
  const hosts = new Set(), roots = new Set();
  for (const c of mine) {
    const t = triedOf.get(`${c.agent_id}|${c.athlete_id}|${String(c.brand_name || '').toLowerCase()}`);
    const h = t && t.why && t.why.website ? hostOf(t.why.website) : null;
    if (h) { hosts.add(h); hosts.add(rootOf(h)); roots.add(rootOf(h)); }
  }
  const hunter = new Map(), site = new Map();
  if (hosts.size) {
    for (const r of (await pool.query(`SELECT brand_key, outcome, evidence FROM brand_evidence_cache WHERE lane = 'hunter' AND brand_key = ANY($1::text[])`, [[...hosts]]).catch(() => ({ rows: [] }))).rows) hunter.set(r.brand_key, r);
  }
  if (roots.size) {
    for (const r of (await pool.query(`SELECT brand_key, evidence FROM brand_evidence_cache WHERE lane = 'siteemail' AND brand_key = ANY($1::text[])`,
      [[...roots].map((x) => `site:${x} | v3`)]).catch(() => ({ rows: [] }))).rows) site.set(String(r.brand_key).replace(/^site:/, '').replace(/ \| v3$/, ''), r.evidence || {});
  }
  const hunterTimeouts = new Set((await pool.query(
    `SELECT DISTINCT context FROM service_faults WHERE service ILIKE 'hunter%' AND at > NOW() - make_interval(days => $1) AND (reason ILIKE '%timed out%' OR reason ILIKE '%timeout%')`, [days])
    .catch(() => ({ rows: [] }))).rows.map((r) => String(r.context || '').replace(/^@/, '').toLowerCase()));
  let budget = null;
  try { budget = await require('./hunterLookup').budgetStatus(); } catch (_) { budget = null; }
  const look = { hunter, site, hunterTimeouts, underBudgetThisMonth: !!(budget && budget.used < budget.budget) };
  const rows = mine.map((c) => {
    const t = triedOf.get(`${c.agent_id}|${c.athlete_id}|${String(c.brand_name || '').toLowerCase()}`) || null;
    return { ...c, ...classify(c, t, look) };
  });
  const mix = cards.reduce((o, c) => { o[c.channel] = (o[c.channel] || 0) + 1; return o; }, {});
  // The night's email cards too, for the dry run's per-athlete before/after.
  const emailCards = cards.filter((c) => c.channel === 'email');
  return { days, cards: cards.length, mix, rows, budget, nights, emailCards };
}

// Hunter's own account numbers (/v2/account: free to call).
async function hunterAccount(fetchImpl) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { error: 'no HUNTER_API_KEY' };
  try {
    const r = await (fetchImpl || fetch)('https://api.hunter.io/v2/account?api_key=' + encodeURIComponent(key));
    const j = await r.json();
    const d = (j && j.data) || {};
    return { plan: d.plan_name || null, resetDate: d.reset_date || null,
      searches: d.requests && d.requests.searches ? { used: d.requests.searches.used, available: d.requests.searches.available } : null,
      verifications: d.requests && d.requests.verifications ? { used: d.requests.verifications.used, available: d.requests.verifications.available } : null,
      credits: d.requests && d.requests.credits ? { used: d.requests.credits.used, available: d.requests.credits.available } : null };
  } catch (e) { return { error: e.message }; }
}

function format(r, account) {
  const L = [];
  const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '-');
  const n = r.rows.length;
  L.push(`EMAIL FINDER: the last ${r.days} nights. ${r.cards} cards placed: ` + Object.entries(r.mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k} (${pct(v, r.cards)})`).join(', '));
  L.push('', `WHY ${n} DM AND CALL CARDS DID NOT GET AN EMAIL (one reason each, the first that explains it):`);
  const by = {};
  for (const x of r.rows) (by[x.reason] = by[x.reason] || []).push(x);
  for (const k of REASONS) L.push(`  ${String((by[k] || []).length).padStart(5)}  ${pct((by[k] || []).length, n).padStart(4)}  ${k}`);
  for (const [k, why] of Object.entries(NOT_POSSIBLE)) L.push(`      -        ${k}: ${why}`);
  const sites = {};
  for (const x of r.rows) sites[x.site] = (sites[x.site] || 0) + 1;
  L.push('', 'THE SITE SCRAPE ON THESE CARDS (step 1 of the address ladder):');
  for (const [k, v] of Object.entries(sites).sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(5)}  ${k}`);
  L.push('', 'HUNTER THIS MONTH:');
  if (r.budget) L.push(`  our count: ${r.budget.used} of the ${r.budget.budget} we allow (HUNTER_MONTHLY_BUDGET): ${r.budget.ladderUsed} domain searches, ${r.budget.verifyUsed} verifications; ${r.budget.remaining} left`);
  else L.push('  our count: could not be read');
  if (account) {
    if (account.error) L.push(`  Hunter's account: could not be read (${account.error})`);
    else {
      L.push(`  Hunter's account: plan ${account.plan || '?'}, resets ${account.resetDate || '?'}`);
      for (const k of ['credits', 'searches', 'verifications']) if (account[k]) L.push(`    ${k}: ${account[k].used} used of ${account[k].available}`);
    }
  }
  if (r.nights && Object.keys(r.nights).length) {
    L.push('', 'BY NIGHT (from the run record): email cards with a verified address for the named person');
    L.push('  night        cards  email-verified  email-unverified   dm  call  found-by-finder');
    for (const [k, n] of Object.entries(r.nights).sort((a, b) => b[0].localeCompare(a[0]))) {
      L.push(`  ${k}  ${String(n.cards).padStart(5)}  ${String(n.emailVerified).padStart(6)} (${pct(n.emailVerified, n.cards).padStart(4)})  ${String(n.emailUnverified).padStart(16)}  ${String(n.dm).padStart(3)}  ${String(n.call).padStart(4)}  ${String(n.finderFound).padStart(15)}${n.finderRan ? '' : '   (before the finder)'}`);
    }
  }
  L.push('', 'EXAMPLES (up to 5 per reason):');
  for (const k of REASONS) {
    const list = by[k] || [];
    if (!list.length) continue;
    L.push(`  ${k}:`);
    for (const x of list.slice(0, 5)) L.push(`    ${String(x.night).slice(0, 10)} ${String(x.agent_name || x.agent_id).slice(0, 18).padEnd(18)} ${String(x.brand_name).slice(0, 34).padEnd(34)} ${x.channel.padEnd(4)} ${x.detail ? String(x.detail).slice(0, 140) : ''}`);
  }
  return L.join('\n');
}

module.exports = { classify, gather, format, hunterAccount, parseStep, REASONS, NOT_POSSIBLE, hostOf, rootOf };
