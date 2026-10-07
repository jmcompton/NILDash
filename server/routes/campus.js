'use strict';
// ── THE DEPARTMENT'S MARKET: ROUTES FOR STAFF (services/campusMarket) ───────
//
// Every route is for a signed-in member of a department's staff: a user with
// a university role and users.university_id set. The university comes from
// the session, never from the request, so one department can never ask for
// another's. Allowed through the university wall by prefix (middleware/
// modeGuard UNIVERSITY_ALLOWED_PREFIXES).
//
//   GET  /api/university/market/me                 who I am, my department, teams, stages
//   GET  /api/university/market/search            filters + sort; ?format=csv exports
//   GET  /api/university/market/business?brand=   one business, every touch, deals, drafts
//   POST /api/university/market/business/stage    { brand, stage, notes }
//   POST /api/university/market/business/touch    { brand, channel, summary, outcome, stage, teamId, athleteName, draftId }
//   POST /api/university/market/business/deal     { brand, teamId, athleteName, value, description, signedOn }
//   GET  /api/university/market/deals
//   POST /api/university/market/pitch             { brand, teamId | athlete:{name,facts}, acknowledgeHistory }
//   GET  /api/university/market/cards             this morning's cards (the nightly feed)
//   POST /api/university/market/me/title          { title }  (for the sign-off)
const CM = require('../services/campusMarket');

function mount(app, { store, requireAuth }) {
  const { requireUniversityMode } = require('../middleware/modeGuard');
  const pool = store.pool;
  const staff = async (req, res, next) => {
    try {
      const u = (await pool.query(`SELECT id, name, email, role, university_id FROM users WHERE id = $1`, [req.session.userId])).rows[0];
      if (!u) return res.status(401).json({ error: 'Not signed in' });
      // The admin viewing another university, read-only (services/adminView).
      const viewing = require('../services/adminView').override(u.id);
      if (viewing) { u.university_id = viewing; u.viewingAsAdmin = true; }
      if (!['university', 'university_admin', 'admin'].includes(u.role)) return res.status(403).json({ error: 'Department staff only', code: 'UNIVERSITY_ROLE_REQUIRED' });
      if (!u.university_id) return res.status(403).json({ error: 'This account is not linked to a department.', code: 'NO_UNIVERSITY_LINKED' });
      req.staff = u;
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  const guard = [requireAuth, requireUniversityMode, staff];
  // THE COLUMNS EVERY READ HERE NEEDS, BEFORE ANY READ. They were added only
  // when a night ran (teamScan.ensureTables), so the cards query named a
  // column production did not have yet and Cypress's 85 cards came back as
  // none. Run once at mount, and awaited by the cards read.
  let _ready = null;
  const ready = () => (_ready = _ready || (async () => {
    await require('../services/campusPool').ensureTables(pool);
    await require('../services/teamScan').ensureTables(pool);
    await require('../services/ownerLookup').ensureTable(pool);
  })().catch((e) => { _ready = null; throw e; }));
  ready().catch((e) => console.error('[campus] table setup at mount failed:', e.message));
  const brandOf = (req) => String((req.body && req.body.brand) || req.query.brand || '').trim().slice(0, 300);

  app.get('/api/university/market/me', guard, async (req, res) => {
    const u = await require('../services/campusPool').universityOf(pool, req.staff.university_id);
    const teams = (await pool.query(`SELECT id, name, sport, season, roster_size FROM university_teams WHERE university_id = $1 ORDER BY name`, [req.staff.university_id])).rows;
    const sender = await CM.senderFor(pool, req.staff.id);
    const cats = (await pool.query(`SELECT category, COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NULL AND category IS NOT NULL
                                     GROUP BY category ORDER BY n DESC`, [u && u.marketKey])).rows;
    res.json({ me: { id: req.staff.id, name: req.staff.name, email: req.staff.email, viewingAsAdmin: !!req.staff.viewingAsAdmin }, sender,
      university: u && { id: u.id, name: u.name, short_name: u.short_name, location: u.location },
      teams, categories: cats, stages: CM.STAGES.map((s) => ({ key: s, label: CM.STAGE_LABEL[s] })), channels: CM.CHANNELS });
  });

  app.get('/api/university/market/search', guard, async (req, res) => {
    try {
      const csv = req.query.format === 'csv';
      const r = await CM.search(pool, req.staff.university_id, { ...req.query, limit: csv ? 5000 : req.query.limit });
      if (!r.ok) return res.status(404).json(r);
      if (csv) {
        const team = r.filters.team ? (await pool.query(`SELECT name FROM university_teams WHERE id = $1 AND university_id = $2`, [r.filters.team, req.staff.university_id])).rows[0] : null;
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="businesses-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send('﻿' + CM.csvOf(r.rows, team && team.name));
      }
      res.json(r);
    } catch (e) { console.error('[campus/search]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/university/market/business', guard, async (req, res) => {
    const d = await CM.detail(pool, req.staff.university_id, brandOf(req));
    if (!d) return res.status(404).json({ error: 'business not found' });
    res.json(d);
  });

  app.post('/api/university/market/business/stage', guard, async (req, res) => {
    const r = await CM.setStage(pool, req.staff.university_id, req.staff.id, brandOf(req), req.body.stage, req.body.notes);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/university/market/business/touch', guard, async (req, res) => {
    const b = req.body || {};
    if (!brandOf(req)) return res.status(400).json({ error: 'brand required' });
    const t = await CM.logTouch(pool, req.staff.university_id, req.staff.id, brandOf(req), { channel: b.channel, direction: b.direction,
      summary: b.summary, outcome: b.outcome, stage: b.stage, teamId: b.teamId, athleteName: b.athleteName, draftId: b.draftId });
    if (b.draftId) {
      await pool.query(`UPDATE university_drafts SET sent_at = COALESCE(sent_at, NOW()), status = 'approved', updated_at = NOW()
                         WHERE id = $1 AND university_id = $2`, [b.draftId, req.staff.university_id]).catch(() => {});
    }
    res.json({ ok: true, touch: t });
  });

  app.post('/api/university/market/business/deal', guard, async (req, res) => {
    if (!brandOf(req)) return res.status(400).json({ error: 'brand required' });
    res.json({ ok: true, deal: await CM.addDeal(pool, req.staff.university_id, req.staff.id, brandOf(req), req.body || {}) });
  });

  app.get('/api/university/market/deals', guard, async (req, res) => {
    res.json({ deals: await CM.deals(pool, req.staff.university_id) });
  });

  app.post('/api/university/market/pitch', guard, async (req, res) => {
    try {
      const b = req.body || {};
      await ready();
      const r = await CM.pitch(pool, req.staff.university_id, req.staff.id, { brand: brandOf(req), teamId: b.teamId || null,
        athlete: b.athlete && b.athlete.name ? b.athlete : null, acknowledgeHistory: b.acknowledgeHistory === true });
      if (!r.ok) return res.status(r.status || 400).json(r);
      res.json(r);
    } catch (e) { console.error('[campus/pitch]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/university/market/cards', guard, async (req, res) => {
    try {
    await ready();
    const rows = (await pool.query(
      `SELECT d.id, d.team_id, t.name AS team_name, d.brand_name, d.subject, d.body, d.why, d.contact_name, d.contact_title, d.contact_email,
              d.contact_phone, d.contact_instagram, d.sender_email, d.status, d.sent_at, d.created_at, d.night, d.lane, d.program_url,
              d.channel, d.best_time, d.talking_points, d.dm_text, d.email_is_shared, t.name AS team_label,
              COALESCE(r.stage, 'not_contacted') AS stage,
              (SELECT o.found FROM university_owner_lookups o WHERE o.university_id = d.university_id AND o.brand = d.brand_name AND o.error IS NULL
                ORDER BY o.at DESC LIMIT 1) AS owner_lookup_found,
              (SELECT (x->>'score')::int FROM university_contacts c, jsonb_array_elements(COALESCE(c.team_fit, '[]'::jsonb)) x
                WHERE c.university_id = d.university_id AND c.brand = d.brand_name AND x->>'team_id' = d.team_id LIMIT 1) AS fit
         FROM university_drafts d LEFT JOIN university_teams t ON t.id = d.team_id
         LEFT JOIN university_crm r ON r.university_id = d.university_id AND r.brand = d.brand_name
        WHERE d.university_id = $1 AND d.kind = 'pitch' AND d.night = (SELECT MAX(night) FROM university_drafts WHERE university_id = $1 AND night IS NOT NULL)
        ORDER BY t.name, d.created_at`, [req.staff.university_id])).rows;
    const uniName = ((await pool.query(`SELECT name FROM universities WHERE id = $1`, [req.staff.university_id])).rows[0] || {}).name || 'the athletic department';
    res.json({ cards: rows.map((d) => CM.cardForPortal(d, uniName)) });
    } catch (e) {
      // Loud: a failed read is never an empty morning.
      console.error('[campus/cards]', req.staff.university_id, e.message);
      require('../services/ourFault').record('university-cards', `cards read failed for ${req.staff.university_id}: ${e.message}`, 'campus.cards').catch(() => {});
      res.status(500).json({ error: 'The leads could not be loaded.', code: 'CARDS_READ_FAILED' });
    }
  });

  // "Find the owner" on a card: the paid lookup for this one business, only
  // when staff ask (services/ownerLookup). Capped a month; never twice.
  app.post('/api/university/market/cards/:id/find-owner', guard, async (req, res) => {
    try {
      await ready();
      const OL = require('../services/ownerLookup');
      const r = await OL.findOwner(pool, req.staff.university_id, req.staff.id, String(req.params.id).slice(0, 80));
      if (!r.ok) return res.status(r.status || 400).json(r);
      const uniName = ((await pool.query(`SELECT name FROM universities WHERE id = $1`, [req.staff.university_id])).rows[0] || {}).name || 'the athletic department';
      res.json({ ok: true, found: r.found, cached: r.cached, leftUsd: r.leftUsd, card: CM.cardForPortal(r.card, uniName) });
    } catch (e) {
      console.error('[campus/find-owner]', e.message);
      require('../services/ourFault').record('campus-contacts', `find-owner failed for ${req.staff.university_id}: ${e.message}`, 'campus.findOwner').catch(() => {});
      res.status(500).json({ error: 'The lookup failed on our side. Try again later.' });
    }
  });

  app.post('/api/university/market/me/title', guard, async (req, res) => {
    await pool.query(`INSERT INTO university_staff (user_id, university_id, title) VALUES ($1,$2,$3)
                      ON CONFLICT (user_id) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()`,
      [req.staff.id, req.staff.university_id, String((req.body && req.body.title) || '').slice(0, 120) || null]);
    res.json({ ok: true });
  });
}

module.exports = { mount };
