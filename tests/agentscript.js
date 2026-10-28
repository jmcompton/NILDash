'use strict';
// ── THE AGENT'S OWN SCRIPT (services/agentScript) ─────────────────────────────
// Local test Postgres. The model is a stand-in.
//
//   - save / get / clear, length limits, the on/off switch;
//   - the nightly writer reads it only for that agent, and only when on;
//   - the writer's prompt carries the script, with the rules still winning;
//   - "Improve it": parsed, tidied (no dashes, no exclamation marks), a price
//     refused, bad model output survives, the quick notes are plain words;
//   - the routes and the Settings card are wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('agentscripttest', { schema: true });
require('./helpers/offlineDns').install();

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const AS = require(REPO + 'server/services/agentScript.js');
const PW = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;

const MINE = `Hi [Owner],

I represent [Athlete], a [Position] at [School]. [Why it fits] I think there is a fun way to work together this season.

Would you be open to a quick call next week?

Thanks,
Ann`;

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await P().query(`INSERT INTO users (id, name, email, password, role) VALUES
    ('as-agent', 'Ann Agent', 'ann@agents.test', 'x', 'agent'),
    ('as-other', 'Otto Other', 'otto@agents.test', 'x', 'agent')`);

  // ── SAVE / GET ─────────────────────────────────────────────────────────
  OUT.push('-- save and read --');
  const empty = await AS.get(P(), 'as-agent');
  ok('no script yet: empty, on by default', empty.script === '' && empty.on === true);
  ok('no script: the writer gets nothing', (await AS.forAgent(P(), 'as-agent')) === null);
  const short = await AS.save(P(), 'as-agent', { script: 'Hi there' });
  ok('too short is refused in plain words', short.ok === false && /too short/.test(short.error));
  const long = await AS.save(P(), 'as-agent', { script: 'x'.repeat(AS.MAX_LEN + 1) });
  ok('too long is refused', long.ok === false && /under 2000/.test(long.error));
  const saved = await AS.save(P(), 'as-agent', { script: MINE + '\r\n\r\n\r\n' });
  ok('saves, trimmed', saved.ok === true && saved.script === MINE && saved.on === true && !!saved.updatedAt, saved);
  ok('the writer reads it for that agent', (await AS.forAgent(P(), 'as-agent')) === MINE);
  ok('and never for another agent', (await AS.forAgent(P(), 'as-other')) === null);
  await AS.save(P(), 'as-agent', { script: MINE, on: false });
  ok('switched off: kept, but the writer gets nothing', (await AS.get(P(), 'as-agent')).script === MINE
    && (await AS.forAgent(P(), 'as-agent')) === null);
  await AS.save(P(), 'as-agent', { script: MINE, on: true });
  ok('back on', (await AS.forAgent(P(), 'as-agent')) === MINE);
  await AS.save(P(), 'as-other', { script: '' });
  ok('an empty save clears it', (await AS.get(P(), 'as-other')).script === '' && (await AS.forAgent(P(), 'as-other')) === null);

  // ── THE QUICK NOTES ───────────────────────────────────────────────────
  OUT.push('-- notes --');
  ok('a clean script has no notes', AS.check(MINE).length === 0, AS.check(MINE));
  const bad = AS.check('Hi [Owner]! We would love $500 for two posts — let me know.');
  ok('a price is named', bad.some((x) => /price/.test(x)), bad);
  ok('dashes and exclamation marks are named', bad.some((x) => /dashes/.test(x)) && bad.some((x) => /exclamation/.test(x)), bad);
  ok('no question is named', bad.some((x) => /question/.test(x)), bad);

  // ── THE WRITER'S PROMPT ───────────────────────────────────────────────
  OUT.push('-- the writer --');
  const ctx = { business: { name: 'Smoothie Hut', category: 'cafe' }, athlete: { name: 'Jay Runner', school: 'Texas State', sport: 'Basketball' },
    agentFirstName: 'Ann', channel: 'email' };
  const plain = PW.buildPrompt(ctx);
  ok('no script: the prompt is unchanged', !/THE AGENT'S OWN SCRIPT/.test(plain));
  const withS = PW.buildPrompt({ ...ctx, agentScript: MINE });
  ok('with a script: the prompt carries it', /THE AGENT'S OWN SCRIPT/.test(withS) && withS.includes('I think there is a fun way to work together'));
  ok('the rules still win, and no blank may be left', /the rule wins/.test(withS) && /Never leave a bracket/.test(withS));
  ok('the script sits before the JSON instructions', withS.indexOf("THE AGENT'S OWN SCRIPT") < withS.indexOf('Return ONLY JSON'));
  // A bracket the model leaves behind never reaches a business (the placeholder backstop).
  ok('a leftover blank is dropped by the writer', !/\[Owner\]/.test(PW.autoRepair('Hi Dana,\nI represent [Athlete] here.\nWould you be open to a call?')));
  const OQ = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('both nightly writer calls pass the agent script', (OQ.match(/agentScript: await require\('\.\.\/services\/agentScript'\)\.forAgent\(pool, agentId\)/g) || []).length === 2);

  // ── IMPROVE IT ────────────────────────────────────────────────────────
  OUT.push('-- improve --');
  let seen = null;
  const good = await AS.improve(MINE, { agentFirst: 'Ann' }, { oneShot: async (p, sys, mt, model) => {
    seen = { p, sys, model };
    return '```json\n' + JSON.stringify({
      improved: 'Hi [Owner],\n\n[Athlete] plays [Position] at [School] and lives near [Business]! [Why it fits] — a quick idea.\n\nWould you be open to a short call next week?\n\nThanks,\nAnn',
      changes: ['Led with why it fits', 'Shorter ask'], ideas: ['Name a game day', 'Mention a menu item', 'Offer a time', 'one too many'],
    }) + '\n```';
  } });
  ok('improve returns a version, changes and up to three ideas', good.ok === true && good.changes.length === 2 && good.ideas.length === 3, good);
  ok('improved: no exclamation marks and no long dashes', !/[!—–]/.test(good.improved), good.improved);
  ok('improved: keeps the blanks for the writer', /\[Owner\]/.test(good.improved) && /\[Why it fits\]/.test(good.improved));
  ok('improve uses the writer model', seen && seen.model === 'claude-sonnet-4-6');
  ok('the prompt carries their script and the no-price rule', seen.p.includes('I think there is a fun way') && /Never name a price/.test(seen.p));
  const priced = await AS.improve(MINE, {}, { oneShot: async () => JSON.stringify({ improved: 'Hi [Owner], we charge $500 per post. Would you be open to it?', ideas: [] }) });
  ok('an edit that names a price is not offered', priced.ok === false && /price/.test(priced.error), priced);
  const junk = await AS.improve(MINE, {}, { oneShot: async () => 'sorry, no' });
  ok('bad model output: a plain error, no crash', junk.ok === false && /Try again/.test(junk.error));
  const thrown = await AS.improve(MINE, {}, { oneShot: async () => { throw new Error('529'); } });
  ok('a model failure: a plain error, no crash', thrown.ok === false && /Try again/.test(thrown.error));
  const tiny = await AS.improve('Hi', {}, { oneShot: async () => { throw new Error('should not be called'); } });
  ok('too short: refused before the model is called', tiny.ok === false && /Paste the whole message/.test(tiny.error));

  // ── WIRING ────────────────────────────────────────────────────────────
  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('routes: get, save, improve (signed in; improve rate-limited)',
    /app\.get\('\/api\/agent\/settings\/script', requireAuth/.test(IX)
    && /app\.post\('\/api\/agent\/settings\/script', requireAuth/.test(IX)
    && /app\.post\('\/api\/agent\/settings\/script\/improve', requireAuth, aiLimiter/.test(IX));
  const H = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the Settings card and its loader', /id="script-card"/.test(H) && /setTimeout\(loadScript, 60\)/.test(H)
    && /function improveScript\(/.test(H) && /function useImprovedScript\(/.test(H));
  ok('the card escapes what the model returns', /_scriptEsc\(c\)/.test(H));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
