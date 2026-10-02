'use strict';
// ── PROVE THE ENGINE ON REAL SUBJECTS, NOW ──────────────────────────────────
//
// Runs the nightly loop by hand on four subjects and reports, per subject:
// candidates considered, how many cleared each role (researcher, judge, owner
// finder, writer), the contact hit rate, cost, time, and the local/social
// split of the cards it holds.
//
//   an athlete in the market with the most rows in the record
//   an athlete in a thin market (the fewest rows above zero)
//   an athlete whose market has ZERO rows in the record -- the whole test
//   one Cypress team
//
// SAME CODE AS THE NIGHT. The athlete runs are jobs/outreachQueue.fillAthlete
// with the context the nightly builds (agent first name, signature, profile,
// raw row); the team run is teamScan.runTeamScan in pitch mode. It writes real
// cards, awaiting approval, exactly as the night would.
//
// fresh: the athlete's queued cards would be expired first so the run starts
// from zero. REFUSED unless allowFreshOnRealQueues is also passed: those cards
// are on customers' screens. Without it, cards already held are reported as
// held from before and the run tops up to five like the night does.
//
//   POST /api/admin/engine/prove            { athletes?, team?, fresh? }
//   GET  /api/admin/engine/prove/:id?text=1
//   GET  /api/admin/engine/prove/pick       which subjects it would choose
const crypto = require('crypto');

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS engine_proof_runs (
    id TEXT PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
    options JSONB, report JSONB)`);
}

// ── WHO TO RUN ──────────────────────────────────────────────────────────────
async function pick(pool) {
  const job = require('../jobs/outreachQueue');
  const AgentName = require('./agentName');
  const rows = (await pool.query(
    `SELECT a.id, a.agent_id, a.data, a.data->>'name' AS name, a.data->>'school' AS school, a.data->>'hometown' AS hometown,
            u.name AS agent_name, u.email AS agent_email
       FROM athletes a JOIN users u ON u.id = a.agent_id
      WHERE COALESCE(u.role, 'agent') NOT IN ('university', 'university_admin')`)).rows;
  const counts = new Map((await pool.query(`SELECT market_key, COUNT(*)::int n FROM market_business_seen GROUP BY 1`)).rows.map((r) => [r.market_key, r.n]));
  const cands = [];
  for (const r of rows) {
    if (!AgentName.agentFirstName({ name: r.agent_name, email: r.agent_email })) continue;
    let p;
    try { p = job.athleteProfile(r); } catch (_) { continue; }
    if (!p || !p.hasLocalMarket || !p.marketKey) continue;
    cands.push({ id: r.id, name: r.name, agentId: r.agent_id, marketKey: p.marketKey, market: p.market, rows: counts.get(p.marketKey) || 0 });
  }
  const withRows = cands.filter((c) => c.rows > 0).sort((a, b) => b.rows - a.rows);
  const zero = cands.filter((c) => c.rows === 0);
  return {
    rich: withRows[0] || null,
    thin: withRows.length > 1 ? withRows[withRows.length - 1] : null,
    zero: zero[0] || null,
    eligible: cands.length, zeroMarkets: new Set(zero.map((c) => c.marketKey)).size,
  };
}

// ── THE FUNNEL, FROM THE NIGHT'S OWN RECORD OF EVERY CANDIDATE ─────────────
// jobs/outreachQueue writes one entry per business tried, with its result:
//   skipped          already researched for this athlete tonight (not counted)
//   prescreen_skip   not operating / not a fit at the door        -> judge
//   rejected         restricted, program cap, placeholder ...     -> judge
//   rejected, stage owner / no_name   no named, reachable person  -> owner finder
//   no_angle         the writer found nothing worth sending       -> writer
//   error            our failure (a lookup or model call failed)
//   queued           a card
function funnel(tried) {
  const t = (tried || []).filter((x) => x && x.result !== 'skipped');
  const judgeOut = t.filter((x) => x.result === 'prescreen_skip' || (x.result === 'rejected' && x.stage !== 'owner')).length;
  const faults = t.filter((x) => x.result === 'error').length;
  const ownerOut = t.filter((x) => x.result === 'no_name' || (x.result === 'rejected' && x.stage === 'owner')).length;
  const writerOut = t.filter((x) => x.result === 'no_angle').length;
  const queued = t.filter((x) => x.result === 'queued');
  const considered = t.length;
  const clearedJudge = considered - judgeOut;
  const reachedOwner = clearedJudge - faults;
  const clearedOwner = reachedOwner - ownerOut;
  return {
    considered, clearedResearcher: considered, clearedJudge, clearedOwner, clearedWriter: queued.length,
    rejected: { judge: judgeOut, ownerFinder: ownerOut, writer: writerOut, ourFaults: faults },
    contactHitRate: reachedOwner > 0 ? clearedOwner / reachedOwner : null,
  };
}

async function runAthlete(pool, athleteId, opts = {}) {
  const job = require('../jobs/outreachQueue');
  const Q = require('./outreachQueue');
  const SIG = require('./signature');
  const AgentName = require('./agentName');
  const owner = (await pool.query(`SELECT agent_id FROM athletes WHERE id = $1`, [athleteId])).rows[0];
  if (!owner) return { ok: false, error: `no athlete ${athleteId}` };
  const ath = (await job.loadAthletesForQueue(pool, owner.agent_id, athleteId))[0];
  const agentFirstName = AgentName.agentFirstName({ name: ath.agent_name, email: ath.agent_email });
  if (!agentFirstName) return { ok: false, error: AgentName.NO_AGENT_NAME_REASON };
  let expired = 0;
  if (opts.fresh && opts.allowFreshOnRealQueues === true) {
    expired = (await pool.query(`UPDATE outreach_queue SET state = 'expired', expired_at = NOW(), updated_at = NOW()
                                  WHERE athlete_id = $1 AND state = 'queued'`, [athleteId])).rowCount;
  }
  const heldBefore = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`, [athleteId])).rows[0].n;
  const counts = new Map((await pool.query(`SELECT market_key, COUNT(*)::int n FROM market_business_seen GROUP BY 1`)).rows.map((r) => [r.market_key, r.n]));
  const ctx = await job.localContextFor(ath);
  const rowsBefore = counts.get(ctx.profile.marketKey) || 0;
  // THE ZERO TEST IS ONLY A ZERO TEST IF THE RECORD IS EMPTY FOR THE MARKET
  // THE RUN WILL ACTUALLY USE. The pick counted rows under the school map's
  // key; the run may geocode to another. Checked here, with the run's key,
  // before anything is spent: a non-empty market is refused, not run.
  if (opts.expectZero && rowsBefore !== 0) {
    return { ok: false, kind: 'athlete', id: ath.id, name: ath.name, market: ctx.profile.market, marketKey: ctx.profile.marketKey,
      notZero: true, recordRowsBefore: rowsBefore,
      error: `NOT A ZERO-ROW TEST: the record holds ${rowsBefore} row(s) for ${ctx.profile.marketKey}, the market this run would use. Nothing was run.` };
  }
  const budget = Q.newBudget(job.CAP_USD);
  const t0 = Date.now();
  const lines = [];
  const r = await job.fillAthlete(pool, {
    agentId: ath.agent_id, athleteId: ath.id, athleteName: ath.name, runDate: job.today(),
    athleteProfile: ctx.profile, agentFirstName, signature: SIG.signatureOf(ath), athleteRow: ath.data || null,
    budget, region: ctx.region, regionFault: ctx.fault || null, keepStale: true,
    onProgress: (m) => { lines.push(m); if (opts.say) opts.say(`[${ath.name}] ${m}`); },
  });
  const ms = Date.now() - t0;
  const held = (await pool.query(`SELECT brand_name, lane, channel, contact_name, created_at FROM outreach_queue
                                   WHERE athlete_id = $1 AND state = 'queued' ORDER BY slot`, [athleteId])).rows;
  const rowsAfter = (await pool.query(`SELECT COUNT(*)::int n FROM market_business_seen WHERE market_key = $1`, [ctx.profile.marketKey])).rows[0].n;
  const split = held.reduce((m, c) => { const k = c.lane || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    ok: true, kind: 'athlete', id: ath.id, name: ath.name, market: ctx.profile.market, marketKey: ctx.profile.marketKey,
    tier: r.loop && r.loop.tier, tierWhy: r.loop && r.loop.tierWhy, recordRowsBefore: rowsBefore, recordRowsAfter: rowsAfter,
    expiredFirst: expired, heldBefore, placed: r.filled, held: held.length, reachedFive: held.length >= Q.SLOTS_PER_ATHLETE,
    funnel: funnel(r.tried), costUsd: Math.round(budget.spent() * 100) / 100, seconds: Math.round(ms / 1000),
    rungs: (r.loop && r.loop.rungs) || [], stop: (r.loop && r.loop.stop) || r.stop || null,
    split, cards: held.map((c) => ({ business: c.brand_name, lane: c.lane, channel: c.channel, contact: c.contact_name,
      new: new Date(c.created_at).getTime() >= t0 })), log: lines.slice(-60),
  };
}

async function runTeam(pool, teamId, opts = {}) {
  const TS = require('./teamScan');
  const team = (await pool.query(`SELECT id, university_id, name, market_key FROM university_teams WHERE id = $1`, [teamId])).rows[0];
  if (!team) return { ok: false, error: `no team ${teamId}` };
  const t0 = Date.now();
  const before = (await pool.query(`SELECT COUNT(*)::int n FROM university_contacts WHERE university_id = $1 AND reachable IS TRUE`, [team.university_id])).rows[0].n;
  const r = await TS.runTeamScan(pool, { universityId: team.university_id, teamId, limit: 5, mode: 'pitch', deps: {} });
  const ms = Date.now() - t0;
  const c = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('reachable','unreachable'))::int resolved,
                                      COUNT(*) FILTER (WHERE reachable IS TRUE)::int reachable FROM university_contacts WHERE university_id = $1`, [team.university_id])).rows[0];
  const drafts = r.drafts || [];
  const considered = (r.loop && r.loop.candidates) || 0;
  return {
    ok: r.ok !== false, error: r.error || null, kind: 'team', id: team.id, name: team.name, market: team.market_key,
    placed: drafts.length, held: drafts.length, reachedFive: drafts.length >= 5,
    funnel: {
      considered, clearedResearcher: considered, clearedJudge: considered - (r.skipped || []).filter((s) => /blocked/.test(s.why)).length,
      // A team's candidates are drawn only from businesses whose contact is
      // already resolved and reachable, so the owner finder's rate is the
      // department's contact pool, not this run.
      clearedOwner: considered, clearedWriter: drafts.length,
      rejected: { writer: (r.skipped || []).filter((s) => !s.fault && !/blocked|already/.test(s.why)).length, ourFaults: (r.skipped || []).filter((s) => s.fault).length },
      contactHitRate: c.resolved ? c.reachable / c.resolved : null, contactPool: { resolved: c.resolved, reachable: c.reachable, reachableBefore: before },
    },
    costUsd: r.loop ? r.loop.costUsd : 0, seconds: Math.round(ms / 1000), rungs: (r.loop && r.loop.rungs) || [], stop: r.loop && r.loop.stop,
    split: { local: drafts.length }, cards: drafts.map((d) => ({ business: d.brand, contact: d.contact, why: d.why, lane: 'local' })),
  };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────
const _live = new Map();
async function start(pool, opts = {}) {
  await ensureTable(pool);
  const id = 'proof_' + crypto.randomBytes(5).toString('hex');
  const picked = await pick(pool);
  const subjects = [];
  const want = Array.isArray(opts.athletes) && opts.athletes.length ? opts.athletes.map((a) => ({ role: 'given', id: a })) : [
    picked.rich && { role: 'market with lots of history', id: picked.rich.id },
    picked.thin && { role: 'thin market', id: picked.thin.id },
    picked.zero && { role: 'ZERO rows in the record', id: picked.zero.id },
  ].filter(Boolean);
  for (const w of want) subjects.push({ kind: 'athlete', ...w });
  const team = opts.team === undefined ? 'univ-cypress:wbb' : opts.team;
  if (team) subjects.push({ kind: 'team', role: 'Cypress team', id: team });
  const missing = [];
  if (!opts.athletes) {
    if (!picked.rich) missing.push('no athlete in a market with rows');
    if (!picked.thin) missing.push('no second market with rows, so no thin-market athlete');
    if (!picked.zero) missing.push('NO athlete has a market with zero rows in the record: pass one with athletes=[id]');
  }
  await pool.query(`INSERT INTO engine_proof_runs (id, options) VALUES ($1,$2)`, [id, { ...opts, subjects, missing }]);
  const state = { id, subjects, missing, results: [], done: false, startedAt: Date.now() };
  _live.set(id, state);
  (async () => {
    // All four at once: the afternoon, not the night.
    state.results = await Promise.all(subjects.map(async (s) => {
      try {
        const res = s.kind === 'team' ? await runTeam(pool, s.id, opts) : await runAthlete(pool, s.id, { ...opts, expectZero: s.role === 'ZERO rows in the record' });
        return { role: s.role, ...res };
      } catch (e) { return { role: s.role, kind: s.kind, id: s.id, ok: false, error: e.message }; }
    }));
    state.done = true;
    await pool.query(`UPDATE engine_proof_runs SET finished_at = NOW(), report = $2 WHERE id = $1`, [id, { subjects, missing, results: state.results }]).catch(() => {});
  })().catch((e) => { state.done = true; state.error = e.message; });
  return { id, subjects, missing };
}

async function get(pool, id) {
  if (_live.has(id)) return _live.get(id);
  await ensureTable(pool);
  const r = (await pool.query(`SELECT * FROM engine_proof_runs WHERE id = $1`, [id])).rows[0];
  if (!r) return null;
  return { id, done: !!r.finished_at, subjects: (r.options || {}).subjects || [], missing: (r.options || {}).missing || [], results: (r.report || {}).results || [] };
}

function formatReport(s) {
  const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
  const out = [`ENGINE PROOF ${s.id}${s.done ? '' : ' (STILL RUNNING)'}`, ''];
  for (const m of s.missing || []) out.push('NOTE: ' + m);
  if ((s.missing || []).length) out.push('');
  if (!s.done) { out.push(`Running: ${(s.subjects || []).map((x) => `${x.role} (${x.id})`).join('; ')}`); return out.join('\n'); }
  for (const r of s.results || []) {
    out.push(`== ${r.role}: ${r.name || r.id}${r.market ? ` -- ${r.market}` : ''}${r.tier ? ` -- tier ${r.tier} (${r.tierWhy})` : ''}`);
    if (r.role === 'ZERO rows in the record' && r.ok) out.push(`   ZERO CONFIRMED: ${r.recordRowsBefore} rows for ${r.marketKey} when the run started, checked with the run's own market key`);
    if (!r.ok) { out.push(`   FAILED: ${r.error}`, ''); continue; }
    out.push(`   ${r.reachedFive ? 'FIVE' : 'SHORT'}: holds ${r.held} of 5 (${r.placed} placed by this run${r.expiredFirst ? `; ${r.expiredFirst} expired first` : ''})`);
    if (r.recordRowsBefore !== undefined) out.push(`   record rows for the market: ${r.recordRowsBefore} before, ${r.recordRowsAfter} after`);
    const f = r.funnel;
    out.push(`   considered ${f.considered} > judge ${f.clearedJudge} > owner finder ${f.clearedOwner} > writer ${f.clearedWriter}`);
    if (f.rejected) out.push(`   dropped: judge ${f.rejected.judge || 0}, owner finder ${f.rejected.ownerFinder || 0}, writer ${f.rejected.writer || 0}, our faults ${f.rejected.ourFaults || 0}`);
    out.push(`   contact hit rate ${pct(f.contactHitRate)}${f.contactPool ? ` (department pool: ${f.contactPool.reachable} reachable of ${f.contactPool.resolved} resolved)` : ''}`);
    out.push(`   cost $${Number(r.costUsd || 0).toFixed(2)}, ${r.seconds}s; rungs ${(r.rungs || []).join(' > ') || 'none'}; stopped by ${r.stop || 'n/a'}`);
    out.push(`   split: ${Object.entries(r.split || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    for (const c of r.cards || []) out.push(`     - ${c.business} [${c.lane || '?'}${c.channel ? ', ' + c.channel : ''}]${c.contact ? ' -> ' + c.contact : ''}${c.new === false ? ' (held from before)' : ''}`);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { start, get, pick, funnel, runAthlete, runTeam, formatReport, ensureTable };
