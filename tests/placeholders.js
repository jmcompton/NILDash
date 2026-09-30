'use strict';
// Runs against the local test Postgres (the audit part).
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/placeholders.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A MISSING VALUE DROPS THE LINE, NEVER PRINTS THE VARIABLE ───────────────
// A DM reached the queue reading "https://www.instagram.com/[athlete_handle]".
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const PH = require(REPO + 'server/services/placeholders.js');
const W = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

async function main() {
  OUT.push('-- what counts as a placeholder --');
  const slots = ['https://www.instagram.com/[athlete_handle]', 'Hi {{first_name}},', 'Hi {first_name},', 'Thanks, [Your Name]',
    '<ATHLETE_NAME> plays at Auburn', 'ATHLETE_HANDLE', 'INSERT LINK', 'We love [Business Name]'];
  ok(`each is found (${slots.length})`, slots.every((s) => PH.has(s)), slots.filter((s) => !PH.has(s)));
  const fine = ['See [1] for more', '[our deck](https://x.test/deck)', 'He is 6 < 7 > 5', 'Q&A at 5pm', 'Price [$500]', 'I said [sic]',
    'https://instagram.com/marcus.j', 'Marcus plays for the Auburn Tigers.'];
  ok(`and none of these is (${fine.length})`, fine.every((s) => !PH.has(s)), fine.filter((s) => PH.has(s)).map((s) => [s, PH.find(s)]));

  OUT.push('', '-- the line goes, the message stays --');
  const dm = 'Hi Dave,\nMarcus is a receiver at Auburn with 12,000 followers.\nWould you be open to a post?\n\nhttps://www.instagram.com/[athlete_handle]\n\nJohn';
  const r = PH.dropLines(dm);
  ok('the placeholder line is dropped and nothing else', !/\[/.test(r.text) && /Would you be open/.test(r.text) && /\nJohn$/.test(r.text) && r.dropped.length === 1, r);
  const h = PH.dropLinesHtml('<p>Hi Dave,</p><p>Marcus plays at Auburn.</p><p>https://www.instagram.com/[athlete_handle]</p><p>John</p>');
  ok('  in HTML too, block by block', h.html === '<p>Hi Dave,</p><p>Marcus plays at Auburn.</p><p>John</p>', h);
  ok('the writer repairs it before judging it', !/\[athlete_handle\]/.test(W.autoRepair(dm))
    && /require\('\.\/placeholders'\)\.dropLines/.test(read('server/services/pitchWriter.js')));
  ok('  and a placeholder that survives is a lint failure, retried or refused', /contains a placeholder where a value should be/.test(read('server/services/pitchWriter.js'))
    && W.lintMessage('Hi Dave,\nMarcus plays at Auburn. Hi [Name]. Would you post? Thanks for reading. Talk soon.\n\nJohn').problems.some((p) => /placeholder/.test(p)));

  OUT.push('', '-- the cause: the prompt no longer asks for a link it does not have --');
  const PW = read('server/services/pitchWriter.js');
  ok('the output format asks for the Instagram link only when there is one',
    /\$\{ctx\.athlete && ctx\.athlete\.instagramHandle \? 'the Instagram link on its own line, ' : ''\}signed off/.test(PW)
    && !/"four to five sentences in the prescribed order, the Instagram link on its own line, signed off"/.test(PW));
  ok('  and with no handle it says so, and forbids a placeholder', /There is NO Instagram link for this athlete\. Do not write a link, a handle, or any placeholder/.test(PW));

  OUT.push('', '-- the backstops --');
  const JOB = read('server/jobs/outreachQueue.js');
  const ins = JOB.indexOf('async function insertCard(');
  ok('every card save drops placeholder lines from the DM and the email body', JOB.indexOf("require('../services/placeholders')", ins) - ins < 900
    && /for \(const f of \['dmText', 'emailBody'\]\)/.test(JOB));
  ok('  and refuses a subject that holds one', /subject held a placeholder; not written/.test(JOB));
  ok('university asks too', /require\('\.\/placeholders'\)/.test(read('server/services/teamScan.js')));

  // ── THE AUDIT ─────────────────────────────────────────────────────────────
  OUT.push('', '-- the audit over drafts already stored --');
  await new Promise((res) => setTimeout(res, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const AG = 'ph-agent', ATH = 'ph-ath';
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Ph Agent','ph@x.test','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,'{"name":"Ph Athlete"}')`, [ATH, AG]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, dm_text) VALUES
    ($1,$2,81,'ph-a','Ph Cafe','queued',$3), ($1,$2,82,'ph-b','Ph Gym','queued','Hi Sam,\nClean message.\n\nJo')`,
    [AG, ATH, dm]);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status) VALUES
    ('ph-log-1',$1,$2,'Ph Cafe','Marcus x Ph Cafe','<p>Hi Dave,</p><p>https://www.instagram.com/[athlete_handle]</p><p>John</p>','draft'),
    ('ph-log-2',$1,$2,'Ph Gym','Hi [Name]','<p>Hi Sam,</p><p>Fine.</p>','approved')`, [AG, ATH]);
  const env = { ...process.env, INIT_WAIT_MS: '6000' };
  const dry = execFileSync(process.execPath, [REPO + 'scripts/placeholder-audit.js'], { env, encoding: 'utf8', timeout: 120000 });
  ok('the report counts the card, the body and the subject', /card DM\s+\d+\s+Ph Agent \/ Ph Athlete -> Ph Cafe: \[athlete_handle\]/.test(dry)
    && /email draft body\s+ph-log-1/.test(dry) && /email draft subject\s+ph-log-2 .*\[Name\].*report only/.test(dry), dry.slice(0, 900));
  ok('  report only changes nothing', (await P.query(`SELECT dm_text FROM outreach_queue WHERE agent_id = $1 AND slot = 81`, [AG])).rows[0].dm_text === dm);
  execFileSync(process.execPath, [REPO + 'scripts/placeholder-audit.js', '--apply'], { env, encoding: 'utf8', timeout: 120000 });
  const card = (await P.query(`SELECT dm_text FROM outreach_queue WHERE agent_id = $1 AND slot = 81`, [AG])).rows[0].dm_text;
  const body = (await P.query(`SELECT body_html FROM outreach_logs WHERE id = 'ph-log-1'`)).rows[0].body_html;
  ok('--apply removes the lines from the card and the draft body', !/\[athlete_handle\]/.test(card) && /Would you be open/.test(card)
    && body === '<p>Hi Dave,</p><p>John</p>', [card, body]);
  ok('the admin runner has it', /'placeholder-audit': \{ file: 'scripts\/placeholder-audit\.js'/.test(read('server/index.js')));
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
