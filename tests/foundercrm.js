'use strict';
// ── THE FOUNDER'S CRM ───────────────────────────────────────────────────────
//
//   node tests/foundercrm.js
//
// services/founderCrm and its routes: who to follow up with today, one-tap
// logging that moves the follow-up, reminders sent once, the old pipeline
// imported without doubling, a calendar file per follow-up, and admin only.
// The routes are run for real behind the real admin gate, and the page is
// driven in a real browser at phone size.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('foundercrmtest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const http = require('http');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
// Wednesday Nov 25, 2026, 2:00 pm Eastern.
const NOW = new Date('2026-11-25T19:00:00Z');
const at = (iso) => new Date(iso);

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store');
  const P = store.pool;
  const C = require(REPO + 'server/services/founderCrm');

  console.log('-- contacts --');
  const a = await C.create(P, { name: 'Chris Example', org: 'Example Sports Agency', group: 'customer', stage: 'active', phone: '(205) 555-0142', next: 'Call about payment.', due: '2026-11-25', prio: 1, value: '$99' });
  ok('a contact saves, with an id from the name', a.ok && a.contact.id === 'chris-example' && a.contact.value === 99 && a.contact.due === '2026-11-25' && a.contact.prio === 1, a.contact);
  ok('no name: refused', (await C.create(P, { org: 'X' })).ok === false);
  const dup = await C.create(P, { name: 'Chris Example' });
  ok('the same name again gets its own id, never overwrites', dup.ok && dup.contact.id === 'chris-example-2');
  await C.update(P, 'chris-example-2', { archived: true });
  await C.create(P, { name: 'Dana Later', group: 'prospect', next: 'Send the offer.', due: '2026-11-23' });
  await C.create(P, { name: 'Pat Soon', group: 'prospect', next: 'Check in.', due: '2026-11-30', dueTime: '14:30' });
  await C.create(P, { name: 'No Date', group: 'prospect' });
  await C.create(P, { name: 'Junk Fields', group: 'not-a-group', stage: 'nope', due: 'tomorrow', dueTime: '25:99', prio: 9 });
  const junk = await C.get(P, 'junk-fields');
  ok('a field that is not one of the choices falls back, never stored as typed', junk.group === 'prospect' && junk.stage === 'new' && junk.due === null && junk.dueTime === null && junk.prio === 2, junk);
  const up = await C.update(P, 'dana-later', { phone: '205-555-0188' });
  ok('an edit changes only what was sent', up.ok && up.contact.phone === '205-555-0188' && up.contact.next === 'Send the offer.' && up.contact.due === '2026-11-23', up.contact);
  ok('an unknown contact is a 404', (await C.update(P, 'nobody', { phone: '1' })).status === 404);

  console.log('-- today --');
  let t = await C.today(P, { now: NOW });
  ok('today is his day, not UTC\'s', t.date === '2026-11-25' && (await C.today(P, { now: at('2026-11-26T03:30:00Z') })).date === '2026-11-25', t.date);
  ok('overdue, due today and the next week, each in its place', t.overdue.map((c) => c.id).join() === 'dana-later' && t.today.map((c) => c.id).join() === 'chris-example' && t.upcoming.map((c) => c.id).join() === 'pat-soon', [t.overdue.map((c) => c.id), t.today.map((c) => c.id), t.upcoming.map((c) => c.id)]);
  ok('an archived contact is nowhere', !(await C.list(P)).some((c) => c.id === 'chris-example-2'));
  ok('it counts the open contacts with no follow-up date', t.counts.noNextStep === 2, t.counts);

  console.log('-- one tap: "I called and he did not answer" --');
  ok('the follow-up each kind of touch suggests', C.suggestFollowUp('no_answer', NOW) === '2026-11-26' && C.suggestFollowUp('voicemail', NOW) === '2026-11-27' && C.suggestFollowUp('talked', NOW) === '2026-12-02' && C.suggestFollowUp('note', NOW) === null,
    [C.suggestFollowUp('no_answer', NOW), C.suggestFollowUp('voicemail', NOW), C.suggestFollowUp('talked', NOW)]);
  ok('  never a Saturday or Sunday', C.suggestFollowUp('texted', NOW) === '2026-11-30' && C.addDays('2026-11-27', 1) === '2026-11-30' && C.addDays('2026-11-27', 2) === '2026-11-30', C.suggestFollowUp('texted', NOW));
  let l = await C.log(P, 'chris-example', { outcome: 'no_answer' }, { now: NOW });
  ok('logged with the time, and the follow-up moves to tomorrow', l.ok && l.contact.due === '2026-11-26' && l.contact.activity[0].text === 'Called. No answer.' && l.contact.activity[0].type === 'call'
    && new Date(l.contact.activity[0].at).getTime() === NOW.getTime() && new Date(l.contact.lastTouchAt).getTime() === NOW.getTime(), l.contact);
  t = await C.today(P, { now: NOW });
  ok('  so he is off today\'s list', !t.today.some((c) => c.id === 'chris-example') && t.upcoming.some((c) => c.id === 'chris-example'));
  l = await C.log(P, 'chris-example', { outcome: 'talked', note: 'New card arrives Friday.', due: '2026-12-01', dueTime: '10:00', next: 'Call to take payment.', stage: 'active' }, { now: at('2026-11-25T20:00:00Z') });
  ok('his own date, time, note and next step win over the suggestion', l.contact.due === '2026-12-01' && l.contact.dueTime === '10:00' && l.contact.next === 'Call to take payment.' && l.contact.activity[0].text === 'Talked on the phone. New card arrives Friday.' && l.contact.activity.length === 2, l.contact);
  ok('  history is newest first, and the list carries the last touch', l.contact.activity[1].text === 'Called. No answer.' && (await C.list(P)).find((c) => c.id === 'chris-example').lastTouch.text === 'Talked on the phone. New card arrives Friday.');
  l = await C.log(P, 'dana-later', { outcome: 'note', note: 'Prefers texts.' }, { now: NOW });
  ok('a note is kept and moves nothing', l.contact.due === '2026-11-23' && l.contact.lastTouchAt === null && l.contact.activity[0].type === 'note', l.contact);
  ok('  an empty note is refused', (await C.log(P, 'dana-later', { outcome: 'note', note: '  ' })).ok === false);
  l = await C.log(P, 'dana-later', { outcome: 'emailed', due: null }, { now: NOW });
  ok('"no follow-up" clears the date', l.contact.due === null);
  l = await C.log(P, 'dana-later', { outcome: 'talked', done: true }, { now: NOW });
  ok('"done with them" ends the follow-ups', l.contact.state === 'done' && l.contact.due === null);
  ok('nothing is logged without saying what happened', (await C.log(P, 'dana-later', {})).ok === false && (await C.log(P, 'nobody', { outcome: 'talked' })).status === 404);
  const before = (await C.get(P, 'dana-later')).activity.length;
  await C.removeActivity(P, 'dana-later', (await C.get(P, 'dana-later')).activity[0].id);
  ok('a mis-logged entry can be removed, only from its own contact', (await C.get(P, 'dana-later')).activity.length === before - 1
    && (await C.removeActivity(P, 'chris-example', (await C.get(P, 'dana-later')).activity[0].id)).removed === 0);

  console.log('-- tell me when --');
  await C.update(P, 'chris-example', { due: '2026-11-27', dueTime: '10:00', state: 'open' });
  await C.update(P, 'pat-soon', { due: '2026-11-27', dueTime: null });
  await C.update(P, 'dana-later', { due: '2026-11-25', state: 'open' });
  const sent = [];
  const send = async (to, msg) => { sent.push({ to, msg }); };
  const TO = 'founder@nildash.test';
  const fri = (h, m) => at(`2026-11-27T${String(h + 5).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);   // Eastern standard time
  ok('before 7:30 nothing is sent', (await C.tick(P, { now: fri(7, 29), to: TO, send })).length === 0 && sent.length === 0);
  let k = await C.tick(P, { now: fri(7, 30), to: TO, send });
  ok('7:30: one morning email, to him', k.join() === 'morning' && sent.length === 1 && sent[0].to === TO, k);
  const m = sent[0].msg;
  ok('  it counts what is due and what is overdue', m.subject === '3 follow-ups today (1 overdue)', m.subject);
  ok('  and names each one with its next step and time', /OVERDUE\n- Dana Later: Send the offer\./.test(m.text) && /TODAY\n- Chris Example \(Example Sports Agency\): Call to take payment\. At 10:00 am\.\n- Pat Soon: Check in\./.test(m.text) && /\/admin\/crm/.test(m.text), m.text);
  ok('  nothing in it is unescaped', !/<script/i.test(C.morningEmail({ overdue: [], today: [{ name: '<script>x</script>', next: 'a<b' }] }).html));
  ok('the next minute does not send it again', (await C.tick(P, { now: fri(7, 31), to: TO, send })).length === 0 && sent.length === 1);
  ok('9:59: the timed one is not due yet', (await C.tick(P, { now: fri(9, 59), to: TO, send })).length === 0);
  k = await C.tick(P, { now: fri(10, 0), to: TO, send });
  ok('10:00: the timed reminder, once, with the number to call', k.join() === 'timed' && sent.length === 2 && sent[1].msg.subject === 'Now: Chris Example (Example Sports Agency)' && /tel:2055550142/.test(sent[1].msg.html) && /#c=chris-example/.test(sent[1].msg.html), sent[1] && sent[1].msg);
  ok('  and not again a minute later', (await C.tick(P, { now: fri(10, 1), to: TO, send })).length === 0 && sent.length === 2);
  await C.update(P, 'pat-soon', { dueTime: '13:00' });
  k = await C.tick(P, { now: fri(14, 30), to: TO, send });
  ok('a reminder missed by a restart still goes out, up to two hours late', k.join() === 'timed' && sent.length === 3);
  await C.update(P, 'pat-soon', { dueTime: '09:00' });
  ok('  but not one from much earlier in the day', (await C.tick(P, { now: fri(14, 31), to: TO, send })).length === 0);
  ok('a send that fails never throws', Array.isArray(await C.tick(P, { now: at('2026-11-30T13:00:00Z'), to: TO, send: async () => { throw new Error('mail down'); } })));
  await P.query(`UPDATE crm_contacts SET due_on = NULL`);
  ok('nothing due: no morning email', (await C.tick(P, { now: at('2026-12-01T13:00:00Z'), to: TO, send })).length === 0);

  console.log('-- the calendar file --');
  await C.update(P, 'chris-example', { due: '2026-12-01', dueTime: '10:00' });
  const ics = C.ics(await C.get(P, 'chris-example'), { now: NOW });
  ok('a timed follow-up is an event at that time where he is, with an alert', /BEGIN:VEVENT/.test(ics) && /DTSTART;TZID=America\/New_York:20261201T100000/.test(ics) && /SUMMARY:Follow up: Chris Example/.test(ics) && /BEGIN:VALARM/.test(ics) && /Phone: \(205\) 555-0142/.test(ics), ics);
  await C.update(P, 'chris-example', { dueTime: null });
  ok('with no time it is an all-day event', /DTSTART;VALUE=DATE:20261201/.test(C.ics(await C.get(P, 'chris-example'))));
  ok('no date, no file', C.ics(await C.get(P, 'no-date')) === null);

  console.log('-- bringing the old pipeline over --');
  const docs = [
    { id: 'zane', data: { name: 'Zed Example', org: 'KM Sports', group: 'prospect', stage: 'trial', channel: 'text', next: 'Wait for him to connect.', due: '2026-11-30', say: 'Hey Zed!', notes: 'Runs outreach for 50 clients.', prio: 1, value: 0,
      activity: [{ at: '2026-11-17', type: 'call', text: 'First call.' }, { at: '2026-11-25T17:30:00Z', type: 'inbound', text: 'Sent his email.' }, { at: 'garbage', type: 'x', text: 'bad date' }, { at: '2026-11-20', type: 'weird', text: 'Typed a note.' }] } },
    { id: 'chris-example', data: { name: 'Someone Else' } },
    { data: { org: 'no name' } },
  ];
  const im = await C.importAll(P, docs);
  ok('new contacts come in with their history', im.added === 1 && im.activity === 3 && im.skipped === 2, im);
  const z = await C.get(P, 'zane');
  ok('  every field lands, history is newest first, and the last touch is the last real contact', z.name === 'Zed Example' && z.stage === 'trial' && z.say === 'Hey Zed!' && z.prio === 1 && z.due === '2026-11-30'
    && z.activity[0].text === 'Sent his email.' && z.activity.find((x) => x.text === 'Typed a note.').type === 'note' && new Date(z.lastTouchAt).toISOString() === '2026-11-25T17:30:00.000Z', z);
  ok('  someone already here is left exactly as they are', (await C.get(P, 'chris-example')).name === 'Chris Example');
  ok('importing the same file again adds nothing twice', (await C.importAll(P, docs)).added === 0 && (await C.get(P, 'zane')).activity.length === 3);

  console.log('-- the routes, behind the real admin gate --');
  const SRC = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const a0 = SRC.indexOf("// ── THE FOUNDER'S CRM (services/founderCrm)");
  const b0 = SRC.indexOf('// Mark an agent done-for-you (or stop)', a0);
  ok('the block is after the admin gate', a0 > SRC.indexOf('AG.makeAdminGate(') && b0 > a0);
  const ADMIN_EMAIL = 'founder@nildash.test';
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('adm', $1, 'the founder', 'x', 'admin'), ('ag1', 'agent@x.com', 'An Agent', 'x', 'agent')`, [ADMIN_EMAIL]);
  const express = require('express');
  const path = require('path');
  const app = express();
  { const j50 = express.json({ limit: '50kb' }); app.use((rq, rs, next) => (rq.path === '/api/admin/crm/import' ? next() : j50(rq, rs, next))); }
  app.use(express.static(REPO + 'public'));
  const sessions = { A: { userId: 'adm' }, Z: { userId: 'ag1' }, X: {} };
  app.use((rq, _rs, next) => { const m = /sess=(\w)/.exec(rq.headers.cookie || ''); rq.session = sessions[rq.headers['x-sess'] || (m && m[1]) || 'X'] || {}; next(); });
  { const AG = require(REPO + 'server/middleware/adminGate');
    app.use(AG.PREFIXES, AG.makeAdminGate({ getUser: (id) => store.getUser(id), adminEmail: ADMIN_EMAIL, isFounderEmail: () => false })); }
  const realTimeout = global.setTimeout;
  { const require_ = require; const __dirname_ = REPO + 'server';
    // The block starts a reminder timer after a minute: not in a test.
    (function (require, __dirname, setTimeout) { eval(SRC.slice(a0, b0)); })((m2) => require_(m2.startsWith('./') ? REPO + 'server/' + m2.slice(2) : m2), __dirname_, () => 0); }
  void realTimeout; void path;
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (sess, method, p, body) => new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', 'x-sess': sess } }, (r) => {
      let tx = ''; r.on('data', (c) => { tx += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(tx); } catch (_) {} res({ code: r.statusCode, body: j, text: tx, headers: r.headers }); });
    });
    rq.on('error', rej); if (body) rq.write(JSON.stringify(body)); rq.end();
  });
  let r = await call('Z', 'GET', '/api/admin/crm/contacts');
  ok('an agent gets nothing', r.code === 403 && (await call('Z', 'GET', '/admin/crm')).code === 403 && (await call('Z', 'POST', '/api/admin/crm/contacts', { name: 'x' })).code === 403, r.code);
  r = await call('X', 'GET', '/api/admin/crm/today');
  ok('nobody signed in gets nothing from the API', r.code === 401);
  r = await call('X', 'GET', '/admin/crm');
  ok('  and the page sends them to sign in', r.code === 302 && r.headers.location === '/app', [r.code, r.headers.location]);
  r = await call('A', 'GET', '/admin/crm');
  ok('the admin gets the page, never cached', r.code === 200 && /<title>NILDash CRM<\/title>/.test(r.text) && /no-store/.test(r.headers['cache-control'] || ''));
  r = await call('A', 'GET', '/api/admin/crm/meta');
  ok('meta: the choices, each touch\'s suggested follow-up, and where reminders go', r.code === 200 && r.body.groups.includes('customer') && r.body.outcomes.no_answer.label === 'No answer' && /^\d{4}-\d\d-\d\d$/.test(r.body.outcomes.no_answer.follow) && r.body.outcomes.note.follow === null && r.body.alertTo === ADMIN_EMAIL, r.body);
  r = await call('A', 'POST', '/api/admin/crm/contacts', { name: 'Route Made', phone: '555', due: '2026-12-03' });
  ok('add, read, edit, log and calendar all answer', r.code === 200 && r.body.contact.id === 'route-made'
    && (await call('A', 'GET', '/api/admin/crm/contacts/route-made')).body.name === 'Route Made'
    && (await call('A', 'PATCH', '/api/admin/crm/contacts/route-made', { org: 'Co' })).body.contact.org === 'Co'
    && (await call('A', 'POST', '/api/admin/crm/contacts/route-made/log', { outcome: 'voicemail' })).body.contact.activity.length === 1
    && /BEGIN:VCALENDAR/.test((await call('A', 'GET', '/api/admin/crm/contacts/route-made/followup.ics')).text));
  ok('a missing contact is a 404, a bad log a 400', (await call('A', 'GET', '/api/admin/crm/contacts/nope')).code === 404 && (await call('A', 'POST', '/api/admin/crm/contacts/route-made/log', {})).code === 400);
  const big = Array.from({ length: 300 }, (_, i) => ({ id: 'bulk-' + i, data: { name: 'Bulk ' + i, notes: 'x'.repeat(700), activity: [{ at: '2026-11-01', type: 'call', text: 'Called.' }] } }));
  r = await call('A', 'POST', '/api/admin/crm/import', { contacts: big });
  ok('a whole pipeline (well over the usual request size) imports in one go', r.code === 200 && r.body.added === 300 && r.body.activity === 300, r.body || r.text.slice(0, 200));
  ok('  and the big body is read only after the gate: signed out, it is a 401 before a byte is parsed', (await call('X', 'POST', '/api/admin/crm/import', { contacts: big })).code === 401 && /app\.post\('\/api\/admin\/crm\/import', express\.json\(\{ limit: '4mb' \}\)/.test(SRC));
  ok('  a file that is not a list is refused in plain words', (await call('A', 'POST', '/api/admin/crm/import', { contacts: 'nope' })).code === 400);

  console.log('-- the page, on a phone --');
  await P.query(`DELETE FROM crm_contacts WHERE id LIKE 'bulk-%'`);
  await C.update(P, 'chris-example', { due: C.nowLocal().date, dueTime: null, state: 'open', next: 'Call about payment.' });
  const { chromium, devices } = require('playwright');
  const br = await chromium.launch();
  const ctx = await br.newContext({ ...devices['iPhone 13'] });
  await ctx.addCookies([{ name: 'sess', value: 'A', url: `http://127.0.0.1:${port}` }]);
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(`http://127.0.0.1:${port}/admin/crm`);
  await pg.waitForSelector('#pg-today .card');
  ok('Today shows who is due, by name, with the next step', /Chris Example/.test(await pg.textContent('#pg-today')) && /Call about payment\./.test(await pg.textContent('#pg-today')) && /to follow up today/.test(await pg.textContent('#hdSub')), await pg.textContent('#hdSub'));
  ok('  with Call and Text links to his number', (await pg.getAttribute('#pg-today .card a[href^="tel:"]', 'href')) === 'tel:2055550142' && (await pg.getAttribute('#pg-today .card a[href^="sms:"]', 'href')) === 'sms:2055550142');
  await pg.click('#pg-today .card >> text=Log');
  await pg.click('#sheetBox >> text=No answer');
  ok('tapping "No answer" picks the next working day on its own', /Follow up /.test(await pg.textContent('#sheetBox .meta')) && (await pg.inputValue('#sheetBox input[type=date]')) === C.suggestFollowUp('no_answer'), await pg.inputValue('#sheetBox input[type=date]'));
  await pg.fill('#logNote', 'Try his cell after 3.');
  await pg.click('#sheetBox >> text=Save');
  await pg.waitForSelector('#sheet:not(.open)', { state: 'attached' });
  await pg.waitForFunction(() => !/Chris Example/.test((document.querySelector('#pg-today h2') || { parentNode: { textContent: '' } }).parentNode.querySelector('.card.none') ? '' : '') || true);
  const saved = await C.get(P, 'chris-example');
  ok('  and it is saved: logged, noted, follow-up moved', saved.activity[0].text === 'Called. No answer. Try his cell after 3.' && saved.due === C.suggestFollowUp('no_answer'), [saved.activity[0], saved.due]);
  await pg.click('nav.tabs >> text=Contacts');
  await pg.fill('#q', 'zed');
  ok('search finds a contact by name', (await pg.locator('#contactList .card').count()) === 1 && /Zed Example/.test(await pg.textContent('#contactList')));
  await pg.click('#contactList .card');
  await pg.waitForSelector('#detail.open >> text=History');
  const dt = await pg.textContent('#detail');
  ok('a contact page has the script, the notes and the history', /Hey Zed!/.test(dt) && /Runs outreach for 50 clients\./.test(dt) && /Sent his email\./.test(dt) && /Add to calendar/.test(dt), dt.slice(0, 300));
  ok('nothing runs off the side of a phone screen', await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await pg.screenshot({ path: process.env.CRM_SHOT || '/tmp/crm-detail.png' });
  await pg.click('#detail >> text=Back');
  await pg.click('nav.tabs >> text=Today');
  await pg.screenshot({ path: (process.env.CRM_SHOT || '/tmp/crm-detail.png').replace('detail', 'today') });
  await pg.click('#addBtn');
  await pg.fill('#f_name', '<b>Tag Name</b>');
  await pg.click('#sheetBox >> text=Save');
  await pg.waitForSelector('#detail.open >> text=History');
  ok('a name is shown as typed, never run as HTML', (await pg.locator('#detail b').count()) === 0 && /<b>Tag Name<\/b>/.test(await pg.textContent('#detail')));
  ok('no script errors on the page', errors.length === 0, errors);
  const html = fs.readFileSync(REPO + 'server/pages/crm.html', 'utf8');
  ok('the page never builds HTML from data', !/innerHTML|insertAdjacentHTML|document\.write/.test(html));
  ok('it can be put on a home screen', /rel="manifest" href="\/crm\.webmanifest"/.test(html) && /apple-touch-icon/.test(html) && /apple-mobile-web-app-capable/.test(html)
    && JSON.parse(fs.readFileSync(REPO + 'public/crm.webmanifest', 'utf8')).start_url === '/admin/crm' && fs.existsSync(REPO + 'public/crm-icon-180.png') && fs.existsSync(REPO + 'public/crm-icon-512.png'));
  ok('the page itself is not in the public folder', !fs.existsSync(REPO + 'public/crm.html'));
  await br.close();
  srv.close();

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
