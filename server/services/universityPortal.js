'use strict';
// ── THE UNIVERSITY PORTAL: TEAMS AND INVENTORY ──────────────────────────────
//
// Reads for public/university.html (GET /api/university/teams and
// /api/university/inventory). UNIVERSITY TABLES ONLY: university_teams,
// university_inventory and universities (migration 013). Nothing here reads or
// writes an agent table; see migrations/007 for why that line exists.
//
// SCOPED BY THE CALLER, NEVER BY THE REQUEST. Every query takes the
// university id resolved from the signed-in user's own row and nothing from
// the query string or the body, so there is no parameter that could name
// another university.

async function universityOf(pool, universityId) {
  const r = await pool.query(
    `SELECT id, name, short_name, location FROM universities WHERE id = $1`, [universityId]);
  return r.rows[0] || null;
}

async function listTeams(pool, universityId) {
  if (!universityId) return null;
  const university = await universityOf(pool, universityId);
  const teams = (await pool.query(
    `SELECT t.id, t.name, t.sport, t.season, t.roster_size, t.venue, t.home_dates, t.market_key,
            COALESCE(SUM(i.price_cents), 0)::bigint AS inventory_cents,
            COUNT(i.id)::int AS inventory_items
       FROM university_teams t
       LEFT JOIN university_inventory i ON i.team_id = t.id AND i.university_id = t.university_id
      WHERE t.university_id = $1
      GROUP BY t.id
      ORDER BY CASE t.season WHEN 'Fall' THEN 1 WHEN 'Winter' THEN 2 WHEN 'Spring' THEN 3 ELSE 4 END,
               t.created_at, t.id`, [universityId])).rows
    .map((t) => ({ ...t, inventory_cents: Number(t.inventory_cents) }));
  // THE ATHLETES ON FILE, NOT A STORED GUESS. roster_size on a seeded team is
  // the demo figure (scripts/seed-cypress, from athletics.html); the
  // athletes are the rows the roster import wrote. Once a university has any,
  // every team's roster is its count of those (a team with none says 0), so
  // the portal's tiles and /api/admin/university-status agree.
  const counts = (await pool.query(
    `SELECT data->>'teamId' AS team_id, COUNT(*)::int n FROM university_athletes WHERE university_id = $1 GROUP BY 1`, [universityId]).catch(() => ({ rows: [] }))).rows;
  if (counts.length) {
    const by = new Map(counts.map((c) => [c.team_id, c.n]));
    for (const t of teams) { t.roster_size_stated = t.roster_size; t.roster_size = by.get(t.id) || 0; t.athletes_on_file = by.get(t.id) || 0; }
  }
  return { university, teams };
}

async function listInventory(pool, universityId) {
  if (!universityId) return null;
  const university = await universityOf(pool, universityId);
  const items = (await pool.query(
    `SELECT i.id, i.team_id, i.name, i.price_cents, i.status,
            t.name AS team_name, t.season
       FROM university_inventory i
       LEFT JOIN university_teams t ON t.id = i.team_id AND t.university_id = i.university_id
      WHERE i.university_id = $1
      ORDER BY (i.team_id IS NULL),
               CASE t.season WHEN 'Fall' THEN 1 WHEN 'Winter' THEN 2 WHEN 'Spring' THEN 3 ELSE 4 END,
               t.created_at, i.id`, [universityId])).rows;
  return { university, items };
}

module.exports = { listTeams, listInventory, universityOf };
