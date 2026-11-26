'use strict';
// ── EVERY FOLLOW-UP WAITS FOR THE FOUNDER, AND THE WRITER KNOWS THE THREAD ──
//
//   node tests/founderreview.js
//
// services/followUpWriter (the writer and its guard rails), services/
// founderReview (the gate), and services/followUps writing into it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('founderreviewtest', { schema: true });
process.env.SEND_GATE_ON = '0';
const WAIT = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 800) : '')); } };
const DAY = 86400000;

(async () => {
  await new Promise((r) => setTimeout(r, WAIT));
  const P = require(REPO + 'server/store').pool;
  const W = require(REPO + 'server/services/followUpWriter');
  const FU = require(REPO + 'server/services/followUps');
  const FR = require(REPO + 'server/services/founderReview');
  const M = { contactFirst: 'Dana', brand: 'Riverbend Sports', category: 'sporting goods', athlete: { name: 'Fay Player', first: 'Fay', sport: 'Softball', position: 'Shortstop', school: 'Auburn', stats: 'hit .340 with 9 home runs' },
    deliverable: 'three posts wearing the product and one in-store signing', agentFirst: 'Jo', signature: {} };
  const FIRST = 'Hi Dana,\n\nFay Player plays shortstop at Auburn and a lot of her followers shop where she does. Would you be open to a quick chat?\n\nJo';

  console.log('-- the writer is told the situation --');
  const pr = W.promptFor(M, 2, [FIRST]);
  ok('it is given the business, who it is to, the athlete on record, the idea, and every email already sent', /BUSINESS: Riverbend Sports/.test(pr) && /Hi Dana,/.test(pr) && /hit \.340 with 9 home runs/.test(pr) && /in-store signing/.test(pr) && /a lot of her followers shop where she does/.test(pr) && /email 2 of 3/.test(pr));
  ok('  the last one is told it is the last, with the sentence it must end on', /LAST email/.test(W.promptFor(M, 3, [FIRST])) && /If this is not for \{BUSINESS\}, tell me and I will stop\./.test(W.SYSTEM));
  ok('  on the pitch writer\'s model', W.MODEL === 'claude-sonnet-4-6');
  const good = 'Hi Dana,\n\nHere is a simple version for Riverbend Sports. Fay could do three posts wearing your gear and one in-store signing, and you see every post before it goes up. She hit .340 with 9 home runs, so people around here know her.\n\nWould a short call be useful?';
  const say = (body) => async () => JSON.stringify({ body });
  const chk = (touch) => (html) => FU.checkFollowUp({ subject: 'Re: x', body: html, earlier: [FIRST], touch });
  let out = await W.write(M, 2, [FIRST], { oneShot: say(good), check: chk(2) });
  ok('a good one is used, signed with the agent\'s name', out && /three posts wearing your gear/.test(out.text) && /\n\nJo$/.test(out.text) && out.material.join() === 'ai', out);
  const bad = {
    'a price': good.replace('you see every post', 'for $250 you see every post'),
    'a made-up number': good.replace('so people around here know her', 'and has 45,000 followers'),
    'another business': good.replace('Would a short call', 'It could be a joint night with Hank\'s Hardware. Would a short call'),
    '"following up"': good.replace('Here is a simple version', 'Just following up with a simple version'),
    'a link': good.replace('Would a short call', 'See https://example.com. Would a short call'),
    'a date': good.replace('Would a short call', 'We could start in October. Would a short call'),
    'a dash': good.replace('your gear and', 'your gear — and'),
    'nothing at all': 'Hi Dana,\n\nThoughts?',
  };
  for (const [what, body] of Object.entries(bad)) {
    out = await W.write(M, 2, [FIRST], { oneShot: say(body), check: chk(2) });
    ok('  refused: ' + what, out === null, out && out.text);
  }
  ok('  refused: the last email without the easy no', (await W.write(M, 3, [FIRST], { oneShot: say(good), check: chk(3) })) === null);
  let calls = 0;
  out = await W.write(M, 2, [FIRST], { oneShot: async (p) => { calls++; return JSON.stringify({ body: calls === 1 ? bad['a price'] : good }); }, check: chk(2) });
  ok('refused once, it is told why and gets one more try', calls === 2 && out && !/\$/.test(out.text));
  ok('a model that is down, or answers with something that is not the JSON, is no follow-up from the writer', (await W.write(M, 2, [FIRST], { oneShot: async () => { throw new Error('529'); } })) === null
    && (await W.write(M, 2, [FIRST], { oneShot: async () => 'Sure! Here you go.' })) === null);

  console.log('-- written into the founder\'s queue, not the agent\'s --');
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('ag1', 'jo@agency.test', 'Jo Agent', 'x', 'agent'), ('ag2', 'mo@agency.test', 'Mo Managed', 'x', 'agent')`);
  await require(REPO + 'server/services/managedClients').set(P, 'ag2', true);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('a1', 'ag1', $1), ('a2', 'ag2', $1)`, [JSON.stringify({ name: 'Fay Player', sport: 'Softball', school: 'Auburn', stats: 'hit .340 with 9 home runs' })]);
  const first = async (id, ag, ath, brand, to, daysAgo) => P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_at, sent_to_email, touch_no, send_verify_status)
    VALUES ($1, $2, $3, $4, 'Quick idea', $5, 'sent', NOW() - ($6 || ' days')::interval, $7, 1, 'valid')`, [id, ag, ath, brand, '<p>' + FIRST.replace(/\n\n/g, '</p><p>') + '</p>', String(daysAgo), to]);
  await first('r1', 'ag1', 'a1', 'Riverbend Sports', 'dana@riverbendsports.com', 5);
  await first('r2', 'ag2', 'a2', 'Riverbend Coffee', 'dana@riverbendcoffee.com', 5);
  await first('r3', 'ag1', 'a1', 'Riverbend Dental', 'dana@riverbenddental.com', 5);
  const aiDeps = { oneShot: async (p) => JSON.stringify({ body: /Riverbend Dental/.test(p) ? bad['a price'] : good.replace(/Riverbend Sports/g, (/BUSINESS: (.+)/.exec(p) || [])[1]) }) };
  const run = await FU.run(P, { aiDeps });
  const row = async (id) => (await P.query(`SELECT * FROM outreach_logs WHERE id = $1`, [id])).rows[0];
  const t2 = await row('r1-t2');
  ok('a due follow-up is written by the writer and lands in founder_review', run.written.length === 3 && t2 && t2.status === 'founder_review' && !t2.founder_ok_at && t2.angle_key === 'follow-up-ai' && /three posts wearing your gear/.test(t2.body_html), [run.written, t2 && t2.status]);
  const t2c = await row('r3-t2');
  ok('  when the writer cannot clear the rules, the fixed wording goes in, still for him to approve', t2c.status === 'founder_review' && !/\$/.test(t2c.body_html) && t2c.angle_key !== 'follow-up-ai', [t2c.angle_key, t2c.body_html]);
  ok('  nothing an agent, auto-send or the send loop reads can see it', (await P.query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE status IN ('draft', 'approved') AND touch_no > 1`)).rows[0].n === 0);
  ok('  a second pass writes nothing twice', (await FU.run(P, { aiDeps })).written.length === 0);

  console.log('-- what he sees, and what he can do --');
  let items = await FR.list(P);
  const it = items.find((x) => x.id === 'r1-t2');
  ok('the list: the done-for-you client first, each with the business, athlete, agent, address and the thread so far', items.length === 3 && items[0].managed === true && it.business === 'Riverbend Sports' && it.athlete === 'Fay Player' && it.agent === 'Jo Agent'
    && it.to === 'dana@riverbendsports.com' && it.touch === 2 && it.earlier.length === 1 && /a lot of her followers/.test(it.earlier[0].body) && it.writtenBy === 'the writer', it);
  ok('  and the count for the sidebar', (await FR.count(P)) === 3);
  let r = await FR.approve(P, 'r1-t2', { body: it.body.replace('Would a short call be useful?', 'Would a short call be useful? It is $300.') });
  ok('his own edit is held to the same rules: a price is refused, in words', r.ok === false && r.status === 400 && /price/.test(r.error) && (await row('r1-t2')).status === 'founder_review', r);
  r = await FR.approve(P, 'r1-t2', { body: it.body.replace('Would a short call be useful?', 'Is that worth ten minutes?') });
  const ap = await row('r1-t2');
  ok('approved with his edit: now an ordinary draft in the agent\'s queue, marked as seen by him', r.ok && r.next === "in the agent's queue" && ap.status === 'draft' && !!ap.founder_ok_at && /Is that worth ten minutes\?/.test(ap.body_html) && !/short call be useful/.test(ap.body_html), [r, ap.status]);
  ok('  and it is not pulled back a second time', (await FR.pullBack(P)) === 0 && (await row('r1-t2')).status === 'draft');
  ok('  approving it again is refused', (await FR.approve(P, 'r1-t2', {})).status === 404);
  let asked = null;
  r = await FR.approve(P, 'r2-t2', {}, { approveBatch: async (pool, agentId, o) => { asked = { agentId, ids: o.ids }; await pool.query(`UPDATE outreach_logs SET status = 'approved', approved_at = NOW() WHERE id = ANY($1)`, [o.ids]); return { approved: 1 }; } });
  ok('a done-for-you client: his approval is the approval, so it goes to send', r.ok && r.next === 'approved to send' && asked.agentId === 'ag2' && asked.ids.join() === 'r2-t2' && (await row('r2-t2')).status === 'approved', [r, asked]);
  r = await FR.rewrite(P, 'r3-t2', { aiDeps: { oneShot: say(good.replace(/Riverbend Sports/g, 'Riverbend Dental').replace('Here is a simple version', 'A plain version')) } });
  ok('"write it again": the writer has another go, and it still waits for him', r.ok && /A plain version/.test(r.body) && (await row('r3-t2')).status === 'founder_review' && (await row('r3-t2')).angle_key === 'follow-up-ai', r);
  ok('  and when the writer cannot, he is told so and nothing changes', (await FR.rewrite(P, 'r3-t2', { aiDeps: { oneShot: say(bad['a link']) } })).status === 502 && /A plain version/.test((await row('r3-t2')).body_html));
  r = await FR.skip(P, 'r3-t2');
  const again = await FU.run(P, { aiDeps, now: new Date(Date.now() + 10 * DAY) });
  ok('skipped: that business gets no more emails', r.ok && (await row('r3-t2')).status === 'skipped' && again.stopped.some((x) => x.root === 'r3') && !(await row('r3-t3')), again.stopped);

  console.log('-- follow-ups written before this rule --');
  await first('r4', 'ag1', 'a1', 'Riverbend Gym', 'dana@riverbendgym.com', 6);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, touch_no, parent_id, sent_to_email, approved_at)
    VALUES ('r4-t2', 'ag1', 'a1', 'Riverbend Gym', 'Re: Quick idea', '<p>Hi Dana,</p><p>Here is something concrete for Riverbend Gym: four short training videos filmed at the gym over a month. Is that worth a short call?</p><p>Jo</p>', 'approved', 2, 'r4', 'dana@riverbendgym.com', NOW())`);
  ok('one already approved by auto-send and not yet sent comes back to him', (await FR.pullBack(P)) === 1 && (await row('r4-t2')).status === 'founder_review' && !(await row('r4-t2')).approved_at);
  await P.query(`UPDATE outreach_logs SET status = 'sent', sent_at = NOW() WHERE id = 'r2-t2'`);
  ok('  one that already went out is left alone, and so is a first email', (await FR.pullBack(P)) === 0 && (await row('r2-t2')).status === 'sent' && (await row('r1')).status === 'sent');

  console.log('-- he is told --');
  const C = require(REPO + 'server/services/founderCrm');
  const sent = [];
  const at = (h) => new Date(`2026-12-01T${String(h + 5).padStart(2, '0')}:00:00Z`);   // Eastern standard time
  await C.tick(P, { now: at(7), to: 'f@x.test', send: async (to, msg) => sent.push(msg) });
  ok('not before 7:30', sent.length === 0);
  await C.tick(P, { now: at(8), to: 'f@x.test', send: async (to, msg) => sent.push(msg) });
  await C.tick(P, { now: at(9), to: 'f@x.test', send: async (to, msg) => sent.push(msg) });
  ok('one email in the morning saying how many are waiting, with the link', sent.length === 1 && /^1 follow-up to approve$/.test(sent[0].subject) && /\/admin\/follow-ups/.test(sent[0].text), sent);
  await C.tick(P, { now: at(15), to: 'f@x.test', send: async (to, msg) => sent.push(msg) });
  ok('  and once more mid-afternoon if they are still waiting', sent.length === 2);

  console.log('-- the routes and the page --');
  const SRC = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const blk = SRC.slice(SRC.indexOf('// ── FOLLOW-UPS WAIT FOR THE FOUNDER'), SRC.indexOf('// Why so few replies'));
  ok('every route is the admin\'s alone, checked on the real admin', (blk.match(/app\.(get|post)\('\/(api\/)?admin\/follow-ups/g) || []).length === 5 && (blk.match(/requireAuth, gate\(/g) || []).length === 5 && /_realAdmin\(req\)\)\) return res\.status\(403\)/.test(blk));
  const html = fs.readFileSync(REPO + 'server/pages/followups.html', 'utf8');
  ok('the page never writes data as HTML', !/innerHTML|insertAdjacentHTML|document\.write/.test(html));
  const closerSrc = fs.readFileSync(REPO + 'server/services/closer.js', 'utf8');
  ok('approving (by an agent or by auto-send) only ever takes a draft, and the send loop only ever takes an approved one',
    /WHERE id = \$1 AND status = 'draft' AND approved_at IS NULL AND sent_at IS NULL/.test(closerSrc) && /WHERE l\.status = 'approved'/.test(closerSrc) && !/founder_review/.test(closerSrc));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
