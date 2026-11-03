'use strict';
// ── THE CONTACT BOOK FOR ONE SCHOOL ─────────────────────────────────────────
//
// Who an agent calls at a school about a portal player, in the order he calls
// them. Read from the program map (program_staff, program_contact), which is
// built off each school's own football staff page: every person here carries
// the page they were listed on.
//
//   1. General manager / football operations   the person who runs the roster
//   2. Player personnel                        evaluates and builds the board
//   3. His position coach                      matched to the player's room
//   4. The coordinator on his side of the ball
//   5. Recruiting                              portal intake runs through here
//   6. Head coach
//   + the football office line and the NIL collective when published.
//
// NOTHING IS CONSTRUCTED. An email is shown only when the school printed it;
// most do not, and then the office line and the person's name are the call.

const P = require('./positions');

function pick(rows, test) {
  const hits = rows.filter(test);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.is_key_contact ? 1 : 0) - (a.is_key_contact ? 1 : 0) || (a.role_rank || 99) - (b.role_rank || 99));
  return hits[0];
}

function person(label, why, r) {
  if (!r) return null;
  return { label, why, name: r.name, title: r.title || null, email: r.email || null, phone: r.phone || null, source: r.source_url || null };
}

// rows: program_staff rows for the school (current only). contact: the
// program_contact row or null.
function build({ school, group, rows = [], contact = null, staffUrl = null }) {
  const t = (r) => String(r.title || '');
  const assocHc = (r) => /assistant head coach|associate head coach/i.test(t(r));
  // The program map files "Associate Head Coach / Wide Receivers" under
  // head_coach and, since it is not the top one, as 'previous'. Those people
  // are current staff: they come back in for the position and coordinator
  // lookups. A true previous head coach stays out.
  const cur = rows.filter((r) => (r.status || 'current') === 'current' || (r.role === 'head_coach' && assocHc(r)));
  const isTrueHc = (r) => !assocHc(r) && (r.role === 'head_coach' || /\bhead\s+(football\s+)?coach\b/i.test(t(r)));
  const used = new Set();
  const take = (r) => { if (!r || used.has(r.name)) return null; used.add(r.name); return r; };
  const side = P.SIDE[group] || null;
  const coachRe = P.COACH_RE[group];
  const coordRe = side ? P.COORD_RE[side] : null;

  const list = [
    person('General manager / football ops', 'Runs the roster and the money', take(pick(cur, (r) => r.role === 'general_manager'))),
    person('Player personnel', 'Evaluates portal players and builds the board', take(pick(cur, (r) => r.role === 'player_personnel'))),
    person(`Position coach (${group})`, `Coaches the ${P.LABEL[group] ? P.LABEL[group].toLowerCase() : 'room'} he would join`,
      take(pick(cur, (r) => coachRe && coachRe.test(t(r)) && !isTrueHc(r) && !/coordinator/i.test(t(r)) && !/analyst|graduate assistant|\bga\b|quality control|intern/i.test(t(r))))
      || take(pick(cur, (r) => coachRe && coachRe.test(t(r)) && !isTrueHc(r) && !/analyst|graduate assistant|quality control|intern/i.test(t(r))))),
    person(side === 'special' ? 'Special teams coordinator' : `${side === 'offense' ? 'Offensive' : 'Defensive'} coordinator`, 'Signs off on who plays on his side of the ball',
      coordRe ? take(pick(cur, (r) => coordRe.test(t(r)) && !/assistant (offensive|defensive|special teams) coordinator|analyst/i.test(t(r)))) : null),
    person('Recruiting', 'Portal intake usually runs through recruiting', take(pick(cur, (r) => r.role === 'recruiting'))),
    person('Head coach', 'Final say', take(pick(cur.filter((r) => (r.status || 'current') === 'current'), isTrueHc))),
  ].filter(Boolean);

  const office = contact && (contact.office_phone || contact.football_office_phone) ? {
    phone: contact.office_phone || contact.football_office_phone,
    source: contact.office_phone_source_url || contact.football_office_phone_source_url || null,
  } : null;
  const collective = contact && (contact.collective_name || contact.collective_email) ? {
    name: contact.collective_name || null, email: contact.collective_email || null, source: contact.collective_email_source_url || null,
  } : null;
  const recruitingEmail = contact && contact.recruiting_email ? { email: contact.recruiting_email, source: contact.recruiting_email_source_url || null } : null;

  return {
    school, group, staffUrl, onFile: cur.length,
    contacts: list, office, collective, recruitingEmail,
    withEmail: list.filter((x) => x.email).length,
    note: cur.length ? null : 'No staff page read for this school yet.',
  };
}

async function forSchool(store, school, group) {
  const rows = await store.getProgramStaff(school, 'football').catch(() => []);
  const contact = await store.getProgramContact(school, 'football').catch(() => null);
  let staffUrl = null;
  try {
    const r = await store.pool.query(`SELECT staff_url FROM program_source WHERE school = $1 AND sport = 'football'`, [school]);
    staffUrl = r.rows[0] ? r.rows[0].staff_url : null;
  } catch (_) { /* no program map */ }
  return build({ school, group, rows, contact, staffUrl });
}

module.exports = { build, forSchool };
