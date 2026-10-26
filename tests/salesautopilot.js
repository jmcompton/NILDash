'use strict';
// Runs against the local test Postgres. No network: the web search, Hunter
// and Microsoft Graph are stand-ins that record what they were asked.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/salesautopilot.js     just this one
//
// ── THE SALES AUTOPILOT ───────────────────────────────────────────────────
// Definition of done, as a test:
//   a dry run drafts 20 (10 agencies, 10 schools), each a named person with
//   an address Hunter verified tonight, and sends nothing;
//   the day-1 plan is 10 sends, 9 to 4 their time, 4+ minutes apart;
//   nobody already in NILDash, suppressed, at a giant agency or at Second
//   Wind Pro; no catch-all, no role address, no unverified address;
//   the emails are plain, short, one link, the team version for schools;
//   it sends from the Outlook mailbox only when SALES_AUTOSEND_ON, warms up,
//   follows up in the thread on day 3 and day 7, and stops a sequence on a
//   reply, a booking, a bounce, an unsubscribe or a trial;
//   it stops itself on bounces over 2%, a spam complaint or a Microsoft
//   limit, emails JohnMark why, and stays stopped until resumed;
//   replies are tagged, filed in "NILDash Prospects", and an interested one
//   is emailed to JohnMark with the thread and a suggested answer.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.BUSINESS_MAILING_ADDRESS = '1 Main St, Auburn, AL 36830';
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'sa-test-secret';
process.env.ADMIN_EMAIL = 'sa-admin@sa-admin.test';
process.env.SALES_FROM_ADDRESS = 'john@comptongroupllc.com';
process.env.APP_URL = 'https://mynildash.com';
process.env.SALES_BOOKING_URL = 'https://calendly.com/johnmark/15min';
delete process.env.SALES_DAILY_NEW; delete process.env.SALES_DAILY_CAP; delete process.env.SALES_MAX_QUEUE; delete process.env.SALES_HUNTER_MAX;
process.env.SALES_AUTOPILOT_ON = 'true';
process.env.SALES_AUTOSEND_ON = 'false';
process.env.SALES_TRIAL_ON = 'true';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const SA = require(REPO + 'server/services/salesAutopilot.js');
const SF = require(REPO + 'server/services/salesFind.js');
const W = require(REPO + 'server/services/salesWriter.js');
const R = require(REPO + 'server/services/salesReplies.js');
const MB = require(REPO + 'server/services/salesMailbox.js');
const SCRIPT = require(REPO + 'scripts/sales-autopilot.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;
const lc = (s) => String(s || '').toLowerCase();
const src = (f) => fs.readFileSync(REPO + f, 'utf8');

// ── THE STAND-INS ─────────────────────────────────────────────────────────
// Web search: firms per agency slice, a person per school.
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '').slice(0, 18);
function research(lane, x) {
  if (lane === 'agency') {
    const l = lc(x.league), st = lc(x.state);
    const firms = [
      { firm: `${x.league} Pros ${x.state}`, domain: `https://www.${l}pros-${st}.test/about`, city: 'Austin', state: x.state,
        person: { name: `Alex ${x.state}son`, title: 'Founder' }, fact: `${x.league} Pros ${x.state} represents 12 ${x.league === 'NIL' ? 'college' : x.league} athletes.`, source: 'https://example.test/a' },
    ];
    if (x.index === 0) {
      firms.unshift(
        { firm: 'Klutch Sports Group', domain: 'klutchsports.com', state: 'CA', person: { name: 'Rich Paul', title: 'CEO' } },
        { firm: 'Second Wind Pro', domain: 'secondwindpro.test', state: 'TX', person: { name: 'Sam Wind', title: 'Agent' } },
        { firm: 'Existing Agency', domain: 'existingagency.test', state: 'TX', person: { name: 'Pat Exists', title: 'Agent' } },
        { firm: 'Catch All Sports', domain: 'catchall-sports.test', state: 'TX', person: { name: 'Cat Chall', title: 'Agent' } },
        { firm: 'Role Firm', domain: 'rolefirm.test', state: 'TX', person: null },
        { firm: 'Suppressed Firm', domain: 'suppressedfirm.test', state: 'TX', person: { name: 'Sue Pressed', title: 'President' } },
        { firm: 'Unverified Sports', domain: 'unverified-sports.test', state: 'TX', person: { name: 'Una Verified', title: 'Agent' } },
      );
    }
    return { firms };
  }
  const k = SF.schoolList().findIndex((s) => s.name === x.name);
  if (k % 4 === 3) return { person: null };                             // nobody found
  const dom = (k % 4 === 2 ? 'catchall-' : '') + slug(x.name) + '.edu';  // some schools are catch-all
  return { person: { name: `Jordan ${slug(x.name).replace(/^./, (c) => c.toUpperCase()).slice(0, 10)}`, title: 'Director of NIL' }, emailDomain: dom, state: x.state || 'TX',
    fact: `${x.name} sponsors 16 sports.`, source: 'https://example.test/s' };
}
const hunterCalls = { find: 0, search: 0, verify: 0 };
const hunter = {
  findEmail: async (first, last, domain) => {
    hunterCalls.find++;
    if (/catchall/.test(domain)) return { email: `${lc(first)}@${domain}`, acceptAll: true };
    if (/rolefirm/.test(domain)) return { email: null };
    return { email: `${lc(first)}.${lc(last)}@${domain}`, acceptAll: false };
  },
  domainSearch: async (domain) => { hunterCalls.search++; return /rolefirm/.test(domain) ? { emails: [{ email: 'info@' + domain, type: 'generic', firstName: null, lastName: null, position: null }] } : { emails: [] }; },
  verify: async (email) => { hunterCalls.verify++; return /unverified/.test(email) ? { result: 'unknown', status: 'unknown' } : { result: 'valid', status: 'valid' }; },
};
// Microsoft Graph: records every call.
function fakeGraph() {
  const g = { calls: [], sent: [], replies: [], moves: [], inbox: [], calendar: [], folder: null, folderMade: 0, fail: null, n: 0 };
  g.fn = async (method, path, body) => {
    g.calls.push({ method, path, body });
    if (g.fail && /sendMail|\/reply$/.test(path)) { const e = new Error(g.fail.message); e.status = g.fail.status; e.code = g.fail.code; throw e; }
    if (method === 'POST' && path === '/me/sendMail') {
      const m = body.message; g.n++;
      g.sent.push({ id: 'msg-' + g.n, conversationId: 'conv-' + g.n, subject: m.subject, toRecipients: m.toRecipients, body: m.body, sentDateTime: new Date().toISOString() });
      return {};
    }
    if (method === 'GET' && path.startsWith('/me/mailFolders/sentitems/messages')) return { value: g.sent.slice().reverse() };
    if (method === 'POST' && /^\/me\/messages\/[^/]+\/reply$/.test(path)) { g.replies.push({ to: decodeURIComponent(path.split('/')[3]), body }); return {}; }
    if (method === 'GET' && path.startsWith('/me/mailFolders/inbox/messages')) return { value: g.inbox };
    if (method === 'GET' && path.startsWith('/me/mailFolders?')) return { value: g.folder ? [{ id: g.folder, displayName: 'NILDash Prospects' }] : [] };
    if (method === 'POST' && path === '/me/mailFolders') { g.folderMade++; g.folder = 'fld-1'; return { id: 'fld-1', displayName: body.displayName }; }
    if (method === 'POST' && /\/move$/.test(path)) { g.moves.push({ id: decodeURIComponent(path.split('/')[3]), to: body.destinationId }); return {}; }
    if (method === 'GET' && path.startsWith('/me/calendarView')) return { value: g.calendar };
    if (method === 'GET' && path.startsWith('/me/messages?')) return { value: [] };
    throw new Error('unexpected Graph call ' + method + ' ' + path);
  };
  return g;
}
const MAILBOX = { ok: true, address: 'john@comptongroupllc.com', accountId: 'x', canSend: true, canRead: true, canMove: true, canCalendar: true };

// The next Monday, two or more days out: a whole test week near today.
function nextMonday() {
  const c = SA.centralDay();
  let d = SA.addDays(c.date, 2);
  while (SA.partsIn(d + 'T18:00:00Z', 'UTC').weekday !== 'Mon') d = SA.addDays(d, 1);
  return d;
}
const MON = nextMonday();
const DAY = (n) => SA.addDays(MON, n);
const CT = (date, hh, mm = 0) => SA.zonedTime(date, hh * 60 + mm, 'America/Chicago');

async function reset() {
  await SA.ensureTables(P());
  for (const t of ['sales_prospects', 'sales_emails', 'sales_runs', 'sales_events', 'sales_tried', 'sales_trials']) await P().query(`DELETE FROM ${t}`);
  await P().query(`UPDATE sales_state SET paused = FALSE, paused_reason = NULL, paused_at = NULL, inbox_checked_at = NULL, folder_id = NULL, cursors = '{}' WHERE id = 1`);
  await P().query(`DELETE FROM email_sends WHERE system = 'sales-autopilot'`).catch(() => {});
  await P().query(`DELETE FROM email_suppression WHERE email LIKE '%.test' OR email LIKE '%.edu'`).catch(() => {});
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await reset();
  // People already in NILDash, and a suppressed address.
  await P().query(`DELETE FROM users WHERE email IN ('pat@existingagency.test', 'sa-admin@sa-admin.test', 'trial.taker@nflpros-ga.test')`);
  await P().query(`INSERT INTO users (id, name, email, password, role) VALUES ('sa-existing', 'Pat Exists', 'pat@existingagency.test', 'x', 'agent')`);
  await P().query(`INSERT INTO users (id, name, email, password, role, scheduling_url) VALUES ('sa-admin', 'JohnMark Compton', 'sa-admin@sa-admin.test', 'x', 'admin', 'https://calendly.com/johnmark/15min')`);
  await require(REPO + 'server/services/suppression.js').suppress(P(), 'sue.pressed@suppressedfirm.test', { reason: 'test', kind: 'manual' });

  // ── 1. THE SWITCHES ───────────────────────────────────────────────────
  OUT.push('-- the switches --');
  process.env.SALES_AUTOPILOT_ON = '';
  ok('off by default: the tick does nothing', (await SA.tick(P(), { deps: { research, hunter, write: false } })).skipped === 'SALES_AUTOPILOT_ON is off');
  ok('  and nothing was drafted', (await P().query(`SELECT COUNT(*)::int n FROM sales_prospects`)).rows[0].n === 0);
  process.env.SALES_AUTOPILOT_ON = 'true';
  ok('SALES_AUTOSEND_ON off: the send tick sends nothing', (await SA.sendTick(P())).skipped === 'SALES_AUTOSEND_ON is off');
  ok('  sending needs both switches', (process.env.SALES_AUTOSEND_ON = 'true', process.env.SALES_AUTOPILOT_ON = '', !SA.SEND_ON()) && (process.env.SALES_AUTOPILOT_ON = 'true', process.env.SALES_AUTOSEND_ON = 'false', true));

  // ── 2. THE DRY RUN: 20 DRAFTED, VERIFIED, NOTHING SENT ────────────────
  OUT.push('', '-- the dry run --');
  const g0 = fakeGraph();
  const dry = await SCRIPT.dryRunText(P(), { deps: { research, hunter, write: false, graph: g0.fn, mailbox: MAILBOX }, now: CT(DAY(-3), 4) });
  const run = dry.run;
  ok('20 drafted: 10 agencies and 10 schools', run.ok && run.drafted === 20 && run.lanes.agency.drafted.length === 10 && run.lanes.school.drafted.length === 10, run.note || run.error);
  const ps = (await P().query(`SELECT * FROM sales_prospects ORDER BY created_at`)).rows;
  ok('  each a named person, first and last', ps.length === 20 && ps.every((p) => SF.splitName(p.person)), ps.map((p) => p.person));
  ok('  each address verified by Hunter tonight (status valid, verified now)', ps.every((p) => p.verify_status === 'valid' && p.verify_result === 'valid' && Date.now() - new Date(p.verified_at).getTime() < 3600000));
  ok('  with the time zone of their state', ps.every((p) => p.tz === SF.tzFor(p.state)));
  ok('  nothing was sent: every email is a draft, Graph was never called', g0.calls.length === 0
    && (await P().query(`SELECT COUNT(*)::int n FROM sales_emails WHERE state <> 'draft'`)).rows[0].n === 0);
  const emails = ps.map((p) => p.email);
  ok('never a giant agency (Klutch)', !emails.some((e) => /klutch/.test(e)) && run.lanes.agency.skipped['a giant agency'] === 1, run.lanes.agency.skipped);
  ok('never Second Wind Pro', !emails.some((e) => /secondwind/.test(e)) && run.lanes.agency.skipped['Second Wind Pro'] === 1);
  ok('never anyone already in NILDash, or their firm', !emails.some((e) => /existingagency/.test(e)) && run.lanes.agency.skipped['already in NILDash'] === 1, run.lanes.agency.skipped);
  ok('never a catch-all domain', !emails.some((e) => /catchall/.test(e)) && run.lanes.agency.skipped['catch-all domain'] === 1 && run.lanes.school.skipped['catch-all domain'] >= 1, run.lanes.school.skipped);
  ok('never a role address', !emails.some((e) => SF.isRole(e)) && Object.keys(run.lanes.agency.skipped).some((k) => /no named person/.test(k)));
  ok('never a suppressed address', !emails.includes('sue.pressed@suppressedfirm.test') && run.lanes.agency.skipped['on the suppression list'] === 1);
  ok('never an address Hunter could not verify', !emails.some((e) => /unverified/.test(e)) && run.lanes.agency.skipped['not verified'] === 1);
  ok('one prospect per domain', new Set(ps.map((p) => p.domain)).size === ps.length);
  // Hunter out of credits, or not reachable: the firm is not written off.
  const ctxB = { hunter: { findEmail: async () => ({ email: null, budget: true }), domainSearch: async () => ({}), verify: async () => ({}) }, ex: await SF.exclusions(P()), credits: { used: 0, max: 99 } };
  const rB = await SF.findPerson({ lane: 'agency', org: 'Later Sports', domain: 'latersports.test', person: { name: 'Lee Later' } }, ctxB);
  ctxB.hunter.findEmail = async () => ({ email: null, fault: { reason: 'HUNTER_API_KEY is not set' } });
  const rF = await SF.findPerson({ lane: 'agency', org: 'Later Sports', domain: 'latersports.test', person: { name: 'Lee Later' } }, ctxB);
  ok('Hunter out of credits stops the lane; Hunter unreachable is retried another night', rB.budget === true && rF.notRun === true && /HUNTER_API_KEY/.test(rF.skip), [rB, rF]);
  ctxB.credits.used = 99;
  ok('  and the sales cap on Hunter credits holds', (await SF.findPerson({ lane: 'agency', org: 'X', domain: 'x-sports.test', person: { name: 'Al Ex' } }, ctxB)).budget === true);
  const drafts = (await P().query(`SELECT e.*, p.lane, p.org, p.fact, p.person FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id`)).rows;
  const ctx = SA.writerCtx();
  ok('every email passes the rules: plain, short, one link, no hype, no em dash, signed', drafts.length === 20
    && drafts.every((d) => W.checkEmail({ subject: d.subject, body: d.body_text }, d, ctx, 1).length === 0),
    drafts.map((d) => W.checkEmail({ subject: d.subject, body: d.body_text }, d, ctx, 1)).filter((x) => x.length));
  ok('  under 120 words each', drafts.every((d) => W.words(d.body_text) < 120), drafts.map((d) => W.words(d.body_text)));
  ok('  the one link is mynildash.com/try, and it offers the 14-day trial', drafts.every((d) => W.links(d.body_text).join() === 'https://mynildash.com/try' && /14-day trial/.test(d.body_text)));
  ok('  leads with the time bought back: 5 pitches, already written, verified people', drafts.every((d) => /mornings back/.test(d.body_text) && /5 (sponsorship )?pitches/.test(d.body_text) && /already written/.test(d.body_text) && /verified people/.test(d.body_text)));
  ok('  a specific line about them', drafts.every((d) => d.body_text.includes(d.org) || d.body_text.includes(String(d.fact || '').slice(0, 30))));
  const school = drafts.find((d) => d.lane === 'school');
  ok('schools get the team version: teams and programs, sponsorship, no individual athletes',
    /teams and programs/.test(school.body_text) && /sponsorship pitches/.test(school.body_text) && !/athlete you represent/.test(school.body_text), school.body_text);
  ok('never claims NILDash closes or negotiates deals', drafts.every((d) => !/\b(close|negotiat)/i.test(d.body_text)));
  ok('the dry-run report lists all 20 with their verified address', /DRAFTED \(20\)/.test(dry.text) && (dry.text.match(/Hunter: valid, verified /g) || []).length === 20, dry.text.slice(0, 400));

  // ── 3. DAY 1: WHAT WILL SEND ──────────────────────────────────────────
  OUT.push('', '-- day 1 --');
  const plan = dry.plan;
  ok('day 1 is warm-up day 1: 10 sends', plan.ok && plan.warmup.day === 1 && plan.warmup.cap === 10 && plan.planned.length === 10, plan.warmup);
  ok('  first emails only, the two lanes in turn', plan.planned.every((x) => x.step === 1)
    && plan.planned.filter((x) => x.lane === 'agency').length === 5 && plan.planned.filter((x) => x.lane === 'school').length === 5);
  const inWindow = (x) => { const p = SA.partsIn(x.at, x.tz); return p.minutes >= 9 * 60 && p.minutes < 16 * 60 && !['Sat', 'Sun'].includes(p.weekday); };
  ok('  each between 9am and 4pm in the prospect\'s time zone, on a weekday', plan.planned.every(inWindow), plan.planned.map((x) => `${x.local} ${x.tz}`));
  const ts = plan.planned.map((x) => new Date(x.at).getTime()).sort((a, b) => a - b);
  ok('  at least 4 minutes apart', ts.every((t, i) => !i || t - ts[i - 1] >= 4 * 60000));
  ok('  the report shows the day-1 plan with times', /DAY 1: WHAT WILL SEND ON /.test(dry.text) && /Warm-up day 1: up to 10 sends\. 10 planned/.test(dry.text) && (dry.text.match(/ Central \(/g) || []).length === 10);
  ok('  and the preview wrote nothing', (await P().query(`SELECT COUNT(*)::int n FROM sales_emails WHERE state = 'scheduled'`)).rows[0].n === 0);

  // ── 4. SENDING: MONDAY ────────────────────────────────────────────────
  OUT.push('', '-- sending --');
  process.env.SALES_AUTOSEND_ON = 'true';
  const g = fakeGraph();
  const alerts = [];
  const deps = { graph: g.fn, mailbox: MAILBOX, alert: async (m) => { alerts.push(m); }, classify: false, random: (() => { let s = 7; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })() };
  const p1 = await SA.planDay(P(), { now: CT(MON, 7), deps });
  ok('Monday 7am: 10 scheduled (warm-up day 1)', p1.ok && p1.planned.length === 10, p1);
  ok('  planning twice the same day does nothing more', (await SA.planDay(P(), { now: CT(MON, 8), deps })).already === true);
  let sends = 0, gapSkips = 0;
  for (let t = CT(MON, 8).getTime(); t <= CT(MON, 23).getTime(); t += 60000) {
    const r = await SA.sendTick(P(), { now: new Date(t), deps });
    if (r.ok) sends++;
    if (r.skipped === 'less than 4 minutes since the last send') gapSkips++;
  }
  ok('all 10 went out on Monday, one at a time', sends === 10 && g.sent.length === 10, { sends, sent: g.sent.length });
  const sent = (await P().query(`SELECT e.*, p.tz, p.email FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id WHERE e.state = 'sent' ORDER BY e.sent_at`)).rows;
  ok('  each in its window and 4+ minutes after the last', sent.every((e, i) => { const p = SA.partsIn(e.sent_at, e.tz); return p.minutes >= 540 && p.minutes < 960 && (!i || new Date(e.sent_at) - new Date(sent[i - 1].sent_at) >= 4 * 60000); }));
  const m0 = g.sent[0];
  ok('  plain text through the Outlook mailbox (Graph sendMail), saved to Sent Items', g.calls.some((c) => c.path === '/me/sendMail' && c.body.saveToSentItems === true) && m0.body.contentType === 'Text');
  ok('  with the CAN-SPAM footer: unsubscribe link and mailing address', /Unsubscribe: https:\/\/mynildash\.com\/unsubscribe\?u=/.test(m0.body.content) && /1 Main St, Auburn, AL 36830/.test(m0.body.content));
  ok('  one link besides the unsubscribe, no image, no pixel, no HTML', W.links(m0.body.content).filter((u) => !/unsubscribe/.test(u)).join() === 'https://mynildash.com/try' && !/<img|<a |<html|<p>/i.test(m0.body.content));
  ok('  to the prospect only', g.sent.every((s) => s.toRecipients.length === 1));
  ok('  the first email is found in Sent Items, for the thread', (await P().query(`SELECT COUNT(*)::int n FROM sales_prospects WHERE root_message_id LIKE 'msg-%' AND status = 'active'`)).rows[0].n === 10);
  ok('  each send is in the shared send log', (await P().query(`SELECT COUNT(*)::int n FROM email_sends WHERE system = 'sales-autopilot'`)).rows[0].n === 10);
  ok('no third-party sending service: the prospect path uses Graph only', !/resend/i.test(src('server/services/salesMailbox.js').replace(/^\s*\/\/.*$/gm, ''))
    && /MB\.sendNew\(/.test(src('server/services/salesAutopilot.js')) && /MB\.reply\(/.test(src('server/services/salesAutopilot.js')));
  // A draft written before SALES_TRIAL_ON went on is not cancelled: it goes
  // as today's template, which offers the trial.
  const pT = (await P().query(`SELECT p.*, e.id AS eid FROM sales_prospects p JOIN sales_emails e ON e.prospect_id = p.id AND e.step = 1 WHERE p.status = 'drafted' LIMIT 1`)).rows[0];
  await P().query(`UPDATE sales_emails SET body_text = $2 WHERE id = $1`, [pT.eid, W.templateEmail(pT, { ...ctx, trialOn: false }).body]);
  ok('  (the draft was written without the trial)', !/14-day trial/.test((await P().query(`SELECT body_text FROM sales_emails WHERE id = $1`, [pT.eid])).rows[0].body_text));
  const gT = fakeGraph();
  await P().query(`UPDATE sales_emails SET state = 'sending' WHERE id = $1`, [pT.eid]);
  const sT = await SA.sendOne(P(), (await P().query(`SELECT * FROM sales_emails WHERE id = $1`, [pT.eid])).rows[0], { now: CT(DAY(1), 11), deps: { ...deps, graph: gT.fn } });
  ok('a draft written before the trial went on is sent with the trial, not cancelled', sT.ok && /14-day trial/.test(gT.sent[0].body.content), sT);
  await P().query(`UPDATE sales_emails SET state = 'draft', sent_at = NULL WHERE id = $1`, [pT.eid]);
  await P().query(`UPDATE sales_prospects SET status = 'drafted', first_sent_at = NULL, last_sent_at = NULL, root_message_id = NULL, conversation_id = NULL WHERE id = $1`, [pT.id]);
  await P().query(`DELETE FROM email_sends WHERE ref_id = $1`, ['sales:' + pT.id]);
  ok('nothing on Saturday', (await SA.sendTick(P(), { now: CT(DAY(5), 11), deps })).skipped === 'a weekend' && (await SA.planDay(P(), { now: CT(DAY(5), 7), deps, save: false })).ok === false);

  // ── 5. WARM-UP AND THE DOMAIN CAP ─────────────────────────────────────
  OUT.push('', '-- warm-up --');
  const tue = await SA.planDay(P(), { now: CT(DAY(1), 7), deps, save: false });
  ok('Tuesday is day 2: up to 13', tue.warmup.day === 2 && tue.warmup.cap === 13 && tue.planned.length === 10, tue.warmup);
  process.env.SALES_DAILY_CAP = '12';
  ok('  never over SALES_DAILY_CAP', (await SA.warmup(P(), DAY(1))).cap === 12);
  delete process.env.SALES_DAILY_CAP;
  // Three drafts at one domain: two go, one waits.
  for (const n of ['one', 'two', 'three']) {
    const id = 'sp_dom_' + n;
    await P().query(`INSERT INTO sales_prospects (id, lane, org, domain, person, email, verify_status, verify_result, verified_at, state, tz, status)
      VALUES ($1, 'agency', 'Same Domain Sports', 'samedomain.test', $2, $3, 'valid', 'valid', NOW(), 'TX', 'America/Chicago', 'drafted')`, [id, `Kim ${n[0].toUpperCase() + n.slice(1)}`, `kim.${n}@samedomain.test`]);
    await P().query(`INSERT INTO sales_emails (id, prospect_id, step, subject, body_text, state, created_at) VALUES ($1, $2, 1, 'Pitches for your athletes, ready each morning', $3, 'draft', NOW() - INTERVAL '30 days')`,
      ['se_dom_' + n, id, W.templateEmail({ lane: 'agency', person: 'Kim One', org: 'Same Domain Sports', state: 'TX', league: 'NFL' }, ctx).body]);
  }
  const tue2 = await SA.planDay(P(), { now: CT(DAY(1), 7), deps, save: false });
  ok('never more than 2 a day to one domain', tue2.planned.filter((x) => x.domain === 'samedomain.test').length === 2
    && tue2.notToday.some((x) => x.domain === 'samedomain.test' && /2 emails to samedomain\.test already today/.test(x.why)), tue2.notToday);
  // An address verified more than 30 days ago is never sent.
  await P().query(`UPDATE sales_prospects SET verified_at = NOW() - INTERVAL '40 days' WHERE id = 'sp_dom_three'`);
  const tue3 = await SA.planDay(P(), { now: CT(DAY(1), 7), deps, save: false });
  ok('a verification older than 30 days is not planned', !tue3.planned.concat(tue3.notToday).some((x) => x.email === 'kim.three@samedomain.test'));
  await P().query(`DELETE FROM sales_emails WHERE prospect_id LIKE 'sp_dom_%'`); await P().query(`DELETE FROM sales_prospects WHERE id LIKE 'sp_dom_%'`);

  // ── 6. FOLLOW-UPS ON DAY 3 AND DAY 7, IN THE THREAD ───────────────────
  OUT.push('', '-- follow-ups --');
  const wed = await SA.planDay(P(), { now: CT(DAY(2), 7), deps, save: false });
  ok('Wednesday (day 2 after): no follow-up yet', wed.planned.every((x) => x.step === 1));
  const thu = await SA.planDay(P(), { now: CT(DAY(3), 7), deps, save: false });
  const fuThu = thu.planned.filter((x) => x.step === 2);
  ok('Thursday (day 3): the 10 first follow-ups are due, and they count toward the cap', fuThu.length === 10 && thu.planned.length === thu.warmup.cap, { fu: fuThu.length, all: thu.planned.length, cap: thu.warmup.cap });
  // Send Thursday's for real: replies in the thread.
  await SA.planDay(P(), { now: CT(DAY(3), 7), deps });
  for (let t = CT(DAY(3), 8).getTime(); t <= CT(DAY(3), 23).getTime(); t += 60000) await SA.sendTick(P(), { now: new Date(t), deps });
  ok('each follow-up is a reply in the first email\'s thread (Graph reply), plain text', g.replies.length === 10
    && g.replies.every((r) => /^msg-\d+$/.test(r.to) && r.body.message.body.contentType === 'Text' && /Bumping this/.test(r.body.message.body.content)), g.replies.slice(0, 1));
  ok('  with the footer too', g.replies.every((r) => /Unsubscribe: https:\/\/mynildash\.com\/unsubscribe/.test(r.body.message.body.content)));
  const nextMon = await SA.planDay(P(), { now: CT(DAY(7), 7), deps, save: false });
  ok('the next Monday (day 7): the second follow-ups are due', nextMon.planned.filter((x) => x.step === 3).length === 10, nextMon.planned.map((x) => x.step));
  const fu3 = W.followUp({ lane: 'agency', person: 'Ann Lee' }, 3, ctx);
  ok('  the last note is short and offers the trial', /Last note from me/.test(fu3.body) && /14-day trial/.test(fu3.body) && W.checkEmail(fu3, {}, ctx, 3).length === 0);
  ok('after day 7 nothing more is planned for them', (() => { const s = src('server/services/salesAutopilot.js'); return /const FOLLOW_UP_AFTER = \{ 2: 3, 3: 7 \}/.test(s) && /if \(!FOLLOW_UP_AFTER\[step\]\) continue;/.test(s); })());

  // ── 7. REPLIES ────────────────────────────────────────────────────────
  OUT.push('', '-- replies --');
  const active = (await P().query(`SELECT * FROM sales_prospects WHERE status = 'active' ORDER BY first_sent_at`)).rows;
  const msg = (i, p, subject, text, extra) => Object.assign({ id: 'in-' + i, conversationId: p.conversation_id, subject, from: { emailAddress: { address: p.email } },
    receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: text }, internetMessageHeaders: [] }, extra || {});
  g.inbox = [
    msg(1, active[0], 'RE: Pitches', 'Sounds good. Can we talk Thursday afternoon?\n\nOn Mon, JohnMark wrote:\n> Hi'),
    msg(2, active[1], 'RE: Pitches', 'Not right now, maybe after the season.'),
    msg(3, active[2], 'RE: Pitches', 'I am no longer with the agency. Reach out to my partner Tom.'),
    msg(4, active[3], 'RE: Pitches', 'Please remove me from your list.'),
    msg(5, active[4], 'Automatic reply: Pitches', 'I am out of the office until Monday.'),
    { id: 'in-6', subject: 'Undeliverable: Pitches for your athletes', from: { emailAddress: { address: 'postmaster@outlook.com' } }, receivedDateTime: new Date().toISOString(),
      body: { contentType: 'text', content: `Your message to ${active[5].email} couldn't be delivered. 550 5.1.1 User unknown` }, internetMessageHeaders: [] },
    { id: 'in-7', subject: 'A note from a friend', from: { emailAddress: { address: 'friend@elsewhere.test' } }, receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'Lunch?' } },
  ];
  const sentBefore = g.sent.length + g.replies.length;
  const sc = await R.scan(P(), { deps });
  const st = async (p) => (await P().query(`SELECT status, tag FROM sales_prospects WHERE id = $1`, [p.id])).rows[0];
  ok('a reply stops the sequence and is tagged interested', (await st(active[0])).status === 'replied' && (await st(active[0])).tag === 'interested');
  ok('  its follow-ups are cancelled', (await P().query(`SELECT COUNT(*)::int n FROM sales_emails WHERE prospect_id = $1 AND state IN ('draft','scheduled')`, [active[0].id])).rows[0].n === 0);
  ok('"not now", "wrong person" and "unsubscribe" are tagged', (await st(active[1])).tag === 'not now' && (await st(active[2])).tag === 'wrong person' && (await st(active[3])).tag === 'unsubscribe');
  ok('  an unsubscribe reply goes on the suppression list', (await require(REPO + 'server/services/suppression.js').isSuppressed(P(), active[3].email)).suppressed);
  ok('an out-of-office changes nothing', (await st(active[4])).status === 'active');
  ok('a bounce stops the sequence and suppresses the address', (await st(active[5])).status === 'bounced' && (await require(REPO + 'server/services/suppression.js').isSuppressed(P(), active[5].email)).kind === 'bounce');
  ok('mail from anyone else is left alone', !g.moves.some((m) => m.id === 'in-7'));
  ok('prospect replies, the auto-reply and the bounce are filed in "NILDash Prospects"', g.folderMade === 1 && ['in-1', 'in-2', 'in-3', 'in-4', 'in-5', 'in-6'].every((id) => g.moves.some((m) => m.id === id && m.to === 'fld-1')), g.moves);
  ok('nobody was answered automatically', g.sent.length + g.replies.length === sentBefore);
  const told = alerts.find((a) => /^Interested: /.test(a.subject));
  ok('interested: JohnMark is emailed at once with the reply, the thread and a suggested answer', !!told && /Can we talk Thursday/.test(told.text)
    && /--- Your email, /.test(told.text) && /--- A suggested answer/.test(told.text) && /calendly\.com\/johnmark\/15min/.test(told.text) && /Nothing was sent to them/.test(told.text), told && told.text.slice(0, 300));
  ok('  only the interested one', alerts.filter((a) => /^Interested: /.test(a.subject)).length === 1);
  ok('the same message is never handled twice', (await R.scan(P(), { deps })).replies === 0);

  // ── 8. THE HARD STOPS ─────────────────────────────────────────────────
  OUT.push('', '-- the hard stops --');
  const stop1 = alerts.find((a) => /^Sales autopilot stopped: bounces are 1 of \d+ sends in the last 7 days/.test(a.subject));
  ok('bounces over 2% of the last 7 days\' sends: stopped, and JohnMark is told why', !!stop1 && (await SA.getState(P())).paused === true && /resume=1/.test(stop1.text), alerts.map((a) => a.subject));
  ok('  stopped means nothing is sent', /^stopped: bounces are/.test((await SA.sendTick(P(), { now: CT(DAY(7), 11), deps })).skipped || ''));
  ok('  it stays stopped until resumed', (await SA.getState(P())).paused === true && (await SA.resume(P())).resumed && (await SA.getState(P())).paused === false);
  // A spam complaint.
  g.inbox = [msg(8, active[6], 'RE: Pitches', 'How did you get my email? This is spam.')];
  await R.scan(P(), { deps });
  ok('a spam complaint stops it at once', (await SA.getState(P())).paused === true && /a spam complaint from /.test((await SA.getState(P())).paused_reason)
    && (await st(active[6])).status === 'unsubscribed', (await SA.getState(P())).paused_reason);
  await SA.resume(P());
  // Microsoft limits the mailbox: a warning in the inbox, or a refused send.
  g.inbox = [{ id: 'in-9', subject: 'Your account has been restricted from sending email', from: { emailAddress: { address: 'no-reply@accountprotection.microsoft.com' } },
    receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'We detected unusual sending activity.' } }];
  await R.scan(P(), { deps });
  ok('a Microsoft warning stops it', (await SA.getState(P())).paused === true && /Microsoft warned the mailbox/.test((await SA.getState(P())).paused_reason));
  await SA.resume(P());
  await SA.planDay(P(), { now: CT(DAY(7), 7), deps });
  g.fail = { status: 429, code: 'ErrorExceededMessageLimit', message: 'Message submission rate exceeded' };
  let lim = null;
  for (let t = CT(DAY(7), 8).getTime(); t <= CT(DAY(7), 23).getTime() && !lim; t += 60000) { const r = await SA.sendTick(P(), { now: new Date(t), deps }); if (r.why === 'send limit') lim = r; }
  g.fail = null;
  ok('a send Microsoft refuses for a limit stops it, and the email waits', !!lim && (await SA.getState(P())).paused === true && /Microsoft limited sending/.test((await SA.getState(P())).paused_reason)
    && (await P().query(`SELECT COUNT(*)::int n FROM sales_emails WHERE state = 'draft' AND error LIKE 'Microsoft limited sending%'`)).rows[0].n === 1);
  ok('every stop emailed JohnMark', alerts.filter((a) => /^Sales autopilot stopped: /.test(a.subject)).length === 4, alerts.map((a) => a.subject));
  await SA.resume(P());

  // ── 9. UNSUBSCRIBE LINK, BOOKING, TRIAL ───────────────────────────────
  OUT.push('', '-- other stops --');
  const live = (await P().query(`SELECT * FROM sales_prospects WHERE status = 'active' ORDER BY first_sent_at`)).rows;
  await require(REPO + 'server/services/sendRules.js').suppressManually(P(), live[0].email, { reason: 'unsubscribed from an outreach email', kind: 'unsubscribe' });
  ok('the unsubscribe link stops the sequence instantly', await SA.onSuppressed(P(), live[0].email) && (await st(live[0])).status === 'unsubscribed');
  ok('  the unsubscribe route calls it', /require\('\.\/services\/salesAutopilot'\)\.onSuppressed\(store\.pool, address\)/.test(src('server/index.js')));
  g.inbox = [];
  g.calendar = [{ id: 'ev1', subject: 'NILDash demo', isCancelled: false, start: { dateTime: DAY(9) + 'T15:00:00' }, attendees: [{ emailAddress: { address: live[1].email } }] }];
  await R.scan(P(), { deps });
  ok('a demo booked on his calendar stops the sequence', (await st(live[1])).status === 'booked');
  await P().query(`INSERT INTO users (id, name, email, password, role) VALUES ('sa-trial', 'Trial Taker', $1, 'x', 'agent')`, [live[2].email]);
  await SA.recordTrial(P(), { id: 'sa-trial', email: live[2].email }, 'signup');
  ok('a prospect who starts a trial gets no more sales email', (await st(live[2])).status === 'trial');
  await P().query(`DELETE FROM users WHERE id = 'sa-trial'`);

  // ── 10. THE 14-DAY TRIAL ──────────────────────────────────────────────
  OUT.push('', '-- the trial --');
  ok('?trial=14 gives 14 days with SALES_TRIAL_ON, nothing otherwise', SA.trialDaysFor('14') === 14 && SA.trialDaysFor('30') === 0 && SA.trialDaysFor(undefined) === 0
    && (process.env.SALES_TRIAL_ON = 'false', SA.trialDaysFor('14') === 0) && (process.env.SALES_TRIAL_ON = 'true', true));
  const idx = src('server/index.js');
  ok('checkout takes the card and starts a 14-day Stripe trial: first charge on day 15', /payment_method_collection: 'always',\s*\.\.\.\(opts\.trialDays > 0 \? \{ subscription_data: \{ trial_period_days: opts\.trialDays/.test(idx));
  ok('  signup passes the trial through, and plain signup is unchanged', /const trialDays = SA\.trialDaysFor\(trial\);\s*const checkoutUrl = await createAgentCheckoutSession\(user, \{ trialDays \}\);/.test(idx)
    && /trial: \(function \(\) \{ try \{ return new URLSearchParams\(window\.location\.search\)\.get\('trial'\)/.test(src('public/index.html')));
  const tryHtml = await SA.tryPage(P());
  ok('/try books 15 minutes with JohnMark and starts the trial', /href="https:\/\/calendly\.com\/johnmark\/15min">Book 15 minutes with JohnMark/.test(tryHtml) && /href="\/\?signin=agent&amp;tab=signup&amp;trial=14">Start 14-day trial/.test(tryHtml)
    && /first charge is on day 15/.test(tryHtml) && !/<img|<script/i.test(tryHtml));
  const PH = require(REPO + 'server/services/publicHome.js');
  const home = await PH.render(P(), {}).catch((e) => 'ERR ' + e.message);
  process.env.SALES_TRIAL_ON = 'false';
  const homeOff = await PH.render(P(), {}).catch((e) => 'ERR ' + e.message);
  process.env.SALES_TRIAL_ON = 'true';
  ok('the homepage has "Start 14-day trial" with the switch on, and nothing with it off', /trial=14">Start 14-day trial<\/a>/.test(home) && !/Start 14-day trial/.test(homeOff) && !/TRIAL_CTA/.test(homeOff));

  // ── 11. REPORTING ─────────────────────────────────────────────────────
  OUT.push('', '-- reporting --');
  const ms = await SA.morningSection(P(), { now: CT(DAY(1), 5, 30) });
  ok('the 5:30 section: sends, replies, interested, trials, bounces, warm-up', /SALES AUTOPILOT \(\d{4}-\d\d-\d\d\): sending/.test(ms.lines[0])
    && /sent 10 \(10 first, 0 follow-up\), replies \d+, interested \d+, trials started \d+, bounces \d+/.test(ms.lines[1]) && /warm-up: day 2, up to 13 sends today/.test(ms.lines[2]), ms.lines);
  const S5 = require(REPO + 'server/services/shortOfFive.js');
  const r5 = await S5.collect(P(), { now: CT(DAY(1), 5, 30) });
  ok('  it is in the 5:30 email', !!r5.sales && S5.render(r5).text.includes('SALES AUTOPILOT') && S5.needsEmail(r5));
  const total = await SA.numbers(P(), SA.centralDay().date, DAY(14));
  ok('the numbers for a date range', total.sent >= 20 && total.replies >= 4 && total.interested >= 1 && total.bounces >= 1 && total.unsubscribes >= 2 && total.booked === 1, total);
  const rep = await SCRIPT.reportText(P(), { from: SA.centralDay().date, to: DAY(14) });
  ok('the admin script reports the same, by day', /^SALES AUTOPILOT, /.test(rep) && /TOTALS/.test(rep) && /BY DAY/.test(rep) && /SEQUENCES THAT ENDED/.test(rep), rep.slice(0, 300));
  const desc = require(REPO + 'server/scripts/admin/sales-autopilot.js');
  ok('  /api/admin/scripts/sales-autopilot takes a date range, dry, plan and resume', desc.name === 'sales-autopilot'
    && JSON.stringify(desc.args({ from: '2026-10-01', to: '2026-10-25' })) === '["--from","2026-10-01","--to","2026-10-25"]'
    && JSON.stringify(desc.args({ dry: '1' })) === '["--dry"]' && JSON.stringify(desc.args({ resume: '1' })) === '["--resume"]');

  // ── 12. THE WRITER'S RULES ────────────────────────────────────────────
  OUT.push('', '-- the writer --');
  const pA = { lane: 'agency', person: 'Ann Lee', org: 'Ridge Sports', state: 'TX', league: 'NFL', fact: 'Ridge Sports represents 14 college football players.' };
  const bad = [
    ['hype', 'Hi Ann,\n\nRevolutionary news! NILDash gives agents their mornings back with 5 pitches, already written, to verified people.\n\nRidge Sports rocks.\n\n15 minutes? https://mynildash.com/try\n\nJohnMark Compton\nNILDash'],
    ['em dash', 'Hi Ann,\n\nNILDash gives agents their mornings back \u2014 5 pitches, already written, to verified people.\n\nRidge Sports.\n\n15 minutes? https://mynildash.com/try\n\nJohnMark Compton'],
    ['deal claim', 'Hi Ann,\n\nNILDash gives agents their mornings back and closes deals for you: 5 pitches, already written, to verified people.\n\nRidge Sports.\n\n15 minutes? https://mynildash.com/try\n\nJohnMark Compton'],
    ['two links', 'Hi Ann,\n\nNILDash gives agents their mornings back: 5 pitches, already written, to verified people. https://bit.ly/x\n\nRidge Sports.\n\n15 minutes? https://mynildash.com/try\n\nJohnMark Compton'],
    ['AI', 'Hi Ann,\n\nNILDash uses AI to give agents their mornings back: 5 pitches, already written, to verified people.\n\nRidge Sports.\n\n15 minutes? https://mynildash.com/try\n\nJohnMark Compton'],
    ['too long', 'Hi Ann,\n\n' + 'NILDash gives agents their mornings back with 5 pitches already written to verified people. '.repeat(10) + '\n\nRidge Sports. 15 minutes? https://mynildash.com/try\n\nJohnMark Compton'],
  ];
  for (const [what, body] of bad) {
    const w = await W.write(pA, ctx, { write: async () => ({ subject: 'Pitches for Ridge', body }) });
    ok(`a draft with ${what} is refused and the template goes instead`, w.by === 'template' && w.writerProblems && w.writerProblems.length > 0 && W.checkEmail(w, pA, ctx, 1).length === 0, w.writerProblems);
  }
  const good = await W.write(pA, ctx, { write: async () => ({ subject: 'Mornings back for Ridge Sports', body: 'Hi Ann,\n\nNILDash gives agents their mornings back. Every morning, each athlete you represent has 5 pitches ready for local and social brands, already written and going to verified people. You review and send.\n\nRidge Sports represents 14 college football players, so that adds up fast.\n\nWorth 15 minutes to see it? Book a time or start a 14-day trial here: https://mynildash.com/try\n\nJohnMark Compton\nNILDash' }) });
  ok('a draft that keeps every rule goes as written', good.by === 'injected', good.writerProblems);
  ok('the pitch writer is untouched: still claude-sonnet-4-6', /const MODEL_BALANCED = 'claude-sonnet-4-6';/.test(src('server/ai.js')) && /const MODEL_GEN = MODEL_BALANCED;/.test(src('server/ai.js'))
    && !/MODEL_BALANCED|MODEL_GEN|generateDealPitch/.test(src('server/services/salesWriter.js').replace(/^\s*\/\/.*$/gm, '')));

  // ── 13. THE MAILBOX ───────────────────────────────────────────────────
  OUT.push('', '-- the mailbox --');
  await P().query(`DELETE FROM email_accounts WHERE id IN ('ea-sa-1', 'ea-sa-2')`);
  ok('no connected mailbox: not ready, with the connect link', !(await MB.account(P())).ok && /\/admin\/sales\/connect-mailbox/.test((await MB.account(P())).why));
  await P().query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status, granted_scopes, can_send) VALUES ('ea-sa-1', 'sa-existing', 'outlook', 'john@comptongroupllc.com', 'active', $1, TRUE)`,
    [['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.ReadWrite']]);
  ok('  a non-admin account with the same address is never used', !(await MB.account(P())).ok);
  await P().query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status, granted_scopes, can_send) VALUES ('ea-sa-2', 'sa-admin', 'outlook', 'john@comptongroupllc.com', 'active', $1, TRUE)`,
    [['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Calendars.Read']]);
  const acct = await MB.account(P());
  ok('the admin\'s Outlook row: send and read, but no folder move without Mail.ReadWrite', acct.ok && acct.canSend && acct.canRead && !acct.canMove && acct.canCalendar, acct);
  await P().query(`UPDATE email_accounts SET granted_scopes = $1 WHERE id = 'ea-sa-2'`, [['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.ReadWrite']]);
  ok('  with Mail.ReadWrite it can file replies', (await MB.account(P())).canMove === true);
  await P().query(`DELETE FROM email_accounts WHERE id IN ('ea-sa-1', 'ea-sa-2')`);
  const OL = require(REPO + 'server/services/providers/outlook.js');
  ok('the sales connect asks for Mail.ReadWrite; no other connect does', OL.scopesFor({ sales: true }).some((s) => /Mail\.ReadWrite$/.test(s))
    && !OL.scopesFor({}).concat(OL.scopesFor({ read: true }), OL.scopesFor({ calendar: true })).some((s) => /Mail\.ReadWrite$/.test(s)));
  ok('  the admin login only', /sales = !!me && String\(me\.email \|\| ''\)\.toLowerCase\(\) === require\('\.\.\/services\/coldAgent'\)\.adminEmail\(\);/.test(src('server/routes/email.js'))
    && /app\.get\('\/admin\/sales\/connect-mailbox', _coldAdmin,/.test(idx));
  ok('a 429 from Graph is a send limit; an ordinary error is not', MB.isSendLimit({ status: 429 }) && MB.isSendLimit({ status: 554, message: '5.2.0 STOREDRV.Submission.Exception:OutboundSpamException' }) && !MB.isSendLimit({ status: 500, message: 'Internal' }));

  // Clean up what other suites could see.
  await reset();
  await P().query(`DELETE FROM users WHERE id IN ('sa-existing', 'sa-admin')`);

  console.log(OUT.join('\n'));
  const passed = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(`\n${passed}/${OUT.filter((l) => /^(PASS|FAIL)/.test(l)).length} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); console.log(OUT.join('\n')); process.exit(1); });
