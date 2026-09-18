'use strict';
// Runs from a checkout on any machine against the local test Postgres. Resend
// is replaced by a stub that records what would have gone out.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/nightlydigest.js    just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── "YOUR ATHLETES HAVE NEW PITCHES READY", ONCE PER AGENT PER NIGHT ────────
//
// Sent the moment an agent's overnight fill finishes, only when at least one
// athlete got a new card, only once per night, never to an unsubscribed
// agent, never to a dormant agent the fill skipped. One line, one row per
// athlete with new cards, one footer line.

const store = require(REPO + 'server/store.js');
const D = require(REPO + 'server/services/nightlyDigest.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'nd-agent', AG2 = 'nd-unsub', NIGHT = '2099-03-01';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM nightly_digest_sends WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id IN ($1,$2)`, [AG, AG2]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Chris Sample','nd-agent@x.com','x','agent'), ($2,'No Mail','nd-unsub@x.com','x','agent')`, [AG, AG2]);
  await P().query(`UPDATE users SET digest_unsubscribed = TRUE WHERE id = $1`, [AG2]);
  const mk = (id, agent, data) => P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3)`, [id, agent, data]);
  await mk('nd-a1', AG, { name: 'Peyton Bair', sport: 'football', school: 'Auburn University' });
  await mk('nd-a2', AG, { name: 'Max Murray', sport: 'soccer', athleteType: 'pro', city: 'New York, NY', team: 'New York City FC' });
  await mk('nd-a3', AG, { name: 'Ella Boerger', sport: 'ice hockey', school: 'University of St. Thomas' });
  await mk('nd-a4', AG, { name: 'Quiet Night', sport: 'golf', school: 'Wofford College' });
  await mk('nd-b1', AG2, { name: 'Un Sub', sport: 'golf', school: 'Brown University' });

  const details = [
    { athleteId: 'nd-a1', athleteName: 'Peyton Bair', filled: 3, open: 3, tried: [] },
    { athleteId: 'nd-a2', athleteName: 'Max Murray', filled: 1, open: 2, tried: [] },
    { athleteId: 'nd-a3', athleteName: 'Ella Boerger', filled: 2, open: 2, tried: [] },
    { athleteId: 'nd-a4', athleteName: 'Quiet Night', filled: 0, open: 3, tried: [], note: '4 businesses tried, none passed the bar' },
  ];

  // ── 1. THE ROWS ──────────────────────────────────────────────────────────
  OUT.push('-- the rows --');
  const rows = await D.rowsFor(P(), AG, details);
  ok('only athletes with new cards that night, most first', JSON.stringify(rows.map((r) => [r.name, r.count])) === JSON.stringify([['Peyton Bair', 3], ['Ella Boerger', 2], ['Max Murray', 1]]), rows);
  ok('  a college athlete shows the school', rows.find((r) => r.name === 'Peyton Bair').place === 'Auburn University');
  ok('  a pro shows the city', rows.find((r) => r.name === 'Max Murray').place === 'New York, NY');
  ok('  an athlete with 0 new cards is not a row', !rows.some((r) => r.name === 'Quiet Night'));
  ok('an empty night has no rows', (await D.rowsFor(P(), AG, [{ athleteId: 'nd-a4', filled: 0 }])).length === 0);

  // ── 2. THE EMAIL ─────────────────────────────────────────────────────────
  OUT.push('', '-- the email --');
  const m = D.render({ rows, reviewUrl: 'https://mynildash.com/', unsubUrl: 'https://mynildash.com/api/digest/unsubscribe?token=t' });
  ok('subject: the count and the date, so no two nights are the same email', /^6 pitches ready, \w{3} \w{3} \d{1,2}$/.test(m.subject), m.subject);
  ok('the one line at the top', m.html.includes("NILDash found new opportunities for your athletes last night. Here&#39;s what&#39;s ready.") || m.html.includes("NILDash found new opportunities for your athletes last night. Here's what's ready."));
  ok('  and it is the first thing in the body after the preheader', m.html.indexOf('NILDash found new opportunities') < m.html.indexOf('Peyton Bair'));
  ok('one row per athlete: name, school or city, count, Review link to the dashboard', (m.html.match(/>Review<\/a>/g) || []).length === 3 && (m.html.match(/href="https:\/\/mynildash\.com\/"/g) || []).length === 3 && /Peyton Bair[\s\S]*Auburn University[\s\S]*3 new pitches/.test(m.html) && /Max Murray[\s\S]*New York, NY[\s\S]*1 new pitch</.test(m.html));
  ok('the single footer line', m.html.includes('Pitches expire in 14 days. NILDash refills automatically each night.') && (m.html.match(/Pitches expire in 14 days/g) || []).length === 1);
  ok('plain: no header banner, no logo image, no marketing or feature copy', !/<img/i.test(m.html) && !/<h1|<h2/i.test(m.html) && !/upgrade|new feature|introducing|learn more|pro plan/i.test(m.html));
  ok('mobile friendly: viewport meta, one 560px table, no fixed widths wider than a phone', /viewport/.test(m.html) && /max-width:560px/.test(m.html) && !/width="6\d\d"|width:7\d\dpx/.test(m.html));
  ok('the unsubscribe link is present and small', /Unsubscribe from these emails/.test(m.html) && m.html.indexOf('Unsubscribe') > m.html.indexOf('Pitches expire'));
  ok('the text alternative carries the same three lines', /NILDash found new opportunities/.test(m.text) && /Peyton Bair \(Auburn University\): 3 new pitches\. Review: https:\/\/mynildash\.com\//.test(m.text) && /Pitches expire in 14 days/.test(m.text));
  ok('names are escaped', /&lt;b&gt;/.test(D.render({ rows: [{ name: '<b>x</b>', place: '', count: 1 }], reviewUrl: 'u', unsubUrl: '' }).html));

  // ── 3. THE SEND, ONCE ────────────────────────────────────────────────────
  OUT.push('', '-- the send --');
  const sent = [];
  const send = async (msg) => { sent.push(msg); return { data: { id: 'resend-1' } }; };
  const r1 = await D.sendForRun(P(), { agentId: AG, runDate: NIGHT, details }, { send });
  ok('sent to the agent', r1.sent === true && sent.length === 1 && sent[0].to === 'nd-agent@x.com', r1);
  ok('  from the address every other NILDash email uses', sent[0].from === 'NILDash <noreply@mynildash.com>', sent[0].from);
  ok('  with the one-click unsubscribe headers', /List-Unsubscribe/.test(JSON.stringify(sent[0].headers)) && /api\/digest\/unsubscribe\?token=/.test(sent[0].headers['List-Unsubscribe']));
  ok('  counted: 3 athletes, 6 cards', r1.athletes === 3 && r1.cards === 6, r1);
  const log = (await P().query(`SELECT * FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = $2`, [AG, NIGHT])).rows[0];
  ok('logged in nightly_digest_sends: agent, night, athletes, cards, sent', log && log.status === 'sent' && log.cards === 6 && log.provider_id === 'resend-1' && Array.isArray(log.athletes) && log.athletes.length === 3 && log.athletes[0].name === 'Peyton Bair' && log.email === 'nd-agent@x.com' && log.sent_at, log);
  const r2 = await D.sendForRun(P(), { agentId: AG, runDate: NIGHT, details }, { send });
  ok('the same night again: not sent', r2.sent === false && /already sent tonight/.test(r2.reason) && sent.length === 1, r2);
  const r3 = await D.sendForRun(P(), { agentId: AG, runDate: '2099-03-02', details }, { send });
  ok('a new night: sent again', r3.sent === true && sent.length === 2);
  const r4 = await D.sendForRun(P(), { agentId: AG, runDate: '2099-03-03', details: [{ athleteId: 'nd-a4', filled: 0 }] }, { send });
  ok('zero new cards: not sent, nothing logged', r4.sent === false && r4.reason === 'no new cards' && sent.length === 2 && (await P().query(`SELECT COUNT(*)::int n FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2099-03-03'`, [AG])).rows[0].n === 0);
  const r5 = await D.sendForRun(P(), { agentId: AG2, runDate: NIGHT, details: [{ athleteId: 'nd-b1', filled: 2 }] }, { send });
  ok('an unsubscribed agent: not sent, nothing logged', r5.sent === false && r5.reason === 'unsubscribed' && sent.length === 2 && (await P().query(`SELECT COUNT(*)::int n FROM nightly_digest_sends WHERE agent_id = $1`, [AG2])).rows[0].n === 0, r5);
  const failing = async () => { throw new Error('Resend down'); };
  // ── THE ALLOWLIST: one inbox verifies a night before customers see it ──
  process.env.NIGHTLY_DIGEST_ALLOWLIST = ' JohnMarkCompton@gmail.com , other@x.com ';
  const before = sent.length;
  const r5a = await D.sendForRun(P(), { agentId: AG, runDate: '2099-03-10', details }, { send });
  ok('an agent not on NIGHTLY_DIGEST_ALLOWLIST: held, not sent, nothing recorded', r5a.sent === false && r5a.reason === 'not on NIGHTLY_DIGEST_ALLOWLIST' && sent.length === before && (await P().query(`SELECT COUNT(*)::int n FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2099-03-10'`, [AG])).rows[0].n === 0, r5a);
  ok('  the list is case- and space-insensitive', D.allowed('johnmarkcompton@gmail.com') && D.allowed('OTHER@X.COM') && !D.allowed('nd-agent@x.com'));
  process.env.NIGHTLY_DIGEST_ALLOWLIST = 'nd-agent@x.com';
  const r5b = await D.sendForRun(P(), { agentId: AG, runDate: '2099-03-10', details }, { send });
  ok('  an agent on the list is sent to, and the held night sends once the list allows it', r5b.sent === true && sent.length === before + 1 && sent[sent.length - 1].to === 'nd-agent@x.com', r5b);
  process.env.NIGHTLY_DIGEST_ALLOWLIST = '  ';
  ok('  a blank list means everyone', D.allowlist() === null && D.allowed('anyone@x.com'));
  delete process.env.NIGHTLY_DIGEST_ALLOWLIST;
  ok('  unset means everyone', D.allowlist() === null && D.allowed('anyone@x.com'));

  const r6 = await D.sendForRun(P(), { agentId: AG, runDate: '2099-03-04', details }, { send: failing });
  const flog = (await P().query(`SELECT status, error FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2099-03-04'`, [AG])).rows[0];
  ok('a failed send is logged as failed with the error, and the fill is not affected', r6.sent === false && flog && flog.status === 'failed' && /Resend down/.test(flog.error), flog);

  // ── 4. WHEN IT FIRES ─────────────────────────────────────────────────────
  OUT.push('', '-- when --');
  const job = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  const hook = job.slice(job.indexOf('async function fillAgent('), job.indexOf('const INACTIVE_AFTER_DAYS'));
  ok('the digest is called at the end of fillAgent, after the run row is written', /UPDATE outreach_queue_runs SET filled = \$3, spent_usd = \$4, details = \$5, finished_at = NOW\(\)[\s\S]*?sendForRun\(pool, \{ agentId: agent\.id, runDate, details \}\)/.test(hook));
  ok('  only when the fill placed something, never in a dry run', /if \(filled > 0 && !opts\.noDigest\) \{/.test(hook) && hook.indexOf('if (!dry) {') < hook.indexOf('sendForRun'));
  ok('  a digest failure cannot fail the fill', /catch \(e\) \{ console\.error\(`\[nightly-digest\] agent=/.test(hook));
  ok('a dormant agent is skipped before fillAgent, so never digested', /const why = inactiveSkip\(a, opts\.now\);[\s\S]*?continue;[\s\S]*?const r = await fillAgent\(pool, a, opts\)/.test(job));
  ok('the on-demand path (fillAthlete) does not send it', !/sendForRun/.test(job.slice(job.indexOf('async function fillOnDemand('), job.indexOf('async function loadAthletesForQueue'))));
  ok('the table is created once with the once-per-night constraint', /CREATE TABLE IF NOT EXISTS nightly_digest_sends \([\s\S]*?UNIQUE \(agent_id, run_date\)/.test(fs.readFileSync(REPO + 'server/store.js', 'utf8')));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
