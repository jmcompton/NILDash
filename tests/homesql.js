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
// The home-metrics queries, LIFTED FROM server/index.js and run against a real
// Postgres with real fixture rows. `pg` is not installed, so they go through psql.
// The point is not that the SQL parses -- it is that the numbers come out right,
// including the ones that are supposed to be withheld.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
const BLOCK = SRV.slice(SRV.indexOf("app.get('/api/agent/home-metrics'"), SRV.indexOf("app.get('/api/admin/deal-outcomes-health'"));
if (!/generate_series/.test(BLOCK)) { console.log('FIXTURE BROKEN: did not lift home-metrics. Aborting.'); process.exit(1); }

// The three shared fragments, read from the source so the test cannot drift from it.
const frag = (name) => {
  const m = new RegExp('const ' + name + ' = `([^`]+)`').exec(BLOCK);
  if (!m) { console.log('FIXTURE BROKEN: no fragment ' + name); process.exit(1); }
  return m[1];
};
const IN_FLIGHT = frag('IN_FLIGHT'), CLOSED_AT = frag('CLOSED_AT'), VALUE = frag('VALUE');

// Every soft(`...`) query in the block, in order, with $1 bound to the agent.
const queries = [...BLOCK.matchAll(/soft\(\s*`([\s\S]*?)`,\s*\[agentId\]\)/g)].map((m) => m[1]);
if (queries.length !== 9) { console.log('FIXTURE BROKEN: expected 9 queries, lifted ' + queries.length); process.exit(1); }

function run(sql) {
  const bound = sql.replace(/\$\{IN_FLIGHT\}/g, IN_FLIGHT)
    .replace(/\$\{CLOSED_AT\}/g, CLOSED_AT).replace(/\$\{VALUE\}/g, VALUE)
    .replace(/\$1/g, "'ag-1'");
  fs.writeFileSync('/tmp/pgtest/q.sql', bound);
  fs.chmodSync('/tmp/pgtest/q.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', 'home',
    '-v', 'ON_ERROR_STOP=1', '--csv', '-f', '/tmp/pgtest/q.sql'], { encoding: 'utf8' });
  if (r.status !== 0) return { err: (r.stderr || '').split('\n')[0] };
  const lines = (r.stdout || '').trim().split('\n');
  const head = (lines[0] || '').split(',');
  return { rows: lines.slice(1).map((l) => {
    const cells = l.split(','); const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; }); return o;
  }) };
}

function seed(sql) {
  fs.writeFileSync('/tmp/pgtest/seed.sql', sql);
  fs.chmodSync('/tmp/pgtest/seed.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', 'home',
    '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/pgtest/seed.sql'], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('SEED FAILED: ' + r.stderr.split('\n')[0]); process.exit(1); }
}

const [HERO, WEEKS, SENT, BRANDS, CLOSED, PIPE, MAILBOX, ROSTER, TRACK] = queries;

console.log('-- every query runs against the real schema --');
seed(`DELETE FROM deals; DELETE FROM athletes; DELETE FROM outreach_logs; DELETE FROM athlete_activity_log;`);
queries.forEach((q, i) => {
  const r = run(q);
  ok('query ' + (i + 1) + ' executes', !r.err, r.err);
});

console.log('\n-- an agent with nothing shows zeroes, not errors --');
{
  const h = run(HERO).rows[0] || {};
  ok('all time is 0', Number(h.all_time) === 0, h.all_time);
  ok('deal count is 0', Number(h.deal_count) === 0, h.deal_count);
  const w = run(WEEKS).rows;
  ok('the week series is still 8 rows, generated from the calendar', w.length === 8, w.length);
  ok('every one of them is empty', w.every((x) => Number(x.earned) === 0));
  ok('so the chart gate holds it back', w.filter((x) => Number(x.earned) > 0).length < 3);
}

console.log('\n-- money lands in the right week, and only when it is dated --');
{
  seed(`
    INSERT INTO athletes (id, agent_id, data) VALUES
      ('at-1','ag-1','{"name":"Fixture Alvarez","sport":"football"}'),
      ('at-2','ag-1','{"name":"Sample Bramwell","sport":"basketball"}'),
      ('at-3','ag-1','{"name":"Placeholder Castellan","sport":"football"}');
    INSERT INTO deals (id, athlete_id, agent_id, data) VALUES
      -- dated closes, three separate weeks
      ('d1','at-1','ag-1', jsonb_build_object('stage','Closed','value','2500','closedAt',
        (DATE_TRUNC('week', CURRENT_DATE))::text)),
      ('d2','at-1','ag-1', jsonb_build_object('stage','Closed','value','1500','closedAt',
        (DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '1 week')::text)),
      ('d3','at-2','ag-1', jsonb_build_object('stage','Closed','value','1000','closedAt',
        (DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '3 weeks')::text)),
      -- a close with NO date: counts to all time, invisible to every dated view
      ('d4','at-2','ag-1','{"stage":"Closed","value":"9000"}'::jsonb),
      -- in flight
      ('d5','at-1','ag-1','{"stage":"Negotiating","value":"4000"}'::jsonb),
      ('d6','at-3','ag-1','{"stage":"Prospecting","value":"800"}'::jsonb),
      -- neither earned nor in flight
      ('d7','at-3','ag-1','{"stage":"Lost","value":"5000"}'::jsonb);
  `);
  const h = run(HERO).rows[0];
  ok('all time counts the undated close too', Number(h.all_time) === 14000, h.all_time);
  ok('and every closed deal is in the count', Number(h.deal_count) === 4, h.deal_count);
  ok('this month counts only what carries a date',
    Number(h.this_month) < Number(h.all_time), { month: h.this_month, all: h.all_time });

  const w = run(WEEKS).rows;
  ok('the series is oldest first', w[0].week_start < w[7].week_start, [w[0].week_start, w[7].week_start]);
  ok('the current week is last and holds 2500', Number(w[7].earned) === 2500, w[7].earned);
  ok('last week holds 1500', Number(w[6].earned) === 1500, w[6].earned);
  ok('three weeks back holds 1000', Number(w[4].earned) === 1000, w[4].earned);
  ok('the undated 9000 appears in NO week', w.reduce((n, x) => n + Number(x.earned), 0) === 5000,
    w.map((x) => x.earned));
  ok('quiet weeks are zeroes, not gaps', w.filter((x) => Number(x.earned) === 0).length === 5,
    w.map((x) => x.earned));
  ok('three live weeks opens the gate', w.filter((x) => Number(x.earned) > 0).length === 3);
}

console.log('\n-- pipeline is in flight only, and in flight means one thing --');
{
  const p = run(PIPE).rows[0];
  ok('pipeline is 4800, excluding Closed AND Lost', Number(p.value) === 4800, p.value);
  ok('two deals in flight', Number(p.n) === 2, p.n);
  ok('the in-flight fragment is the standard one', IN_FLIGHT.includes("NOT IN ('Closed','Lost')"), IN_FLIGHT);
  ok('and it does not mention Dead', !/Dead/.test(IN_FLIGHT), IN_FLIGHT);
}

console.log('\n-- businesses contacted counts BUSINESSES, not emails --');
{
  seed(`
    INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, status, sent_at) VALUES
      ('o1','ag-1','at-1','Fixture Coffee','fixturecoffee.com','sent', DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 hour'),
      ('o2','ag-1','at-1','Fixture Coffee','fixturecoffee.com','sent', DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '2 hours'),
      ('o3','ag-1','at-2','Sample Motors','samplemotors.com','sent',  DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '3 hours'),
      ('o4','ag-1','at-2','Placeholder Gym','placeholdergym.com','sent', DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '2 days'),
      ('o5','ag-1','at-2','Specimen Deli',NULL,'draft', NULL);
  `);
  const s = run(SENT).rows[0], b = run(BRANDS).rows[0];
  ok('three emails sent this week', Number(s.this_week) === 3, s.this_week);
  ok('one last week', Number(s.last_week) === 1, s.last_week);
  ok('but only TWO businesses this week', Number(b.this_week) === 2, b.this_week);
  ok('one last week', Number(b.last_week) === 1, b.last_week);
  ok('a draft that was never sent counts as neither',
    Number(s.this_week) + Number(s.last_week) === 4, { s: s.this_week, l: s.last_week });
}

console.log('\n-- the strip can tell a quiet week from no mailbox --');
{
  seed(`DELETE FROM email_accounts;`);
  ok('no mailbox reads zero', Number(run(MAILBOX).rows[0].n) === 0, run(MAILBOX).rows[0].n);
  seed(`INSERT INTO email_accounts (id, user_id, provider, email_address)
        VALUES ('em-1','ag-1','gmail','agent@example.test');`);
  ok('a connected mailbox reads one', Number(run(MAILBOX).rows[0].n) === 1, run(MAILBOX).rows[0].n);
  seed(`INSERT INTO email_accounts (id, user_id, provider, email_address)
        VALUES ('em-9','ag-2','gmail','other@example.test');`);
  ok('another agent\'s mailbox does not count', Number(run(MAILBOX).rows[0].n) === 1, run(MAILBOX).rows[0].n);
  seed(`DELETE FROM email_accounts;`);
}

console.log('\n-- the roster --');
{
  seed(`
    INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type, created_at) VALUES
      ('at-1','ag-1','deal_scan', NOW() - INTERVAL '2 days'),
      ('at-2','ag-1','deal_scan', NOW() - INTERVAL '60 days');
  `);
  const r = run(ROSTER).rows;
  ok('every athlete appears, including the one with nothing', r.length === 3, r.length);
  const byName = {}; r.forEach((x) => { byName[x.name] = x; });
  ok('earned is per athlete', Number(byName['Fixture Alvarez'].earned) === 4000, byName['Fixture Alvarez'].earned);
  ok('deal count includes every stage', Number(byName['Fixture Alvarez'].deals) === 3, byName['Fixture Alvarez'].deals);
  ok('in flight excludes Closed and Lost', Number(byName['Fixture Alvarez'].in_flight) === 1,
    byName['Fixture Alvarez'].in_flight);
  ok('their Lost deal is excluded, leaving just the Prospecting one in flight',
    Number(byName['Placeholder Castellan'].in_flight) === 1 && Number(byName['Placeholder Castellan'].deals) === 2,
    { inFlight: byName['Placeholder Castellan'].in_flight, deals: byName['Placeholder Castellan'].deals });
  ok('an athlete with no earnings shows 0, not null',
    Number(byName['Placeholder Castellan'].earned) === 0, byName['Placeholder Castellan'].earned);
  ok('ordered by earned, highest first', Number(r[0].earned) >= Number(r[1].earned),
    r.map((x) => x.earned));
  ok('last activity comes from the newest of scan or outreach',
    byName['Fixture Alvarez'].last_activity > byName['Sample Bramwell'].last_activity,
    [byName['Fixture Alvarez'].last_activity, byName['Sample Bramwell'].last_activity]);
  ok('an athlete who has never done anything has an epoch marker the route maps to dormant',
    /1970/.test(byName['Placeholder Castellan'].last_activity), byName['Placeholder Castellan'].last_activity);
}

console.log('\n-- tracking start, so a delta is never invented --');
{
  const t = run(TRACK).rows[0];
  ok('the earliest stamped close is reported', !!t.since && /\d{4}-\d{2}-\d{2}/.test(t.since), t.since);
  const c = run(CLOSED).rows[0];
  ok('closed this week is 1', Number(c.this_week) === 1, c.this_week);
  ok('closed last week is 1', Number(c.last_week) === 1, c.last_week);
}

console.log('\n-- one agent never sees another agent --');
{
  seed(`
    INSERT INTO athletes (id, agent_id, data) VALUES ('at-9','ag-2','{"name":"Other Agent Athlete"}');
    INSERT INTO deals (id, athlete_id, agent_id, data) VALUES
      ('d9','at-9','ag-2', jsonb_build_object('stage','Closed','value','99999','closedAt', CURRENT_DATE::text));
    INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at)
      VALUES ('o9','ag-2','at-9','Someone Else','sent', NOW());
  `);
  ok('their money is not in the hero', Number(run(HERO).rows[0].all_time) === 14000);
  ok('nor in any week', run(WEEKS).rows.reduce((n, x) => n + Number(x.earned), 0) === 5000);
  ok('their athlete is not on the roster', run(ROSTER).rows.length === 3);
  ok('their outreach is not in the strip', Number(run(SENT).rows[0].this_week) === 3);
}

console.log('\n-- THE BACKFILL DETECTOR --');
{
  // The health endpoint's own SQL, lifted and bound the same way.
  const HB = SRV.slice(SRV.indexOf("app.get('/api/admin/deal-outcomes-health'"), SRV.indexOf('// \u2500\u2500 Weekly athlete report'));
  const qs = [...HB.matchAll(/store\.pool\.query\(\s*`([\s\S]*?)`\)/g)].map((m) => m[1]);
  ok('lifted the three health queries', qs.length === 3, qs.length);
  const [TOT, BYDAY, SPREAD] = qs;

  const verdict = () => {
    const t = run(TOT).rows[0], days = run(BYDAY).rows, sp = run(SPREAD).rows[0];
    const dated = Number(t.dated) || 0;
    const conc = (days[0] && dated) ? Number(days[0].n) / dated : 0;
    const span = sp.first_deal ? Math.round((new Date(sp.last_deal) - new Date(sp.first_deal)) / 86400000) : 0;
    return { dated, conc, span, backfilled: dated >= 5 && conc >= 0.8 && span > 14,
             rows: Number(t.rows), distinct: Number(t.distinct_deals) };
  };

  seed('DELETE FROM deal_outcomes;');
  ok('an empty ledger is not called a backfill', verdict().backfilled === false);
  ok('and reports zero rows', verdict().rows === 0);

  // A BACKFILL: ten deals created across MONTHS (the fixture first spanned 10 days,
  // under the 14-day threshold, so it was the fixture that failed to look like a
  // backfill rather than the detector failing to spot one), every outcome stamped
  // on a single day.
  seed(`DELETE FROM deal_outcomes;
    INSERT INTO deals (id, athlete_id, agent_id, data, created_at)
      SELECT 'bf'||g, 'at-1','ag-1','{"stage":"Closed","value":"1000"}'::jsonb,
             NOW() - (g * 12||' days')::interval
        FROM generate_series(1,10) g;
    INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, deal_value, closed_at)
      SELECT 'ag-1','at-1','bf'||g, 1000, DATE_TRUNC('day', NOW())
        FROM generate_series(1,10) g;`);
  const bf = verdict();
  ok('ten rows on one day, deals spanning months, is flagged', bf.backfilled === true, bf);
  ok('and the concentration is what gives it away', bf.conc === 1, bf.conc);

  // REAL CLOSES: same volume, spread across ten different days.
  seed(`DELETE FROM deal_outcomes;
    INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, deal_value, closed_at)
      SELECT 'ag-1','at-1','bf'||g, 1000, DATE_TRUNC('day', NOW()) - (g||' days')::interval
        FROM generate_series(1,10) g;`);
  const real = verdict();
  ok('the same volume spread over ten days is NOT flagged', real.backfilled === false, real);

  // THE LIMIT, STATED. A history shorter than a fortnight cannot be told apart from
  // one busy day, so the detector declines rather than guesses. The endpoint returns
  // the raw counts either way, so the judgement is available even when the verdict
  // is not.
  seed(`DELETE FROM deal_outcomes; DELETE FROM deals WHERE id LIKE 'bf%';
    INSERT INTO deals (id, athlete_id, agent_id, data, created_at)
      SELECT 'bf'||g, 'at-1','ag-1','{"stage":"Closed","value":"1000"}'::jsonb,
             NOW() - (g||' days')::interval FROM generate_series(1,10) g;
    INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, deal_value, closed_at)
      SELECT 'ag-1','at-1','bf'||g, 1000, DATE_TRUNC('day', NOW()) FROM generate_series(1,10) g;`);
  const short = verdict();
  ok('a history under a fortnight is NOT called a backfill, even clustered',
    short.backfilled === false && short.conc === 1, short);
  ok('but the concentration is still reported, so a human can judge', short.conc === 1);

  // UNDATED rows must not be mistaken for clustering.
  seed(`DELETE FROM deal_outcomes;
    INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, deal_value, closed_at)
      SELECT 'ag-1','at-1','bf'||g, 1000, NULL FROM generate_series(1,10) g;`);
  ok('an all-NULL ledger is not flagged', verdict().backfilled === false);
  ok('and it reports rows but zero dated', verdict().rows === 10 && verdict().dated === 0, verdict());

  // Duplicate rows for one deal, the reopen-and-reclose double count.
  seed(`DELETE FROM deal_outcomes;
    INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, deal_value, closed_at) VALUES
      ('ag-1','at-1','dup-1', 1000, NOW()), ('ag-1','at-1','dup-1', 1000, NOW());`);
  const d = verdict();
  ok('a deal counted twice is visible as rows > distinct deals', d.rows === 2 && d.distinct === 1, d);
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
