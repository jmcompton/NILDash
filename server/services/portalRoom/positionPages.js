'use strict';
// ── PUBLIC PAGES: WHICH FBS SCHOOLS NEED EACH POSITION ──────────────────────
//
// /portal-room/needs            every position, linked
// /portal-room/needs/<pos>      e.g. /portal-room/needs/wr: the 25 FBS schools
//                               thinnest at that position right now
//
// Built on the server from the same roster count the Portal Room uses
// (board.rank on every FBS roster read), so search engines can read them and
// an agent searching for portal help lands on real numbers. Rebuilt at most
// once an hour; the rosters themselves are re-read nightly. Each page says
// how many rosters it is built from and that "seniors or older" is an
// estimate, and ends with the free Portal Board and the trial.

const P = require('./positions');
const Board = require('./board');

const TOP = 25;
const TTL_MS = 60 * 60 * 1000;
const SLUG = Object.fromEntries(P.GROUPS.map((g) => [g.toLowerCase(), g]));
const SINGULAR = { QB: 'quarterback', RB: 'running back', WR: 'wide receiver', TE: 'tight end', OL: 'offensive lineman', DL: 'defensive lineman', LB: 'linebacker', DB: 'defensive back', K: 'kicker', P: 'punter', LS: 'long snapper' };
const NEED = { high: 'Thin', medium: 'Below average', low: 'Deep', unknown: 'Roster not read yet' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BASE = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');

let cache = new Map();
function clearCache() { cache = new Map(); }

async function dataFor(pool, group, { now = new Date() } = {}) {
  const hit = cache.get(group);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const PR = require('./index');
  const [rows, coaching] = await Promise.all([PR.rosters(pool), PR.Coaching.load(pool, { now })]);
  const b = Board.rank({ group, prefs: {}, rosters: rows, coaching, limit: 500 });
  // Need first: the thinnest rooms, read rosters only.
  const ranked = [...b.dream, ...b.options].filter((r) => r.need.rating !== 'unknown' && !r.need.noYears)
    .sort((x, y) => (y.need.leaving / Math.max(1, y.need.on)) - (x.need.leaving / Math.max(1, x.need.on)) || (x.need.back - y.need.back) || x.school.localeCompare(y.school))
    .slice(0, TOP);
  const data = { group, rows: ranked, rostersRead: b.rostersRead, totalSchools: b.totalSchools, median: b.median, valueLine: require('./value').line(group), builtAt: now.toISOString() };
  cache.set(group, { at: Date.now(), data });
  return data;
}

const STYLE = `:root{--ground:#F4F5F2;--ink:#111613;--muted:#5B645E;--line:#E2E5E0;--soft:#EEF0EC;--accent:#157347;--warn:#8A3F05;--warn-soft:#FBEFE3;--side:#0F1A14}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.55 Inter,system-ui,sans-serif}a{color:var(--accent)}
header{background:var(--side)}header .in{max-width:980px;margin:0 auto;padding:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
header a{color:#fff;text-decoration:none;font:700 22px 'Barlow Semi Condensed',sans-serif}header a.l{font:500 14px Inter,sans-serif;color:#C9D6CD}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font:700 clamp(28px,5vw,42px)/1.08 'Barlow Semi Condensed',sans-serif}h2{margin:0;font:700 24px 'Barlow Semi Condensed',sans-serif}
.sub{color:var(--muted);margin:0}.tbox{overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:12px}
table{width:100%;min-width:640px;border-collapse:collapse}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:12px 14px;border-bottom:1px solid var(--line)}
td{padding:11px 14px;border-bottom:1px solid var(--soft);vertical-align:top}.f{font-size:12px;color:var(--muted)}
.chip{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;padding:2px 7px;border-radius:4px;background:var(--warn-soft);color:var(--warn)}
.cta{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}.btn.g{background:#fff;color:var(--ink);border:1px solid #CDD3CB}
.pos{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}.pos a{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;text-decoration:none;color:var(--ink);font-weight:600}`;

function shell({ title, description, canonical, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(canonical)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@700&family=Inter:wght@400;600&display=swap">
<style>${STYLE}</style></head><body><header><div class="in"><a href="/portal-board">Portal Room <span style="font:500 12px Inter,sans-serif;color:#9FB0A5">by NILDash</span></a><a class="l" href="/">mynildash.com</a></div></header><main>${body}</main></body></html>`;
}

function day(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }); }

async function page(pool, slug, { now = new Date() } = {}) {
  const group = SLUG[String(slug || '').toLowerCase()];
  if (!group) return null;
  const d = await dataFor(pool, group, { now });
  const one = SINGULAR[group];
  const title = `FBS schools that need a ${one}: 2027 transfer portal | NILDash`;
  const description = `The ${TOP} FBS schools thinnest at ${one} right now, counted from ${d.rostersRead} school rosters: seniors or older on each roster, players coming back and head coaching changes. Updated ${day(d.builtAt)}.`;
  const rows = d.rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.school)}</b>${r.coachingChange ? ' <span class="chip">New head coach</span>' : ''}<div class="f">${esc([r.conference, r.level].filter(Boolean).join(' · '))}</div></td>
    <td><b>${esc(NEED[r.need.rating])}</b><div class="f">${r.need.back} coming back, FBS median ${r.need.median}</div></td><td>${r.need.leaving} of ${r.need.on}</td>
    <td class="f">${r.coachingChange ? esc(`${r.coachingChange.coach || 'Head coach'} ${r.coachingChange.how === 'fired' ? 'fired' : r.coachingChange.how || 'left'} ${new Date(r.coachingChange.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`) : 'No change on file'}</td></tr>`).join('');
  const others = P.GROUPS.filter((g) => g !== group).map((g) => `<a href="/portal-room/needs/${g.toLowerCase()}">${esc(P.LABEL[g])}</a>`).join(' · ');
  const body = `<h1>FBS schools that need a ${esc(one)} for the 2027 transfer portal</h1>
<p class="sub">The ${TOP} FBS rooms thinnest at ${esc(one)} right now, from ${d.rostersRead} of ${d.totalSchools} FBS rosters read from each school's own site. Updated ${esc(day(d.builtAt))}. The football portal window is Jan 2 to 16, 2027.</p>
${d.rows.length ? `<div class="tbox"><table><thead><tr><th>#</th><th>School</th><th>Need at ${esc(group)}</th><th>Seniors or older</th><th>Head coach</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="sub">Rosters are still being read. Check back tomorrow.</p>'}
<p class="f">How this is counted: players a school's roster lists as seniors or older are counted as likely leaving, and the rest as coming back, compared with the FBS median at the position. Not every senior leaves, and some rosters print no class years; those schools are left off. Head coaching changes come from public reports, each linked inside the Portal Room.${d.valueLine ? ' What a ' + esc(one) + ' is paid: ' + esc(d.valueLine) : ''}</p>
<div class="cta"><div><h2>Have a client going in?</h2><p class="sub">Get his own top 10, with his school left off and the level he wants. Free, no account.</p></div><div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="/portal-board?position=${group.toLowerCase()}">Get a free Portal Board</a><a class="btn g" href="/portal-room/demo">See the Portal Room</a></div></div>
<p class="f">Other positions: ${others}</p>`;
  return shell({ title, description, canonical: `${BASE()}/portal-room/needs/${group.toLowerCase()}`, body });
}

function index() {
  const links = P.GROUPS.map((g) => `<a href="/portal-room/needs/${g.toLowerCase()}">${esc(P.LABEL[g])}</a>`).join('');
  const body = `<h1>Which FBS schools need each position for the 2027 transfer portal</h1>
<p class="sub">Counted from every FBS roster, school by school, and updated as rosters are re-read. Pick a position.</p><div class="pos">${links}</div>
<div class="cta"><div><h2>Have a client going in?</h2><p class="sub">Get his own top 10 schools. Free, no account.</p></div><a class="btn" href="/portal-board">Get a free Portal Board</a></div>`;
  return shell({ title: 'FBS position needs for the 2027 transfer portal | NILDash', description: 'Which FBS schools are thin at each position, counted from every FBS roster. Free Portal Board for agents.', canonical: `${BASE()}/portal-room/needs`, body });
}

module.exports = { page, index, dataFor, clearCache, SLUG, SINGULAR, TOP };
