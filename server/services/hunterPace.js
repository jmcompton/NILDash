'use strict';
// ── HUNTER, PACED TO THE RESET (HUNTER_PACE_ON) ─────────────────────────────
//
// Hunter ran out of credits on 2026-10-18 and the next two nights placed no
// cards at all. Nothing knew how much was left: the monthly ceilings
// (hunterLookup MONTHLY_BUDGET / VERIFY_MONTHLY_BUDGET) are our own counts
// against a number in an environment variable, blind to what the account
// really holds, to daytime use, and to the date the plan resets. The first
// night simply spent until Hunter said no.
//
// Now, before every nightly run, Hunter's own account endpoint (/v2/account,
// free) is read: credits left and the reset date. Tonight may use at most
//
//     (credits left - a 10% reserve) / nights until the reset
//
// The reserve is 10% of the period's credits (HUNTER_RESERVE_PCT), kept for
// daytime lookups and the send gate. Every Hunter call during the night is
// counted against that allowance where the credit is committed
// (hunterLookup.reserveCredit for searches, verifyEmail for verifications);
// past it, Hunter is not called again tonight and the night places cards
// from addresses already verified in the last 30 days instead (jobs/
// outreachQueue: cache mode), so a night is never empty.
//
// A plan billed in CREDITS (Hunter's current plans) is one pool: a search
// costs HUNTER_SEARCH_CREDIT (1), a verification HUNTER_VERIFY_CREDIT (0.5).
// A plan billed in searches and verifications separately is two pools, each
// with its own allowance; a search draws only on searches.
//
// The 5:30am email (services/shortOfFive) carries the night's line, a loud
// warning under HUNTER_WARN_CREDITS (300), and the admin is alerted the
// moment the period's burn rate is on track to run out before the reset.
//
// OFF UNLESS HUNTER_PACE_ON=1. Off, nothing here runs and the night is as
// before.

const ON = () => process.env.HUNTER_PACE_ON === '1';
const DAY = 86400000;
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const RESERVE_PCT = () => num(process.env.HUNTER_RESERVE_PCT, 0.10);
const WARN_BELOW = () => num(process.env.HUNTER_WARN_CREDITS, 300);
const COST = () => ({ search: num(process.env.HUNTER_SEARCH_CREDIT, 1), verify: num(process.env.HUNTER_VERIFY_CREDIT, 0.5) });
const CENTRAL_TZ = 'America/Chicago';
const ACCOUNT_URL = 'https://api.hunter.io/v2/account';
// Cache mode takes an address verified valid no longer ago than this.
const CACHE_DAYS = 30;

// The Central date: the nightly run's date (jobs/outreachQueue today()).
function centralDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CENTRAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now == null ? Date.now() : now));
}

let _table = null;
function ensureTable(pool) {
  if (_table) return _table;
  _table = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hunter_nights (
        run_date    DATE PRIMARY KEY,
        started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at    TIMESTAMPTZ,
        account     JSONB,
        plan        JSONB,
        spent       JSONB,
        cache_only  BOOLEAN NOT NULL DEFAULT FALSE,
        cache_why   TEXT,
        cache_at    TIMESTAMPTZ
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hunter_pace_alerts (
        alert_date  DATE NOT NULL,
        kind        TEXT NOT NULL,
        subject     TEXT,
        body        TEXT,
        sent_at     TIMESTAMPTZ,
        error       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (alert_date, kind)
      )`);
  })().catch((e) => { _table = null; console.error('[hunter-pace] tables: ' + e.message); });
  return _table;
}

// ── THE ACCOUNT, AS HUNTER SAYS IT ──────────────────────────────────────────
// -> { ok, plan, resetDate, credits?, searches?, verifications? } each pool
//    { used, available, left }; or { ok: false, error }.
function poolOf(p) {
  if (!p || !Number.isFinite(Number(p.available))) return null;
  const used = Number(p.used) || 0, available = Number(p.available);
  return { used, available, left: Math.max(0, available - used) };
}
function parseAccount(json) {
  const d = (json && json.data) || null;
  if (!d) return { ok: false, error: (json && json.errors && json.errors[0] && (json.errors[0].details || json.errors[0].id)) || 'no account data' };
  const rq = d.requests || {};
  const out = { ok: true, plan: d.plan_name || null, resetDate: d.reset_date ? String(d.reset_date).slice(0, 10) : null,
    credits: poolOf(rq.credits), searches: poolOf(rq.searches), verifications: poolOf(rq.verifications) };
  if (!out.credits && !out.searches && !out.verifications) return { ok: false, error: 'the account answered with no request counts' };
  return out;
}
async function readAccount(fetchImpl) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ok: false, error: 'HUNTER_API_KEY is not set' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await (fetchImpl || fetch)(ACCOUNT_URL + '?api_key=' + encodeURIComponent(key), { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: `Hunter answered HTTP ${r.status}${j && j.errors && j.errors[0] ? ': ' + (j.errors[0].details || j.errors[0].id) : ''}` };
    return parseAccount(j);
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'Hunter did not answer in 10s' : e.message }; }
}

// When the account endpoint does not answer: our own counts against the
// ceilings, over the same window the counters use (services/hunterPeriod):
// Hunter's billing period from the last answer that still covers today, else
// the calendar month. Said so wherever it is shown.
async function estimateAccount(now) {
  const H = require('./hunterLookup');
  const b = await H.budgetStatus().catch(() => null);
  if (!b) return null;
  const next = require('./hunterPeriod').current({ now }).resetDate;
  return { ok: true, estimated: true, plan: null, resetDate: next,
    searches: { used: b.used, available: b.budget, left: b.remaining },
    verifications: { used: b.verifyUsed, available: b.verifyBudget, left: b.verifyRemaining } };
}

// ── TONIGHT'S ALLOWANCE. Pure. ──────────────────────────────────────────────
// Nights until the reset: tonight and every night before the reset date (the
// run on the reset date itself has the new period's credits).
function nightsUntil(resetDate, runDate) {
  if (!resetDate) return 30;
  const a = Date.parse(String(runDate).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(resetDate).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 30;
  return Math.max(1, Math.round((b - a) / DAY));
}
// The pools the plan bills, and what a search or a verification draws on each.
function poolsOf(account) {
  const c = COST();
  if (account.credits) return [{ key: 'credits', unit: 'credits', ...account.credits, charges: { search: c.search, verify: c.verify } }];
  const out = [];
  if (account.searches) out.push({ key: 'searches', unit: 'searches', ...account.searches, charges: { search: 1 } });
  if (account.verifications) out.push({ key: 'verifications', unit: 'verifications', ...account.verifications, charges: { verify: 1 } });
  return out;
}
// -> { runDate, resetDate, nights, pools: [{ key, unit, left, available, reserve, allowance, warn }], warn, estimated }
function planFor(account, { runDate, reservePct = RESERVE_PCT(), warnBelow = WARN_BELOW() } = {}) {
  const nights = nightsUntil(account.resetDate, runDate);
  const pools = poolsOf(account).map((p) => {
    const reserve = Math.ceil((p.available || 0) * reservePct);
    const allowance = Math.max(0, Math.floor((p.left - reserve) / nights));
    return { key: p.key, unit: p.unit, used: p.used, left: p.left, available: p.available, reserve, allowance, charges: p.charges,
      warn: p.left < warnBelow };
  });
  return { runDate, resetDate: account.resetDate || null, nights, pools, warn: pools.some((p) => p.warn),
    estimated: !!account.estimated, plan: account.plan || null };
}

// ── ON TRACK TO RUN OUT BEFORE THE RESET? Pure. ─────────────────────────────
// The period's burn rate so far (used / days since the period began, the
// period being the month before the reset), carried to the reset date.
function projection(account, now) {
  const t = now == null ? Date.now() : new Date(now).getTime();
  if (!account || !account.resetDate) return [];
  const reset = Date.parse(account.resetDate + 'T00:00:00Z');
  const start = require('./hunterPeriod').monthBefore(account.resetDate).getTime();
  const elapsed = Math.max(1, (t - start) / DAY);
  const daysLeft = Math.max(0, (reset - t) / DAY);
  return poolsOf(account).map((p) => {
    const perDay = p.used / elapsed;
    const projected = Math.round(perDay * daysLeft);
    const runsOutIn = perDay > 0 ? p.left / perDay : Infinity;
    return { key: p.key, unit: p.unit, left: p.left, perDay: Math.round(perDay * 10) / 10, projected, daysLeft: Math.round(daysLeft * 10) / 10,
      runsOut: perDay > 0 && runsOutIn < daysLeft,
      runsOutOn: perDay > 0 && runsOutIn < daysLeft ? new Date(t + runsOutIn * DAY).toISOString().slice(0, 10) : null };
  });
}

// ── THE NIGHT ───────────────────────────────────────────────────────────────
let _night = null;   // { runDate, startedAt, plan, spent: { search, verify }, cacheOnly, cacheWhy, cacheAt }
// The 15-minute tick can start a run while the last is still going: the night
// stays open until the last of them ends.
let _refs = 0;

function unitsSpent(pool, spent) {
  return (spent.search || 0) * (pool.charges.search || 0) + (spent.verify || 0) * (pool.charges.verify || 0);
}

// Read from our own records since the night began, so a restart mid-night
// starts from what was really spent, not from zero.
async function spentSince(pool, since) {
  const H = require('./hunterLookup');
  const s = await pool.query(
    `SELECT COUNT(*)::int AS n FROM brand_evidence_cache WHERE lane = ANY($1::text[]) AND outcome <> 'NO_KEY' AND refreshed_at >= $2`,
    [H.SEARCH_LANES, since]).catch(() => ({ rows: [{ n: 0 }] }));
  const v = await pool.query(`SELECT COUNT(*)::int AS n FROM email_verify_credit_log WHERE checked_at >= $1`, [since])
    .catch(() => ({ rows: [{ n: 0 }] }));
  return { search: s.rows[0].n, verify: v.rows[0].n };
}

// Before every nightly run (jobs/outreachQueue run()). The first call of a
// run date reads the account and fixes tonight's allowance; a later call the
// same night (the next 15-minute tick, a restart) keeps it.
async function beginNight(pool, opts = {}) {
  if (!ON()) return null;
  await ensureTable(pool);
  const runDate = opts.runDate || centralDate(opts.now);
  if (_night && _night.runDate === runDate) { _refs++; return _night; }
  _refs = 1;
  const row = (await pool.query(`SELECT * FROM hunter_nights WHERE run_date = $1`, [runDate])).rows[0];
  if (row && row.plan) {
    const spent = await spentSince(pool, row.started_at);
    _night = { runDate, startedAt: row.started_at, plan: row.plan, account: row.account, spent,
      cacheOnly: !!row.cache_only, cacheWhy: row.cache_why || null, cacheAt: row.cache_at || null };
    checkAllowance();
    return _night;
  }
  let account = await readAccount(opts.fetchImpl);
  require('./hunterPeriod').noteAccount(account, opts.now);
  let readError = null;
  if (!account.ok) {
    readError = account.error;
    console.error(`[hunter-pace] the account endpoint did not answer (${readError}); pacing on our own counts`);
    account = await estimateAccount(opts.now) || { ok: false, error: readError };
  }
  const plan = account.ok ? planFor(account, { runDate }) : { runDate, resetDate: null, nights: null, pools: [], unknown: true };
  if (readError) plan.readError = readError;
  // OUR OWN COUNT, over the same window (services/hunterPeriod), for the 5:30
  // line: a counter that disagrees with Hunter shows up there, not in a log.
  const ours = await require('./hunterLookup').budgetStatus().catch(() => null);
  if (ours) plan.ourCount = { since: ours.periodStart, from: ours.periodFrom, searches: ours.used, searchBudget: ours.budget, verifications: ours.verifyUsed, verifyBudget: ours.verifyBudget };
  const started = new Date(opts.now == null ? Date.now() : opts.now);
  await pool.query(
    `INSERT INTO hunter_nights (run_date, started_at, account, plan, spent) VALUES ($1,$2,$3::jsonb,$4::jsonb,'{}'::jsonb)
     ON CONFLICT (run_date) DO NOTHING`, [runDate, started, JSON.stringify(account), JSON.stringify(plan)]);
  _night = { runDate, startedAt: started, plan, account, spent: { search: 0, verify: 0 }, cacheOnly: false, cacheWhy: null, cacheAt: null };
  const line = plan.pools.map((p) => `${p.left} ${p.unit} left, allowance ${p.allowance}`).join('; ');
  console.log(`[hunter-pace] ${runDate}: ${line || 'no plan'}; resets ${plan.resetDate || '?'} (${plan.nights || '?'} nights)${plan.estimated ? ' [our own count]' : ''}`);
  checkAllowance();
  if (account.ok) await alertIfRunningOut(pool, account, { now: opts.now, send: opts.send }).catch((e) => console.error('[hunter-pace] alert: ' + e.message));
  return _night;
}

// After the run: what tonight spent, on the row the 5:30 email reads.
async function endNight(pool, opts = {}) {
  if (!_night) return null;
  const n = _night;
  _refs = Math.max(0, _refs - 1);
  await pool.query(
    `UPDATE hunter_nights SET ended_at = NOW(), spent = $2::jsonb, cache_only = $3, cache_why = $4, cache_at = $5 WHERE run_date = $1`,
    [n.runDate, JSON.stringify(n.spent), n.cacheOnly, n.cacheWhy, n.cacheAt]).catch((e) => console.error('[hunter-pace] end: ' + e.message));
  if (opts.keep !== true && _refs === 0) _night = null;
  // What the night spent may have put the period on track to run out.
  if (_refs === 0 && opts.check !== false) {
    const account = await readAccount(opts.fetchImpl);
    require('./hunterPeriod').noteAccount(account, opts.now);
    if (account.ok) await alertIfRunningOut(pool, account, { now: opts.now, send: opts.send }).catch((e) => console.error('[hunter-pace] alert: ' + e.message));
  }
  return n;
}

// Every pool tonight's allowance is spent on (or none left at all).
function checkAllowance() {
  const n = _night;
  if (!n || n.cacheOnly || !n.plan || !Array.isArray(n.plan.pools) || !n.plan.pools.length) return;
  const out = n.plan.pools.filter((p) => unitsSpent(p, n.spent) >= p.allowance);
  // Cache mode once NOTHING can be spent: a credits plan's one pool, or the
  // verification pool on a split plan (no card without a verification).
  const blocking = out.find((p) => p.key === 'credits' || p.key === 'verifications');
  if (blocking) markExhausted(`tonight's Hunter allowance is spent (${unitsSpent(blocking, n.spent)} of ${blocking.allowance} ${blocking.unit})`);
}

// CHECK AND COUNT IN ONE SYNCHRONOUS STEP: athletes run side by side.
// kind: 'search' | 'verify' -> { ok, why? }
function take(kind) {
  const n = _night;
  if (!ON() || !n || !n.plan || !Array.isArray(n.plan.pools)) return { ok: true };
  for (const p of n.plan.pools) {
    const cost = p.charges[kind] || 0;
    if (!cost) continue;
    if (unitsSpent(p, n.spent) + cost > p.allowance + 1e-9) {
      const why = `tonight's Hunter allowance is spent (${p.allowance} ${p.unit}: ${p.left} left, ${p.reserve} held in reserve, ${n.plan.nights} night(s) to the reset on ${n.plan.resetDate || '?'})`;
      if (kind === 'verify' || p.key === 'credits') markExhausted(why);
      return { ok: false, why, pace: true };
    }
  }
  n.spent[kind] = (n.spent[kind] || 0) + 1;
  checkAllowance();
  return { ok: true };
}
// Would `take` refuse? No count. For a caller that writes its own credit
// log row first (emailFinder.liveDeps).
function blocked(kind) {
  const n = _night;
  if (!ON() || !n || !n.plan || !Array.isArray(n.plan.pools)) return null;
  for (const p of n.plan.pools) {
    const cost = p.charges[kind] || 0;
    if (cost && unitsSpent(p, n.spent) + cost > p.allowance + 1e-9) return `tonight's Hunter allowance is spent (${p.allowance} ${p.unit})`;
  }
  return null;
}

// Hunter itself said the plan is out (a 429 that is not "too fast"), or the
// allowance is spent: the rest of the night is cache mode.
function markExhausted(why) {
  const n = _night;
  if (!n || n.cacheOnly) return;
  n.cacheOnly = true; n.cacheWhy = String(why || 'Hunter credits exhausted').slice(0, 300); n.cacheAt = new Date();
  console.warn(`[hunter-pace] ${n.runDate}: cache mode from now: ${n.cacheWhy}`);
}
function cacheOnly() { return !!(ON() && _night && _night.cacheOnly); }
function night() { return _night; }

// ── CACHE MODE: WHICH BUSINESSES CAN STILL BECOME A VERIFIED EMAIL CARD ─────
// Every business with an address verified valid in the last 30 days: one a
// card was placed for (any athlete), or one whose address a check was paid
// for (the verification credit log names the business). Lowercased names.
async function cachedBrands(pool, { days = CACHE_DAYS } = {}) {
  const r = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(x.brand)) AS b
       FROM (SELECT q.brand_name AS brand, q.email FROM outreach_queue q
              WHERE q.email IS NOT NULL AND q.brand_name IS NOT NULL
             UNION ALL
             SELECT c.business AS brand, c.email FROM email_verify_credit_log c
              WHERE c.business IS NOT NULL AND c.checked_at > NOW() - make_interval(days => $1)) x
       JOIN email_verification v ON v.email = LOWER(TRIM(x.email))
      WHERE v.result = 'valid' AND v.checked_at > NOW() - make_interval(days => $1)`, [days])
    .catch((e) => { console.error('[hunter-pace] cached brands: ' + e.message); return { rows: [] }; });
  return new Set(r.rows.map((x) => x.b).filter(Boolean));
}

// ── THE ALERT, THE MOMENT IT IS ON TRACK TO RUN OUT ─────────────────────────
// Once per Central date per pool.
const TO = () => process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || '';
const FROM = () => process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
async function _send(msg) {
  if (!TO()) throw new Error('no alert destination: neither ADMIN_ALERT_EMAIL nor ADMIN_EMAIL is set');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: FROM(), to: TO(), subject: msg.subject, text: msg.text });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}
async function alertIfRunningOut(pool, account, opts = {}) {
  if (!ON() || !account || !account.ok) return [];
  await ensureTable(pool);
  const day = centralDate(opts.now);
  const sent = [];
  for (const p of projection(account, opts.now)) {
    if (!p.runsOut) continue;
    const subject = `NILDash: Hunter is on track to run out of ${p.unit} on ${p.runsOutOn}, before the reset on ${account.resetDate}`;
    const text = [
      `Hunter ${p.unit}: ${p.left} left, resets ${account.resetDate} (${p.daysLeft} days).`,
      `This period has used about ${p.perDay} a day. At that rate it runs out on ${p.runsOutOn}, and the nights after that place cards only from addresses already verified (cache mode).`,
      `Needed to the reset at this rate: ~${p.projected}. Left: ${p.left}.`,
      ON() ? 'The nightly allowance caps the nights; this burn is coming from somewhere else too (daytime lookups, the send gate, manual runs), or the allowance was set before a large spend.' : '',
      'Breakdown: /api/admin/scripts/spend-breakdown?text=1  |  Hunter usage: /api/admin/scripts/email-finder-report?text=1&days=7',
    ].filter(Boolean).join('\n');
    const claim = await pool.query(
      `INSERT INTO hunter_pace_alerts (alert_date, kind, subject, body) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING kind`,
      [day, 'runout:' + p.key, subject, text]);
    if (!claim.rowCount) continue;
    try {
      await (opts.send || _send)({ subject, text });
      await pool.query(`UPDATE hunter_pace_alerts SET sent_at = NOW() WHERE alert_date = $1 AND kind = $2`, [day, 'runout:' + p.key]);
      sent.push(p.key);
    } catch (e) {
      console.error('[hunter-pace] RUN-OUT ALERT NOT SENT: ' + e.message);
      await pool.query(`UPDATE hunter_pace_alerts SET error = $3 WHERE alert_date = $1 AND kind = $2`, [day, 'runout:' + p.key, String(e.message).slice(0, 300)]);
    }
  }
  return sent;
}

// The hourly check (index.js): daytime use can put the period on track to
// run out between nights. The account read is free.
async function tick(pool, opts = {}) {
  if (!ON()) return { skipped: 'HUNTER_PACE_ON is not set' };
  const account = await readAccount(opts.fetchImpl);
  require('./hunterPeriod').noteAccount(account, opts.now);
  if (!account.ok) return { error: account.error };
  return { alerted: await alertIfRunningOut(pool, account, opts) };
}

// ── THE 5:30 LINE ───────────────────────────────────────────────────────────
// For a run date: the night's row, rendered. -> { lines: [], warn, cacheOnly } | null
async function morningLines(pool, runDate) {
  if (!ON()) return null;
  await ensureTable(pool);
  const row = (await pool.query(`SELECT * FROM hunter_nights WHERE run_date = $1`, [runDate]).catch(() => ({ rows: [] }))).rows[0];
  return renderMorning(row || null, runDate);
}
function fmt(n) { return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString(); }
function renderMorning(row, runDate) {
  const L = [];
  if (!row || !row.plan) {
    L.push(`Hunter: no record for ${runDate}: the nightly run did not start, or HUNTER_PACE_ON was off for it.`);
    return { lines: L, warn: false, cacheOnly: false };
  }
  const plan = row.plan, spent = row.spent || {};
  if (plan.unknown) L.push(`Hunter: the account could not be read (${plan.readError || 'no answer'}), and there was no count of our own to pace on.`);
  // Left NOW: what the account held before the night, less what it spent.
  const pools = (plan.pools || []).map((p) => {
    const used = unitsSpent(p, { search: spent.search || 0, verify: spent.verify || 0 });
    return { ...p, used, leftNow: Math.max(0, Math.floor(p.left - used)) };
  });
  for (const p of pools) {
    L.push(`Hunter: ${p.leftNow} ${p.unit} left, resets ${plan.resetDate || '?'}, tonight's allowance ${p.allowance}`
      + ` (used ${fmt(p.used)} tonight; ${p.reserve} held in reserve; ${plan.nights} night${plan.nights === 1 ? '' : 's'} to the reset)`
      + (plan.estimated ? ' [estimated from our own count: the account endpoint did not answer]' : ''));
  }
  const oc = plan.ourCount;
  if (oc) {
    L.push(`Our own count since ${oc.since}${oc.from === 'calendar' ? ' (the calendar month: the account could not be read)' : ''}: `
      + `${oc.searches} of ${oc.searchBudget} searches, ${oc.verifications} of ${oc.verifyBudget} verifications.`);
  }
  const low = pools.filter((p) => p.leftNow < WARN_BELOW());
  for (const p of low) {
    L.push(`!!! HUNTER IS LOW: ${p.leftNow} ${p.unit} left, under ${WARN_BELOW()}. Top up the plan or expect nights placed from cached addresses only. !!!`);
  }
  if (row.cache_only) {
    L.push(`Cache mode from ${row.cache_at ? new Date(row.cache_at).toISOString().slice(11, 16) + ' UTC' : 'the start'}: ${row.cache_why || 'Hunter credits exhausted'}. `
      + 'After that, cards were placed only from addresses already verified in the last 30 days.');
  }
  return { lines: L, warn: low.length > 0, cacheOnly: !!row.cache_only };
}

module.exports = {
  ON, ensureTable, readAccount, parseAccount, estimateAccount, nightsUntil, poolsOf, planFor, projection,
  beginNight, endNight, take, blocked, markExhausted, cacheOnly, night, alertIfRunningOut, tick, morningLines, renderMorning,
  centralDate, COST, RESERVE_PCT, WARN_BELOW, CACHE_DAYS, cachedBrands, _reset: () => { _night = null; _refs = 0; },
};
