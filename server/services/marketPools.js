'use strict';
// ── EVERY ATHLETE MARKET HAS A POOL, WHETHER OR NOT ANYONE RAN A DEAL SCAN ───
//
// market_business_seen is what the nightly local lane selects from. It used to
// be filled ONLY as a side effect of Deal Scan: a market nobody scanned had no
// pool at all, and the nightly job had nothing to choose from. Most accounts had
// never opened Deal Scan, and a 30-athlete agent had run it twice. The promise
// is that the agent does nothing and wakes up to pitches; that cannot depend on
// the agent having prospected first.
//
// This is the scheduled build. Once a night, before the nightly window, it
// lists every athlete market (the same market the nightly job resolves, so the
// key it writes is the key the Scout reads), counts the USABLE businesses in
// each, and builds from Google Places the ones that need it:
//
//   empty   no usable row at all                       first, always
//   thin    under TARGET usable businesses             next, fewest first; the
//           radius widens (RADII) until TARGET or the widest ring
//   stale   last built more than REFRESH_DAYS ago      last
//
// "Usable" is a row the nightly lane could draw: not a national brand from the
// social index, not a collective, not a restricted category by name or kind.
//
// A run stops at MAX_MARKETS markets or MAX_PLACES_CALLS requests, whichever
// comes first, and says which. What is left is due tomorrow, in the same order.
// Every build, failed or not, is on market_pool_schedule and (from
// placesMarket) on places_market_builds, which the morning alert reads.
//
// Pros are listed and counted but not built here: Deal Scan deliberately keeps
// the Places small-business pool away from pros (their pool comes from the pro
// web-search passes), and this job does not change that rule on its own.
const PM = require('./placesMarket');

const TARGET = parseInt(process.env.MARKET_POOL_TARGET, 10) || 150;
const REFRESH_DAYS = parseInt(process.env.MARKET_POOL_REFRESH_DAYS, 10) || 30;
// A market that stayed thin at the widest ring is small, not unbuilt: it is
// tried again after this many days, not every night.
const THIN_RETRY_DAYS = parseInt(process.env.MARKET_POOL_THIN_RETRY_DAYS, 10) || 7;
const RADII = String(process.env.MARKET_POOL_RADII_M || '8000,16000,24000').split(',')
  .map((x) => parseInt(x, 10)).filter((x) => x > 0);
const MAX_MARKETS = parseInt(process.env.MARKET_POOL_MAX_MARKETS, 10) || 25;
const MAX_PLACES_CALLS = parseInt(process.env.MARKET_POOL_MAX_PLACES_CALLS, 10) || 3000;
// The hour (Central) the nightly build may start: before the 1am fill.
const WINDOW_START_HOUR = 22, WINDOW_END_HOUR = 24;

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_pool_schedule (
      market_key    TEXT PRIMARY KEY,
      query         TEXT,
      region        TEXT,
      last_built_at TIMESTAMPTZ,
      last_ok       BOOLEAN,
      last_reason   TEXT,
      radius_m      INT,
      pool_size     INT,
      usable        INT,
      places_calls  INT DEFAULT 0,
      builds        INT DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_pool_runs (
      run_date    DATE PRIMARY KEY,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      summary     JSONB
    )`);
}

// ── THE MARKETS ─────────────────────────────────────────────────────────────
// Every athlete of every agent who is not archived. Resolved exactly as the
// nightly job resolves them (jobs/outreachQueue.localContextFor), so a pool is
// written under the key the Scout will read. Inactive agents are included: a
// pool built today is there the night they come back.
async function athleteMarkets(pool, opts = {}) {
  const resolve = opts.resolve || require('../jobs/outreachQueue').localContextFor;
  const PL = require('./proLane');
  const rows = (await pool.query(
    `SELECT a.id, a.data, a.agent_id, u.name AS agent_name
       FROM athletes a JOIN users u ON u.id = a.agent_id
      WHERE u.role IN ('agent','admin') AND u.archived IS NOT TRUE
      ORDER BY a.created_at ASC`)).rows;
  const byKey = new Map();
  const noMarket = [];
  for (const r of rows) {
    const name = (r.data && r.data.name) || r.id;
    let ctx;
    try { ctx = await resolve(r); } catch (e) { ctx = { profile: {}, fault: e.message }; }
    const p = (ctx && ctx.profile) || {};
    if (!p.marketKey) { noMarket.push({ athlete: name, agent: r.agent_name, why: ctx.fault || p.localLaneNote || 'no market' }); continue; }
    const pro = PL.isPro(p) || PL.isPro(r.data || {});
    if (!byKey.has(p.marketKey)) {
      byKey.set(p.marketKey, { key: p.marketKey, region: p.market, query: null, pro: true, athletes: [], agents: new Set() });
    }
    const m = byKey.get(p.marketKey);
    m.athletes.push(name);
    m.agents.add(r.agent_name || r.agent_id);
    // A college athlete's SCHOOL is the best query: Places resolves the campus.
    // A market with only pros is marked pro and not built (see the header).
    if (!pro) { m.pro = false; if (!m.query && p.school) m.query = p.school; }
  }
  for (const m of byKey.values()) { if (!m.query) m.query = m.region; m.agents = [...m.agents]; }
  return { markets: [...byKey.values()], noMarket, athletes: rows.length };
}

// ── USABLE ROWS PER MARKET ──────────────────────────────────────────────────
function usableRow(brand, category) {
  const C = require('./compliance');
  const cls = C.classifyBusiness(brand, { category });
  return !(cls.hits || []).length;
}
async function usableCounts(pool, keys) {
  const out = new Map(keys.map((k) => [k, { rows: 0, usable: 0, newest: null }]));
  if (!keys.length) return out;
  const r = await pool.query(
    `SELECT m.market_key, m.brand, m.category, m.last_seen_at,
            EXISTS (SELECT 1 FROM social_brands sb WHERE LOWER(sb.brand) = LOWER(m.brand)) AS national
       FROM market_business_seen m WHERE m.market_key = ANY($1::text[])`, [keys]);
  for (const row of r.rows) {
    const o = out.get(row.market_key);
    o.rows++;
    if (!o.newest || row.last_seen_at > o.newest) o.newest = row.last_seen_at;
    if (!row.national && usableRow(row.brand, row.category)) o.usable++;
  }
  return out;
}

// ── WHAT IS DUE ─────────────────────────────────────────────────────────────
const DAY = 86400000;
function planOf(markets, counts, schedule, now) {
  const t = now ? new Date(now).getTime() : Date.now();
  const plan = [];
  for (const m of markets) {
    const c = counts.get(m.key) || { rows: 0, usable: 0, newest: null };
    const s = schedule.get(m.key) || null;
    const lastAt = s && s.last_built_at ? new Date(s.last_built_at).getTime() : null;
    const age = lastAt != null ? (t - lastAt) / DAY : (c.newest ? (t - new Date(c.newest).getTime()) / DAY : Infinity);
    const widest = RADII[RADII.length - 1];
    let status, due = false, why;
    if (c.usable === 0) {
      status = 'empty'; due = true; why = c.rows ? `${c.rows} row(s), none usable` : 'no rows at all';
    } else if (c.usable < TARGET) {
      status = 'thin';
      const smallAtWidest = s && s.last_ok && s.radius_m >= widest;
      due = !smallAtWidest ? true : age >= THIN_RETRY_DAYS;
      why = `${c.usable} usable, under ${TARGET}` + (smallAtWidest ? ` at the widest ring (${Math.round(widest / 1000)} km); retried every ${THIN_RETRY_DAYS} days` : '');
    } else if (age >= REFRESH_DAYS) {
      status = 'stale'; due = true; why = `${c.usable} usable, last built ${Number.isFinite(age) ? Math.floor(age) + ' days ago' : 'never by this job'}`;
    } else {
      status = 'ok'; why = `${c.usable} usable, built ${Math.floor(age)} day(s) ago`;
    }
    if (s && s.last_ok === false) why += `; last build FAILED: ${s.last_reason || 'unknown'}`;
    if (m.pro) { due = false; why += '; pro-only market, not built here'; }
    plan.push({ ...m, status, due, why, rows: c.rows, usable: c.usable,
      startRadius: status === 'thin' && s && s.radius_m && s.last_ok ? nextRadius(s.radius_m) || s.radius_m : RADII[0] });
  }
  const rank = { empty: 0, thin: 1, stale: 2, ok: 3 };
  plan.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.usable - b.usable) || (b.athletes.length - a.athletes.length));
  return plan;
}
function nextRadius(r) { return RADII.find((x) => x > r) || null; }

// ── ONE MARKET ──────────────────────────────────────────────────────────────
// Builds at the start radius and widens until TARGET usable or the widest ring
// or the request allowance is gone. Returns what happened, in numbers.
async function buildMarket(pool, m, opts = {}) {
  const store = opts.store || require('../store');
  const build = opts.build || PM.buildMarketPoolFromPlaces;
  let radius = m.startRadius || RADII[0];
  let calls = 0, lastOk = null, lastReason = null, poolSize = 0;
  let usable = m.usable || 0;
  const steps = [];
  while (radius) {
    if (opts.callsLeft != null && calls >= opts.callsLeft) { lastReason = lastReason || 'request allowance for this run is spent'; break; }
    const r = await build(m.query, { source: 'pool-schedule', radiusM: radius });
    calls += r.placesCalls || 0;
    lastOk = !!r.ok; lastReason = r.ok ? (r.warning || null) : (r.reason || 'unknown');
    if (!r.ok) { steps.push({ radius, ok: false, reason: lastReason, calls: r.placesCalls || 0 }); break; }
    poolSize = (r.candidates || []).length;
    if (poolSize) await store.recordMarketPool(r.candidates, { schoolMarket: m.region });
    usable = (await usableCounts(pool, [m.key])).get(m.key).usable;
    steps.push({ radius, ok: true, found: poolSize, usable, calls: r.placesCalls || 0 });
    if (usable >= TARGET) break;
    radius = nextRadius(radius);
  }
  const lastRadius = steps.length ? steps[steps.length - 1].radius : null;
  await pool.query(
    `INSERT INTO market_pool_schedule (market_key, query, region, last_built_at, last_ok, last_reason, radius_m, pool_size, usable, places_calls, builds)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,1)
     ON CONFLICT (market_key) DO UPDATE SET query = EXCLUDED.query, region = EXCLUDED.region, last_built_at = NOW(),
       last_ok = EXCLUDED.last_ok, last_reason = EXCLUDED.last_reason, radius_m = EXCLUDED.radius_m,
       pool_size = EXCLUDED.pool_size, usable = EXCLUDED.usable,
       places_calls = market_pool_schedule.places_calls + EXCLUDED.places_calls, builds = market_pool_schedule.builds + 1`,
    [m.key, m.query, m.region, lastOk, lastReason, lastRadius, poolSize, usable, calls]);
  return { key: m.key, query: m.query, before: m.usable, usable, calls, ok: lastOk !== false, reason: lastReason, steps,
    reached: usable >= TARGET };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────
// opts: { apply, maxMarkets, maxCalls, now, resolve, build, store, keys }
async function run(pool, opts = {}) {
  await ensureTables(pool);
  const { markets, noMarket, athletes } = await athleteMarkets(pool, opts);
  const keys = markets.map((m) => m.key);
  const counts = await usableCounts(pool, keys);
  const sched = new Map((await pool.query(`SELECT * FROM market_pool_schedule WHERE market_key = ANY($1::text[])`, [keys])).rows
    .map((r) => [r.market_key, r]));
  let plan = planOf(markets, counts, sched, opts.now);
  if (opts.keys) plan = plan.filter((p) => opts.keys.includes(p.key));
  const summary = {
    athletes, markets: markets.length,
    empty: plan.filter((p) => p.status === 'empty').length,
    thin: plan.filter((p) => p.status === 'thin').length,
    stale: plan.filter((p) => p.status === 'stale').length,
    ok: plan.filter((p) => p.status === 'ok').length,
    proOnly: plan.filter((p) => p.pro).length,
    athletesWithNoMarket: noMarket.length,
    due: plan.filter((p) => p.due).length,
    target: TARGET,
  };
  const out = { summary, plan, noMarket, built: [], stop: null };
  if (!opts.apply) return out;

  const maxMarkets = opts.maxMarkets != null ? opts.maxMarkets : MAX_MARKETS;
  const maxCalls = opts.maxCalls != null ? opts.maxCalls : MAX_PLACES_CALLS;
  let calls = 0;
  for (const m of plan.filter((p) => p.due)) {
    if (out.built.length >= maxMarkets) { out.stop = `market limit (${maxMarkets}) for this run`; break; }
    if (calls >= maxCalls) { out.stop = `Places request limit (${maxCalls}) for this run`; break; }
    let b;
    try { b = await buildMarket(pool, m, { ...opts, callsLeft: maxCalls - calls }); }
    catch (e) { b = { key: m.key, query: m.query, before: m.usable, usable: m.usable, calls: 0, ok: false, reason: e.message, steps: [] }; }
    calls += b.calls;
    out.built.push(b);
    console.log(`[market-pools] ${m.key} (${m.query}): ${b.before} -> ${b.usable} usable, ${b.calls} Places request(s)`
      + (b.ok ? '' : ` FAILED: ${b.reason}`));
  }
  if (!out.stop && out.built.length === summary.due) out.stop = 'every due market was built';
  out.calls = calls;
  const Q = require('./outreachQueue');
  out.costUsd = Math.round(calls * Q.USD_PER_PLACES_REQUEST * 100) / 100;
  return out;
}

// ── THE NIGHTLY TICK ────────────────────────────────────────────────────────
// Once per Central date, 10pm to midnight, before the 1am fill. The date row
// is claimed first, so two processes or a restart cannot run it twice.
function centralHour(ms) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false })
    .format(new Date(ms == null ? Date.now() : ms)), 10) % 24;
}
function centralDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms == null ? Date.now() : ms));
}
function enabled() {
  return process.env.MARKET_POOL_SCHEDULE !== 'off' && !!(process.env.GOOGLE_PLACES_API_KEY || '').trim();
}
async function tick(pool, opts = {}) {
  if (!enabled() && !opts.force) return { ran: false, why: 'off' };
  const h = centralHour(opts.now);
  if (!opts.force && !(h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR)) return { ran: false, why: 'outside the window' };
  await ensureTables(pool);
  const date = centralDate(opts.now);
  const claim = await pool.query(`INSERT INTO market_pool_runs (run_date) VALUES ($1) ON CONFLICT DO NOTHING RETURNING run_date`, [date]);
  if (!claim.rowCount) return { ran: false, why: 'already ran for ' + date };
  const res = await run(pool, { ...opts, apply: true });
  const brief = { ...res.summary, builtMarkets: res.built.length, calls: res.calls, costUsd: res.costUsd, stop: res.stop,
    reached: res.built.filter((b) => b.reached).length, failed: res.built.filter((b) => !b.ok).map((b) => `${b.key}: ${b.reason}`) };
  await pool.query(`UPDATE market_pool_runs SET finished_at = NOW(), summary = $2 WHERE run_date = $1`, [date, brief]);
  console.log(`[market-pools] ${date}: built ${res.built.length} of ${res.summary.due} due market(s), ${res.calls} Places request(s) `
    + `(~$${res.costUsd}); stopped: ${res.stop}`);
  // A build that failed is ours (services/ourFault): it is on
  // places_market_builds, which the morning alert already reads.
  return { ran: true, ...brief };
}

function formatReport(res) {
  const s = res.summary;
  const L = [];
  L.push(`ATHLETE MARKET POOLS   target ${s.target} usable businesses a market`);
  L.push(`${s.athletes} athlete(s) across ${s.markets} distinct market(s); ${s.athletesWithNoMarket} athlete(s) have no market at all`);
  L.push(`  ${s.empty} market(s) with ZERO usable rows   ${s.thin} under ${s.target}   ${s.stale} stale   ${s.ok} ok`
    + (s.proOnly ? `   (${s.proOnly} pro-only, not built here)` : ''));
  L.push(`  ${s.due} due for a build`);
  L.push('');
  for (const p of res.plan) {
    L.push(`  ${p.status.toUpperCase().padEnd(5)} ${p.key.padEnd(28)} ${String(p.usable).padStart(4)} usable / ${String(p.rows).padStart(4)} rows  `
      + `${p.athletes.length} athlete(s), ${p.agents.length} agent(s)  query "${p.query}"  ${p.due ? 'DUE' : ''}  ${p.why}`);
  }
  if (res.noMarket.length) {
    L.push('', 'ATHLETES WITH NO MARKET (no pool can be built until the school or city resolves):');
    for (const n of res.noMarket) L.push(`  ${n.athlete} (${n.agent || '?'}): ${n.why}`);
  }
  if (res.built.length || res.stop) {
    L.push('', `BUILT ${res.built.length} market(s), ${res.calls || 0} Places request(s), about $${(res.costUsd || 0).toFixed(2)}; stopped: ${res.stop}`);
    for (const b of res.built) {
      L.push(`  ${b.key}: ${b.before} -> ${b.usable} usable${b.reached ? '' : ` (under ${s.target})`}, ${b.calls} request(s)`
        + (b.ok ? '' : `  FAILED: ${b.reason}`)
        + (b.steps.length ? '  rings: ' + b.steps.map((x) => `${Math.round(x.radius / 1000)}km ${x.ok ? `${x.found} found` : 'failed'}`).join(', ') : ''));
    }
  }
  return L.join('\n');
}

module.exports = {
  run, tick, athleteMarkets, usableCounts, planOf, buildMarket, formatReport, ensureTables, enabled, centralHour, centralDate,
  TARGET, REFRESH_DAYS, THIN_RETRY_DAYS, RADII, MAX_MARKETS, MAX_PLACES_CALLS, WINDOW_START_HOUR, WINDOW_END_HOUR,
};
