'use strict';
// Runs against the local test Postgres. No network: every service is a stub.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/opsstatus.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE PREFLIGHT, THE MORNING ALERT'S NEW SECTIONS, AND /admin/status ─────
// Nothing that fails outside may go quiet: each outside service is checked
// before the night, the result is written down, a failure is alerted with what
// it breaks, and one page shows all of it.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const PF = require(REPO + 'server/services/preflight.js');
const MA = require(REPO + 'server/services/morningAlert.js');
const SP = require(REPO + 'server/services/statusPage.js');
const ai = require(REPO + 'server/ai.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const ENV_KEYS = ['ADMIN_ALERT_EMAIL', 'ADMIN_EMAIL', 'GOOGLE_PLACES_API_KEY', 'HUNTER_API_KEY', 'RESEND_API_KEY', 'ADMIN_ALERT_FROM', 'NIGHTLY_DIGEST_FROM'];
const SAVED = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function env(vals) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vals);
}

// A fake outside world. `down` names the services that fail, with the
// provider's own words.
function world(down = {}) {
  const res = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  const fetch = async (url) => {
    if (/places\.googleapis/.test(url)) {
      if (down.places) return res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: down.places } });
      return res(200, { places: [{ id: 'p1' }] });
    }
    if (/hunter\.io/.test(url)) {
      if (down.hunter) return res(401, { errors: [{ id: 'authentication_failed', details: down.hunter }] });
      return res(200, { data: { requests: { searches: { available: 500, used: down.hunterSpent ? 500 : 12 } } } });
    }
    if (/api\.resend\.com\/domains/.test(url)) {
      if (down.resend) return res(401, { name: 'validation_error', message: down.resend });
      return res(200, { data: [{ name: 'mynildash.com', status: down.resendUnverified ? 'pending' : 'verified' }] });
    }
    throw new Error('unexpected url ' + url);
  };
  const aiStub = {
    MODEL_FAST: 'fast-model',
    _webSearchFault: ai._webSearchFault,
    getClient: () => ({ messages: { create: async (req) => {
      if (down.anthropic) { const e = new Error(down.anthropic); e.status = 529; throw e; }
      if (req.tools && down.webSearchTool) return { content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: down.webSearchTool } }] };
      return { content: req.tools ? [{ type: 'web_search_tool_result', content: [] }, { type: 'text', text: 'ok' }] : [{ type: 'text', text: 'p' }] };
    } } }),
  };
  const ds = { apiKey: () => 'k', model: () => 'deepseek-chat', chat: async () => { if (down.deepseek) throw new Error(down.deepseek); return {}; } };
  const wst = { provider: () => (down.noSearchProvider ? null : { name: 'serper', search: async () => { if (down.serper) throw new Error(down.serper); return [{ url: 'x' }]; } }) };
  // Mailboxes other suites left connected must not reach Google or Microsoft.
  const prov = { isAvailable: () => true, refreshAccessToken: async () => ({ access_token: 'a' }) };
  return { fetch, ai: aiStub, ds, wst, gmail: prov, outlook: prov, emailStore: { getEmailAccountWithTokens: async () => ({ refreshToken: 'rt' }) } };
}

const AG = 'opsstatus-agent';
const UNI = 'univ-opstest';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE CHECKS ─────────────────────────────────────────────────────────
  OUT.push('-- every outside service, one real call each --');
  const GOOD = { ADMIN_ALERT_EMAIL: 'ops@alert.test', GOOGLE_PLACES_API_KEY: 'g', HUNTER_API_KEY: 'h', RESEND_API_KEY: 'r' };
  env(GOOD);
  const names = Object.keys(PF.checks({ pool: P }));
  for (const s of ['database', 'admin-alert-email', 'google-places', 'anthropic', 'anthropic-web-search', 'deepseek', 'web-search', 'hunter', 'resend', 'mailbox-tokens']) {
    ok(`  the preflight checks ${s}`, names.includes(s), names);
  }
  ok('every checked service has a plain "what will not work tonight"', names.every((n) => PF.CONSEQUENCE[n]) && PF.CONSEQUENCE['token-encryption'], names.filter((n) => !PF.CONSEQUENCE[n]));

  const allGood = await PF.runAll(P, { deps: world() });
  const noAthleteMailboxes = allGood.results.find((r) => r.service === 'mailbox-tokens');
  ok('with everything answering, nothing fails', allGood.failed.length === 0, allGood.failed);
  ok('  each result carries a response time', allGood.results.every((r) => Number.isInteger(r.ms) && r.ms >= 0));
  const rows = (await P.query(`SELECT service, ok, ms, error FROM service_checks WHERE run_id = $1`, [allGood.runId])).rows;
  ok('  and every one is written to service_checks', rows.length === allGood.results.length && rows.every((r) => r.ok), rows.length);
  ok('  no mailbox is not a failure', noAthleteMailboxes && noAthleteMailboxes.ok);

  const down = await PF.runAll(P, { deps: world({ places: 'Places API (New) has not been used in project 123 before or it is disabled.' }) });
  const g = down.failed.find((f) => f.service === 'google-places');
  ok('Google down: google-places fails with Google\'s own words', g && /HTTP 403: Places API \(New\) has not been used/.test(g.error), down.failed);
  const gRow = (await P.query(`SELECT ok, error FROM service_checks WHERE run_id = $1 AND service = 'google-places'`, [down.runId])).rows[0];
  ok('  written as not ok, with the error text', gRow && gRow.ok === false && /has not been used/.test(gRow.error), gRow);
  const fRow = (await P.query(`SELECT reason FROM service_faults WHERE service = 'google-places' AND context = 'preflight' ORDER BY at DESC LIMIT 1`)).rows[0];
  ok('  and recorded as a fault on our side', fRow && /has not been used/.test(fRow.reason), fRow);
  const msg = PF.render(down, Date.parse('2031-04-01T05:30:00Z'));
  ok('the alert names the service in the subject', /PREFLIGHT FAILED: google-places/.test(msg.subject), msg.subject);
  ok('  and says plainly what will not work tonight', /What will not work tonight: Places market builds fail, so no new businesses are discovered tonight/.test(msg.text), msg.text);
  ok('  and links the status page', /\/admin\/status/.test(msg.text));

  const each = async (d, service, re) => {
    const r = await PF.runAll(P, { deps: world(d) });
    const f = r.failed.find((x) => x.service === service);
    ok(`  ${service}: ${re}`, f && re.test(f.error), r.failed);
  };
  await each({ anthropic: 'Overloaded' }, 'anthropic', /Overloaded/);
  await each({ webSearchTool: 'too_many_requests' }, 'anthropic-web-search', /too_many_requests/);
  await each({ deepseek: 'Insufficient Balance' }, 'deepseek', /Insufficient Balance/);
  await each({ serper: 'HTTP 403: Not enough credits' }, 'web-search', /Not enough credits/);
  await each({ noSearchProvider: true }, 'web-search', /no web search provider key is set/);
  await each({ hunter: 'No user found for the API key supplied' }, 'hunter', /HTTP 401: No user found/);
  await each({ hunterSpent: true }, 'hunter', /no Hunter searches left/);
  await each({ resend: 'API key is invalid' }, 'resend', /HTTP 401: API key is invalid/);
  await each({ resendUnverified: true }, 'resend', /mynildash\.com is pending, not verified/);

  // ── 2. THE ALERT HAS SOMEWHERE TO GO ─────────────────────────────────────
  OUT.push('', '-- an alert with no destination is worse than no alert --');
  env({ ...GOOD, ADMIN_ALERT_EMAIL: '' });
  delete process.env.ADMIN_ALERT_EMAIL;
  const noDest = await PF.runAll(P, { deps: world() });
  const nd = noDest.failed.find((f) => f.service === 'admin-alert-email');
  ok('ADMIN_ALERT_EMAIL and ADMIN_EMAIL both unset: the preflight fails loudly', nd && /neither ADMIN_ALERT_EMAIL nor ADMIN_EMAIL is set/.test(nd.error), noDest.failed);
  ok('  and says failures tonight will reach no one', /nowhere to go/.test(PF.render(noDest).text));
  env({ ...GOOD, ADMIN_ALERT_EMAIL: 'not an address' });
  const bad = await PF.runAll(P, { deps: world() });
  ok('  a destination that is not an email address fails too', bad.failed.some((f) => f.service === 'admin-alert-email' && /is not an email address/.test(f.error)));
  env({ ...GOOD, ADMIN_ALERT_EMAIL: '', ADMIN_EMAIL: 'owner@alert.test' });
  delete process.env.ADMIN_ALERT_EMAIL;
  const fb = await PF.runAll(P, { deps: world() });
  const fbr = fb.results.find((r) => r.service === 'admin-alert-email');
  ok('  ADMIN_EMAIL alone passes, and says ADMIN_ALERT_EMAIL is unset', fbr.ok && /ADMIN_ALERT_EMAIL is unset; using ADMIN_EMAIL/.test(fbr.detail), fbr);
  ok('the morning alert has no hard-coded destination left', !/@[a-z0-9-]+\.(com|io)'\s*\)?;?\s*$/m.test(read('server/services/morningAlert.js').split('\n').filter((l) => /TO\s*=/.test(l)).join('\n'))
    && /no alert destination/.test(read('server/services/morningAlert.js')));
  env(GOOD);

  // ── 3. MAILBOX TOKENS ────────────────────────────────────────────────────
  OUT.push('', '-- the mailbox tokens the run needs --');
  await P.query(`DELETE FROM email_accounts WHERE user_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Ops Agent', 'ops-agent@alert.test', 'x', 'agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('opsstatus-ath', $1, '{"name":"Ops Athlete"}')`, [AG]);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('opsstatus-mb', $1, 'gmail', 'ops@gmail.test', 'active')`, [AG]);
  const mbDeps = (over) => ({ ...world(), emailStore: { getEmailAccountWithTokens: async (id) => (id === 'opsstatus-mb' ? over.tokens : { refreshToken: 'fine' }) },
    gmail: { isAvailable: () => true, refreshAccessToken: over.refresh }, outlook: { isAvailable: () => true, refreshAccessToken: async () => ({}) } });
  const onlyMine = async (over) => {
    // Other suites may leave connected mailboxes behind; this one's words are what is asserted.
    const r = await PF.runAll(P, { deps: mbDeps(over) });
    return r.results.find((x) => x.service === 'mailbox-tokens' || x.service === 'token-encryption');
  };
  const good = await onlyMine({ tokens: { refreshToken: 'rt' }, refresh: async () => ({ access_token: 'a' }) });
  ok('a mailbox Google accepts passes', good.ok, good);
  const revoked = await onlyMine({ tokens: { refreshToken: 'rt' }, refresh: async () => { throw new Error('invalid_grant: Token has been expired or revoked.'); } });
  ok('  a revoked token fails, naming the agent and Google\'s words', !revoked.ok && /Ops Agent \(ops@gmail\.test\): gmail refused the token: invalid_grant/.test(revoked.error), revoked);
  ok('  and the alert says their approved emails will not send tonight', /Approved emails for the listed agents will not send tonight/.test(PF.CONSEQUENCE['mailbox-tokens']));
  const undec = await onlyMine({ tokens: null, refresh: async () => ({}) });
  ok('  a token that cannot be decrypted fails', !undec.ok && /could not be read|could be decrypted/.test(undec.error), undec);
  await P.query(`DELETE FROM email_accounts WHERE user_id = $1`, [AG]);

  // ── 4. ONCE A NIGHT, BEFORE THE RUN, AND THE ALERT GOES AT ONCE ──────────
  OUT.push('', '-- when it runs --');
  const at = (iso) => Date.parse(iso);
  // 2031-04-02 00:40 Central (CDT, UTC-5) = 05:40Z.
  const IN = at('2031-04-02T05:40:00Z'), NIGHT = '2031-04-02';
  ok('00:40 Central is inside the preflight window', PF.inPreflightWindow(IN));
  ok('  noon Central is not', !PF.inPreflightWindow(at('2031-04-02T17:00:00Z')));
  ok('  00:10 Central is not (too early)', !PF.inPreflightWindow(at('2031-04-02T05:10:00Z')));
  await P.query(`DELETE FROM preflight_runs WHERE night = $1`, [NIGHT]);
  const sent = [];
  const e1 = await PF.ensureTonight(P, { now: IN, deps: world({ places: 'API key expired. Please renew the API key.' }), send: async (m) => { sent.push(m); } });
  ok('a failure alerts immediately, not in the morning', e1.night === NIGHT && e1.alert === 'sent' && sent.length === 1 && /google-places/.test(sent[0].subject), [e1.night, e1.alert, sent.length]);
  const e2 = await PF.ensureTonight(P, { now: IN + 10 * 60000, deps: world(), send: async (m) => { sent.push(m); } });
  ok('  and it runs once a night', /already ran/.test(e2.skipped || '') && sent.length === 1, e2);
  const pr = (await P.query(`SELECT status, failed, alert FROM preflight_runs WHERE night = $1`, [NIGHT])).rows[0];
  ok('  the night is recorded: failed, how many, whether the alert went', pr && pr.status === 'failed' && pr.failed === 1 && pr.alert === 'sent', pr);
  await P.query(`DELETE FROM preflight_runs WHERE night = $1`, [NIGHT]);
  const e3 = await PF.ensureTonight(P, { now: IN, deps: world({ resend: 'API key is invalid' }), send: async () => { throw new Error('Resend refused the email: API key is invalid'); } });
  const pr3 = (await P.query(`SELECT alert FROM preflight_runs WHERE night = $1`, [NIGHT])).rows[0];
  ok('an alert that cannot be sent is written down, not dropped', /^FAILED: Resend refused/.test(e3.alert) && /^FAILED/.test(pr3.alert), pr3);
  await P.query(`DELETE FROM preflight_runs WHERE night = $1`, [NIGHT]);
  const e4 = await PF.ensureTonight(P, { now: IN, deps: world(), send: async (m) => { sent.push(m); } });
  ok('a clean night sends nothing and records ok', !e4.alert && sent.length === 1
    && (await P.query(`SELECT status FROM preflight_runs WHERE night = $1`, [NIGHT])).rows[0].status === 'ok');
  ok('outside the window it does nothing', /outside/.test((await PF.ensureTonight(P, { now: at('2031-04-02T17:00:00Z') })).skipped || ''));
  const IDX = read('server/index.js');
  ok('the queue tick runs the preflight before the night starts', /await require\('\.\/services\/preflight'\)\.ensureTonight\(store\.pool\)[\s\S]{0,200}queueJob\.run\(/.test(IDX));
  ok('  and its own tick runs it whether or not the queue is on', /PF\.ensureTonight\(store\.pool\)/.test(IDX) && /setInterval\(pfTick/.test(IDX));
  ok('the admin runner has preflight', /'preflight': \{ file: 'scripts\/preflight\.js'/.test(IDX) || /preflight: \{ file: 'scripts\/preflight\.js'/.test(IDX));

  // ── 5. THE MORNING ALERT: UNIVERSITIES, DIGESTS, SENDS, FAULTS ───────────
  OUT.push('', '-- the morning alert covers everything that can go quiet --');
  // 7am Central on a day of our own.
  const MNOW = at('2031-04-09T12:00:00Z'), MDAY = '2031-04-09';
  await P.query(`DELETE FROM preflight_runs WHERE night = $1`, [MDAY]);
  await P.query(`DELETE FROM university_drafts WHERE university_id = $1`, [UNI]).catch(() => {});
  await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE $1`, [UNI + ':%']).catch(() => {});
  await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [UNI]);
  await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [UNI]);
  await P.query(`DELETE FROM universities WHERE id = $1`, [UNI]);
  await P.query(`INSERT INTO universities (id, name) VALUES ($1, 'Opstest College')`, [UNI]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport) VALUES ($1, $2, 'Opstest Softball', 'Softball')`, [UNI + ':sb', UNI]);
  await P.query(`INSERT INTO university_inventory (id, university_id, name, price_cents) VALUES ($1, $2, 'Opstest banner', 50000)`, [UNI + ':inv1', UNI]);
  await P.query(`INSERT INTO university_research_claims (team_id, brand_key, night) VALUES ($1, 'opstest-cafe', CURRENT_DATE)`, [UNI + ':sb']);
  const rep = await MA.collect(P, { now: MNOW });
  ok('no preflight for last night is itself a problem', rep.preflightMissing === true && rep.problemCount > 0);
  const uni = (rep.universities || []).find((u) => u.id === UNI);
  ok('every athletics department is in the report', uni && uni.teams === 1 && uni.asks24h === 0, uni);
  const quiet = (rep.universityProblems || []).find((u) => u.university === 'Opstest College');
  ok('  a team scan that ran and wrote no sponsor ask is a problem', quiet && /wrote no sponsor ask/.test(quiet.text), rep.universityProblems);
  const txt = MA.render(rep);
  ok('  the alert names it', /ATHLETICS DEPARTMENTS THAT WENT QUIET:[\s\S]*Opstest College: a team scan ran/.test(txt.text) && /athletics department\(s\) went quiet/.test(txt.subject), txt.subject);
  ok('  and says no preflight ran', /NO PREFLIGHT RAN for 2031-04-09/.test(txt.text) && /no preflight ran for last night/.test(txt.subject));
  ok('  and links the status page', /Status: https?:\/\/[^\s]+\/admin\/status/.test(txt.text));
  // A failed preflight and faults of our own show up with their words.
  await P.query(`INSERT INTO preflight_runs (night, status, failed, alert, run_id) VALUES ($1, 'failed', 1, 'sent', $2)`, [MDAY, down.runId]);
  const rep2 = await MA.collect(P, { now: MNOW });
  const t2 = MA.render(rep2);
  ok('a failed preflight is in the morning alert, with the provider\'s words', !rep2.preflightMissing && /PREFLIGHT for 2031-04-09 FAILED/.test(t2.text) && /google-places: HTTP 403/.test(t2.text), t2.text.split('\n').filter((l) => /PREFLIGHT|google-places|preflight/i.test(l)));
  ok('our own failures are listed by service', (rep2.faults24h || []).some((f) => f.service === 'google-places') && /OUR FAILURES, last 24 hours/.test(t2.text));
  ok('the alert has a section for digests and approved emails not sent', /AGENT DIGESTS for/.test(read('server/services/morningAlert.js')) && /APPROVED EMAILS NOT SENT/.test(read('server/services/morningAlert.js')));
  const clear = MA.render({ runDate: MDAY, problemCount: 0, problems: [], cardsLastNight: 3, agentsWithAthletes: 1, queueEnabled: true,
    builds: { total: 1, failed: 0, pooled: 1, failures: [] }, newBusinesses24h: 2, digests: { sent: 1 },
    universities: [{ name: 'Opstest College', teams: 1, items: 4, asks24h: 2, last_ask: new Date(MNOW) }] });
  ok('the all-clear lists every department too, and the preflight', /Opstest College: 1 team\(s\), 4 item\(s\) for sale, 2 sponsor ask\(s\) in 24h/.test(clear.text)
    && /Preflight for 2031-04-09: every service answered/.test(clear.text), clear.text);

  // ── 6. /admin/status ─────────────────────────────────────────────────────
  OUT.push('', '-- one screen --');
  const st = await SP.collect(P);
  ok('status: no read failed', st.readErrors.length === 0, st.readErrors);
  const gp = st.services.find((s) => s.service === 'google-places');
  ok('each service has a state and when it was last checked', st.services.length >= 10 && st.services.every((s) => ['ok', 'failed', 'unchecked'].includes(s.state)) && gp && gp.checkedAt, st.services.map((s) => s.service + ':' + s.state));
  ok('  the seven nights are all there, a quiet one included', st.agents.length === 7 && st.universities.length === 7);
  ok('  a department with no ask in seven days is listed', st.quietTeams.some((t) => t.id === UNI + ':sb'));
  // A red service: its last check failed.
  await P.query(`INSERT INTO service_checks (run_id, service, ok, ms, error) VALUES ('opsstatus', 'hunter', false, 120, 'HTTP 401: No user found for the API key supplied')`);
  const st2 = await SP.collect(P);
  const html = SP.renderHtml(st2);
  const hu = st2.services.find((s) => s.service === 'hunter');
  ok('a failed check is red, with the provider\'s error and what breaks', hu.state === 'failed' && /No user found/.test(hu.error)
    && /<tr class="failed">[\s\S]*?hunter[\s\S]*?No user found for the API key supplied[\s\S]*?Tier 2 addresses/.test(html), hu);
  ok('  the page says services are failing at the top', /class="banner bad">\d+ service\(s\) failing/.test(html));
  const never = SP.renderHtml({ ...st2, services: [{ service: 'resend', state: 'unchecked', checkedAt: null }], readErrors: [] });
  ok('a service never checked is grey and says so, not green', /dot unchecked/.test(never) && /never checked/.test(never) && /have never been checked/.test(never));
  const broken = SP.renderHtml({ ...st2, readErrors: ['service_checks: relation does not exist'] });
  ok('a read that failed is shown, not rendered as an empty week', /could not read everything/.test(broken) && /relation does not exist/.test(broken));
  ok('the page escapes provider text', !/<script>/.test(SP.renderHtml({ ...st2, services: [{ service: 'x', state: 'failed', error: '<script>alert(1)</script>' }] })));
  ok('the routes are admin only', /app\.get\('\/admin\/status'[\s\S]{0,120}_statusAdminOk\(req\)\)\) return res\.status\(403\)/.test(IDX)
    && /app\.get\('\/api\/admin\/status'[\s\S]{0,120}_statusAdminOk\(req\)\)\) return res\.status\(403\)/.test(IDX));
  ok('  and gated on the admin email', /function _statusAdminOk[\s\S]{0,300}user\.email === ADMIN_EMAIL \|\| isFounderEmail\(user\.email\)/.test(IDX));
  ok('the status page is not a university endpoint (the wall is untouched)', !/admin\/status/.test(read('server/middleware/modeGuard.js')));

  // Cleanup.
  await P.query(`DELETE FROM service_checks WHERE run_id = 'opsstatus'`);
  await P.query(`DELETE FROM preflight_runs WHERE night IN ($1, $2)`, [NIGHT, MDAY]);
  await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE $1`, [UNI + ':%']);
  await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [UNI]);
  await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [UNI]);
  await P.query(`DELETE FROM universities WHERE id = $1`, [UNI]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  env(Object.fromEntries(Object.entries(SAVED).filter(([, v]) => v !== undefined)));
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
