'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// Run scripts/workflow-timing.js against a real Postgres holding runs and events
// in the shape executeWorkflow actually writes, and check the numbers it reports.
// The step names are lifted from the orchestrator, so a renamed step fails here
// rather than silently reporting "never ran".
const fs = require('fs'), cp = require('child_process'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const DB = 'wftiming';
const WO = fs.readFileSync(REPO + 'server/services/workflowOrchestrator.js', 'utf8');

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/w.sql', text);
  fs.chmodSync('/tmp/pgtest/w.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/w.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return 'ARRAY[' + v.map(lit).join(',') + ']::text[]';
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function bind(text, params) {
  if (!params || !params.length) return text;
  let out = text;
  for (let i = params.length; i >= 1; i--) out = out.split('$' + i).join(lit(params[i - 1]));
  return out;
}
function parseCsv(out) {
  const lines = []; let cur = '', inQ = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"') { if (inQ && out[i + 1] === '"') { cur += '""'; i++; } else inQ = !inQ; cur += ch; continue; }
    if (ch === '\n' && !inQ) { lines.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  if (!lines.length) return [];
  const split = (l) => {
    const cells = []; let c = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; continue; }
      if (ch === ',' && !q) { cells.push(c); c = ''; continue; }
      c += ch;
    }
    cells.push(c); return cells;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l), o = {};
    head.forEach((h, i) => { o[h] = cells[i] === '' ? null : cells[i]; });
    if (typeof o.payload === 'string') { try { o.payload = JSON.parse(o.payload); } catch (_) {} }
    return o;
  });
}
const pool = {
  async query(text, params) {
    const s = bind(text, params);
    if (!(/^\s*(SELECT|WITH)/i.test(s) || /RETURNING/i.test(s))) { psql(s); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(s, true));
    return { rows, rowCount: rows.length };
  },
  async end() {},
};

// ── the step names, taken from the orchestrator ─────────────────────────────
const STEPS = [...WO.matchAll(/await step\('([a-z_]+)'/g)].map((m) => m[1]);
if (STEPS.length !== 7) throw new Error('FIXTURE BROKEN: expected 7 steps, found ' + STEPS.join(','));

psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
psql(`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, agent_id TEXT, athlete_id TEXT,
        brand_name TEXT, status TEXT, steps_completed JSONB, steps_failed JSONB,
        contact_id TEXT, error_message TEXT,
        started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE workflow_events (id SERIAL PRIMARY KEY, run_id TEXT, agent_id TEXT,
        event_type TEXT, payload JSONB DEFAULT '{}', created_at TIMESTAMPTZ);
      CREATE TABLE outreach_logs (id TEXT PRIMARY KEY, agent_id TEXT, athlete_id TEXT,
        brand_name TEXT, brand_key TEXT, subject TEXT, body_html TEXT, status TEXT,
        source TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);

const AG = 'usr_john', ATH = 'ath_amari';
// Run A: the reported shape. Contact discovery is instant because the card's bare
// business phone made it "already supplied", and the run produced no contact.
let base = Date.parse('2026-08-18T02:00:00Z');
const ev = (run, type, offsetMs, payload) =>
  psql(bind(`INSERT INTO workflow_events (run_id, agent_id, event_type, payload, created_at)
             VALUES ($1,$2,$3,$4,$5)`,
    [run, AG, type, payload || {}, new Date(base + offsetMs).toISOString()]));
const mkRun = (id, brand, startOff, endOff, contactId) =>
  psql(bind(`INSERT INTO automation_runs (id, agent_id, athlete_id, brand_name, status,
               steps_completed, steps_failed, contact_id, started_at, completed_at, created_at)
             VALUES ($1,$2,$3,$4,'complete','[]'::jsonb,'[]'::jsonb,$5,$6,$7,$6)`,
    [id, AG, ATH, brand, contactId, new Date(base + startOff).toISOString(), new Date(base + endOff).toISOString()]));

// A: 96s total. enrichment 18s, contacts 0.2s (SKIPPED), match 5s, pitch 9s, deck 61s.
mkRun('run_a', 'Iron Tribe Homewood', 0, 96000, null);
const A = [['enrichment', 500, 18500], ['contact_discovery', 18600, 18800],
  ['brand_match', 18900, 23900], ['pitch_generation', 24000, 33000],
  ['deck_generation', 33100, 94100], ['email_draft', 94200, 94600], ['crm_update', 94700, 95900]];
for (const [s, a, b] of A) { ev('run_a', s + '_started', a); ev('run_a', s + '_complete', b); }
ev('run_a', 'contact_discovery_reused_card', 18650, { enrichmentId: 'e1', named: 0 });

// B: the fan-out actually ran. 132s total, contacts 26s, and it produced a contact.
base += 600000;
mkRun('run_b', 'The Pottery Jar', 0, 132000, 'con_1');
const B = [['enrichment', 400, 21400], ['contact_discovery', 21500, 47500],
  ['brand_match', 47600, 52600], ['pitch_generation', 52700, 61700],
  ['deck_generation', 61800, 129800], ['email_draft', 129900, 130400], ['crm_update', 130500, 131500]];
for (const [s, a, b] of B) { ev('run_b', s + '_started', a); ev('run_b', s + '_complete', b); }

// C: a run that fired even though a warm draft already existed -- a lookup failure,
// not a race.
base += 600000;
psql(bind(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key,
             subject, body_html, status, source, created_at)
           VALUES ($1,$2,$3,$4,$5,'S','<div>b</div>','draft','prewarm',$6)`,
  ['out_warm', AG, ATH, 'Ferrer Auto', 'place:x', new Date(base - 120000).toISOString()]));
mkRun('run_c', 'Ferrer Auto', 0, 40000, 'con_2');
for (const [s, a, b] of [['enrichment', 200, 12200], ['contact_discovery', 12300, 30300],
  ['pitch_generation', 30400, 38400]]) { ev('run_c', s + '_started', a); ev('run_c', s + '_complete', b); }
ev('run_c', 'deck_generation_started', 38500); ev('run_c', 'deck_generation_failed', 39500);

// Some click-path drafts for the 7-day tally.
psql(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, source)
      VALUES ('o1','${AG}','${ATH}','A','draft','prewarm'),
             ('o2','${AG}','${ATH}','B','draft','prewarm'),
             ('o3','${AG}','${ATH}','C','draft',NULL),
             ('o4','${AG}','${ATH}','D','sent','prewarm');`);

// ── run the shipped script ──────────────────────────────────────────────────
const origLoad = Module._load;
Module._load = function (r) { if (r === 'pg') return { Pool: function () { return pool; } }; return origLoad.apply(this, arguments); };
process.env.DATABASE_URL = 'postgres://localhost/wftiming';
process.argv = [process.argv[0], 'workflow-timing.js', '15', '--json'];
const out = [];
const realLog = console.log, realExit = process.exit;
console.log = (...a) => out.push(a.join(' '));
process.exit = () => {};
require(REPO + 'scripts/workflow-timing.js');

setTimeout(() => {
  console.log = realLog; process.exit = realExit; Module._load = origLoad;
  let rep;
  try { rep = JSON.parse(out.join('\n')); }
  catch (e) { realLog('NO JSON:\n' + out.join('\n').slice(0, 1500)); realExit(1); }
  const by = (b) => rep.runs.find((r) => r.brand === b);

  console.log('-- the step names come from the orchestrator, not a copy --');
  ok('all seven steps lifted', STEPS.length === 7, STEPS);
  ok('  including crm_update', STEPS.indexOf('crm_update') !== -1, STEPS);

  console.log('\n-- per-step wall clock is reconstructed from the events --');
  {
    const a = by('Iron Tribe Homewood');
    ok('three runs reported', rep.runs.length === 3, rep.runs.length);
    ok('total is start..complete', a.totalMs === 96000, a.totalMs);
    ok('  enrichment 18s', a.steps.enrichment.ms === 18000, a.steps.enrichment.ms);
    ok('  deck 61s, the single biggest step', a.steps.deck_generation.ms === 61000, a.steps.deck_generation.ms);
    ok('  contact_discovery 0.2s, because it was skipped', a.steps.contact_discovery.ms === 200, a.steps.contact_discovery.ms);
  }

  console.log('\n-- THE REPORTED BUG IS NAMED, NOT JUST TIMED --');
  {
    const a = by('Iron Tribe Homewood');
    ok('the run produced no contact', a.producedContact === false, a.producedContact);
    ok('  and the shortcut says WHY', /^reused_card/.test(a.contactShortcut || ''), a.contactShortcut);
    ok('  with the count that proves it looked for nobody',
      /named=0/.test(a.contactShortcut || ''), a.contactShortcut);
    const b = by('The Pottery Jar');
    ok('a run where the fan-out DID run is not flagged', !b.contactShortcut, b.contactShortcut);
    ok('  and it took 26s', b.steps.contact_discovery.ms === 26000, b.steps.contact_discovery.ms);
    ok('  and produced a contact', b.producedContact === true, b.producedContact);
  }

  console.log('\n-- A FAILED STEP IS SHOWN AS FAILED, NOT MISSING --');
  {
    const c = by('Ferrer Auto');
    ok('deck failed', c.steps.deck_generation.failed === true, c.steps.deck_generation);
    ok('  and its duration is still measured', c.steps.deck_generation.ms === 1000, c.steps.deck_generation.ms);
    ok('a step that never ran is marked not-ran', c.steps.crm_update.ran === false, c.steps.crm_update);
  }

  console.log('\n-- RACE vs LOOKUP FAILURE ARE SEPARATED --');
  {
    ok('the run with a pre-existing warm draft is singled out',
      rep.ranDespiteWarmDraft.length === 1, rep.ranDespiteWarmDraft.map((r) => r.brand_name));
    ok('  and it is the right one',
      rep.ranDespiteWarmDraft[0].brand_name === 'Ferrer Auto', rep.ranDespiteWarmDraft[0]);
    ok('the two genuine races are NOT listed',
      !rep.ranDespiteWarmDraft.some((r) => /Iron Tribe|Pottery/.test(r.brand_name)), rep.ranDespiteWarmDraft);
  }

  console.log('\n-- the draft tally splits prewarm from click --');
  {
    const pwDraft = rep.prewarmCounts.find((r) => r.source === 'prewarm' && r.status === 'draft');
    const click = rep.prewarmCounts.find((r) => r.source === 'click');
    // Number(): the psql-backed shim returns COUNT(*)::int as text, where the real
    // pg driver returns a number. The script does not depend on which, so neither
    // does this.
    ok('prewarm drafts counted', pwDraft && Number(pwDraft.n) === 3, rep.prewarmCounts);
    ok('  click-path drafts counted separately', click && Number(click.n) === 1, rep.prewarmCounts);
  }

  console.log('\nfailures: ' + f);
  realExit(f ? 1 : 0);
}, 3000);
