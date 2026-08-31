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
// Is the pre-warmed draft still the one the modal reads?
//
// Runs the SHIPPED GET /api/outreach/draft handler against a real Postgres holding
// a row written exactly the way draftPrewarm.js writes one, with an agent
// principal -- i.e. the read half of the pre-warm contract, end to end.
//
// The question this answers: did tonight's recipient/principal work break the
// hit, so the modal falls through to /run and regenerates?
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const RT = fs.readFileSync(R + 'server/routes/outreach.js', 'utf8');
const PW = fs.readFileSync(R + 'server/services/draftPrewarm.js', 'utf8');
const DB = 'prewarmread';

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/p.sql', text);
  fs.chmodSync('/tmp/pgtest/p.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/p.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
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
};

psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
// outreach_logs columns the two halves of the contract touch.
psql(`CREATE TABLE outreach_logs (
        id TEXT PRIMARY KEY, agent_id TEXT, athlete_id TEXT, brand_name TEXT, brand_key TEXT,
        subject TEXT, body_html TEXT, status TEXT, source TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);

const AGENT = 'usr_john', ATHLETE = 'ath_amari';
const BRAND = 'Iron Tribe Homewood', KEY = 'place:ChIJfixtureA';

// ── write it the way draftPrewarm.js writes it ──────────────────────────────
// The INSERT is lifted from the shipped file rather than retyped, so a column or
// a status the prewarm changes shows up here as a failure instead of a false pass.
const INS = PW.slice(PW.indexOf('`INSERT INTO outreach_logs'), PW.indexOf('ON CONFLICT DO NOTHING`') + 'ON CONFLICT DO NOTHING`'.length);
if (!/status, source/.test(INS) || !/'draft','prewarm'/.test(INS)) throw new Error('FIXTURE BROKEN: prewarm INSERT lifted wrong: ' + INS.slice(0, 200));
const insertSql = INS.replace(/^`|`$/g, '');
psql(bind(insertSql, ['out_prewarm_1', AGENT, ATHLETE, BRAND, KEY,
  'Amari Allen x Iron Tribe Homewood', '<div>Hi,</div><div><br></div><div>Amari runs distance at Samford.</div>']));

// ── lift and run the shipped /draft handler ─────────────────────────────────
function liftHandler(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('FIXTURE BROKEN, no route: ' + marker);
  const bodyStart = src.indexOf('async (req, res) => {', start);
  let d = 0, j = src.indexOf('{', bodyStart), end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return src.slice(bodyStart, end + 1);
}
const DRAFT = liftHandler(RT, "router.get('/draft'");
if (!/no draft yet/.test(DRAFT)) throw new Error('FIXTURE BROKEN: /draft lifted wrong');

const makeDraft = () => new Function('pool', 'console', 'const h = ' + DRAFT + '; return h;')(
  pool, { log() {}, warn() {}, error() {} });
const mkRes = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (principal, query) => {
  const res = mkRes();
  await makeDraft()({ principal, query, session: principal.kind === 'agent' ? { userId: principal.id } : null }, res);
  return res;
};

(async () => {
  const AGENT_P = { kind: 'agent', id: AGENT };

  console.log('-- THE PRE-WARM CONTRACT, BOTH HALVES --');
  {
    // The client sends brandKey when the card has one. This is the hot path.
    const res = await call(AGENT_P, { athleteId: ATHLETE, brandKey: KEY, brand: BRAND });
    ok('THE MODAL GETS A HIT', res.code === 200, { code: res.code, body: res.body });
    ok('  it is the pre-warmed row', res.body && res.body.source === 'prewarm', res.body && res.body.source);
    ok('  with a body the modal can render', !!(res.body && res.body.body_html), res.body && res.body.body_html);
    ok('  and its id, so edits PATCH the same row', res.body && res.body.id === 'out_prewarm_1', res.body && res.body.id);
  }
  {
    // A card that lost its key falls back to the brand name.
    const res = await call(AGENT_P, { athleteId: ATHLETE, brand: BRAND });
    ok('a name-only lookup hits too', res.code === 200, { code: res.code, body: res.body });
    const ci = await call(AGENT_P, { athleteId: ATHLETE, brand: 'iron tribe homewood' });
    ok('  case-insensitively', ci.code === 200, ci.code);
  }

  console.log('\n-- AND IT IS STILL SCOPED --');
  {
    const other = await call({ kind: 'agent', id: 'usr_someone_else' }, { athleteId: ATHLETE, brandKey: KEY });
    ok('another agent cannot read it', other.code === 404, other.code);
    const wrongAth = await call(AGENT_P, { athleteId: 'ath_other', brandKey: KEY });
    ok('nor the same agent for a different athlete', wrongAth.code === 404, wrongAth.code);
  }

  console.log('\n-- A MISS IS A 404, WHICH IS WHAT SENDS THE MODAL TO /run --');
  {
    const miss = await call(AGENT_P, { athleteId: ATHLETE, brandKey: 'place:never-warmed' });
    ok('an unwarmed brand is 404', miss.code === 404, miss.code);
  }
  {
    // The prewarm writes status='draft'. Once an outreach is SENT the row no longer
    // satisfies the read, and the next open regenerates. Worth knowing: it is a
    // deliberate miss, not a bug.
    psql(`UPDATE outreach_logs SET status='sent' WHERE id='out_prewarm_1';`);
    const sent = await call(AGENT_P, { athleteId: ATHLETE, brandKey: KEY });
    ok('a SENT outreach stops being a warm draft', sent.code === 404, sent.code);
    psql(`UPDATE outreach_logs SET status='draft' WHERE id='out_prewarm_1';`);
  }

  console.log('\n-- NOTHING IN TONIGHT\'S WORK GATES THE PRE-WARM BRANCH --');
  {
    const OE = fs.readFileSync(R + 'public/outreach-engine.js', 'utf8');
    const gen = OE.slice(OE.indexOf('async function generateOutreach'), OE.indexOf('function cardContacts'));
    ok('the modal still asks for the warm draft FIRST',
      gen.indexOf('fetchPrewarmedDraft') < gen.indexOf("outreachAPI.post('/run'"), null);
    ok('  and returns without posting /run on a hit',
      /if \(pre\) \{\s*\n\s*renderPrewarmedDraft\(pre, dealResult, athleteId\);\s*\n\s*return;/.test(gen), gen.slice(0, 400));
    // pickCardContact runs AFTER the branch is taken. It cannot influence it.
    const pre = OE.slice(OE.indexOf('function renderPrewarmedDraft'), OE.indexOf('function pickCardContact'));
    ok('pickCardContact is used inside renderPrewarmedDraft, downstream of the hit',
      /const contact = pickCardContact\(dealResult\);/.test(pre), null);
    ok('  and fetchPrewarmedDraft does not reference it at all',
      !/pickCardContact/.test(OE.slice(OE.indexOf('async function fetchPrewarmedDraft'), OE.indexOf('function renderPrewarmedDraft'))), null);
    ok('the draft fetch is unchanged tonight',
      /const r = await fetch\('\/api\/outreach\/draft\?' \+ qs, \{ credentials: 'include' \}\);/.test(OE), null);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
