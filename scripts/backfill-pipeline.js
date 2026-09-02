#!/usr/bin/env node
'use strict';
// ── TODAY'S ROSTER DOES NOT START FROM AN EMPTY BOARD ───────────────────────
//
// Every Home action now lands in athlete_self_deals. Nothing did before, so
// every card an agent has already worked -- every DM marked sent, every call
// marked done, every email approved and sent -- is outreach that happened and
// left no trace on the pipeline. An agent opening the board after this ships
// would see only what they do from now on, which reads as the feature not
// working.
//
// Two sources, because the two channels record themselves differently:
//
//   outreach_queue WHERE state = 'sent'      DM, call and program cards
//   outreach_logs  WHERE sent_at IS NOT NULL  emails that actually went out
//
// A brand can appear in both (an email card writes a queue row AND a draft), so
// they are deduped on athlete + normalised brand name -- the same key the live
// path uses, so the backfill and tomorrow's outreach cannot disagree.
//
// THE STAGE REFLECTS WHAT HAPPENED, not a flat "outreach sent":
//
//   sent, no reply          Outreach Sent
//   replied                 Negotiating
//   outcome = closed        Closed
//
// FORWARD ONLY, exactly like the live path. A brand already on the board is
// advanced if this evidence is further along and LEFT ALONE otherwise, so
// running this after an agent has hand-moved deals cannot pull their work back.
//
// DRY RUN BY DEFAULT. --apply is required to write. Per-athlete counts are
// printed either way.
//
// REVERSIBLE. Every row it creates is stamped source='backfill-pipeline', and
// --undo --apply deletes exactly those rows and nothing else. Rows it only
// ADVANCED are not rolled back by --undo: the stage move is the same one the
// live path would have made, and un-advancing a deal an agent may since have
// worked would destroy real information. --undo says so when it skips them.
//
//   node scripts/backfill-pipeline.js                  # dry run, all agents
//   node scripts/backfill-pipeline.js --agent <id>     # dry run, one agent
//   node scripts/backfill-pipeline.js --apply
//   node scripts/backfill-pipeline.js --undo --apply

const store = require('../server/store');
const PIPE = require('../server/services/pipeline');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const APPLY = has('--apply');
const UNDO = has('--undo');
const ONE_AGENT = val('--agent');
const SOURCE = 'backfill-pipeline';
const INIT_WAIT_MS = parseInt(process.env.SCRIPT_INIT_WAIT_MS, 10) || 2500;

const norm = (b) => String(b || '').trim().toLowerCase();

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  if (UNDO) {
    const scope = ONE_AGENT ? 'AND a.agent_id = $1' : '';
    const params = ONE_AGENT ? [ONE_AGENT] : [];
    const rows = (await P.query(
      `SELECT d.id, d.brand_name, d.athlete_id, a.data->>'name' AS athlete_name
         FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id
        WHERE d.source = '${SOURCE}' ${scope}
        ORDER BY a.data->>'name'`, params)).rows;
    console.log(`\n${rows.length} row(s) created by this backfill${APPLY ? '' : '  — DRY RUN'}`);
    for (const r of rows) console.log(`  ${r.athlete_name || r.athlete_id}  ${r.brand_name}`);
    console.log('\nRows this backfill only ADVANCED are not touched by --undo: that stage move');
    console.log('is the one the live path would have made, and un-advancing a deal an agent has');
    console.log('since worked would destroy real information.\n');
    if (APPLY && rows.length) {
      const del = await P.query(
        `DELETE FROM athlete_self_deals WHERE id = ANY($1::int[]) AND source = $2`,
        [rows.map((r) => r.id), SOURCE]);
      console.log(`Deleted ${del.rowCount} row(s).\n`);
    } else if (!APPLY) {
      console.log('Re-run with --apply to delete them.\n');
    }
    await P.end();
    return;
  }

  // ── WHAT ALREADY HAPPENED ─────────────────────────────────────────────────
  const scopeQ = ONE_AGENT ? 'AND a.agent_id = $1' : '';
  const params = ONE_AGENT ? [ONE_AGENT] : [];

  const queued = (await P.query(
    `SELECT q.athlete_id, q.agent_id, q.brand_name, q.contact_name, q.email,
            q.sent_at, q.sent_via, q.outcome, q.replied_at,
            a.data->>'name' AS athlete_name
       FROM outreach_queue q JOIN athletes a ON a.id = q.athlete_id
      WHERE q.state = 'sent' AND q.brand_name IS NOT NULL AND q.brand_name <> '' ${scopeQ}`,
    params)).rows;

  const logs = (await P.query(
    `SELECT l.athlete_id, l.agent_id, l.brand_name, l.sent_to_email,
            l.sent_at, l.replied_at, l.status,
            a.data->>'name' AS athlete_name
       FROM outreach_logs l JOIN athletes a ON a.id = l.athlete_id
      WHERE l.sent_at IS NOT NULL AND l.brand_name IS NOT NULL AND l.brand_name <> '' ${scopeQ}`,
    params)).rows;

  // ── ONE ENTRY PER athlete + BRAND, at the furthest stage the evidence shows ─
  // An email card writes BOTH a queue row and a draft, so the same brand arrives
  // twice and the two halves can disagree about how far it got.
  const want = new Map();
  const consider = (r, stage, via) => {
    const key = r.athlete_id + '|' + norm(r.brand_name);
    const prev = want.get(key);
    const merged = {
      athleteId: r.athlete_id, agentId: r.agent_id || null,
      athleteName: r.athlete_name || r.athlete_id,
      brandName: String(r.brand_name).trim(),
      contactName: (prev && prev.contactName) || r.contact_name || null,
      contactEmail: (prev && prev.contactEmail) || r.sent_to_email || r.email || null,
      stage: prev ? PIPE.advanceTo(prev.stage, stage) : stage,
      via: prev ? prev.via + '+' + via : via,
    };
    want.set(key, merged);
  };
  for (const r of queued) {
    const stage = r.outcome === 'closed' ? 'Closed'
      : (r.outcome === 'replied' || r.replied_at) ? 'Negotiating' : 'Outreach Sent';
    consider(r, stage, r.sent_via || 'queue');
  }
  for (const r of logs) {
    const stage = r.replied_at ? 'Negotiating' : 'Outreach Sent';
    consider(r, stage, 'email');
  }

  // ── WHAT IS ALREADY ON THE BOARD ──────────────────────────────────────────
  const existing = new Map();
  const ex = (await P.query(
    `SELECT d.id, d.athlete_id, d.brand_name, d.stage
       FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id
      WHERE 1=1 ${scopeQ}`, params)).rows;
  for (const r of ex) existing.set(r.athlete_id + '|' + norm(r.brand_name), r);

  const toCreate = [];
  const toAdvance = [];
  const leftAlone = [];
  for (const [key, w] of want) {
    const cur = existing.get(key);
    if (!cur) { toCreate.push(w); continue; }
    const to = PIPE.advanceTo(cur.stage, w.stage);
    if (to !== PIPE.normalizeStage(cur.stage)) toAdvance.push({ ...w, id: cur.id, from: cur.stage, to });
    else leftAlone.push({ ...w, from: cur.stage });
  }

  // ── THE COUNTS, BEFORE ANYTHING IS WRITTEN ────────────────────────────────
  const byAthlete = {};
  const bump = (w, k) => {
    const a = byAthlete[w.athleteName] = byAthlete[w.athleteName]
      || { create: 0, advance: 0, leave: 0 };
    a[k]++;
  };
  toCreate.forEach((w) => bump(w, 'create'));
  toAdvance.forEach((w) => bump(w, 'advance'));
  leftAlone.forEach((w) => bump(w, 'leave'));

  console.log(`\n${queued.length} worked card(s) and ${logs.length} sent email(s) `
    + `-> ${want.size} distinct athlete+brand pair(s)${APPLY ? '' : '   — DRY RUN, nothing will be written'}\n`);
  console.log('  ' + 'ATHLETE'.padEnd(26) + 'CREATE'.padEnd(9) + 'ADVANCE'.padEnd(10) + 'ALREADY OK');
  console.log('  ' + '-'.repeat(62));
  for (const name of Object.keys(byAthlete).sort()) {
    const a = byAthlete[name];
    console.log('  ' + String(name).slice(0, 24).padEnd(26)
      + String(a.create).padEnd(9) + String(a.advance).padEnd(10) + String(a.leave));
  }
  console.log('\n  ' + 'TOTAL'.padEnd(26) + String(toCreate.length).padEnd(9)
    + String(toAdvance.length).padEnd(10) + String(leftAlone.length));

  const byStage = {};
  for (const w of toCreate) byStage[w.stage] = (byStage[w.stage] || 0) + 1;
  if (toCreate.length) {
    console.log('\n  New rows by stage:');
    for (const st of PIPE.STAGES) if (byStage[st]) console.log(`    ${st}: ${byStage[st]}`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    console.log('Every row created is stamped source=\'' + SOURCE + '\' and can be removed with');
    console.log('  node scripts/backfill-pipeline.js --undo --apply\n');
    await P.end();
    return;
  }

  let created = 0, advanced = 0;
  for (const w of toCreate) {
    const r = await PIPE.enterStage(P, {
      athleteId: w.athleteId, agentId: w.agentId, brandName: w.brandName,
      stage: w.stage, contactName: w.contactName, contactEmail: w.contactEmail,
      note: 'Backfilled from outreach already sent (' + w.via + ')',
      source: SOURCE,
    }).catch((e) => { console.error('  ' + w.brandName + ':', e.message); return null; });
    if (r && r.ok) created++;
  }
  for (const w of toAdvance) {
    // Through the same function the live path uses, so the forward-only rule and
    // the stage_history entry are identical rather than reimplemented here.
    const r = await PIPE.enterStage(P, {
      athleteId: w.athleteId, agentId: w.agentId, brandName: w.brandName,
      stage: w.stage, contactName: w.contactName, contactEmail: w.contactEmail,
      note: 'Backfilled from outreach already sent (' + w.via + ')',
    }).catch((e) => { console.error('  ' + w.brandName + ':', e.message); return null; });
    if (r && r.advanced) advanced++;
  }
  console.log(`\nCreated ${created}, advanced ${advanced}, left ${leftAlone.length} alone.\n`);
  await P.end();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('THREW', e);
  process.exit(1);
});
