'use strict';
// Runs against the local test Postgres. No network: research, the demo night,
// the writer and the mail provider are stubs.
//
//   node tests/coldreach.js
//
// ── THE COLD AGENT REACHES THE PEOPLE WHO NEED IT (COLD_AGENT_REACH_ON) ─────
//   comped accounts are eligible when they are not active
//   someone who cannot log in is emailed a fresh personal login link, issued
//     at send time, valid 30 days, and found nowhere but the sent email
//   group 4: logged in, has athletes, never connected a mailbox -- emailed even
//     if they logged in this week, asked to connect it, with a direct link
//   the sign-off defaults to the admin's "First name for sign-offs", as typed
//   every other exclusion is unchanged, and with the switch off nothing changes
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.BUSINESS_MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || '1 Main St, Auburn, AL 36830';
process.env.ADMIN_EMAIL = 'cr-admin@cr-admin.test';
process.env.APP_URL = 'https://mynildash.com';
delete process.env.COLD_AGENT_REACH_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const CA = require(REPO + 'server/services/coldAgent.js');
const PR = require(REPO + 'server/services/passwordReset.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);
const P = () => store.pool;
const S = CA.clampSettings({ ...CA.DEFAULTS });
const on = () => { process.env.COLD_AGENT_REACH_ON = '1'; };
const off = () => { delete process.env.COLD_AGENT_REACH_ON; };

const U = {
  compNever:  { name: 'Ada Pruitt',  email: 'ada@pruittsports.com',  created: ago(90), login: null, comped: true, resetRequired: true },
  compOld:    { name: 'Ben Ortega',  email: 'ben@ortegareps.com',    created: ago(90), login: ago(30), comped: true, athletes: 1, mailbox: true },
  compActive: { name: 'Cora Lind',   email: 'cora@lindnil.com',      created: ago(90), login: ago(3), comped: true, athletes: 1, mailbox: true },
  compNoBox:  { name: 'Dev Patel',   email: 'dev@patelmgmt.com',     created: ago(90), login: ago(3), comped: true, athletes: 2 },
  noBoxWeek:  { name: 'Eli Grant',   email: 'eli@grantagency.com',   created: ago(60), login: ago(2), athletes: 1 },
  boxWeek:    { name: 'Fay Moon',    email: 'fay@moonsports.com',    created: ago(60), login: ago(2), athletes: 1, mailbox: true },
  noBox10:    { name: 'Gil Ames',    email: 'gil@amesreps.com',      created: ago(60), login: ago(10), athletes: 1 },
  g3:         { name: 'Hal Reyes',   email: 'hal@reyesnil.com',      created: ago(60), login: ago(10), athletes: 1, mailbox: true },
  locked:     { name: 'Ivy Stone',   email: 'ivy@stonesports.com',   created: ago(100), login: null, resetRequired: true },
  usedLink:   { name: 'Jon Weller',  email: 'jon@wellerreps.com',    created: ago(100), login: null, link: 'used' },
  validLink:  { name: 'Kay Burke',   email: 'kay@burkeagency.com',   created: ago(30), login: null, link: 'valid' },
  payingNoBox:{ name: 'Lou Haynes',  email: 'lou@haynessports.com',  created: ago(60), login: ago(2), athletes: 1, sub: 'active' },
  greg:       { name: 'Mo Carver',   email: 'mo@carvernil.com',      created: ago(100), login: null, referredBy: 'pliable' },
  sinceIn:    { name: 'Ned Fox',     email: 'ned@foxreps.com',       created: ago(100), login: null, resetRequired: true },
};
const ID = (k) => 'cr-' + k;
const IDS = Object.keys(U).map(ID);
const EMAILS = Object.values(U).map((u) => u.email);

async function clean() {
  const p = P();
  await p.query(`DELETE FROM cold_demo_cards WHERE draft_id IN (SELECT id FROM cold_drafts WHERE user_id = ANY($1))`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_drafts WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_prospects WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM email_accounts WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM email_sends WHERE email = ANY($1)`, [EMAILS]).catch(() => {});
  await p.query(`DELETE FROM password_resets WHERE email = ANY($1)`, [EMAILS]).catch(() => {});
  await p.query(`DELETE FROM users WHERE id = ANY($1) OR id = 'cr-admin'`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_runs WHERE trigger LIKE 'test-cr%'`).catch(() => {});
}
async function seed() {
  const p = P();
  await p.query(`INSERT INTO users (id,name,email,password,role,sign_first_name) VALUES ('cr-admin','John Mark Compton',$1,'x','admin','JohnMark')`, [process.env.ADMIN_EMAIL]);
  for (const [k, u] of Object.entries(U)) {
    await p.query(`INSERT INTO users (id,name,email,password,role,created_at,last_login,subscription_status,comped,password_reset_required,referred_by)
                   VALUES ($1,$2,$3,'x','agent',$4,$5,$6,$7,$8,$9)`, [ID(k), u.name, u.email, u.created, u.login, u.sub || null, !!u.comped, !!u.resetRequired, u.referredBy || null]);
    if (u.link) await p.query(`INSERT INTO password_resets (email, token_hash, expires_at, used) VALUES ($1,$2,$3,$4)`,
      [u.email, 'cr-hash-' + k, u.link === 'valid' ? new Date(Date.now() + 5 * DAY) : ago(30), u.link === 'used']);
    for (let i = 0; i < (u.athletes || 0); i++) {
      await p.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [ID(k) + '-ath' + i, ID(k), JSON.stringify({ name: 'Tess Court ' + i, school: 'Auburn University', sport: 'Tennis' })]);
    }
    if (u.mailbox) await p.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ($1,$2,'gmail',$3,'active')`, [ID(k) + '-mbx', ID(k), u.email]);
  }
}

const engineCard = (i) => ({ brandName: `Court Side Grill ${i}`, contactName: `Dana Kessler ${i}`, contactTitle: 'Owner',
  email: `dana${i}@courtside${i}.com`, phone: null, instagram: null, why: 'Two blocks from the tennis center', businessCategory: 'restaurant', channel: 'email' });
const baseDeps = {
  research: async () => ({ agency: 'Some Agency', sports: ['Tennis'], rosterAthletes: [], nearbySchool: 'Auburn University' }),
  runDemo: async () => ({ demoAthleteId: 'colddemo:cr', cards: [1, 2, 3, 4].map(engineCard), tried: 9 }),
  write: async (u, ctx) => CA.templateEmail({ u, subject: ctx.subject, cards: ctx.cards, senderFull: ctx.senderFull, touchNo: ctx.touchNo, research: ctx.research, ask: ctx.ask, loginLine: ctx.loginLine }),
};
const draftOf = async (k) => (await P().query(`SELECT * FROM cold_drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [ID(k)])).rows[0];

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await CA.ensureTables(P());
  await clean();
  await seed();
  const rows = () => CA.candidates(P()).then((r) => r.filter((u) => IDS.includes(u.id)));

  // ── 1. SWITCH OFF: EXACTLY AS BEFORE ─────────────────────────────────────
  OUT.push('-- COLD_AGENT_REACH_ON off: nothing changes --');
  off();
  let by = Object.fromEntries((await rows()).map((u) => [u.id, CA.classify(u, S)]));
  let c = (k) => by[ID(k)] || {};
  ok('a comped account is never picked', !c('compNever').group && !c('compOld').group && /comped/.test(c('compOld').why), [c('compNever'), c('compOld')]);
  ok('someone who cannot log in is held for you, not emailed', c('locked').hold === 'login' && !c('locked').group, c('locked'));
  ok('logged in this week with no mailbox: left alone', /logged in this week/.test(c('noBoxWeek').why), c('noBoxWeek'));
  ok('  logged in 10 days ago, no mailbox, never approved: group 3 as before', c('noBox10').group === 3, c('noBox10'));
  ok('  and no draft would carry a login link', !Object.values(by).some((x) => x.loginLink));

  // ── 2. SWITCH ON: WHO ────────────────────────────────────────────────────
  OUT.push('', '-- COLD_AGENT_REACH_ON on: who --');
  on();
  by = Object.fromEntries((await rows()).map((u) => [u.id, CA.classify(u, S)]));
  ok('comped, never logged in: eligible (group 1), with a login link', c('compNever').group === 1 && c('compNever').loginLink === true, c('compNever'));
  ok('comped, no login in 14+ days: eligible (group 2)', c('compOld').group === 2, c('compOld'));
  ok('comped, logged in this week with a mailbox: active, left alone', !c('compActive').group && /comped and active/.test(c('compActive').why), c('compActive'));
  ok('comped, logged in, never connected a mailbox: eligible (group 4)', c('compNoBox').group === 4, c('compNoBox'));
  ok('GROUP 4: logged in this week, has athletes, no mailbox -- emailed', c('noBoxWeek').group === 4 && /never connected a mailbox/.test(c('noBoxWeek').why), c('noBoxWeek'));
  ok('  logged in 10 days ago, no mailbox: group 4 (the mailbox comes before "never approved")', c('noBox10').group === 4, c('noBox10'));
  ok('  with a mailbox, this week: still left alone; 10 days ago: group 3', /logged in this week/.test(c('boxWeek').why) && c('g3').group === 3, [c('boxWeek'), c('g3')]);
  ok('CANNOT LOG IN: emailed (group 1), not held, with a login link', c('locked').group === 1 && c('locked').loginLink === true && !c('locked').hold, c('locked'));
  ok('  a link out there they never used still gets a fresh one in the email', c('validLink').loginLink === true, c('validLink'));
  ok('  someone who set a password but never signed in gets none (they can log in)', c('usedLink').group === 1 && !c('usedLink').loginLink, c('usedLink'));
  ok('every other exclusion is kept: paying with no mailbox is still paying; Greg\'s referral still held',
    /paying/.test(c('payingNoBox').why) && c('greg').hold === 'referral', [c('payingNoBox'), c('greg')]);
  const pk = await CA.pick(P(), { settings: S, limit: 50, onlyIds: IDS });
  const order = pk.picked.map((u) => u.group);
  ok('picked in order: group 1, 2, then 4 (the mailbox), then 3', JSON.stringify(order) === JSON.stringify(order.slice().sort((a, b) => CA.GROUP_RANK[a] - CA.GROUP_RANK[b]))
    && order.indexOf(4) < order.indexOf(3) && order.indexOf(2) < order.indexOf(4), order);
  ok('  perRun stays 1 by default', CA.DEFAULTS.perRun === 1 && S.perRun === 1);

  // ── 3. THE EMAIL ─────────────────────────────────────────────────────────
  OUT.push('', '-- the email --');
  const r1 = await CA.runOnce(P(), { trigger: 'test-cr-locked', deps: { ...baseDeps, onlyIds: [ID('locked')] } });
  const d1 = await draftOf('locked');
  ok('a draft for someone who cannot log in says a login link goes in', r1.drafted === 1 && d1 && d1.login_link === true && d1.body_text.includes(CA.LOGIN_LINE), { r1: r1.note, d1 });
  ok('  but the draft holds no link: nothing to show on the page or leak in a log', !/token=|\/reset\?/.test(d1.body_text) && !/token=/.test(JSON.stringify(d1)));
  ok('  signed with the admin\'s first name for sign-offs, as typed', /\nJohnMark\nNILDash\s*$/.test(d1.body_text), d1.body_text.slice(-60));
  ok('  no link has been issued yet', (await P().query(`SELECT COUNT(*)::int n FROM password_resets WHERE email = $1`, [U.locked.email])).rows[0].n === 0);

  const r4 = await CA.runOnce(P(), { trigger: 'test-cr-g4', deps: { ...baseDeps, onlyIds: [ID('noBoxWeek')] } });
  const d4 = await draftOf('noBoxWeek');
  ok('group 4: the ask is to connect the mailbox, with a direct link to that step', r4.drafted === 1 && d4.body_text.includes(CA.MAILBOX_ASK()) && d4.body_text.includes('https://mynildash.com/connect-mailbox'), d4 && d4.body_text);
  ok('  and no login link (they can log in)', d4.login_link === false && !d4.body_text.includes(CA.LOGIN_LINE));
  const html4 = CA.textToHtml(d4.body_text);
  ok('  the link is clickable in the email', /<a href="https:\/\/mynildash\.com\/connect-mailbox">https:\/\/mynildash\.com\/connect-mailbox<\/a>/.test(html4), html4.slice(0, 300));
  await P().query(`DELETE FROM cold_demo_cards WHERE draft_id IN (SELECT id FROM cold_drafts WHERE user_id = $1)`, [ID('compNoBox')]);
  const rBad = await CA.runOnce(P(), { trigger: 'test-cr-bad', deps: { ...baseDeps, onlyIds: [ID('compNoBox')],
    write: async (u, ctx) => CA.templateEmail({ u, subject: ctx.subject, cards: ctx.cards, senderFull: ctx.senderFull, touchNo: ctx.touchNo, research: ctx.research }) } });
  ok('a writer that leaves out the group\'s ask is refused (nothing drafted)', rBad.drafted === 0 && /leaves out the ask this group needs/.test(JSON.stringify(rBad.detail.failed)), rBad.detail);
  ok('the writer is told the exact ask and the login line', /exactly this sentence, word for word/.test(require('fs').readFileSync(REPO + 'server/services/coldAgent.js', 'utf8'))
    && CA.missingRequired('x', { ask: 'A', loginLine: true }).length === 2 && CA.missingRequired(`A\n${CA.LOGIN_LINE}`, { ask: 'A', loginLine: true }).length === 0);

  // ── 4. THE SEND: THE LINK EXISTS ONLY IN THE SENT EMAIL ──────────────────
  OUT.push('', '-- the send --');
  const sent = [];
  const a1 = await CA.approve(P(), d1.id, {}, { send: async (m) => { sent.push(m); return { providerMessageId: 'cr-1' }; }, awaitSend: true });
  const m1 = sent[0] || {};
  const tok = (String(m1.text || '').match(/https:\/\/mynildash\.com\/reset\?token=([a-f0-9]{64})/) || [])[1];
  ok('approve sends it, and the sent email carries a personal set-password link right under the line', a1.ok && tok
    && new RegExp(CA.LOGIN_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\nhttps://mynildash\\.com/reset\\?token=' + tok).test(m1.text), { a1, text: m1.text });
  ok('  clickable in the HTML', m1.html && m1.html.includes(`<a href="https://mynildash.com/reset?token=${tok}">`));
  const pr = (await P().query(`SELECT token_hash, expires_at, used, created_at FROM password_resets WHERE email = $1`, [U.locked.email])).rows;
  const live = pr.find((x) => x.token_hash === PR.hashToken(tok));
  const days = live ? (new Date(live.expires_at) - Date.now()) / DAY : 0;
  ok('  issued at send time, unused, valid 30 days (stored hashed)', live && !live.used && days > 29.9 && days <= 30.01 && live.created_at, { live, days });
  const d1s = (await P().query(`SELECT * FROM cold_drafts WHERE id = $1`, [d1.id])).rows[0];
  ok('  the stored draft still has no link, and the draft is sent', d1s.status === 'sent' && !/token=/.test(JSON.stringify(d1s)), d1s.status);

  // A failed send retires the link it issued: nobody received it.
  const r2 = await CA.runOnce(P(), { trigger: 'test-cr-comp', deps: { ...baseDeps, onlyIds: [ID('compNever')] } });
  const d2 = await draftOf('compNever');
  let leaked = null;
  await CA.approve(P(), d2.id, {}, { send: async (m) => { leaked = m.text; throw new Error('provider said no to ' + m.text.match(/https:\S+token=\S+/)[0]); }, awaitSend: true });
  const d2s = (await P().query(`SELECT status, send_error FROM cold_drafts WHERE id = $1`, [d2.id])).rows[0];
  const pr2 = (await P().query(`SELECT used FROM password_resets WHERE email = $1`, [U.compNever.email])).rows;
  ok('a failed send: the link it issued is retired, so the next draft gets one again', r2.drafted === 1 && d2s.status === 'failed' && pr2.length === 1 && pr2[0].used === true, { d2s, pr2 });
  ok('  and the error shown on the page does not carry the link', /\[link removed\]/.test(d2s.send_error) && !/token=/.test(d2s.send_error), d2s.send_error);
  ok('  (the send itself did carry it)', /reset\?token=/.test(leaked || ''));

  // Signed in after the draft was written: no link, and no line about one.
  const r3 = await CA.runOnce(P(), { trigger: 'test-cr-since', deps: { ...baseDeps, onlyIds: [ID('sinceIn')] } });
  const d3 = await draftOf('sinceIn');
  await P().query(`UPDATE users SET last_login = NOW() - INTERVAL '8 days' WHERE id = $1`, [ID('sinceIn')]);
  const sent3 = [];
  await CA.approve(P(), d3.id, {}, { send: async (m) => { sent3.push(m); return {}; }, awaitSend: true });
  ok('signed in since the draft: sent without a link or the line, and no link issued', r3.drafted === 1 && sent3.length === 1 && !sent3[0].text.includes(CA.LOGIN_LINE)
    && !/token=/.test(sent3[0].text) && (await P().query(`SELECT COUNT(*)::int n FROM password_resets WHERE email = $1`, [U.sinceIn.email])).rows[0].n === 0, sent3[0] && sent3[0].text);
  const edited = CA.withLoginLink('Kay,\n\nSome businesses.\n\nJohnMark\nNILDash', 'https://x/reset?token=abc');
  ok('the admin edited the line out: it goes back in, before the sign-off', /Some businesses\.\n\nHere's your login link, it's set up and waiting:\nhttps:\/\/x\/reset\?token=abc\n\nJohnMark\nNILDash$/.test(edited), edited);

  // ── 5. THE SIGN-OFF ──────────────────────────────────────────────────────
  OUT.push('', '-- the sign-off --');
  ok('"Sign as" on the page still wins', await (async () => {
    await CA.saveSettings(P(), { signName: 'John Compton' });
    await P().query(`DELETE FROM cold_demo_cards WHERE draft_id IN (SELECT id FROM cold_drafts WHERE user_id = $1)`, [ID('g3')]);
    await CA.runOnce(P(), { trigger: 'test-cr-sign', deps: { ...baseDeps, onlyIds: [ID('g3')] } });
    await CA.saveSettings(P(), { signName: '' });
    return /\nJohn Compton\nNILDash\s*$/.test((await draftOf('g3')).body_text);
  })());
  ok('names are never lowercased', CA.cleanSignName('JohnMark') === 'JohnMark' && CA.cleanSignName(' McKay ') === 'McKay' && CA.clampSettings({ signName: 'JohnMark' }).signName === 'JohnMark');
  off();
  await P().query(`DELETE FROM cold_demo_cards WHERE draft_id IN (SELECT id FROM cold_drafts WHERE user_id = $1)`, [ID('g3')]);
  await P().query(`DELETE FROM cold_drafts WHERE user_id = $1`, [ID('g3')]);
  await CA.runOnce(P(), { trigger: 'test-cr-off', deps: { ...baseDeps, onlyIds: [ID('g3')] } });
  ok('switch off: the sign-off is the admin account\'s full name, as before', /\nJohn Mark Compton\nNILDash\s*$/.test(((await draftOf('g3')) || {}).body_text || ''), ((await draftOf('g3')) || {}).body_text);
  ok('the admin\'s first name for sign-offs is set once at startup and never overwritten',
    /UPDATE users SET sign_first_name = 'JohnMark' WHERE LOWER\(TRIM\(email\)\) = \$1 AND sign_first_name IS NULL/.test(require('fs').readFileSync(REPO + 'server/store.js', 'utf8')));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
