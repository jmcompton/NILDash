'use strict';
// ── THE DEPARTMENT'S TOWN: SEARCH IT, WORK IT, REMEMBER IT ──────────────────
//
// An agent's athletes are in thirty towns, so we push them cards. A department
// has one town and wants to go hunting in it: "if I'm looking for women's
// basketball and a couple different companies around the area... I can still
// go in and individually pitch them." That is a filter, not a feed. This is
// the filter, and the shared record of who already talked to whom:
//
//   search      every business in the pool with its contact and CRM state,
//               filtered (category, distance, has-contact, athlete history,
//               team fit, stage, text) and sorted; CSV of the filtered set
//   detail      one business: contact, stage, every touch by every staff
//               member, deals, drafts
//   crm         stage, notes, touches (who, when, channel, what was said, what
//               came back), deals against a team or an athlete
//   pitch       on demand: a business plus a team or one athlete, written and
//               signed by the staff member who asked
//
// THE HARD RULE. If anyone on staff has touched a business, no one can pitch
// it again without seeing that history first: pitch() refuses with the history
// unless the caller acknowledges it, and the nightly job never picks it.
//
// UNIVERSITY TABLES ONLY (read migrations/007). Every query is scoped by the
// caller's university_id, which comes from the session (users.university_id),
// never from the request.

const STAGES = ['not_contacted', 'contacted', 'replied', 'in_talks', 'deal_signed', 'declined', 'do_not_contact'];
const STAGE_LABEL = { not_contacted: 'Not contacted', contacted: 'Contacted', replied: 'Replied', in_talks: 'In talks',
  deal_signed: 'Deal signed', declined: 'Declined', do_not_contact: 'Do not contact' };
const CHANNELS = ['email', 'phone', 'instagram', 'in_person', 'text', 'other', 'note'];
const FIT_MIN = 10;
const MI = 1609.34;

async function universityFor(pool, universityId) {
  return require('./campusPool').universityOf(pool, universityId);
}

// ── SEARCH ──────────────────────────────────────────────────────────────────
const SORTS = {
  name: 'm.brand', distance: 'm.distance_m', category: 'm.category', rating: 'm.rating', reviews: 'm.user_ratings_total',
  stage: `array_position(ARRAY['not_contacted','contacted','replied','in_talks','deal_signed','declined','do_not_contact'], COALESCE(r.stage,'not_contacted'))`,
  last_touch: 'r.last_touch_at', contact: 'c.reachable', fit: 'fit_score',
  // How likely the kind of business is to do an athlete deal (campusQuality),
  // contactable first, a category over its 15% share after, then nearest.
  priority: 'm.deal_priority',
};

function parseFilters(q) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    q: String(q.q || '').trim().slice(0, 80) || null,
    categories: list(q.category),
    maxMiles: num(q.miles),
    hasContact: q.contact === '1' || q.contact === 'true' || q.hasContact === true,
    // contact=1 is THE contactable list: within each category's 15% share.
    // held=1 adds the rows the cap holds back (shown last, marked held).
    includeHeld: q.held === '1' || q.held === 'true',
    history: q.history === '1' || q.history === 'true',
    team: String(q.team || '').trim() || null,
    stages: list(q.stage).filter((s) => STAGES.includes(s)),
    sort: SORTS[q.sort] ? q.sort : (q.team ? 'fit' : 'priority'),
    dir: String(q.dir || '').toLowerCase() === 'desc' ? 'DESC' : (String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : null),
    limit: Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 100)),
    offset: Math.max(0, parseInt(q.offset, 10) || 0),
  };
}

async function search(pool, universityId, query) {
  const QC = require('./campusQuality');
  await QC.ensureColumns(pool).catch(() => {});
  const u = await universityFor(pool, universityId);
  if (!u) return { ok: false, error: 'no university' };
  // The 15% cap ran only at the end of a build and the start of a night, and
  // contact=1 read reachable without looking at it: Cypress showed 22 dentists
  // in 65. The cap is applied here, on the read, before the list is selected.
  await QC.ensureCapped(pool, u).catch((e) => console.warn('[campusMarket] share cap:', e.message));
  const f = parseFilters(query || {});
  const args = [universityId, u.marketKey];
  const where = ['m.market_key = $2', 'm.blocked_reason IS NULL'];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
  if (f.q) add(`m.brand ILIKE ?`, '%' + f.q.replace(/[%_]/g, '') + '%');
  if (f.categories.length) add(`m.category = ANY(?)`, f.categories);
  if (f.maxMiles !== null) add(`m.distance_m <= ?`, Math.round(f.maxMiles * MI));
  if (f.hasContact) where.push(f.includeHeld ? 'c.reachable IS TRUE' : 'c.reachable IS TRUE AND c.held_reason IS NULL');
  if (f.history) where.push('c.athlete_history IS TRUE');
  if (f.stages.length) add(`COALESCE(r.stage, 'not_contacted') = ANY(?)`, f.stages);
  let fitSel = 'NULL::int AS fit_score, NULL::text AS fit_why';
  if (f.team) {
    args.push(f.team);
    const t = '$' + args.length;
    fitSel = `(SELECT (x->>'score')::int FROM jsonb_array_elements(COALESCE(c.team_fit,'[]'::jsonb)) x WHERE x->>'team_id' = ${t}) AS fit_score,
              (SELECT x->>'why' FROM jsonb_array_elements(COALESCE(c.team_fit,'[]'::jsonb)) x WHERE x->>'team_id' = ${t}) AS fit_why`;
    where.push(`COALESCE((SELECT (x->>'score')::int FROM jsonb_array_elements(COALESCE(c.team_fit,'[]'::jsonb)) x WHERE x->>'team_id' = ${t}), ${FIT_MIN}) >= ${FIT_MIN}`);
  }
  const dir = f.dir || (['fit', 'rating', 'reviews', 'last_touch', 'contact', 'priority'].includes(f.sort) ? 'DESC' : 'ASC');
  const base = `FROM university_market_seen m
      LEFT JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
      LEFT JOIN university_crm r ON r.university_id = $1 AND r.brand = m.brand
     WHERE ${where.join(' AND ')}`;
  const total = (await pool.query(`SELECT COUNT(*)::int n ${base}`, args)).rows[0].n;
  const rows = (await pool.query(
    `SELECT * FROM (SELECT m.brand, m.category, m.primary_type_label, m.address, m.distance_m, m.rating, m.user_ratings_total, m.place_id,
            m.deal_priority, m.deal_bucket, c.held_reason,
            c.contact_name, c.contact_title, c.email, c.generic_email, c.phone, c.instagram, c.website, c.facebook, c.linkedin,
            COALESCE(c.reachable, FALSE) AS reachable, COALESCE(c.status, 'pending') AS contact_status, c.athlete_history, c.athlete_history_note, c.team_fit,
            COALESCE(r.stage, 'not_contacted') AS stage, r.last_touch_at, r.last_touch_by, r.notes, ${fitSel}
       ${base}) z
     ORDER BY ${f.sort === 'priority'
      ? `(CASE WHEN reachable AND held_reason IS NULL THEN 0 WHEN reachable THEN 1 ELSE 2 END), deal_priority ${dir} NULLS LAST, distance_m ASC NULLS LAST`
      : `${SORTS[f.sort].replace(/^[mcr]\./, '').replace(/COALESCE\(r\.stage,'not_contacted'\)/, 'stage')} ${dir} NULLS LAST`}, brand ASC
     LIMIT ${f.limit} OFFSET ${f.offset}`, args)).rows;
  return { ok: true, total, filters: f, rows: rows.map(present) };
}

function present(r) {
  return {
    brand: r.brand, category: r.category, kind: r.primary_type_label || r.category || null, address: r.address,
    miles: r.distance_m === null || r.distance_m === undefined ? null : Math.round((Number(r.distance_m) / MI) * 10) / 10,
    rating: r.rating === null ? null : Number(r.rating), reviews: r.user_ratings_total,
    contact: { name: r.contact_name || null, title: r.contact_title || null, email: r.email || null, sharedEmail: r.generic_email || null, phone: r.phone || null,
      instagram: r.instagram || null, website: r.website || null, facebook: r.facebook || null, linkedin: r.linkedin || null,
      reachable: !!r.reachable, status: r.contact_status },
    athleteHistory: r.athlete_history === true, athleteHistoryNote: r.athlete_history_note || null,
    teamFit: Array.isArray(r.team_fit) ? r.team_fit.slice(0, 3) : [],
    fit: r.fit_score === null || r.fit_score === undefined ? null : { score: Number(r.fit_score), why: r.fit_why },
    stage: r.stage, stageLabel: STAGE_LABEL[r.stage] || r.stage, lastTouchAt: r.last_touch_at || null, lastTouchBy: r.last_touch_by || null,
    notes: r.notes || null,
    bucket: r.deal_bucket || null, held: r.held_reason || null,
  };
}

function csvOf(rows, teamName) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Business', 'Kind', 'Address', 'Miles from campus', 'Contact', 'Title', 'Email', 'Phone', 'Instagram', 'Website',
    'Athlete/NIL history', teamName ? `Why for ${teamName}` : 'Best team fit', 'Stage', 'Last touch', 'Last touched by', 'Notes'];
  const lines = [head.map(esc).join(',')];
  for (const r of rows) {
    lines.push([r.brand, r.kind, r.address, r.miles, r.contact.name, r.contact.title, r.contact.email, r.contact.phone,
      r.contact.instagram ? '@' + r.contact.instagram : '', r.contact.website, r.athleteHistory ? (r.athleteHistoryNote || 'yes') : '',
      r.fit ? r.fit.why : (r.teamFit[0] ? `${r.teamFit[0].team}: ${r.teamFit[0].why}` : ''), r.stageLabel,
      r.lastTouchAt ? new Date(r.lastTouchAt).toISOString().slice(0, 10) : '', r.lastTouchBy, r.notes].map(esc).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ── ONE BUSINESS ────────────────────────────────────────────────────────────
async function detail(pool, universityId, brand) {
  const u = await universityFor(pool, universityId);
  const r = (await search(pool, universityId, { q: null, limit: 5000 })).rows.find((x) => x.brand === brand);
  if (!u || !r) return null;
  const touches = (await pool.query(`SELECT id, user_id, user_name, channel, direction, team_id, athlete_name, summary, outcome, stage_after, draft_id, at
                                       FROM university_touches WHERE university_id = $1 AND brand = $2 ORDER BY at DESC`, [universityId, brand])).rows;
  const deals = (await pool.query(`SELECT d.*, t.name AS team_name FROM university_deals d LEFT JOIN university_teams t ON t.id = d.team_id
                                    WHERE d.university_id = $1 AND d.brand = $2 ORDER BY d.created_at DESC`, [universityId, brand])).rows;
  const drafts = (await pool.query(`SELECT d.id, d.kind, d.team_id, t.name AS team_name, d.athlete_name, d.subject, d.body, d.status, d.created_at, d.sent_at, d.created_by, d.sender_email
                                      FROM university_drafts d LEFT JOIN university_teams t ON t.id = d.team_id
                                     WHERE d.university_id = $1 AND d.brand_name = $2 ORDER BY d.created_at DESC LIMIT 20`, [universityId, brand])).rows;
  return { ...r, touches, deals, drafts };
}

// Has anyone on staff touched it? The history, or [].
async function history(pool, universityId, brand) {
  const t = (await pool.query(`SELECT user_name, channel, summary, outcome, at FROM university_touches WHERE university_id = $1 AND brand = $2 ORDER BY at DESC`,
    [universityId, brand])).rows;
  const crm = (await pool.query(`SELECT stage, notes FROM university_crm WHERE university_id = $1 AND brand = $2`, [universityId, brand])).rows[0];
  // Notes count: someone on staff wrote about this business, so it is read first.
  return { touches: t, stage: crm ? crm.stage : 'not_contacted', notes: (crm && crm.notes) || null,
    touched: t.length > 0 || !!(crm && (crm.stage !== 'not_contacted' || crm.notes)) };
}

// ── THE CRM ─────────────────────────────────────────────────────────────────
async function staffName(pool, userId) {
  const u = (await pool.query(`SELECT name, email FROM users WHERE id = $1`, [userId])).rows[0];
  return u ? (u.name || u.email) : null;
}

async function logTouch(pool, universityId, userId, brand, t) {
  const channel = CHANNELS.includes(t.channel) ? t.channel : 'other';
  const stage = t.stage && STAGES.includes(t.stage) ? t.stage : null;
  const who = await staffName(pool, userId);
  const r = await pool.query(
    `INSERT INTO university_touches (university_id, brand, user_id, user_name, channel, direction, team_id, athlete_name, summary, outcome, stage_after, draft_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [universityId, brand, userId, who, channel, t.direction === 'in' ? 'in' : 'out', t.teamId || null, t.athleteName || null,
      t.summary ? String(t.summary).slice(0, 4000) : null, t.outcome ? String(t.outcome).slice(0, 2000) : null, stage, t.draftId || null]);
  // A touch out moves a business that was untouched to "contacted" unless a
  // stage was given; nothing ever moves it backwards on its own.
  const next = stage || (channel !== 'note' ? 'contacted' : null);
  await pool.query(
    `INSERT INTO university_crm (university_id, brand, stage, last_touch_at, last_touch_by, updated_at, updated_by)
     VALUES ($1,$2,COALESCE($3,'not_contacted'),NOW(),$4,NOW(),$5)
     ON CONFLICT (university_id, brand) DO UPDATE SET
       stage = CASE WHEN $3 IS NULL THEN university_crm.stage
                    WHEN $6 THEN $3
                    WHEN university_crm.stage = 'not_contacted' THEN $3 ELSE university_crm.stage END,
       last_touch_at = NOW(), last_touch_by = $4, updated_at = NOW(), updated_by = $5`,
    [universityId, brand, next, who, userId, !!stage]);
  return r.rows[0];
}

async function setStage(pool, universityId, userId, brand, stage, notes) {
  if (stage && !STAGES.includes(stage)) return { ok: false, error: 'unknown stage' };
  const who = await staffName(pool, userId);
  await pool.query(
    `INSERT INTO university_crm (university_id, brand, stage, notes, updated_at, updated_by) VALUES ($1,$2,COALESCE($3,'not_contacted'),$4,NOW(),$5)
     ON CONFLICT (university_id, brand) DO UPDATE SET stage = COALESCE($3, university_crm.stage),
       notes = CASE WHEN $6 THEN $4 ELSE university_crm.notes END, updated_at = NOW(), updated_by = $5`,
    [universityId, brand, stage || null, notes === undefined ? null : String(notes || '').slice(0, 8000) || null, userId, notes !== undefined]);
  if (stage) {
    await pool.query(`INSERT INTO university_touches (university_id, brand, user_id, user_name, channel, summary, stage_after)
                      VALUES ($1,$2,$3,$4,'note',$5,$6)`, [universityId, brand, userId, who, `Stage set to ${STAGE_LABEL[stage]}`, stage]);
  }
  return { ok: true };
}

async function addDeal(pool, universityId, userId, brand, d) {
  const cents = Math.round(Number(d.value) * 100);
  const r = await pool.query(
    `INSERT INTO university_deals (university_id, brand, team_id, athlete_name, value_cents, description, signed_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [universityId, brand, d.teamId || null, d.athleteName ? String(d.athleteName).slice(0, 120) : null, Number.isFinite(cents) ? cents : null,
      d.description ? String(d.description).slice(0, 2000) : null, d.signedOn || null, userId]);
  await logTouch(pool, universityId, userId, brand, { channel: 'note', summary: `Deal logged${d.value ? ` ($${Number(d.value).toLocaleString('en-US')})` : ''}`
    + `${d.athleteName ? ' with ' + d.athleteName : ''}`, stage: 'deal_signed', teamId: d.teamId });
  return r.rows[0];
}

async function deals(pool, universityId) {
  return (await pool.query(`SELECT d.*, t.name AS team_name FROM university_deals d LEFT JOIN university_teams t ON t.id = d.team_id
                             WHERE d.university_id = $1 ORDER BY d.created_at DESC`, [universityId])).rows;
}

// ── WHO SIGNS ───────────────────────────────────────────────────────────────
// A staff member's own sign-off: name, title, the department, and the address
// their connected mailbox sends from (their login email when none).
async function senderFor(pool, userId) {
  const u = (await pool.query(`SELECT id, name, email FROM users WHERE id = $1`, [userId])).rows[0];
  if (!u) return null;
  const st = (await pool.query(`SELECT title FROM university_staff WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] }))).rows[0];
  let mailbox = null;
  try { mailbox = await require('./emailStore').sendingMailbox(userId); } catch (_) { mailbox = null; }
  return { userId: u.id, name: u.name || null, title: (st && st.title) || null,
    email: (mailbox && mailbox.connected && mailbox.address) || u.email, mailboxConnected: !!(mailbox && mailbox.connected) };
}

// The department's sender for the nightly cards: the staff member marked as
// default, else one with a connected mailbox, else the first staff user.
async function defaultSender(pool, universityId) {
  const staff = (await pool.query(`SELECT u.id, COALESCE(s.default_sender, FALSE) AS def FROM users u LEFT JOIN university_staff s ON s.user_id = u.id
                                    WHERE u.university_id = $1 AND u.role IN ('university','university_admin') ORDER BY def DESC, u.created_at ASC`, [universityId])).rows;
  let first = null;
  for (const s of staff) {
    const snd = await senderFor(pool, s.id);
    if (!snd) continue;
    if (s.def || snd.mailboxConnected) return snd;
    if (!first) first = snd;
  }
  return first;
}

// ── A CARD, AS THE PORTAL SHOWS IT (services/cardChannel) ───────────────────
// Every card says how it reaches someone. Cards written before the channel was
// stored get it here, from what is on file: an email address makes an email
// card and nothing else does; a phone alone is a call card, its talking points
// built from the card's own reason (nothing invented); an Instagram handle
// alone is a DM; a social brand is a program card. A card with none of them is
// not shown as something to send.
function cardForPortal(d, universityName) {
  const CHN = require('./cardChannel');
  const channel = d.channel || CHN.campusChannelOf({ email: d.contact_email, phone: d.contact_phone, instagram: d.contact_instagram,
    programUrl: d.lane === 'social' ? d.program_url : null, social: d.lane === 'social', brand: d.lane === 'social' ? null : d.brand_name });
  const out = { ...d, channel, sendable: channel === 'email' };
  if (channel === 'call' && !d.talking_points) {
    out.best_time = d.best_time || CHN.bestTime(String(d.why || '') + ' ' + String(d.brand_name || ''));
    out.talking_points = CHN.talkingPoints({ who: `${universityName} Athletics`, subject: d.team_label ? `the ${d.team_label} program` : 'the athletics program',
      business: d.brand_name, why: d.why });
  }
  // A call card has no email in it; its body is what to say.
  if (channel === 'call') { out.subject = null; out.body = CHN.callText({ contactName: d.contact_name, phone: d.contact_phone, best: out.best_time, points: out.talking_points }); }
  return out;
}

// ── ON-DEMAND PITCH ─────────────────────────────────────────────────────────
// opts: { brand, teamId, athlete: { name, facts }, acknowledgeHistory, ai }
async function pitch(pool, universityId, userId, opts) {
  const u = await universityFor(pool, universityId);
  const biz = (await search(pool, universityId, { limit: 5000 })).rows.find((x) => x.brand === opts.brand);
  if (!u || !biz) return { ok: false, status: 404, error: 'business not found' };
  // Restricted categories are blocked here too, not only in the pool.
  const raw = (await pool.query(`SELECT types, primary_type, primary_type_label, blocked_reason FROM university_market_seen WHERE market_key = $1 AND brand = $2`,
    [u.marketKey, opts.brand])).rows[0] || {};
  const blocked = raw.blocked_reason || require('./teamScan').blockedFor({ name: opts.brand, types: raw.types || [], primary_type: raw.primary_type, primary_type_label: raw.primary_type_label });
  if (blocked) return { ok: false, status: 422, error: `this business cannot be pitched for a team: ${blocked.key || blocked}` };
  if (biz.stage === 'do_not_contact') return { ok: false, status: 409, error: 'marked Do not contact' };
  // THE HARD RULE: anyone's earlier touch is shown before anything is written.
  const h = await history(pool, universityId, opts.brand);
  if (h.touched && !opts.acknowledgeHistory) return { ok: false, status: 409, needsAck: true, history: h };
  const team = opts.teamId ? (await pool.query(`SELECT * FROM university_teams WHERE id = $1 AND university_id = $2`, [opts.teamId, universityId])).rows[0] : null;
  // A TEAM WITH NOTHING TO SELL IS NOT PITCHED (campusNightly.sellableTeams):
  // inventory still available, roster or home dates or not.
  if (team && !((await require('./campusNightly').sellableTeams(pool, universityId)).get(team.id) || {}).sellable) {
    return { ok: false, status: 422, error: `${team.name} has no inventory left to sell, so there is nothing to pitch for it yet.` };
  }
  if (opts.teamId && !team) return { ok: false, status: 404, error: 'team not found' };
  if (!team && !(opts.athlete && opts.athlete.name)) return { ok: false, status: 400, error: 'pick a team or name an athlete' };
  const sender = await senderFor(pool, userId);
  const TW = require('./teamWriter');
  const ctx = { university: u, team: team || { name: `${u.name} Athletics` },
    business: { brand_name: biz.brand, kindLabel: biz.kind, category: biz.category, address: biz.address, distance_m: biz.miles === null ? null : biz.miles * MI,
      rating: biz.rating, user_ratings_total: biz.reviews, evidence: biz.athleteHistoryNote },
    athlete: opts.athlete && opts.athlete.name ? { name: String(opts.athlete.name).slice(0, 80), facts: String(opts.athlete.facts || '').slice(0, 400) } : null,
    contactName: biz.contact.name, sender };
  // No email address, no email (services/cardChannel).
  const CHN = require('./cardChannel');
  // Not a decision maker (an assistant store manager): left off, as on the night's cards.
  { const QC = require('./campusQuality');
    if (biz.contact.name && (QC.refusedName(biz.contact.name) || QC.refusedTitle(biz.contact.title))) {
      biz.contact.name = null; biz.contact.title = null; biz.contact.email = null; ctx.contactName = null;
    } }
  // No named person yet: written to the business ("Hi <business> team,"), as
  // the free night does; "Find the owner" on the card puts a name on it.
  const sendTo = biz.contact.email || biz.contact.sharedEmail || null;
  // A brand-wide handle is not this location's DM (cardChannel.campusHandle).
  biz.contact.instagram = CHN.campusHandle({ instagram: biz.contact.instagram, brand: biz.brand, city: require('./teamScan').cityOf(u.location) });
  const channel = CHN.campusChannelOf({ email: sendTo, phone: biz.contact.phone, instagram: biz.contact.instagram });
  if (!channel) return { ok: false, status: 422, error: 'there is no email, phone or Instagram for anyone at this business yet, so there is no one to reach' };
  let w, best = null, points = null;
  if (channel === 'call') {
    best = CHN.bestTime([biz.category, biz.kind].filter(Boolean).join(' '));
    points = CHN.talkingPoints({ who: [sender && sender.name, `${u.name} Athletics`].filter(Boolean).join(', '),
      subject: ctx.athlete ? ctx.athlete.name : `the ${ctx.team.name} program`, business: biz.brand, why: biz.fit && biz.fit.why, miles: biz.miles,
      ask: ctx.athlete ? `would ${biz.brand} like to work with ${ctx.athlete.name} on a few posts or an appearance? If yes, set a 15-minute call; if this is not the right person, ask who decides on marketing.` : null });
    w = { ok: true, subject: `Call ${biz.brand}`, body: CHN.callText({ contactName: biz.contact.name, phone: biz.contact.phone, best, points }), model: null };
  } else {
    w = await TW.writeAsk({ ...ctx, dm: channel === 'dm' }, { ai: opts.ai });
  }
  if (!w.ok) return { ok: false, status: 502, error: 'could not write it: ' + w.error };
  // Every way to reach them: a handle gets its DM beside the email or the call.
  let dmText = channel === 'dm' ? w.body : null;
  if (channel !== 'dm' && CHN.hasHandle(biz.contact.instagram)) {
    const d = await TW.writeAsk({ ...ctx, dm: true }, { ai: opts.ai });
    if (d.ok) dmText = d.body;
  }
  const id = 'udraft_' + require('crypto').randomBytes(8).toString('hex');
  await pool.query(
    `INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, place_id, subject, body, model, status, kind, athlete_name,
        contact_name, contact_title, contact_email, contact_phone, contact_instagram, sender_user_id, sender_email, created_by, channel, best_time, talking_points, dm_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12,$13,$14,$15,$16,$17,$18,$17,$19,$20,$21::jsonb,$22)`,
    [id, universityId, team ? team.id : null, 'brand:' + biz.brand.toLowerCase(), biz.brand, biz.place_id || null, w.subject, w.body, w.model,
      ctx.athlete ? 'athlete' : 'pitch', ctx.athlete ? ctx.athlete.name : null, biz.contact.name, biz.contact.title, sendTo,
      biz.contact.phone, biz.contact.instagram, userId, sender && sender.email, channel, best, points ? JSON.stringify(points) : null, dmText]);
  return { ok: true, draft: { id, channel, bestTime: best, talkingPoints: points, dmText, subject: channel === 'call' ? null : w.subject, body: w.body,
    to: channel === 'email' ? sendTo : null, contact: biz.contact, sender,
    mailto: channel === 'email' ? `mailto:${encodeURIComponent(sendTo)}?subject=${encodeURIComponent(w.subject)}&body=${encodeURIComponent(w.body)}` : null } };
}

module.exports = {
  cardForPortal,
  search, csvOf, detail, history, logTouch, setStage, addDeal, deals, senderFor, defaultSender, pitch, parseFilters, present,
  STAGES, STAGE_LABEL, CHANNELS, FIT_MIN,
};
