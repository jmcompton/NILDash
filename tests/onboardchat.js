'use strict';
// Runs from a checkout on any machine against the local test Postgres. The
// assistant route is mounted on a throwaway express app with a fake session;
// the model (ai.toolLoop) and the web lookup are stubs, so no network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/onboardchat.js      just this one
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

// ── THE FIRST-LOGIN ASSISTANT ────────────────────────────────────────────────
//
// An agent with no athletes gets the assistant full screen instead of an
// empty dashboard. The opening is a fixed script sent without a model call;
// the turns after it carry the onboarding brief and three extra tools (look
// an athlete up, open the import, finish); the roster decides every turn;
// once an athlete exists the takeover never returns.

const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const actions = require(REPO + 'server/services/assistantActions.js');
const Onb = require(REPO + 'server/services/assistantOnboarding.js');
const router = require(REPO + 'server/routes/assistant.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'ob-agent-new', AG2 = 'ob-agent-has';

// The model stand-in: each turn runs the next script, which may call runTool.
const turns = [];
let scripts = [];
ai.toolLoop = async (o) => {
  turns.push(o);
  const s = scripts.shift();
  if (!s) return { text: 'ok', calls: [] };
  return s(o);
};
// The lookup stand-in: one candidate for Ann, nothing for anyone else.
actions._setLookupForTests({ resolveAthlete: async (_ai, q) => (/ann lee/i.test(q.name)
  ? { found: true, candidates: [{ name: 'Ann Lee', school: 'Auburn University', sport: 'softball', position: 'SS', year: 'Junior', confidence: 91, sourceLabel: 'ESPN' }], searchNote: 'Found on the Auburn roster.' }
  : { found: false, candidates: [], searchNote: 'Nothing matched.' }) });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    for (const t of ['assistant_messages', 'assistant_sessions', 'assistant_pending_actions']) await P().query(`DELETE FROM ${t} WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id IN ($1,$2)`, [AG, AG2]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'New Agent','ob-new@x.com','x','agent'), ($2,'Has Agent','ob-has@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG, AG2]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ob-ath-1',$1,$2::jsonb)`, [AG2, JSON.stringify({ name: 'Peyton Bair', sport: 'football', school: 'Auburn University' })]);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: req.headers['x-agent'] }; next(); });
  app.use('/api/assistant', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (path, body, agent) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': agent || AG }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ── 1. THE OPENING ───────────────────────────────────────────────────────
  OUT.push('-- the opening: a script, no model, three choices --');
  turns.length = 0;
  const s1 = await post('/api/assistant/session', { mode: 'onboarding' });
  ok('a new agent asking for onboarding gets it', s1.status === 200 && s1.body.onboarding === true, s1.body);
  ok('  the opening is the exact script', s1.body.messages.length === 1 && s1.body.messages[0].role === 'assistant' && s1.body.messages[0].content === Onb.OPENING);
  ok('  it begins "Welcome to NILDash" and ends with the question', /^Welcome to NILDash\. I'm going to get you set up in the next few minutes\./.test(Onb.OPENING) && /Which works best for you\?$/.test(Onb.OPENING));
  ok('  the three ways are the three chips', s1.body.choices.map((c) => c.label).join('|') === 'Look them up for me|Upload a spreadsheet|Enter one at a time');
  ok('  no model was called', turns.length === 0);
  const stored = (await P().query(`SELECT role, content FROM assistant_messages WHERE session_id = $1 ORDER BY id`, [s1.body.sessionId])).rows;
  ok('  the opening is stored as the first assistant message, so later turns read it', stored.length === 1 && stored[0].role === 'assistant' && stored[0].content === Onb.OPENING);
  const sid = s1.body.sessionId;

  turns.length = 0;
  const s2 = await post('/api/assistant/session', { mode: 'onboarding' }, AG2);
  ok('an agent WITH an athlete asking for onboarding is refused it: an ordinary greeting', s2.body.onboarding === false && turns.length === 1 && s2.body.messages[0].content === 'ok', s2.body);
  turns.length = 0;
  const s3 = await post('/api/assistant/session', {});
  ok('a new agent NOT asking for it gets the ordinary greeting (the bubble on other pages)', s3.body.onboarding === false && turns.length === 1);
  ok('applies: never an athlete principal, never an admin', !Onb.applies({ kind: 'athlete', id: 'x' }, { athletes: 0 }) && !Onb.applies({ kind: 'agent', id: 'x' }, { athletes: 0, role: 'admin' }) && Onb.applies({ kind: 'agent', id: 'x' }, { athletes: 0, role: 'agent' }) && !Onb.applies({ kind: 'agent', id: 'x' }, { athletes: 2, role: 'agent' }));

  // ── 2. A TURN: THE BRIEF AND THE TOOLS ───────────────────────────────────
  OUT.push('', '-- an onboarding turn: the brief, the tools, the lookup --');
  turns.length = 0;
  let toolOut = {};
  scripts = [async (o) => {
    toolOut.lookup = await o.runTool('lookup_athlete', { name: 'Ann Lee', school: 'Auburn University', sport: 'softball' });
    toolOut.nobody = await o.runTool('lookup_athlete', { name: 'Nobody Real' });
    return { text: 'I found Ann Lee, Auburn University softball, shortstop, junior. Add her?', calls: [] };
  }];
  const m1 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Look them up by name and school. Ann Lee at Auburn, softball.' });
  const t1 = turns[0];
  ok('the turn carries the onboarding brief, not the no_athletes offer', /ONBOARDING\. This agent has no athletes yet/.test(t1.system) && /THE LOOKUP WAY/.test(t1.system) && !/Offer to add their first one/.test(t1.system));
  ok('  and the knowledge base, so questions can be answered mid-flow', /KNOWLEDGE/.test(t1.system) && /WHAT NILDASH IS FOR/.test(t1.system) && /QUESTIONS\. If at any point they ask anything about NILDash/.test(t1.system));
  ok('  the three onboarding tools are offered, with the ordinary ones', ['lookup_athlete', 'open_import', 'finish_onboarding', 'add_athlete', 'look_up_data'].every((n) => t1.tools.some((t) => t.name === n)));
  ok('  the conversation opens on the first-login opener and carries the script', t1.messages[0].role === 'user' && /signed in for the first time/.test(t1.messages[0].content) && t1.messages[1].content === Onb.OPENING && /Ann Lee at Auburn/.test(t1.messages[t1.messages.length - 1].content));
  ok('  with the longer timeout a web lookup needs', t1.timeoutMs === 90000 && t1.maxRounds === 4, [t1.timeoutMs, t1.maxRounds]);
  ok('lookup_athlete returns the candidates to the model and the turn goes on', toolOut.lookup && !toolOut.lookup.stop && toolOut.lookup.result.found === true && toolOut.lookup.result.candidates[0].school === 'Auburn University' && toolOut.lookup.result.candidates[0].position === 'SS', toolOut.lookup);
  ok('  a miss is an answer, not an error', toolOut.nobody && toolOut.nobody.result.found === false && toolOut.nobody.result.candidates.length === 0);
  ok('  the reply comes back with the roster count and onboarding still on', m1.status === 200 && /Add her\?/.test(m1.body.reply) && m1.body.onboarding === true && m1.body.athletes === 0, m1.body);

  // ── 3. THE ADD, AND WHAT IT SAYS ─────────────────────────────────────────
  OUT.push('', '-- adding: the directive, the town, the 5 pitches line --');
  scripts = [async (o) => {
    toolOut.add = await o.runTool('add_athlete', { name: 'Ann Lee', sport: 'softball', school: 'Auburn University', position: 'SS', year: 'Junior' });
    return { text: 'Added. NILDash is already finding businesses near Auburn, Alabama. You will have 5 pitches ready tomorrow morning. Want to add another?', calls: [] };
  }];
  const m2 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Yes, add her.' });
  ok('add_athlete is a POST to the same endpoint the form uses, with the optional fields', m2.body.directives.length === 1 && m2.body.directives[0].kind === 'post' && m2.body.directives[0].url === '/api/athletes' && m2.body.directives[0].body.position === 'SS' && m2.body.directives[0].body.year === 'Junior' && m2.body.directives[0].then === 'reload_athletes', m2.body.directives);
  ok('  the tool result names the town and the 5 pitches, for the model to say', /already finding businesses near Auburn, Alabama/.test(toolOut.add.result.note) && /5 pitches ready tomorrow morning/.test(toolOut.add.result.note), toolOut.add);
  ok('  a pro is added by city and team, with no school', JSON.stringify(actions.ACTIONS.add_athlete.check({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY', team: 'NYCFC' }).args) === JSON.stringify({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY', team: 'NYCFC', school: '' }));
  ok('  and says the city', /near New York, NY/.test(actions.ACTIONS.add_athlete.say({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY' })));
  ok('  a college athlete still needs a school, a pro a city', /school is needed/.test(actions.ACTIONS.add_athlete.check({ name: 'X', sport: 'golf' }).error) && /city they play in/.test(actions.ACTIONS.add_athlete.check({ name: 'X', sport: 'golf', athleteType: 'pro' }).error));
  ok('  an unknown school is "near their school", never a guess', /near their school/.test(actions.ACTIONS.add_athlete.say({ name: 'X', sport: 'golf', athleteType: 'college', school: 'Nowhere Tech' })));

  // ── 4. THE FINISH, GUARDED BY THE REAL ROSTER ────────────────────────────
  OUT.push('', '-- finishing: refused on an empty roster, the plan on a real one --');
  scripts = [async (o) => { toolOut.finishEmpty = await o.runTool('finish_onboarding', {}); return { text: 'x', calls: [] }; }];
  const m3 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'I am done.' });
  ok('finish with no athlete on the roster is refused, whatever the model believes', toolOut.finishEmpty.result.refused === true && /no athlete on the roster/.test(toolOut.finishEmpty.result.reason) && m3.body.directives.length === 0, toolOut.finishEmpty);
  // The browser performed the POST: the athlete exists now.
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ob-ath-2',$1,$2::jsonb)`, [AG, JSON.stringify({ name: 'Ann Lee', sport: 'softball', school: 'Auburn University' })]);
  scripts = [async (o) => { toolOut.finish = await o.runTool('finish_onboarding', {}); return { text: 'Opening your dashboard.', calls: [] }; }];
  const m4 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'No, that is all for now.' });
  ok('with an athlete, finish returns the directive with the overnight plan', m4.body.directives.length === 1 && m4.body.directives[0].kind === 'finish_onboarding' && /finding local businesses near Ann Lee right now/.test(m4.body.directives[0].summary) && /Nothing sends until you approve it/.test(m4.body.directives[0].summary), m4.body.directives);
  ok('  the roster count says one, and the turn was still an onboarding turn (the page has not been handed over yet)', m4.body.athletes === 1 && m4.body.onboarding === true && /ONBOARDING\./.test(turns[turns.length - 1].system), m4.body);
  ok('summaryFor names one, two or several', /near Ann Lee right now/.test(Onb.summaryFor(['Ann Lee'])) && /near Ann Lee and Bob Ray right now/.test(Onb.summaryFor(['Ann Lee', 'Bob Ray'])) && /near A, B and C right now/.test(Onb.summaryFor(['A', 'B', 'C'])) && /near your athletes right now/.test(Onb.summaryFor([])));

  // ── 5. NEVER AGAIN, AND THE SPREADSHEET WAY ──────────────────────────────
  OUT.push('', '-- never again; the spreadsheet way --');
  turns.length = 0;
  const s4 = await post('/api/assistant/session', { mode: 'onboarding' });
  ok('once an athlete exists, a fresh session asking for onboarding gets the ordinary greeting', s4.body.onboarding === false && turns.length === 1 && turns[0].messages[0].content !== undefined, s4.body);
  ok('  and an ordinary turn does not offer the onboarding tools', (() => { scripts = []; return true; })() && actions.toolDefsFor('chat').every((t) => !actions.ONBOARDING_ONLY.has(t.name)) && actions.toolDefsFor('onboarding').some((t) => t.name === 'open_import'));
  scripts = [async (o) => { toolOut.imp = await o.runTool('open_import', {}); return { text: 'The import window is open.', calls: [] }; }];
  const m5 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Actually I will upload a spreadsheet.' });
  ok('open_import is a directive the page performs, and the model is told what to say', m5.body.directives[0] && m5.body.directives[0].kind === 'open_import' && /CSV or Excel/.test(toolOut.imp.result.note));

  // ── 6. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const cli = src('public/assistant.js'), idx = src('public/index.html'), srvs = src('server/index.js');
  ok('/api/auth/me carries the roster count', /athleteCount: await store\.pool\.query\('SELECT COUNT\(\*\)::int AS n FROM athletes WHERE agent_id=\$1'/.test(srvs));
  ok('the page asks for onboarding only for an agent with zero athletes', /onboarding: currentUser\.role === 'agent' && currentUser\.athleteCount === 0/.test(idx));
  ok('the takeover is the same panel, full screen, under the app\'s modals', /body\.na-onboarding #na-panel\{transform:none;width:100vw;left:0;right:0;z-index:150;/.test(cli) && /\.modal-overlay\{[^}]*z-index:200/.test(idx));
  ok('  with the tab hidden and no page shift', /body\.na-onboarding #na-tab\{display:none !important;\}/.test(cli) && /body\.na-onboarding \.main\{margin-right:0 !important;\}/.test(cli));
  ok('the session request says which mode, and the server\'s answer decides', /mode: NA\.onboarding \? 'onboarding' : undefined/.test(cli) && /if \(NA\.onboarding && !j\.onboarding\) \{\s*naLeaveOnboarding\(false\);/.test(cli));
  ok('the choices are chips that send their sentence', /naChips\(\(j\.choices \|\| \[\]\)\.map/.test(cli) && /if \(it\.onClick\) it\.onClick\(\); else naSendText\(it\.text \|\| it\.label\);/.test(cli));
  ok('open_import opens the app\'s own import and watches for it to land', /d\.kind === 'open_import'[\s\S]*?impOpen\(\); naWatchImport\(\);/.test(cli) && /naSendText\('\(The spreadsheet import has landed/.test(cli));
  ok('finish shows the plan, then Home with the roster reloaded', /d\.kind === 'finish_onboarding'[\s\S]*?naFinishOnboarding\(d\.summary/.test(cli) && /function naLeaveOnboarding\(toHome\)[\s\S]*?showView\('home', document\.getElementById\('homeNavBtn'\)\)/.test(cli));
  ok('  and Home already shows "Finding businesses" for an athlete being filled', /Finding businesses for '\s*\+ hqEscape/.test(idx) && /markFilling\(id\)/.test(srvs));
  ok('a failed start is never a dead end on first login', /Add an athlete the usual way instead/.test(cli) && /showView\('add-athlete', document\.getElementById\('addAthleteNavBtn'\)\)/.test(cli));
  ok('the import\'s "Go to roster" hands back to the assistant during onboarding', /if \(document\.body\.classList\.contains\('na-onboarding'\)\) \{\s*loadAthletes\(\)\.then\(function \(\) \{ try \{ window\.nilAssistant\.rosterChanged\(\); \}/.test(idx));

  srv.close();
  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
