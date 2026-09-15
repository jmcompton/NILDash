'use strict';
// Runs from a checkout on any machine against the local test Postgres. Boots
// the real server on a spare port and drives the four import calls the way
// the screen does.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/importui.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const { spawn } = require('child_process');

// ── IMPORT FROM SPREADSHEET: UPLOAD, MATCH COLUMNS, PREVIEW AND FIX, CREATE ──
//
// The agent-side import on Add Client. The same module as the CLI importer
// (services/rosterImport) does the reading and the placing; these calls wrap
// it for the screen. Checked here end to end: a file is parsed and its
// columns auto-matched; a corrected column map is honoured; the preview
// splits rows into create / needs a fix / skipped; a fix typed into the
// preview changes the outcome; the seat rule refuses an over-limit commit;
// a commit creates the athletes as the form would and starts nothing twice.

const store = require(REPO + 'server/store.js');
const bcrypt = require(REPO + 'node_modules/bcryptjs');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const PORT = parseInt(process.env.IMPORT_TEST_PORT, 10) || 3519;
const BASE = 'http://127.0.0.1:' + PORT;
const AG = 'imp-agent', EMAIL = 'imp-agent@x.com', PASS = 'pw-imp-test';

const CSV = `First,Last,Sport,School/Affiliation,Total followers,Instagram handle,Instagram followers,TikTok handle,TikTok followers
Cooper,Farrall,Basketball,Bentley University,"15,000+",@t1dhooper/@cooperfarrall,"11,100/4,254",@cooperfarrall,643
Caleb,Manuel,Golf,Professional Golfer,"4,500+",@calebmanuel59/@calebgolf59,"3,612/1,034",@Caleb.Manuel03,128
Abby,Turnpaugh,Softball,University of Manhattan,"1,700+",abby.turnpaugh,"1,534",@abbyturnpaugh,219
Emma,Boulanger,Basketball and Softball,UMaine at Augusta,"1,200+",emmaboulanger,759,@emma_boulanger,566
Kaylee,Sakoda,Golf,Professional Golfer,"1,200+",@kay_sakoda,"1,213",@kaylee sakoda,186
Ella,Boerger,Hockey,University of St. Thomas,"1,200+",@ella.boerger,"1,262",,
Pat,Quinn,Esports,Stonehill College,"900",@patq,"900",,
`;

let server = null, cookie = '';
async function boot() {
  const env = { ...process.env, PORT: String(PORT), SESSION_SECRET: 'imp-test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-test', GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY || 'x',
    OUTREACH_QUEUE_ENABLED: '0', NODE_ENV: 'development' /* the session cookie is Secure outside development, and this server speaks http */ };
  server = spawn(process.execPath, [REPO + 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up:\n' + log.slice(-1500));
}
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text().catch(() => '');
  let body = text; try { body = JSON.parse(text); } catch (_) { /* not JSON: a CSV, say */ }
  return { status: r.status, body, headers: r.headers };
}
async function postJson(path, data) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM outreach_queue_ondemand WHERE athlete_id IN (SELECT id FROM athletes WHERE agent_id = $1)`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  const hash = await bcrypt.hash(PASS, 4);
  await P().query(`INSERT INTO users (id,name,email,password,role,plan_tier,last_login) VALUES ($1,'Import Agent',$2,$3,'agent','basic',NOW() - INTERVAL '30 days')`, [AG, EMAIL, hash]);
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('imp-a1',$1,$2)`, [AG, { name: 'Cooper Farrall', sport: 'basketball', school: 'Bentley University' }]);

  await boot();
  const login = await postJson('/api/auth/login', { email: EMAIL, password: PASS });
  ok('logs in', login.status === 200 && !!cookie, login);

  // ── 1. TEMPLATE ──────────────────────────────────────────────────────────
  OUT.push('-- template --');
  const t = await api('/api/athletes/import/template');
  ok('the blank template downloads as CSV', t.status === 200 && /text\/csv/.test(t.headers.get('content-type') || '') && /^First,Last,Sport,School\/Affiliation,City/.test(String(t.body)), String(t.body).slice(0, 80));
  ok('  with an attachment name', /nildash-roster-template\.csv/.test(t.headers.get('content-disposition') || ''));

  // ── 2. PARSE + AUTO-MATCH ────────────────────────────────────────────────
  OUT.push('', '-- upload --');
  const fd = new FormData();
  fd.append('file', new Blob([CSV], { type: 'text/csv' }), 'greg-roster.csv');
  const up = await api('/api/athletes/import/parse', { method: 'POST', body: fd });
  ok('a CSV uploads and parses', up.status === 200 && up.body.rowCount === 7, up.body && (up.body.error || up.body.rowCount));
  const cols = (up.body && up.body.columns) || {};
  ok('  columns auto-match', cols.first === 0 && cols.last === 1 && cols.sport === 2 && cols.affiliation === 3 && cols.instagramHandle === 5 && cols.tiktok === 8, cols);
  ok('  the header, a sample and the field list come back for the mapping step', Array.isArray(up.body.header) && up.body.header.length === 9 && up.body.sample.length === 3 && up.body.fields.some((f) => f.key === 'city'));
  const bad = new FormData(); bad.append('file', new Blob(['x'], { type: 'image/png' }), 'pic.png');
  const badUp = await api('/api/athletes/import/parse', { method: 'POST', body: bad });
  ok('a non-spreadsheet is refused with a reason', badUp.status === 400 && /CSV or Excel/.test(badUp.body.error || ''), badUp.body);
  // Excel: the same rows written as .xlsx through the library the server reads with.
  const XLSX = require(REPO + 'node_modules/xlsx');
  const ws = XLSX.utils.aoa_to_sheet(require(REPO + 'server/services/rosterImport.js').parseCsv(CSV));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fx = new FormData(); fx.append('file', new Blob([xbuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'greg-roster.xlsx');
  const upx = await api('/api/athletes/import/parse', { method: 'POST', body: fx });
  ok('an Excel file parses to the same table', upx.status === 200 && upx.body.rowCount === 7 && upx.body.table[1][0] === 'Cooper' && upx.body.columns.sport === 2, upx.body && (upx.body.error || upx.body.rowCount));

  // ── 3. PREVIEW ───────────────────────────────────────────────────────────
  OUT.push('', '-- preview --');
  const table = up.body.table;
  const noName = await postJson('/api/athletes/import/preview', { table, columns: { sport: 2 } });
  ok('a map without a name column is refused', noName.status === 400 && /name/.test(noName.body.error || ''), noName.body);
  const pv = await postJson('/api/athletes/import/preview', { table, columns: cols, overrides: {} });
  ok('the preview answers', pv.status === 200, pv.body && pv.body.error);
  const names = (list) => list.map((p) => p.name);
  ok('  will create: Abby, Emma, Ella (schools resolve; no lookup needed)', JSON.stringify(names(pv.body.create).sort()) === JSON.stringify(['Abby Turnpaugh', 'Ella Boerger', 'Emma Boulanger']), names(pv.body.create));
  ok('  Emma is basketball with softball noted', pv.body.create.some((p) => p.name === 'Emma Boulanger' && p.sport === 'basketball' && p.notes.some((n) => /softball/.test(n))));
  ok('  markets come from the resolver', pv.body.create.every((p) => p.market), pv.body.create.map((p) => [p.name, p.market]));
  ok('  skipped: Cooper, already on the roster', pv.body.skipped.length === 1 && pv.body.skipped[0].name === 'Cooper Farrall' && /already on the roster/.test(pv.body.skipped[0].skip), pv.body.skipped);
  const fixNames = names(pv.body.needsFix).sort();
  ok('  needs a fix: the two golfers (city) and Pat (sport)', JSON.stringify(fixNames) === JSON.stringify(['Caleb Manuel', 'Kaylee Sakoda', 'Pat Quinn']), fixNames);
  const pat = pv.body.needsFix.find((p) => p.name === 'Pat Quinn');
  ok('    Pat needs a sport, and the file\'s word is shown', pat && pat.fix.includes('sport') && pat.sportRaw === 'Esports', pat && pat.fix);
  const caleb = pv.body.needsFix.find((p) => p.name === 'Caleb Manuel');
  ok('    Caleb needs a city', caleb && pat && caleb.fix.includes('city') && !caleb.fix.includes('sport'), caleb && caleb.fix);
  ok('  the seat line: 1 now, 3 adding, of 10 (plan)', pv.body.seats.now === 1 && pv.body.seats.adding === 3 && pv.body.seats.limit === 10 && pv.body.seats.over === 0, pv.body.seats);

  // A corrected column map is honoured: swap Instagram and TikTok handles.
  const swapped = { ...cols, instagramHandle: 7, tiktokHandle: 5 };
  const pv2 = await postJson('/api/athletes/import/preview', { table, columns: swapped, overrides: {} });
  const abby2 = pv2.body.create.find((p) => p.name === 'Abby Turnpaugh');
  ok('a corrected column map is used (handles swapped)', abby2 && abby2.instagramHandle === 'abbyturnpaugh' && abby2.tiktokHandle === 'abby.turnpaugh', abby2 && [abby2.instagramHandle, abby2.tiktokHandle]);

  // Fixes typed in the preview: Caleb gets a city, Pat gets a sport, Kaylee is left.
  const overrides = { [caleb.line]: { city: 'Portland, ME' }, [pat.line]: { sport: 'golf' } };
  const pv3 = await postJson('/api/athletes/import/preview', { table, columns: cols, overrides });
  ok('after fixes, Caleb and Pat move to create', JSON.stringify(names(pv3.body.create).sort()) === JSON.stringify(['Abby Turnpaugh', 'Caleb Manuel', 'Ella Boerger', 'Emma Boulanger', 'Pat Quinn']), names(pv3.body.create));
  const caleb3 = pv3.body.create.find((p) => p.name === 'Caleb Manuel');
  ok('  Caleb is a pro in Portland, ME with no team', caleb3 && caleb3.athleteType === 'pro' && caleb3.market === 'Portland, ME' && caleb3.team === '', caleb3);
  const pat3 = pv3.body.create.find((p) => p.name === 'Pat Quinn');
  ok('  Pat is a golfer at Stonehill, Easton MA', pat3 && pat3.sport === 'golf' && /Easton/.test(pat3.market || ''), pat3 && [pat3.sport, pat3.market]);
  ok('  Kaylee still needs a fix', pv3.body.needsFix.length === 1 && pv3.body.needsFix[0].name === 'Kaylee Sakoda');

  // ── 4. THE SEAT RULE ─────────────────────────────────────────────────────
  OUT.push('', '-- seats --');
  await P().query(`UPDATE users SET seat_override = 3 WHERE id = $1`, [AG]);
  const over = await postJson('/api/athletes/import/commit', { table, columns: cols, overrides });
  ok('a commit over the limit is refused, naming the numbers', over.status === 403 && over.body.code === 'SEAT_LIMIT_REACHED' && /1 on the roster plus 5 new is 3 over/.test(over.body.error), over.body);
  ok('  and says where the limit came from', over.body.seatSource === 'override' && /support/.test(over.body.error));
  const nRows = (await P().query(`SELECT COUNT(*)::int n FROM athletes WHERE agent_id = $1`, [AG])).rows[0].n;
  ok('  nothing was created', nRows === 1, nRows);
  await P().query(`UPDATE users SET seat_override = 0 WHERE id = $1`, [AG]);
  const pvNoLimit = await postJson('/api/athletes/import/preview', { table, columns: cols, overrides });
  ok('with no limit the seat line says so', pvNoLimit.body.seats.limit === null && pvNoLimit.body.seats.source === 'override', pvNoLimit.body.seats);

  // ── 5. COMMIT ────────────────────────────────────────────────────────────
  OUT.push('', '-- create --');
  const c = await postJson('/api/athletes/import/commit', { table, columns: cols, overrides });
  ok('the commit creates the five', c.status === 201 && c.body.ok && c.body.created.length === 5, c.body);
  ok('  and reports the skipped and unfixed counts', c.body.skipped === 1 && c.body.needsFix === 1, c.body);
  const rows = (await P().query(`SELECT id, data FROM athletes WHERE agent_id = $1 AND id LIKE 'ath-%' ORDER BY created_at`, [AG])).rows;
  ok('five athlete rows exist, agent-managed', rows.length === 5, rows.length);
  const byName = {}; for (const r of rows) byName[r.data.name] = r.data;
  ok('  Caleb: pro, Portland, ME, both Instagram handles kept', byName['Caleb Manuel'] && byName['Caleb Manuel'].athleteType === 'pro' && byName['Caleb Manuel'].city === 'Portland, ME' && byName['Caleb Manuel'].instagramHandle === 'calebmanuel59' && byName['Caleb Manuel'].instagramHandleAlt === 'calebgolf59', byName['Caleb Manuel']);
  ok('  Ella: college, ice hockey, University of St. Thomas, reach dated to the agent', byName['Ella Boerger'] && byName['Ella Boerger'].sport === 'ice hockey' && byName['Ella Boerger'].school === 'University of St. Thomas' && byName['Ella Boerger'].reachSource === 'agent' && byName['Ella Boerger'].instagram === 1262, byName['Ella Boerger']);
  ok('  Pat: golf at Stonehill', byName['Pat Quinn'] && byName['Pat Quinn'].sport === 'golf' && byName['Pat Quinn'].school === 'Stonehill College');
  ok('  imported rows say where they came from', rows.every((r) => r.data.importedFrom === 'csv' && r.data.importedAt));
  const u = (await P().query(`SELECT last_login > NOW() - INTERVAL '1 minute' AS fresh FROM users WHERE id = $1`, [AG])).rows[0];
  ok('the agent\'s dormant clock reset', u.fresh === true, u);
  ok('the fill was not started because the queue is off in this test (OUTREACH_QUEUE_ENABLED=0)', c.body.filling === false, c.body.filling);
  const again = await postJson('/api/athletes/import/commit', { table, columns: cols, overrides });
  ok('a second commit of the same file creates nothing: all now on the roster', again.status === 400 && /Nothing to create/.test(again.body.error) && again.body.preview.skipped.length === 6, again.body && (again.body.error || again.status));

  // ── 6. THE SCREEN ────────────────────────────────────────────────────────
  OUT.push('', '-- the screen --');
  const html = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('Add Client has the button', /onclick="impOpen\(\)"[^>]*>[^<]*Import from spreadsheet/.test(html));
  ok('  a template link', /href="\/api\/athletes\/import\/template"/.test(html));
  ok('  the four steps', ['imp-step-1', 'imp-step-2', 'imp-step-3', 'imp-step-4'].every((id) => html.includes('id="' + id + '"')));
  ok('  a column map the agent can change', /function impMapChanged\(sel\)/.test(html) && /One column per field/.test(html));
  ok('  a preview with create / needs a fix / skipped', /Will create ' \+ d\.create\.length/.test(html) && /Needs a fix ' \+ d\.needsFix\.length/.test(html) && /Skipped ' \+ d\.skipped\.length/.test(html));
  ok('  editable cells in the fix rows that re-run the preview', /oninput="impFix\(' \+ p\.line \+ ',\\'city\\',this\.value\)"/.test(html) && /onclick="impPreview\(\)">Re-check fixes/.test(html));
  ok('  the create button is disabled when over the seat limit or nothing to create', /cb\.disabled = !d\.create\.length \|\| s\.over > 0/.test(html));
  ok('  the commit sends the same table, columns and fixes as the preview', (html.match(/body: JSON\.stringify\(\{ table: IMP\.table, columns: IMP\.columns, overrides: IMP\.overrides \}\)/g) || []).length === 2);
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the commit places rows again server-side and fills each new athlete in turn', /const pv = await importPreview\(user, req\.body \|\| \{\}\);/.test(idx) && /await runOnDemandFills\(user\.id, c\.id\)/.test(idx));
  ok('  and the university imports are untouched', /app\.post\('\/api\/university\/bulk-import'/.test(idx) && /app\.post\('\/api\/university\/roster\/preview'/.test(idx));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  if (server) server.kill('SIGTERM');
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch(async (e) => { console.error('THREW', e); if (server) server.kill('SIGTERM'); process.exit(1); });
