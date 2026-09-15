#!/usr/bin/env node
'use strict';
// ── EVERY ATHLETE WHOSE SCHOOL DOES NOT RESOLVE BY EXACT MATCH ───────────────
//
//   node scripts/audit-schools.js                       dry run: the list
//   node scripts/audit-schools.js --agent cs@...        one agent's roster
//   node scripts/audit-schools.js --commit --approve ath-1,ath-2
//
// For each college athlete whose stored school is not an exact hit in the
// school map (services/schoolResolver: 'exact', or 'normalized' when only
// case, spacing or a suffix differ), one line:
//
//   athlete id · agent · stored school · what the resolver makes of it
//
// "what the resolver makes of it" is one of
//   FIX -> Virginia Tech (alias)          a correction, ready to apply
//   FIX -> Auburn University (fuzzy 0.83) a correction, ready to apply
//   ? Boston College 0.59                 a near miss, NOT a correction
//   ? Miami University | University of Miami   two candidates; never guessed
//   no match                              nothing close enough to offer
//
// A FIX comes ONLY from the resolver -- the same call the nightly fill makes,
// with its floor (schoolResolver.MARKET_FLOOR, 0.8) and its refusal to pick
// between two schools. The form's suggestion list (floor 0.55) is shown as
// "?" so a human can judge it; it is never applied. The first live audit
// labelled "Stonehill College -> Boston College (0.59)" a FIX from that list,
// which is exactly the confident wrong answer this file exists to prevent.
//
// Dry run by default and writes nothing. With --commit, ONLY the athlete ids
// in --approve are changed, and only when the audit has a single FIX for
// them: data.school becomes the corrected name and the old value is kept in
// data.schoolCorrectedFrom so it can be put back. An approved id with no FIX
// is reported and left alone.
//
// Read-only otherwise. Safe to run against production.

const store = require('../server/store');
const { resolveSchool, MARKET_FLOOR } = require('../server/services/schoolResolver');
const { suggestionsFor } = require('../server/services/schoolCheck');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

// Methods that mean "the stored text IS the school, as written". Anything
// else resolved only by an alias, a typo allowance, or not at all.
const EXACT_METHODS = new Set(['exact', 'normalized']);

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] !== undefined && !/^--/.test(process.argv[i + 1]) ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

// One athlete row -> what the audit says about it. Pure: rows in, verdicts
// out, so the test can feed it rows without a database.
//   { id, agent, school, exact: bool, fix: {name, city, state, method, confidence} | null,
//     candidates: [names] (when ambiguous), verdict: 'ok'|'fix'|'ambiguous'|'none' }
function auditRow(row, opts = {}) {
  const resolve = opts.resolve || resolveSchool;
  const suggest = opts.suggest || suggestionsFor;
  const school = String(row.school || '').trim();
  const out = { id: row.id, agent: row.agent_email || row.agent_name || row.agent_id, agentName: row.agent_name || '', name: row.name || '', school, exact: false, fix: null, candidates: [], verdict: 'none', market: null };
  if (!school) { out.verdict = 'none'; out.note = 'no school on file'; return out; }
  const hit = resolve(school);
  if (hit && hit.city && EXACT_METHODS.has(hit.method)) {
    out.exact = true; out.verdict = 'ok'; out.market = hit.state ? `${hit.city}, ${hit.state}` : hit.city; return out;
  }
  if (hit && hit.city && (hit.confidence === undefined || hit.confidence >= MARKET_FLOOR)) {
    // An alias or a typo allowance: the resolver is sure enough to use it at
    // night, and correcting the stored text makes that permanent and visible.
    out.fix = { name: hit.matched, city: hit.city, state: hit.state, method: hit.method, confidence: hit.confidence };
    out.market = hit.state ? `${hit.city}, ${hit.state}` : hit.city;
    out.verdict = hit.matched && hit.matched !== school ? 'fix' : 'ok';
    if (out.verdict === 'ok') out.exact = true;
    return out;
  }
  // Nothing the nightly fill would use. The near misses are listed for a
  // human to judge -- with their scores -- and are never a FIX.
  const sugs = (suggest(school) || []).filter((x) => x && x.name);
  if (sugs.length) {
    out.candidates = sugs.map((x) => `${x.name} ${x.score}`);
    out.verdict = 'ambiguous';
  }
  return out;
}

function describe(a) {
  if (a.verdict === 'fix') return `FIX -> ${a.fix.name} (${a.fix.method}${a.fix.confidence !== undefined && a.fix.confidence < 1 ? ' ' + a.fix.confidence : ''}) = ${a.fix.city}${a.fix.state ? ', ' + a.fix.state : ''}`;
  if (a.verdict === 'ambiguous') return `? ${a.candidates.join(' | ')}`;
  return a.note || 'no match';
}

async function loadRows(P, who) {
  const params = [];
  let where = `COALESCE(a.data->>'athleteType', 'college') <> 'pro'`;
  if (who) { params.push(who); where += ` AND (u.id = $1 OR LOWER(TRIM(u.email)) = LOWER(TRIM($1)))`; }
  const r = await P.query(
    `SELECT a.id, a.agent_id, a.data->>'name' AS name, a.data->>'school' AS school,
            u.name AS agent_name, u.email AS agent_email
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
      WHERE ${where}
      ORDER BY u.email NULLS LAST, a.created_at ASC`, params);
  return r.rows || [];
}

async function applyFix(P, a) {
  const cur = (await P.query(`SELECT data FROM athletes WHERE id = $1`, [a.id])).rows[0];
  if (!cur) return { id: a.id, ok: false, why: 'row gone' };
  if (String((cur.data || {}).school || '').trim() !== a.school) return { id: a.id, ok: false, why: `school changed since the audit (now "${(cur.data || {}).school}")` };
  await P.query(
    `UPDATE athletes SET data = data || jsonb_build_object('school', $2::text, 'schoolCorrectedFrom', $3::text, 'schoolCorrectedAt', $4::text), updated_at = NOW() WHERE id = $1`,
    [a.id, a.fix.name, a.school, new Date().toISOString()]);
  return { id: a.id, ok: true, from: a.school, to: a.fix.name };
}

async function main() {
  const commit = flag('commit');
  const who = arg('agent', null);
  const approve = String(arg('approve', '')).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (commit && !approve.length) { console.log('audit-schools: --commit needs --approve <athlete id,...>. Nothing written.'); process.exit(1); }
  console.log(`audit-schools: ${commit ? 'COMMIT' : 'DRY RUN'}${who ? '  agent=' + who : ''}  via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  const rows = await loadRows(P, who);
  const audited = rows.map((r) => auditRow(r));
  const flagged = audited.filter((a) => a.verdict !== 'ok');
  const n = { total: audited.length, ok: audited.length - flagged.length, fix: 0, ambiguous: 0, none: 0 };
  for (const a of flagged) n[a.verdict]++;

  console.log(`\n${n.total} college athletes: ${n.ok} resolve by exact match, ${flagged.length} do not (${n.fix} with a correction, ${n.ambiguous} ambiguous, ${n.none} no match)\n`);
  if (flagged.length) {
    console.log(`  ${pad('athlete id', 20)} ${pad('agent', 34)} ${pad('athlete', 22)} ${pad('stored school', 34)} resolver`);
    for (const a of flagged) console.log(`  ${pad(a.id, 20)} ${pad(a.agent, 34)} ${pad(a.name, 22)} ${pad(a.school || '(blank)', 34)} ${describe(a)}`);
  }

  if (!commit) {
    const ready = flagged.filter((a) => a.verdict === 'fix').map((a) => a.id);
    if (ready.length) console.log(`\nDry run: nothing written. To apply the FIX lines you agree with:\n  node scripts/audit-schools.js --commit --approve ${ready.join(',')}`);
    else console.log('\nDry run: nothing written.');
    await P.end(); process.exit(0);
  }

  console.log('\nAPPLYING approved corrections');
  let applied = 0;
  for (const id of approve) {
    const a = audited.find((x) => x.id === id);
    if (!a) { console.log(`  ${id}: not in this audit (wrong id, a pro, or another agent's athlete when --agent is set); skipped`); continue; }
    if (a.verdict !== 'fix') { console.log(`  ${id}: no single correction (${describe(a)}); skipped`); continue; }
    const r = await applyFix(P, a);
    if (r.ok) { applied++; console.log(`  ${id}: "${r.from}" -> "${r.to}"`); }
    else console.log(`  ${id}: NOT changed: ${r.why}`);
  }
  console.log(`\nAPPLIED ${applied} of ${approve.length} approved. The old name is kept in data.schoolCorrectedFrom on each.`);
  await P.end(); process.exit(0);
}

module.exports = { auditRow, describe, applyFix, loadRows, EXACT_METHODS };
if (require.main === module) main().catch((e) => { console.error('audit-schools: FAILED', e && e.message ? e.message : e); process.exit(1); });
