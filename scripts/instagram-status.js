'use strict';
// EVERY ATHLETE'S INSTAGRAM, ONE LINE EACH. Read only.
//
// Connected or not (and why), the scopes granted, the last sync and the last
// error in plain words, followers, and the local share (followers in the
// school's city, from Instagram's follower demographics). A screenshot is
// shown as one, never as verified.
//
//   node scripts/instagram-status.js [--agent <email>]
//   /api/admin/scripts/instagram-status?text=1            (&agent=<email>)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };

async function run(pool, opts = {}) {
  const IG = require(ROOT + 'server/services/instagramConnect.js');
  const II = require(ROOT + 'server/services/instagramInsights.js');
  const AR = require(ROOT + 'server/services/athleteRecord.js');
  await IG.ensureTables(pool);
  const rows = (await pool.query(
    `SELECT a.id, a.data, u.name AS agent, u.email AS agent_email, c.status, c.status_reason, c.scopes_granted, c.needs_reconnect_for_insights,
            c.last_synced_at, c.last_sync_error, c.last_error_kind, c.username, c.account_type
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id LEFT JOIN instagram_connections c ON c.athlete_id = a.id
      WHERE ($1::text IS NULL OR LOWER(u.email) = LOWER($1))
      ORDER BY (c.status IS NULL), u.name, a.data->>'name'`, [opts.agent || null])).rows;
  const counts = { athletes: rows.length, connected: 0, needsNewLink: 0, personal: 0, blocked: 0, screenshot: 0, none: 0 };
  const L = [];
  for (const r of rows) {
    const name = (r.data && r.data.name) || r.id;
    const latest = (await pool.query(`SELECT * FROM instagram_stats WHERE athlete_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [r.id])).rows[0] || null;
    let city = null; try { city = AR.resolveAthlete({ data: r.data || {} }).schoolCity; } catch (_) { city = null; }
    const d = latest ? II.derive(latest, { city }) : null;
    const state = !r.status ? (latest && latest.source === 'screenshot' ? 'screenshot only' : 'not connected')
      : r.status === 'connected' ? (r.needs_reconnect_for_insights ? 'connected, NEEDS NEW LINK for insights' : r.last_error_kind === 'permission_blocked' ? 'connected, insights BLOCKED by Meta' : 'connected')
        : r.status === 'expired' ? 'EXPIRED, needs new link' : r.status === 'personal_account' ? 'PERSONAL ACCOUNT, ask them to switch to Creator' : r.status;
    if (r.status === 'connected' && !r.needs_reconnect_for_insights && r.last_error_kind !== 'permission_blocked') counts.connected++;
    else if (r.status === 'expired' || r.needs_reconnect_for_insights) counts.needsNewLink++;
    else if (r.status === 'personal_account') counts.personal++;
    else if (r.last_error_kind === 'permission_blocked') counts.blocked++;
    else if (latest && latest.source === 'screenshot') counts.screenshot++;
    else counts.none++;
    const local = d && d.local ? `${Math.round(d.local.cityShare * 1000) / 10}% in ${d.local.city}` : (d && !d.demographicsAvailable ? `no audience data (${d.demographicsReason || 'not granted'})` : '-');
    L.push(`${String(name).padEnd(26)} ${String(r.agent || '-').padEnd(18)} ${state}`
      + `\n    scopes: ${r.scopes_granted ? r.scopes_granted.join(', ') : (r.status ? 'not recorded (connected before scopes were kept)' : '-')}`
      + ` | last sync: ${r.last_synced_at ? new Date(r.last_synced_at).toISOString().slice(0, 16).replace('T', ' ') : '-'}`
      + ` | last error: ${r.last_error_kind ? II.KIND_WORDS[r.last_error_kind] || r.last_error_kind : (r.last_sync_error ? String(r.last_sync_error).slice(0, 120) : '-')}`
      + `\n    followers: ${latest && latest.followers_count !== null ? Number(latest.followers_count).toLocaleString('en-US') : '-'}`
      + `${latest ? ` (${latest.source === 'screenshot' ? "from the athlete's screenshot" : 'verified by Instagram'}, ${new Date(latest.fetched_at).toISOString().slice(0, 10)})` : ''}`
      + ` | local share: ${local}`
      + (d && d.avgReachPerPost !== null ? ` | avg reach/post: ${Math.round(d.avgReachPerPost).toLocaleString('en-US')}` : ''));
  }
  const head = [`INSTAGRAM: ${counts.athletes} athlete(s): ${counts.connected} connected, ${counts.needsNewLink} need a new link, ${counts.personal} personal account, `
    + `${counts.blocked} insights blocked by Meta, ${counts.screenshot} screenshot only, ${counts.none} not connected`,
  `App configured: ${IG.configured() ? 'yes' : 'NO (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)'}; scope requested: ${IG.SCOPE}`, ''];
  return { ok: true, lines: head.concat(L), counts };
}

if (require.main === module) {
  (async () => {
    await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
    const out = await run(store.pool, { agent: arg('agent') === true ? null : arg('agent') });
    console.log(out.lines.join('\n'));
    process.exit(0);
  })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { run };
