'use strict';
// ── THE NIL OFFICE'S DAY: TODAY AND IN PROGRESS (university portal) ─────────
//
// Two reads for public/university.html, built only from what the department
// already has:
//
//   today(pool, universityId)     the home screen: what is waiting to approve,
//                                 who replied, deals done and paid, which teams
//                                 have the fewest deals, athlete applications
//   progress(pool, universityId)  every business past "not contacted", by
//                                 stage, with its last touch, and every deal
//
// UNIVERSITY TABLES ONLY (migrations/007): university_drafts, university_crm,
// university_touches, university_deals, university_teams, universities and
// university_applications. No agent table is read. Every query is scoped by
// the university id, which the route takes from the session. Reads only.

const STAGE_LABEL = { contacted: 'Pitched', replied: 'Replied', in_talks: 'Working out terms', deal_signed: 'Deal done', declined: 'Said no' };
const ACTIVE = ['contacted', 'replied', 'in_talks', 'deal_signed'];
const PER_STAGE = 60;

const exists = async (pool, table) => !!(await pool.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
const int = (v) => Number(v) || 0;

// The latest night's pitches for the department: how many still wait on staff.
async function leads(pool, universityId) {
  if (!(await exists(pool, 'university_drafts'))) return { night: null, total: 0, waiting: 0, teams: 0 };
  const r = (await pool.query(
    `SELECT MAX(night) AS night FROM university_drafts WHERE university_id = $1 AND kind = 'pitch' AND night IS NOT NULL`, [universityId])).rows[0];
  if (!r || !r.night) return { night: null, total: 0, waiting: 0, teams: 0 };
  const c = (await pool.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE d.sent_at IS NULL AND d.status = 'awaiting_approval'
                               AND COALESCE(cr.stage, 'not_contacted') = 'not_contacted')::int waiting,
            COUNT(DISTINCT d.team_id)::int teams
       FROM university_drafts d
       LEFT JOIN university_crm cr ON cr.university_id = d.university_id AND cr.brand = d.brand_name
      WHERE d.university_id = $1 AND d.kind = 'pitch' AND d.night = $2`, [universityId, r.night])).rows[0];
  return { night: r.night, total: c.total, waiting: c.waiting, teams: c.teams };
}

async function today(pool, universityId) {
  const uni = (await pool.query(`SELECT id, name, short_name FROM universities WHERE id = $1`, [universityId])).rows[0] || null;
  const L = await leads(pool, universityId);

  const stages = {};
  if (await exists(pool, 'university_crm')) {
    for (const r of (await pool.query(
      `SELECT stage, COUNT(*)::int n FROM university_crm WHERE university_id = $1 GROUP BY stage`, [universityId])).rows) stages[r.stage] = r.n;
  }

  // Businesses that answered and are waiting on the office, newest first.
  let replies = [];
  if (await exists(pool, 'university_crm')) {
    replies = (await pool.query(
      `SELECT cr.brand, cr.stage, cr.last_touch_at, cr.notes,
              (SELECT t.summary FROM university_touches t WHERE t.university_id = cr.university_id AND t.brand = cr.brand
                ORDER BY (t.direction = 'in') DESC, t.at DESC LIMIT 1) AS said,
              (SELECT tm.name FROM university_touches t JOIN university_teams tm ON tm.id = t.team_id
                WHERE t.university_id = cr.university_id AND t.brand = cr.brand AND t.team_id IS NOT NULL ORDER BY t.at DESC LIMIT 1) AS team
         FROM university_crm cr
        WHERE cr.university_id = $1 AND cr.stage IN ('replied', 'in_talks')
        ORDER BY cr.last_touch_at DESC NULLS LAST, cr.updated_at DESC
        LIMIT 8`, [universityId])).rows.map((r) => ({
      brand: r.brand, stage: r.stage, stageLabel: STAGE_LABEL[r.stage] || r.stage, team: r.team || null,
      said: r.said || r.notes || null, at: r.last_touch_at || null }));
  }

  // Deals: how many, how much, this month, and by team.
  let deals = { count: 0, cents: 0, monthCount: 0, monthCents: 0, athletes: 0 };
  const dealsByTeam = new Map();
  if (await exists(pool, 'university_deals')) {
    const d = (await pool.query(
      `SELECT COUNT(*)::int count, COALESCE(SUM(value_cents), 0)::bigint cents,
              COUNT(*) FILTER (WHERE COALESCE(signed_on, created_at::date) >= date_trunc('month', CURRENT_DATE))::int month_count,
              COALESCE(SUM(value_cents) FILTER (WHERE COALESCE(signed_on, created_at::date) >= date_trunc('month', CURRENT_DATE)), 0)::bigint month_cents,
              COUNT(DISTINCT NULLIF(TRIM(athlete_name), ''))::int athletes
         FROM university_deals WHERE university_id = $1`, [universityId])).rows[0];
    deals = { count: d.count, cents: int(d.cents), monthCount: d.month_count, monthCents: int(d.month_cents), athletes: d.athletes };
    for (const r of (await pool.query(
      `SELECT team_id, COUNT(*)::int n, COALESCE(SUM(value_cents), 0)::bigint cents FROM university_deals
        WHERE university_id = $1 AND team_id IS NOT NULL GROUP BY team_id`, [universityId])).rows) dealsByTeam.set(r.team_id, { n: r.n, cents: int(r.cents) });
  }

  // Every team, fewest deals first: the ones the office should push next.
  const leadsByTeam = new Map();
  if (L.night) {
    for (const r of (await pool.query(
      `SELECT team_id, COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND kind = 'pitch' AND night = $2 AND sent_at IS NULL
        GROUP BY team_id`, [universityId, L.night])).rows) leadsByTeam.set(r.team_id, r.n);
  }
  const teams = (await pool.query(
    `SELECT id, name, sport, roster_size FROM university_teams WHERE university_id = $1 ORDER BY name`, [universityId])).rows
    .map((t) => ({ id: t.id, name: t.name, athletes: t.roster_size || 0, deals: (dealsByTeam.get(t.id) || {}).n || 0,
      cents: (dealsByTeam.get(t.id) || {}).cents || 0, waiting: leadsByTeam.get(t.id) || 0 }))
    .sort((a, b) => a.deals - b.deals || b.athletes - a.athletes || a.name.localeCompare(b.name));

  // Athlete Deals (services/universityApply), when the table exists.
  let athletes = null;
  if (await exists(pool, 'university_applications')) {
    const a = (await pool.query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE state IN ('open', 'sent'))::int open,
              COUNT(*) FILTER (WHERE state IN ('applied', 'accepted'))::int applied,
              COUNT(*) FILTER (WHERE state = 'accepted')::int accepted,
              COUNT(DISTINCT athlete_id)::int covered
         FROM university_applications WHERE university_id = $1`, [universityId])).rows[0];
    const roster = (await pool.query(
      `SELECT COUNT(*)::int n FROM university_athletes WHERE university_id = $1 AND name IS NOT NULL`, [universityId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    athletes = { roster, ...a };
  }

  return {
    university: uni,
    leads: L,
    pipeline: { contacted: stages.contacted || 0, replied: stages.replied || 0, inTalks: stages.in_talks || 0,
      dealSigned: stages.deal_signed || 0, declined: stages.declined || 0 },
    replies, deals, teams, athletes,
  };
}

// Every business past "not contacted", by stage, with its last touch, and
// every deal. The In progress screen.
async function progress(pool, universityId) {
  const out = { stages: ACTIVE.map((s) => ({ key: s, label: STAGE_LABEL[s], rows: [], total: 0 })), deals: [] };
  if (await exists(pool, 'university_crm')) {
    for (const st of out.stages) {
      st.total = (await pool.query(`SELECT COUNT(*)::int n FROM university_crm WHERE university_id = $1 AND stage = $2`, [universityId, st.key])).rows[0].n;
      st.rows = (await pool.query(
        `SELECT cr.brand, cr.notes, cr.last_touch_at,
                (SELECT t.summary FROM university_touches t WHERE t.university_id = cr.university_id AND t.brand = cr.brand ORDER BY t.at DESC LIMIT 1) AS last,
                (SELECT t.channel FROM university_touches t WHERE t.university_id = cr.university_id AND t.brand = cr.brand ORDER BY t.at DESC LIMIT 1) AS channel,
                (SELECT tm.name FROM university_touches t JOIN university_teams tm ON tm.id = t.team_id
                  WHERE t.university_id = cr.university_id AND t.brand = cr.brand AND t.team_id IS NOT NULL ORDER BY t.at DESC LIMIT 1) AS team,
                (SELECT COUNT(*)::int FROM university_touches t WHERE t.university_id = cr.university_id AND t.brand = cr.brand) AS touches
           FROM university_crm cr
          WHERE cr.university_id = $1 AND cr.stage = $2
          ORDER BY cr.last_touch_at DESC NULLS LAST, cr.updated_at DESC
          LIMIT ${PER_STAGE}`, [universityId, st.key])).rows.map((r) => ({
        brand: r.brand, team: r.team || null, last: r.last || r.notes || null, channel: r.channel || null,
        at: r.last_touch_at || null, touches: r.touches || 0, daysQuiet: r.last_touch_at ? Math.floor((Date.now() - new Date(r.last_touch_at).getTime()) / 86400000) : null }));
    }
  }
  if (await exists(pool, 'university_deals')) {
    out.deals = (await pool.query(
      `SELECT d.id, d.brand, d.athlete_name, d.value_cents, d.description, d.signed_on, d.created_at, t.name AS team
         FROM university_deals d LEFT JOIN university_teams t ON t.id = d.team_id
        WHERE d.university_id = $1 ORDER BY COALESCE(d.signed_on, d.created_at::date) DESC, d.id DESC LIMIT 200`, [universityId])).rows
      .map((d) => ({ id: d.id, brand: d.brand, team: d.team || null, athlete: d.athlete_name || null, cents: d.value_cents == null ? null : int(d.value_cents),
        what: d.description || null, on: d.signed_on || d.created_at }));
  }
  return out;
}

module.exports = { today, progress, STAGE_LABEL, ACTIVE };
