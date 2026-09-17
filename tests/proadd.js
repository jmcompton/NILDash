'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/proadd.js           just this one
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

// ── ADDING A PRO THROUGH THE CHAT: NAME AND TEAM ARE ENOUGH ────────────────
//
// "Add Bo Nix the QB for the Denver Broncos" came back "the tool came back
// with an error I did not expect". The tool's check required the city as
// "City, ST" for a pro and returned an error when the model passed the team
// without it. Now a pro team named anywhere in the call (in team, or in
// school when the model treated it as one) means pro, and the team supplies
// the city and the sport (services/proTeams). NFL, NBA and MLB players are
// added by name and team through the same route the chat uses.

const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const actions = require(REPO + 'server/services/assistantActions.js');
const PT = require(REPO + 'server/services/proTeams.js');
require(REPO + 'server/services/schoolFind.js')._setDepsForTests({
  lookupPlaceResult: async () => ({ ok: true, place: null, reason: 'not-found' }),
  searchLoop: async () => ({ text: '{"city":null}', results: [], searches: 1 }),
});
const router = require(REPO + 'server/routes/assistant.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const P = () => store.pool;
const AG = 'pa-agent-1';

const turns = [];
let scripts = [];
ai.toolLoop = async (o) => { turns.push(o); const s = scripts.shift(); return s ? s(o) : { text: 'ok', calls: [] }; };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    for (const t of ['assistant_messages', 'assistant_sessions', 'assistant_pending_actions']) await P().query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Pro Agent','pa@x.com','x','agent')`, [AG]);
  const AC = require(REPO + 'server/services/athleteCreate.js');
  AC._setFillNowForTests(false);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: AG }; next(); });
  app.use('/api/assistant', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const roster = async () => (await P().query(`SELECT id, data FROM athletes WHERE agent_id=$1 ORDER BY created_at ASC`, [AG])).rows;
  const s = await post('/api/assistant/session', {});
  const sid = s.body.sessionId;

  OUT.push('-- the error: a pro without a typed city --');
  const chk = actions.ACTIONS.add_athlete.check;
  ok('the old check errored on a pro whose team was given but not the city; now the team supplies the city', chk({ name: 'Bo Nix', sport: 'football', athleteType: 'pro', team: 'Denver Broncos' }).args && chk({ name: 'Bo Nix', sport: 'football', athleteType: 'pro', team: 'Denver Broncos' }).args.city === 'Denver, CO');
  ok('  a pro with no team and no city is asked for the city in plain words, with the way out', /Which city does Bo Nix play in, as "City, ST"\? Or name the team/.test(chk({ name: 'Bo Nix', sport: 'football', athleteType: 'pro' }).error || ''));
  ok('  a team the table does not carry still asks for the city rather than guessing', /Which city/.test(chk({ name: 'X Y', sport: 'football', athleteType: 'pro', team: 'Wichita Wind Surge' }).error || ''));

  OUT.push('', '-- a pro team means a pro --');
  const c1 = chk({ name: 'Bo Nix', sport: 'football', position: 'QB', athleteType: 'college', school: 'Denver Broncos' });
  ok('a team passed as the school is read as a pro team: athleteType pro, school blank, team and city set', c1.args && c1.args.athleteType === 'pro' && c1.args.school === '' && c1.args.team === 'Denver Broncos' && c1.args.city === 'Denver, CO', c1);
  const c2 = chk({ name: 'Nikola Jokic', team: 'the Nuggets' });
  ok('  the sport comes from the team when the model left it out ("the Nuggets" -> basketball, Denver, CO)', c2.args && c2.args.sport === 'basketball' && c2.args.team === 'Denver Nuggets' && c2.args.city === 'Denver, CO', c2);
  ok('  a typed city wins over the team\'s', chk({ name: 'X', athleteType: 'pro', team: 'Denver Broncos', city: 'Englewood, CO' }).args.city === 'Englewood, CO');
  ok('a college athlete is unchanged', (() => { const c = chk({ name: 'Ann Lee', sport: 'softball', school: 'Auburn University' }); return c.args && c.args.athleteType === 'college' && c.args.school === 'Auburn University' && !c.args.team; })());
  ok('  a school that shares a word with a team is never a team ("Union College", "Kansas City Kansas Community College", "Sun Belt Academy")', PT.findTeam('Union College') === null && PT.findTeam('Kansas City Kansas Community College') === null && PT.findTeam('Sun Belt Academy') === null && chk({ name: 'A B', sport: 'soccer', school: 'Union College' }).args.athleteType === 'college');
  ok('the team table: every NFL, NBA, WNBA, MLB, NHL and MLS club, with a city and a two-letter code', PT.TEAMS.length >= 165 && PT.TEAMS.every((t) => t.name && t.city && /^[A-Z]{2}$/.test(t.state) && t.league && t.sport) && PT.TEAMS.filter((t) => t.league === 'NFL').length === 32 && PT.TEAMS.filter((t) => t.league === 'NBA').length === 30 && PT.TEAMS.filter((t) => t.league === 'MLB').length === 30 && PT.TEAMS.filter((t) => t.league === 'NHL').length === 32);
  ok('  full name, "the Nickname", nickname alone and a name inside a sentence all resolve', ['Denver Broncos', 'the Broncos', 'Broncos', 'Bo Nix the QB for the Denver Broncos'].every((q) => (PT.findTeam(q) || {}).market === 'Denver, CO'));
  ok('  a nickname two teams share needs the city ("Rangers" alone is nobody; "Texas Rangers" is Arlington)', PT.findTeam('Rangers') === null && PT.findTeam('Texas Rangers').market === 'Arlington, TX' && PT.findTeam('New York Rangers').league === 'NHL');
  ok('  two-word nicknames', PT.findTeam('Trail Blazers').name === 'Portland Trail Blazers' && PT.findTeam('Red Sox').name === 'Boston Red Sox');

  OUT.push('', '-- through the chat: NFL, NBA, MLB by name and team --');
  let out = {};
  scripts = [async (o) => { out.nfl = await o.runTool('add_athlete', { name: 'Bo Nix', sport: 'football', position: 'QB', athleteType: 'pro', team: 'Denver Broncos' }); return { text: 'Added Bo Nix, Denver Broncos QB. Who else?', calls: [] }; }];
  const m1 = await post('/api/assistant/message', { sessionId: sid, text: 'Add Bo Nix the QB for the Denver Broncos on my roster' });
  let r = await roster();
  const nix = r.find((x) => x.data.name === 'Bo Nix');
  ok('NFL: Bo Nix is added as a pro on the Broncos in Denver, CO, no school, no error', out.nfl.result.added === true && nix && nix.data.athleteType === 'pro' && nix.data.team === 'Denver Broncos' && nix.data.city === 'Denver, CO' && nix.data.school === '' && nix.data.position === 'QB' && m1.status === 200, { res: out.nfl.result, data: nix && nix.data });
  ok('  the tool\'s note says Denver, not "their school"', /Denver, CO/.test(out.nfl.result.note) && !/their school/.test(out.nfl.result.note), out.nfl.result.note);

  scripts = [async (o) => { out.nba = await o.runTool('add_athlete', { name: 'Nikola Jokic', sport: 'basketball', athleteType: 'college', school: 'Denver Nuggets' }); return { text: 'Added Nikola Jokic. Who else?', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, text: 'Add Nikola Jokic, center for the Denver Nuggets' });
  r = await roster();
  const jok = r.find((x) => x.data.name === 'Nikola Jokic');
  ok('NBA: the model marked him college with the team as the school; he is saved as a pro on the Nuggets in Denver, CO', out.nba.result.added === true && jok && jok.data.athleteType === 'pro' && jok.data.team === 'Denver Nuggets' && jok.data.city === 'Denver, CO' && jok.data.school === '', { res: out.nba.result, data: jok && jok.data });

  scripts = [async (o) => { out.mlb = await o.runTool('add_athlete', { name: 'Aaron Judge', athleteType: 'pro', team: 'Yankees' }); return { text: 'Added Aaron Judge. Who else?', calls: [] }; }];
  await post('/api/assistant/message', { sessionId: sid, text: 'Add Aaron Judge from the Yankees' });
  r = await roster();
  const judge = r.find((x) => x.data.name === 'Aaron Judge');
  ok('MLB: name and "Yankees" alone: sport baseball, New York Yankees, New York, NY', out.mlb.result.added === true && judge && judge.data.athleteType === 'pro' && judge.data.sport === 'baseball' && judge.data.team === 'New York Yankees' && judge.data.city === 'New York, NY', { res: out.mlb.result, data: judge && judge.data });
  ok('none of the three was asked for a school, a class year or a date of birth', [out.nfl, out.nba, out.mlb].every((t) => !t.result.needs && !t.result.error));

  OUT.push('', '-- the prompt: a pro team means pro, and a failure is said plainly --');
  const prompt = src('server/services/assistantPrompt.js');
  ok('the rule: a pro team anywhere in the message means athleteType pro, team set, never a school', /A PRO TEAM MEANS A PRO/.test(prompt) && /Never ask a pro for a school, a class year or a date of birth/.test(prompt) && /the tool works the city out from the\s+team/.test(prompt));
  ok('  when a tool fails: plain words, what to do instead, never "an error I did not expect", never flag-to-the-team first', /WHEN A TOOL FAILS/.test(prompt) && /Never say "an error I did not expect"/.test(prompt) && /Never offer\s+to flag it to the NILDash team as your first move/.test(prompt) && /Add Client page/.test(prompt));
  ok('  the tool descriptions say the same', /A pro team named anywhere in the message[^']*means pro; never ask a pro for a school/.test(src('server/services/assistantActions.js')) && /the tool works the city out from the team/.test(src('server/services/assistantActions.js')));
  ok('  the knowledge base says a pro is added by name and team', /A PRO IS ADDED BY NAME AND TEAM/.test(src('server/services/assistantKnowledge.js')) && /Denver, CO/.test(src('server/services/assistantKnowledge.js')));

  await clean();
  srv.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch(async (e) => { console.error('proadd: FAILED', e); try { await P().end(); } catch (_) {} process.exit(1); });
