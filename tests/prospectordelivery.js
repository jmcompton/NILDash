'use strict';
// ── PROSPECTOR DELIVERY: THE WEEKLY LEADS FOR PAYING IT COMPANIES ───────────
// services/prospector/delivery + the run's exclude list + the portal routes.
// Local test Postgres; the run, the customer email and the alert are stand-ins.
//
//   - weekly amounts follow the plans (25 / 100 / 300 a month);
//   - only live, onboarded customers are due, once a week, never twice at once;
//   - a run never repeats a business the customer already has;
//   - the customer gets their page link by email; JohnMark hears about every
//     batch, a short one and a failure;
//   - the page shows only what was delivered; the CSV is safe in a spreadsheet;
//   - weekdays from 7:00 Central only; idle while off;
//   - the routes are wired, the admin ones checked.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectordeliverytest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PROSPECTOR_DELIVERY_ON;
process.env.PROSPECTOR_BASE_URL = 'https://mynildash.com';

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const D = require(REPO + 'server/services/prospector/delivery.js');
const R = require(REPO + 'server/services/prospector/run.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;
// Tuesday 3 Nov 2026, 9:00 Central.
const T0 = new Date('2026-11-03T15:00:00Z');
const days = (n) => new Date(T0.getTime() + n * 86400000);

// A stand-in run: the area has `pool` businesses with a gap; it builds up to
// `limit` of the ones not excluded, and records what it was asked.
const asked = [];
function fakeRun(size = 40) {
  return async (pool, input) => {
    asked.push({ area: input.area, limit: input.limit, exclude: [...(input.exclude || [])], sender: input.sender, delivery: input.delivery });
    await R.ensureTables(pool);
    const run = (await pool.query(`INSERT INTO prospector_runs (playbook, area, sender, status) VALUES ('it-msp', $1, $2, 'done') RETURNING id`, [input.area, JSON.stringify(input.sender)])).rows[0];
    if (input.onStart) input.onStart(run.id);
    const ex = new Set(input.exclude || []);
    const free = [];
    for (let i = 1; i <= size && free.length < input.limit; i++) { const d = `biz${i}.${input.area.split(',')[0].toLowerCase()}.test`; if (!ex.has(d)) free.push(d); }
    for (const d of free) {
      await pool.query(`INSERT INTO prospector_leads (run_id, business, domain, category, level, finding, person, verified, email) VALUES ($1,$2,$3,'dentist','high',$4,$5,true,$6)`,
        [run.id, '=Biz ' + d, d, JSON.stringify({ problems: ['No DMARC record'] }), JSON.stringify({ first: 'Pat', last: 'Lee', title: 'Owner', email: 'pat@' + d }),
          JSON.stringify({ subject: 'Quick one', body: `Hi Pat,\nfrom ${input.sender.company}` })]);
    }
    return { runId: run.id, summary: { checked: size * 2, withGap: size - ex.size, alreadyDelivered: ex.size } };
  };
}
const alerts = [], mails = [];
const deps = (size) => ({ run: fakeRun(size), alert: async (m) => alerts.push(m), sendCustomer: async (to, m) => mails.push({ to, ...m }) });

async function customer(o) {
  const r = await P().query(`INSERT INTO prospector_customers (token, email, company, sender_name, area, area_key, plan, period, status, onboarded_at, checkout_session_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'monthly',$8,$9,$1) RETURNING *`,
  [o.token, o.email || null, o.company, o.sender || null, o.area, (o.area || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), o.plan, o.status || 'active', o.onboarded === false ? null : days(-1)]);
  return r.rows[0];
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await D.ensureTables(P());

  OUT.push('-- amounts --');
  ok('a week is a quarter of the month, rounded up: 6 / 24 / 70', D.weekly('starter') === 6 && D.weekly('territory') === 24 && D.weekly('dfy') === 70, [D.weekly('starter'), D.weekly('territory'), D.weekly('dfy')]);
  ok('no plan, no leads', D.weekly('nope') === 0);

  OUT.push('-- who is due --');
  const hoover = await customer({ token: 'tokHoover', email: 'amy@hooverit.test', company: 'Hoover IT', sender: 'Amy Lee', area: 'Hoover, AL', plan: 'starter' });
  const pelham = await customer({ token: 'tokPelham', email: 'bo@pelhamit.test', company: 'Pelham IT', sender: 'Bo Ray', area: 'Pelham, AL', plan: 'territory' });
  await customer({ token: 'tokNew', company: 'New IT', area: 'Mobile, AL', plan: 'starter', onboarded: false });
  await customer({ token: 'tokGone', company: 'Gone IT', area: 'Dothan, AL', plan: 'starter', status: 'canceled' });
  await customer({ token: 'tokLate', company: 'Late IT', area: 'Auburn, AL', plan: 'starter', status: 'past_due' });
  let due = await D.due(P(), T0);
  ok('only live, onboarded customers are due', JSON.stringify(due.map((c) => c.company).sort()) === JSON.stringify(['Hoover IT', 'Pelham IT']), due.map((c) => c.company));

  OUT.push('-- a batch --');
  let r = await D.deliver(P(), hoover, { now: T0, deps: deps(40) });
  ok('six leads for a Starter customer', r.delivered === 6 && r.wanted === 6, r);
  ok('built in their area, signed with their name and company, as a delivery', asked[0].area === 'Hoover, AL' && asked[0].sender.company === 'Hoover IT'
    && asked[0].sender.name === 'Amy Lee' && asked[0].delivery === true && asked[0].limit === 6, asked[0]);
  ok('they get an email with their page link', mails.length === 1 && mails[0].to === 'amy@hooverit.test' && mails[0].text.includes('https://mynildash.com/p/tokHoover')
    && /^6 new leads in Hoover, AL$/.test(mails[0].subject) && /^Hi Amy,/.test(mails[0].text), mails[0]);
  ok('a Starter email says they send them themselves', /Send them from your own inbox/.test(mails[0].text));
  ok('JohnMark hears about it', alerts.some((a) => /6 leads delivered to Hoover IT/.test(a.subject)));
  due = await D.due(P(), days(1));
  ok('not due again the next day', !due.some((c) => c.id === hoover.id));
  ok('due again a week later', (await D.due(P(), days(7))).some((c) => c.id === hoover.id));
  r = await D.deliver(P(), hoover, { now: days(7), deps: deps(40) });
  ok('the next week never repeats a business', asked[1].exclude.length === 6 && r.delivered === 6, { ex: asked[1].exclude.length, r });
  const all = (await P().query(`SELECT COUNT(DISTINCT domain)::int AS n, COUNT(*)::int AS t FROM prospector_delivered WHERE customer_id = $1`, [hoover.id])).rows[0];
  ok('twelve different businesses after two weeks', all.n === 12 && all.t === 12, all);

  alerts.length = 0; mails.length = 0;
  r = await D.deliver(P(), pelham, { now: T0, deps: deps(10) });
  ok('an area running low delivers what it has and says so', r.delivered === 10 && r.wanted === 24 && alerts.some((a) => /Short of the plan/.test(a.text)), r);
  ok('a Territory email offers to send from their mailbox', /connect your mailbox/i.test(mails[0].text));
  alerts.length = 0;
  const bad = await D.deliver(P(), pelham, { now: days(8), deps: { ...deps(10), run: async () => { throw new Error('Places quota'); } } });
  ok('a failure is recorded and JohnMark is told', bad.error === 'Places quota' && alerts.some((a) => /delivery failed for Pelham IT/.test(a.subject)));
  ok('a failed batch does not count as this week\'s', (await D.due(P(), days(8))).some((c) => c.id === pelham.id));
  await P().query(`INSERT INTO prospector_batches (customer_id, wanted, status, created_at) VALUES ($1, 24, 'running', $2)`, [pelham.id, days(9)]);
  ok('never two batches at once', !(await D.due(P(), new Date(days(9).getTime() + 30 * 60000))).some((c) => c.id === pelham.id));

  OUT.push('-- their page --');
  const v = await D.portal(P(), 'tokHoover');
  ok('the page shows everything delivered, newest week first', v.leads.length === 12 && new Date(v.leads[0].batchAt) > new Date(v.leads[11].batchAt) && v.perWeek === 6 && v.plan.name === 'Starter', v.leads.length);
  ok('each lead has the person, the problem and the email', v.leads[0].person.email.startsWith('pat@') && v.leads[0].problem === 'No DMARC record' && v.leads[0].email.subject === 'Quick one');
  ok('another customer\'s leads never show', v.leads.every((l) => /hoover/.test(l.domain)));
  ok('a wrong token shows nothing', (await D.portal(P(), 'nope')) === null);
  const csv = D.csv(v);
  const lines = csv.trim().split('\r\n');
  ok('the CSV has a header and one row per lead', lines[0].startsWith('Business,Category,Website') && csv.split('\r\n').filter((l) => /^"'?=Biz|^'=Biz/.test(l)).length === 12, lines.slice(0, 2));
  ok('a cell that starts with = is defused for spreadsheets', lines[1].startsWith(`"'=Biz`), lines[1]);
  ok('line breaks in an email stay inside one cell', /"Hi Pat,\nfrom Hoover IT"/.test(csv));

  OUT.push('-- the clock --');
  ok('off: nothing runs', (await D.tick(P(), { now: T0, deps: deps(40) })).skipped === 'PROSPECTOR_DELIVERY_ON is off');
  process.env.PROSPECTOR_DELIVERY_ON = '1';
  ok('the weekend: nothing runs', (await D.tick(P(), { now: new Date('2026-11-07T15:00:00Z'), deps: deps(40) })).skipped === 'weekend');
  ok('before 7:00 Central: nothing runs', (await D.tick(P(), { now: new Date('2026-11-03T12:00:00Z'), deps: deps(40) })).skipped === 'before 7:00 Central');
  const fresh = await customer({ token: 'tokFresh', email: 'x@fresh.test', company: 'Fresh IT', area: 'Trussville, AL', plan: 'dfy' });
  await P().query(`UPDATE prospector_customers SET onboarded_at = $2 WHERE id = $1`, [fresh.id, days(-30)]);
  asked.length = 0;
  const tk = await D.tick(P(), { now: days(20), deps: deps(100) });
  ok('a weekday tick delivers to the customer waiting longest', tk.delivered > 0 && asked[0].area === 'Trussville, AL' && asked[0].limit === 70, { tk, a: asked[0] && asked[0].area });

  OUT.push('-- the run skips what was delivered --');
  const RS = fs.readFileSync(REPO + 'server/services/prospector/run.js', 'utf8');
  ok('the run reads an exclude list and filters gaps by it before choosing', /input\.exclude/.test(RS) && /!exclude\.has\(/.test(RS) && /alreadyDelivered/.test(RS));
  ok('only a delivery may ask for more than 25', /input\.delivery \? 100 : 25/.test(RS));

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.get('/p/:token'", "app.get('/api/prospector/portal/:token'", "app.get('/api/prospector/portal/:token/leads.csv'",
    "app.get('/api/lab/prospector/customers'", "app.post('/api/lab/prospector/customers/:id/deliver'"];
  ok('every route exists', routes.every((x) => IX.includes(x)), routes.filter((x) => !IX.includes(x)));
  const adm = (x) => { const i = IX.indexOf(x); return IX.slice(i, i + 200).includes('_statusAdminOk(req)'); };
  ok('the admin routes check admin first', adm(routes[3]) && adm(routes[4]));
  ok('the clock starts with the server', IX.includes("require('./services/prospector/delivery').start(store.pool)"));
  const page = fs.readFileSync(REPO + 'server/views/prospector-portal.html', 'utf8');
  ok('the page escapes what it shows and stays out of search', /const esc = /.test(page) && /noindex/.test(page));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
