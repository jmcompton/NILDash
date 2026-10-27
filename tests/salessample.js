'use strict';
// ── THE SALES SAMPLE (services/salesSample, SALES_SAMPLE_ON) ────────────────
// Runs against the local test Postgres. No network: the web search, Hunter
// and the card engine are stand-ins.
//
//   - the agency list loads, most clients first, a mid-roster client picked;
//   - with the switch on, the agency lane drafts from the list first, and each
//     prospect waits for its sample (never planned while pending);
//   - a sample with 2+ cards is ready: a page token, the email rewritten to
//     lead with it, its one link the sample page, passing every check;
//   - fewer than 2 cards: failed, and the plain template is planned instead;
//   - the page shows the businesses, people and pitches, never an address,
//     and escapes what it prints;
//   - the plain template: the workload line, "Founder, NILDash", the phone.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('salessampletest', { schema: true });
process.env.BUSINESS_MAILING_ADDRESS = '3796 Turnberry Court, Duluth, GA 30096';
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'ss-test-secret';
process.env.ADMIN_EMAIL = 'ss-admin@ss-admin.test';
process.env.SALES_FROM_ADDRESS = 'john@comptongroupllc.com';
process.env.APP_URL = 'https://mynildash.com';
process.env.SALES_BOOKING_URL = 'https://calendly.com/johnmark/15min';
process.env.SALES_AUTOPILOT_ON = 'true';
process.env.SALES_AUTOSEND_ON = 'true';
process.env.SALES_TRIAL_ON = 'true';
process.env.SALES_SAMPLE_ON = 'true';
process.env.SALES_SENDER_PHONE = '470-306-3835';
delete process.env.SALES_DAILY_NEW;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();

const store = require(REPO + 'server/store.js');
const SA = require(REPO + 'server/services/salesAutopilot.js');
const SS = require(REPO + 'server/services/salesSample.js');
const W = require(REPO + 'server/services/salesWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;
const lc = (s) => String(s || '').toLowerCase();

const LIST = [
  { slug: 'big-college-agency', agency: 'Big College Agency', clients: 99, agents: ['Adam Lead', 'Miles Second'],
    players: [{ name: 'Star Player', position: 'QB', school: 'Texas', grade: 9.1 }, { name: 'Mid Player', position: 'WR', school: 'Utah', grade: 5.2 }] },
  { slug: 'small-shop', agency: 'Small Shop Sports', clients: 12, agents: ['Kelly Owner'], notable: 'Tavion Gadson (DT, Kentucky)' },
  { slug: 'no-agents', agency: 'Nameless Group', clients: 40, agents: [], notable: 'Some One (LB, Iowa)' },
  { slug: 'thin-sample', agency: 'Thin Sample Group', clients: 30, agents: ['Tess Thin'], notable: 'Lone Card (RB, Boise State)' },
];
function research(lane, x) {
  if (lane === 'pool') return { domain: x.slug + '.test', city: 'Austin', state: 'TX', person: { name: x.agents[0], title: 'Founder' } };
  if (lane === 'agency') return { firms: [] };
  return { person: null };
}
const hunter = {
  findEmail: async (first, last, domain) => ({ email: `${lc(first)}@${domain}`, acceptAll: false }),
  domainSearch: async () => ({ emails: [] }),
  verify: async () => ({ result: 'valid', status: 'valid' }),
};
// The card engine: cards for the athlete, as fillAthlete writes them.
function filler(n) {
  return async ({ pool, agentId, athleteId }) => {
    for (let i = 0; i < n; i++) {
      const logId = `oq-test-${athleteId}-${i}`;
      await pool.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source, sent_to_email, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','nightly-queue',$8,NOW(),NOW())`,
        [logId, agentId, athleteId, `Biz <${i}>`, `biz-${i}`, `Idea for Biz ${i}`, `<p>Hi Owner ${i},</p><p>A pitch &amp; a plan.</p>`, `owner${i}@biz${i}.test`]);
      await pool.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title, channel, state, email, outreach_log_id, identity_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'email','queued',$9,$10,$11)`,
        [agentId, athleteId, i + 1, `biz-${i}`, `Biz <${i}>`, `Near campus, sponsors local teams ${i}.`, `Owner ${i}`, 'Owner', `owner${i}@biz${i}.test`, logId, `biz-${i}-${athleteId}`]);
    }
    return { filled: n, note: n ? null : 'nothing found' };
  };
}

function nextMonday() {
  const c = SA.centralDay();
  let d = SA.addDays(c.date, 2);
  while (SA.partsIn(d + 'T18:00:00Z', 'UTC').weekday !== 'Mon') d = SA.addDays(d, 1);
  return d;
}
const MON = nextMonday();
const CT = (date, hh, mm = 0) => SA.zonedTime(date, hh * 60 + mm, 'America/Chicago');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await SS.ensureTables(P());

  // ── THE LIST ───────────────────────────────────────────────────────────
  OUT.push('-- the agency list --');
  const imp = await SS.importPool(P(), LIST, 'test');
  ok('the list loads', imp.saved === 4, imp);
  const next = await SS.nextAgencies(P(), 10);
  ok('most clients first, agencies with no named agent left out', next.map((r) => r.slug).join() === 'big-college-agency,thin-sample,small-shop', next.map((r) => r.slug));
  ok('a mid-roster client is picked over the star', SS.pickClient(next[0].players).name === 'Mid Player', SS.pickClient(next[0].players));
  ok('a "Name (POS, School)" client is read', JSON.stringify(SS.parsePlayer('Tavion Gadson (DT, Kentucky)')) === JSON.stringify({ name: 'Tavion Gadson', position: 'DT', school: 'Kentucky', grade: null }));

  // ── THE NIGHT: FROM THE LIST, SAMPLES PENDING ─────────────────────────
  OUT.push('', '-- drafted from the list --');
  const run = await SA.runOnce(P(), { trigger: 'dry-run', now: CT(MON, 4, 5), want: 6, deps: { research, hunter, write: false, hunterMax: 99 } });
  ok('the run worked', run.ok, run.error);
  const fromList = run.lanes.agency.drafted;
  ok('three agencies drafted from the list', fromList.length === 3 && run.lanes.agency.fromList === 3, fromList.map((d) => d.org));
  ok('  each waiting for a sample of one of its clients', fromList.every((d) => d.sample && d.sample.status === 'pending' && d.sample.athlete.name), fromList.map((d) => d.sample));
  ok('  written to the agent the research named', fromList.some((d) => d.person === 'Adam Lead' && d.email === 'adam@big-college-agency.test'), fromList.map((d) => d.email));
  const used = (await P().query(`SELECT slug, outcome FROM sales_pool WHERE used_at IS NOT NULL ORDER BY slug`)).rows;
  ok('  and the list remembers them', used.length === 3 && used.every((u) => u.outcome === 'drafted'), used);
  const plan0 = await SA.planDay(P(), { now: CT(MON, 7, 1), save: false });
  ok('a pending sample is never planned', plan0.planned.length === 0, plan0.planned.map((x) => x.person));

  // ── BUILDING THEM ─────────────────────────────────────────────────────
  OUT.push('', '-- building the samples --');
  const notYet = await SS.tick(P(), { now: CT(MON, 5, 0), deps: { fill: filler(3) } });
  ok('not before 5:30 Central (the Hunter night)', notYet.skipped === 'not yet', notYet);
  const thinId = (await P().query(`SELECT id FROM sales_prospects WHERE org = 'Thin Sample Group'`)).rows[0].id;
  let calls = 0;
  const fill = async (a) => { calls++; const thin = (await P().query(`SELECT 1 FROM sales_prospects WHERE id = $1 AND sample->>'athleteId' = $2`, [thinId, a.athleteId])).rowCount; return filler(thin ? 1 : 3)(a); };
  const built = await SS.tick(P(), { now: CT(MON, 5, 31), deps: { fill } });
  ok('every pending sample is built once', calls === 3 && built.built.length === 3, built);
  const ready = (await P().query(`SELECT p.*, e.subject, e.body_text, e.written_by FROM sales_prospects p JOIN sales_emails e ON e.prospect_id = p.id AND e.step = 1 WHERE p.sample_status = 'ready' ORDER BY p.org`)).rows;
  ok('2 or more cards: ready, with a page token', ready.length === 2 && ready.every((r) => /^[A-Za-z0-9_-]{12,}$/.test(r.sample_token)), ready.map((r) => [r.org, r.sample_token]));
  const big = ready.find((r) => r.org === 'Big College Agency');
  const url = SS.sampleUrl(big.sample_token);
  ok('  the email leads with their own client', big.written_by === 'sample' && /I ran NILDash for one of Big College Agency's clients, Mid Player at Utah/.test(big.body_text), big.body_text);
  ok('  its one link is the sample page', W.links(big.body_text).length === 1 && W.links(big.body_text)[0] === url, W.links(big.body_text));
  ok('  and it passes every check with that link', W.checkEmail({ subject: big.subject, body: big.body_text }, big, SA.ctxFor(big), 1).length === 0,
    W.checkEmail({ subject: big.subject, body: big.body_text }, big, SA.ctxFor(big), 1));
  ok('  the subject names the athlete', big.subject === 'Mid Player: 3 brands ready to pitch', big.subject);
  ok('  the possessive is right for a name ending in s', /one of Small Shop Sports' clients/.test(ready.find((r) => r.org === 'Small Shop Sports').body_text));
  ok('  signed as Founder, with the phone', /JohnMark Compton\nFounder, NILDash\n470-306-3835/.test(big.body_text), big.body_text);
  const thin = (await P().query(`SELECT p.*, e.body_text FROM sales_prospects p JOIN sales_emails e ON e.prospect_id = p.id AND e.step = 1 WHERE p.id = $1`, [thinId])).rows[0];
  ok('fewer than 2 cards: failed, and the template stays', thin.sample_status === 'failed' && !thin.sample_token && /mynildash\.com\/try/.test(thin.body_text) && /only 1 card/.test(thin.sample.why), [thin.sample_status, thin.sample && thin.sample.why]);
  const plan1 = await SA.planDay(P(), { now: CT(MON, 7, 1), save: false });
  ok('ready and failed samples are both planned', plan1.planned.length === 3, plan1.planned.map((x) => x.org));
  const again = await SS.tick(P(), { now: CT(MON, 5, 40), deps: { fill } });
  ok('nothing is built twice', calls === 3 && again.built.length === 0, again);
  ok('the sample account is hidden from the nightly run', (await P().query(`SELECT archived FROM users WHERE id = $1`, [SS.SAMPLES_ID])).rows[0].archived === true);
  const left = (await P().query(`SELECT (SELECT COUNT(*) FROM athletes WHERE agent_id = $1)::int AS a, (SELECT COUNT(*) FROM outreach_queue WHERE agent_id = $1)::int AS q, (SELECT COUNT(*) FROM outreach_logs WHERE agent_id = $1)::int AS l`, [SS.SAMPLES_ID])).rows[0];
  ok('the sample athletes, cards and drafts are deleted once copied', left.a === 0 && left.q === 0 && left.l === 0, left);
  ok('  and the prospect keeps which athlete it was', !!(big.sample && /^ath-sample-/.test(big.sample.athleteId)), big.sample && big.sample.athleteId);
  const late = await SS.tick(P(), { now: CT(MON, 7, 5), deps: { fill } });
  ok('not after 7:00 Central (the day\'s plan)', late.skipped === 'not yet', late);
  // A build that never finished: failed after 45 minutes, never paid for twice.
  await P().query(`UPDATE sales_prospects SET sample_status = 'building', updated_at = NOW() - INTERVAL '2 hours' WHERE org = 'Thin Sample Group'`);
  const plan2 = await SA.planDay(P(), { now: CT(MON, 7, 1), save: false });
  ok('a sample being built is never planned', !plan2.planned.some((x) => x.org === 'Thin Sample Group'), plan2.planned.map((x) => x.org));
  const calls0 = calls;
  await SS.tick(P(), { now: CT(MON, 5, 45), deps: { fill } });
  const thin2 = (await P().query(`SELECT sample_status, sample FROM sales_prospects WHERE org = 'Thin Sample Group'`)).rows[0];
  ok('an interrupted build is failed, not retried', thin2.sample_status === 'failed' && /interrupted/.test(thin2.sample.why) && calls === calls0, [thin2.sample_status, calls - calls0]);

  // ── THE PAGE ──────────────────────────────────────────────────────────
  OUT.push('', '-- the page --');
  const html = await SS.page(P(), big.sample_token);
  ok('the page shows the businesses, the people and the pitch', html && /Biz &lt;0&gt;/.test(html) && /Owner 0, Owner/.test(html) && /A pitch &amp; a plan\./.test(html), html && html.slice(0, 400));
  ok('  escapes what it prints', html && !/Biz <0>/.test(html));
  ok('  never shows an address', html && !/@biz\d\.test/.test(html));
  ok('  ends with the roster ask, the 15 minutes and the trial', /Get this every morning for every athlete you represent/.test(html) && /calendly\.com\/johnmark\/15min/.test(html) && /Start 14-day trial/.test(html));
  ok('  and is not indexed', /noindex/.test(html));
  ok('an unknown or malformed token is no page', (await SS.page(P(), 'nope-nope-nope')) === null && (await SS.page(P(), '../etc')) === null);

  // ── THE PLAIN TEMPLATE ─────────────────────────────────────────────────
  OUT.push('', '-- the plain template --');
  const p = { lane: 'agency', org: 'Green Sports Management', person: 'Daniel Green', fact: 'Green Sports Management is a family owned agency.' };
  const t = W.templateEmail(p, SA.writerCtx());
  ok('the specific line is their workload, not their website read back', /For the team at Green Sports Management, that is hours of writing back every week\./.test(t.body) && !/family owned/.test(t.body), t.body);
  ok('  signed as Founder with the phone', /JohnMark Compton\nFounder, NILDash\n470-306-3835$/.test(t.body), t.body);
  ok('  and still passes every check', W.checkEmail(t, p, SA.writerCtx(), 1).length === 0, W.checkEmail(t, p, SA.writerCtx(), 1));
  const s = { lane: 'school', org: 'Temple', person: 'Brian Thornburg', level: 'Group of Five' };
  const ts = W.templateEmail(s, SA.writerCtx());
  ok('the school version passes too', W.checkEmail(ts, s, SA.writerCtx(), 1).length === 0, W.checkEmail(ts, s, SA.writerCtx(), 1));
  process.env.SALES_SENDER_PHONE = '';
  ok('no phone set: name and title only', /JohnMark Compton\nFounder, NILDash$/.test(W.templateEmail(p, SA.writerCtx()).body));

  // ── THE RIGHT PERSON ──────────────────────────────────────────────────
  OUT.push('', '-- only an agent on record --');
  await SS.importPool(P(), [{ slug: 'wrong-domain', agency: 'Wrong Domain Group', clients: 80, agents: ['Wanda Listed'], notable: 'Some Body (CB, Iowa)' }], 'test');
  const strangerHunter = { ...hunter,
    findEmail: async () => ({ email: null }),
    domainSearch: async (domain) => ({ emails: [{ email: 'stranger@' + domain, type: 'personal', firstName: 'Sam', lastName: 'Stranger', position: 'President' }] }) };
  const run3 = await SA.runOnce(P(), { trigger: 'dry-run', now: CT(SA.addDays(MON, 2), 4, 5), want: 2, deps: { research, hunter: strangerHunter, write: false, hunterMax: 99 } });
  const stranger = (await P().query(`SELECT 1 FROM sales_prospects WHERE email LIKE 'stranger@%'`)).rowCount;
  ok('never written to someone Domain Search turned up instead of the listed agent', run3.ok && stranger === 0
    && /not one of the agents on record/.test((await P().query(`SELECT outcome FROM sales_pool WHERE slug = 'wrong-domain'`)).rows[0].outcome), run3.lanes && run3.lanes.agency.skipped);

  // ── THE SWITCH ────────────────────────────────────────────────────────
  OUT.push('', '-- the switch --');
  await P().query(`UPDATE sales_prospects SET sample_status = 'pending' WHERE org = 'Thin Sample Group'`);
  process.env.SALES_SAMPLE_ON = '';
  ok('off: the sample step does nothing', (await SS.tick(P(), { now: CT(MON, 6, 0), force: true })).skipped === 'SALES_SAMPLE_ON is off');
  const plan3 = await SA.planDay(P(), { now: CT(MON, 7, 1), save: false });
  ok('off: a prospect left waiting for a sample is planned with the template', plan3.planned.some((x) => x.org === 'Thin Sample Group'), plan3.planned.map((x) => x.org));
  await SS.importPool(P(), [{ slug: 'later-agency', agency: 'Later Agency', clients: 50, agents: ['Lou Later'], notable: 'Late Guy (LB, Iowa)' }], 'test');
  const run2 = await SA.runOnce(P(), { trigger: 'dry-run', now: CT(SA.addDays(MON, 1), 4, 5), want: 2, deps: { research, hunter, write: false, hunterMax: 99 } });
  ok('off: the agency lane does not touch the list', run2.ok && run2.lanes.agency.fromList === 0 && (await P().query(`SELECT used_at FROM sales_pool WHERE slug = 'later-agency'`)).rows[0].used_at === null, run2.lanes && run2.lanes.agency);

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
