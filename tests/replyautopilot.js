'use strict';
// ── THE CRM FILLS ITSELF IN WHEN A BUSINESS REPLIES (services/replyAutopilot) ──
// Local test Postgres. The model and the email are stand-ins.
//
//   - off (CRM_AUTO_ON unset): nothing happens, and markReplied behaves as before;
//   - interested: deal to Negotiating, CRM stage Replied, next step Negotiate,
//     the suggested reply saved, one email to the agent who sent the pitch;
//   - a no: stage Replied, the board not moved past Outreach Sent, no next step;
//   - never twice for one reply; never a deal moved backward;
//   - the reader: quoted pitch removed, bad model output survives, no em dashes;
//   - the email escapes what it prints and names only that agent's deal.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('replyautopilottest', { schema: true });
delete process.env.CRM_AUTO_ON;
require('./helpers/offlineDns').install();

const store = require(REPO + 'server/store.js');
const RA = require(REPO + 'server/services/replyAutopilot.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;

function fakes(json) {
  const calls = { prompts: [], sent: [] };
  return {
    calls,
    deps: {
      oneShot: async (prompt) => { calls.prompts.push(prompt); return typeof json === 'string' ? json : JSON.stringify(json); },
      send: async (to, msg) => { calls.sent.push({ to, msg }); },
    },
  };
}
async function log(id, brand, replyText, extra = {}) {
  await P().query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, sent_at, replied_at, reply_text)
     VALUES ($1, $2, $3, $4, $5, $6, 'replied', $7, NOW() - INTERVAL '2 days', NOW(), $8)`,
    [id, extra.agent || 'ra-agent', extra.athlete || 'ra-ath', brand, `Quick idea for ${brand}`,
      `<p>Hi Dana, I wanted to call your attention to Jay Runner, guard on the Texas State team.</p><p>Would you like to learn more?</p>`,
      'dana@' + brand.toLowerCase().replace(/\W+/g, '') + '.test', replyText]);
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await P().query(`INSERT INTO users (id, name, email, password, role, scheduling_url) VALUES
    ('ra-agent', 'Ann Agent', 'ann@agents.test', 'x', 'agent', 'https://cal.test/ann'),
    ('ra-other', 'Otto Other', 'otto@agents.test', 'x', 'agent', NULL)`);
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ra-ath', 'ra-agent', '{"name":"Jay Runner","school":"Texas State","sport":"Basketball"}'::jsonb)`);

  // ── OFF ───────────────────────────────────────────────────────────────
  OUT.push('-- off --');
  await log('ra-off', 'Off Shop', 'Sounds good, tell me more.');
  const off = await RA.onReply(P(), 'ra-off', { deps: fakes({}).deps });
  ok('off: does nothing', off.skipped === 'CRM_AUTO_ON is off');
  const FU = require(REPO + 'server/services/followUpAutomation.js');
  await FU.markReplied('ra-off', new Date());
  await new Promise((r) => setTimeout(r, 300));
  ok('off: markReplied leaves the new columns alone', !(await P().query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'outreach_logs' AND column_name = 'reply_handled_at'`)).rowCount
    || (await P().query(`SELECT reply_handled_at FROM outreach_logs WHERE id = 'ra-off'`)).rows[0].reply_handled_at === null);

  process.env.CRM_AUTO_ON = '1';

  // ── INTERESTED ────────────────────────────────────────────────────────
  OUT.push('', '-- interested --');
  await log('ra-yes', 'Smoothie Hut', 'Hi Ann,\nThis sounds great. What would Jay post, and how often?\nThanks,\nDana\n\nOn Tue, Oct 27, 2026 at 9:01 AM Ann Agent wrote:\n> Hi Dana, I wanted to call your attention to Jay');
  const y = fakes({ intent: 'question', summary: 'Dana asked what Jay would post and how often.',
    draft: 'Hi Dana,\n\nGreat question — Jay usually does game day and training content. I can walk you through options on a quick call: https://cal.test/ann\n\nAnn' });
  const r1 = await RA.onReply(P(), 'ra-yes', { deps: y.deps });
  ok('handled: a question, a draft, one email', r1.intent === 'question' && r1.drafted && r1.emailed, r1);
  ok('the model read only their words, not the quoted pitch', y.calls.prompts[0].includes('What would Jay post') && !/^> Hi Dana/m.test(y.calls.prompts[0].split('THE BUSINESS REPLIED:')[1] || ''));
  ok('the prompt carries the scheduling link and forbids prices', /https:\/\/cal\.test\/ann/.test(y.calls.prompts[0]) && /Never name a price/.test(y.calls.prompts[0]));
  const row = (await P().query(`SELECT reply_intent, reply_summary, reply_draft, reply_handled_at FROM outreach_logs WHERE id = 'ra-yes'`)).rows[0];
  ok('saved on the outreach: intent, summary, draft without em dashes', row.reply_intent === 'question' && /how often/.test(row.reply_summary)
    && row.reply_draft && !/—/.test(row.reply_draft) && row.reply_handled_at, row);
  const deal = (await P().query(`SELECT stage, crm_stage, next_step FROM athlete_self_deals WHERE athlete_id = 'ra-ath' AND brand_name = 'Smoothie Hut'`)).rows[0];
  ok('the deal: Negotiating, Replied, next step Negotiate', deal && deal.stage === 'Negotiating' && deal.crm_stage === 'replied' && deal.next_step === 'negotiate', deal);
  const mail = y.calls.sent[0];
  ok('one email, to the agent who sent the pitch', y.calls.sent.length === 1 && mail.to === 'ann@agents.test');
  ok('the email: who, which athlete, what they said, the suggested reply, what moved', mail && /Smoothie Hut replied about Jay Runner/.test(mail.msg.subject)
    && /What would Jay post/.test(mail.msg.text) && /A reply you can send/.test(mail.msg.text) && /moved this deal to Negotiating/.test(mail.msg.text), mail && mail.msg.text);

  // ── ONCE ──────────────────────────────────────────────────────────────
  OUT.push('', '-- once --');
  const y2 = fakes({ intent: 'interested', summary: 'x', draft: 'y' });
  const again = await RA.onReply(P(), 'ra-yes', { deps: y2.deps });
  ok('never twice for one reply', /already handled/.test(again.skipped || '') && y2.calls.sent.length === 0 && y2.calls.prompts.length === 0);

  // ── A NO ──────────────────────────────────────────────────────────────
  OUT.push('', '-- a no --');
  await log('ra-no', 'Tire Barn', 'Not interested at this time, thanks.');
  const n = fakes({ intent: 'not_interested', summary: 'Not interested right now.', draft: 'Hi,\n\nThanks for letting me know. If anything changes, I am here.\n\nAnn' });
  await RA.onReply(P(), 'ra-no', { deps: n.deps });
  const nd = (await P().query(`SELECT stage, crm_stage, next_step FROM athlete_self_deals WHERE athlete_id = 'ra-ath' AND brand_name = 'Tire Barn'`)).rows[0];
  ok('a no: Replied, board Outreach Sent, no next step (the agent decides the decline)', nd && nd.stage === 'Outreach Sent' && nd.crm_stage === 'replied' && !nd.next_step, nd);
  ok('a no: the email says so and marks it Replied', /Sounds like a no/.test(n.calls.sent[0].msg.text) && /marked this deal Replied/.test(n.calls.sent[0].msg.text));

  // ── NEVER BACKWARD ────────────────────────────────────────────────────
  OUT.push('', '-- never backward --');
  await P().query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, deal_type, stage, crm_stage, next_step, source)
    VALUES ('ra-ath', 'ra-agent', 'Pool Patio', 'Other', 'Closing', 'contract_signed', 'file_nil_go', 'test')`);
  await log('ra-late', 'Pool Patio', 'Sending the signed copy now.');
  await RA.onReply(P(), 'ra-late', { deps: fakes({ intent: 'interested', summary: 's', draft: 'd' }).deps });
  const ld = (await P().query(`SELECT stage, crm_stage, next_step FROM athlete_self_deals WHERE brand_name = 'Pool Patio'`)).rows[0];
  ok('a signed deal stays signed: stage, CRM stage and next step untouched', ld.stage === 'Closing' && ld.crm_stage === 'contract_signed' && ld.next_step === 'file_nil_go', ld);

  // ── THE READER ────────────────────────────────────────────────────────
  OUT.push('', '-- the reader --');
  await log('ra-junk', 'Junk Co', 'Maybe? Call me.');
  const junk = fakes('I am not JSON at all');
  const rj = await RA.onReply(P(), 'ra-junk', { deps: junk.deps });
  ok('model output that is not JSON: unclear, no draft, still emailed and still moved', rj.intent === 'unclear' && !rj.drafted && rj.emailed
    && (await P().query(`SELECT crm_stage FROM athlete_self_deals WHERE brand_name = 'Junk Co'`)).rows[0].crm_stage === 'replied');
  ok('an unknown intent reads as unclear', RA.parse('{"intent":"thrilled","summary":"a","draft":"b"}').intent === 'unclear');
  ok('own words: quoted lines and the "wrote:" tail removed', RA.ownWords('Yes please.\n\nOn Mon, Oct 1, 2026 at 9 AM X wrote:\n> old pitch') === 'Yes please.');
  const failing = { oneShot: async () => { throw new Error('model down'); }, send: async () => {} };
  await log('ra-down', 'Down Co', 'Interested.');
  const rd = await RA.onReply(P(), 'ra-down', { deps: failing });
  ok('the model down: the deal still moves and the agent is still told', rd.intent === 'unclear' && rd.dealId);

  // ── ESCAPING AND OWNERSHIP ────────────────────────────────────────────
  OUT.push('', '-- escaping and ownership --');
  const m = RA.alertFor({ brand: '<b>Evil</b> & Co', athlete: 'Jay', reply: '<script>x</script>', subject: 's' }, { intent: 'interested', draft: '<img src=x>' });
  ok('the email escapes the business, the reply and the draft', !/<script>|<img src=x>|<b>Evil<\/b>/.test(m.html) && /&lt;script&gt;/.test(m.html));
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ra-ath2', 'ra-other', '{"name":"Kim Swim"}'::jsonb)`);
  await log('ra-otto', 'Otto Shop', 'Yes, interested.', { agent: 'ra-other', athlete: 'ra-ath2' });
  const o = fakes({ intent: 'interested', summary: 's', draft: 'd' });
  await RA.onReply(P(), 'ra-otto', { deps: o.deps });
  ok('another agent\'s reply goes only to that agent', o.calls.sent.length === 1 && o.calls.sent[0].to === 'otto@agents.test');

  // ── THROUGH markReplied ───────────────────────────────────────────────
  OUT.push('', '-- through markReplied --');
  await P().query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, sent_at)
    VALUES ('ra-mr', 'ra-agent', 'ra-ath', 'Live Shop', 's', '<p>pitch</p>', 'sent', 'x@live.test', NOW() - INTERVAL '1 day')`);
  const savedKey = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;   // no real email can leave
  await FU.markReplied('ra-mr', new Date(), { text: 'Interested!', from: 'x@live.test', subject: 'Re: s' });
  await new Promise((r) => setTimeout(r, 1500));
  const mr = (await P().query(`SELECT reply_handled_at FROM outreach_logs WHERE id = 'ra-mr'`)).rows[0];
  ok('markReplied starts it (claimed once, deal moved)', !!mr.reply_handled_at
    && !!(await P().query(`SELECT 1 FROM athlete_self_deals WHERE brand_name = 'Live Shop' AND crm_stage = 'replied'`)).rowCount);
  await P().query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, sent_at)
    VALUES ('ra-amb', 'ra-agent', 'ra-ath', 'Maybe Shop', 's', '<p>pitch</p>', 'sent', 'x@maybe.test', NOW() - INTERVAL '1 day')`);
  await FU.markReplied('ra-amb', new Date(), { text: 'Yes', autopilot: false });
  await new Promise((r) => setTimeout(r, 800));
  ok('an ambiguous match (autopilot: false) moves nothing and drafts nothing', (await P().query(`SELECT reply_handled_at FROM outreach_logs WHERE id = 'ra-amb'`)).rows[0].reply_handled_at === null
    && !(await P().query(`SELECT 1 FROM athlete_self_deals WHERE brand_name = 'Maybe Shop'`)).rowCount);
  const RI = require('fs').readFileSync(REPO + 'server/routes/resendInbound.js', 'utf8');
  ok('the reply-domain path: the old email only when the autopilot is off or the match is ambiguous', /markReplied\(logRow\.id, [^;]*\{ autopilot: !ambiguous \}\)/.test(RI)
    && /if \(!require\('\.\.\/services\/replyAutopilot'\)\.ON\(\) \|\| ambiguous\)/.test(RI));
  if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
