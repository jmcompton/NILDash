'use strict';
// Runs from a checkout on any machine against the local test Postgres. The
// assistant route is mounted on a throwaway express app with a fake session;
// the model (ai.toolLoop) is a stub, so no network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/assistantui.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const express = require('express');

// ── THE ASSISTANT DOES THE WORK AND BRINGS IT HERE ──────────────────────────
//
// Three things Jamond hit: it could not say which email providers connect
// and could not start one; it said "I'll let you know" about a scan it can
// never come back to; and "ok thanks" ran the scan again. And one rule under
// all of them: a page, tab or setting is a button, never directions.

const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const actions = require(REPO + 'server/services/assistantActions.js');
const ctxSvc = require(REPO + 'server/services/assistantContext.js');
const { systemPrompt } = require(REPO + 'server/services/assistantPrompt.js');
const { KNOWLEDGE } = require(REPO + 'server/services/assistantKnowledge.js');
const router = require(REPO + 'server/routes/assistant.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'ui-agent';
const turns = [];
let scripts = [];
ai.toolLoop = async (o) => { turns.push(o); const s = scripts.shift(); return s ? s(o) : { text: 'ok', calls: [] }; };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  for (const t of ['assistant_messages', 'assistant_sessions', 'assistant_pending_actions']) await P().query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Ui Agent','ui@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ui-ath-1',$1,$2::jsonb)`, [AG, JSON.stringify({ name: 'Jamond Reed', sport: 'football', school: 'Auburn University' })]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: req.headers['x-agent'] || AG }; next(); });
  app.use('/api/assistant', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': AG }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const ses = { agentId: AG, principal: { kind: 'agent', id: AG }, session: {} };

  // ── 1. EMAIL PROVIDERS ───────────────────────────────────────────────────
  OUT.push('-- which mailboxes connect, and a button to start one --');
  const prov = ctxSvc.emailProvidersAvailable();
  ok('the context reads the three doors from the provider modules', typeof prov.gmail === 'boolean' && typeof prov.outlook === 'boolean' && typeof prov.imap === 'boolean', prov);
  const line = ctxSvc.emailProvidersLine({ gmail: true, outlook: false, imap: true });
  ok('  and the block says each plainly', line === 'Gmail and Google Workspace YES; Outlook / Microsoft 365 NO; any other mailbox by IMAP/SMTP YES', line);
  const block = ctxSvc.contextBlock({ agentName: 'A', athletes: 1, scans: 0, sent: 0, replies: 0, pipeline: 0, gmailConnected: false, roster: [], emailProviders: { gmail: true, outlook: true, imap: false } }, 'no_scans');
  ok('  on the AGENT SITUATION block', /Email providers this NILDash can connect right now: Gmail and Google Workspace YES; Outlook \/ Microsoft 365 YES; any other mailbox by IMAP\/SMTP NO/.test(block));
  ok('the knowledge base answers Gmail, Google Workspace, Outlook / Microsoft 365 and IMAP, and says the block decides', /CONNECTING EMAIL/.test(KNOWLEDGE) && /Google Workspace/.test(KNOWLEDGE) && /Outlook \/ Microsoft 365/.test(KNOWLEDGE) && /IMAP\/SMTP/.test(KNOWLEDGE) && /Email providers this NILDash can connect/.test(KNOWLEDGE) && /offer to start it with a button/.test(KNOWLEDGE));
  const ce = await actions.resolveCall('connect_email', { provider: 'outlook' }, ses);
  ok('connect_email starts the Outlook door', ce.ok && ce.directive.kind === 'connect_email' && ce.directive.provider === 'outlook' && /Microsoft/.test(ce.say), ce);
  ok('  and refuses a provider it does not have', (await actions.resolveCall('connect_email', { provider: 'yahoo' }, ses)).ok === false);
  const btn = await actions.resolveCall('offer_button', { label: 'Connect Gmail', kind: 'connect_email', provider: 'gmail' }, ses);
  ok('offer_button hands the page a button that starts the connection', btn.ok && btn.directive.kind === 'button' && btn.directive.label === 'Connect Gmail' && btn.directive.action.kind === 'connect_email' && btn.directive.action.provider === 'gmail', btn);
  ok('the page opens the provider\'s door and checks Outlook is switched on first', /d\.kind === 'connect_gmail' \|\| d\.kind === 'connect_email'/.test(src('public/assistant.js')) && /'\/api\/email\/oauth\/' \+ provider \+ '\?returnTo='/.test(src('public/assistant.js')) && /probe\.status === 501/.test(src('public/assistant.js')));
  ok('the Outlook door exists on the server and says what it needs', /router\.get\('\/oauth\/outlook'/.test(src('server/routes/email.js')) && /OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET/.test(src('server/routes/email.js')));

  // ── 2. PAGES ARE BUTTONS ─────────────────────────────────────────────────
  OUT.push('', '-- a page, a tab or a setting is a button --');
  const tab = await actions.resolveCall('offer_button', { label: 'Open Settings', kind: 'tab', tab: 'settings' }, ses);
  ok('a tab button', tab.ok && tab.directive.action.kind === 'open_tab' && tab.directive.action.tab === 'settings' && tab.say === null, tab);
  ok('  an unknown tab is refused', (await actions.resolveCall('offer_button', { label: 'x', kind: 'tab', tab: 'billing' }, ses)).ok === false);
  const ds = await actions.resolveCall('offer_button', { label: 'Open Deal Scan', kind: 'deal_scan', athleteId: 'ui-ath-1' }, ses);
  ok('a Deal Scan button carries the athlete', ds.ok && ds.directive.action.kind === 'open_deal_scan' && ds.directive.action.athleteId === 'ui-ath-1', ds);
  const sys = systemPrompt({ contextBlock: block, brief: 'b', suppressed: [], toolsEnabled: true, lean: false });
  ok('the prompt: pages are buttons, never directions', /PAGES ARE BUTTONS\. Whenever you mention a page, a tab or a setting, call offer_button/.test(sys) && /Never describe where to click/.test(sys) && /You do the\s+work and bring the result here/.test(sys));
  ok('  the knowledge base says the same', /PAGES ARE BUTTONS\. When you mention a page, a tab or a setting, the agent gets a\s+button/.test(KNOWLEDGE));
  ok('the page draws the button and performs its action on click', /function naButtons\(items\)/.test(src('public/assistant.js')) && /b\.addEventListener\('click', function \(\) \{ if \(it\.action\) naPerform\(\[it\.action\]\); \}\);/.test(src('public/assistant.js')) && /d\.kind === 'button'/.test(src('public/assistant.js')));
  ok('  and Open Deal Scan selects the athlete on the Deal Scan tab', /window\.nilOpenDealScanFor = async function \(athleteId\)/.test(src('public/index.html')) && /d\.kind === 'open_deal_scan'/.test(src('public/assistant.js')));
  ok('offer_button is offered on ordinary turns', actions.toolDefsFor('chat').some((t) => t.name === 'offer_button') && actions.toolDefsFor('chat').some((t) => t.name === 'connect_email'));

  // ── 3. THE DEAL SCAN, IN THE CHAT ────────────────────────────────────────
  OUT.push('', '-- the scan: waited for, shown, a button, a next step; never "I\'ll let you know" --');
  ok('the prompt: it cannot message later, and says only "Scanning now, about a minute."', /YOU CANNOT MESSAGE THE AGENT LATER/.test(sys) && /Never say you will let them know, follow up, check back or get back to them/.test(sys) && /say only "Scanning now, about a minute\."/.test(sys));
  ok('  the tool says the same and never "let you know"', /say only "Scanning now, about a minute\." Never say you will let them know/.test(actions.ACTIONS.run_deal_scan.description));
  const cli = src('public/assistant.js');
  const blk = cli.slice(cli.indexOf("d.kind === 'run_deal_scan'"), cli.indexOf("d.kind === 'lookup_program'"));
  ok('the page waits for the scan under "Scanning, about a minute"', /naRunning\('Scanning, about a minute'\)/.test(blk) && /await window\.nilRunDealScanFor\(d\.athleteId\); scanOk = true;/.test(blk) && /await naScanFinished\(d\.athleteId, scanOk, scanErr\);/.test(blk));
  ok('  then shows the top 3 to 5 with name, town, why and the owner', /results\.slice\(0, 5\)/.test(cli) && /naScanTown\(d\)/.test(cli) && /d\.rationale \|\| d\.reason \|\| d\.why/.test(cli) && /naScanOwner\(d\)/.test(cli) && /'Deal Scan for ' \+ name \+ ': top '/.test(cli));
  ok('  waits for the owner names to load, a little', /function naWaitContacts\(list, ms\)/.test(cli) && /await naWaitContacts\(top, 8000\)/.test(cli));
  ok('  an Open Deal Scan button and the one next line', /naButtons\(\[\{ label: 'Open Deal Scan', action: \{ kind: 'open_deal_scan', athleteId: athleteId \} \}\]\)/.test(cli) && /naSay\('assistant', 'Want me to draft pitches for any of these\?'\)/.test(cli));
  ok('  a failure or an empty scan is said plainly with a Try again chip', /'The scan did not finish'/.test(cli) && /found nothing new for/.test(cli) && /naChips\(\[\{ label: 'Try again', text: 'Run the deal scan again for '/.test(cli));
  ok('  the model is told what the agent saw, without a turn', /function naRecordNote\(text\)/.test(cli) && /'\/api\/assistant\/note'/.test(cli) && /do not repeat the list/.test(cli));
  const s1 = await post('/api/assistant/session', {});
  const n1 = await post('/api/assistant/note', { sessionId: s1.body.sessionId, text: 'The deal scan for Jamond Reed finished: 1. Maxie Bakery (Auburn, AL).' });
  const stored = (await P().query(`SELECT role, content FROM assistant_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 1`, [s1.body.sessionId])).rows[0];
  ok('POST /note records the note as the agent\'s side, in parentheses, no model call', n1.status === 200 && stored.role === 'user' && stored.content === '(The deal scan for Jamond Reed finished: 1. Maxie Bakery (Auburn, AL).)' && turns.length === 1, stored);

  // ── 4. "ok", "thanks", "ok thanks" ───────────────────────────────────────
  OUT.push('', '-- an acknowledgement is not a request --');
  turns.length = 0;
  for (const t of ['ok', 'OK', 'thanks', 'ok thanks', 'Thank you!', 'cool, thanks', 'got it', 'k']) {
    const r = await post('/api/assistant/message', { sessionId: s1.body.sessionId, text: t });
    ok(`"${t}" gets a few words back and no turn, no tool`, r.status === 200 && r.body.ack === true && r.body.directives.length === 0 && r.body.reply.length < 60 && turns.length === 0, r.body);
  }
  const r2 = await post('/api/assistant/message', { sessionId: s1.body.sessionId, text: 'ok thanks' });
  ok('  "ok thanks" is answered as thanks', /You're welcome/.test(r2.body.reply), r2.body.reply);
  scripts = [async () => ({ text: 'Scanning now, about a minute.', calls: [] })];
  const r3 = await post('/api/assistant/message', { sessionId: s1.body.sessionId, text: 'ok run the scan for Jamond' });
  ok('  a request that starts with ok still reaches the model', turns.length === 1 && r3.body.ack === undefined, r3.body);
  ok('the prompt says a bare ok is not a request', /A BARE "ok", "thanks" or "ok thanks" is not a request/.test(sys));

  srv.close();
  for (const t of ['assistant_messages', 'assistant_sessions', 'assistant_pending_actions']) await P().query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
