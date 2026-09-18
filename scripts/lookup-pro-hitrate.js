#!/usr/bin/env node
'use strict';
// ── THE PRO LOOKUP, MEASURED: TEN NFL, TEN NBA, TEN MLB PLAYERS ─────────────
//
//   railway run node scripts/lookup-pro-hitrate.js            the thirty below
//   node scripts/lookup-pro-hitrate.js --league NFL           one league
//   node scripts/lookup-pro-hitrate.js --no-team              name and sport only, no team
//   node scripts/lookup-pro-hitrate.js --force                ignore the 30-day cache
//
// Runs the real lookup (services/athleteLookup: the roster feeds, then the
// web) for each player, prints one line per player with the trace, and the
// hit rate per league. Needs network reach to ESPN, statsapi.mlb.com and,
// for the web fallback, DEEPSEEK_API_KEY and SERPER_API_KEY. The build box
// has none of that, so this runs on Railway or the Mac. Read-only apart from
// the lookup cache.

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'unused';
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 3000;
const flag = (n) => process.argv.includes('--' + n);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

// Current starters and regulars as of the 2025-26 seasons, written from
// memory; a player who has moved teams since is still a valid test of the
// feeds (the roster is the truth, the team here is only the hint).
const PLAYERS = {
  NFL: [['Bo Nix', 'Denver Broncos', 'QB'], ['Patrick Mahomes', 'Kansas City Chiefs', 'QB'], ['Josh Allen', 'Buffalo Bills', 'QB'], ['Justin Jefferson', 'Minnesota Vikings', 'WR'],
    ['Micah Parsons', 'Green Bay Packers', 'LB'], ['Saquon Barkley', 'Philadelphia Eagles', 'RB'], ['Ja\'Marr Chase', 'Cincinnati Bengals', 'WR'], ['Myles Garrett', 'Cleveland Browns', 'DE'],
    ['Lamar Jackson', 'Baltimore Ravens', 'QB'], ['Jayden Daniels', 'Washington Commanders', 'QB']],
  NBA: [['Nikola Jokic', 'Denver Nuggets', 'C'], ['Jayson Tatum', 'Boston Celtics', 'SF'], ['Luka Doncic', 'Los Angeles Lakers', 'PG'], ['Shai Gilgeous-Alexander', 'Oklahoma City Thunder', 'PG'],
    ['Giannis Antetokounmpo', 'Milwaukee Bucks', 'PF'], ['Anthony Edwards', 'Minnesota Timberwolves', 'SG'], ['Stephen Curry', 'Golden State Warriors', 'PG'], ['Victor Wembanyama', 'San Antonio Spurs', 'C'],
    ['Jalen Brunson', 'New York Knicks', 'PG'], ['Tyrese Haliburton', 'Indiana Pacers', 'PG']],
  MLB: [['Aaron Judge', 'New York Yankees', 'RF'], ['Shohei Ohtani', 'Los Angeles Dodgers', 'DH'], ['Bobby Witt Jr.', 'Kansas City Royals', 'SS'], ['Juan Soto', 'New York Mets', 'RF'],
    ['Mookie Betts', 'Los Angeles Dodgers', 'SS'], ['Jose Ramirez', 'Cleveland Guardians', '3B'], ['Gunnar Henderson', 'Baltimore Orioles', 'SS'], ['Tarik Skubal', 'Detroit Tigers', 'SP'],
    ['Paul Skenes', 'Pittsburgh Pirates', 'SP'], ['Elly De La Cruz', 'Cincinnati Reds', 'SS']],
};
const SPORT = { NFL: 'football', NBA: 'basketball', MLB: 'baseball' };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const AL = require('../server/services/athleteLookup');
  const only = String(arg('league', '')).toUpperCase();
  const noTeam = flag('no-team');
  const totals = {};
  for (const [league, list] of Object.entries(PLAYERS)) {
    if (only && league !== only) continue;
    let hits = 0, stats = 0, handle = 0, count = 0;
    console.log(`\n${league}${noTeam ? ' (name and sport only)' : ' (name, sport and team)'}`);
    for (const [name, team, pos] of list) {
      const t0 = Date.now();
      let r;
      try { r = await AL.resolveAthlete(null, { name, sport: SPORT[league], athleteType: 'pro', team: noTeam ? '' : team }, { force: flag('force') }); }
      catch (e) { r = { found: false, candidates: [], trace: ['threw: ' + e.message] }; }
      const best = r.candidates && r.candidates[0];
      const hit = !!(best && best.team);
      if (hit) hits++;
      if (best && (best.highlight || best.stats)) stats++;
      if (best && best.instagramHandle) handle++;
      if (best && Number(best.instagram) > 0) count++;
      console.log(`  ${hit ? 'HIT ' : 'MISS'} ${name.padEnd(26)} expected ${(team + ', ' + pos).padEnd(34)} got ${best ? `${best.name}, ${best.team || '?'}, ${best.position || '?'} (${best.sourceLabel || best.source || '?'}, ${best.confidence || 0})` : 'nothing'}  ${Date.now() - t0}ms`);
      if (best) console.log(`       stats: ${best.highlight || best.stats || '(none)'}\n       instagram: ${best.instagramHandle ? '@' + best.instagramHandle : '(no handle)'}${Number(best.instagram) > 0 ? ' ' + Number(best.instagram).toLocaleString() + (best.followersApprox ? ' approx' : '') + (best.followersAsOf ? ' as of ' + best.followersAsOf : '') : ' (no count)'}  tiktok: ${best.tiktokHandle ? '@' + best.tiktokHandle : '(no handle)'}`);
      for (const line of (r.trace || [])) console.log(`       ${line}`);
    }
    totals[league] = { hits, stats, handle, count, of: list.length };
  }
  console.log('\nHIT RATE BY LEAGUE (athlete found / stats filled / Instagram handle / follower count)');
  for (const [lg, t] of Object.entries(totals)) console.log(`  ${lg.padEnd(5)} athlete ${t.hits} of ${t.of}${t.hits >= t.of ? '' : '  (bar: ' + t.of + ' of ' + t.of + ')'}   stats ${t.stats} of ${t.of}${t.stats >= 8 ? '' : '  (bar: 8)'}   instagram handle ${t.handle} of ${t.of}${t.handle >= 8 ? '' : '  (bar: 8)'}   follower count ${t.count} of ${t.of}`);
  try { await require('../server/store').pool.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('lookup-pro-hitrate: FAILED', e); process.exit(1); });
