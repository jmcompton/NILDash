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
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// READY TO SEND: grouped by athlete, capped at three, and the draft readable.
// The thing this exists to prevent: an agent approving nineteen messages that
// go out under their own name having read none of them.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const C = require(ROOT + 'server/services/closer.js');
const G = require(ROOT + 'server/services/sendGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'rt-agent';
const HTML = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await G.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'A','rt@x.com','x','agent','America/Chicago')`, [AG]);

  // Three athletes at different urgencies: one with a reply, one long quiet,
  // one worked yesterday.
  const mk = async (id, name, school) => P.query(
    `INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [id, AG, JSON.stringify({ name, school })]);
  await mk('rt-warm', 'Marcus Hall', 'Auburn University');
  await mk('rt-quiet', 'Priya Nelson', 'Auburn University');
  await mk('rt-fresh', 'Kaden House', 'Auburn University');

  let n = 0;
  const draft = async (ath, brand, email, lane, contact) => {
    const id = 'rt-l' + (n++);
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,touch_no)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,1)`,
      [id, AG, ath, brand, 'Quick idea for ' + brand,
       '<p>First line about them.</p><p>What she would do.</p><p>JohnMark</p>', email]);
    if (lane) {
      await P.query(
        `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,lane,contact_name,contact_title)
         VALUES ($1,$2,$3,$4,$5,'dm','queued',$6,$7,$8)`,
        [AG, ath, n, 'k' + n, brand, lane, contact ? contact[0] : null, contact ? contact[1] : null]);
    }
    return id;
  };
  // Marcus: five, so the cap and the "N more" line both matter.
  for (let i = 0; i < 5; i++) {
    // The named contact goes on Biz 1, NOT Biz 0: rt-l0 is marked sent-and-
    // replied below to make Marcus sort first, which takes it out of the draft
    // batch entirely.
    await draft('rt-warm', 'Warm Biz ' + i, 'w' + i + '@rt.example', 'local',
      i === 1 ? ['Dana Reed', 'Owner'] : null);
  }
  await draft('rt-quiet', 'Quiet Biz', 'q@rt.example', 'social');
  await draft('rt-fresh', 'Fresh Biz', 'f@rt.example', 'national');
  // One with no address at all: it must be held back, not shown.
  await draft('rt-warm', 'No Address Co', null, 'local');

  // Marcus has a reply, so he must sort first; Priya has been quiet longest.
  await P.query(`UPDATE outreach_logs SET replied_at = NOW() - INTERVAL '2 days',
                   status='sent', sent_at = NOW() - INTERVAL '3 days' WHERE id='rt-l0'`);
  await P.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '12 days'
                  WHERE athlete_id='rt-quiet' AND id='rt-l5'`).catch(() => {});

  const b = await C.buildBatch(P, AG);
  ok('the batch is grouped by athlete', Array.isArray(b.groups) && b.groups.length > 0,
    b.groups && b.groups.length);

  // ── THE NAME APPEARS ONCE ────────────────────────────────────────────────
  const ids = b.groups.map((g) => g.athleteId);
  ok('  one group per athlete, not one row per pitch',
    ids.length === new Set(ids).size, ids);
  ok('  each group carries the name once', b.groups.every((g) => !!g.name), b.groups.map((g) => g.name));
  ok('  with a pitch count', b.groups.every((g) => g.count === g.items.length), b.groups.map((g) => [g.count, g.items.length]));
  ok('  and a status line explaining the ordering',
    b.groups.every((g) => !!g.status), b.groups.map((g) => g.status));

  // ── ORDERED BY URGENCY, THE CLOSER'S OWN WEIGHTING ───────────────────────
  const warm = b.groups.find((g) => g.athleteId === 'rt-warm');
  ok('THE ATHLETE WITH A REPLY SORTS FIRST', b.groups[0].athleteId === 'rt-warm',
    b.groups.map((g) => g.name + ':' + g.status));
  ok('  and the status line says why', /replied/.test(warm.status), warm.status);
  ok('  the order matches the allocator, not a second opinion',
    b.groups.map((g) => g.athleteId).join(',') ===
      b.plan.picks.filter((p) => b.groups.some((g) => g.athleteId === p.athleteId))
        .map((p) => p.athleteId).join(','),
    { groups: b.groups.map((g) => g.athleteId), plan: b.plan.picks.map((p) => p.athleteId) });

  // ── WHAT A ROW CARRIES ───────────────────────────────────────────────────
  const item = warm.items[0];
  ok('a row carries the business name', !!item.brand, item);
  ok('  the lane', !!item.lane, item);
  ok('  the full draft body, not a preview',
    item.body && item.body.length > 30 && /JohnMark/.test(item.body), item.body);
  ok('  and who it is actually going to', !!(item.to && item.to.name), item.to);
  const named = warm.items.find((x) => x.to && x.to.kind === 'person');
  ok('a named contact is shown by name', named && named.to.name === 'Dana Reed', named && named.to);
  const inbox = warm.items.find((x) => x.to && x.to.kind === 'inbox');
  ok('  and an unnamed one says "the general inbox", not a guess',
    inbox && inbox.to.name === 'the general inbox', inbox && inbox.to);

  ok('a local lane names the town when we have an address',
    C.laneLabel({ lane: 'local', biz_address: '1204 Opelika Rd, Auburn, AL 36830' }) === 'Local · Auburn',
    C.laneLabel({ lane: 'local', biz_address: '1204 Opelika Rd, Auburn, AL 36830' }));
  ok('  and does NOT invent one when we do not',
    C.laneLabel({ lane: 'local', biz_address: null }) === 'Local',
    C.laneLabel({ lane: 'local', biz_address: null }));
  ok('social reads as DTC', C.laneLabel({ lane: 'social' }) === 'DTC');
  ok('national reads as National', C.laneLabel({ lane: 'national' }) === 'National');
  ok('a city is only taken from a shape we recognise',
    C.cityOf('some free text') === null, C.cityOf('some free text'));

  // ── THE HELD-BACK LINE IS ONE LINE ───────────────────────────────────────
  ok('a business with no address is held back, not shown',
    !b.batch.some((x) => x.brand === 'No Address Co'), b.batch.map((x) => x.brand));
  ok('  and summarised in ONE line', !!(b.heldBack && b.heldBack.line), b.heldBack);
  ok('  naming the count and what happens to them',
    /held back with no email address yet\. They stay as DM or call cards\./.test(b.heldBack.line),
    b.heldBack.line);
  ok('  without listing individual businesses in the line',
    !/No Address Co/.test(b.heldBack.line), b.heldBack.line);

  // ── THE PAGE ─────────────────────────────────────────────────────────────
  ok('THE PAGE RENDERS GROUPS, not flat rows', /function srRenderBatch/.test(HTML), null);
  ok('  the athlete header carries name, count and status',
    /sr-ath-name/.test(HTML) && /sr-ath-count/.test(HTML) && /sr-ath-status/.test(HTML), null);
  ok('  capped at three per athlete', /_srPerAthlete = 3/.test(HTML), null);
  ok('  with one quiet line for the rest',
    /' more for ' \+ hqEsc\(firstName\(g\.name\)\)/.test(HTML), null);
  ok('  the row no longer says "for [athlete]"',
    !/'for ' \+ hqEsc\(b\.athleteName\)/.test(HTML), null);
  ok('  clicking a row shows the full message',
    /class="sr-msg"/.test(HTML) && /stripHtml\(it\.body\)/.test(HTML), null);
  ok('  and who it is going to', /class="sr-to"/.test(HTML) && /<b>To:<\/b>/.test(HTML), null);
  ok('  Edit opens a textarea in place', /class="sr-edit"/.test(HTML) && /srEditDraft/.test(HTML), null);
  ok('  and saves without navigating', /srSaveDraft/.test(HTML) && !/location\.href/.test(
    HTML.slice(HTML.indexOf('async function srSaveDraft'), HTML.indexOf('async function srSkipDraft'))), null);
  ok('  Skip this one is on the expanded row', /Skip this one/.test(HTML), null);
  ok('  the approve button is kept', /id="sr-approve"/.test(HTML), null);
  ok('  and so is the timing line', /You do not pick the time/.test(HTML), null);
  ok('  mobile has its own rules', /@media \(max-width:520px\)[\s\S]{0,400}sr-ath-status/.test(HTML), null);

  // APPROVE COVERS COLLAPSED ROWS TOO. A pitch hidden behind "2 more" is still
  // approved unless it was unchecked -- otherwise the cap silently drops them.
  ok('approve collects every draft, including ones behind "N more"',
    /\(_srBatch\.groups \|\| \[\]\)\.forEach[\s\S]{0,200}ids\.push\(it\.id\)/.test(HTML), null);

  // ── EDIT AND SKIP ENDPOINTS ──────────────────────────────────────────────
  ok('the edit endpoint exists', /app\.patch\('\/api\/agent\/closer\/draft\/:id'/.test(SRC), null);
  ok('  editing flags the draft, which is what gates auto mode',
    /edited_before_approval = edited_before_approval OR \$4/.test(SRC), null);
  ok('  skipping stops the cadence rather than deleting the row',
    /cadence_stopped_at = NOW\(\), cadence_stop_reason = 'you skipped it'/.test(SRC), null);

  // Run the real handler.
  const start = SRC.indexOf("app.patch('/api/agent/closer/draft/:id'");
  const end = SRC.indexOf("// Auto mode, per athlete or per lane", start);
  const bodySrc = SRC.slice(SRC.indexOf('{', SRC.indexOf('async (req, res)', start)), end);
  const handler = new Function('store', 'req', 'res',
    'return (async (req,res)=>' + bodySrc.slice(0, bodySrc.lastIndexOf('}') + 1) + ')(req,res);');
  let out = null, code = 200;
  const res = { json: (v) => { out = v; return res; }, status: (c) => { code = c; return res; } };
  await handler(store, { params: { id: item.id }, session: { userId: AG },
    body: { body: 'Rewritten by the agent.' } }, res);
  ok('editing saves in place', out && out.ok === true, { code, out });
  const after = (await P.query(
    `SELECT body_html, edited_before_approval FROM outreach_logs WHERE id=$1`, [item.id])).rows[0];
  ok('  the new text is stored', after.body_html === 'Rewritten by the agent.', after);
  ok('  and the edit is recorded against auto mode', after.edited_before_approval === true, after);

  await handler(store, { params: { id: item.id }, session: { userId: AG }, body: { skip: true } }, res);
  const skipped = (await P.query(
    `SELECT cadence_stopped_at, cadence_stop_reason FROM outreach_logs WHERE id=$1`, [item.id])).rows[0];
  ok('skipping one stops it', !!skipped.cadence_stopped_at, skipped);
  ok('  saying the agent did it', /you skipped it/.test(skipped.cadence_stop_reason), skipped);
  const b2 = await C.buildBatch(P, AG);
  ok('  and it does not come back in the next batch',
    !b2.batch.some((x) => x.id === item.id), b2.batch.map((x) => x.id));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
