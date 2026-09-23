'use strict';
// ── BEFORE AND AFTER: THE WRITER WITH AND WITHOUT THE EVIDENCE ──────────────
//
// Picks real cards (outreach_queue rows) whose business has marketing-activity
// evidence we can find, and writes each pitch twice with the SHIPPING writer:
//
//   BEFORE  evidence: []            what the queue has always passed (two nulls)
//   AFTER   evidence: [the lines]   what it passes now (services/writerEvidence)
//
// Everything else about the call is held the same, so the only difference
// between the two drafts is the evidence. The card's stored message is shown
// too, for reference.
//
// Needs the production database and a model key; it spends two writer calls
// per card (four if a draft is retried), and writes nothing.
//
//   node scripts/evidence-before-after.js              three cards
//   node scripts/evidence-before-after.js --n 5        five
//   node scripts/evidence-before-after.js --agent <id>
//   /api/admin/scripts/evidence-before-after?text=1          (in Chrome, as admin)
//
// WHERE THE EVIDENCE COMES FROM, per card, first found wins per source:
//   market_business_seen.evidence       written by scans from now on
//   deal_scan_market_cache candidates   the scan's own record, for cards queued
//                                       before the column existed
//   deal_comps                          a publicly reported NIL deal
// A card with none is passed over: its before and after are the same by rule.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const ai = require(ROOT + 'server/ai.js');
const PW = require(ROOT + 'server/services/pitchWriter.js');
const WE = require(ROOT + 'server/services/writerEvidence.js');
const AN = require(ROOT + 'server/services/agentName.js');
const AR = require(ROOT + 'server/services/athleteRecord.js');

const argv = process.argv.slice(2);
const N = argv.includes('--n') ? parseInt(argv[argv.indexOf('--n') + 1], 10) || 3 : 3;
const AGENT = argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null;

async function evidenceLines(P, card, school) {
  const brand = card.brand_name;
  let scan = null;
  const seen = await P.query(
    `SELECT evidence FROM market_business_seen WHERE brand = $1 AND evidence IS NOT NULL
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [brand]).catch(() => ({ rows: [] }));
  if (seen.rows[0]) scan = seen.rows[0].evidence;
  if (!scan) {
    const c = await P.query(
      `SELECT e->>'evidence' AS evidence
         FROM deal_scan_market_cache m, jsonb_array_elements(m.candidates) e
        WHERE lower(COALESCE(e->>'name', e->>'brand')) = lower($1)
          AND COALESCE(e->>'evidence', '') <> ''
        ORDER BY m.fetched_at DESC LIMIT 1`, [brand]).catch(() => ({ rows: [] }));
    if (c.rows[0]) scan = c.rows[0].evidence;
  }
  let sponsorSignal = null;
  if (school) {
    const d = await P.query(
      `SELECT 1 FROM deal_comps WHERE lower(brand) = lower($1)
          AND LOWER(TRIM(COALESCE(source,''))) <> 'agent-close'
          AND (LOWER(school) = LOWER($2) OR LOWER(school) LIKE '%' || LOWER($3) || '%') LIMIT 1`,
      [brand, school, school.replace(/\s*(university|college)\s*/ig, ' ').trim()]).catch(() => ({ rows: [] }));
    if (d.rows[0]) sponsorSignal = { kind: 'reported-deal-at-school', detail: `publicly reported an NIL deal with an athlete at ${school}` };
  }
  return WE.evidenceFor({ evidence_text: scan, sponsorSignal });
}

async function main() {
  const P = store.pool;
  await new Promise((r) => setTimeout(r, parseInt(process.env.INIT_WAIT_MS, 10) || 8000));
  const cards = (await P.query(
    `SELECT q.*, a.data AS athlete_data, u.name AS agent_name, u.email AS agent_email, u.scheduling_url,
            l.body_html AS email_html
       FROM outreach_queue q
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
       JOIN athletes a ON a.id = q.athlete_id
       JOIN users u ON u.id = q.agent_id
      WHERE q.channel IN ('email','dm') AND q.contact_name IS NOT NULL
        ${AGENT ? 'AND q.agent_id = $1' : ''}
      ORDER BY q.created_at DESC LIMIT 400`, AGENT ? [AGENT] : [])).rows;

  let shown = 0;
  for (const c of cards) {
    if (shown >= N) break;
    const athlete = AR.resolveAthlete({ id: c.athlete_id, data: c.athlete_data || {} },
      { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool });
    const evidence = await evidenceLines(P, c, athlete && athlete.school);
    if (!evidence.length) continue;
    const agentFirstName = AN.agentFirstName({ name: c.agent_name, email: c.agent_email });
    if (!agentFirstName) continue;
    const greet = PW.firstNameOf ? PW.firstNameOf(c.contact_name) : String(c.contact_name).split(' ')[0];
    const ctxOf = (ev) => ({
      business: { name: c.brand_name, category: c.business_category || null,
        ownerName: c.contact_name, ownerTitle: c.contact_title || null, greetFirstName: greet, evidence: ev },
      athlete: { ...athlete, instagramHandle: (c.athlete_data && c.athlete_data.instagramHandle) || null },
      agentFirstName, hasSchedulingLink: !!c.scheduling_url,
      channel: c.channel === 'email' ? 'email' : 'dm',
    });
    // Labelled, so these calls are counted apart from the nightly writer.
    const write = (ev) => PW.writePitch(ctxOf(ev), { oneShot: (p, s, mt) => require(ROOT + 'server/scanMeter.js').label(
      { site: 'writer.beforeafter', agentId: c.agent_id, athleteId: c.athlete_id, brand: c.brand_name },
      () => ai.oneShot(p, s, mt, ai.MODEL_GEN, { prose: true })) });
    const before = await write([]);
    const after = await write(evidence);
    shown++;
    console.log('\n' + '='.repeat(78));
    console.log(`CARD ${shown}: ${c.brand_name}  (queue id ${c.id}, ${c.channel}, athlete ${athlete.name}, agent ${c.agent_id})`);
    console.log('EVIDENCE SUPPLIED:');
    evidence.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    console.log('\n-- BEFORE (no evidence, as the queue has always called it) --');
    console.log(before.skipped ? '[not written: ' + before.reason + ']' : before.message);
    console.log('\n-- AFTER (evidence supplied) --');
    console.log(after.skipped ? '[not written: ' + after.reason + ']' : after.message);
    if (!after.skipped) console.log(`\n   evidence line stated: ${after.evidenceUsed || 'none'}`);
    console.log('\n-- WHAT THE CARD HOLDS TODAY --');
    console.log(c.dm_text || (c.email_html
      ? String(c.email_html).replace(/<\/p>/g, '\n').replace(/<[^>]+>/g, '').trim()
      : '(no stored text)'));
  }
  if (!shown) console.log('No card with findable evidence. Run a scan so market_business_seen.evidence fills, then retry.');
  // The writer calls are real spend: let the ledger write them before exiting.
  // And exit explicitly, because ai.js holds timers open and the admin runner
  // waits for the process to end.
  try { await require(ROOT + 'server/services/aiLedger.js').drain(); } catch (_) {}
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error('evidence-before-after: FAILED', e); process.exit(1); });
