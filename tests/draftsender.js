'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/draftsender.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── EVERY DRAFT SAYS THE ADDRESS IT ACTUALLY SENDS FROM ────────────────────
// A paying agent read his personal Gmail (his login) on every draft and
// believed outreach went out from it. It went out from his connected work
// mailbox, as it always had: the login was written into the draft's signature.
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const ES = require(REPO + 'server/services/emailStore.js');
const WO = require(REPO + 'server/services/workflowOrchestrator.js');
const FIX = require(REPO + 'scripts/fix-draft-sender.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const A = 'ds-agent', B = 'ds-nomail', LOGIN = 'jamond.personal@gmail.test', WORK = 'jamond@agency-work.test';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P.query(`DELETE FROM email_accounts WHERE user_id = ANY($1)`, [[A, B]]);
    await P.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [[A, B]]);
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [[A, B]]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Jamond Dubose', $2, 'x', 'agent'), ($3, 'No Mailbox', 'nomail@x.test', 'x', 'agent')`, [A, LOGIN, B]);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('ds-mb', $1, 'gmail', $2, 'active')`, [A, WORK]);

  // ── 1. ONE ANSWER TO "WHICH MAILBOX" ──────────────────────────────────────
  OUT.push('-- which mailbox sends --');
  ok('the first connected mailbox, skipping a disconnected one', ES.pickSendingAccount([{ id: 1, status: 'disconnected' }, { id: 2, status: 'active' }]).id === 2);
  ok('  a disconnected one only when it is all there is (the send has always done this)', ES.pickSendingAccount([{ id: 1, status: 'disconnected' }]).id === 1);
  ok('  none: null', ES.pickSendingAccount([]) === null);
  const mb = await ES.sendingMailbox(A);
  ok('Jamond sends from his work mailbox, not his login', mb.address === WORK && mb.connected === true && mb.provider === 'gmail', mb);
  const none = await ES.sendingMailbox(B);
  ok('  an agent with no mailbox gets none, and a reason in words, never the login email', none.address === null && none.connected === false && /no mailbox/.test(none.why), none);
  ok('the send uses the same choice', /emailStore\.pickSendingAccount\(accounts\)/.test(read('server/jobs/closerRelease.js')));

  // ── 2. NEW DRAFTS ARE SIGNED WITH THE SENDING MAILBOX ─────────────────────
  OUT.push('', '-- the signature --');
  const id = await WO.loadSenderIdentity(A, false, null);
  ok('the draft is signed with the address it sends from', id.agentEmail === WORK && id.agentName === 'Jamond Dubose', id);
  const idNone = await WO.loadSenderIdentity(B, false, null);
  ok('  no mailbox connected: the signup email, as the fallback', idNone.agentEmail === 'nomail@x.test', idNone);
  const html = WO.renderProfessionalEmail('Hi there.\n\nA short pitch.', id.agentName, id.agentEmail, null, { name: 'X' }, { brand_name: 'Y' });
  ok('  the rendered body carries the work address and not the login', html.includes('mailto:' + WORK) && !html.includes(LOGIN));

  // ── 3. BOTH PREVIEWS SAY IT ───────────────────────────────────────────────
  OUT.push('', '-- the previews --');
  const Home = require(REPO + 'server/services/homeQueue.js');
  const home = await Home.buildHome(P, A, {});
  ok('Home returns the sending mailbox for the From row', home.from && home.from.address === WORK, home.from);
  const homeNone = await Home.buildHome(P, B, {});
  ok('  and says there is none for an agent without one', homeNone.from && homeNone.from.address === null && homeNone.from.connected === false, homeNone.from);
  const Closer = require(REPO + 'server/services/closer.js');
  const batch = await Closer.buildBatch(P, A, {});
  ok('the Closer batch review returns it too, on every path', batch.from && batch.from.address === WORK, [batch.from, batch.note]);

  const IDX = read('public/index.html');
  const src = IDX.slice(IDX.indexOf('function mailFromHtml(from) {'), IDX.indexOf('function hqEmailBody(c, i) {'));
  const ctx = { hqEscape: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(ctx); vm.runInContext(src + '; this.mailFromHtml = mailFromHtml;', ctx);
  const shown = ctx.mailFromHtml(mb), shownNone = ctx.mailFromHtml(none);
  ok('the From row shows the work address as a connected Gmail mailbox', shown.includes(WORK) && /your connected Gmail mailbox/.test(shown), shown);
  ok('  with no mailbox it says so, with a way to connect one', /No mailbox connected/.test(shownNone) && /Connect a mailbox/.test(shownNone), shownNone);
  ok('  and it never shows the login email', !shown.includes(LOGIN) && !shownNone.includes(LOGIN) && !/currentUser/.test(src));
  const disc = ctx.mailFromHtml({ address: WORK, connected: false, why: 'the mailbox is disconnected; reconnect it to send' });
  ok('  a disconnected mailbox is named with the problem and a Reconnect', disc.includes(WORK) && /disconnected/.test(disc) && /Reconnect/.test(disc));
  ok('the Home card and the batch review both render it', /'<dt>From<\/dt><dd>' \+ mailFromHtml\(HQ\.data && HQ\.data\.from\)/.test(IDX)
    && /<b>From:<\/b> ' \+ mailFromHtml\(_srBatch && _srBatch\.from\)/.test(IDX));

  // ── 3b. EVERY DOCUMENT A BUSINESS SEES ────────────────────────────────────
  OUT.push('', '-- decks, kits, contracts and reports --');
  const AB = require(REPO + 'server/services/agencyBrand.js');
  const u = (await P.query(`SELECT * FROM users WHERE id = $1`, [A])).rows[0];
  ok('the brand contact is the sending mailbox, not the signup email', (await AB.brandForUser(u)).contactEmail === WORK);
  ok('  an address typed into My Brand still wins (it is a deliberate choice)', (await AB.brandForUser({ ...u, agency_contact_email: 'deals@agency.test' })).contactEmail === 'deals@agency.test');
  ok('  and with no mailbox it falls back to the signup email', (await AB.brandForUser((await P.query(`SELECT * FROM users WHERE id = $1`, [B])).rows[0])).contactEmail === 'nomail@x.test');
  const IDXs = read('server/index.js');
  ok('every server caller that renders the brand loads the mailbox (brandForUser)',
    !/agencyBrand\.brandFor\((?!null)/.test(IDXs) && !/AB\.brandFor\(u\)/.test(IDXs) && !/agencyBrand'\)\.brandFor\(/.test(IDXs)
    && /brandForUser\(u\)/.test(read('server/services/deckGeneration.js')));
  ok('the report page\'s agent email is the brand contact, not users.email', /agent: \{ name: agent\?\.name, email: _agency\.contactEmail \|\| null \}/.test(IDXs));
  ok('the deck page no longer falls back to the login email in sessionStorage', !/agentEmailEl\.textContent = a\.email/.test(read('public/pitch.html')));
  ok('the contract form pre-fills the brand contact, not the login', /d\.shown && d\.shown\.contactEmail/.test(read('public/index.html'))
    && !/agentEmail\.value = currentUser \? \(currentUser\.email/.test(read('public/index.html')));

  // ── 3c. THE WEEKLY REPORT TO FAMILIES, AND THE CONTRACT ───────────────────
  OUT.push('', '-- the family report and the contract --');
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ds-ath-a', $1, '{"name":"Report Kid","school":"Auburn University"}'),
                 ('ds-ath-b', $2, '{"name":"Other Kid","school":"Auburn University"}') ON CONFLICT DO NOTHING`, [A, B]);
  const RPT = require(REPO + 'server/services/athleteReport.js');
  const since = new Date(Date.now() - 7 * 864e5).toISOString(), until = new Date().toISOString();
  const rA = await RPT.collectReportData('ds-ath-a', A, since, until);
  ok('a parent\'s reply goes to the mailbox the agent sends from, not the signup email', rA && rA.agent && rA.agent.email === WORK, rA && rA.agent);
  const rB = await RPT.collectReportData('ds-ath-b', B, since, until);
  ok('  and to the signup email only when no mailbox is connected', rB && rB.agent && rB.agent.email === 'nomail@x.test', rB && rB.agent);
  ok('  the send uses it as the reply-to', /replyTo: data\.agent\.email \|\| undefined/.test(read('server/index.js')));
  ok('the contract\'s agent party email falls back to the brand contact, not the login',
    /\(_contact && _contact\.contactEmail\) \|\| \(_me && _me\.email\) \|\| null/.test(read('server/index.js'))
    && /const _contact = _me \? \(await require\('\.\/services\/agencyBrand'\)\.brandForUser\(_me\)/.test(read('server/index.js')));

  // ── 4. DRAFTS ALREADY WRITTEN ─────────────────────────────────────────────
  OUT.push('', '-- drafts already signed with the login --');
  const old = `<div>Pitch.</div><div><br></div><div>Best,</div><div>Jamond Dubose</div>${FIX.sigLine(LOGIN)}`;
  ok('the rewrite swaps only the generated signature line', FIX.rewrite(old, LOGIN, WORK) === old.replace(FIX.sigLine(LOGIN), FIX.sigLine(WORK)));
  ok('  and leaves it when there is no mailbox (the signup email is the right fallback)', FIX.rewrite(old, LOGIN, null) === null);
  ok('  and leaves a body without that exact line alone', FIX.rewrite('<div>Email me at ' + LOGIN + '</div>', LOGIN, WORK) === null);
  const mk = (lid, status, sent) => P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_at)
    VALUES ($1, $2, 'ds-ath', 'Biz', 's', $3, $4, $5)`, [lid, A, old, status, sent]);
  await mk('ds-l1', 'draft', null); await mk('ds-l2', 'approved', null); await mk('ds-l3', 'sent', new Date());
  const env = { ...process.env, INIT_WAIT_MS: '6000' };
  const dry = execFileSync(process.execPath, [REPO + 'scripts/fix-draft-sender.js'], { env, encoding: 'utf8', timeout: 120000 });
  const bodies = async () => Object.fromEntries((await P.query(`SELECT id, body_html FROM outreach_logs WHERE agent_id = $1`, [A])).rows.map((r) => [r.id, r.body_html]));
  ok('report only: counts Jamond\'s two unsent drafts and changes nothing', /Jamond Dubose <jamond\.personal@gmail\.test>: 2 draft\(s\) \(1 awaiting approval, 1 approved not yet sent\) -> should say jamond@agency-work\.test/.test(dry)
    && Object.values(await bodies()).every((b) => b.includes(LOGIN)), dry);
  execFileSync(process.execPath, [REPO + 'scripts/fix-draft-sender.js', '--apply'], { env, encoding: 'utf8', timeout: 120000 });
  const after = await bodies();
  ok('--apply re-signs the unsent drafts with the work mailbox', after['ds-l1'].includes(WORK) && after['ds-l2'].includes(WORK) && !after['ds-l1'].includes(LOGIN));
  ok('  and never touches one already sent', after['ds-l3'].includes(LOGIN));
  ok('the admin runner has fix-draft-sender', /'fix-draft-sender': \{ file: 'scripts\/fix-draft-sender\.js'/.test(read('server/index.js')));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
