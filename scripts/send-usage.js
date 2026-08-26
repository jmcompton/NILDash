#!/usr/bin/env node
'use strict';
// ── WHAT IS ACTUALLY BEING SENT, AGAINST WHAT IS ALLOWED ─────────────────────
//
//   node scripts/send-usage.js                 last 14 days, every account
//   node scripts/send-usage.js --days 30       a longer window
//   node scripts/send-usage.js --agent <id|email>
//   node scripts/send-usage.js --sql           print the SQL and exit
//
// TWO COUNTS, NOT ONE, and the gap between them is the point.
//
//   reserved   agent_send_budget.sent -- what sendGuard handed out permission
//              for. This is the number the ceiling is enforced against.
//   sent       outreach_logs rows with a real sent_at on that day. This is what
//              actually left the building.
//
// They should match. If `sent` exceeds `reserved`, something is putting mail on
// the wire without going through sendGuard.reserve, and the ceiling is not a
// ceiling. If `reserved` exceeds `sent`, sends were reserved and then failed
// without release() giving the allowance back -- the agent is being charged for
// mail nobody received. Either way, guessing would not have shown it.
//
// The day is the AGENT'S local date, from users.report_tz, because that is the
// boundary the cap resets on. Comparing against a UTC day would show a bogus
// overspend every evening for anyone west of Greenwich.

const path = require('path');

const SQL = `
SELECT u.id                                             AS agent_id,
       u.email,
       COALESCE(u.report_tz, 'America/Chicago')         AS tz,
       -- Mirrors sendGuard.capFor exactly: a value is used only when it is a
       -- positive number. NULL, 0 and anything negative mean "unset" and fall
       -- back to the default, so this report cannot claim a ceiling of 0 that
       -- the guard would never enforce.
       COALESCE(NULLIF(GREATEST(COALESCE(u.daily_email_cap, 0), 0), 0),
                $1::int)                                 AS limit_today,
       CASE WHEN COALESCE(u.daily_email_cap, 0) > 0
            THEN 'per-account' ELSE 'default' END        AS limit_source,
       d.day,
       COALESCE(b.sent, 0)                              AS reserved,
       COALESCE(s.sent, 0)                              AS actually_sent,
       COALESCE(s.sent, 0) - COALESCE(b.sent, 0)        AS drift,
       ROUND(100.0 * COALESCE(b.sent, 0)
             / COALESCE(NULLIF(GREATEST(COALESCE(u.daily_email_cap, 0), 0), 0),
                        $1::int), 1)                     AS pct_of_limit,
       b.blocked_at IS NOT NULL                         AS blocked,
       b.blocked_reason
  FROM users u
  -- Every local date in the window, per agent, so a day with no sends still
  -- prints a zero rather than vanishing from the report.
  CROSS JOIN LATERAL (
    SELECT generate_series(
      (NOW() AT TIME ZONE COALESCE(u.report_tz, 'America/Chicago'))::date - ($2::int - 1),
      (NOW() AT TIME ZONE COALESCE(u.report_tz, 'America/Chicago'))::date,
      INTERVAL '1 day')::date AS day
  ) d
  LEFT JOIN agent_send_budget b
         ON b.agent_id = u.id AND b.local_date = d.day
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS sent
      FROM outreach_logs l
     WHERE l.agent_id = u.id
       AND l.sent_at IS NOT NULL
       AND (l.sent_at AT TIME ZONE COALESCE(u.report_tz, 'America/Chicago'))::date = d.day
  ) s ON TRUE
 WHERE u.role = 'agent'
   AND ($3::text IS NULL OR u.id = $3 OR LOWER(u.email) = LOWER($3))
   -- A row is worth printing only if something happened on it, or if the account
   -- has a raised limit worth watching.
   AND (COALESCE(b.sent,0) > 0 OR COALESCE(s.sent,0) > 0 OR COALESCE(u.daily_email_cap, 0) > 0)
 ORDER BY u.email, d.day DESC`;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

(async () => {
  if (process.argv.includes('--sql')) { console.log(SQL); process.exit(0); }

  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set, so this would report on the wrong database.');
    process.exit(1);
  }
  const store = require(path.join(__dirname, '..', 'server', 'store'));
  // The same default the guard uses, read the same way, so this report cannot
  // disagree with the thing it is reporting on.
  const DEFAULT_CAP = parseInt(process.env.AGENT_DAILY_EMAIL_CAP, 10) || 40;
  const days = parseInt(arg('days', '14'), 10) || 14;
  const who = arg('agent', null);

  const rows = (await store.pool.query(SQL, [DEFAULT_CAP, days, who])).rows;
  if (!rows.length) {
    console.log('No send activity in the last ' + days + ' days'
      + (who ? ' for ' + who : '') + ', and no account has a raised limit.');
    process.exit(0);
  }

  const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
  const lpad = (s, n) => String(s == null ? '' : s).padStart(n);
  console.log('');
  console.log(pad('EMAIL', 30) + pad('DAY', 12) + lpad('RESV', 6) + lpad('SENT', 6)
    + lpad('DRIFT', 7) + lpad('LIMIT', 7) + '  ' + pad('SOURCE', 12) + 'NOTE');
  console.log('-'.repeat(96));
  let lastEmail = null;
  for (const r of rows) {
    const note = r.blocked ? ('BLOCKED — ' + (r.blocked_reason || ''))
      : (Number(r.drift) !== 0 ? 'drift: reserved and sent disagree' : '');
    console.log(
      pad(r.email === lastEmail ? '' : r.email, 30)
      + pad(r.day.toISOString ? r.day.toISOString().slice(0, 10) : r.day, 12)
      + lpad(r.reserved, 6) + lpad(r.actually_sent, 6) + lpad(r.drift, 7)
      + lpad(r.limit_today, 7) + '  ' + pad(r.limit_source, 12) + note);
    lastEmail = r.email;
  }

  const drifting = rows.filter((r) => Number(r.drift) !== 0);
  console.log('');
  if (drifting.length) {
    console.log(drifting.length + ' day(s) where reserved and sent disagree. A positive drift means'
      + ' mail went out without passing sendGuard.reserve, so the ceiling did not hold it;'
      + ' a negative one means reservations were taken for sends that failed and never released.');
  } else {
    console.log('Reserved and sent agree on every day in the window.');
  }
  process.exit(0);
})().catch((e) => { console.error('send-usage failed:', e.message); process.exit(1); });
