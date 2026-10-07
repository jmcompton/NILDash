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

async function run(pool, universityId, { apply = false } = {}) {
  const p = await plan(pool, universityId);
  const out = { ok: true, universityId, apply, teamsBefore: p.teams, merges: [], teamsAfter: p.teams - p.merges.reduce((a, m) => a + m.drop.length, 0) };
  const tables = await teamIdTables(pool);
  for (const m of p.merges) {
    const rec = { keep: { id: m.keep.id, name: m.keep.name, renamedTo: m.name !== m.keep.name ? m.name : null }, dropped: [] };
    for (const d of m.drop) {
      const ath = await athletesOf(pool, universityId, d);
      const keepAth = new Set((await athletesOf(pool, universityId, m.keep)).map((a) => slug(a.name)));
      const r = { id: d.id, name: d.name, athletes: ath.length, athletesMoved: 0, athletesAlreadyOnKept: 0, rows: {} };
      for (const t of tables) r.rows[t] = (await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE team_id = $1`, [d.id])).rows[0].n;
      for (const a of ath) { if (keepAth.has(slug(a.name))) r.athletesAlreadyOnKept++; else r.athletesMoved++; }
      if (apply) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          for (const a of ath) {
            if (keepAth.has(slug(a.name))) { await c.query(`DELETE FROM university_athletes WHERE id = $1`, [a.id]); continue; }
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
          // The deleted team out of every business's team fit.
          await c.query(`UPDATE university_contacts SET team_fit = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(team_fit) x WHERE x->>'team_id' <> $2), '[]'::jsonb)
                          WHERE university_id = $1 AND team_fit IS NOT NULL AND team_fit::text LIKE '%' || $2 || '%'`, [universityId, d.id]);
          await c.query(`DELETE FROM university_teams WHERE id = $1`, [d.id]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          out.ok = false; r.error = e.message;
        } finally { c.release(); }
      }
      rec.dropped.push(r);
    }
    if (apply && out.ok) {
      await pool.query(`UPDATE university_teams SET name = $2, sport = $3, updated_at = NOW() WHERE id = $1`,
        [m.keep.id, m.name, String(m.name).replace(/^(Men's|Women's)\s+/, '')]);
      await pool.query(`UPDATE university_athletes SET sport = $3 WHERE university_id = $1 AND (data->>'teamId' = $2)`, [universityId, m.keep.id, m.name]);
    }
    out.merges.push(rec);
  }
  if (apply) out.teamsAfter = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  out.athletesMoved = out.merges.reduce((a, m) => a + m.dropped.reduce((b, d) => b + d.athletesMoved, 0), 0);
  out.athletesAlreadyOnKept = out.merges.reduce((a, m) => a + m.dropped.reduce((b, d) => b + d.athletesAlreadyOnKept, 0), 0);
  return out;
}

function format(r) {
  const L = [`${r.apply ? 'MERGED' : 'DRY RUN (add apply=1 to do it)'}: ${r.universityId}, ${r.teamsBefore} teams -> ${r.teamsAfter}`];
  if (!r.merges.length) L.push('  no duplicate teams');
  for (const m of r.merges) {
    L.push(`  KEEP ${m.keep.id} "${m.keep.name}"${m.keep.renamedTo ? ` -> renamed "${m.keep.renamedTo}"` : ''}`);
    for (const d of m.dropped) {
      const rows = Object.entries(d.rows).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
      L.push(`    DROP ${d.id} "${d.name}": ${d.athletes} athletes (${d.athletesMoved} moved, ${d.athletesAlreadyOnKept} already on the kept roster); rows moved: ${rows}${d.error ? '; FAILED: ' + d.error : ''}`);
    }
  }
  L.push(`ATHLETES MOVED: ${r.athletesMoved} (${r.athletesAlreadyOnKept} were on both rosters and kept once)`, `TEAMS AFTER: ${r.teamsAfter}`);
  return L.join('\n');
}

module.exports = { run, plan, format };
