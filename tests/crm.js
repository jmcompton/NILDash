'use strict';
// Runs against the local test Postgres, in its own database. No network.
//
//   node tests/run.js      every suite, against the committed baseline
//   node tests/crm.js      just this one
//
// ── THE AGENT'S CRM (CRM_ON), AND "DEAL SIGNED" ONLY WHEN IT WAS ───────────
//
// 1. THE BUG (always on). A card read "deal signed" when nothing was signed
//    (Greg Glynn, athlete Amber, a veterinary hospital). Three ways that
//    happened, all fixed:
//      the BUTTON that marks a deal signed was drawn as a green "Deal signed"
//        pill on every unsigned row, the same look as the signed label
//      the Add Manual Deal form preselected Closed, so tracking a deal
//        signed it (My Brands reads Closed as signed)
//      the assistant logged a deal on "done"
//    A deal reads signed only from a logged deal the agent marked.
// 2. WHAT HAPPENED: Replied / No reply yet / Declined / Got a bounce email,
//    on the tracker (was "Action") and on Home's sent list.
// 3. NEXT STEP on the deal, and the agent's to-do list on Home.
// 4. ASK THE ATHLETE: an optional first stage before sending.
// 5. WHY: a decline needs a reason; signed or paid asks why it worked.
// 6. STAGES after Replied: Proposal and negotiation, Contract signed, Filed
//    with NIL Go, Cleared, Paid.
// 7. deal-reasons: each reason by business type and offer amount.
// Migrations are additive and idempotent; existing deals keep their status.
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..') + path.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('crmtest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SEND_GATE_ON;
delete process.env.EMAIL_FIVE_ON;
delete process.env.CRM_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();

const store = require(REPO + 'server/store.js');
const CRM = require(REPO + 'server/services/crm');
const DL = require(REPO + 'server/services/dealLog');
const Home = require(REPO + 'server/services/homeQueue');
const DR = require(REPO + 'server/services/dealReasons');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');
const on = () => { process.env.CRM_ON = '1'; };
const off = () => { delete process.env.CRM_ON; };

(async () => {
  const html = read('public/index.html');
  const idx = read('server/index.js');

  console.log('\n1. "DEAL SIGNED" ONLY WHEN IT WAS (always on)');
  ok('the action reads "Mark deal signed" on Home\'s sent rows and reply cards',
    /onclick="hqSentDeal\(' \+ Number\(r\.id\) \+ '\)">Mark deal signed<\/button>/.test(html) && /hqReplyDeal\([^\n]*>Mark deal signed<\/button>/.test(html)
    && !/>Deal signed<\/button>/.test(html));
  ok('  and it no longer looks like the signed label (no green, no bold): a dashed button', /\.hq-mark\.deal\{border-style:dashed\}/.test(html)
    && !/\.hq-mark\.deal\{[^}]*#84CC16/.test(html));
  ok('  the signed label is still the filled green chip, from a logged deal only', /\.hq-sentstate\.signed\{color:#84CC16;[^}]*background:rgba\(132,204,22,\.12\)/.test(html));
  ok('My Brands and the tracker: "Mark deal signed", a dashed button beside the status, not a pill', /border:1px dashed var\(--border\);cursor:pointer">Mark deal signed<\/button>'/.test(html)
    && /Deal signed \\u2713 Undo/.test(html));
  ok('the Pipeline card too', /Mark deal signed<\/button>' : ''\)/.test(read('public/pipeline.js')) && !/>Deal signed<\/button>/.test(read('public/pipeline.js')));
  ok('Add Manual Deal no longer preselects Closed: Prospecting is first and chosen, Closed says (signed)',
    /<select id="md-stage"[^>]*>\s*<option selected>Prospecting<\/option>[\s\S]{0,200}<option value="Closed">Closed \(signed\)<\/option>/.test(html));
  ok('  and the server no longer defaults a deal to Closed', /value: parseInt\(value\), stage: stage \|\| 'Prospecting',/.test(idx) && !/stage: stage \|\| 'Closed'/.test(idx));
  const AA = read('server/services/assistantActions.js');
  ok('the assistant logs a deal only when the agent says it was signed, never on "done"',
    /Use ONLY when the agent says in words that the business signed or the deal closed/.test(AA) && !/signed, closed or done/.test(AA)
    && /Never for "done", "finished", "sent", "reached out", "handled" or "followed up"/.test(AA));
  ok('"Got a bounce email" replaces "This bounced" everywhere', !/>This bounced</.test(html) && !/'This bounced'/.test(read('public/outreach-engine.js'))
    && (html.match(/Got a bounce email/g) || []).length >= 3);

  console.log('\n2. THE WORDS');
  const v = CRM.vocab();
  const labels = (l) => l.map((x) => x.label).join(' | ');
  ok('What happened: Replied, No reply yet, Declined, Got a bounce email', labels(v.what) === 'Replied | No reply yet | Declined | Got a bounce email', labels(v.what));
  ok('Next step: the eight, in order', labels(v.next) === 'Ask the athlete | Talk to athlete | Draft proposal | Negotiate | Send contract | File with NIL Go | Waiting on payment | Done', labels(v.next));
  ok('Stages after Replied: the five', labels(v.stages) === 'Proposal and negotiation | Contract signed | Filed with NIL Go | Cleared | Paid', labels(v.stages));
  ok('The optional first stage: Ask the athlete', v.ask.label === 'Ask the athlete');
  ok('Declined reasons: the eight', labels(v.decline) === "No budget | Doesn't understand NIL | Doesn't see the value in the athlete | Athlete doesn't have enough followers | Not comfortable with the agency | Not the right fit | Bad timing | Other", labels(v.decline));
  ok('Why it worked: the five', labels(v.win) === 'Loved the athlete | Loved the offer or menu item | Wanted brand recognition on campus | Promoting their specials | Other', labels(v.win));
  ok('no em dash in any of it', !/—/.test(JSON.stringify(v)));
  ok('a decline needs a reason from the list', !CRM.checkReason('declined', '').ok && CRM.checkReason('declined', '').error === 'Pick why they declined.' && !CRM.checkReason('declined', 'bogus').ok);
  ok('  "Other" needs a short note, kept to 200 characters', CRM.checkReason('declined', 'other', '').error === 'Add a short note for Other.'
    && CRM.checkReason('declined', 'other', 'x'.repeat(300)).note.length === 200 && CRM.checkReason('declined', 'no_budget').label === 'No budget');
  ok('why it worked, the same way', !CRM.checkReason('won', '').ok && CRM.checkReason('won', 'loved_offer').label === 'Loved the offer or menu item');

  console.log('\n3. THE DATABASE (Postgres)');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await DL.ensureTable(P);
  await CRM.ensureColumns(P); await CRM.ensureColumns(P);
  const cols = async (t) => (await P.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).rows.map((x) => x.column_name);
  const asd = await cols('athlete_self_deals');
  ok('migrations add the columns, and running them twice is fine', ['crm_stage', 'next_step', 'next_step_at', 'decline_reason', 'decline_note', 'win_reason', 'win_note'].every((c) => asd.includes(c))
    && (await cols('outreach_queue')).includes('decline_reason') && (await cols('deal_outcomes')).includes('win_reason'));

  const AG = 'crm-greg', AG2 = 'crm-other', ATH = 'crm-amber';
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1,'Greg Glynn','greg@agency.example','agent','x'), ($2,'Other','o@agency.example','agent','x')`, [AG, AG2]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3)`, [ATH, AG, JSON.stringify({ name: 'Amber Lee', school: 'Auburn University', dob: '2004-02-02', over18: 'true' })]);
  const sentCard = async (slot, brand, cat, offer, log) => (await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, sent_via, sent_at, contact_name, lane, business_category, offer_amount, offer_kind, outreach_log_id)
     VALUES ($1,$2,$3,$4,$5,'sent','email','email',NOW() - INTERVAL '2 days','Pat Owner','local',$6,$7,'cash',$8) RETURNING id`,
    [AG, ATH, slot, 'place:' + brand.toLowerCase().replace(/\W+/g, '-'), brand, cat, offer, log || null])).rows[0].id;
  const sentLog = async (id, brand) => P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_at, sent_to_email, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'NIL opportunity for ' || $4,'<div>Hi</div>','sent',NOW() - INTERVAL '2 days','owner@' || $5 || '.com',NOW(),NOW())`, [id, AG, ATH, brand, brand.toLowerCase().replace(/\W+/g, '')]);
  await sentLog('out_vet', 'Northside Veterinary Hospital');
  const vet = await sentCard(1, 'Northside Veterinary Hospital', 'pet', 250, 'out_vet');
  // Sending put it on the Pipeline at Outreach Sent, as Home's actions do.
  await require(REPO + 'server/services/pipeline').enterStage(P, { athleteId: ATH, agentId: AG, brandName: 'Northside Veterinary Hospital', stage: 'Outreach Sent' });

  console.log('\n   the veterinary hospital card, before and after');
  off();
  let h = await Home.buildHome(P, AG, { athleteId: ATH });
  let row = (h.sent || []).find((x) => x.business === 'Northside Veterinary Hospital');
  ok('sent, nothing marked: it is not signed', row && row.outcome === 'waiting' && !row.dealId, row);
  ok('  CRM_ON off: no CRM on the payload', h.crm === undefined && h.todo === undefined && row.crm === undefined);
  // A deal for the SAME business added by hand to track it, which used to default to Closed.
  await store.saveDeal('deal-manual-1', { athleteId: ATH, agentId: AG, brand: 'Some Other Clinic', campaign: 'Manual Entry', value: 300, stage: 'Prospecting', status: 'active' });
  const MB = require(REPO + 'server/services/myBrands.js');
  const mbRows = MB.buildRows(await MB.loadRaw(P, AG));
  const vetRow = (Array.isArray(mbRows) ? mbRows : []).find((x) => x.brand === 'Northside Veterinary Hospital');
  ok('My Brands: the veterinary hospital reads pitched, not deal signed', vetRow && vetRow.status === 'pitched', vetRow || mbRows);

  console.log('\n4. WHAT HAPPENED, ON A CARD (CRM_ON)');
  on();
  ok('the card outcome route asks why on a decline, and keeps the deal with the card',
    /_why = _crm\.checkReason\('declined', req\.body\.reason, req\.body\.note\);\s*if \(!_why\.ok\) return res\.status\(400\)/.test(idx)
    && /if \(_crm\) await _crm\.afterCardOutcome\(store\.pool, card, outcome, _why\)/.test(idx));
  const gym = await sentCard(2, 'Iron Gym', 'gym', 500);
  await P.query(`UPDATE outreach_queue SET outcome = 'declined' WHERE id = $1`, [gym]);
  await CRM.afterCardOutcome(P, { id: gym, agent_id: AG, athlete_id: ATH, brand_name: 'Iron Gym' }, 'declined', CRM.checkReason('declined', 'no_budget'));
  const gq = (await P.query(`SELECT decline_reason FROM outreach_queue WHERE id = $1`, [gym])).rows[0];
  const gd = await CRM.dealFor(P, AG, ATH, 'Iron Gym');
  ok('Declined: the reason is on the card and on the deal', gq.decline_reason === 'no_budget' && gd && gd.crm_stage === 'declined' && gd.decline_reason === 'no_budget', { gq, gd });
  await CRM.afterCardOutcome(P, { id: vet, agent_id: AG, athlete_id: ATH, brand_name: 'Northside Veterinary Hospital' }, 'replied', null);
  ok('Replied: the deal reads Replied', (await CRM.dealFor(P, AG, ATH, 'Northside Veterinary Hospital')).crm_stage === 'replied');

  console.log('\n5. STAGES, SIGNED ONLY WHEN MARKED');
  const ref = { cardId: 'queue:' + vet };
  let u = await CRM.update(P, AG, ref, { stage: 'proposal' });
  ok('Proposal and negotiation: the deal moves on the board to Negotiating', u.ok && u.deal.stage === 'proposal' && u.deal.board === 'Negotiating', u);
  u = await CRM.update(P, AG, ref, { stage: 'contract_signed' });
  ok('Contract signed with no logged deal is refused: mark the deal signed first', !u.ok && u.status === 409 && u.needs === 'deal', u);
  u = await CRM.update(P, AG, ref, { stage: 'paid' });
  ok('  Paid too', !u.ok && u.needs === 'deal');
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  row = (h.sent || []).find((x) => x.business === 'Northside Veterinary Hospital');
  ok('  so the card is still not signed', row.outcome !== 'signed' && !row.dealId, row);
  const bad = await DL.logDeal(P, { agentId: AG, athleteId: ATH, queueId: vet, value: 400, winReason: 'bogus' });
  ok('marking it signed checks why it worked', !bad.ok && /Pick why it worked/.test(bad.error));
  const dl = await DL.logDeal(P, { agentId: AG, athleteId: ATH, queueId: vet, value: 400, winReason: 'loved_athlete' });
  const out = (await P.query(`SELECT win_reason, deal_value FROM deal_outcomes WHERE id = $1`, [dl.id])).rows[0];
  let vd = await CRM.dealFor(P, AG, ATH, 'Northside Veterinary Hospital');
  ok('the agent marks it signed: logged, why it worked kept, and the stage reads Contract signed', dl.ok && out.win_reason === 'loved_athlete' && vd.crm_stage === 'contract_signed' && vd.win_reason === 'loved_athlete', { out, vd });
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  row = (h.sent || []).find((x) => x.business === 'Northside Veterinary Hospital');
  ok('  and only now Home says signed', row.outcome === 'signed' && !!row.dealId && row.crm.stageLabel === 'Contract signed' && row.crm.winLabel === 'Loved the athlete', row);
  u = await CRM.update(P, AG, ref, { stage: 'filed_nil_go' });
  ok('Filed with NIL Go', u.ok && u.deal.stageLabel === 'Filed with NIL Go');
  u = await CRM.update(P, AG, ref, { stage: 'cleared' });
  u = await CRM.update(P, AG, ref, { stage: 'paid' });
  vd = await CRM.dealFor(P, AG, ATH, 'Northside Veterinary Hospital');
  ok('Cleared, then Paid (why it worked already on record), with the paid date', u.ok && u.deal.stageLabel === 'Paid' && !!vd.paid_date, u);
  // A signed deal logged with no reason (the assistant) is asked why before Paid.
  const tacos = await sentCard(3, 'Taco Stand', 'restaurant', 250);
  await DL.logDeal(P, { agentId: AG, athleteId: ATH, queueId: tacos, value: 250 });
  u = await CRM.update(P, AG, { cardId: 'queue:' + tacos }, { stage: 'paid' });
  ok('Paid with no "why it worked" on record asks for it', !u.ok && u.needs === 'why' && u.error === 'Pick why it worked.', u);
  u = await CRM.update(P, AG, { cardId: 'queue:' + tacos }, { stage: 'paid', reason: 'loved_offer' });
  const to = (await P.query(`SELECT win_reason FROM deal_outcomes WHERE agent_id = $1 AND brand = 'Taco Stand'`, [AG])).rows[0];
  ok('  given, it is kept on the deal and its logged outcome', u.ok && u.deal.winLabel === 'Loved the offer or menu item' && to.win_reason === 'loved_offer', { u, to });
  ok('another agent cannot touch the deal', (await CRM.update(P, AG2, ref, { nextStep: 'negotiate' })).status === 404);
  ok('an unknown stage or next step is refused', (await CRM.update(P, AG, ref, { stage: 'won' })).status === 400 && (await CRM.update(P, AG, ref, { nextStep: 'party' })).status === 400);

  console.log('\n6. NEXT STEP AND THE TO-DO LIST');
  await CRM.update(P, AG, { cardId: 'queue:' + gym }, { nextStep: 'talk_athlete' });
  await CRM.update(P, AG, ref, { nextStep: 'waiting_payment' });
  let td = await CRM.todo(P, AG);
  ok('the to-do list is every deal with a next step, oldest first', td.length === 2 && td[0].business === 'Iron Gym' && td[0].nextStepLabel === 'Talk to athlete'
    && td[1].nextStepLabel === 'Waiting on payment' && td[0].athlete === 'Amber Lee', td);
  await CRM.update(P, AG, { dealId: td[0].dealId }, { nextStep: 'done' });
  td = await CRM.todo(P, AG);
  ok('  Done takes it off', td.length === 1 && td[0].business === 'Northside Veterinary Hospital', td);
  ok('  another agent sees none of it', (await CRM.todo(P, AG2)).length === 0);
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  ok('Home carries the words, the to-do list, and each sent row\'s deal and email', h.crm && h.crm.next.length === 8 && h.todo.length === 1
    && (h.sent || []).find((x) => x.business === 'Northside Veterinary Hospital').logId === 'out_vet'
    && (h.sent || []).find((x) => x.business === 'Iron Gym').crm.declineLabel === 'No budget', { todo: h.todo, errors: h.errors });

  console.log('\n7. ASK THE ATHLETE, BEFORE SENDING');
  const qd = (await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, lane) VALUES ($1,$2,4,'place:books','Campus Books','queued','dm','local') RETURNING id`, [AG, ATH])).rows[0].id;
  u = await CRM.update(P, AG, { cardId: 'queue:' + qd }, { stage: 'ask_athlete' });
  ok('a card not sent yet: Ask the athlete, a Pipeline row at Prospecting, and it is the next step', u.ok && u.deal.stage === 'ask_athlete' && u.deal.board === 'Prospecting' && u.deal.nextStep === 'ask_athlete', u);
  u = await CRM.update(P, AG, ref, { stage: 'ask_athlete' });
  ok('  a card already sent: refused, it is the step before sending', !u.ok && u.status === 409, u);

  console.log('\n8. WHAT HAPPENED, ON THE TRACKER (an email)');
  await sentLog('out_bake', 'Sweet Bakery');
  await sentCard(5, 'Sweet Bakery', 'food', 250, 'out_bake');
  let dlr = await CRM.declineLog(P, AG, 'out_bake', '', '');
  ok('Declined with no reason is refused', !dlr.ok && dlr.status === 400 && dlr.error === 'Pick why they declined.');
  dlr = await CRM.declineLog(P, AG, 'out_bake', 'other', 'Owner retiring');
  const bl = (await P.query(`SELECT status, replied_at FROM outreach_logs WHERE id = 'out_bake'`)).rows[0];
  const bq = (await P.query(`SELECT outcome, decline_reason, decline_note FROM outreach_queue WHERE outreach_log_id = 'out_bake'`)).rows[0];
  const bd = await CRM.dealFor(P, AG, ATH, 'Sweet Bakery');
  ok('Declined (Other, with a note): the email is answered, its card and deal say declined, with why', dlr.ok && bl.status === 'replied' && !!bl.replied_at
    && bq.outcome === 'declined' && bq.decline_reason === 'other' && bq.decline_note === 'Owner retiring' && bd.crm_stage === 'declined', { bl, bq, bd });
  ok('  another agent\'s email is not found', (await CRM.declineLog(P, AG2, 'out_bake', 'no_budget')).status === 404);
  await sentLog('out_cafe', 'Corner Cafe');
  await require(REPO + 'server/services/pipeline').enterStage(P, { athleteId: ATH, agentId: AG, brandName: 'Corner Cafe', stage: 'Outreach Sent' });
  const bo = await CRM.bounceLog(P, AG, 'out_cafe');
  const bc = (await P.query(`SELECT bounced_at FROM outreach_logs WHERE id = 'out_cafe'`)).rows[0];
  ok('Got a bounce email: the address gets no more email, and the deal says bounced', bo.ok && bo.suppressed === 'owner@cornercafe.com' && !!bc.bounced_at
    && (await CRM.dealFor(P, AG, ATH, 'Corner Cafe')).crm_stage === 'bounced', bo);
  await CRM.afterLogReply(P, AG, 'out_cafe', true);
  ok('  marked Replied after all (it was a wrong bounce), the deal follows', (await CRM.dealFor(P, AG, ATH, 'Corner Cafe')).crm_stage === 'replied');
  const OR = read('server/routes/outreach.js');
  ok('the tracker\'s list says what happened to each email, and its deal', /row\.whatHappened = row\.bounced_at \? 'bounced'/.test(OR) && /row\.crm = CRM\.payloadOf\(d\);/.test(OR)
    && /if \(CRM\.ON\(\)\) await CRM\.afterLogReply\(pool, req\.principal\.id, log\.id, replied\)/.test(OR));
  ok('the routes are behind the switch', /app\.post\('\/api\/agent\/crm\/deal', requireAuth/.test(idx) && /app\.post\('\/api\/agent\/crm\/declined', requireAuth/.test(idx)
    && /app\.post\('\/api\/agent\/crm\/bounced', requireAuth/.test(idx) && (idx.match(/if \(!CRM\.ON\(\)\) return _crmOff\(res\);/g) || []).length === 3);

  console.log('\n9. EXISTING DEALS KEEP THEIR STATUS');
  const old = (await P.query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, stage, value) VALUES ($1,$2,'Old Closed Deal','Closed',900) RETURNING *`, [ATH, AG])).rows[0];
  const p0 = CRM.payloadOf(old);
  ok('a deal closed before the CRM reads Contract signed, and its row is not rewritten', p0.stage === 'contract_signed' && p0.stageLabel === 'Contract signed'
    && (await P.query(`SELECT crm_stage, stage FROM athlete_self_deals WHERE id = $1`, [old.id])).rows[0].crm_stage === null);
  ok('  nothing else is assumed: a deal at Outreach Sent has no CRM stage', CRM.payloadOf({ id: 1, stage: 'Outreach Sent' }).stage === null);

  console.log('\n10. THE PAGES (CRM_ON)');
  ok('the tracker\'s column is "What happened" with the CRM on, "Action" without', /\(crm \? 'What happened' : 'Action'\)/.test(html) && /trackerCrmCell\(row, crm\)/.test(html));
  ok('  Declined asks why before it saves', /crmWhyOpen\('declined', 'Why did they decline\?'/.test(html) && /'\/api\/agent\/crm\/declined', \{ logId: id, reason: w\.reason, note: w\.note \}/.test(html));
  ok('Home: the to-do list above the news, and the sent row\'s three controls', /news\.innerHTML = hqFaultsHtml\(d\) \+ hqTodoHtml\(d\) \+ hqNewsHtml\(d\);/.test(html)
    && /<span>What happened<\/span>/.test(html) && /<span>Stage<\/span>/.test(html) && /<span>Next step<\/span>/.test(html));
  ok('  a decline from Home asks why too', /if \(outcome === 'declined' && !why && typeof crmV === 'function' && crmV\(\)\) \{\s*crmWhyOpen\('declined'/.test(html));
  ok('  Ask the athlete first, on a card before it goes out', /\+ hqAskHtml\(c, i\)/.test(html) && /stage: 'ask_athlete'/.test(html));
  ok('the deal form asks why it worked with the CRM on', /id="deal-form-why"/.test(html) && /body\.winReason = document\.getElementById\('deal-form-why'\)\.value/.test(html)
    && /winReason: b\.winReason \|\| null, winNote: b\.winNote \|\| null/.test(idx));
  ok('the Pipeline card shows its stage and next step', /function crmLine\(d\)/.test(read('public/pipeline.js')) && /crm: require\('\.\/services\/crm'\)\.payloadOf\(r\)/.test(idx));
  // The sent row, drawn: a real reply is not "signed"; a logged deal is.
  const grab = (re) => { const m = html.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
  const env = new Function('HQ', 'escHtml', grab(/function crmOpts[\s\S]*?\n}\n/) + grab(/function hqSentCrm[\s\S]*?\n}\n/) + '; return { hqSentCrm };')(
    {}, (s) => String(s == null ? '' : s));
  global.hqEscape = (s) => String(s == null ? '' : s);
  const drawn = env.hqSentCrm({ id: 9, outcome: 'replied', business: 'Northside Veterinary Hospital', crm: { stage: 'proposal' } }, v);
  ok('a replied row reads Replied, with a stage and a next step, and "Mark deal signed": never the signed label', /value="replied" selected>Replied</.test(drawn.btns)
    && /value="proposal" selected>Proposal and negotiation</.test(drawn.btns) && /Mark deal signed/.test(drawn.btns) && !/hq-sentstate signed/.test(drawn.state), drawn);
  const drawn2 = env.hqSentCrm({ id: 9, outcome: 'signed', dealId: 4, dealValue: 400, crm: { stage: 'paid', winLabel: 'Loved the athlete' } }, v);
  ok('  a logged deal reads "Deal signed", with why it worked, and no Mark button', /hq-sentstate signed">Deal signed &middot; \$400/.test(drawn2.state) && /Why it worked: Loved the athlete/.test(drawn2.state)
    && !/Mark deal signed/.test(drawn2.btns), drawn2);

  console.log('\n11. deal-reasons');
  await P.query(`UPDATE outreach_queue SET decline_reason = 'no_budget', outcome = 'declined', outcome_at = NOW() WHERE id = $1`, [tacos]).catch(() => {});
  const data = await DR.gather(P, {});
  const sum = DR.summarize(data);
  const nb = sum.declines.find((x) => x.reason === 'no_budget');
  ok('declines counted by reason, business type and offer amount', nb && nb.total === 2 && nb.byType.some((x) => x.type === 'gym' && x.n === 1)
    && nb.byOffer.some((x) => x.offer === '$500' && x.n === 1) && nb.cells.some((x) => x.type === 'restaurant' && x.offer === '$250' && x.n === 1), nb);
  const oth = sum.declines.find((x) => x.reason === 'other');
  ok('  "Other" shows its notes', oth && oth.notes.some((n) => n.note === 'Owner retiring'), oth);
  ok('  a decline marked on an email with no card is counted once, from its card', sum.declineTotal === 3, sum.declineTotal);
  const la = sum.wins.find((x) => x.reason === 'loved_athlete');
  ok('wins counted the same way, from the logged deals', la && la.total === 1 && sum.wins.find((x) => x.reason === 'loved_offer').total === 1, sum.wins);
  const { spawnSync } = require('child_process');
  const run = (file, args) => spawnSync(process.execPath, [REPO + file, ...args], { env: { ...process.env, INIT_WAIT_MS: '2500' }, encoding: 'utf8', timeout: 120000 });
  const rep = run('scripts/deal-reasons.js', ['--agent', 'greg@agency.example']);
  ok('the admin script prints it, by agent', /WHY THEY DECLINED: 3/.test(rep.stdout) && /No budget\s+2/.test(rep.stdout) && /by offer amount:\s+\$250 1, \$500 1/.test(rep.stdout)
    && /WHY IT WORKED: 2/.test(rep.stdout) && /note: "Owner retiring" \(Sweet Bakery\)/.test(rep.stdout), rep.stdout + rep.stderr);
  const D = require(REPO + 'server/scripts/admin/deal-reasons.js');
  ok('  its descriptor: one file, days and agent cleaned', D.name === 'deal-reasons' && D.file === 'scripts/deal-reasons.js'
    && JSON.stringify(D.args({ days: '30', agent: 'greg@agency.example;rm' })) === JSON.stringify(['--days', '30', '--agent', 'greg@agency.examplerm']));
  await store.saveDeal('deal-manual-2', { athleteId: ATH, agentId: AG, brand: 'Hand Typed Spa', campaign: 'Manual Entry', value: 200, stage: 'Closed', status: 'closed' });
  const why = run('scripts/signed-why.js', ['--agent', 'greg@agency.example', '--athlete', 'Amber']);
  ok('signed-why traces every signed record to where it came from', /Northside Veterinary Hospital for Amber Lee: signed with a logged deal/.test(why.stdout)
    && /Hand Typed Spa for Amber Lee: NO LOGGED DEAL/.test(why.stdout) && /the Add Manual Deal form, which preselected Closed/.test(why.stdout), why.stdout + why.stderr);
  const SW = require(REPO + 'server/scripts/admin/signed-why.js');
  ok('  its descriptor', SW.name === 'signed-why' && JSON.stringify(SW.args({ agent: 'g@x.com', brand: 'veterinary' })) === JSON.stringify(['--agent', 'g@x.com', '--brand', 'veterinary']));

  off();
  ok('CRM_ON off: no to-do list, no words, the routes answer 404', (await Home.buildHome(P, AG, { athleteId: ATH })).crm === undefined && !CRM.ON());

  await P.end().catch(() => {});
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
