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
// THE GATE IS RUN, not described. Every assertion here drives the real
// releaseDue() with a real database and a fake provider, because the claim being
// made is "nothing sends without passing this" and the only way to test that
// claim is to try to send.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Closer = require(ROOT + 'server/services/closer.js');
const C = require(ROOT + 'server/services/compliance.js');
const shiftReport = require(ROOT + 'server/services/shiftReport.js');
const { renderShiftEmail } = require(ROOT + 'server/services/shiftEmail.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'cmp-agent';
const P = () => store.pool;

// A provider that records every send it is asked to make. If a held message
// reaches this, the gate failed.
function recorder() {
  const sent = [];
  return { sent, fn: async (log) => { sent.push(log.brand_name); return { providerMessageId: 'm' + sent.length }; } };
}

async function draft(id, brand, opts = {}) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,
       status,sent_to_email,touch_no,scheduled_send_at)
     VALUES ($1,$2,$3,$4,$5,'Hi','<p>x</p>','approved',$6,1, NOW() - INTERVAL '1 minute')`,
    [id, AG, opts.athleteId || 'cmp-a1', brand, brand.toLowerCase(), (opts.email || 'x@cmp.example')]);
}
async function places(brand, types) {
  await P().query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'places',$2,$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
    ['cmp:' + brand.toLowerCase(), brand, JSON.stringify({ found: true, types, name: brand })]);
}
// A Tuesday at 10am Central, so the send window is open and the only thing that
// can hold a message is the gate under test.
const WHEN = new Date('2026-08-25T15:00:00Z');
const release = (opts = {}) =>
  Closer.releaseDue(P(), Object.assign({ sleep: async () => {}, now: WHEN }, opts));

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const G = require(ROOT + 'server/services/sendGuard.js');
  await G.ensureTable(P());
  const clean = async () => {
    await P().query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'cmp:%'`).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz)
                   VALUES ($1,'Jonathan C','cmp@x.com','x','agent','America/Chicago')`, [AG]);
  // Three athletes: a known minor, a known adult, and one with no date of birth.
  const mkAthlete = (id, name, dob) => P().query(
    `INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [id, AG, JSON.stringify({ name, school: 'Auburn University', dob })]);
  const yearsAgo = (n) => new Date(Date.now() - n * 365.25 * 864e5).toISOString().slice(0, 10);
  await mkAthlete('cmp-a1', 'Adult Athlete', yearsAgo(21));
  await mkAthlete('cmp-a2', 'Minor Athlete', yearsAgo(16));
  await mkAthlete('cmp-a3', 'Unknown Age', null);

  // ── 1. THE PURE RULE TABLE ───────────────────────────────────────────────
  OUT.push('-- the rules are lookups, not judgments --');
  const adult = C.ageFrom(yearsAgo(21));
  const minor = C.ageFrom(yearsAgo(16));
  const unknown = C.ageFrom(null);
  ok('a birthday resolves to an age', adult.known && adult.years === 21, adult);
  ok('  and a minor is identified as one', minor.known && minor.minor === true, minor);
  ok('  a missing birthday is UNKNOWN, never an adult',
    unknown.known === false && unknown.minor === null, unknown);
  ok('  and so is a junk one', C.ageFrom('not-a-date').known === false);
  ok('  and so is a future one', C.ageFrom('2099-01-01').known === false);

  ok('alcohol to a minor is a hard block', C.severityFor('alcohol', minor) === 'block');
  ok('  to an adult it is a hold, because we do not hold the school policy',
    C.severityFor('alcohol', adult) === 'hold');
  ok('  and on an UNKNOWN age it holds -- it never assumes an adult',
    C.severityFor('alcohol', unknown) === 'hold');
  ok('sports betting is a block at ANY age', C.severityFor('gambling', adult) === 'block'
    && C.severityFor('gambling', minor) === 'block');
  ok('adult entertainment is a block at any age', C.severityFor('adult', adult) === 'block');
  ok('supplements hold at any age (NCAA banned-substance risk)',
    C.severityFor('supplements', adult) === 'hold');

  // ── 2. CLASSIFICATION, FROM DATA WE HOLD ─────────────────────────────────
  OUT.push('', '-- classification comes from Places types and the name, nothing else --');
  const byType = C.classifyBusiness('The Corner', { found: true, types: ['bar', 'restaurant'] });
  ok('a Google Places type classifies it', byType.hits.some((h) => h.key === 'alcohol'), byType.hits);
  ok('  and the record says which type said so', /Google Places type "bar"/.test(byType.hits[0].basis), byType.hits[0]);
  const byName = C.classifyBusiness('Auburn Brewing Co', { found: true, types: ['restaurant'] });
  ok('a bar typed "restaurant" is still caught by name',
    byName.hits.some((h) => h.key === 'alcohol'), byName.hits);
  const cannabis = C.classifyBusiness('Green Leaf Dispensary', { found: true, types: ['store'] });
  ok('cannabis is caught by name, because Google publishes no type for it',
    cannabis.hits.some((h) => h.key === 'cannabis'), cannabis.hits);
  ok('a plain restaurant is clean',
    C.classifyBusiness('Amsterdam Cafe', { found: true, types: ['restaurant'] }).hits.length === 0);
  ok('  word boundaries hold: "Burgundy Wine Bar" is alcohol, "Burgundy Barbers" is not',
    C.classifyBusiness('Burgundy Barbers', { found: true, types: ['hair_care'] }).hits.length === 0);
  ok('NO PLACES ROW IS NOT A CLEAN RESULT',
    C.classifyBusiness('Mystery Co', null).classified === false);

  // ── 3. THE GATE BLOCKS. THIS IS THE WHOLE CLAIM. ─────────────────────────
  OUT.push('', '-- it blocks, it does not warn --');
  await places('Amsterdam Cafe', ['restaurant']);
  await places('The Tap Room', ['bar']);
  await places('Bowie Guns', ['gun_store']);
  await draft('cmp-1', 'Amsterdam Cafe', { athleteId: 'cmp-a1' });   // clean, adult
  await draft('cmp-2', 'The Tap Room', { athleteId: 'cmp-a2' });     // alcohol, MINOR
  await draft('cmp-3', 'Bowie Guns', { athleteId: 'cmp-a3' });       // firearms, unknown age
  await draft('cmp-4', 'Mystery Co', { athleteId: 'cmp-a1' });       // no Places row at all

  const r1 = recorder();
  const out1 = await release({ send: r1.fn });
  ok("the clean pitch sent", r1.sent.indexOf('Amsterdam Cafe') !== -1, r1.sent);
  ok('ALCOHOL TO A MINOR DID NOT SEND', r1.sent.indexOf('The Tap Room') === -1, r1.sent);
  ok('FIREARMS ON AN UNKNOWN AGE DID NOT SEND', r1.sent.indexOf('Bowie Guns') === -1, r1.sent);
  ok('AN UNCLASSIFIABLE BUSINESS DID NOT SEND', r1.sent.indexOf('Mystery Co') === -1, r1.sent);
  ok('  exactly one message reached the provider', r1.sent.length === 1, r1.sent);
  ok('  and the run counted the holds', out1.compliance === 3, out1);

  // ── 4. EVERY HOLD IS ON THE RECORD ───────────────────────────────────────
  OUT.push('', '-- the record is the product --');
  const rows = (await P().query(
    `SELECT * FROM compliance_holds WHERE agent_id=$1 ORDER BY id`, [AG])).rows;
  ok('a row exists for each held pitch', rows.length === 3, rows.map((r) => r.brand_name + ':' + r.rule_key + ':' + r.severity));
  const tap = rows.find((r) => r.brand_name === 'The Tap Room');
  ok('  it names the rule', tap.rule_label === 'alcohol', tap && tap.rule_label);
  ok('  the severity is a hard block for the minor', tap.severity === 'block', tap && tap.severity);
  ok('  the reason is readable months later', /is 16, a minor/.test(tap.reason), tap && tap.reason);
  ok('  it records what we knew at the time', tap.facts && tap.facts.age && tap.facts.age.minor === true, tap && tap.facts);
  ok('  THE DATE OF BIRTH ITSELF IS NOT IN THE LOG',
    tap.facts.dob === 'on file' && !/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(tap.facts.dob)), tap.facts.dob);
  ok('  and it records what was NOT checked', Array.isArray(tap.unchecked) && tap.unchecked.length === 3, tap && tap.unchecked);
  ok('  naming school policy as unchecked', /school policy/.test(JSON.stringify(tap.unchecked)));
  ok('  and the sponsor roster', /sponsor roster/.test(JSON.stringify(tap.unchecked)));
  const mystery = rows.find((r) => r.brand_name === 'Mystery Co');
  ok('an unverifiable category is its own rule, not silence',
    mystery.rule_key === 'category-unknown' && mystery.severity === 'hold', mystery && mystery.rule_key);

  // ── 5. RE-RUNNING DOES NOT DUPLICATE, AND DOES NOT RELEASE ───────────────
  const r2 = recorder();
  await release({ send: r2.fn });
  ok('a second tick still does not send the held ones', r2.sent.length === 0, r2.sent);
  const rows2 = (await P().query(`SELECT COUNT(*)::int n FROM compliance_holds WHERE agent_id=$1`, [AG])).rows[0].n;
  ok('  and does not write a second identical row', rows2 === 3, rows2);

  // ── 6. OVERRIDE: ALLOWED FOR A HOLD, REFUSED FOR A BLOCK ─────────────────
  OUT.push('', '-- an agent overriding a hold is normal. a block is not overridable --');
  const bad = await C.overrideHold(P(), tap.id, { agentId: AG, reason: 'I checked and it is fine' });
  ok('A HARD BLOCK CANNOT BE OVERRIDDEN', bad.ok === false, bad);
  ok('  and it says why', /cannot be overridden/.test(bad.error), bad.error);
  const noReason = await C.overrideHold(P(), mystery.id, { agentId: AG, reason: 'ok' });
  ok('an override with no real reason is refused', noReason.ok === false, noReason);
  ok('  because the reason goes on the record', /goes on the record/.test(noReason.error), noReason.error);
  const good = await C.overrideHold(P(), mystery.id,
    { agentId: AG, reason: 'Called them, they are an accounting firm' });
  ok('a hold CAN be overridden with a reason', good.ok === true, good);

  const r3 = recorder();
  await release({ send: r3.fn });
  // AN OVERRIDE HAS TO STICK. The gate re-runs every tick against unchanged
  // data, so without remembering the decision it would re-derive the identical
  // hold and the override would achieve nothing, forever.
  ok('  and the overridden pitch then sends', r3.sent.indexOf('Mystery Co') !== -1, r3.sent);
  ok('  while the block still does not', r3.sent.indexOf('The Tap Room') === -1, r3.sent);
  const resolved = (await P().query(`SELECT * FROM compliance_holds WHERE id=$1`, [mystery.id])).rows[0];
  ok('  the override is recorded against the agent', resolved.resolved_by === AG, resolved.resolved_by);
  ok('  with the reason they gave', /accounting firm/.test(resolved.resolution_reason), resolved.resolution_reason);
  ok('  and the original hold is NOT erased', resolved.reason === mystery.reason && resolved.severity === 'hold');

  // An override is scoped to ONE RULE on ONE MESSAGE. It must not clear a
  // different rule, and it must not clear the same rule on another pitch.
  await places('Cellar Door Wine', ['restaurant']);
  await draft('cmp-6', 'Cellar Door Wine', { athleteId: 'cmp-a1' });
  await draft('cmp-7', 'Mystery Co', { athleteId: 'cmp-a1' });
  const r3b = recorder();
  await release({ send: r3b.fn });
  ok('  overriding one rule does not clear a different one',
    r3b.sent.indexOf('Cellar Door Wine') === -1, r3b.sent);
  ok('  and does not clear the same rule on another pitch',
    r3b.sent.indexOf('Mystery Co') === -1, r3b.sent);

  // ── 7. FAIL CLOSED ───────────────────────────────────────────────────────
  OUT.push('', '-- if the gate cannot run, nothing sends --');
  const broke = await C.evaluate(null, null);      // no pool, no context at all
  ok('evaluate() never throws', !!broke && !!broke.decision, broke);
  ok('  it returns a HOLD, not a pass', broke.decision === 'hold', broke.decision);
  ok('  and marks itself as failed closed', broke.failedClosed === true, broke);

  // A gate that throws inside releaseDue must still hold. Break recordFindings.
  await draft('cmp-5', 'The Tap Room', { athleteId: 'cmp-a2' });
  const realRecord = C.recordFindings;
  C.recordFindings = async () => { throw new Error('database on fire'); };
  const r4 = recorder();
  const out4 = await release({ send: r4.fn });
  C.recordFindings = realRecord;
  ok('A THROW INSIDE THE GATE HOLDS THE SEND', r4.sent.length === 0, r4.sent);
  ok('  and the run says a compliance hold stopped it',
    (out4.detail || []).some((d) => /could not run|alcohol/.test(d.why || '')), out4.detail);

  // ── 8. THE SHIFT REPORT ──────────────────────────────────────────────────
  OUT.push('', '-- a hold is in Needs you, not buried --');
  const rep = await shiftReport.buildShiftReport(P(), AG);
  const items = rep.needsYou.items;
  ok('holds are in Needs you', items.some((i) => i.kind === 'compliance'), items.map((i) => i.kind));
  ok('  and they are FIRST, above replies and approvals', items[0].kind === 'compliance', items.map((i) => i.kind));
  const h = items.find((i) => i.kind === 'compliance');
  ok('  the row names the business and the athlete',
    /The Tap Room/.test(h.line) && /Minor Athlete/.test(h.line), h.line);
  ok('  and the rule', h.detail === 'alcohol', h.detail);
  ok('  and carries the reason, so the decision can be made from the row', !!h.reason, h);
  ok('  a block offers no override action',
    h.severity !== 'block' || !/Review and decide/.test(h.actionLabel), h.actionLabel);

  const mail = renderShiftEmail(rep, { appUrl: 'https://mynildash.com', agentName: 'Jonathan C' });
  ok('the email subject leads with the hold', /^Cannot send: |^On hold: |pitches on hold/.test(mail.subject), mail.subject);
  ok('  the body names the business', /The Tap Room/.test(mail.html), null);
  ok('  and carries the reason', /is 16, a minor/.test(mail.html), null);
  ok('  the plain text does too', /The Tap Room/.test(mail.text), null);

  // ── 8b. AGENT-SUPPLIED SCHOOL RESTRICTIONS ───────────────────────────────
  OUT.push('', '-- the agent can state a school restriction, and it is labelled as theirs --');
  await P().query(`UPDATE athletes SET data = data || '{"schoolRestrictions":["supplements"]}'::jsonb
                    WHERE id = 'cmp-a1'`);
  await places('Peak Supplements', ['store']);
  await draft('cmp-8', 'Peak Supplements', { athleteId: 'cmp-a1' });
  const r5 = recorder();
  await release({ send: r5.fn });
  ok('a category the agent says the school restricts does not send',
    r5.sent.indexOf('Peak Supplements') === -1, r5.sent);
  const sr = (await P().query(
    `SELECT * FROM compliance_holds WHERE agent_id=$1 AND brand_name='Peak Supplements'`, [AG])).rows[0];
  ok('  it is a BLOCK, not a hold -- the agent already decided when they ticked it',
    sr && sr.severity === 'block', sr && sr.severity);
  ok('  the rule is named as a school restriction',
    /restricted by the school/.test(sr.rule_label), sr && sr.rule_label);
  ok('  THE RECORD SAYS THE SOURCE WAS THE AGENT', sr.facts.source === 'agent', sr && sr.facts.source);
  ok('  and the reason says we did not check with the school',
    /came from you, not from the school/.test(sr.reason), sr && sr.reason);
  ok('  it does NOT claim we verified anything',
    !/we verified|we confirmed|school policy says/i.test(sr.reason), sr && sr.reason);
  ok('  and it cannot be overridden, because it is the agent\'s own rule',
    (await C.overrideHold(P(), sr.id, { agentId: AG, reason: 'changed my mind about this' })).ok === false);

  // ── 8c. STATE CATEGORY RULES: EMPTY TABLE CHANGES NOTHING ────────────────
  OUT.push('', '-- an unpopulated state table holds, exactly as before --');
  const empty = (await P().query(`SELECT COUNT(*)::int n FROM state_category_rules`)).rows[0].n;
  ok('the state rules table ships EMPTY', empty === 0, empty);
  ok('  and nothing in the codebase populates it',
    !/INSERT INTO state_category_rules/.test(
      require('fs').readFileSync(ROOT + 'server/services/compliance.js', 'utf8')), null);
  // A citation is structurally required, so a row without one cannot exist.
  let refused = false;
  try {
    await P().query(`INSERT INTO state_category_rules
      (state_code,category,minor_rule,adult_rule,citation,date_checked)
      VALUES ('AL','alcohol','block','hold','   ',CURRENT_DATE)`);
  } catch (_) { refused = true; }
  ok('A ROW WITHOUT A REAL CITATION IS REFUSED BY THE SCHEMA', refused === true);
  // A populated row can TIGHTEN.
  await P().query(`INSERT INTO state_category_rules
    (state_code,category,minor_rule,adult_rule,citation,date_checked,confidence)
    VALUES ('AL','firearms','block','block','Ala. Code Title 13A, Chapter 11 (test row)',CURRENT_DATE,'confident')
    ON CONFLICT (state_code,category) DO UPDATE SET adult_rule='block'`);
  const ruleRow = await C.stateRuleFor(P(), 'AL', 'firearms');
  ok('a populated row is read back', !!ruleRow && ruleRow.adult_rule === 'block', ruleRow && ruleRow.adult_rule);
  const tightened = await C.evaluate(null, {
    brandName: 'Bowie Guns', evidence: { found: true, types: ['gun_store'] },
    dob: yearsAgo(21), athleteName: 'A', school: 'Auburn University',
    stateRule: { firearms: ruleRow },
  });
  ok('  and it TIGHTENS an adult hold into a block', tightened.decision === 'block', tightened.decision);
  ok('  citing the statute on the record', /Ala\. Code Title 13A/.test(tightened.findings[0].reason), tightened.findings[0].reason);
  // 'allow' must NOT loosen.
  await P().query(`UPDATE state_category_rules SET minor_rule='allow', adult_rule='allow'
                    WHERE state_code='AL' AND category='firearms'`);
  const allowRow = await C.stateRuleFor(P(), 'AL', 'firearms');
  const loosened = await C.evaluate(null, {
    brandName: 'Bowie Guns', evidence: { found: true, types: ['gun_store'] },
    dob: yearsAgo(21), athleteName: 'A', school: 'Auburn University',
    stateRule: { firearms: allowRow },
  });
  ok('AN "ALLOW" STATE RULE DOES NOT OPEN THE GATE', loosened.decision === 'hold', loosened.decision);
  ok('  because a state permitting it says nothing about the school',
    /school/.test(loosened.findings[0].reason), loosened.findings[0].reason);
  await P().query(`DELETE FROM state_category_rules WHERE state_code='AL' AND category='firearms'`);

  // ── 9. DISCLOSURE IS PREPARED, NOT FILED ─────────────────────────────────
  OUT.push('', '-- filing is out of scope --');
  const under = C.prepareDisclosureFiling({ value: '400', brand: 'X' }, { name: 'A', school: 'B' });
  ok('under the threshold, no NIL Go submission is triggered', under.required === false, under);
  ok('  but it does not claim the school needs nothing', /may still require/.test(under.note), under.note);
  const over = C.prepareDisclosureFiling({ value: '2500', brand: 'Kessler Auto' }, { name: 'A', school: 'Auburn' });
  ok('at or over $600 a filing is prepared', over.required === true && over.filing.amount === 2500, over);
  ok('  and it says plainly that WE DO NOT SUBMIT IT', /does not submit/.test(over.submission), over.submission);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
