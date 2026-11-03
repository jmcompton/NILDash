'use strict';
// ── HEAD COACHING CHANGES ───────────────────────────────────────────────────
//
// A new head coach is the biggest roster signal there is: the room gets
// reshuffled, players leave, and the NCAA opens a 30-day transfer window for the
// old coach's players once a new one is named. Under the Protect College Sports
// Act a head coach leaving is also an exception that keeps a second transfer
// from costing a year (services/pcsa).
//
// Two sources, both shown with where they came from:
//   SEEDED    the changes below, each with a public report.
//   TABLE     portal_coaching_changes: added by the admin route (or the morning
//             run) as the carousel moves. A table row for a school wins over a
//             seeded one.
// The program map's staff rows are NOT used: a refresh rewrites every row's
// updated_at, and "Assistant Head Coach" titles are filed as previous head
// coaches, so they would show a coaching change at nearly every school. A
// change here is one somebody reported, with the report linked.

const SEEDED = [
  { school: 'Maryland', coach: 'Mike Locksley', how: 'fired', date: '2026-10-21', source: 'https://sports.yahoo.com/articles/college-football-coaching-carousel-tracker-163144469.html' },
  { school: 'NC State', coach: 'Dave Doeren', how: 'fired', date: '2026-10-23', interim: 'Todd Goebbel', source: 'http://www.cfbeveryday.com/head-coach-changes-during-season/2026/9/28/head-coaches-fired-or-resigned-during-the-season-2026' },
  { school: 'Baylor', coach: 'Dave Aranda', how: 'fired', date: '2026-10-24', interim: 'Joe Klanderman', source: 'http://www.cfbeveryday.com/head-coach-changes-during-season/2026/9/28/head-coaches-fired-or-resigned-during-the-season-2026' },
  { school: 'Sam Houston', coach: 'Phil Longo', how: 'fired', date: '2026-10-28', source: 'https://www.saturdaydownsouth.com/news/college-football/conference-usa-team-announces-firing-of-head-coach/' },
];

const RECENT_DAYS = 150;   // a change this old still shapes this offseason's roster

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_coaching_changes (
    school TEXT NOT NULL, sport TEXT NOT NULL DEFAULT 'football',
    coach TEXT, how TEXT, change_date DATE, interim TEXT, new_coach TEXT, source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (school, sport))`);
}

function recent(dateStr, now) {
  const d = new Date(String(dateStr || '') + (String(dateStr || '').length === 10 ? 'T12:00:00Z' : ''));
  if (isNaN(d)) return false;
  const days = (now - d) / 86400000;
  return days >= -1 && days <= RECENT_DAYS;
}

// school -> { school, coach, how, date, interim, newCoach, source, via }
async function load(pool, { now = new Date(), sport = 'football' } = {}) {
  const out = new Map();
  for (const c of SEEDED) if (recent(c.date, now)) out.set(c.school, { ...c, via: 'seeded' });
  if (pool) {
    try {
      await ensureTable(pool);
      const r = await pool.query(`SELECT school, coach, how, change_date::text AS date, interim, new_coach, source FROM portal_coaching_changes WHERE sport = $1`, [sport]);
      for (const x of r.rows) if (recent(x.date, now)) out.set(x.school, { school: x.school, coach: x.coach, how: x.how, date: x.date, interim: x.interim, newCoach: x.new_coach, source: x.source, via: 'added' });
    } catch (e) { console.warn('[portal] coaching changes table:', e.message); }
  }
  return out;
}

async function add(pool, c) {
  const school = require('./schools').canonical(c.school);
  if (!school) { const e = new Error('unknown FBS school'); e.status = 400; throw e; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || ''))) { const e = new Error('date must be YYYY-MM-DD'); e.status = 400; throw e; }
  await ensureTable(pool);
  const clip = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
  await pool.query(`INSERT INTO portal_coaching_changes (school, sport, coach, how, change_date, interim, new_coach, source)
    VALUES ($1,'football',$2,$3,$4,$5,$6,$7)
    ON CONFLICT (school, sport) DO UPDATE SET coach=EXCLUDED.coach, how=EXCLUDED.how, change_date=EXCLUDED.change_date,
      interim=EXCLUDED.interim, new_coach=EXCLUDED.new_coach, source=EXCLUDED.source`,
    [school, clip(c.coach, 80), clip(c.how, 30), c.date, clip(c.interim, 80), clip(c.newCoach, 80), clip(c.source, 500)]);
  return { school };
}

function describe(c) {
  if (!c) return null;
  const when = new Date(c.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  let t = `New head coach coming: ${c.coach || 'the head coach'} ${c.how === 'fired' ? 'was fired' : c.how === 'resigned' ? 'resigned' : 'left'} ${when}`;
  if (c.newCoach) t += `, ${c.newCoach} hired`;
  else if (c.interim) t += `, ${c.interim} is interim`;
  return t + '. A new staff reshuffles the room.';
}

module.exports = { SEEDED, load, add, describe, ensureTable, RECENT_DAYS };
