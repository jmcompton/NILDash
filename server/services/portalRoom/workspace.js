'use strict';
// ── THE WORKSPACE: ONE CLIENT IN THE PORTAL, ON ONE SCREEN ──────────────────
//
// What the Portal Room app (/portal-room) opens to. Everything on it comes
// from the pieces that already do the work; nothing here is a new number:
//
//   PIPELINE   his target schools by stage (services/portalRoom/targets), each
//              with its need at his position and its fit score from the same
//              board an agent searches (board.rank on the rosters read), the
//              coaching change if there is one, the next step and when it is
//              due, and the last thing that happened.
//   WHO        when each person in a school's contact book was last reached,
//              from the activity the agent logged against that school.
//   STATS      schools on his list, contacted, replies logged in the last 7
//              days, visits set, offers and the most guaranteed, steps due.
//   WINDOW     days until the portal window opens (index WINDOWS).
//   COVERAGE   how many FBS rosters are read, so a need score never looks more
//              complete than it is.
//   OFFERS     the offer board (index.offerBoard), as is.
//
// assemble() is pure, so the public demo is built from the same code.

const P = require('./positions');
const Board = require('./board');
const T = require('./targets');
const Schools = require('./schools');
const Coaching = require('./coachingChanges');

const DAY = 86400000;
const chicagoDay = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const OPEN = (stage) => !['committed', 'passed'].includes(stage);

function assemble({ targets = [], boardRows = [], rostersRead = 0, totalSchools = 0, activity = [], offerBoard = null, windows = null, opens = {}, now = new Date() }) {
  const today = chicagoDay(now);
  const bySchool = new Map(boardRows.map((r) => [r.school, r]));
  const lastByTarget = new Map();
  const touch = {};
  for (const a of activity) {        // newest first
    if (!lastByTarget.has(a.targetId)) lastByTarget.set(a.targetId, a);
    if (a.contact && ['email', 'call', 'reply', 'visit'].includes(a.kind)) {
      const m = touch[a.targetId] || (touch[a.targetId] = {});
      if (!m[a.contact]) m[a.contact] = { kind: a.kind, at: a.at };
    }
  }
  const cards = targets.map((t) => {
    const r = bySchool.get(t.school) || null;
    const info = Schools.info(t.school);
    const dueIn = t.dueOn ? daysBetween(today, t.dueOn) : null;
    const ch = r ? r.coachingChange : null;
    return {
      ...t,
      level: info ? info.level : null, conference: info ? info.conference : null, state: info ? info.state : null,
      fit: r ? r.score : null,
      need: r ? r.need : null,
      coachingChange: ch, coachingLine: ch ? Coaching.describe(ch) : null,
      dueIn, due: OPEN(t.stage) && dueIn != null && dueIn <= 0,
      lastActivity: lastByTarget.get(t.id) || null,
      contactTouch: touch[t.id] || {},
      opens: opens[t.id] || null,
    };
  });
  const count = (k) => cards.filter((c) => c.stage === k).length;
  const offers = (offerBoard && offerBoard.offers) || [];
  const best = offers[0] || null;
  const weekAgo = now.getTime() - 7 * DAY;
  const stats = {
    onList: cards.filter((c) => c.stage !== 'passed').length,
    contacted: cards.filter((c) => !['target', 'passed'].includes(c.stage)).length,
    repliesThisWeek: activity.filter((a) => a.kind === 'reply' && new Date(a.at).getTime() >= weekAgo).length,
    visits: count('visit'),
    offers: offers.length,
    bestGuaranteed: best && best.guaranteedTotal ? { school: best.school, amount: best.guaranteedTotal } : null,
    due: cards.filter((c) => c.due).length,
    opened: cards.filter((c) => c.opens && c.opens.opens > 0).length,
    committed: cards.find((c) => c.stage === 'committed') ? cards.find((c) => c.stage === 'committed').school : null,
  };
  const tasks = cards.filter((c) => OPEN(c.stage) && c.nextStep)
    .sort((a, b) => (a.dueIn == null ? 1e9 : a.dueIn) - (b.dueIn == null ? 1e9 : b.dueIn) || a.school.localeCompare(b.school))
    .map((c) => ({ targetId: c.id, school: c.school, nextStep: c.nextStep, dueOn: c.dueOn, dueIn: c.dueIn }));
  let window = null;
  if (windows && windows.main) {
    const toOpen = daysBetween(today, windows.main.opens), toClose = daysBetween(today, windows.main.closes);
    window = { opens: windows.main.opens, closes: windows.main.closes, daysToOpen: toOpen, daysToClose: toClose, isOpen: toOpen <= 0 && toClose >= 0, closed: toClose < 0 };
  }
  return {
    today,
    stages: T.STAGES.map((k) => ({ key: k, label: T.STAGE_LABEL[k], cards: cards.filter((c) => c.stage === k) })),
    cards, stats, tasks, window,
    coverage: { read: rostersRead, total: totalSchools },
  };
}

async function workspace(pool, store, agent, athlete, { now = new Date() } = {}) {
  const PR = require('./index');
  const [targets, activity, wl] = await Promise.all([
    T.listTargets(pool, agent.id, athlete.id),
    T.listActivity(pool, agent.id, athlete.id, { limit: 300 }),
    PR.getWishlist(pool, agent.id, athlete.id),
  ]);
  const prefs = wl.prefs || {};
  const group = P.GROUPS.includes(prefs.group) ? prefs.group : P.groupOf(athlete.position);
  let boardRows = [], rostersRead = 0, totalSchools = Schools.all().length;
  if (group) {
    // Every school scored with his saved wish list (the same scores the
    // Schools tab shows), so a target never falls off the bottom of a list.
    // No school saved yet: his school from his profile, so it is not ranked
    // as a place to transfer to.
    const { prefs: cp } = PR.cleanPrefs({ ...prefs, group, currentSchool: prefs.currentSchool || athlete.school || null });
    const [rows, coaching] = await Promise.all([PR.rosters(pool), PR.Coaching.load(pool, { now })]);
    const b = Board.rank({ group, prefs: cp, rosters: rows, coaching, limit: 1000, keepAll: true });
    boardRows = [...b.dream, ...b.options];
    rostersRead = b.rostersRead; totalSchools = b.totalSchools;
  }
  const offerBoard = await PR.offerBoard(pool, agent, athlete, { now });
  const opens = await require('./opens').opensFor(pool, agent.id, athlete.id).catch(() => ({}));
  return {
    athlete: { id: athlete.id, name: athlete.name || null, position: athlete.position || null, school: athlete.school || null },
    group, groupLabel: group ? P.LABEL[group] : null, hasPlayerDetails: !!wl.prefs,
    // The Protect College Sports Act is a bill until the House passes it: the
    // page says so next to every check built on it.
    pcsaStatus: require('../pcsa').rules().status,
    ...assemble({ targets, boardRows, rostersRead, totalSchools, activity, offerBoard, windows: PR.WINDOWS.football, opens, now }),
    offers: offerBoard,
  };
}

// The agent's football clients, each with how many schools and offers he has.
async function clients(pool, agentId, athletes) {
  await T.ensureTables(pool);
  await require('./offers').ensureTable(pool);
  const t = await pool.query(`SELECT athlete_id, COUNT(*) FILTER (WHERE stage <> 'passed')::int AS n, COUNT(*) FILTER (WHERE stage = 'committed')::int AS c
    FROM portal_targets WHERE agent_id = $1 GROUP BY athlete_id`, [agentId]);
  const o = await pool.query(`SELECT athlete_id, COUNT(*) FILTER (WHERE status <> 'declined')::int AS n FROM portal_offers WHERE agent_id = $1 GROUP BY athlete_id`, [agentId]);
  const tn = new Map(t.rows.map((r) => [r.athlete_id, r])), on = new Map(o.rows.map((r) => [r.athlete_id, r.n]));
  return (athletes || []).filter((a) => !a.sport || /football/i.test(a.sport)).map((a) => ({
    id: a.id, name: a.name || null, position: a.position || null, school: a.school || null,
    schools: tn.get(a.id) ? tn.get(a.id).n : 0, committed: !!(tn.get(a.id) && tn.get(a.id).c), offers: on.get(a.id) || 0,
  })).sort((a, b) => (b.schools > 0) - (a.schools > 0) || String(a.name || '').localeCompare(String(b.name || '')));
}

module.exports = { assemble, workspace, clients, chicagoDay, daysBetween };
