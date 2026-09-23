'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable Postgres
// settings, and a startup wait the runner can shorten once the schema is up.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/signalscope.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── TWO AGENTS AT ONE SCHOOL ────────────────────────────────────────────────
//
// scout.schoolSponsorSignals filtered on the school alone. Auburn University is
// not one agent's private fact: any number of agencies carry Auburn athletes,
// and every one of them shared these rows.
//
// So the second agent's nightly slate inherited the first agent's book. Not as
// an abstraction -- as a +18 ranking boost and as a sentence written onto the
// card in sponsor_note, in the second person:
//
//   "you have already closed a deal with them at Auburn University"
//
// handed to an agent who had closed nothing, on a card built to be read out to
// a business owner. And 'replied-at-school' is worse than false, because it is
// TRUE about somebody else: brand_engagement 'responded' is written by
// followUpAutomation.markReplied from reply capture over a connected Gmail or
// Outlook mailbox. services/brandFlags.js already refuses to cross agents with
// that data and says why -- "showing a second agent a badge derived from the
// first agent's inbox is a disclosure of the first agent's mail, however small
// the badge". This file holds scout.js to the same rule.
//
// The fixture is the whole point: ONE school, TWO agents, one athlete each, and
// every signal source populated for agent A only. B must see nothing of A's.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const S = require(ROOT + 'server/services/scout.js');
const fs = require('fs');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const SCHOOL = 'Signalscope State University';
const A = 'ss-agent-a', B = 'ss-agent-b';
const ATH_A = 'ss-ath-a', ATH_B = 'ss-ath-b';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const wipe = async () => {
    for (const t of ['brand_engagement', 'deals', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => {});
    }
    await P.query(`DELETE FROM deal_comps WHERE school = $1`, [SCHOOL]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [[A, B]]).catch(() => {});
  };
  await wipe();

  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES
    ($1,'Agent A','ss-a@x.com','x','agent'), ($2,'Agent B','ss-b@x.com','x','agent')`, [A, B]);
  // One school. Two agents. One athlete each.
  for (const [id, ag, name] of [[ATH_A, A, 'A Athlete'], [ATH_B, B, 'B Athlete']]) {
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
      [id, ag, JSON.stringify({ name, school: SCHOOL })]);
  }

  // ── EVERYTHING BELOW BELONGS TO AGENT A ────────────────────────────────
  // A closed a deal with Kessler Auto.
  await P.query(`INSERT INTO deals (id, agent_id, athlete_id, data) VALUES
    ('ss-d1',$1,$2,'{"stage":"Closed","brand":"Kessler Auto"}'::jsonb)`, [A, ATH_A]);
  // A business answered A -- over A's connected mailbox.
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'ss-k1','Reply Cafe','responded')`, [A, ATH_A]);
  // And one closed for A.
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'ss-k2','Closed Diner','closed')`, [A, ATH_A]);
  // Public press, belonging to nobody.
  await P.query(`INSERT INTO deal_comps (sport, school, brand, deal_value, source, auto_ingested)
                 VALUES ('Football',$1,'Press Collective',50000,'https://news.example/x',true)`, [SCHOOL]);

  const sigA = await S.schoolSponsorSignals(P, SCHOOL, { agentId: A });
  const sigB = await S.schoolSponsorSignals(P, SCHOOL, { agentId: B });

  OUT.push('-- agent A sees their own book --');
  ok('A sees the deal A closed', sigA.get('kessler auto')
    && sigA.get('kessler auto').kind === 'agent-closed-at-school', sigA.get('kessler auto'));
  ok('  and the business that replied to A', sigA.get('reply cafe')
    && sigA.get('reply cafe').kind === 'replied-at-school', sigA.get('reply cafe'));
  ok('  and the one that closed for A', sigA.get('closed diner')
    && sigA.get('closed diner').kind === 'replied-at-school', sigA.get('closed diner'));

  OUT.push('', '-- AGENT B SEES NONE OF IT --');
  ok('B DOES NOT INHERIT A\'S CLOSED DEAL', !sigB.has('kessler auto'), [...sigB.keys()]);
  ok('B DOES NOT INHERIT A\'S REPLY, which came out of A\'s mailbox',
    !sigB.has('reply cafe'), [...sigB.keys()]);
  ok('  nor the brand that closed for A', !sigB.has('closed diner'), [...sigB.keys()]);
  // The sentence is the reason this matters: it is second person, and it is
  // rendered onto a card the agent reads out to a business owner.
  ok('  so B is never told "you have already closed a deal" about A\'s deal',
    ![...sigB.values()].some((v) => /you have already closed/.test(v.detail || '')),
    [...sigB.values()].map((v) => v.detail));

  OUT.push('', '-- public press is shared, because it belongs to nobody --');
  ok('both agents see the publicly reported deal',
    sigA.get('press collective') && sigB.get('press collective'), [[...sigA.keys()], [...sigB.keys()]]);
  ok('  labelled a report for both', sigB.get('press collective').kind === 'reported-deal-at-school',
    sigB.get('press collective'));
  ok('  and it is the ONLY thing B sees', sigB.size === 1, [...sigB.keys()]);

  // ── OUR OWN CLOSE IS STILL NOT LAUNDERED INTO PUBLIC EVIDENCE ──────────
  // saveComp writes source='agent-close'. It must not come back as "the market
  // says so" for A, and it must not reach B at all.
  await P.query(`INSERT INTO deal_comps (sport, school, brand, deal_value, source)
                 VALUES ('Football',$1,'Laundered Brand',9000,'  Agent-Close  ')`, [SCHOOL]);
  const sigA2 = await S.schoolSponsorSignals(P, SCHOOL, { agentId: A });
  const sigB2 = await S.schoolSponsorSignals(P, SCHOOL, { agentId: B });
  ok('an agent-close comp is not a public report, whatever its casing or padding',
    !sigA2.has('laundered brand') && !sigB2.has('laundered brand'),
    [[...sigA2.keys()], [...sigB2.keys()]]);

  // ── NO AGENT, NO SIGNALS ───────────────────────────────────────────────
  // The failure mode this guards is a future caller that forgets the option and
  // silently gets every agent's history back, which is exactly what the bug was.
  OUT.push('', '-- it fails closed --');
  ok('NO agentId RETURNS NOTHING, rather than everyone\'s',
    (await S.schoolSponsorSignals(P, SCHOOL)).size === 0);
  ok('  an empty-string agentId too', (await S.schoolSponsorSignals(P, SCHOOL, { agentId: '' })).size === 0);
  ok('  and a whitespace one', (await S.schoolSponsorSignals(P, SCHOOL, { agentId: '   ' })).size === 0);
  ok('an unknown agent gets only the public row',
    (await S.schoolSponsorSignals(P, SCHOOL, { agentId: 'ss-nobody' })).size === 1);

  // ── THE SLATE PASSES THE AGENT THROUGH ─────────────────────────────────
  // Scoping the function is only half of it: assembleSlate has to hand it the
  // agent it was called for. Read off the source, because the slate's own
  // signal count is the thing that would silently go to zero.
  OUT.push('', '-- the slate hands the agent down --');
  const SRC = fs.readFileSync(ROOT + 'server/services/scout.js', 'utf8');
  ok('assembleSlate calls it WITH the agent',
    /schoolSponsorSignals\(pool, athlete\.school, \{ agentId \}\)/.test(SRC));
  ok('  and no caller in the tree calls it with two arguments',
    !/schoolSponsorSignals\(\s*pool\s*,\s*[^,)]+\)/.test(SRC.replace(/async function schoolSponsorSignals[^\n]*\n/, '')));

  const slA = await S.assembleSlate(P, { agentId: A, athlete: { id: ATH_A, school: SCHOOL, hasLocalMarket: false }, store });
  const slB = await S.assembleSlate(P, { agentId: B, athlete: { id: ATH_B, school: SCHOOL, hasLocalMarket: false }, store });
  ok('A\'s slate counts A\'s signals', slA.signalCount >= 3, slA.signalCount);
  ok('  and B\'s counts only the public one', slB.signalCount === 1, slB.signalCount);

  // ── THE QUERIES THEMSELVES NAME THE AGENT ──────────────────────────────
  // A behavioural test passes if a query returns nothing for an unrelated
  // reason. These read the SQL, so a scoping clause cannot be dropped while the
  // fixture happens to stay green.
  OUT.push('', '-- the scoping is in the SQL, not in the fixture --');
  const fn = SRC.slice(SRC.indexOf('async function schoolSponsorSignals'), SRC.indexOf('// ── Candidate pools'));
  const dealsQ = fn.slice(fn.indexOf('FROM deals d'), fn.indexOf('LIMIT 200', fn.indexOf('FROM deals d')));
  ok('the deals query checks BOTH the deal\'s agent and the athlete\'s',
    /d\.agent_id = \$2/.test(dealsQ) && /a\.agent_id = \$2/.test(dealsQ), dealsQ.trim().slice(-120));
  const engQ = fn.slice(fn.indexOf('FROM brand_engagement be'), fn.indexOf('LIMIT 200', fn.indexOf('FROM brand_engagement be')));
  ok('the reply query is scoped to the athlete\'s owner', /a\.agent_id = \$2/.test(engQ), engQ.trim().slice(-160));
  ok('  and refuses a ledger row recorded against another agent',
    /be\.agent_id IS NULL OR be\.agent_id = \$2/.test(engQ), engQ.trim().slice(-160));
  ok('the comps query still excludes our own closes',
    /LOWER\(TRIM\(COALESCE\(source,''\)\)\) <> 'agent-close'/.test(fn));

  await wipe();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}

main().catch((e) => { console.error('signalscope: FAILED', e); process.exit(1); });
