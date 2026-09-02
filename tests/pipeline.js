'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── ONE PIPELINE, ONE VOCABULARY ────────────────────────────────────────────
//
// An agent who approved five emails opened the Pipeline board and found it
// empty. Not because a write failed -- because no write was attempted. The
// three Home actions stopped at brand_engagement, which is the ledger that
// stops the Scout re-pitching a brand and is not a pipeline, and the board read
// `deals`, which nothing in the outreach flow writes.
//
// There were also four names for one concept, one of which (_stageRemap in
// store.js) rewrote rows on EVERY BOOT, so a row's stage depended on whether the
// server had restarted since it was written.
//
// The rule this suite exists to hold: outreach only ever puts things ON the
// board and only ever moves them FORWARD. An agent who has dragged a deal to
// Closing must never be pulled back by marking a follow-up DM sent.

const fs = require('fs');
const ROOT = REPO;
const PL = require(ROOT + 'server/services/pipeline');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const AG = 'pipe-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM athlete_self_deals WHERE athlete_id LIKE 'pipe-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id LIKE 'pipe-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role)
                 VALUES ($1,'Pipe','pipe@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('pipe-a1',$1,'{"name":"A One"}')`, [AG]);

  // ── THE FIVE STAGES ───────────────────────────────────────────────────────
  ok('the board is the five stages, in order',
    JSON.stringify(PL.STAGES) === JSON.stringify(
      ['Prospecting', 'Outreach Sent', 'Negotiating', 'Closing', 'Closed']), PL.STAGES);
  ok('Lost is off the board, not past Closed',
    PL.rank(PL.LOST) === -1 && PL.STAGES.indexOf(PL.LOST) === -1);

  // ── THE DRIFT IS GONE ─────────────────────────────────────────────────────
  // Contacted and Pitched were two names for one stage, and which one a row
  // carried depended on whether the server had rebooted.
  ok('CONTACTED AND PITCHED ARE NOW ONE STAGE',
    PL.normalizeStage('Contacted') === 'Outreach Sent'
      && PL.normalizeStage('Pitched') === 'Outreach Sent');
  for (const [legacy, canon] of [
    ['Prospect', 'Prospecting'], ['In Talks', 'Negotiating'], ['Signed', 'Closing'],
    ['Agreed', 'Closing'], ['Contract', 'Closing'], ['Negotiating', 'Negotiating'],
    ['not_contacted', 'Prospecting'], ['in_talks', 'Negotiating'], ['deal_closed', 'Closed'],
    ['no_response', 'Outreach Sent'], ['Lost', 'Lost'],
  ]) ok('  "' + legacy + '" -> ' + canon, PL.normalizeStage(legacy) === canon, PL.normalizeStage(legacy));
  ok('case does not matter', PL.normalizeStage('  closing  ') === 'Closing');
  // A stage we do not recognise must NOT become Prospecting: that would move a
  // closed deal back to the top of the board on the next write.
  ok('AN UNKNOWN STAGE IS NULL, NEVER Prospecting', PL.normalizeStage('Wat') === null);

  const st = fs.readFileSync(ROOT + 'server/store.js', 'utf8');
  ok('the every-boot remap is deleted',
    !/UPDATE athlete_self_deals SET stage='Pitched'  WHERE stage='Contacted'/.test(st), null);
  ok('  replaced by a migration guarded so it runs once',
    /self_deals_canonical_stages_v1/.test(st) && /app_flags/.test(st), null);
  ok('  which leaves a stage it cannot map ALONE rather than guessing',
    /if \(!canon\) \{ unknown\.push\(st\); continue; \}/.test(st), null);

  // ── FORWARD ONLY ──────────────────────────────────────────────────────────
  ok('an untouched brand enters at Outreach Sent',
    PL.advanceTo('Prospecting', 'Outreach Sent') === 'Outreach Sent');
  ok('A DEAL ALREADY NEGOTIATING IS NOT PULLED BACK BY A DM',
    PL.advanceTo('Negotiating', 'Outreach Sent') === 'Negotiating');
  ok('  nor one at Closing', PL.advanceTo('Closing', 'Outreach Sent') === 'Closing');
  ok('  nor a closed one', PL.advanceTo('Closed', 'Outreach Sent') === 'Closed');
  ok('a LOST deal is not revived by outreach',
    PL.advanceTo('Lost', 'Outreach Sent') === 'Lost');
  ok('a reply moves Outreach Sent to Negotiating',
    PL.advanceTo('Outreach Sent', 'Negotiating') === 'Negotiating');
  ok('nothing on file takes the target', PL.advanceTo(null, 'Outreach Sent') === 'Outreach Sent');
  ok('an unrecognised target leaves the row where it is',
    PL.advanceTo('Negotiating', 'Wat') === 'Negotiating');

  // ── CREATE OR ADVANCE, AGAINST THE REAL TABLE ─────────────────────────────
  const A = 'pipe-a1';
  const r1 = await PL.enterOutreachSent(P, { athleteId: A, agentId: AG,
    brandName: 'Cahaba Brewing', contactName: 'Ronda Perkins', source: 'test' });
  ok('the first touch CREATES a row', r1.created === true && r1.to === 'Outreach Sent', r1);
  ok('  with the contact on it', r1.deal.contact_name === 'Ronda Perkins', r1.deal.contact_name);
  ok('  and a stage_history entry',
    Array.isArray(r1.deal.stage_history) && r1.deal.stage_history.length === 1, r1.deal.stage_history);

  const r2 = await PL.enterOutreachSent(P, { athleteId: A, agentId: AG, brandName: 'cahaba brewing' });
  ok('A SECOND TOUCH DOES NOT CREATE A SECOND ROW',
    r2.created === false && r2.deal.id === r1.deal.id, { r2c: r2.created });
  ok('  matched case-insensitively on the brand name', r2.to === 'Outreach Sent');
  ok('  and does not append history for a move that did not happen',
    r2.deal.stage_history.length === 1, r2.deal.stage_history);

  // Hand-move it forward, then send another DM.
  await P.query(`UPDATE athlete_self_deals SET stage='Closing' WHERE id=$1`, [r1.deal.id]);
  const r3 = await PL.enterOutreachSent(P, { athleteId: A, agentId: AG, brandName: 'Cahaba Brewing' });
  ok('OUTREACH NEVER UNDOES AN AGENT\'S OWN MOVE',
    r3.to === 'Closing' && r3.advanced === false, r3);

  // Contact details fill in even when the stage does not move.
  const r4 = await PL.enterOutreachSent(P, { athleteId: A, agentId: AG,
    brandName: 'Cahaba Brewing', contactEmail: 'info@cahaba.com' });
  ok('  but a contact we learned later is still recorded',
    r4.deal.contact_email === 'info@cahaba.com', r4.deal.contact_email);

  const r5 = await PL.enterStage(P, { athleteId: A, agentId: AG, brandName: 'New Brand',
    stage: 'Closed', note: 'closed on the card', source: 'test' });
  ok('a card marked closed enters at Closed', r5.to === 'Closed', r5.to);
  ok('an athlete or brand we do not have is refused, not guessed at',
    (await PL.enterOutreachSent(P, { athleteId: A, brandName: '  ' })).ok === false);

  // ── EVERY HOME ACTION IS WIRED ────────────────────────────────────────────
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('MARKING A DM OR CALL SENT LANDS ON THE BOARD',
    /PIPE\.enterOutreachSent\(store\.pool/.test(idx), null);
  ok('  and an outcome moves it', /stage: outcome === 'closed' \? 'Closed' : 'Negotiating'/.test(idx), null);
  ok('  a board failure never fails the action the agent took',
    /pipeline write failed/.test(idx), null);
  const closer = fs.readFileSync(ROOT + 'server/services/closer.js', 'utf8');
  ok('APPROVING AN EMAIL LANDS ON THE BOARD TOO',
    /PIPE\.enterOutreachSent\(pool/.test(closer), null);
  ok('  carrying the address it was actually sent to',
    /contactEmail: r\.sent_to_email/.test(closer), null);
  ok('  and never unschedules an approved email if the board write fails',
    /cannot un-send an email/.test(closer), null);

  // ── THE BOARD READS THE PIPELINE ──────────────────────────────────────────
  ok('there is a pipeline endpoint', /app\.get\('\/api\/agent\/pipeline'/.test(idx), null);
  ok('  serving athlete_self_deals', /FROM athlete_self_deals d/.test(idx), null);
  ok('  scoped to the caller\'s roster', /WHERE a\.agent_id = \$1/.test(idx), null);
  ok('  and normalising stages on the way OUT as well as in',
    /stage: PIPE\.normalizeStage\(r\.stage\) \|\| PIPE\.FIRST/.test(idx), null);
  ok('MANUAL DEALS DO NOT VANISH FROM THE BOARD',
    /manualEntry: true/.test(idx), null);
  ok('  and a brand never appears twice', /if \(seen\.has\(key\)\) continue;/.test(idx), null);
  ok('a hand move MAY go backward, because that is the agent correcting themselves',
    /A HAND MOVE MAY GO BACKWARD/.test(idx), null);
  const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  ok('the board fetches the pipeline, not /api/agent/deals',
    /fetch\(`\$\{API_BASE\}\/api\/agent\/pipeline`/.test(html), null);
  ok('  taking its stage list from the server so the two cannot drift',
    /res && Array\.isArray\(res\.stages\)/.test(html), null);
  ok('  and PATCHes a pipeline row to the pipeline endpoint',
    /api\/agent\/pipeline\/\$\{encodeURIComponent\(dealId\)\}/.test(html), null);

  // ── THE PARTNERSHIP COUNT ─────────────────────────────────────────────────
  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('THE PARTNERSHIP COUNT READS athlete_self_deals ONLY',
    !/FROM athlete_deal_pipeline/.test(job)
      && /FROM athlete_self_deals\n\s+WHERE athlete_id = \$1 AND stage = ANY/.test(job), null);
  ok('  and counts CLOSED deals, not every row on the board',
    /\['Closed', 'Closing'\]/.test(job), null);

  // ── THE BACKFILL ──────────────────────────────────────────────────────────
  const bf = fs.readFileSync(ROOT + 'scripts/backfill-pipeline.js', 'utf8');
  const bfCode = bf.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('the backfill is a dry run unless --apply',
    /const APPLY = has\('--apply'\)/.test(bfCode) && /if \(!APPLY\)/.test(bfCode), null);
  ok('  reading both worked cards and sent emails',
    /FROM outreach_queue q/.test(bfCode) && /FROM outreach_logs l/.test(bfCode), null);
  ok('  deduped, because an email card writes to both',
    /want\.set\(key, merged\)/.test(bfCode), null);
  ok('  reversible, and only its own rows',
    /source = '\$\{SOURCE\}'/.test(bf) && /AND source = \$2/.test(bfCode), null);
  ok('  ADVANCING through the same function the live path uses',
    /PIPE\.enterStage\(P/.test(bfCode), null);
  ok('  and it says that rows it only advanced are not rolled back',
    /not touched by --undo/.test(bf), null);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
