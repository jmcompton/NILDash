'use strict';
// ── WHICH BUSINESSES TURN INTO A VERIFIED EMAIL ─────────────────────────────
//
// Learned from our own history. Every business the nightly fill took as far as
// the contact lookup is an attempt; it is a success when it ended in a verified
// address for a named person:
//   - the night's own record says so (the email finder marked it verifiedNamed),
//   - or the card it produced was an email card whose address the verifier
//     confirmed (outreach_queue.email_verified, or a valid email_verification),
//   - or a valid verification exists for an address at the business's domain
//     that carries the named contact's name (the dry run's finds land here).
//
// Each business TYPE (services/businessCategory) and each SIGNAL is scored by
// how often it ended that way:
//   website        a website confirmed as the business's own
//   placesWebsite  the Google Places record has a website field
//   ownerNamed     the person named is the owner (or founder, or an officer)
//   size           how big the business looks: about 5 or fewer, 6-10, 11+, or
//                  unknown. NOT an employee count -- nothing we hold has one.
//                  Hunter's headcount band where Hunter answered, else the
//                  number of people named at the business (site, ladder,
//                  Hunter). Recorded on each attempt from the night it ships.
//
// Rates are smoothed toward the overall rate (PRIOR_WEIGHT attempts of it), so
// a type seen twice cannot claim 100%. Recomputed weekly into
// reachability_model; admin script reachability-report prints it.
//
// USE (EMAIL_SMART_PICK): RANK, NEVER FILTER. A candidate's score only moves it
// ahead of others OF THE SAME TYPE (smartOrder); no type is ever dropped or
// pushed behind another type for being hard to reach.

const BC = require('./businessCategory');

const WINDOW_DAYS = parseInt(process.env.REACHABILITY_WINDOW_DAYS, 10) || 90;
const STALE_DAYS = 7;
const PRIOR_WEIGHT = 5;
const lc = (s) => String(s || '').trim().toLowerCase();

// ── CONTACT CLASS: OWNER, MARKETING LEAD, GM OR MANAGER ─────────────────────
// The contact order (EMAIL_SMART_PICK) and the dry run's shares read this.
const MARKETING = /\b(marketing|brand|partnership|sponsorship|promotions?|community|social media|communications|pr)\b/i;
function contactClass(title) {
  const CR = require('./contactRank');
  const t = String(title || '');
  const rank = CR.authorityOf(t).rank;
  if (MARKETING.test(t) && rank <= CR.RANK.MANAGER) return 'marketing';
  if (rank <= CR.RANK.OFFICER) return 'owner';
  if (rank <= CR.RANK.MANAGER) return 'gm';
  return 'other';
}
const CLASS_ORDER = { owner: 0, marketing: 1, gm: 2, other: 3 };

// ── SIZE: ABOUT 5 OR FEWER? ──────────────────────────────────────────────────
// headcount: Hunter's band ("1-10", "11-50"...) or null. people: distinct
// people named at the business. A chain, or a kind of business that is
// rarely that small, is never "about 5 or fewer".
const NEVER_TINY = new Set(['bank', 'dealership', 'education', 'insurance', 'realestate']);
function sizeBucket({ headcount, people, chain, type } = {}) {
  const n = Number(people) || 0;
  const hc = String(headcount || '').trim();
  if (chain) return '11+';
  if (/^(11|51|201|501|1001|5001|10001)/.test(hc)) return '11+';
  if (n >= 11) return '11+';
  if (n >= 6) return '6-10';
  if (NEVER_TINY.has(type)) return hc ? '6-10' : 'unknown';
  if (hc === '1-10' || n >= 1) return 'about 5 or fewer';
  return 'unknown';
}
function aboutFiveOrFewer(x) { return sizeBucket(x) === 'about 5 or fewer'; }

// ── ONE ATTEMPT'S SIGNALS, FROM THE RUN RECORD (pure) ───────────────────────
function signalsOfTried(t, card) {
  const why = (t && t.why) || {};
  const places = (t && t.places) || {};
  const type = (card && card.business_category) || BC.categoryOf({ primaryType: places.primaryType }).category || why.type || null;
  const title = (why.person && why.person.title) || (card && card.contact_title) || (why.finalName && why.finalName.title) || null;
  return {
    type: type || 'unknown',
    website: why.website ? 'yes' : 'no',
    placesWebsite: places.found === false ? 'unknown' : (places.hasWebsite ? 'yes' : 'no'),
    ownerNamed: title ? (contactClass(title) === 'owner' ? 'yes' : 'no') : 'no name',
    size: why.size || 'unknown',
  };
}

// ── THE MODEL ───────────────────────────────────────────────────────────────
// attempts: [{ signals, verified }] -> { overall, types, signals, n, computedAt }
function build(attempts, opts = {}) {
  const n = attempts.length;
  const v = attempts.filter((a) => a.verified).length;
  const overall = n ? v / n : 0;
  const smooth = (vv, nn) => (vv + PRIOR_WEIGHT * overall) / (nn + PRIOR_WEIGHT);
  const tally = (key) => {
    const m = {};
    for (const a of attempts) {
      const k = a.signals[key] || 'unknown';
      const e = (m[k] = m[k] || { attempts: 0, verified: 0 });
      e.attempts++; if (a.verified) e.verified++;
    }
    for (const e of Object.values(m)) { e.rate = e.attempts ? e.verified / e.attempts : 0; e.score = smooth(e.verified, e.attempts); }
    return m;
  };
  return { computedAt: new Date().toISOString(), windowDays: opts.windowDays || WINDOW_DAYS, attempts: n, verified: v, overall,
    types: tally('type'),
    signals: { website: tally('website'), placesWebsite: tally('placesWebsite'), ownerNamed: tally('ownerNamed'), size: tally('size') } };
}

// A candidate's chance, from its type and whichever signals are known: the
// type's smoothed rate, moved by each known signal's lift over the overall
// rate (in log-odds, so lifts add). Unknown signals add nothing.
const logit = (p) => Math.log(Math.max(1e-4, Math.min(1 - 1e-4, p)) / (1 - Math.max(1e-4, Math.min(1 - 1e-4, p))));
const unlogit = (x) => 1 / (1 + Math.exp(-x));
function scoreOf(model, s) {
  if (!model || !model.attempts) return null;
  const base = model.overall || 0.01;
  const t = model.types[s.type || 'unknown'];
  let x = logit(t ? t.score : base);
  for (const key of ['website', 'placesWebsite', 'ownerNamed', 'size']) {
    const val = s[key];
    if (!val || val === 'unknown') continue;
    const e = model.signals[key] && model.signals[key][val];
    if (e) x += logit(e.score) - logit(base);
  }
  return unlogit(x);
}

// ── RANK WITHIN TYPE, NEVER ACROSS ──────────────────────────────────────────
// Each type keeps exactly the positions it held in the slate; within those
// positions its candidates are put in order of score, best first. A type is
// never moved behind another and never dropped. Candidates of unknown type
// keep their places.
function smartOrder(cands, scoreFn) {
  const typeOf = (c) => (c && (c.businessCategory || c.business_category)) || null;
  const out = cands.slice();
  const groups = new Map();
  cands.forEach((c, i) => { const t = typeOf(c); if (!t) return; (groups.get(t) || groups.set(t, []).get(t)).push(i); });
  for (const idx of groups.values()) {
    const members = idx.map((i) => cands[i]);
    const scored = members.map((c, k) => ({ c, k, s: scoreFn(c) }));
    scored.sort((a, b) => ((b.s == null ? -1 : b.s) - (a.s == null ? -1 : a.s)) || (a.k - b.k));
    idx.forEach((pos, j) => { out[pos] = scored[j].c; });
  }
  return out;
}

// ── FROM OUR HISTORY ────────────────────────────────────────────────────────
async function gatherAttempts(pool, { days = WINDOW_DAYS } = {}) {
  const runs = (await pool.query(
    `SELECT agent_id, run_date, details FROM outreach_queue_runs WHERE run_date >= CURRENT_DATE - $1::int`, [days])).rows;
  const cards = (await pool.query(
    `SELECT q.agent_id, q.athlete_id, lower(q.brand_name) AS brand, q.channel, q.email, q.email_verified, q.contact_name, q.contact_title,
            q.business_category, v.result AS verdict
       FROM outreach_queue q LEFT JOIN email_verification v ON v.email = lower(q.email)
      WHERE q.created_at > NOW() - make_interval(days => $1)`, [days + 1])).rows;
  const cardOf = new Map(cards.map((c) => [`${c.agent_id}|${c.athlete_id}|${c.brand}`, c]));
  // Valid verdicts by domain, for the finds a card never carried (the dry run).
  const valid = (await pool.query(
    `SELECT email FROM email_verification WHERE result = 'valid' AND checked_at > NOW() - make_interval(days => $1)`, [days + 30])
    .catch(() => ({ rows: [] }))).rows.map((r) => r.email);
  const byDomain = new Map();
  for (const e of valid) { const d = e.split('@')[1]; if (d) (byDomain.get(d) || byDomain.set(d, []).get(d)).push(e.split('@')[0]); }
  const ET = require('./emailTier');
  const EP = require('./emailPattern');
  const carries = (local, name) => {
    const n = EP.splitName(name); if (!n) return false;
    const l = String(local).replace(/[^a-z]/g, '');
    return [n.first, n.last].filter((x) => x && x.length >= 3).some((x) => l.includes(x));
  };
  const attempts = [];
  const seen = new Set();
  for (const r of runs) {
    for (const d of (Array.isArray(r.details) ? r.details : [])) {
      for (const t of (d && Array.isArray(d.tried) ? d.tried : [])) {
        if (!t || !t.brand || !t.why) continue;                    // never reached the contact lookup
        if (t.result === 'deferred') continue;                     // decided by a later try
        const key = `${r.agent_id}|${d.athleteId}|${lc(t.brand)}`;
        const night = `${key}|${r.run_date instanceof Date ? r.run_date.toISOString().slice(0, 10) : r.run_date}`;
        if (seen.has(night)) continue;
        seen.add(night);
        const card = t.result === 'queued' ? cardOf.get(key) : null;
        const f = t.why.finder || null;
        let verified = !!(f && f.verifiedNamed);
        if (!verified && card && card.channel === 'email' && (card.email_verified || card.verdict === 'valid')) verified = true;
        if (!verified && t.why.website) {
          const dom = ET.rootDomain(t.why.website);
          const who = (card && card.contact_name) || (t.why.finalName && t.why.finalName.name) || (t.why.person && t.why.person.name) || null;
          if (dom && who && (byDomain.get(dom) || []).some((local) => carries(local, who))) verified = true;
        }
        attempts.push({ signals: signalsOfTried(t, card), verified });
      }
    }
  }
  return attempts;
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS reachability_model (
    id BIGSERIAL PRIMARY KEY, computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), window_days INT NOT NULL,
    attempts INT NOT NULL, model JSONB NOT NULL)`).catch((e) => console.error('[reachability] table:', e.message));
}

async function recompute(pool, opts = {}) {
  await ensureTable(pool);
  const days = opts.days || WINDOW_DAYS;
  const model = build(await gatherAttempts(pool, { days }), { windowDays: days });
  await pool.query(`INSERT INTO reachability_model (window_days, attempts, model) VALUES ($1, $2, $3)`, [days, model.attempts, JSON.stringify(model)]);
  _cache = { at: Date.now(), model };
  console.log(`[reachability] recomputed: ${model.attempts} attempt(s), ${model.verified} verified (${(model.overall * 100).toFixed(1)}%), ${Object.keys(model.types).length} type(s)`);
  return model;
}

let _cache = { at: 0, model: null };
async function latest(pool) {
  if (_cache.model && Date.now() - _cache.at < 10 * 60 * 1000) return _cache.model;
  await ensureTable(pool);
  const r = (await pool.query(`SELECT model FROM reachability_model ORDER BY computed_at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0];
  _cache = { at: Date.now(), model: r ? r.model : null };
  return _cache.model;
}

// Weekly. Called by a scheduler tick; recomputes only when the latest is a
// week old (or there is none).
async function recomputeIfStale(pool) {
  await ensureTable(pool);
  const r = (await pool.query(`SELECT computed_at FROM reachability_model ORDER BY computed_at DESC LIMIT 1`)).rows[0];
  if (r && Date.now() - new Date(r.computed_at).getTime() < STALE_DAYS * 86400000) return { skipped: 'fresh', computedAt: r.computed_at };
  return { model: await recompute(pool) };
}

// ── SIGNALS FOR CANDIDATES, BEFORE ANYTHING IS SPENT ────────────────────────
// Read only from what is already cached: the Places record (website field),
// the contacts lookup (a website, an owner named, how many people), Hunter's
// headcount for the domain. Free; a business never looked up has only its type.
async function candidateSignals(pool, cands) {
  const names = [...new Set((cands || []).map((c) => lc(c.brand_name)).filter(Boolean))];
  const out = new Map();
  if (!names.length) return out;
  const rows = (await pool.query(
    `SELECT DISTINCT ON (lower(brand), lane) lower(brand) AS b, lane, website, evidence
       FROM brand_evidence_cache WHERE lane IN ('places', 'contacts') AND lower(brand) = ANY($1::text[])
      ORDER BY lower(brand), lane, refreshed_at DESC`, [names]).catch(() => ({ rows: [] }))).rows;
  const by = new Map();
  for (const r of rows) { const e = by.get(r.b) || {}; e[r.lane] = r; by.set(r.b, e); }
  const ET = require('./emailTier');
  const domains = [];
  for (const [, e] of by) { const w = (e.contacts && e.contacts.website) || (e.places && e.places.website); if (w) domains.push(ET.rootDomain(w)); }
  const hc = new Map();
  if (domains.length) {
    for (const r of (await pool.query(`SELECT brand_key, evidence FROM brand_evidence_cache WHERE lane = 'hunter' AND brand_key = ANY($1::text[])`, [domains])
      .catch(() => ({ rows: [] }))).rows) hc.set(r.brand_key, r.evidence || {});
  }
  const NC = require('./nationalChains');
  for (const c of cands) {
    const b = lc(c.brand_name);
    const e = by.get(b) || {};
    const pev = (e.places && e.places.evidence) || null;
    const cev = (e.contacts && e.contacts.evidence) || null;
    const contacts = (cev && Array.isArray(cev.contacts)) ? cev.contacts : [];
    const site = (e.contacts && e.contacts.website) || (pev && pev.website) || null;
    const h = site ? hc.get(ET.rootDomain(site)) : null;
    const type = c.businessCategory || c.business_category || null;
    out.set(b, {
      type: type || 'unknown',
      website: e.contacts ? (e.contacts.website ? 'yes' : 'no') : 'unknown',
      placesWebsite: pev ? (pev.website ? 'yes' : 'no') : 'unknown',
      ownerNamed: cev ? (contacts.some((x) => x && x.name && contactClass(x.title) === 'owner') ? 'yes' : (contacts.some((x) => x && x.name) ? 'no' : 'no name')) : 'unknown',
      size: cev ? sizeBucket({ headcount: h && h.headcount, people: contacts.filter((x) => x && x.name).length, chain: !!NC.isChainLocation(c.brand_name), type }) : 'unknown',
    });
  }
  return out;
}

// ── THE REPORT ──────────────────────────────────────────────────────────────
function format(model) {
  if (!model) return 'REACHABILITY: no model yet. Run with recompute=1.';
  const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
  const L = [`REACHABILITY: which businesses turn into a verified email for a named person`,
    `Computed ${String(model.computedAt).slice(0, 16).replace('T', ' ')} UTC over the last ${model.windowDays} days: ${model.attempts} business(es) taken to the contact lookup, `
    + `${model.verified} ended in a verified named-person email (${pct(model.overall).trim()}).`,
    `Rates are smoothed toward the overall rate (${PRIOR_WEIGHT} attempts' worth), so a type seen twice cannot claim 100%.`,
    `Used by EMAIL_SMART_PICK to rank WITHIN a type only. No type is ever excluded or ranked behind another for being hard to reach.`, '',
    'BY BUSINESS TYPE                    tried  verified   rate  smoothed'];
  for (const [k, e] of Object.entries(model.types).sort((a, b) => b[1].score - a[1].score)) {
    L.push(`  ${k.padEnd(32)} ${String(e.attempts).padStart(6)}  ${String(e.verified).padStart(8)}  ${pct(e.rate)}  ${pct(e.score)}`);
  }
  const NAMES = { website: 'a website confirmed as theirs', placesWebsite: 'Places record has a website', ownerNamed: 'the person named is the owner', size: 'size (Hunter headcount, else people named; not an employee count)' };
  for (const [key, label] of Object.entries(NAMES)) {
    L.push('', `BY SIGNAL: ${label}`);
    for (const [k, e] of Object.entries(model.signals[key] || {}).sort((a, b) => b[1].score - a[1].score)) {
      L.push(`  ${k.padEnd(32)} ${String(e.attempts).padStart(6)}  ${String(e.verified).padStart(8)}  ${pct(e.rate)}  ${pct(e.score)}`);
    }
  }
  return L.join('\n');
}

module.exports = {
  build, scoreOf, smartOrder, contactClass, CLASS_ORDER, sizeBucket, aboutFiveOrFewer, signalsOfTried,
  gatherAttempts, recompute, recomputeIfStale, latest, candidateSignals, format, ensureTable, WINDOW_DAYS, PRIOR_WEIGHT,
  _resetCache: () => { _cache = { at: 0, model: null }; },
};
