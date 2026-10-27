'use strict';
// ── ONE GATE AT SEND TIME, AND EVERY ADDRESS FROM ONE PLACE (SEND_GATE_ON) ──
//
// An agent's account sent 11 emails in 60 days; 7 went by hand to addresses
// no email finder ever produced (general.counsel@hibbett.com,
// circleheart@myyahoo.com, an info@, a hello@), and they bounced.
//
//   0. THE GUARD. Every provider send call under server/ is either on a path
//      that runs the gate first, or named here as not an outside business
//      address, with the reason. A new send call fails this suite until it
//      is one or the other.
//   1. The rule (services/sendGate): department and shared inboxes never; a
//      named person; their address; valid within 30 days, re-verified if
//      older; a check that could not run holds, never sends.
//   2. The Closer's release: blocked with the reason, the card turned into
//      the call or DM; held when the check could not run; sent and recorded
//      when valid. Off: unchanged.
//   3. The editor's Send: blocked, with the reason and the call or DM on
//      send-status. "This bounced": suppressed, follow-ups stopped.
//   4. Follow-ups: never to an address never verified, or invalid since.
//   5. stop-unverified: print first, apply stops; never a sent or replied one.
//   6. bounce-report: path (card / by hand) x verification at send time.
//   7. Every address from the finder: strip, annotate, forPerson; the nightly
//      job's general-inbox and catch-all doors; Home and My Brands labels.
//   8. The 17 cards (unverified-cards): each path, and what closed it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('sendgatetest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.SEND_GATE_ON;
delete process.env.EMAIL_FIVE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();
const fs = require('fs');
const path = require('path');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g) : '')); } };
const on = () => { process.env.SEND_GATE_ON = '1'; };
const off = () => { delete process.env.SEND_GATE_ON; };
const DAY = 86400000;
const AG = 'sg-agent', AG2 = 'sg-agent2', ATH = 'sg-ath';

// ── 0. THE GUARD ────────────────────────────────────────────────────────────
function guard() {
  console.log('\n0. THE GUARD: NO SEND PATH SKIPS THE GATE');
  const SEND_CALL = /\.sendEmail\(|resend\.emails\.send\(|emails\.send\(|\bsendFn\(|_sendImpl\(|\.sendMail\(/;
  // The four paths that email a business. Each must run sendGate.check before
  // the provider is called, and act on what it says.
  const GATED = [
    { file: 'server/services/closer.js', fn: /async function releaseDue\(/, call: /sendFn\(log\)/, why: 'the Closer release: approved cards, the approved backlog, follow-ups' },
    { file: 'server/routes/outreach.js', fn: /async function runManualSend\(/, call: /router\._sendImpl\(/, why: "the editor's Send (Deal Scan, Write Outreach, the assistant's confirm)" },
    { file: 'server/index.js', fn: /async function _sendAthleteEmail\(/, call: /gmailSend\.sendEmail\(/, why: "the athlete's brand email (pitch, email, pipeline follow-up)" },
    { file: 'server/routes/email.js', fn: /router\.post\('\/send'/, call: /gmail\.sendEmail\(/, why: 'the inbox composer' },
  ];
  // Every OTHER send call, and why it is not an outside business address.
  // Counted per file: a new call in any of them fails until it is placed.
  const EXEMPT = {
    'server/jobs/closerRelease.js': { n: 2, why: 'the provider call releaseDue makes through opts.send, after the gate' },
    'server/routes/outreach.js': { n: 4, extra: true, why: 'sendViaEmailService: the provider call runManualSend makes through router._sendImpl, after the gate' },
    'server/routes/email.js': { n: 2, extra: true, why: 'the outlook / imap branches of the same composer send, after the same gate' },
    'server/index.js': { n: 15, extra: true, why: 'system mail to NILDash users (welcome, invites, verification, reports, password reset, alerts) and the second branch of _sendAthleteEmail' },
    'server/jobs/weeklyDigest.js': { n: 2, why: "the agent's own digest" },
    'server/routes/growth.js': { n: 1, why: "NILDash's own sales list, admin-sent" },
    'server/routes/resendInbound.js': { n: 1, why: 'forwards a reply to the agent' },
    'server/services/coldAgent.js': { n: 2, why: "NILDash's own account holders, admin-approved" },
    'server/services/mailboxProspects.js': { n: 2, why: "NILDash's own prospects, from the admin's mailbox" },
    'server/services/mailboxNotice.js': { n: 1, why: 'to the agent' },
    'server/services/morningAlert.js': { n: 1, why: 'to the admin' },
    'server/services/nightlyDigest.js': { n: 2, why: 'to the agent' },
    'server/services/autoSend.js': { n: 1, why: 'the morning note to the agent who turned it on' },
    'server/services/ourFault.js': { n: 1, why: 'to the admin' },
    'server/services/preflight.js': { n: 1, why: 'to the admin' },
    'server/services/sendFaults.js': { n: 1, why: 'to the agent' },
    'server/services/shortOfFive.js': { n: 1, why: 'to the admin' },
    'server/services/hunterPace.js': { n: 1, why: 'the Hunter run-out alert, to the admin' },
    // Its prospect emails go through services/salesMailbox (Graph), each to a
    // named person whose address Hunter verified within 30 days (planDay and
    // sendOne refuse anything else; tests/salesautopilot.js).
    'server/services/salesAutopilot.js': { n: 1, why: 'the sales autopilot\'s stop and interested-reply alerts, to the admin' },
    'server/services/providers/imap.js': { n: 1, why: 'the provider itself' },
  };
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.js')) files.push(p);
  } };
  walk(ROOT + 'server');
  const sites = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === 'server/services/providers/fakeSend.js') continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (SEND_CALL.test(l) && !/^\s*\/\//.test(l)) (sites[rel] = sites[rel] || []).push(i + 1); });
  }
  // The gated paths: the gate runs before the provider, and its verdict is used.
  for (const g of GATED) {
    const src = fs.readFileSync(ROOT + g.file, 'utf8');
    const m = g.fn.exec(src);
    const start = m ? m.index : -1;
    const callAt = start > -1 ? src.slice(start).search(g.call) : -1;
    const before = callAt > -1 ? src.slice(start, start + callAt) : '';
    ok(`${g.why}: the gate runs before the send`, /SG\.check\(/.test(before), g.file);
    ok('  and a "no" stops it', /!\s*_?gate\.ok|!\s*g\.ok|!\s*_?g\.ok|if \(!gate\.ok\)|if \(!_gate\.ok\)|\.ok\)\s*\{?\s*(const|throw|return)/.test(before) || /if \(!\w+\.ok\)/.test(before), g.file);
  }
  // Only through the gated paths: the provider functions are not called anywhere else.
  const outreachSrc = fs.readFileSync(ROOT + 'server/routes/outreach.js', 'utf8');
  ok('sendViaEmailService is reached only as router._sendImpl',
    (outreachSrc.match(/sendViaEmailService\(/g) || []).length === 2 && /async function sendViaEmailService\(/.test(outreachSrc)
      && /router\._sendImpl = \([^)]*\) => sendViaEmailService\(/.test(outreachSrc));
  const relSrc = fs.readFileSync(ROOT + 'server/jobs/closerRelease.js', 'utf8');
  ok('the release job sends only through closer.releaseDue', /releaseDue\(/.test(relSrc));
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok("the athlete's three routes all go through _sendAthleteEmail",
    (idx.match(/await _sendAthleteEmail\(/g) || []).length >= 3, (idx.match(/await _sendAthleteEmail\(/g) || []).length);
  // Every call site is placed.
  const unplaced = [];
  for (const [f, at] of Object.entries(sites)) {
    const gatedHere = GATED.filter((g) => g.file === f).length;
    const ex = EXEMPT[f];
    const allowed = (ex ? ex.n : 0) + gatedHere;
    if (at.length !== allowed) unplaced.push(`${f}: ${at.length} send call(s) at lines ${at.join(', ')}, ${allowed} placed`);
  }
  for (const f of Object.keys(EXEMPT)) if (!sites[f]) unplaced.push(`${f}: listed as exempt but has no send call`);
  ok('every provider send call under server/ is gated or exempt with a reason', !unplaced.length, unplaced);
}

// ── fixtures ────────────────────────────────────────────────────────────────
async function seedBase(P) {
  for (const [id, email] of [[AG, 'sg@agency.com'], [AG2, 'sg2@agency.com']]) {
    await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,$2,$3,'x','agent','America/Chicago')`, [id, id === AG ? 'Jamond D' : 'Other Agent', email]);
    await P.query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [id]);
  }
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-09-02' })]);
}
async function verified(P, email, result, ageDays = 0, status = null) {
  await P.query(
    `INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES ($1,$2,'seeded','hunter',$3, NOW() - make_interval(days => $4))
     ON CONFLICT (email) DO UPDATE SET result=EXCLUDED.result, status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`,
    [email, result, status || (result === 'valid' ? 'valid' : result === 'invalid' ? 'invalid' : 'unknown'), ageDays]);
}
let _n = 0;
async function draft(P, o) {
  const id = o.id || ('sg-' + (++_n));
  await P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, approved_at, scheduled_send_at,
                                sent_to_email, touch_no, parent_id, source, contact_name, sent_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'<p>Hi Jamie,</p><p>A real idea for your shop and our athlete.</p>',$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16, NOW()))`,
    [id, o.agent || AG, o.athlete || ATH, o.brand, 'name:' + o.brand.toLowerCase(), o.subject || 'Quick idea for ' + o.brand,
      o.status || 'approved', o.status === 'draft' ? null : new Date(Date.now() - 3600000), o.status === 'draft' ? null : new Date(Date.now() - 60000),
      o.email || null, o.touch || 1, o.parent || null, o.source || 'nightly-queue', o.contact || null, o.sentAt || null, o.createdAt || null]);
  // A Places record, so the compliance gate can clear the business.
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
                 VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
    ['name:' + o.brand.toLowerCase(), o.brand, JSON.stringify({ primaryType: 'clothing_store', types: ['clothing_store', 'store'] })]).catch(() => {});
  return id;
}
async function card(P, o) {
  const r = await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, brand_name, brand_key, channel, state, contact_name, phone, instagram, instagram_scope, outreach_log_id, slot, email, email_verified)
     VALUES ($1,$2,$3,$12,'email','queued',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [o.agent || AG, o.athlete || ATH, o.brand, o.contact || null, o.phone || null, o.instagram || null, o.instagram ? 'business' : null,
      o.log || null, o.slot || 1, o.email || null, o.verified === true, 'name:' + o.brand.toLowerCase()]);
  return r.rows[0].id;
}
const row = async (P, id) => (await P.query(`SELECT * FROM outreach_logs WHERE id=$1`, [id])).rows[0];

// ── 1. THE RULE ─────────────────────────────────────────────────────────────
async function rule(P) {
  console.log('\n1. THE RULE');
  const SG = require(ROOT + 'server/services/sendGate.js');
  const p = (e, n, o) => SG.addressProblem(e, n, o);
  ok('general.counsel@hibbett.com: a department inbox, never', (p('general.counsel@hibbett.com', 'Jamie Smith') || {}).code === 'forbidden', p('general.counsel@hibbett.com', 'Jamie Smith'));
  for (const local of ['legal', 'counsel', 'privacy', 'careers', 'customerservice', 'customer.service', 'customer-care', 'support', 'jobs', 'hr', 'compliance']) {
    ok(`  ${local}@: never`, (p(local + '@shop.com', 'Jamie Smith') || {}).code === 'forbidden', p(local + '@shop.com', 'Jamie Smith'));
  }
  ok('  never, even typed by hand', (p('legal@shop.com', null, { typed: true }) || {}).code === 'forbidden');
  ok('info@: a shared inbox, not a named person', (p('info@shop.com', 'Jamie Smith') || {}).code === 'shared');
  ok('hello@: the same', (p('hello@shop.com', 'Jamie Smith') || {}).code === 'shared');
  ok('circleheart@myyahoo.com for Jamie Smith: not their address', (p('circleheart@myyahoo.com', 'Jamie Smith') || {}).code === 'not-theirs', p('circleheart@myyahoo.com', 'Jamie Smith'));
  ok('no name: not addressed to a named person', (p('jamie@shop.com', null) || {}).code === 'no-person');
  ok('"Owner" is a role, not a person', (p('owner@shop.com', 'Owner') || {}).code !== undefined, p('owner@shop.com', 'Owner'));
  ok('jamie@shop.com for Jamie Smith: may be theirs', p('jamie@shop.com', 'Jamie Smith') === null, p('jamie@shop.com', 'Jamie Smith'));
  ok('jsmith@shop.com for Jamie Smith: may be theirs', p('jsmith@shop.com', 'Jamie Smith') === null, p('jsmith@shop.com', 'Jamie Smith'));
  ok('a typed address skips the name checks only', p('pat@shop.com', null, { typed: true }) === null);

  ok('category: valid', SG.categoryOf({ result: 'valid', status: 'valid' }) === 'valid');
  ok('category: catch-all', SG.categoryOf({ result: 'unknown', status: 'accept_all' }) === 'catch-all');
  ok('category: unverified', SG.categoryOf({ result: 'unknown', status: 'unknown' }) === 'unverified');
  ok('category: none', SG.categoryOf(null) === 'none');
  ok('category: a check made after the send did not exist then',
    SG.categoryOf({ result: 'valid', checked_at: new Date() }, new Date(Date.now() - DAY)) === 'none');

  await verified(P, 'jamie@freshco.com', 'valid', 3);
  await verified(P, 'dana@staleco.com', 'valid', 45);
  await verified(P, 'lee@goneco.com', 'valid', 45);
  await verified(P, 'kim@catchco.com', 'valid', 45);
  const calls = [];
  const V = (answers) => async (email) => { calls.push(email); const a = answers[email]; if (a instanceof Error) throw a; return a; };
  const deps = { verifier: V({ 'dana@staleco.com': { status: 'valid' }, 'lee@goneco.com': { status: 'invalid' },
    'kim@catchco.com': { status: 'accept_all' }, 'rae@downco.com': { ok: false, why: 'Hunter is down' } }) };
  const c1 = await SG.check(P, { email: 'jamie@freshco.com', contactName: 'Jamie Fresh' }, deps);
  ok('valid within 30 days: passes, no credit spent', c1.ok && !c1.reverified && !calls.includes('jamie@freshco.com'), c1);
  const c2 = await SG.check(P, { email: 'dana@staleco.com', contactName: 'Dana Stale' }, deps);
  ok('valid 45 days ago: verified again now, and passes', c2.ok && c2.reverified && calls.includes('dana@staleco.com'), c2);
  const fresh = await SG.verificationOf(P, 'dana@staleco.com');
  ok('  the new check is on record', fresh && Date.now() - new Date(fresh.checked_at).getTime() < 60000, fresh);
  const c3 = await SG.check(P, { email: 'lee@goneco.com', contactName: 'Lee Gone' }, deps);
  ok('valid 45 days ago, invalid now: blocked as invalid', !c3.ok && c3.code === 'invalid' && !c3.retry, c3);
  const c4 = await SG.check(P, { email: 'kim@catchco.com', contactName: 'Kim Catch' }, deps);
  ok('a catch-all: blocked, it cannot be verified', !c4.ok && c4.code === 'catch-all', c4);
  const c5 = await SG.check(P, { email: 'rae@downco.com', contactName: 'Rae Down' }, deps);
  ok('the check could not run: held to retry, never sent', !c5.ok && c5.retry === true && c5.code === 'not-run', c5);
  const before = calls.length;
  const c6 = await SG.check(P, { email: 'general.counsel@hibbett.com', contactName: 'Jamie Smith' }, deps);
  ok('a department inbox is refused before any credit is spent', !c6.ok && c6.code === 'forbidden' && calls.length === before, c6);

  const pk = await SG.peek(P, 'jamie@freshco.com', 'Jamie Fresh');
  ok('peek: Verified', pk.verified && pk.label === 'Verified', pk);
  const pk2 = await SG.peek(P, 'circleheart@myyahoo.com', 'Jamie Smith');
  ok('peek: Not verified, with why', !pk2.verified && pk2.label === 'Not verified' && /not Jamie Smith/.test(pk2.why), pk2);
}

// ── 2. THE CLOSER'S RELEASE ─────────────────────────────────────────────────
async function release(P) {
  console.log("\n2. THE CLOSER'S RELEASE");
  const C = require(ROOT + 'server/services/closer.js');
  const verifier = async (e) => ({ 'pat@renewco.com': { status: 'valid' }, 'max@flakyco.com': { ok: false, why: 'Hunter timed out' } })[e] || { status: 'unknown' };
  await verified(P, 'pat@renewco.com', 'valid', 40);

  // Off: as before.
  off();
  const offId = await draft(P, { brand: 'Off Co', email: 'legal@offco.com', contact: 'Jo Off' });
  const sentIds = [];
  const send = async (log) => { sentIds.push(log.id); return { providerMessageId: 'p-' + log.id }; };
  const r0 = await C.releaseDue(P, { send, gateDeps: { verifier } });
  ok('switch off: the release sends as before', sentIds.includes(offId), r0.detail);
  const off0 = await row(P, offId);
  ok('  and records what was known about the address as it left', off0.send_verify_status === 'none' && off0.send_path === 'card', { s: off0.send_verify_status, p: off0.send_path });

  on();
  sentIds.length = 0;
  const a = await draft(P, { brand: 'Hibbett', email: 'general.counsel@hibbett.com', contact: 'Jamie Smith' });
  const aCard = await card(P, { brand: 'Hibbett', contact: 'Jamie Smith', phone: '205-555-0101', log: a, email: 'general.counsel@hibbett.com', slot: 1 });
  const b = await draft(P, { brand: 'Shop Co', email: 'info@shopco.com', contact: 'Jamie Shop' });
  const bCard = await card(P, { brand: 'Shop Co', contact: 'Jamie Shop', instagram: 'shopco', log: b, email: 'info@shopco.com', slot: 2 });
  const c = await draft(P, { brand: 'Yahoo Heart', email: 'circleheart@myyahoo.com', contact: 'Jamie Smith', source: 'prewarm' });
  const d = await draft(P, { brand: 'Fresh Co', email: 'jamie@freshco.com', contact: 'Jamie Fresh' });
  const e = await draft(P, { brand: 'Renew Co', email: 'pat@renewco.com', contact: 'Pat Renew' });
  const f = await draft(P, { brand: 'Flaky Co', email: 'max@flakyco.com', contact: 'Max Flaky' });
  const g = await draft(P, { brand: 'Nobody Co', email: 'sam@nobodyco.com', contact: null });
  const r = await C.releaseDue(P, { send, gateDeps: { verifier } });
  const det = (id) => r.detail.find((x) => x.id === id) || {};

  const ra = await row(P, a);
  ok('general.counsel@: NOT SENT', !sentIds.includes(a) && !ra.sent_at, det(a));
  ok('  stopped, saying why', !!ra.cadence_stopped_at && /department inbox/.test(ra.send_error || ''), ra.send_error);
  ok('  and offering the call instead', /Call Jamie instead: 205-555-0101/.test(ra.send_error || '') && ra.gate_offer && ra.gate_offer.channel === 'call', ra.gate_offer);
  const qa = (await P.query(`SELECT * FROM outreach_queue WHERE id=$1`, [aCard])).rows[0];
  ok('  its card is a call card now, with the reason on it', qa.channel === 'call' && qa.state === 'queued' && !qa.outreach_log_id && /Not sent/.test(qa.email_note || ''), qa);
  const rb = await row(P, b);
  ok('info@: NOT SENT, a shared inbox', !sentIds.includes(b) && /shared inbox/.test(rb.send_error || ''), rb.send_error);
  const qb = (await P.query(`SELECT * FROM outreach_queue WHERE id=$1`, [bCard])).rows[0];
  ok('  its card is a DM card now, with the message to send', qb.channel === 'dm' && /real idea/.test(qb.dm_text || ''), { ch: qb.channel, dm: qb.dm_text });
  const rc = await row(P, c);
  ok("circleheart@myyahoo.com for Jamie Smith: NOT SENT, not their address", !sentIds.includes(c) && /not Jamie Smith/.test(rc.send_error || ''), rc.send_error);
  ok('  no phone or handle on file: it says so', /no phone or Instagram/.test(rc.send_error || ''), rc.send_error);
  const rd = await row(P, d);
  ok('a valid address checked 3 days ago: SENT', sentIds.includes(d) && !!rd.sent_at, det(d));
  ok('  recorded valid, from a card', rd.send_verify_status === 'valid' && rd.send_path === 'card', { s: rd.send_verify_status, p: rd.send_path });
  const re = await row(P, e);
  ok('valid 40 days ago: verified again, then SENT', sentIds.includes(e) && re.send_verify_status === 'valid', det(e));
  const rf = await row(P, f);
  ok('the check could not run: HELD, not sent and not stopped', !sentIds.includes(f) && !rf.sent_at && !rf.cadence_stopped_at && /address:/.test(rf.send_hold_reason || ''), { hold: rf.send_hold_reason, stop: rf.cadence_stopped_at });
  const rg = await row(P, g);
  ok('no named person: NOT SENT', !sentIds.includes(g) && /named person|name the person/.test(rg.send_error || ''), rg.send_error);
  ok('only the two valid ones left', sentIds.length === 2, sentIds);
  off();
}

// ── 3. THE EDITOR'S SEND, AND "THIS BOUNCED" ────────────────────────────────
async function editor(P) {
  console.log("\n3. THE EDITOR'S SEND, AND \"THIS BOUNCED\"");
  const express = require('express');
  const router = require(ROOT + 'server/routes/outreach.js');
  const sent = [];
  router._sendImpl = async (ctx, acct, to, log) => { sent.push({ to, id: log.id }); return { providerMessageId: 'm-' + log.id, messageId: '<m-' + log.id + '@x>' }; };
  router._gateDeps = { verifier: async () => ({ status: 'unknown' }) };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: AG }; next(); });
  app.use('/api/outreach', router);
  // The inbox composer, with an account that is the agent's own. The gate
  // answers before any provider is reached.
  const ES = require(ROOT + 'server/services/emailStore.js');
  ES.getEmailAccountWithTokens = async () => ({ user_id: AG, provider: 'gmail', email_address: 'sg@agency.com' });
  const emailRouter = require(ROOT + 'server/routes/email.js');
  emailRouter._gateDeps = { verifier: async () => ({ status: 'unknown' }) };
  app.use('/api/email', emailRouter);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/outreach`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const settle = async (id) => { for (let i = 0; i < 40; i++) { const s = await get('/logs/' + id + '/send-status'); if (s.body.state !== 'sending') return s.body; await new Promise((r) => setTimeout(r, 100)); } return null; };
  try {
    on();
    const h = await draft(P, { brand: 'Hibbett Two', status: 'draft', source: 'prewarm' });
    await card(P, { brand: 'Hibbett Two', contact: 'Jamie Smith', phone: '205-555-0199', slot: 3 });
    const r1 = await post('/logs/' + h + '/send', { emailAccountId: 'acct-1', toEmail: 'general.counsel@hibbett.com', contactName: 'Jamie Smith' });
    ok('Send answers at once (the send runs behind it)', r1.status === 202, r1);
    const s1 = await settle(h);
    ok('general.counsel@ from the editor: NOT SENT', !sent.some((x) => x.id === h) && s1 && s1.state === 'failed', s1);
    ok('  send-status says why', s1 && /department inbox/.test(s1.error || ''), s1 && s1.error);
    ok('  and offers the call', s1 && s1.offer && s1.offer.channel === 'call' && /Call Jamie instead/.test(s1.error), s1);
    ok('  no doubled "Not sent: Not sent:"', s1 && !/Not sent: Not sent/.test(s1.error || ''), s1 && s1.error);

    await verified(P, 'riley@goodco.com', 'valid', 1);
    const gd = await draft(P, { brand: 'Good Co', status: 'draft', source: 'prewarm' });
    await post('/logs/' + gd + '/send', { emailAccountId: 'acct-1', toEmail: 'riley@goodco.com', contactName: 'Riley Good' });
    const s2 = await settle(gd);
    ok('a valid named address from the editor: SENT', s2 && s2.state === 'sent' && sent.some((x) => x.id === gd), s2);
    const g2 = await row(P, gd);
    ok('  recorded valid, by hand', g2.send_verify_status === 'valid' && g2.send_path === 'hand', { s: g2.send_verify_status, p: g2.send_path });

    // "This bounced"
    const fu = await draft(P, { brand: 'Good Co', status: 'approved', touch: 2, parent: gd, email: 'riley@goodco.com', subject: 'Re: Quick idea for Good Co', source: 'follow-up' });
    const b1 = await post('/logs/' + gd + '/bounced', {});
    ok('"This bounced": accepted', b1.status === 200 && b1.body.ok, b1);
    const sup = (await P.query(`SELECT * FROM email_suppression WHERE email='riley@goodco.com'`)).rows[0];
    ok('  the address is suppressed as a bounce', sup && sup.kind === 'bounce', sup);
    const fur = await row(P, fu);
    ok('  its follow-up is stopped', !!fur.cadence_stopped_at, fur.cadence_stop_reason);
    ok('  and the sent email says it bounced', !!(await row(P, gd)).bounced_at);
    const b2 = await post('/logs/' + h + '/bounced', {});
    ok('only a sent email can bounce', b2.status === 400, b2);
    // The inbox composer: a new message is held to the gate too.
    const ib = await fetch(base.replace('/api/outreach', '/api/email') + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acct-1', to: 'customerservice@inboxco.com', subject: 'An idea' }) });
    const ibj = await ib.json().catch(() => ({}));
    ok('the inbox composer: customerservice@ is NOT SENT', ib.status === 409 && ibj.reason === 'unverified' && /department inbox/.test(ibj.error || ''), { s: ib.status, ibj });
    const ib2 = await fetch(base.replace('/api/outreach', '/api/email') + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acct-1', to: 'casey@inboxco.com', subject: 'An idea' }) });
    const ib2j = await ib2.json().catch(() => ({}));
    ok('  nor an address that does not verify', ib2.status === 409 && ib2j.gate === 'unverified', { s: ib2.status, ib2j });
    off();
    const b3 = await post('/logs/' + gd + '/bounced', {});
    ok('switch off: no bounce button behind it', b3.status === 404, b3.status);
    const fa = await post('/find-address', { brand: 'Good Co', name: 'Riley Good' });
    ok('switch off: no finder endpoint either', fa.status === 404, fa.status);
  } finally { off(); server.close(); }
}

// ── 4. FOLLOW-UPS ───────────────────────────────────────────────────────────
async function followups(P) {
  console.log('\n4. FOLLOW-UPS');
  const FUP = require(ROOT + 'server/services/followUps.js');
  const mk = async (brand, email, status, sendStatus) => {
    const root = await draft(P, { brand, email, status: 'sent', sentAt: new Date(Date.now() - 6 * DAY), contact: 'Avery ' + brand.split(' ')[0] });
    await P.query(`UPDATE outreach_logs SET send_verify_status=$2 WHERE id=$1`, [root, sendStatus]);
    if (status) await verified(P, email, status, 1);
    const t2 = await draft(P, { brand, email, touch: 2, parent: root, subject: 'Re: Quick idea for ' + brand, source: 'follow-up' });
    return { root, t2: await row(P, t2) };
  };
  on();
  const never = await mk('Never Co', 'avery@neverco.com', null, null);
  const why1 = await FUP.stopForSend(P, never.t2);
  ok('first email never verified: no follow-up', /never verified/.test(why1 || ''), why1);
  const since = await mk('Since Co', 'avery@sinceco.com', 'invalid', 'valid');
  const why2 = await FUP.stopForSend(P, since.t2);
  ok('verified then, invalid since: no follow-up', /invalid/.test(why2 || ''), why2);
  const good = await mk('Good Fu', 'avery@goodfu.com', 'valid', 'valid');
  const why3 = await FUP.stopForSend(P, good.t2);
  ok('verified and still valid: the follow-up may go', !why3, why3);
  off();
  const why4 = await FUP.stopForSend(P, never.t2);
  ok('switch off: as before', !why4 || !/never verified/.test(why4), why4);
}

// ── 5. STOP-UNVERIFIED ──────────────────────────────────────────────────────
async function stopUnverified(P) {
  console.log('\n5. STOP-UNVERIFIED');
  const SU = require(ROOT + 'server/services/stopUnverified.js');
  const bad = await draft(P, { agent: AG2, brand: 'Queued Bad', status: 'draft', email: 'hello@queuedbad.com', contact: 'Quinn Bad' });
  const badCard = await card(P, { agent: AG2, brand: 'Queued Bad', contact: 'Quinn Bad', phone: '205-555-0142', log: bad, email: 'hello@queuedbad.com', slot: 4 });
  const appr = await draft(P, { agent: AG2, brand: 'Approved Bad', email: 'circle@approvedbad.com', contact: 'Ari Moss' });
  await verified(P, 'quinn@queuedgood.com', 'valid', 2);
  const good = await draft(P, { agent: AG2, brand: 'Queued Good', status: 'draft', email: 'quinn@queuedgood.com', contact: 'Quinn Good' });
  const sentOne = await draft(P, { agent: AG2, brand: 'Sent One', status: 'sent', email: 'info@sentone.com', sentAt: new Date() });
  const replRoot = await draft(P, { agent: AG2, brand: 'Replied Co', status: 'sent', email: 'info@repliedco.com', sentAt: new Date(Date.now() - 5 * DAY) });
  await P.query(`UPDATE outreach_logs SET replied_at=NOW() WHERE id=$1`, [replRoot]);
  const replFu = await draft(P, { agent: AG2, brand: 'Replied Co', touch: 2, parent: replRoot, email: 'info@repliedco.com', source: 'follow-up' });
  const fu = await draft(P, { agent: AG2, brand: 'Sched Co', touch: 2, parent: sentOne, email: 'info@sentone.com', source: 'follow-up' });

  const dry = await SU.run(P, { agentId: AG2 });
  const ids = [...dry.agents.values()].flatMap((A) => A.stop.map((x) => x.id));
  ok('dry run lists the queued card to a shared inbox', ids.includes(bad), ids);
  ok('  the approved email to an address not theirs', ids.includes(appr));
  ok('  the scheduled follow-up', ids.includes(fu));
  ok('  not the verified one', !ids.includes(good));
  ok('  never anything sent', !ids.includes(sentOne) && !ids.includes(replRoot));
  ok('  never anything on a thread with a reply', !ids.includes(replFu));
  ok('  and changes nothing', !(await row(P, bad)).cadence_stopped_at && !(await row(P, appr)).cadence_stopped_at);
  const txt = SU.format(dry);
  ok('  it prints by agent, saying DRY RUN', /Other Agent/.test(txt) && /DRY RUN/.test(txt), txt.slice(0, 300));

  const applied = await SU.run(P, { agentId: AG2, apply: true });
  ok('apply stops them', applied.stopped === ids.length, applied.stopped);
  const rb = await row(P, bad);
  ok('  with the reason on the draft', !!rb.cadence_stopped_at && /shared inbox/.test(rb.send_error || ''), rb.send_error);
  const qb = (await P.query(`SELECT * FROM outreach_queue WHERE id=$1`, [badCard])).rows[0];
  ok('  and the card turned into the call', qb.channel === 'call', qb.channel);
  ok('  the verified one untouched', !(await row(P, good)).cadence_stopped_at);
  ok('  the sent one untouched', !(await row(P, sentOne)).cadence_stopped_at);
  ok('  the replied thread untouched', !(await row(P, replFu)).cadence_stopped_at);
  ok('  it says APPLIED', /APPLIED/.test(SU.format(applied)));
}

// ── 6. BOUNCE-REPORT ────────────────────────────────────────────────────────
async function bounceReport(P) {
  console.log('\n6. BOUNCE-REPORT');
  const BR = require(ROOT + 'server/services/bounceReport.js');
  const cls = BR.classify;
  ok('a nightly card sent by the release: card', cls({ source: 'nightly-queue', touch_no: 1 }).path === 'card');
  ok('a follow-up to a card: card', cls({ source: 'follow-up', root_source: 'nightly-queue', touch_no: 2 }).how === 'follow-up to a card');
  ok("the editor's Send: by hand", cls({ source: 'nightly-queue', system: 'manual' }).path === 'hand');
  ok('a Deal Scan draft approved: by hand', cls({ source: 'prewarm' }).path === 'hand');
  ok('a Write Outreach draft: by hand', cls({ source: null, contact_id: 'c1' }).how === 'Write Outreach draft, approved');
  ok('the status recorded at send wins', cls({ send_verify_status: 'catch-all', result: 'valid', status: 'valid' }).status === 'catch-all');
  ok('else the check on record, if made before the send',
    cls({ sent_at: new Date(), result: 'valid', status: 'valid', checked_at: new Date(Date.now() - DAY) }).status === 'valid'
    && cls({ sent_at: new Date(Date.now() - DAY), result: 'valid', checked_at: new Date() }).status === 'none');
  ok('suppressed as a bounce: bounced', cls({ sup_kind: 'bounce' }).bounced && !cls({ sup_kind: 'unsubscribe' }).bounced);

  const rep = await BR.run(P, { days: 30, agentId: AG });
  const A = rep.agents.get(AG);
  ok('the agent is on the report', !!A, [...rep.agents.keys()]);
  ok('  every send counted once', A && A.sends === (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id=$1 AND sent_at > NOW() - INTERVAL '30 days'`, [AG])).rows[0].n, A && A.sends);
  ok('  the editor send of riley@ is by hand, valid, bounced', A && (A.cells['hand|valid'] || {}).bounced >= 1, A && A.cells);
  ok('  the release sends are cards', A && (A.cells['card|valid'] || {}).sends >= 2, A && A.cells);
  const txt = BR.format(rep, { days: 30 });
  ok('it prints the path x status table', /by hand/.test(txt) && /catch-all/.test(txt) && /BOUNCED/.test(txt), txt.slice(0, 400));
}

// ── 7. EVERY ADDRESS FROM THE FINDER ────────────────────────────────────────
async function finder(P) {
  console.log('\n7. EVERY ADDRESS FROM THE FINDER');
  const FA = require(ROOT + 'server/services/finderAddress.js');
  const resp = {
    results: [{ brand: 'Strip Co', contactName: 'Jamie Strip', contactEmail: 'general.counsel@stripco.com', genericInbox: 'info@stripco.com',
      contacts: [{ name: 'Jamie Strip', title: 'Owner', email: 'jamie@stripco.com', phone: '205-555-0111', emailCheck: { ok: true } },
        { name: 'Pat Other', email: 'pat@stripco.com' }],
      contactLadder: { tiers: [{ tier: 1, rows: [{ name: 'Jamie Strip', email: 'js@stripco.com', emailKind: 'hunter', phone: '205-555-0111' }] }] },
      siteEmail: { email: 'info@stripco.com' }, hunterPattern: { pattern: '{first}', example: 'x@stripco.com' } }],
    finder: { email: 'kept@stripco.com' },
  };
  const s = FA.strip(JSON.parse(JSON.stringify(resp)));
  const r0 = s.results[0];
  ok('strip: the AI address on the card is gone', r0.contactEmail === undefined && r0.genericInbox === undefined);
  ok('  every contact address is gone', r0.contacts.every((c) => c.email === undefined && c.emailCheck === undefined));
  ok('  the ladder row address is gone', r0.contactLadder.tiers[0].rows[0].email === undefined);
  ok('  the scrape and the pattern example are gone', r0.siteEmail === undefined && r0.hunterPattern.example === undefined && r0.hunterPattern.pattern === '{first}');
  ok('  names, titles and phones stay', r0.contacts[0].name === 'Jamie Strip' && r0.contacts[0].phone === '205-555-0111' && r0.contactName === 'Jamie Strip');
  ok('  the finder\'s own answer stays', s.finder.email === 'kept@stripco.com');

  await FA.remember(P, { brand: 'Strip Co', name: 'Jamie Strip', email: 'jamie.strip@stripco.com' });
  await verified(P, 'jamie.strip@stripco.com', 'valid', 1);
  await FA.annotateDeep(P, s);
  ok('annotate: the finder\'s address for the named person, labelled', r0.contactEmail === 'jamie.strip@stripco.com' && r0.contactEmailVerified === true && r0.contactEmailLabel === 'Verified', r0);
  ok('  on the contact too', r0.contacts[0].email === 'jamie.strip@stripco.com' && r0.contacts[0].emailLabel === 'Verified', r0.contacts[0]);
  ok('  and on the ladder row', r0.contactLadder.tiers[0].rows[0].email === 'jamie.strip@stripco.com', r0.contactLadder.tiers[0].rows[0]);
  ok('  nobody else gets one', r0.contacts[1].email === undefined);

  const steps = [];
  const deps = {
    resolveDomain: async () => ({ domain: 'findco.com' }),
    corporate: () => null,
    hunterCached: async () => null,
    emailFinder: async (first, last, domain) => { steps.push('finder'); return { email: `${first}.${last}@${domain}`.toLowerCase() }; },
    verify: async (e) => { steps.push('verify ' + e); return { result: 'valid', status: 'valid', source: 'hunter' }; },
    peek: async () => new Map(),
  };
  const f1 = await FA.forPerson(P, { brand: 'Find Co', name: 'Robin Banks' }, deps);
  ok('forPerson: the finder\'s verified address', f1.email === 'robin.banks@findco.com' && f1.from === 'finder', f1);
  const n0 = steps.length;
  const f2 = await FA.forPerson(P, { brand: 'Find Co', name: 'Robin Banks' }, deps);
  ok('  cached 30 days: asked again, nothing spent', f2.email === f1.email && steps.length === n0, steps.length - n0);
  const f3 = await FA.forPerson(P, { brand: 'Find Co', name: 'Owner' }, deps);
  ok('  nobody named: no address', !f3.email && /nobody named/.test(f3.why), f3);
  const catchDeps = { ...deps, verify: async () => ({ result: 'unknown', status: 'accept_all', source: 'hunter' }) };
  const f4 = await FA.forPerson(P, { brand: 'Catch Co', name: 'Casey Catch' }, catchDeps);
  ok('  a catch-all never passes', !f4.email || !f4.verified, f4);

  // The nightly job's doors, and Home / My Brands.
  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('nightly, gate on: no general-inbox card', /allowGeneral: !SG\.ON\(\) && generalPlaced < 1/.test(job) && /FINDER\.smart\(\) && !SG\.ON\(\)/.test(job));
  ok('  the finder runs valid-only, so no catch-all passes', /validOnly: SG\.ON\(\) \|\| undefined/.test(job));
  ok('  the finder runs whenever the gate is on', /process\.env\.SEND_GATE_ON === '1'/.test(job.slice(job.indexOf('const FINDER = {'), job.indexOf('const FINDER = {') + 800)));
  ok('  an email card without the finder\'s verified address is the DM or call instead', /SG\.ON\(\) && card\.channel === 'email' && !\(card\.emailVerified && verifiedNamedEmail/.test(job));

  // Home: the To line's label and the bounce id.
  on();
  const Home = require(ROOT + 'server/services/homeQueue.js');
  await verified(P, 'drew@homeco.com', 'valid', 2);
  const hd = await draft(P, { brand: 'Home Co', status: 'draft', email: 'drew@homeco.com', contact: 'Drew Home' });
  await card(P, { brand: 'Home Co', contact: 'Drew Home', log: hd, email: 'drew@homeco.com', verified: true, slot: 5 });
  const hz = await draft(P, { brand: 'Home Zip', status: 'draft', email: 'info@homezip.com', contact: 'Zip Home' });
  await card(P, { brand: 'Home Zip', contact: 'Zip Home', log: hz, email: 'info@homezip.com', slot: 6 });
  let home = null;
  try { home = await Home.buildHome(P, AG, { athleteId: ATH }); } catch (e) { home = { error: e.message }; }
  const hc = (home && home.cards || []).find((x) => x.business === 'Home Co');
  const hzc = (home && home.cards || []).find((x) => x.business === 'Home Zip');
  ok('Home: a finder-verified address says Verified', hc && hc.toLabel === 'Verified' && hc.toVerified === true, hc ? { l: hc.toLabel, to: hc.to } : home && home.error);
  // A shared inbox may be held off Home altogether (its address tier); if it shows, it says why.
  ok('  a shared inbox is never shown as Verified', !hzc || (hzc.toLabel === 'Not verified' && /shared inbox/.test(hzc.toWhy || '')), hzc ? { l: hzc.toLabel, w: hzc.toWhy } : 'held off Home');
  console.log('    (Home Zip ' + (hzc ? 'shown' : 'held off Home') + ')');
  const sentRow = (home && home.outbox || []).find((x) => x.status === 'sent');
  ok('  a sent email carries the bounce button\'s id', !!sentRow && !!sentRow.bounceId, home && home.outbox);
  off();
  let home2 = null;
  try { home2 = await Home.buildHome(P, AG, { athleteId: ATH }); } catch (e) { home2 = { error: e.message }; }
  const hc2 = (home2 && home2.cards || []).find((x) => x.business === 'Home Co');
  ok('Home, switch off: no label, no bounce id', hc2 && hc2.toLabel === undefined && !(home2.outbox || []).some((x) => x.bounceId), hc2 ? hc2.toLabel : home2 && home2.error);

  const MB = require(ROOT + 'server/services/myBrands.js');
  await P.query(`INSERT INTO company_enrichment (id, agent_id, brand_name) VALUES ('sg-enr1',$1,'Brand Ai')`, [AG]).catch((e) => console.log('    (enrichment seed: ' + e.message + ')'));
  await P.query(`INSERT INTO brand_contacts (id, agent_id, enrichment_id, brand_name, name, title, email) VALUES ('sg-bc1',$1,'sg-enr1','Brand Ai','Alex Ai','Owner','alex@ai-guess.com')`, [AG]).catch((e) => console.log('    (brand_contacts seed: ' + e.message + ')'));
  await card(P, { brand: 'Brand Ai', contact: 'Alex Ai', slot: 7 });
  on();
  const pg = await MB.pageFor(P, AG, { filter: 'all', pageSize: 200 }).catch((e) => ({ error: e.message }));
  const mbRow = (pg.rows || pg.items || []).find((x) => x.brand === 'Brand Ai');
  ok('My Brands, gate on: no AI-found address', mbRow && !mbRow.email, mbRow || pg.error);
  off();
  const pg2 = await MB.pageFor(P, AG, { filter: 'all', pageSize: 200 }).catch((e) => ({ error: e.message }));
  const mbRow2 = (pg2.rows || pg2.items || []).find((x) => x.brand === 'Brand Ai');
  ok('My Brands, switch off: as before', mbRow2 && mbRow2.email === 'alex@ai-guess.com', mbRow2 || pg2.error);
}

// ── 8. THE 17 CARDS: EACH PATH AND WHAT CLOSED IT ───────────────────────────
async function seventeen(P) {
  console.log('\n8. THE 17 CARDS (unverified-cards)');
  const UC = require(ROOT + 'server/services/unverifiedCards.js');
  const card0 = { email: 'jo@x.com', email_verified: true, result: 'valid', status: 'valid' };
  ok('a valid named card: valid', UC.classifyCard(card0, null).cause === 'valid');
  ok('a card linked to an older draft that sends elsewhere: linked-draft',
    UC.classifyCard({ ...card0, draft_email: 'info@x.com', draft_source: 'prewarm' }, null).cause === 'linked-draft');
  ok('a card without the verified flag: not-flagged', UC.classifyCard({ ...card0, email_verified: false }, null).cause === 'not-flagged');
  ok('a General inbox card: general-inbox', UC.classifyCard({ ...card0, email_label: 'General inbox' }, null).cause === 'general-inbox');
  ok('a catch-all passed from a pattern: catch-all',
    UC.classifyCard({ ...card0, result: 'unknown', status: 'accept_all' }, { why: { finder: { verify: { pass: true, verdict: 'catch-all' } } } }).cause === 'catch-all');
  ok('a Deal Scan draft: scan-prewarm', UC.classifyDraft({ sent_to_email: 'info@x.com', source: 'prewarm' }).cause === 'scan-prewarm');
  ok('a scraped address attached by Home: attached', UC.classifyDraft({ sent_to_email: 'info@x.com', source: 'nightly-queue', email_kind: 'generic' }).cause === 'attached');
  ok('a Write Outreach draft: write-outreach', UC.classifyDraft({ sent_to_email: 'pat@x.com', contact_id: 'c1' }).cause === 'write-outreach');
  ok('every cause says what closed it', ['linked-draft', 'scan-prewarm', 'attached', 'write-outreach', 'catch-all', 'general-inbox', 'follow-up'].every((k) => /closed/.test(UC.CLOSED_BY[k] || '')));

  // linked-draft, closed: a verified card readdresses the draft it links to.
  const JOB = require(ROOT + 'server/jobs/outreachQueue.js');
  const Q = require(ROOT + 'server/services/outreachQueue.js');
  const old = await draft(P, { brand: 'Linked Co', status: 'draft', source: 'prewarm', email: 'info@linkedco.com' });
  const ladder = { mainLine: { phone: '205-555-0177' }, tiers: [{ tier: 1, rows: [{ name: 'Morgan Link', title: 'Owner', email: 'morgan@linkedco.com', emailKind: 'published' }] }] };
  const c = Q.buildCard({ brand: 'Linked Co', brandKey: 'name:linked co', pitch: { message: 'Hi Morgan, a real idea.' } }, ladder, {});
  c.emailVerified = true;
  const wrote = await JOB.insertCard(P, { agentId: AG, athleteId: ATH, slot: 8, card: { ...c, athleteName: 'Amber Bretton' } });
  const after = await row(P, old);
  ok('linked-draft closed: the Deal Scan draft now sends to the card\'s verified address', wrote && after.sent_to_email === 'morgan@linkedco.com', { wrote, to: after.sent_to_email });

  // attached / fillAddress / prewarm, closed.
  const DA = require(ROOT + 'server/services/draftAddress.js');
  const DC = require(ROOT + 'server/services/draftChannel.js');
  on();
  const att = await DA.attach(P, AG, ATH, { ids: [old] }).catch((e) => ({ error: e.message }));
  ok('attached closed: with the gate on, nothing is attached', att && (att.finderOnly || att.attached === 0 || (Array.isArray(att) && !att.length)), att);
  const nf = await draft(P, { brand: 'Fill Co', status: 'approved' });
  await P.query(`UPDATE outreach_logs SET sent_to_email=NULL WHERE id=$1`, [nf]);
  await card(P, { brand: 'Fill Co', contact: 'Fay Fill', log: nf, email: 'info@fillco.com', verified: false, slot: 9 });
  const got = await DC.fillAddress(P, [nf]);
  ok('fillAddress closed: an address the finder did not verify is not filled in at send', !got.get(String(nf)), [...got.entries()]);
  off();
  const pre = fs.readFileSync(ROOT + 'server/services/draftPrewarm.js', 'utf8');
  ok('scan-prewarm closed: a Deal Scan draft is written with no address under EMAIL_FIVE_ON or the gate', /EMAIL_FIVE_ON/.test(pre) && /sendGate|SEND_GATE_ON|SG\.ON\(\)/.test(pre));

  const txt = UC.format({ date: '2026-10-15', cards: 2, drafts: 1, by: { 'general-inbox': 1, 'linked-draft': 1, valid: 1 },
    items: [{ kind: 'card', cause: 'general-inbox', agent: 'Jamond D', athlete: 'A', brand: 'B', detail: 'info@b.com' },
      { kind: 'card', cause: 'linked-draft', agent: 'Jamond D', athlete: 'A', brand: 'C', detail: 'x' }, { kind: 'draft', cause: 'valid' }] });
  ok('it prints each path with what closed it', /general-inbox/.test(txt) && /closed:/.test(txt) && /2 not a named person/.test(txt), txt);
}

(async () => {
  guard();
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await require(ROOT + 'server/services/sendGate.js').ensureColumns(P);
  await require(ROOT + 'server/services/sendRules.js').ensureTable(P);   // made at boot in production
  await seedBase(P);
  for (const step of [rule, release, editor, followups, stopUnverified, bounceReport, finder, seventeen]) {
    try { await step(P); } catch (e) { F++; console.log('  FAIL  ' + step.name + ' threw: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | ')); }
  }
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
