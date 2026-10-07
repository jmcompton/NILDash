'use strict';
// ── MERGE A UNIVERSITY'S DUPLICATE TEAMS ────────────────────────────────────
// Two rows that are one team (teamNames.teamKey: "Women's Swim & Dive" and
// "Women's Swimming & Diving") become one: the kept team takes the canonical
// name, every athlete, every card and every other row that names the
// duplicate's team_id; then the duplicate row is deleted. Dry run unless apply.
//
// Which row is kept: the one already named canonically ("Swim & Dive"), then
// the one with more athletes, then the shorter id.
// An athlete on both rosters (same name) is one athlete: the duplicate's row
// is dropped, not moved.
const TN = require('./teamNames');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function teamIdTables(pool) {
  return (await pool.query(`SELECT table_name FROM information_schema.columns
                             WHERE table_schema = 'public' AND column_name = 'team_id' AND table_name <> 'university_teams' ORDER BY 1`)).rows.map((r) => r.table_name);
}

async function athletesOf(pool, universityId, team) {
  return (await pool.query(`SELECT id, name, data FROM university_athletes WHERE university_id = $1
                              AND (id LIKE $2 OR data->>'teamId' = $3 OR sport = $4)`,
    [universityId, team.id.replace(/[%_]/g, '\\$&') + ':%', team.id, team.name])).rows;
}

async function plan(pool, universityId) {
  const teams = (await pool.query(`SELECT id, name FROM university_teams WHERE university_id = $1 ORDER BY id`, [universityId])).rows;
  const groups = new Map();
  for (const t of teams) {
    const k = TN.teamKey(t.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const merges = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const t of g) t.athletes = (await athletesOf(pool, universityId, t)).length;
    g.sort((a, b) => ((b.name === TN.canonicalName(b.name) ? 1 : 0) - (a.name === TN.canonicalName(a.name) ? 1 : 0))
      || (b.athletes - a.athletes) || (a.id.length - b.id.length) || a.id.localeCompare(b.id));
    merges.push({ keep: g[0], name: TN.canonicalName(g[0].name), drop: g.slice(1) });
  }
  return { teams: teams.length, merges };
}

// What a group of rows holds, read inside the merge's own transaction.
async function holdings(c, universityId, teams) {
  const ids = teams.map((t) => t.id);
  const ath = new Set();
  for (const t of teams) for (const a of await athletesOf(c, universityId, t)) ath.add(slug(a.name));
  const inv = (await c.query(`SELECT COUNT(*)::int n, COALESCE(SUM(price_cents), 0)::int cents FROM university_inventory WHERE team_id = ANY($1::text[])`, [ids])
    .catch(() => ({ rows: [{ n: 0, cents: 0 }] }))).rows[0];
  const hd = (await c.query(`SELECT COALESCE(MAX(home_dates), 0)::int h FROM university_teams WHERE id = ANY($1::text[])`, [ids])).rows[0].h;
  return { athletes: ath.size, inventoryItems: inv.n, inventoryCents: inv.cents, homeDates: hd };
}

// ONE GROUP, IN ONE TRANSACTION. The real Cypress split is roster on one row
// and schedule and inventory on the other ("Men's Swimming & Diving": 16
// athletes, no home dates, $0; "Men's Swim & Dive": 0 athletes, 7 home
// dates, $1,250), so the kept row takes everything from both: athletes,
// inventory, cards and every team_id row, and any of its own empty fields
// (home dates, venue, season, the roster URL) from the dropped row; its
// roster_size is the athletes it holds after. The dry run does exactly this
// and rolls back, so its AFTER numbers are what apply would leave. If the
// athletes, the inventory or the home dates would drop, it refuses and rolls
// back, dry run or not.
async function mergeGroup(pool, universityId, m, tables, apply) {
  const c = await pool.connect();
  const rec = { keep: { id: m.keep.id, name: m.keep.name, renamedTo: m.name !== m.keep.name ? m.name : null }, dropped: [], before: null, after: null };
  try {
    await c.query('BEGIN');
    rec.before = await holdings(c, universityId, [m.keep, ...m.drop]);
    rec.beforeByRow = [];
    for (const t of [m.keep, ...m.drop]) rec.beforeByRow.push({ id: t.id, name: t.name, ...(await holdings(c, universityId, [t])) });
    const keepAth = new Set((await athletesOf(c, universityId, m.keep)).map((a) => slug(a.name)));
    for (const d of m.drop) {
      const ath = await athletesOf(c, universityId, d);
      const r = { id: d.id, name: d.name, athletes: ath.length, athletesMoved: 0, athletesAlreadyOnKept: 0, rows: {} };
      for (const t of tables) r.rows[t] = (await c.query(`SELECT COUNT(*)::int n FROM ${t} WHERE team_id = $1`, [d.id])).rows[0].n;
      for (const a of ath) {
        if (keepAth.has(slug(a.name))) { r.athletesAlreadyOnKept++; await c.query(`DELETE FROM university_athletes WHERE id = $1`, [a.id]); continue; }
        r.athletesMoved++;
        const data = { ...(a.data || {}), teamId: m.keep.id, team: m.name };
        await c.query(`UPDATE university_athletes SET id = $2, sport = $3, data = $4, updated_at = NOW() WHERE id = $1`,
          [a.id, `${m.keep.id}:${slug(a.name)}`, m.name, JSON.stringify(data)]);
        keepAth.add(slug(a.name));
      }
      // Every row naming the duplicate: moved; one that would collide with
      // the kept team's own row (a key on team_id) is dropped instead.
      for (const t of tables) {
        await c.query('SAVEPOINT mv');
        try {
          await c.query(`UPDATE ${t} SET team_id = $2 WHERE team_id = $1`, [d.id, m.keep.id]);
          await c.query('RELEASE SAVEPOINT mv');
        } catch (_) {
          await c.query('ROLLBACK TO SAVEPOINT mv');
          const ids = (await c.query(`SELECT ctid FROM ${t} WHERE team_id = $1`, [d.id])).rows;
          for (const row of ids) {
            await c.query('SAVEPOINT one');
            try { await c.query(`UPDATE ${t} SET team_id = $2 WHERE ctid = $1`, [row.ctid, m.keep.id]); await c.query('RELEASE SAVEPOINT one'); }
            catch (_e) { await c.query('ROLLBACK TO SAVEPOINT one'); await c.query(`DELETE FROM ${t} WHERE ctid = $1`, [row.ctid]); }
          }
        }
      }
      // The kept row's empty fields from the dropped one (the schedule side).
      await c.query(
        `UPDATE university_teams k SET home_dates = GREATEST(COALESCE(k.home_dates, 0), COALESCE(d.home_dates, 0)),
                venue = COALESCE(k.venue, d.venue), season = COALESCE(k.season, d.season), market_key = COALESCE(k.market_key, d.market_key)
           FROM university_teams d WHERE k.id = $1 AND d.id = $2`, [m.keep.id, d.id]);
      for (const col of ['roster_url', 'source', 'roster_imported_at']) {
        await c.query(`UPDATE university_teams k SET ${col} = COALESCE(k.${col}, d.${col}) FROM university_teams d WHERE k.id = $1 AND d.id = $2`, [m.keep.id, d.id]).catch(() => {});
      }
      await c.query(`UPDATE university_contacts SET team_fit = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(team_fit) x WHERE x->>'team_id' <> $2), '[]'::jsonb)
                      WHERE university_id = $1 AND team_fit IS NOT NULL AND team_fit::text LIKE '%' || $2 || '%'`, [universityId, d.id]);
      await c.query(`DELETE FROM university_teams WHERE id = $1`, [d.id]);
      rec.dropped.push(r);
    }
    await c.query(`UPDATE university_teams SET name = $2, sport = $3, updated_at = NOW() WHERE id = $1`,
      [m.keep.id, m.name, String(m.name).replace(/^(Men's|Women's)\s+/, '')]);
    await c.query(`UPDATE university_athletes SET sport = $3 WHERE university_id = $1 AND data->>'teamId' = $2`, [universityId, m.keep.id, m.name]);
    rec.after = await holdings(c, universityId, [{ ...m.keep, name: m.name }]);
    await c.query(`UPDATE university_teams SET roster_size = $2 WHERE id = $1`, [m.keep.id, rec.after.athletes]);
    const drops = ['athletes', 'inventoryItems', 'inventoryCents', 'homeDates'].filter((k) => rec.after[k] < rec.before[k]);
    if (drops.length) rec.refused = `${drops.map((k) => `${k} ${rec.before[k]} -> ${rec.after[k]}`).join(', ')} would drop`;
    await c.query(apply && !rec.refused ? 'COMMIT' : 'ROLLBACK');
    rec.applied = apply && !rec.refused;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    rec.error = e.message;
  } finally { c.release(); }
  return rec;
}

async function run(pool, universityId, { apply = false } = {}) {
  const p = await plan(pool, universityId);
  const out = { ok: true, universityId, apply, teamsBefore: p.teams, merges: [], teamsAfter: p.teams - p.merges.reduce((a, m) => a + m.drop.length, 0) };
  const tables = await teamIdTables(pool);
  for (const m of p.merges) {
    const rec = await mergeGroup(pool, universityId, m, tables, apply);
    if (rec.refused || rec.error) out.ok = false;
    out.merges.push(rec);
  }
  if (apply) out.teamsAfter = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  out.athletesMoved = out.merges.reduce((a, m) => a + m.dropped.reduce((b, d) => b + d.athletesMoved, 0), 0);
  out.athletesAlreadyOnKept = out.merges.reduce((a, m) => a + m.dropped.reduce((b, d) => b + d.athletesAlreadyOnKept, 0), 0);
  return out;
}

function format(r) {
  const $ = (cents) => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const h = (x) => `${x.athletes} athletes, ${x.inventoryItems} inventory items ${$(x.inventoryCents)}, ${x.homeDates} home dates`;
  const L = [`${r.apply ? 'MERGE' : 'DRY RUN (the merge done and rolled back; add apply=1 to keep it)'}: ${r.universityId}, ${r.teamsBefore} teams -> ${r.teamsAfter}`];
  if (!r.merges.length) L.push('  no duplicate teams');
  for (const m of r.merges) {
    L.push('', `  KEEP ${m.keep.id} "${m.keep.name}"${m.keep.renamedTo ? ` -> renamed "${m.keep.renamedTo}"` : ''}`);
    for (const row of m.beforeByRow || []) L.push(`    now  ${row.id.padEnd(28)} "${row.name}": ${h(row)}`);
    for (const d of m.dropped) {
      const rows = Object.entries(d.rows).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
      L.push(`    DROP ${d.id} "${d.name}": ${d.athletesMoved} athletes moved, ${d.athletesAlreadyOnKept} already on the kept roster; rows moved: ${rows}`);
    }
    if (m.before) L.push(`    BEFORE (both rows): ${h(m.before)}`);
    if (m.after) L.push(`    AFTER  (kept row):  ${h(m.after)}`);
    if (m.refused) L.push(`    REFUSED, rolled back: ${m.refused}`);
    else if (m.error) L.push(`    FAILED, rolled back: ${m.error}`);
    else L.push(`    ${m.applied ? 'DONE' : 'would be done'}: nothing drops`);
  }
  L.push('', `ATHLETES MOVED: ${r.athletesMoved} (${r.athletesAlreadyOnKept} were on both rosters and kept once)`, `TEAMS AFTER: ${r.teamsAfter}${r.ok ? '' : '  (NOT ALL MERGED: see REFUSED / FAILED above)'}`);
  return L.join('\n');
}

module.exports = { run, plan, format };
