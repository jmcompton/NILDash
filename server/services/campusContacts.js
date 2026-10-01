'use strict';
// ── A NAME AND A WAY TO REACH THEM, FOR EVERY BUSINESS IN TOWN ──────────────
//
// "Rather than me trying to figure out who's the owner of Wava Grill down the
// street, being able to just pull that information." The pool is the town; this
// makes it a call list. Platform-wide we had an owner for 40% of businesses,
// and that number is the difference between a product and an empty table.
//
// One business, the same ladder the agent side runs -- not a second one:
//   1. ai.getBrandContacts: Places (website, phone), the site scrape, Hunter,
//      the person-email search, Instagram (bio, owner, DM handle), and the
//      web-search sources (chamber, site, Facebook About, Google reviews
//      replies, LinkedIn, registry, news).
//   2. ownerNameSearch.findOwnerName: a plain owner / marketing-director web
//      search, when the ladder found no named person.
//   3. One search for athlete or NIL sponsorship history (cited, or nothing).
// A public Instagram handle counts as a way to reach: a business is never
// discarded for lacking an email when there is a DM path.
//
// REACHABLE = a named human AND (email OR phone OR Instagram handle).
// A failure on our side (services/ourFault) is status 'error' and retried; it
// is never written down as "unreachable".
//
// Long-running (a thousand businesses), so it runs inside the server as a
// background job, resumable: rows are 'pending' until resolved, and a restart
// picks up where it stopped.
const CAMPUS_CONCURRENCY = parseInt(process.env.CAMPUS_CONTACTS_CONCURRENCY, 10) || 4;
const MAX_ATTEMPTS = 3;

// ── WHICH OF THE TEAMS A BUSINESS PLAUSIBLY FITS, AND WHY ───────────────────
// Deterministic, no model call. Every team gets the general local-sponsor
// fit; a sport-specific business adds weight to its sport.
const SPORT_WORDS = {
  basketball: /basketball|hoops|\bcourt\b|sneaker|shoe|foot locker|athletic/i,
  soccer: /soccer|futbol|football club|\bfc\b|cleats/i,
  'water polo': /swim|aquatic|pool|water polo|surf|beach/i,
  swimming: /swim|aquatic|pool|surf|beach|spa\b|physical therapy|physio/i,
  baseball: /baseball|batting|cage|little league|diamond|dugout/i,
  softball: /softball|batting|cage|diamond|dugout/i,
  volleyball: /volleyball|\bcourt\b|athletic/i,
  'beach volleyball': /beach|volleyball|surf|sand|sunscreen|smoothie|juice/i,
  tennis: /tennis|racquet|racket|pickleball|country club/i,
};
const EVERY_TEAM = /gym|fitness|training|sports|athletic|physical therapy|chiropract|orthopedic|nutrition|smoothie|juice|sporting goods|dick'?s|big 5|uniform|screen print|embroider|trophy/i;
const CATEGORY_ALL = { gym: 18, health: 16, wellness: 14, restaurant: 10, food: 10, coffee: 8, bank: 10, dealership: 10, insurance: 8,
  apparel: 10, retail: 6, auto: 8, education: 6, entertainment: 6, realestate: 6, services: 4, salon: 4, medspa: 4, pet: 3 };
function teamFit(business, teams) {
  const text = `${business.brand || ''} ${(business.types || []).join(' ')} ${business.primary_type_label || ''} ${business.category || ''}`;
  const base = CATEGORY_ALL[business.category] || 3;
  const everyone = EVERY_TEAM.test(text);
  const d = Number(business.distance_m);
  const near = Number.isFinite(d) ? (d <= 3000 ? 8 : d <= 8000 ? 4 : 0) : 0;
  const out = [];
  for (const t of teams) {
    const why = [];
    let score = base + near;
    if (base >= 10) why.push(`${business.category} businesses back local teams`);
    if (near) why.push(`${(d / 1609.34).toFixed(1)} mi from campus`);
    if (everyone) { score += 12; why.push('sports or fitness business'); }
    const re = SPORT_WORDS[String(t.sport || '').toLowerCase()];
    if (re && re.test(text)) { score += 25; why.unshift(`a ${t.sport} business`); }
    out.push({ team_id: t.id, team: t.name, score, why: why.slice(0, 3).join('; ') || 'local business near campus' });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── ONE BUSINESS ────────────────────────────────────────────────────────────
function pickPerson(res) {
  const ONS = require('./ownerNameSearch');
  const people = (res && res.contacts || []).filter((c) => c && c.name && ONS.looksLikePerson(c.name) && c.affiliationScope !== 'corporate');
  const rank = (c) => (c.email ? 4 : 0) + (c.phone ? 2 : 0) + (/owner|founder|president|ceo|general manager|gm\b|marketing/i.test(c.title || '') ? 1 : 0)
    + (c.confidence === 'high' ? 1 : 0);
  return people.sort((a, b) => rank(b) - rank(a))[0] || null;
}

async function resolveOne(row, ctx) {
  const ai = ctx.ai || require('../ai');
  const ONS = require('./ownerNameSearch');
  const city = ctx.city;
  const sources = [];
  let res = null;
  try {
    res = await ai.getBrandContacts(row.brand, null, city, ai.deepContactCtx({ market: 'school' }));
  } catch (e) {
    return { error: 'contact ladder: ' + e.message, fault: true };
  }
  if (res && res.outcome === 'ERROR') return { error: 'contact ladder failed on our side', fault: true };
  let person = pickPerson(res);
  if (person) sources.push(person.source || 'ladder');
  if (!person) {
    try {
      const found = await ONS.findOwnerName({ brand: row.brand, city, search: ai.webSearchJson });
      if (found && found.name) { person = { name: found.name, title: found.title || null, sourceUrl: found.sourceUrl || null }; sources.push('owner-search'); }
    } catch (e) {
      if (!(res && (res.businessPhone || res.instagram))) return { error: 'owner search: ' + e.message, fault: true };
    }
  }
  const ladder = (res && res.addressLadder) || {};
  const email = (person && person.email) || (ladder.email && (ladder.kind === 'person' || ladder.kind === 'personal' || ladder.kind === 'role') ? ladder.email : null)
    || (res && res.personalInbox) || (res && res.genericInbox) || null;
  const emailSource = person && person.email ? (person.emailSource || person.source || 'ladder') : email ? (ladder.label || 'inbox') : null;
  const phone = (person && person.phone) || (res && res.businessPhone) || null;
  const instagram = res && res.instagram ? String(res.instagram).replace(/^@/, '') : null;
  const all = (res && res.contacts) || [];
  const urlLike = (re) => (all.map((c) => [c.sourceUrl, c.linkedinUrl]).flat().find((u) => u && re.test(u))) || null;
  // ── ATHLETE OR NIL HISTORY: cited, or nothing ─────────────────────────────
  let history = null, historyNote = null;
  if (ctx.history !== false) {
    try {
      const h = await ai.webSearchJson(`Search for: has "${row.brand}" in ${city} sponsored local athletes, college or high school sports teams, or signed NIL deals?\n`
        + 'Answer ONLY JSON: {"history": true|false, "note": "one sentence naming the team or athlete, or empty", "url": "the source page or empty"}. '
        + 'true only if a source you found says so about THIS business.',
        'You check whether a local business has sponsored athletes or school sports. Answer only with the JSON asked for.');
      const j = JSON.parse(String((h && h.text) || '').replace(/^[^{]*/, '').replace(/[^}]*$/, '') || '{}');
      const cited = j.url && (h.citations || []).some((c) => String(c).includes(String(j.url).replace(/^https?:\/\//, '').split('/')[0]));
      history = j.history === true && cited ? true : false;
      historyNote = history ? String(j.note || '').slice(0, 240) || null : null;
    } catch (_) { history = null; }
  }
  return {
    contact_name: person ? person.name : null, contact_title: person ? person.title || null : null,
    email, email_source: emailSource, phone, instagram, website: (res && (res.website || res.websiteResolved)) || null,
    facebook: urlLike(/facebook\.com/i), linkedin: (person && person.linkedinUrl) || urlLike(/linkedin\.com/i),
    sources: sources.concat(all.map((c) => c.source).filter(Boolean)).filter((v, i, a) => a.indexOf(v) === i),
    athlete_history: history, athlete_history_note: historyNote,
    reachable: !!(person && person.name && (email || phone || instagram)),
  };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────
const _running = new Map();   // universityId -> promise, one run per university per process

async function seedRows(pool, u) {
  const teams = (await pool.query(`SELECT id, name, sport FROM university_teams WHERE university_id = $1`, [u.id])).rows;
  const rows = (await pool.query(
    `SELECT m.brand, m.place_id, m.category, m.types, m.distance_m, m.primary_type_label FROM university_market_seen m
      WHERE m.market_key = $1 AND m.blocked_reason IS NULL`, [u.marketKey])).rows;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO university_contacts (university_id, market_key, brand, place_id, team_fit) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (university_id, brand) DO UPDATE SET team_fit = EXCLUDED.team_fit, place_id = COALESCE(university_contacts.place_id, EXCLUDED.place_id)`,
      [u.id, u.marketKey, r.brand, r.place_id, JSON.stringify(teamFit(r, teams))]);
  }
  return rows.length;
}

async function run(pool, universityId, opts = {}) {
  if (_running.has(universityId)) return { ok: false, error: 'already running', running: true };
  const p = (async () => {
    const CP = require('./campusPool');
    await CP.ensureTables(pool);
    const u = await CP.universityOf(pool, universityId);
    if (!u) return { ok: false, error: `no university "${universityId}"` };
    const city = require('./teamScan').cityOf(u.location) || u.location;
    const seeded = await seedRows(pool, u);
    const runId = (await pool.query(`INSERT INTO university_market_runs (university_id, kind) VALUES ($1,'contacts') RETURNING id`, [universityId])).rows[0].id;
    const todo = (await pool.query(
      `SELECT brand, place_id FROM university_contacts WHERE university_id = $1
         AND (status = 'pending' OR (status = 'error' AND attempts < $2)) ORDER BY brand ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}`,
      [universityId, MAX_ATTEMPTS])).rows;
    const scanMeter = require('../scanMeter');
    const Q = require('./outreachQueue');
    let done = 0, reachable = 0, errors = 0, cost = 0, i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const row = todo[i++];
        let out, meter;
        try {
          ({ result: out, meter } = await scanMeter.run(() => scanMeter.label({ site: 'campus.contacts', brand: row.brand },
            () => resolveOne(row, { city, ai: opts.ai, history: opts.history }))));
        } catch (e) { out = { error: e.message, fault: true }; meter = null; }
        const c = meter ? Q.priceOf(meter) : 0;
        cost += c;
        if (out.error) {
          errors++;
          await pool.query(`UPDATE university_contacts SET status = 'error', last_error = $3, attempts = attempts + 1, cost_usd = cost_usd + $4, updated_at = NOW()
                             WHERE university_id = $1 AND brand = $2`, [universityId, row.brand, String(out.error).slice(0, 400), c]);
          require('./ourFault').record('campus-contacts', `${row.brand}: ${out.error}`, 'campusContacts ' + universityId).catch(() => {});
        } else {
          if (out.reachable) reachable++;
          await pool.query(
            `UPDATE university_contacts SET contact_name = $3, contact_title = $4, email = $5, email_source = $6, phone = $7, instagram = $8,
               website = $9, facebook = $10, linkedin = $11, sources = $12::jsonb, athlete_history = $13, athlete_history_note = $14,
               reachable = $15, status = $16, last_error = NULL, attempts = attempts + 1, cost_usd = cost_usd + $17, resolved_at = NOW(), updated_at = NOW()
             WHERE university_id = $1 AND brand = $2`,
            [universityId, row.brand, out.contact_name, out.contact_title, out.email, out.email_source, out.phone, out.instagram, out.website,
              out.facebook, out.linkedin, JSON.stringify(out.sources || []), out.athlete_history, out.athlete_history_note, out.reachable,
              out.reachable ? 'reachable' : 'unreachable', c]);
        }
        done++;
        if (done % 25 === 0) {
          console.log(`[campus-contacts] ${u.name}: ${done}/${todo.length} resolved, ${reachable} reachable, ${errors} errors, $${cost.toFixed(2)}`);
          await pool.query(`UPDATE university_market_runs SET summary = $2 WHERE id = $1`, [runId, { seeded, todo: todo.length, done, reachable, errors, costUsd: cost }]).catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || CAMPUS_CONCURRENCY) }, worker));
    const summary = { seeded, todo: todo.length, done, reachable, errors, costUsd: Math.round(cost * 100) / 100 };
    await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [runId, summary]);
    console.log(`[campus-contacts] ${u.name}: run complete ${JSON.stringify(summary)}`);
    return { ok: true, ...summary };
  })().finally(() => _running.delete(universityId));
  _running.set(universityId, p);
  return opts.wait === false ? { ok: true, started: true } : p;
}
const isRunning = (universityId) => _running.has(universityId);

// ── THE THREE NUMBERS ───────────────────────────────────────────────────────
async function report(pool, universityId) {
  const CP = require('./campusPool');
  await CP.ensureTables(pool);
  const u = await CP.universityOf(pool, universityId);
  const pc = u ? await CP.poolCount(pool, u.marketKey) : { usable: 0, total: 0 };
  const c = (await pool.query(
    `SELECT COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE status IN ('reachable','unreachable'))::int AS resolved,
            COUNT(*) FILTER (WHERE reachable)::int AS reachable,
            COUNT(*) FILTER (WHERE contact_name IS NOT NULL)::int AS named,
            COUNT(*) FILTER (WHERE reachable AND email IS NOT NULL)::int AS with_email,
            COUNT(*) FILTER (WHERE reachable AND phone IS NOT NULL)::int AS with_phone,
            COUNT(*) FILTER (WHERE reachable AND email IS NULL AND phone IS NULL AND instagram IS NOT NULL)::int AS dm_only,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
            COUNT(*) FILTER (WHERE athlete_history)::int AS history,
            COALESCE(SUM(cost_usd), 0)::float AS contacts_cost
       FROM university_contacts WHERE university_id = $1`, [universityId])).rows[0];
  const poolRuns = (await pool.query(`SELECT summary FROM university_market_runs WHERE university_id = $1 AND kind = 'pool' AND finished_at IS NOT NULL`, [universityId])).rows;
  const poolCost = poolRuns.reduce((s, r) => s + (Number(r.summary && r.summary.costUsd) || 0), 0);
  const teams = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  // THE NIGHTLY ESTIMATE. Contacts are resolved once, so a card costs the
  // writer: one ask, sometimes a lint retry, on the team writer's model.
  const perAsk = parseFloat(process.env.UNIVERSITY_ASK_USD) || 0.02;
  const asksPerCard = 1.3;
  const nightly = Math.round(teams * 5 * asksPerCard * perAsk * 100) / 100;
  return {
    university: u && u.name, marketKey: u && u.marketKey, pool: pc, contacts: c, teams,
    hitRate: c.resolved ? c.reachable / c.resolved : null,
    poolCostUsd: Math.round(poolCost * 100) / 100, contactsCostUsd: Math.round(c.contacts_cost * 100) / 100,
    nightly: { cards: teams * 5, usd: nightly, assumes: `${asksPerCard} writer calls a card at $${perAsk} (contacts already resolved, so no lookup cost)` },
    running: isRunning(universityId),
  };
}

function formatReport(r) {
  const c = r.contacts;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  return [
    `${r.university} (${r.marketKey})${r.running ? '  CONTACT RESOLUTION STILL RUNNING' : ''}`,
    `POOL: ${r.pool.usable} usable businesses (${r.pool.total} incl. blocked)`,
    `1. CONTACT HIT RATE: ${c.reachable} of ${c.resolved} resolved have a named human AND a way to reach them = ${r.hitRate === null ? '-' : pct(c.reachable, c.resolved)}`
      + `${c.pending ? `  (${c.pending} still pending)` : ''}${c.errors ? `  (${c.errors} failed on our side, will retry)` : ''}`,
    `   with email ${c.with_email}, with phone ${c.with_phone}, Instagram DM only ${c.dm_only}; named but no way to reach ${c.named - c.reachable}; athlete/NIL history ${c.history}`,
    `2. COST OF THE DEEP BUILD: pool $${r.poolCostUsd.toFixed(2)} + contacts $${r.contactsCostUsd.toFixed(2)} = $${(r.poolCostUsd + r.contactsCostUsd).toFixed(2)}`,
    `3. NIGHTLY ESTIMATE: ${r.nightly.cards} cards (${r.teams} teams x 5) about $${r.nightly.usd.toFixed(2)} a night; ${r.nightly.assumes}`,
    r.hitRate !== null && r.hitRate < 0.6 ? 'UNDER 60%: this is the product problem; stop before the UI.' : '',
  ].filter(Boolean).join('\n');
}

module.exports = { run, report, formatReport, resolveOne, teamFit, pickPerson, seedRows, isRunning, MAX_ATTEMPTS };
