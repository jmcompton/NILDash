'use strict';
//   node tests/sendfaults.js
//
// ── NOTHING FAILS SILENTLY ──────────────────────────────────────────────────
// An approval that has not sent within two hours is a fault: a line on the
// agent's Home with the reason in plain words and what to do, one email to the
// agent, and a line in the admin's morning alert. Every way releaseDue can end
// an approval without a send is covered. And the send path looks in our own
// address cache before it gives up with "no address to send to".
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const SF = require(REPO + 'server/services/sendFaults.js');
const C = require(REPO + 'server/services/closer.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 800) : '')); } };
const AG = 'sf-agent', AG2 = 'sf-agent2', ATH = 'sf-ath';
const H = 3600 * 1000;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SF.ensureTable(P);
  const clean = async () => {
    for (const a of [AG, AG2]) {
      await P.query(`DELETE FROM approval_faults WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM compliance_holds WHERE agent_id = $1`, [a]).catch(() => {});
      for (const t of ['outreach_logs', 'outreach_queue']) await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM users WHERE id = $1`, [a]).catch(() => {});
    }
    await P.query(`DELETE FROM brand_evidence_cache WHERE LOWER(brand) IN ('central city toyota','hornsdownshop','contacts cached co')`).catch(() => {});
    await P.query(`DELETE FROM approval_faults WHERE log_id LIKE 'sf-%'`).catch(() => {});
    // What this test records as our fault is removed with it (the shared test
    // database feeds other suites' "our failures" counts).
    await P.query(`DELETE FROM service_faults WHERE (service = 'send-fault' AND context LIKE 'sendFaults %') OR service = 'send-fault-email'`).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email = 'gone@sf-bounce.test'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Jabree Sample','jabree.sf@belcher.test','x','agent'), ($2,'Quiet Agent','quiet.sf@x.test','x','agent')`, [AG, AG2]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [ATH, AG, JSON.stringify({ name: 'Mataya Sample', school: 'Auburn University' })]);
  const now = Date.now();
  const row = (id, brand, o = {}) => P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,sent_at,cadence_stopped_at,cadence_stop_reason,send_hold_reason,send_error,touch_no,created_at)
     VALUES ($1,$2,$3,$4,'Hi','<p>Hi Pat,</p><p>x</p>',$5,$6,$7,$7,$8,$9,$10,$11,$12,1,$7)`,
    [id, o.agent || AG, ATH, brand, o.status || 'approved', o.to === undefined ? 'owner@' + brand.toLowerCase().replace(/\W/g, '') + '.test' : o.to,
      new Date(now - (o.agoH || 3) * H), o.sent ? new Date(now - H) : null, o.stopped ? new Date(now - 0.1 * H) : null, o.stopped || null, o.hold || null, o.err || null]);
  await row('sf-silent', 'Silent Grill');
  await row('sf-mailbox', 'Mailbox Cafe', { hold: 'the mailbox could not send (reconnect it in Settings): invalid_grant' });
  await row('sf-noaddr', 'Nowhere Shop', { agoH: 0.2, stopped: 'no address to send to', to: null });
  await row('sf-fresh', 'Fresh Bakery', { agoH: 0.5 });
  await row('sf-sent', 'Sent Gym', { status: 'sent', sent: true });
  await row('sf-compliance', 'Held Studio', { hold: 'compliance: the athlete has no date of birth on file' });
  await row('sf-limit', 'Limit Auto', { hold: "today's sending ceiling is reached (40 a day)" });
  await row('sf-bounce', 'Bounced Bar', { agoH: 0.3, stopped: 'previously bounced' });
  await row('sf-replied', 'Replied Deli', { agoH: 0.3, stopped: 'they replied before this went out' });
  await row('sf-fail', 'Failing Florist', { err: '550 relay denied', hold: 'the send failed and will be retried: 550 relay denied' });
  await row('sf-old', 'Old Bike Shop', { agoH: 24 * 10 });
  await row('sf-canspam', 'Footer Cafe', { hold: 'BUSINESS_MAILING_ADDRESS is not set, so the CAN-SPAM footer cannot be written' });
  // Another agent mid-way through a bulk approve: their mailbox sent a minute ago.
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('sf-ath2',$1,'{"name":"Other Athlete"}'::jsonb) ON CONFLICT DO NOTHING`, [AG2]);
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,sent_at,touch_no)
                 VALUES ('sf-line-sent',$1,'sf-ath2','Sent One','Hi','x','sent','a@a.test',NOW() - INTERVAL '3 hours',NOW() - INTERVAL '3 hours',NOW() - INTERVAL '1 minute',1),
                        ('sf-in-line',$1,'sf-ath2','In Line','Hi','x','approved','b@b.test',NOW() - INTERVAL '3 hours',NOW() - INTERVAL '3 hours',NULL,1)`, [AG2]);

  // ── DETECT ────────────────────────────────────────────────────────────────
  OUT.push('-- every way an approval can end without a send is a fault --');
  const s = await SF.sweep(P);
  const f = Object.fromEntries((await P.query(`SELECT * FROM approval_faults WHERE agent_id = $1`, [AG])).rows.map((r) => [r.log_id, r]));
  ok('APPROVED, NOT SENT, OVER TWO HOURS: a fault, every kind', ['sf-silent', 'sf-mailbox', 'sf-compliance', 'sf-limit', 'sf-fail', 'sf-old'].every((id) => f[id]), Object.keys(f));
  ok('  stopped for good: a fault at once, not after two hours', f['sf-noaddr'] && f['sf-bounce'] && f['sf-replied']);
  ok('  approved 30 minutes ago and still moving: not yet', !f['sf-fresh']);
  ok('  STILL IN LINE IS NOT STUCK: a bulk approve the queue is still sending (the agent\'s mailbox sent a minute ago) is not a fault',
    !(await P.query(`SELECT 1 FROM approval_faults WHERE log_id = 'sf-in-line'`)).rows.length);
  ok('  our missing footer address: our fault, said as ours', f['sf-canspam'] && f['sf-canspam'].kind === 'ours' && /Our footer settings were missing/.test(f['sf-canspam'].why), f['sf-canspam']);
  ok('  sent: never a fault', !f['sf-sent']);
  ok('NEVER PICKED UP, NOTHING RECORDED: said as OUR fault, and recorded as one', f['sf-silent'].kind === 'ours' && f['sf-silent'].ours === true && /our send queue never picked it up/.test(f['sf-silent'].why)
    && (await P.query(`SELECT 1 FROM service_faults WHERE service = 'send-fault' AND context = 'sendFaults sf-silent'`).catch(() => ({ rows: [] }))).rows.length >= 1);
  ok('THE REASON IN PLAIN WORDS, AND WHAT TO DO', /email account is disconnected/.test(f['sf-mailbox'].why) && /Reconnect your mailbox in Settings/.test(f['sf-mailbox'].fix)
    && /no email address/.test(f['sf-noaddr'].why) && /date of birth/.test(f['sf-compliance'].fix) && /can send today/.test(f['sf-limit'].why) && /go out automatically/.test(f['sf-limit'].fix)
    && /bounced/.test(f['sf-bounce'].why) && /replied/.test(f['sf-replied'].why) && /refused it: 550 relay denied/.test(f['sf-fail'].why),
    Object.values(f).map((x) => [x.log_id, x.kind, x.why, x.fix]));

  // ── HOME ──────────────────────────────────────────────────────────────────
  OUT.push('', '-- the agent sees it on Home --');
  const Home = require(REPO + 'server/services/homeQueue.js');
  const h = await Home.buildHome(P, AG, {});
  ok('"N APPROVALS DID NOT SEND. HERE IS WHY." on Home, each with its reason and what to do', h.sendFaults && h.sendFaults.count === 10
    && h.sendFaults.rows.every((r) => r.business && r.why && r.fix) && h.sendFaults.rows.some((r) => r.athlete === 'Mataya Sample'), h.sendFaults);
  const page = require('fs').readFileSync(REPO + 'public/index.html', 'utf8');
  ok('  drawn first on Home, above everything, with a dismiss', /news\.innerHTML = hqFaultsHtml\(d\) \+ hqNewsHtml\(d\)/.test(page) && /did not send\.<\/b> Here is why\./.test(page) && /What to do: /.test(page));

  // ── ONE EMAIL, ONCE ───────────────────────────────────────────────────────
  OUT.push('', '-- one email to the agent, once --');
  // The test database is shared: other suites leave other agents' rows. Only ours are read here.
  const all = [];
  const sent = { push: (m) => { if (m.to === 'jabree.sf@belcher.test') sent.list.push(m); }, list: [] };
  const n1 = await SF.notify(P, { send: async (m) => { all.push(m); sent.push(m); } });
  sent.length = sent.list.length; Object.assign(sent, sent.list);
  ok('ONE EMAIL TO THE AGENT, listing each with why and what to do', sent.list.length === 1 && sent[0].to === 'jabree.sf@belcher.test'
    && /9 approved emails did not send/.test(sent[0].subject) && /Mailbox Cafe/.test(sent[0].text) && /What to do: Reconnect your mailbox/.test(sent[0].text), { n1, s: sent[0] && sent[0].subject });
  ok('  a fault from ten days ago is on Home and in the alert, but not emailed', !/Old Bike Shop/.test(sent[0].text));
  const n2 = await SF.notify(P, { send: async (m) => { sent.push(m); } });
  ok('  ONCE: the next run sends nothing', n2.emailed === 0 && sent.list.length === 1, n2);
  await row('sf-new', 'New Diner', { agoH: 2.5 });
  await SF.sweep(P);
  await SF.notify(P, { send: async (m) => { sent.push(m); } });
  ok('  a new fault later is its own email, with only the new one', sent.list.length === 2 && /New Diner/.test(sent.list[1].text) && !/Mailbox Cafe/.test(sent.list[1].text), sent.list[1] && sent.list[1].text);
  const failing = await (async () => { await row('sf-new2', 'Another Diner', { agoH: 2.5 }); await SF.sweep(P); return SF.notify(P, { send: async () => { throw new Error('resend down'); } }); })();
  ok('  an email that could not be sent is tried again next time, and the failure is recorded', failing.failed.length === 1
    && (await P.query(`SELECT emailed_at FROM approval_faults WHERE log_id = 'sf-new2'`)).rows[0].emailed_at === null);

  // ── THE MORNING ALERT ─────────────────────────────────────────────────────
  OUT.push('', '-- the admin\'s morning alert names the agent and the count --');
  const MA = require(REPO + 'server/services/morningAlert.js');
  const rep = await MA.collect(P);
  const mine = (rep.sendFaults || []).find((x) => x.email === 'jabree.sf@belcher.test');
  ok('THE MORNING ALERT NAMES THE AGENT AND THE COUNT', mine && mine.n === 12 && mine.ours >= 2, rep.sendFaults);
  const txt = MA.render(rep).text || '';
  ok('  printed', /APPROVALS THAT DID NOT SEND, by agent/.test(txt) && /12  Jabree Sample <jabree\.sf@belcher\.test>/.test(txt), txt.slice(0, 600));

  // ── RESOLVED, DISMISSED ───────────────────────────────────────────────────
  await P.query(`UPDATE outreach_logs SET status = 'sent', sent_at = NOW() WHERE id = 'sf-mailbox'`);
  await P.query(`UPDATE outreach_logs SET status = 'expired' WHERE id = 'sf-old'`);
  const s2 = await SF.sweep(P);
  const res = Object.fromEntries((await P.query(`SELECT log_id, resolved_at, resolution FROM approval_faults WHERE log_id IN ('sf-mailbox','sf-old')`)).rows.map((r) => [r.log_id, r]));
  ok('A FAULT RESOLVES ITSELF when the email sends, or the row is closed', res['sf-mailbox'].resolved_at && res['sf-mailbox'].resolution === 'sent' && res['sf-old'].resolved_at && s2.resolved === 2, res);
  await SF.acknowledge(P, AG, null);
  ok('  and the agent can dismiss the line once read', (await SF.forAgent(P, AG)).count === 0);

  // ── THE CACHE BUG ─────────────────────────────────────────────────────────
  OUT.push('', '-- the send path asks our own address cache before "no address to send to" --');
  await store.saveBrandEvidence('site:centralcitytoyota.test | v3', 'siteemail', 'Central City Toyota', 'https://centralcitytoyota.test',
    { v: 'v3', email: 'mmisuraco@centralcitytoyota.test', personalEmail: 'mmisuraco@centralcitytoyota.test', type: 'personal', siteRoot: 'centralcitytoyota.test', outcomeKind: 'found' }, 'OK');
  await store.saveBrandEvidence('site:hornsdownshop.test | v3', 'siteemail', 'HornsDownShop', 'https://hornsdownshop.test',
    { v: 'v3', email: 'info@hornsdownshop.test', roleEmail: 'info@hornsdownshop.test', type: 'role', siteRoot: 'hornsdownshop.test', outcomeKind: 'found' }, 'OK');
  await store.saveBrandEvidence('contacts cached co | cypress, ca', 'contacts', 'Contacts Cached Co', null,
    { contacts: [{ name: 'Lou Reyes', title: 'Owner', email: 'lou@contactscached.test' }], addressLadder: {} }, 'OK');
  const DC = require(REPO + 'server/services/draftChannel.js');
  ok('our address cache, both lanes: the website\'s address and a past contact lookup\'s', await DC.cachedAddress(P, 'Central City Toyota') === 'mmisuraco@centralcitytoyota.test'
    && await DC.cachedAddress(P, 'HornsDownShop') === 'info@hornsdownshop.test' && await DC.cachedAddress(P, 'Contacts Cached Co') === 'lou@contactscached.test');
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,touch_no) VALUES
    ('sf-ct','${AG}','${ATH}','Central City Toyota','Hi','<p>Hi Mike,</p><p>x</p>','draft',NULL,1)`);
  const ap = await C.approveBatch(P, AG, { ids: ['sf-ct'] });
  ok('APPROVE: a draft with no address on the row takes the one in our cache, and is approved', ap.scheduled === 1 && ap.refused.length === 0
    && (await P.query(`SELECT sent_to_email FROM outreach_logs WHERE id = 'sf-ct'`)).rows[0].sent_to_email === 'mmisuraco@centralcitytoyota.test', ap);
  // An approved row with no address (approved before the rule): the send path looks before giving up.
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,touch_no) VALUES
    ('sf-hd','${AG}','${ATH}','HornsDownShop','Hi','<p>Hi Sam,</p><p>x</p>','approved',NULL,NOW() - INTERVAL '1 hour',NOW() - INTERVAL '1 hour',1)`);
  // The compliance gate needs to know what the business is (its Places record).
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at) VALUES ('sf:hornsdownshop','places','HornsDownShop',$1::jsonb,'OK',NOW())
                 ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`, [JSON.stringify({ found: true, types: ['clothing_store'], name: 'HornsDownShop' })]);
  const to = [];
  const rel = await C.releaseDue(P, { send: async (log) => { to.push([log.id, log.sent_to_email]); return { providerMessageId: 'p-' + log.id }; } });
  const hd = (await P.query(`SELECT status, sent_to_email, cadence_stop_reason FROM outreach_logs WHERE id = 'sf-hd'`)).rows[0];
  ok('RELEASE: an approved row with no address is sent to the cached address, not stopped', to.some(([id, e]) => id === 'sf-hd' && e === 'info@hornsdownshop.test')
    && hd.status === 'sent' && !hd.cadence_stop_reason, { to, hd, rel: rel.detail.filter((d) => d.id === 'sf-hd') });
  // A bounce list we cannot read is a hold, never a permanent stop.
  const sup = require(REPO + 'server/services/suppression.js');
  const real = sup.isSuppressed;
  sup.isSuppressed = async () => ({ suppressed: true, reason: 'could not check the bounce list, so not sending' });
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,touch_no) VALUES
    ('sf-db','${AG}','${ATH}','Blip Cafe','Hi','<p>Hi Al,</p><p>x</p>','approved','al@blip.test',NOW() - INTERVAL '1 hour',NOW() - INTERVAL '1 hour',1)`);
  await C.releaseDue(P, { send: async () => ({ providerMessageId: 'x' }) });
  sup.isSuppressed = real;
  const db = (await P.query(`SELECT status, cadence_stopped_at, send_hold_reason FROM outreach_logs WHERE id = 'sf-db'`)).rows[0];
  ok('A BOUNCE LIST WE COULD NOT READ HOLDS THE ROW; it is never stopped for good', db.status === 'approved' && !db.cadence_stopped_at && /could not check/.test(db.send_hold_reason || ''), db);
  // An approval whose athlete row is gone does not vanish from the queue: it is
  // held with a reason, and a fault after two hours like any other.
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,touch_no) VALUES
    ('sf-orphan','${AG}','sf-no-such-athlete','Orphan Gym','Hi','<p>Hi Al,</p><p>x</p>','approved','al@orphan.test',NOW() - INTERVAL '3 hours',NOW() - INTERVAL '3 hours',1)`);
  const relO = await C.releaseDue(P, { send: async () => ({ providerMessageId: 'x' }) });
  const orphan = relO.detail.find((d) => d.id === 'sf-orphan');
  await SF.sweep(P);
  const fo = (await P.query(`SELECT kind, why FROM approval_faults WHERE log_id = 'sf-orphan'`)).rows[0];
  ok('AN APPROVAL WITH NO ATHLETE ROW IS NOT SILENTLY SKIPPED: held with a reason, then a fault', orphan && orphan.result !== 'sent' && orphan.why && fo && fo.why, { orphan, fo });
  // The backlog sweep reads both cache lanes too.
  const BL = require(REPO + 'server/services/approvedBacklog.js');
  ok('the backlog sweep reads the same cache (both lanes)', /DC\.cachedAddress\(pool, r\.brand_name\)/.test(require('fs').readFileSync(REPO + 'server/services/approvedBacklog.js', 'utf8')) && typeof BL.onHomeAll === 'function');
  ok('the job runs every 10 minutes from boot', /SF\.tick\(store\.pool\)/.test(require('fs').readFileSync(REPO + 'server/index.js', 'utf8')) && /setInterval\(sfTick, 10 \* 60 \* 1000\)/.test(require('fs').readFileSync(REPO + 'server/index.js', 'utf8')));
  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
