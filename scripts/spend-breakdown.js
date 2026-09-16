#!/usr/bin/env node
'use strict';
// ── WHAT A NIGHT'S MODEL CALLS COST, BY CALL SITE, ATHLETE AND AGENT ─────────
//
//   node scripts/spend-breakdown.js                       last 24 hours
//   node scripts/spend-breakdown.js --date 2026-09-14     that run date (6pm the evening before to noon, UTC)
//   node scripts/spend-breakdown.js --hours 36
//   node scripts/spend-breakdown.js --agent cs@9091sportsagency.com
//
// Report only. Writes nothing.
//
// TWO SOURCES, and it says which one it is reading:
//
//   ai_call_ledger   one row per model call since the ledger shipped: site,
//                    model, tokens, searches, agent, athlete, brand, and an
//                    estimate priced from the model's list price. This is
//                    the answer to "what was the $10".
//
//   outreach_queue_runs.details   what the nightly job recorded BEFORE the
//                    ledger: per athlete, per lookup, a flat-rate estimate
//                    ($0.01 a search, $0.003 a model call, Places at cost).
//                    It knows discovery, the Instagram check and the contact
//                    ladder. It does NOT know the writer at all, and it knows
//                    no tokens and no model, so it cannot be reconciled to the
//                    console. Printed when the ledger has nothing for the
//                    window, labelled as the estimate it is.
//
// The last block is the repeat check: the same site asked about the same
// brand for the same athlete more than once inside the window.

const store = require('../server/store');
const Ledger = require('../server/services/aiLedger');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('spend-breakdown: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `spend-breakdown: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}
const usd = (n) => '$' + (Number(n) || 0).toFixed(3);
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);
const num = (n) => String(Number(n) || 0);

function window_() {
  const date = arg('date', null);
  if (date) {
    // A run date is the morning the cards appeared; the job ran the night
    // before. 6pm UTC the evening before to noon UTC that day covers every
    // Central-time nightly window.
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime())) return fail('args', new Error('--date must be YYYY-MM-DD'));
    return { from: new Date(d.getTime() - 18 * 3600000), to: d, label: 'run date ' + date };
  }
  const hours = parseFloat(arg('hours', '24')) || 24;
  return { from: new Date(Date.now() - hours * 3600000), to: new Date(), label: 'last ' + hours + ' hours' };
}

async function main() {
  const w = window_();
  const agentEmail = arg('agent', null);
  console.log(`spend-breakdown: connecting via ${target()}  window: ${w.label} (${w.from.toISOString()} .. ${w.to.toISOString()})`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  let agentFilter = null;
  if (agentEmail) {
    let u;
    try { u = (await P.query(`SELECT id, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [agentEmail])).rows; } catch (e) { return fail('users', e); }
    if (!u.length) return fail('args', new Error('no user with email ' + agentEmail));
    agentFilter = u.map((x) => x.id);
  }

  // ── 1. THE LEDGER ────────────────────────────────────────────────────────
  let rows;
  try {
    rows = (await P.query(
      `SELECT l.site, l.model, COALESCE(l.provider, 'anthropic') AS provider, l.agent_id, l.athlete_id, l.brand, l.input_tokens, l.output_tokens,
              l.cache_read_tokens, l.cache_write_tokens, l.web_searches, l.est_usd, l.ms, l.at,
              u.email AS agent_email, a.data->>'name' AS athlete_name
         FROM ai_call_ledger l
         LEFT JOIN users u ON u.id = l.agent_id
         LEFT JOIN athletes a ON a.id = l.athlete_id
        WHERE l.at >= $1 AND l.at < $2 ${agentFilter ? 'AND l.agent_id = ANY($3)' : ''}
        ORDER BY l.at ASC`, agentFilter ? [w.from, w.to, agentFilter] : [w.from, w.to])).rows;
  } catch (e) {
    if (/column l\.provider does not exist/.test(e.message)) {
      // A ledger from before the provider column: every row is Anthropic.
      try {
        rows = (await P.query(
          `SELECT l.site, l.model, 'anthropic' AS provider, l.agent_id, l.athlete_id, l.brand, l.input_tokens, l.output_tokens,
                  l.cache_read_tokens, l.cache_write_tokens, l.web_searches, l.est_usd, l.ms, l.at,
                  u.email AS agent_email, a.data->>'name' AS athlete_name
             FROM ai_call_ledger l LEFT JOIN users u ON u.id = l.agent_id LEFT JOIN athletes a ON a.id = l.athlete_id
            WHERE l.at >= $1 AND l.at < $2 ${agentFilter ? 'AND l.agent_id = ANY($3)' : ''} ORDER BY l.at ASC`,
          agentFilter ? [w.from, w.to, agentFilter] : [w.from, w.to])).rows;
      } catch (e2) { return fail('ledger', e2); }
    } else if (/does not exist/.test(e.message)) { rows = []; console.log('spend-breakdown: ai_call_ledger does not exist yet (the deploy that creates it has not started).'); }
    else return fail('ledger', e);
  }
  console.log(`spend-breakdown: connected. ${rows.length} ledger row(s) in the window.`);

  if (rows.length) {
    const total = rows.reduce((n, r) => n + (Number(r.est_usd) || 0), 0);
    const unpriced = rows.filter((r) => r.est_usd === null).length;
    console.log(`\nTOTAL (estimated from list prices): ${usd(total)} across ${rows.length} call(s)`
      + (unpriced ? `  -- ${unpriced} call(s) on a model with no price on file, counted at $0` : ''));
    console.log('Prices assumed, USD per million tokens [in, out, cache read]: ' + Object.entries(Ledger.PRICES).filter(([k]) => k !== 'deepseek').map(([k, v]) => `${k}=${v.join('/')}`).join('  ')
      + `; web search ${usd(Ledger.USD_PER_SEARCH.anthropic)} each on Anthropic, ${usd(Ledger.USD_PER_SEARCH.deepseek)} each through the search provider on DeepSeek.`);
    console.log('DeepSeek rates are the DEEPSEEK_PRICE_IN / _OUT / _CACHE_HIT assumptions (defaults are the V3.2-era list prices; set the V4.1 Flash rates from api-docs.deepseek.com to correct every estimate).');

    // ── BY PROVIDER: the Anthropic bill beside the DeepSeek bill ──────────
    {
      const byP = new Map();
      for (const r of rows) {
        const g = byP.get(r.provider) || { calls: 0, inTok: 0, outTok: 0, cacheTok: 0, searches: 0, usd: 0, models: new Set() };
        g.calls++; g.inTok += r.input_tokens; g.outTok += r.output_tokens; g.cacheTok += r.cache_read_tokens; g.searches += r.web_searches;
        g.usd += Number(r.est_usd) || 0; g.models.add(r.model); byP.set(r.provider, g);
      }
      console.log('\nBY PROVIDER');
      console.log(`  ${pad('', 12)} ${pad('calls', 6)} ${pad('searches', 9)} ${pad('tokens in', 11)} ${pad('cache read', 11)} ${pad('tokens out', 11)} ${pad('usd', 9)} model(s)`);
      for (const [k, g] of [...byP.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
        console.log(`  ${pad(k, 12)} ${pad(g.calls, 6)} ${pad(g.searches, 9)} ${pad(g.inTok, 11)} ${pad(g.cacheTok, 11)} ${pad(g.outTok, 11)} ${pad(usd(g.usd), 9)} ${[...g.models].map((m) => m.replace(/-\d{8}$/, '')).join(', ')}`);
      }
      if (!byP.has('deepseek')) console.log('  (no DeepSeek rows: the fast tier ran on Anthropic in this window; node scripts/deepseek-savings.js estimates what it would have cost)');
    }

    const group = (key) => {
      const m = new Map();
      for (const r of rows) {
        const k = key(r);
        const g = m.get(k) || { calls: 0, inTok: 0, outTok: 0, searches: 0, usd: 0, models: new Set() };
        g.calls++; g.inTok += r.input_tokens; g.outTok += r.output_tokens; g.searches += r.web_searches;
        g.usd += Number(r.est_usd) || 0; g.models.add(r.model);
        m.set(k, g);
      }
      return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd);
    };
    const table = (title, entries, keyWidth) => {
      console.log(`\n${title}`);
      console.log(`  ${pad('', keyWidth)} ${pad('calls', 6)} ${pad('searches', 9)} ${pad('tokens in', 11)} ${pad('tokens out', 11)} ${pad('usd', 9)} model(s)`);
      for (const [k, g] of entries) {
        console.log(`  ${pad(k, keyWidth)} ${pad(g.calls, 6)} ${pad(g.searches, 9)} ${pad(g.inTok, 11)} ${pad(g.outTok, 11)} ${pad(usd(g.usd), 9)} ${[...g.models].map((m) => m.replace(/-\d{8}$/, '')).join(', ')}`);
      }
    };
    // Group keys carry the provider when both appear, so a site split across
    // the two bills reads as two lines rather than one blended number.
    const withProvider = (key) => (r) => key(r) + (rows.some((x) => x.provider !== rows[0].provider) ? `  [${r.provider}]` : '');

    // Site, rolled up to its top level and then in full.
    table('BY CALL SITE (top level)', group(withProvider((r) => r.site.split('.')[0])), 34);
    table('BY CALL SITE (full label)', group(withProvider((r) => r.site)), 42);
    // ── ATHLETE LOOKUPS: cost per lookup, by level ─────────────────────────
    // A lookup is a few DeepSeek turns and a searches row, all under
    // lookup.<level> with the athlete's name as the brand. Distinct names per
    // level are the lookups; the average is what one costs.
    {
      const lk = rows.filter((r) => /^lookup\./.test(r.site));
      if (lk.length) {
        const byLevel = new Map();
        for (const r of lk) {
          const g = byLevel.get(r.site) || { names: new Set(), calls: 0, searches: 0, usd: 0 };
          g.names.add(String(r.brand || '').toLowerCase()); g.calls++; g.searches += r.web_searches; g.usd += Number(r.est_usd) || 0;
          byLevel.set(r.site, g);
        }
        console.log('\nATHLETE LOOKUPS (services/athleteLookup; a lookup is one athlete name under one level)');
        console.log(`  ${pad('', 22)} ${pad('lookups', 8)} ${pad('calls', 6)} ${pad('searches', 9)} ${pad('usd', 9)} ${pad('per lookup', 11)}`);
        for (const [k, g] of [...byLevel.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
          const n = g.names.size || 1;
          console.log(`  ${pad(k, 22)} ${pad(n, 8)} ${pad(g.calls, 6)} ${pad(g.searches, 9)} ${pad(usd(g.usd), 9)} ${pad(usd(g.usd / n), 11)}`);
        }
      }
    }

    table('BY AGENT', group((r) => r.agent_email || r.agent_id || '(no agent on the call)'), 34);
    table('BY ATHLETE', group((r) => (r.athlete_name || r.athlete_id || '(no athlete on the call)') + (r.agent_email ? '  ' + r.agent_email : '')), 46);

    // Per agent, per athlete, per top-level site: the answer to the question as asked.
    console.log('\nPER AGENT, PER ATHLETE, PER SITE');
    const byAgent = new Map();
    for (const r of rows) {
      const ag = r.agent_email || r.agent_id || '(no agent)';
      const ath = r.athlete_name || r.athlete_id || '(no athlete)';
      const site = r.site.split('.')[0];
      const a = byAgent.get(ag) || new Map();
      const t = a.get(ath) || new Map();
      t.set(site, (t.get(site) || 0) + (Number(r.est_usd) || 0));
      a.set(ath, t); byAgent.set(ag, a);
    }
    for (const [ag, aths] of byAgent) {
      const agTotal = [...aths.values()].reduce((n, t) => n + [...t.values()].reduce((x, y) => x + y, 0), 0);
      console.log(`  ${ag}  ${usd(agTotal)}`);
      for (const [ath, sites] of [...aths.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
        const line = [...sites.entries()].sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${usd(v)}`).join('  ');
        console.log(`     ${pad(ath, 28)} ${line}`);
      }
    }

    // ── THE REPEAT CHECK ────────────────────────────────────────────────────
    console.log('\nSAME SITE, SAME BRAND, SAME ATHLETE, MORE THAN ONCE IN THE WINDOW');
    const rep = new Map();
    for (const r of rows) {
      if (!r.brand) continue;
      const k = `${r.site}|${r.athlete_id || ''}|${r.brand.toLowerCase()}`;
      const g = rep.get(k) || { site: r.site, brand: r.brand, athlete: r.athlete_name || r.athlete_id || '', n: 0, usd: 0 };
      g.n++; g.usd += Number(r.est_usd) || 0; rep.set(k, g);
    }
    const repeats = [...rep.values()].filter((g) => g.n > 1).sort((a, b) => b.usd - a.usd);
    if (!repeats.length) console.log('  none.');
    for (const g of repeats.slice(0, 40)) console.log(`  ${pad(g.site, 24)} ${pad(g.brand, 32)} ${pad(g.athlete, 22)} x${g.n}  ${usd(g.usd)}`);
    if (repeats.length > 40) console.log(`  ... and ${repeats.length - 40} more`);
    console.log('  (a writer retry after a lint failure shows here as x2; a second night on the same business shows only if both fall in the window)');
  }

  // ── 2. WHAT THE RUN ROWS RECORDED (the flat estimate) ────────────────────
  let runs;
  try {
    runs = (await P.query(
      `SELECT r.agent_id, u.email AS agent_email, r.run_date, r.filled, r.spent_usd, r.details
         FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id
        WHERE r.finished_at >= $1 AND r.finished_at < $2 ${agentFilter ? 'AND r.agent_id = ANY($3)' : ''}
        ORDER BY r.run_date, u.email`, agentFilter ? [w.from, w.to, agentFilter] : [w.from, w.to])).rows;
  } catch (e) { return fail('runs', e); }

  console.log(`\n${rows.length ? 'FOR COMPARISON, ' : ''}WHAT THE NIGHTLY RUN ROWS RECORDED: ${runs.length} run(s) finished in the window`);
  if (!runs.length) console.log('  none.');
  for (const run of runs) {
    const det = Array.isArray(run.details) ? run.details : [];
    console.log(`\n  ${run.agent_email || run.agent_id}  ${String(run.run_date).slice(0, 10)}  filled=${run.filled}  spent_usd=${usd(run.spent_usd)} (flat-rate estimate, writer NOT included)`);
    console.log(`     ${pad('athlete', 26)} ${pad('discovery', 10)} ${pad('instagram', 10)} ${pad('contacts', 10)} ${pad('writer calls', 13)} ${pad('unmetered', 10)} tried`);
    const tot = { discovery: 0, instagram: 0, contacts: 0, writer: 0, unmetered: 0 };
    for (const d of det) {
      const log = Array.isArray(d.spendLog) ? d.spendLog : [];
      // The three entry shapes the job writes (see jobs/outreachQueue.js):
      // discovery carries lane='discovery'; the Instagram check carries the
      // candidate's lane; the contact ladder carries no lane at all.
      const disc = log.filter((x) => x.lane === 'discovery').reduce((n, x) => n + (Number(x.cost) || 0), 0);
      const ig = log.filter((x) => x.lane && x.lane !== 'discovery').reduce((n, x) => n + (Number(x.cost) || 0), 0);
      const con = log.filter((x) => !x.lane).reduce((n, x) => n + (Number(x.cost) || 0), 0);
      const unm = log.filter((x) => x.metered === false).length;
      // The writer was never metered: one call per candidate that reached it
      // (queued or refused), plus an unrecorded retry on a lint failure.
      const tried = Array.isArray(d.tried) ? d.tried : [];
      // A pitch written and then refused a slot (slotTaken, "slot taken after
      // write") is a writer call too: it is not a tried business, but it was
      // paid for.
      const lost = Array.isArray(d.slotTaken) ? d.slotTaken : [];
      const writer = tried.filter((t) => t.result === 'queued' || t.result === 'no_angle').length + lost.length;
      tot.discovery += disc; tot.instagram += ig; tot.contacts += con; tot.writer += writer; tot.unmetered += unm; tot.slotTaken = (tot.slotTaken || 0) + lost.length;
      console.log(`     ${pad(d.athleteName || d.athleteId, 26)} ${pad(usd(disc), 10)} ${pad(usd(ig), 10)} ${pad(usd(con), 10)} ${pad(writer, 13)} ${pad(unm, 10)} ${tried.length}`);
    }
    console.log(`     ${pad('TOTAL', 26)} ${pad(usd(tot.discovery), 10)} ${pad(usd(tot.instagram), 10)} ${pad(usd(tot.contacts), 10)} ${pad(tot.writer, 13)} ${pad(tot.unmetered, 10)}`);
    console.log(`     writer calls x ~${usd(0.012)}-${usd(0.02)} each on Sonnet (2-3k tokens in, ~400 out) = roughly ${usd(tot.writer * 0.012)} to ${usd(tot.writer * 0.02)} that spent_usd does not contain`);
    // ── NO NAME FOUND ────────────────────────────────────────────────────
    // A business the ladder could not name, whose final owner / marketing
    // searches also came back empty, is skipped rather than written to (see
    // services/ownerNameSearch). The rate is what decides whether the bar is
    // right; the names are what decides whether the searches are.
    const localTried = det.flatMap((d) => (Array.isArray(d.tried) ? d.tried : []).filter((t) => t && t.result !== 'prescreen_skip' && t.lane !== 'social' && t.lane !== 'program' && t.lane !== 'pro'));
    const noName = localTried.filter((t) => t.result === 'no_name');
    const rescued = det.flatMap((d) => (Array.isArray(d.tried) ? d.tried : []).filter((t) => t && t.why && t.why.finalName));
    if (noName.length || rescued.length || localTried.some((t) => t.result === 'queued')) {
      const denom = localTried.length || 1;
      console.log(`     no name found: ${noName.length} of ${localTried.length} local businesses skipped (${Math.round(100 * noName.length / denom)}%); ${rescued.length} named only by the final owner/marketing search`);
      for (const t of noName.slice(0, 10)) console.log(`        skipped  ${t.brand}`);
      for (const t of rescued.slice(0, 10)) console.log(`        rescued  ${t.brand}: ${t.why.finalName.name} (${t.why.finalName.title}, ${t.why.finalName.query} search)`);
    }

    // ── SLOT TAKEN AFTER WRITE ───────────────────────────────────────────
    // The slot was confirmed open before the writer ran and found taken right
    // before the insert: the pitch was thrown away. Each one is a Sonnet call
    // that bought nothing, and they are listed by athlete and business.
    const lostAll = det.flatMap((d) => (Array.isArray(d.slotTaken) ? d.slotTaken : []).map((x) => ({ ...x, athlete: d.athleteName || d.athleteId })));
    if (lostAll.length) {
      console.log(`     slot taken after write: ${lostAll.length} pitch(es) written, then the slot was gone before the insert (~${usd(lostAll.length * 0.012)}-${usd(lostAll.length * 0.02)} spent for nothing)`);
      for (const x of lostAll.slice(0, 12)) console.log(`        ${pad(x.athlete, 26)} slot ${x.slot}  ${x.brand}${x.lane ? '  (' + x.lane + ')' : ''}${x.writerRetried ? '  [writer retried]' : ''}`);
      if (lostAll.length > 12) console.log(`        ... and ${lostAll.length - 12} more`);
    } else if (det.some((d) => Array.isArray(d.slotTaken))) {
      console.log('     slot taken after write: none');
    }

    // ── WHO MADE THE UNLABELLED CALLS ────────────────────────────────────
    // Rows with no site carry the first stack frame outside the AI plumbing
    // (aiLedger.callerOf), so the mystery line names its file and line.
    try {
      const uc = await P.query(
        `SELECT COALESCE(caller, '(no caller recorded: row predates the column)') AS caller, model,
                COUNT(*)::int AS calls, SUM(web_searches)::int AS searches, SUM(est_usd)::float AS usd
           FROM ai_call_ledger WHERE site = 'unlabelled' AND at >= NOW() - INTERVAL '36 hours'
          GROUP BY 1, 2 ORDER BY usd DESC NULLS LAST LIMIT 12`);
      if (uc.rows.length) {
        console.log(`     unlabelled calls, by caller (last 36h):`);
        for (const r of uc.rows) console.log(`        ${pad(usd(r.usd || 0), 9)} ${pad(r.calls + ' call(s)', 12)} ${pad((r.searches || 0) + ' search(es)', 14)} ${pad(r.model, 30)} ${r.caller}`);
      }
    } catch (_) { /* older ledger without the column: the section is skipped */ }

    // ── THE WRITER RETRY ─────────────────────────────────────────────────
    // A lint refusal buys a second Sonnet call. Since the flag shipped every
    // attempt says whether it fired; before that, the only trace is a pitch
    // refused TWICE (the retry failed too), which is a lower bound.
    // ONE WRITE PER ATHLETE AND BUSINESS. The local lane records a 'queued'
    // attempt before the writer runs and a 'no_angle' attempt after a refusal,
    // so a refused business had two entries and the write count was inflated.
    const seenWrite = new Set();
    const attempts = det.flatMap((d) => (Array.isArray(d.tried) ? d.tried : [])
      .filter((t) => t.result === 'queued' || t.result === 'no_angle')
      // The later entry for a business wins (it carries the refusal).
      .reverse()
      .filter((t) => { const k = d.athleteId + '|' + String(t.brand || '').toLowerCase(); if (seenWrite.has(k)) return false; seenWrite.add(k); return true; }));
    const flagged = attempts.filter((t) => typeof t.writerRetried === 'boolean');
    const retried = flagged.filter((t) => t.writerRetried);
    const twice = attempts.filter((t) => /could not write it in voice|invented a fact about the athlete/.test(t.reason || ''));
    if (flagged.length) {
      console.log(`     writer retries: ${retried.length} of ${flagged.length} writes needed the second call (${Math.round(100 * retried.length / flagged.length)}%), ${twice.length} of those were refused twice`);
      const why = new Map();
      for (const t of retried) for (const p of (t.writerFirstProblems || [])) { const k = String(p).replace(/"[^"]*"/g, '"..."').slice(0, 70); why.set(k, (why.get(k) || 0) + 1); }
      for (const [k, n] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`        x${n}  ${k}`);
      // --writer-examples N: the raw refusal strings, which carry BOTH what the
      // model wrote and what is stored, beside the athlete's stored position
      // as the database holds it right now.
      const nEx = parseInt(arg('writer-examples', '0'), 10) || 0;
      if (nEx) {
        console.log(`     first ${nEx} refusal(s), verbatim:`);
        let shown = 0;
        for (const d of det) {
          if (shown >= nEx) break;
          const ath = await P.query(`SELECT data->>'position' AS position, data->>'sport' AS sport FROM athletes WHERE id = $1`, [d.athleteId]).then((r) => r.rows[0] || {}).catch(() => ({}));
          for (const t of (Array.isArray(d.tried) ? d.tried : [])) {
            if (shown >= nEx) break;
            if (!t.writerRetried) continue;
            const twiceRefused = /could not write it in voice|invented a fact/.test(t.reason || '');
            console.log(`       ${++shown}. ${d.athleteName || d.athleteId} (stored position ${JSON.stringify(ath.position || null)}, ${ath.sport || '?'}) x ${t.brand}${twiceRefused ? '  [REFUSED TWICE, no card]' : '  [retry passed]'}`);
            for (const p of (t.writerFirstProblems || [])) console.log(`            first draft: ${p}`);
            if (twiceRefused) console.log(`            second draft: ${String(t.reason).replace(/^could not write it in voice: |^invented a fact about the athlete: /, '')}`);
          }
        }
      }
    } else {
      console.log(`     writer retries: not recorded on this run (predates the flag); ${twice.length} of ${attempts.length} writes were refused twice, which is the lower bound on retries`);
    }
  }

  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
