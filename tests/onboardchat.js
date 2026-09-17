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
// The school lookup (services/schoolFind) behind add_athlete, faked: the two
// high schools below are "found" by Places in Hoover, AL; anything else the
// lists do not carry is not found, which is the one question for the city.
require(REPO + 'server/services/schoolFind.js')._setDepsForTests({
  lookupPlaceResult: async (q) => (/^(Hoover High School|Spain Park High)/.test(q)
    ? { ok: true, place: { name: q.replace(/,.*$/, ''), address: '1000 Buccaneer Dr, Hoover, AL 35244, USA', types: ['school', 'secondary_school'] } }
    : { ok: true, place: null, reason: 'not-found' }),
  searchLoop: async () => ({ text: '{"city":null}', results: [], searches: 1 }),
});
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
    await P().query(`DELETE FROM user_onboarding WHERE user_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
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
  ok('  with the longer timeout a web lookup needs, and rounds for several adds', t1.timeoutMs === 90000 && t1.maxRounds === 6, [t1.timeoutMs, t1.maxRounds]);
  ok('lookup_athlete returns the candidates to the model and the turn goes on', toolOut.lookup && !toolOut.lookup.stop && toolOut.lookup.result.found === true && toolOut.lookup.result.candidates[0].school === 'Auburn University' && toolOut.lookup.result.candidates[0].position === 'SS', toolOut.lookup);
  ok('  a miss is an answer, not an error', toolOut.nobody && toolOut.nobody.result.found === false && toolOut.nobody.result.candidates.length === 0);
  ok('  the reply comes back with the roster count and onboarding still on', m1.status === 200 && /Add her\?/.test(m1.body.reply) && m1.body.onboarding === true && m1.body.athletes === 0, m1.body);

  // ── 3. THE FINISH IS GUARDED BY THE REAL ROSTER ─────────────────────────
  OUT.push('', '-- finishing on an empty roster is refused, whatever the model believes --');
  scripts = [async (o) => { toolOut.finishEmpty = await o.runTool('finish_onboarding', {}); return { text: 'x', calls: [] }; }];
  const m3 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'I am done.' });
  ok('finish with no athlete on the roster is refused', toolOut.finishEmpty.result.refused === true && /no athlete on the roster/.test(toolOut.finishEmpty.result.reason) && m3.body.directives.length === 0, toolOut.finishEmpty);

  // ── 4. THE ADD: THE ROW EXISTS BEFORE THE MODEL IS TOLD ──────────────────
  OUT.push('', '-- adding: the row is saved on the server, the answer is what happened --');
  const AC = require(REPO + 'server/services/athleteCreate.js');
  AC._setFillNowForTests(false);   // never start a real fill from a test
  const rosterOf = async (agent) => (await P().query(`SELECT id, data FROM athletes WHERE agent_id=$1 ORDER BY created_at ASC`, [agent || AG])).rows;
  scripts = [async (o) => {
    toolOut.add = await o.runTool('add_athlete', { name: 'Ann Lee', sport: 'softball', school: 'Auburn University', position: 'SS', year: 'Junior' });
    // The model sees the row exists and says so.
    return { text: 'Added Ann Lee. Her pitches will be ready tomorrow morning. Who else?', calls: [] };
  }];
  const m2 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Yes, add her.' });
  let roster = await rosterOf();
  ok('add_athlete saves the athlete itself and answers added:true with the id', toolOut.add && !toolOut.add.stop && toolOut.add.result.added === true && roster.length === 1 && toolOut.add.result.id === roster[0].id, toolOut.add);
  ok('  with the optional fields the lookup returned', roster[0].data.position === 'SS' && roster[0].data.year === 'Junior' && roster[0].data.sport === 'softball' && roster[0].data.school === 'Auburn University', roster[0].data);
  ok('  the page is told to reload the roster, not to post anything', m2.body.directives.length === 1 && m2.body.directives[0].kind === 'reload_athletes' && m2.body.directives[0].athleteId === roster[0].id, m2.body.directives);
  ok('  the reply carries the roster count of one, still onboarding', m2.body.athletes === 1 && m2.body.onboarding === true, m2.body);
  ok('  with the fill flag off the note promises tomorrow, not "already finding"', /pitches will be ready tomorrow morning/.test(toolOut.add.result.note) && !/already finding/.test(toolOut.add.result.note), toolOut.add.result.note);
  AC._setFillNowForTests(true);
  ok('  with the fill flag on it says the town and that the search has started', /already finding businesses near Auburn, Alabama/.test(actions.ACTIONS.add_athlete.say({ name: 'Ann Lee', sport: 'softball', athleteType: 'college', school: 'Auburn University' })) && /5 pitches ready tomorrow morning/.test(actions.ACTIONS.add_athlete.say({ name: 'Ann Lee', sport: 'softball', athleteType: 'college', school: 'Auburn University' })));
  AC._setFillNowForTests(false);
  ok('  a pro is added by city and team, with no school', JSON.stringify(actions.ACTIONS.add_athlete.check({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY', team: 'NYCFC' }).args) === JSON.stringify({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY', team: 'NYCFC', school: '' }));
  ok('  and says the city', /near New York, NY/.test(actions.ACTIONS.add_athlete.say({ name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY' })));
  ok('  a college athlete still needs a school, a pro a city', /school is needed/.test(actions.ACTIONS.add_athlete.check({ name: 'X', sport: 'golf' }).error) && /city they play in/.test(actions.ACTIONS.add_athlete.check({ name: 'X', sport: 'golf', athleteType: 'pro' }).error));
  ok('  an unknown school is "near their school", never a guess', /near their school/.test(actions.ACTIONS.add_athlete.say({ name: 'X', sport: 'golf', athleteType: 'college', school: 'Nowhere Tech' })));
  ok('the route and the tool are the same function', /AthleteCreate\.createAthlete\(user, req\.body \|\| \{\}\)/.test(fs.readFileSync(REPO + 'server/index.js', 'utf8')) && /AC\.createAthlete\(user, body, \{ allowDuplicate/.test(fs.readFileSync(REPO + 'server/services/assistantActions.js', 'utf8')));

  // ── 5. DUPLICATES: A QUESTION, NOT A SECOND ROW ──────────────────────────
  OUT.push('', '-- duplicates: the roster is checked by name before a second row --');
  scripts = [async (o) => { toolOut.dup = await o.runTool('add_athlete', { name: 'ann  lee', sport: 'softball', school: 'Auburn University' }); return { text: 'Ann Lee is already on the roster. Add a second one?', calls: [] }; }];
  const m5 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Add Ann Lee, softball, Auburn' });
  roster = await rosterOf();
  ok('a same name (case and spacing folded) is a question to the agent, and no row', toolOut.dup.result.added === false && toolOut.dup.result.needs === 'duplicate_confirmation' && /Ann Lee is already on the roster \(softball, Auburn University\)\. Add a second ann  lee anyway\?/.test(toolOut.dup.result.ask) && roster.length === 1 && m5.body.directives.length === 0, toolOut.dup);
  ok('  the turn does not stop: the rest of a multi-athlete message is still worked', !toolOut.dup.stop);
  scripts = [async (o) => { toolOut.dup2 = await o.runTool('add_athlete', { name: 'Ann Lee', sport: 'softball', school: 'Auburn University', confirmDuplicate: true }); return { text: 'Added a second Ann Lee.', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Yes, add her anyway' });
  roster = await rosterOf();
  ok('  on a yes, confirmDuplicate adds the second row', toolOut.dup2.result.added === true && roster.length === 2, toolOut.dup2);
  await P().query(`DELETE FROM athletes WHERE id=$1`, [roster[1].id]);
  ok('findDuplicate matches the way the spreadsheet import matches', (await AC.findDuplicate(AG, "ANN LEE")) !== null && (await AC.findDuplicate(AG, 'Ann Lee.')) !== null && (await AC.findDuplicate(AG, 'Anne Lee')) === null && (await AC.findDuplicate(AG, 'Ann-Lee')) === null && (await AC.findDuplicate(AG2, 'Ann Lee')) === null);

  // ── 6. HIGH SCHOOL: THE DATE OF BIRTH IS ASKED FOR, SKIPPING IS ALLOWED ──
  OUT.push('', '-- high school athletes: welcome, asked for a date of birth --');
  ok('isHighSchool reads the name', ['Hoover High School', 'Mountain Brook HS', "St. Paul's Prep", 'Spain Park High', 'IMG Academy', 'Vestavia Hills Prep Academy'].every(AC.isHighSchool));
  ok('  and never a college, however it is called', !['Auburn University', 'Alabama', 'United States Naval Academy', 'Air Force Academy', 'Troy University', 'Samford'].some(AC.isHighSchool));
  scripts = [async (o) => { toolOut.hs = await o.runTool('add_athlete', { name: 'Cam Doe', sport: 'football', school: 'Hoover High School' }); return { text: 'What is Cam\'s date of birth?', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Cam Doe, football, Hoover High School' });
  roster = await rosterOf();
  ok('a high school athlete comes back as a question for the date of birth, and no row yet', toolOut.hs.result.added === false && toolOut.hs.result.needs === 'dob' && /Hoover High School looks like a high school\. What is Cam Doe's date of birth\?/.test(toolOut.hs.result.ask) && /say skip/.test(toolOut.hs.result.ask) && roster.length === 1, toolOut.hs);
  ok('  a date that is not a real past date is refused with the format', /YYYY-MM-DD/.test(actions.ACTIONS.add_athlete.check({ name: 'Cam Doe', sport: 'football', school: 'Hoover High School', dob: '13/40/2008' }).error) && /YYYY-MM-DD/.test(actions.ACTIONS.add_athlete.check({ name: 'Cam Doe', sport: 'football', school: 'Hoover High School', dob: '2099-01-01' }).error));
  scripts = [async (o) => { toolOut.hs2 = await o.runTool('add_athlete', { name: 'Cam Doe', sport: 'football', school: 'Hoover High School', dob: '2008-05-01' }); return { text: 'Added Cam Doe. Who else?', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: '2008-05-01' });
  roster = await rosterOf();
  const cam = roster.find((r) => r.data.name === 'Cam Doe');
  ok('  with the date, the athlete is saved and the date is on the record for the compliance gate', toolOut.hs2.result.added === true && cam && cam.data.dob === '2008-05-01' && cam.data.school === 'Hoover High School', cam && cam.data);
  scripts = [async (o) => { toolOut.hs3 = await o.runTool('add_athlete', { name: 'Dee Roe', sport: 'soccer', school: 'Spain Park High', dobUnknown: true }); return { text: 'Added Dee Roe with age unknown. Who else?', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'skip' });
  roster = await rosterOf();
  const dee = roster.find((r) => r.data.name === 'Dee Roe');
  ok('  skipping adds them with age unknown, and the note says what that holds', toolOut.hs3.result.added === true && dee && dee.data.dob === '' && /Age is unknown, so age-restricted businesses are held/.test(toolOut.hs3.result.note), toolOut.hs3);
  ok('  a college athlete is never asked', (await actions.ACTIONS.add_athlete.check({ name: 'Ann Lee', sport: 'softball', school: 'Auburn University' })).args.dob === undefined && !AC.isHighSchool('Auburn University'));

  // ── 7. THE REAL REASON WHEN A SAVE FAILS ─────────────────────────────────
  OUT.push('', '-- a refused save says why, in words --');
  await P().query(`UPDATE users SET seat_override = 1 WHERE id=$1`, [AG]);
  scripts = [async (o) => { toolOut.seat = await o.runTool('add_athlete', { name: 'Zed Zee', sport: 'golf', school: 'Troy University' }); return { text: 'The roster is full.', calls: [] }; }];
  const m7 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Zed Zee, golf, Troy' });
  await P().query(`UPDATE users SET seat_override = NULL WHERE id=$1`, [AG]);
  roster = await rosterOf();
  ok('the seat limit comes back as added:false with the limit message, and no row', toolOut.seat.result.added === false && /athlete limit \(1\)/.test(toolOut.seat.result.error) && toolOut.seat.result.code === 'SEAT_LIMIT_REACHED' && roster.length === 3 && m7.body.directives.length === 0, toolOut.seat);
  ok('  the reply is the model\'s sentence, not "Done."', m7.body.reply === 'The roster is full.', m7.body.reply);
  // Back to a roster of one for the finish.
  await P().query(`DELETE FROM athletes WHERE agent_id=$1 AND id <> $2`, [AG, roster[0].id]);

  // ── 8. THE FINISH, AND THE FLAG ──────────────────────────────────────────
  OUT.push('', '-- finishing: the plan on a real roster, recorded on the account --');
  AC._setFillNowForTests(true);
  scripts = [async (o) => { toolOut.finish = await o.runTool('finish_onboarding', {}); return { text: 'Opening your dashboard.', calls: [] }; }];
  const m4 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Nobody else, that is all for now.' });
  AC._setFillNowForTests(false);
  ok('with an athlete, finish returns the directive with the overnight plan', m4.body.directives.length === 1 && m4.body.directives[0].kind === 'finish_onboarding' && /finding local businesses near Ann Lee right now/.test(m4.body.directives[0].summary) && /Nothing sends until you approve it/.test(m4.body.directives[0].summary), m4.body.directives);
  ok('  the roster count says one, and the turn was still an onboarding turn (the page has not been handed over yet)', m4.body.athletes === 1 && m4.body.onboarding === true && /ONBOARDING\./.test(turns[turns.length - 1].system), m4.body);
  await new Promise((r) => setTimeout(r, 200));
  ok('  the account is marked onboarded by the server as well as by the page', (await P().query(`SELECT onboarding_completed FROM users WHERE id=$1`, [AG])).rows[0].onboarding_completed === true);
  ok('summaryFor names one, two or several', /near Ann Lee right now/.test(Onb.summaryFor(['Ann Lee'])) && /near Ann Lee and Bob Ray right now/.test(Onb.summaryFor(['Ann Lee', 'Bob Ray'])) && /near A, B and C right now/.test(Onb.summaryFor(['A', 'B', 'C'])) && /near your athletes right now/.test(Onb.summaryFor([])));
  ok('  and says tonight, not right now, when the fill flag is off', /^Here is what happens next\. Tonight NILDash finds local businesses near Ann Lee, researches each one/.test(Onb.summaryFor(['Ann Lee'], { fillingNow: false })) && !/right now/.test(Onb.summaryFor(['Ann Lee'], { fillingNow: false })));

  // ── 9. NEVER AGAIN; THE RELOAD BEFORE THE FINISH; THE SPREADSHEET WAY ────
  OUT.push('', '-- never again; a reload after an add shows the plan once; the spreadsheet way --');
  turns.length = 0;
  const s4 = await post('/api/assistant/session', { mode: 'onboarding' });
  ok('once an athlete exists and the flow is finished, a fresh session gets the ordinary greeting', s4.body.onboarding === false && !s4.body.finishSummary && turns.length === 1 && turns[0].messages[0].content !== undefined, s4.body);
  await P().query(`UPDATE users SET onboarding_completed = false WHERE id=$1`, [AG]);
  turns.length = 0;
  const s5 = await post('/api/assistant/session', {});
  ok('added an athlete, closed the tab, came back: the plan is the greeting, no model call', s5.body.finishSummary === true && s5.body.onboarding === false && s5.body.autoOpen === true && /^Here is what happens next\. Tonight NILDash finds local businesses near Ann Lee/.test(s5.body.messages[0].content) && turns.length === 0, s5.body);
  ok('  and the account is now marked onboarded, so it shows once', (await P().query(`SELECT onboarding_completed FROM users WHERE id=$1`, [AG])).rows[0].onboarding_completed === true);
  turns.length = 0;
  const s6 = await post('/api/assistant/session', {});
  ok('  the next session is ordinary', !s6.body.finishSummary && turns.length === 1, s6.body);
  turns.length = 0;
  const s7 = await post('/api/assistant/session', {}, AG2);
  ok('an agent from before the chatbot (athletes, no opening on file, flag false) is never shown the plan', !s7.body.finishSummary && turns.length === 1, s7.body);
  ok('  and an ordinary turn does not offer the onboarding tools', (() => { scripts = []; return true; })() && actions.toolDefsFor('chat').every((t) => !actions.ONBOARDING_ONLY.has(t.name)) && actions.toolDefsFor('onboarding').some((t) => t.name === 'open_import'));
  scripts = [async (o) => { toolOut.imp = await o.runTool('open_import', {}); return { text: 'The import window is open.', calls: [] }; }];
  const m6 = await post('/api/assistant/message', { sessionId: sid, mode: 'onboarding', text: 'Actually I will upload a spreadsheet.' });
  ok('open_import is a directive the page performs, and the model is told what to say', m6.body.directives[0] && m6.body.directives[0].kind === 'open_import' && /CSV or Excel/.test(toolOut.imp.result.note));

  // ── 10. THE WIRING ───────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const cli = src('public/assistant.js'), idx = src('public/index.html'), srvs = src('server/index.js');
  ok('/api/auth/me carries the roster count', /athleteCount: await store\.pool\.query\('SELECT COUNT\(\*\)::int AS n FROM athletes WHERE agent_id=\$1'/.test(srvs));
  ok('the page asks for onboarding only for an agent with zero athletes', /onboarding: currentUser\.role === 'agent' && currentUser\.athleteCount === 0/.test(idx));
  ok('the takeover is the same panel, full screen, under the app\'s modals', /body\.na-onboarding #na-panel\{transform:none;width:100vw;left:0;right:0;z-index:150;/.test(cli) && /\.modal-overlay\{[^}]*z-index:200/.test(idx));
  ok('  with the tab hidden and no page shift', /body\.na-onboarding #na-tab\{display:none !important;\}/.test(cli) && /body\.na-onboarding \.main\{margin-right:0 !important;\}/.test(cli));
  ok('THE OLD WIZARD NEVER SHOWS OVER THE CHATBOT: zero athletes means the assistant only', /async function checkOnboarding\(\) \{[\s\S]*?if \(document\.body\.classList\.contains\('na-onboarding'\)\) return;\s*if \(currentUser && currentUser\.role === 'agent' && currentUser\.athleteCount === 0\) return;[\s\S]*?onboardingOverlay/.test(idx));
  ok('  the Getting Started checklist is untouched', /NILOnboard\.refreshChecklist/.test(idx) && fs.existsSync(REPO + 'public/onboarding.js'));
  ok('the session request says which mode, and the server\'s answer decides', /mode: NA\.onboarding \? 'onboarding' : undefined/.test(cli) && /if \(NA\.onboarding && !j\.onboarding\) \{\s*naLeaveOnboarding\(false\);/.test(cli));
  ok('the choices are chips that send their sentence', /naChips\(\(j\.choices \|\| \[\]\)\.map/.test(cli) && /if \(it\.onClick\) it\.onClick\(\); else naSendText\(it\.text \|\| it\.label\);/.test(cli));
  ok('the page reloads the roster on add_athlete\'s directive and posts nothing itself', /d\.kind === 'reload_athletes'[\s\S]*?loadAthletes\(\)[\s\S]*?naRosterChanged\(\);/.test(cli));
  ok('open_import opens the app\'s own import and watches for it to land', /d\.kind === 'open_import'[\s\S]*?impOpen\(\); naWatchImport\(\);/.test(cli) && /naSendText\('\(The spreadsheet import has landed/.test(cli));
  ok('  and tells the model, once, when the window closed with nothing imported', /NA\.importClosedTold = true;[\s\S]*?naSendText\('\(The import window was closed without importing anything\.\)', \{ silent: true \}\)/.test(cli) && /import window was closed with nothing imported, ask which of the three ways/.test(Onb.BRIEF));
  ok('finish shows the plan, calls onboarding-complete, then Home with the roster reloaded', /function naFinishOnboarding\(summary\)[\s\S]*?fetch\(naBase\(\) \+ '\/api\/agent\/onboarding-complete', \{ method: 'POST'/.test(cli) && /d\.kind === 'finish_onboarding'[\s\S]*?naFinishOnboarding\(d\.summary/.test(cli) && /function naLeaveOnboarding\(toHome\)[\s\S]*?showView\('home', document\.getElementById\('homeNavBtn'\)\)/.test(cli));
  ok('  and the resumed plan opens the panel even when auto-open is off', /else if \(j\.finishSummary\) \{[\s\S]*?naRevealOwed\(\);/.test(cli) && /function naRevealOwed\(\) \{\s*if \(!NA\.open\) naOpen\(\);/.test(cli));
  ok('the indicator says "Searching, this takes about 20 seconds" on the lookup path', /NA\.lookupPath = true;/.test(cli) && /w\.textContent = 'Searching, this takes about 20 seconds';/.test(cli) && /if \(searching\) clearTimeout\(searching\);/.test(cli));
  ok('  and Home already shows "Finding businesses" for an athlete being filled', /Finding businesses for '\s*\+ hqEscape/.test(idx) && /markFilling\(id\)/.test(src('server/services/athleteCreate.js')));
  ok('a failed start is never a dead end on first login', /Add an athlete the usual way instead/.test(cli) && /showView\('add-athlete', document\.getElementById\('addAthleteNavBtn'\)\)/.test(cli));
  ok('the import\'s "Go to roster" hands back to the assistant during onboarding', /if \(document\.body\.classList\.contains\('na-onboarding'\)\) \{\s*loadAthletes\(\)\.then\(function \(\) \{ try \{ window\.nilAssistant\.rosterChanged\(\); \}/.test(idx));
  ok('the brief: three fields in one message, no position question, "Who else?", several at once, the answers of add_athlete', /"Ann Lee, softball, Auburn"/.test(Onb.BRIEF) && /Do not ask for position or class year/.test(Onb.BRIEF) && /ask "Who else\?"/.test(Onb.BRIEF) && /SEVERAL AT ONCE/.test(Onb.BRIEF) && /dobUnknown true/.test(Onb.BRIEF) && /confirmDuplicate true/.test(Onb.BRIEF) && /Never say an athlete has been added until add_athlete has returned added:true/.test(Onb.BRIEF));
  ok('the knowledge base no longer reads as college-only', /It is not college-only\. An athlete can be a college athlete, a professional, or a high\s+school athlete/.test(t1.system) && /A pro's local lane is the city they play in\. A high school athlete's is their school's town\./.test(t1.system));
  ok('the pitch writer was not touched', !/pitchWriter/.test(src('server/services/athleteCreate.js')) && !/pitchWriter/.test(src('server/services/assistantActions.js')));

  srv.close();
  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
