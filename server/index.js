// server/index.js
require('dotenv').config();
if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set — using insecure default');

const express  = require('express');
const session  = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt   = require('bcryptjs');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const PDFDocument = require('pdfkit');
const store    = require('./store');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const ai       = require('./ai');
const { requireUniversityMode } = require('./middleware/modeGuard');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com';

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Restrict CORS to your domain only
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://mynildash.com', 'https://www.mynildash.com']
    : 'http://localhost:3000',
  credentials: true
}));

// Rate limiting — login/register: 10 attempts per 15 min
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI tools: 20 requests per minute per user
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.session?.userId || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many AI requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API: 100 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down.' },
});

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.set('trust proxy', 1);
app.use(session({
  store: process.env.DATABASE_URL ? new pgSession({ conString: process.env.DATABASE_URL, tableName: 'session', createTableIfMissing: true }) : undefined,
  secret: process.env.SESSION_SECRET || 'nildash-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV !== 'development', httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Auth middleware ────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── Health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('YOUR_KEY'));
  res.json({ status: 'ok', aiReady: hasKey, version: '1.0.0' });
});

// ── Auth routes ────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: 'All fields required' });
  if (!['agent', 'university'].includes(role))
    return res.status(400).json({ error: 'Invalid role selected.' });
  if (await store.getUserByEmail(email))
    return res.status(400).json({ error: 'Email already registered' });
  // Check if email is approved
  try {
    const approved = await store.pool.query('SELECT id FROM access_requests WHERE email=$1 AND status=$2', [email, 'approved']);
    if (approved.rows.length === 0)
      return res.status(403).json({ error: 'Your email has not been approved yet. Request access at mynildash.com/landing' });
  } catch(e) { console.error('Approval check failed:', e.message); }

  const hash = await bcrypt.hash(password, 10);
  const id   = 'user-' + Date.now();
  const user = await store.saveUser(id, {
    id, name, email, password: hash, role,
    createdAt: new Date().toISOString(),
  });

  req.session.userId = id;
  req.session.role   = role;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = await store.getUserByEmailWithPassword(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  req.session.userId = user.id;
  req.session.role   = user.role;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  // Refresh session role on every /me call — handles sessions that predate role storage
  if (!req.session.role) req.session.role = user.role;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });

// ── Admin seed + university link endpoint ─────────────────────────
// POST /api/admin/seed-samford
// Links admin account to Samford University, inserts demo athletes
// with university_id stamped. ON CONFLICT DO UPDATE so re-running
// this refreshes the university_id on any previously inserted records.
}).post('/api/admin/seed-samford', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const agentId = user.id;
  const UNIV_ID = 'univ-samford';

  // 1. Ensure university exists (migration may not have run yet)
  await store.pool.query(
    `INSERT INTO universities (id, name, short_name, conference, location)
     VALUES ($1, 'Samford University', 'Samford', 'SoCon', 'Birmingham, AL')
     ON CONFLICT (id) DO NOTHING`,
    [UNIV_ID]
  ).catch(() => {});

  // 2. Link this admin account to Samford for University Mode
  await store.pool.query(
    `UPDATE users SET university_id = $1 WHERE id = $2`,
    [UNIV_ID, agentId]
  ).catch(() => {});

  const SAMFORD_ATHLETES = [
    { id:'samford-demo-001', name:'Marcus Webb',   sport:'Football',           position:'Wide Receiver', school:'Samford University', schoolTier:'G5', instagram:18400, tiktok:22100, engagement:5.2, stats:'68 rec, 1,024 yds, 9 TD (2024)',          notes:'Birmingham native. Business major. Training content and fan engagement on social.', university_id: UNIV_ID },
    { id:'samford-demo-002', name:'Jordan Tate',   sport:'Basketball',         position:'Point Guard',   school:'Samford University', schoolTier:'G5', instagram:9800,  tiktok:14300, engagement:6.8, stats:'17.4 PPG, 6.1 APG, 1.9 SPG (2024-25)',   notes:'SoCon All-Conference honorable mention. Behind-the-scenes campus content.', university_id: UNIV_ID },
    { id:'samford-demo-003', name:'Ava Hollins',   sport:"Women's Soccer",     position:'Midfielder',    school:'Samford University', schoolTier:'G5', instagram:7200,  tiktok:5100,  engagement:7.4, stats:'8 goals, 5 assists (2024)',               notes:'Pre-med student. Active in local community volunteering.', university_id: UNIV_ID },
    { id:'samford-demo-004', name:'Caleb Norris',  sport:'Baseball',           position:'Pitcher',       school:'Samford University', schoolTier:'G5', instagram:4100,  tiktok:3600,  engagement:4.1, stats:'2.87 ERA, 89 K, 7-3 record (2024)',       notes:'Junior. High engagement when active. Minimal posting frequency.', university_id: UNIV_ID },
    { id:'samford-demo-005', name:'Deja Monroe',   sport:"Women's Basketball", position:'Small Forward', school:'Samford University', schoolTier:'G5', instagram:12600, tiktok:19800, engagement:8.3, stats:'14.2 PPG, 7.8 RPG (2024-25)',             notes:'Most followed athlete in the program. Active creator — training, travel, fashion.', university_id: UNIV_ID },
    { id:'samford-demo-006', name:'Tyler Okafor',  sport:'Football',           position:'Linebacker',    school:'Samford University', schoolTier:'G5', instagram:3200,  tiktok:1800,  engagement:3.9, stats:'88 tackles, 6.5 TFL, 3 sacks (2024)',     notes:'Sophomore. Social presence still developing.', university_id: UNIV_ID },
    { id:'samford-demo-007', name:'Priya Nair',    sport:'Track & Field',      position:'Sprints',       school:'Samford University', schoolTier:'G5', instagram:2900,  tiktok:6700,  engagement:9.1, stats:'11.42s 100m PR, SoCon qualifier 2024',    notes:'High engagement despite smaller following. Training clips perform well on TikTok.', university_id: UNIV_ID },
    { id:'samford-demo-008', name:'Cole Hutchins', sport:'Football',           position:'Quarterback',   school:'Samford University', schoolTier:'G5', instagram:31200, tiktok:28900, engagement:4.7, stats:'2,841 pass yds, 24 TD, 7 INT (2024)',    notes:'Starting QB and de facto face of the program.', university_id: UNIV_ID },
  ];

  let inserted = 0, updated = 0, failed = 0;
  for (const athlete of SAMFORD_ATHLETES) {
    const { id, ...data } = athlete;
    try {
      const result = await store.pool.query(
        `INSERT INTO athletes (id, agent_id, data, created_at, updated_at, last_updated_at)
         VALUES ($1, $2, $3, NOW(), NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), last_updated_at = NOW()`,
        [id, agentId, JSON.stringify(data)]
      );
      // rowCount = 1 for both insert and update with ON CONFLICT DO UPDATE
      const existing = await store.pool.query('SELECT id FROM athletes WHERE id=$1', [id]);
      if (existing.rows.length) updated++; else inserted++;
    } catch (err) {
      console.error('[seed]', athlete.name, err.message);
      // Fallback without last_updated_at
      try {
        await store.pool.query(
          `INSERT INTO athletes (id, agent_id, data, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [id, agentId, JSON.stringify(data)]
        );
        updated++;
      } catch (e2) { failed++; }
    }
  }

  res.json({ ok: true, upserted: inserted + updated, failed, total: SAMFORD_ATHLETES.length, university: 'Samford University', university_id: UNIV_ID, adminLinked: true });
});

// ── Athletes ───────────────────────────────────────────────────
app.get('/api/athletes', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  let athletes;
  if (user.role === 'agent') {
    athletes = await store.getAthletesByAgent(user.id);
  } else {
    // Athlete sees only their own profile
    athletes = await store.getAthletesByAgent(user.id); // athleteId stored under their userId
  }
  res.json(athletes);
});

app.post('/api/athletes', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  const { name, sport, position, school, schoolTier, instagram, tiktok, engagement, notes, year, stats, transferReason, gpa } = req.body;
  if (!name || !sport) return res.status(400).json({ error: 'name and sport required' });
  const id = 'ath-' + Date.now();
  const athlete = await store.saveAthlete(id, {
    id, agentId: user.id, name, sport, position: position || '',
    school: school || '', schoolTier: schoolTier || 'p4-mid',
    instagram: parseInt(instagram) || 0,
    tiktok: parseInt(tiktok) || 0,
    engagement: parseFloat(engagement) || 3.0,
    notes: notes || '',
    year: year || '',
    stats: stats || '',
    transferReason: transferReason || '',
    gpa: gpa || '',
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(athlete);
});

app.put('/api/athletes/:id', requireAuth, async (req, res) => {
  const existing = await store.getAthlete(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = await store.saveAthlete(req.params.id, { ...existing, ...req.body });
  res.json(updated);
});

app.delete('/api/athletes/:id', requireAuth, async (req, res) => {
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Not found' });
  const user = await store.getUser(req.session.userId);
  // Allow admin or owner to delete
  if (athlete.agent_id !== req.session.userId && user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await store.deleteAthlete(req.params.id);
  res.json({ ok: true });
});

// ── Athlete note ─────────────────────────────────────────────
app.patch('/api/athletes/:id/note', requireAuth, async (req, res) => {
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Not found' });
  if (athlete.agent_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  await store.saveAthlete(req.params.id, { ...athlete, agentNote: req.body.agentNote || '' });
  res.json({ ok: true });
});

// ── Deals ──────────────────────────────────────────────────────
app.get('/api/athletes/:id/deals', requireAuth, async (req, res) => {
  res.json(await store.getDealsByAthlete(req.params.id));
});

app.post('/api/athletes/:id/deals', requireAuth, async (req, res) => {
  try {
    const { brand, campaign, stage, value, offeredValue } = req.body;
    if (!brand) return res.status(400).json({ error: 'Brand is required' });
    const athlete = await store.getAthlete(req.params.id);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const id = 'deal-' + Date.now();
    const deal = await store.saveDeal(id, {
      id, athleteId: req.params.id,
      agentId: req.session.userId,
      brand: brand || '', campaign: campaign || '',
      stage: stage || 'Prospecting',
      value: parseInt(value) || 0,
      offeredValue: parseInt(offeredValue) || 0,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(deal);
  } catch(err) {
    console.error('Save deal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get deal comps for rate accuracy
app.get('/api/comps', requireAuth, async (req, res) => {
  const { sport, schoolTier } = req.query;
  const comps = await store.getComps(sport, schoolTier, 20);
  const stats = await store.getCompStats(sport, schoolTier);
  res.json({ comps, stats, count: comps.length });
});

app.post('/api/deals', requireAuth, async (req, res) => {
  const { id, athleteId, agentId, brand, campaign, value, stage, notes, source } = req.body;
  if (!id || !athleteId || !brand || !value) return res.status(400).json({ error: 'Missing required fields' });
  const deal = await store.saveDeal(id, {
    athleteId, agentId: req.session.userId,
    brand, campaign: campaign || 'Manual Entry',
    value: parseInt(value), stage: stage || 'Closed',
    notes: notes || '', source: source || 'manual',
    status: stage === 'Closed' ? 'closed' : 'active',
    createdAt: new Date().toISOString()
  });
  res.json(deal);
});

app.patch('/api/deals/:id', requireAuth, async (req, res) => {
  const existing = await store.getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const merged = { ...existing, ...req.body };
  // Sync status from stage (pipeline drag uses 'stage', other code uses 'status')
  if (req.body.stage === 'Closed' && existing.stage !== 'Closed') merged.status = 'closed';
  else if (req.body.status === 'closed' && existing.status !== 'closed') merged.stage = merged.stage || 'Closed';
  // Auto-save to deal comps when deal moves to Closed with a real value
  const isNowClosed = (req.body.stage === 'Closed' && existing.stage !== 'Closed') ||
                      (req.body.status === 'closed' && existing.status !== 'closed');
  if (isNowClosed && parseInt(merged.value || 0) > 0) {
    const athlete = await store.getAthlete(existing.athleteId);
    if (athlete) {
      await store.saveComp(merged, athlete);
      console.log('Deal comp saved:', athlete.sport, athlete.schoolTier, '$' + (merged.value || 0));
    }
  }
  res.json(await store.saveDeal(req.params.id, merged));
});

app.delete('/api/deals/:id', requireAuth, async (req, res) => {
  const deal = await store.getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Not found' });
  // Allow if owner or if no agent_id set (legacy deals)
  const user = await store.getUser(req.session.userId);
  const isAdmin = user && user.email === ADMIN_EMAIL;
  if (!isAdmin && deal.agent_id && deal.agent_id !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await store.deleteDeal(req.params.id);
  res.json({ ok: true });
});

// ── AI endpoints ───────────────────────────────────────────────
app.post('/api/ai/command', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const athlete = athleteId ? await store.getAthlete(athleteId) : null;
  const eff = athlete || { name:'General', sport:'basketball', position:'',
    school:'Unknown', schoolTier:'p4-mid', instagram:0, tiktok:0, engagement:4.0, notes:'' };
  const user = await store.getUser(req.session.userId);
  try {
    await ai.streamResponse(eff, message, user.role, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/deals', requireAuth, aiLimiter, async (req, res) => {
  const athlete = await store.getAthlete(req.body.athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const user = await store.getUser(req.session.userId);
  try {
    const excludeBrands = Array.isArray(req.body.excludeBrands) ? req.body.excludeBrands : [];
    const recommendations = await ai.getDealRecommendations(athlete, user.role, excludeBrands);
    res.json({ recommendations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/rate', requireAuth, aiLimiter, async (req, res) => {
  const athlete = await store.getAthlete(req.body.athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const deliverableType = req.body.deliverableType || 'ig-reel';
  const rate = ai.calculateRate(athlete, deliverableType);

  // Pull comparable deals from the database
  const [compStats, recentComps] = await Promise.all([
    store.getCompStats(athlete.sport, athlete.schoolTier),
    store.getComps(athlete.sport, athlete.schoolTier, 5)
  ]);

  const compCount = parseInt(compStats?.count || 0);
  const confidence = compCount >= 20 ? 'High' : compCount >= 5 ? 'Medium' : 'Low';
  const confidenceNote = compCount >= 20
    ? `Based on ${compCount} comparable closed deals in this sport/tier`
    : compCount >= 5
    ? `Based on ${compCount} comparable deals — more data will improve accuracy`
    : 'Limited comp data for this sport/tier — rate based on NILViewVal model benchmarks';

  const comps = recentComps.map(c => ({
    sport: c.sport,
    tier: c.school_tier,
    followers: parseInt(c.followers),
    engagement: parseFloat(c.engagement),
    dealType: c.deal_type,
    value: parseInt(c.deal_value),
    year: c.year_in_school || null
  }));

  // ── Trustworthy output layer ─────────────────────────────────────────────
  // Adds transparent estimation fields — keeps all existing fields intact.
  const {
    nilViewVal: _nilVV,
    cleanRange, generateRateDrivers, generateRateLimitations,
    calcMarketReliabilityScore, generateConfidenceTypes, generateComparableNote,
    generateMomentumSignal, generatePricingStrategy,
  } = require('./benchmarks');
  const cleaned     = cleanRange(rate.low, rate.high);
  const rateDrivers = generateRateDrivers(athlete, rate);
  const rateLimits  = generateRateLimitations(athlete, rate, compCount);
  const reliability = calcMarketReliabilityScore(athlete, rate, compCount);
  const confTypes   = generateConfidenceTypes(athlete, rate, compCount);
  const compNote    = generateComparableNote(athlete, rate);
  const momentum    = generateMomentumSignal(athlete);
  const pricingStrategy = generatePricingStrategy(rate);

  // Pre-compute clean ranges for key deal types (reuses existing math, no new model)
  function _cr(t) { const r = _nilVV(athlete, t); return cleanRange(r.low, r.high); }
  const dealTypeRates = {
    'ig-post':            _cr('ig-post'),
    'ig-reel':            _cr('ig-reel'),
    'stories':            _cr('stories'),
    'bundle':             _cr('bundle'),
    'appearance-inperson':_cr('appearance-inperson'),
    'retainer':           _cr('retainer'),
  };

  // Inputs used — for "How this estimate was built" transparency panel
  const estimateInputs = [
    athlete.instagram > 0   ? 'Instagram reach ('  + (athlete.instagram||0).toLocaleString() + ')' : null,
    athlete.tiktok > 0      ? 'TikTok reach ('     + (athlete.tiktok||0).toLocaleString() + ')'    : null,
    athlete.engagement > 0  ? 'Engagement rate ('  + athlete.engagement + '%)'                      : null,
    athlete.schoolTier      ? 'School visibility (' + athlete.schoolTier + ')'                      : null,
    athlete.sport           ? 'Sport demand index (' + athlete.sport + ')'                          : null,
    athlete.position        ? 'Position market index (' + athlete.position + ')'                    : null,
    athlete.ppg || athlete.rpg ? 'On-field performance stats'                                       : null,
    'Public NIL benchmark data (NCAA 2025, Opendorse, On3)',
  ].filter(Boolean);

  res.json({
    ...rate,
    liveData: false,
    comps,
    compStats: compCount > 0 ? {
      count: compCount,
      avg: Math.round(parseFloat(compStats.avg_value)),
      min: Math.round(parseFloat(compStats.min_value)),
      max: Math.round(parseFloat(compStats.max_value))
    } : null,
    confidence,
    confidenceNote,
    // ── Trustworthy output layer (new fields — additive, backward compatible)
    cleanLow:      cleaned.low,
    cleanHigh:     cleaned.high,
    rateDrivers,
    rateLimits,
    reliability,
    confTypes,
    compNote,
    momentum,
    pricingStrategy,
    dealTypeRates,
    estimateInputs,
  });
});

// ── Deal Close Mode — analyze endpoint ────────────────────────
app.post('/api/deal-close/analyze', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, brand, dealScanData } = req.body;
  if (!athleteId || !brand) return res.status(400).json({ error: 'athleteId and brand required' });

  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const user = await store.getUser(req.session.userId);
  const agentId = req.session.userId;

  // ── Pull cached data from DB (non-blocking lookups) ───────────
  const [enrichmentRow, matchRow, contactRows, outreachRows] = await Promise.all([
    store.pool.query(
      `SELECT * FROM company_enrichment WHERE agent_id=$1 AND brand_name ILIKE $2 ORDER BY created_at DESC LIMIT 1`,
      [agentId, brand]
    ).then(r => r.rows[0] || null).catch(() => null),
    store.pool.query(
      `SELECT * FROM brand_match_scores WHERE agent_id=$1 AND athlete_id=$2 AND brand_name ILIKE $3 ORDER BY created_at DESC LIMIT 1`,
      [agentId, athleteId, brand]
    ).then(r => r.rows[0] || null).catch(() => null),
    store.pool.query(
      `SELECT bc.* FROM brand_contacts bc
       JOIN company_enrichment ce ON bc.enrichment_id = ce.id
       WHERE ce.agent_id=$1 AND ce.brand_name ILIKE $2 ORDER BY bc.created_at DESC LIMIT 3`,
      [agentId, brand]
    ).then(r => r.rows).catch(() => []),
    store.pool.query(
      `SELECT id, subject, status, created_at FROM outreach_logs WHERE agent_id=$1 AND athlete_id=$2 AND brand_name ILIKE $3 ORDER BY created_at DESC LIMIT 3`,
      [agentId, athleteId, brand]
    ).then(r => r.rows).catch(() => []),
  ]);

  // ── Rate estimate + full reasoning layer ─────────────────────
  const {
    nilViewVal: _nvv, cleanRange, generatePricingStrategy,
    generateRateDrivers, generateRateLimitations,
    calcMarketReliabilityScore, generateConfidenceTypes,
    generateComparableNote, generateMomentumSignal,
    decomposeFitScore,
  } = require('./benchmarks');

  const athleteForRate = athlete.data || athlete;
  const rawRate   = _nvv(athleteForRate, dealScanData?.dealType || 'ig-reel');
  const cleaned   = cleanRange(rawRate.low, rawRate.high);
  const pricing   = generatePricingStrategy(rawRate);

  // Comp count from brand_match_scores or fallback
  const compCount = matchRow?.comp_count || 0;

  // Trustworthy output layer (same functions used in Rate Calculator)
  const rateDrivers    = generateRateDrivers(athleteForRate, rawRate);
  const rateLimits     = generateRateLimitations(athleteForRate, rawRate, compCount);
  const reliability    = calcMarketReliabilityScore(athleteForRate, rawRate, compCount);
  const confTypes      = generateConfidenceTypes(athleteForRate, rawRate, compCount);
  const compNote       = generateComparableNote(athleteForRate, rawRate);
  const momentum       = generateMomentumSignal(athleteForRate);
  const fitBreakdown   = decomposeFitScore(athleteForRate, enrichmentRow, matchRow, dealScanData);

  // ── AI: Negotiation Talking Points + Objection Handling ──────
  const reach = ((athleteForRate.instagram || 0) + (athleteForRate.tiktok || 0)).toLocaleString();
  const engagement = athleteForRate.engagement || 4.2;
  const campaignConcept = dealScanData?.campaign || matchRow?.campaign_ideas?.[0] || 'brand ambassador partnership';
  const fitScore = dealScanData?.fitScore || matchRow?.compatibility_score || 78;
  const rationale = dealScanData?.rationale || matchRow?.reasoning || 'Strong fit identified';
  const audienceAlignment = matchRow?.audience_alignment || '';
  const brandDesc = enrichmentRow?.description || '';

  const aiPrompt = `You are a sports agent preparing for a call with ${brand} about a NIL deal for ${athlete.name}.

CONTEXT:
- Athlete: ${athlete.name}, ${athleteForRate.sport || 'athlete'}, ${athleteForRate.school || 'college'}
- Combined social reach: approximately ${reach}
- Engagement: ${engagement}%
- Brand: ${brand}${brandDesc ? ' (' + brandDesc + ')' : ''}
- Campaign concept: ${campaignConcept}
- Estimated market range: $${cleaned.low.toLocaleString()}–$${cleaned.high.toLocaleString()} per deliverable
- Why this brand was flagged: ${rationale}
${audienceAlignment ? '- Audience note: ' + audienceAlignment : ''}

Write a practical deal close briefing for the agent. Tone: experienced, human, grounded. No hype.

Return ONLY valid JSON (no markdown):
{
  "negotiation_points": [
    "One specific, data-grounded point the agent should make on the call",
    "Second point",
    "Third point",
    "Fourth point",
    "Fifth point"
  ],
  "opening_line": "Natural, low-pressure way to open the call — not scripted, not corporate",
  "objection_handling": [
    { "objection": "The rate feels high", "response": "Concise, grounded response — one or two sentences" },
    { "objection": "We're not sure about athlete fit", "response": "One or two sentences" },
    { "objection": "We need to get CMO approval", "response": "One or two sentences" },
    { "objection": "We already work with influencers", "response": "One or two sentences" }
  ],
  "ask_anchor": "One sentence: where to open the rate conversation and why that number",
  "walk_away_line": "Soft, non-aggressive sentence to close the call if it isn't going anywhere"
}`;

  let aiData = null;
  try {
    const raw = await ai.oneShot(aiPrompt, 'You are an elite sports agent negotiation coach. Return only valid JSON.', 2000, ai.MODEL_FAST);
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    aiData = JSON.parse(clean);
  } catch (e) {
    console.error('[deal-close] AI parse failed:', e.message);
    aiData = {
      negotiation_points: [
        `${athlete.name}'s ${engagement}% engagement is ${(engagement / 2.1).toFixed(1)}x the industry average for paid influencers`,
        `Total reach of ${reach} delivers CPM of approximately $12–16 vs. $28–45 for paid Instagram ads`,
        `${fitScore}/100 fit score — audience demographics align with ${brand}'s core market`,
        campaignConcept,
        rationale,
      ],
      opening_line: `I appreciate you taking the time — I wanted to walk you through why I think ${athlete.name} is a strong fit for ${brand} right now.`,
      objection_handling: [
        { objection: 'Your rate is too high', response: `The $${cleaned.low.toLocaleString()}–$${cleaned.high.toLocaleString()} range is based on ${athlete.name}'s ${engagement}% engagement, which is well above the ${(engagement / 2.1).toFixed(1)}x industry average. You're getting college-level authenticity at a fraction of macro-influencer pricing.` },
        { objection: 'We need to think about it', response: `Totally understand — what specific questions can I answer today to help you move forward? I can also send over the pitch deck if that helps the internal conversation.` },
      ],
      ask_anchor: `Open at $${cleaned.high.toLocaleString()} and signal flexibility down to $${cleaned.low.toLocaleString()} if they need to adjust scope.`,
      walk_away_line: `I hear you — let's stay in touch and revisit this when timing makes more sense.`,
    };
  }

  res.json({
    // ── Existing fields (preserved for backward compat) ──────────
    athlete: { name: athlete.name, sport: athleteForRate.sport, school: athleteForRate.school, instagram: athleteForRate.instagram, tiktok: athleteForRate.tiktok, engagement: athleteForRate.engagement, position: athleteForRate.position, stats: athleteForRate.stats },
    brand: { name: brand, description: brandDesc, industry: enrichmentRow?.industry, size: enrichmentRow?.brand_size, targetDemographics: enrichmentRow?.raw_data?.target_demographics },
    enrichment: enrichmentRow,
    match: matchRow,
    contacts: contactRows,
    outreach: outreachRows,
    pricing: { low: cleaned.low, high: cleaned.high, mid: pricing.target, start: pricing.start, target: pricing.target, stretch: pricing.stretch, dealType: dealScanData?.dealType || 'ig-reel' },
    dealScan: dealScanData || null,
    ai: aiData,
    hasExistingData: !!(enrichmentRow || matchRow || outreachRows.length),
    // ── v2 additions: 3-layer architecture ──────────────────────
    // DATA LAYER
    marketRange: { low: cleaned.low, high: cleaned.high, label: 'Estimated market range' },
    // REASONING LAYER
    rateDrivers,
    rateLimits,
    reliability,
    confTypes,
    compNote,
    momentum,
    fitBreakdown,
    // Meta
    userRole: user?.role || 'agent',
  });
});

app.post('/api/ai/negotiate', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, brand, theirOffer, agentTarget } = req.body;
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const user = await store.getUser(req.session.userId);
  const prompt = `The ${user.role} has a call in 30 minutes negotiating with ${brand}.
Their offer: ${theirOffer} | Target: ${agentTarget}
Give a 4-part playbook:
1. OPENING LINE — exact words
2. PUSHBACK RESPONSE — data to cite, exact words
3. CONCESSION MOVE — non-cash thing to offer
4. WALK-AWAY LINE — exact sentence
Include 3 KEY DATA POINTS to quote. Word-for-word scripts only.`;
  try {
    const playbook = await ai.oneShot(prompt, 'You are an elite sports agent negotiation coach with deep expertise in NIL deal rates and brand spending. Return practical word-for-word scripts.', 8000);
    res.json({ playbook });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI ask (non-streaming, works on all hosting) ──────────────
app.post('/api/ai/ask', requireAuth, async (req, res) => {
  const { athleteId, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const athlete = athleteId ? await store.getAthlete(athleteId) : null;
  const eff = athlete || { name:'General', sport:'basketball', position:'',
    school:'Unknown', schoolTier:'p4-mid', instagram:0, tiktok:0, engagement:4.0, notes:'' };
  const user = await store.getUser(req.session.userId);
  try {
    const response = await ai.oneShot(message, await ai.buildSystemPrompt(eff, user.role));
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





// ── Brand Outreach ─────────────────────────────────────────────
app.post('/api/ai/outreach', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, brand, category, contact, goal } = req.body;
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  const ig  = parseInt(athlete.instagram) || 0;
  const tt  = parseInt(athlete.tiktok)   || 0;
  const igFmt = ig >= 1000 ? 'around ' + Math.round(ig / 1000) + 'K' : (ig > 0 ? String(ig) : null);
  const ttFmt = tt >= 1000 ? 'around ' + Math.round(tt / 1000) + 'K' : (tt > 0 ? String(tt) : null);
  const statsSnippet = athlete.stats ? athlete.stats.split('|')[0].trim() : null;
  const contactFirstName = contact ? contact.split(/[\s,]+/)[0] : null;

  const system = `You are a NIL agent writing short, direct cold outreach emails. You sound like a real person — not a marketer, not an AI. Every sentence earns its place.

FORBIDDEN phrases — any of these cause immediate failure:
"The idea itself is simple" / "As I was thinking through" / "Hope you're doing well" as standalone / "I wanted to reach out" / "unique opportunity" / "perfect fit" / "natural fit" / "synergy" / "leverage" / "game-changer" / "thrilled" / "passionate" / "look forward to hearing" / "at your earliest convenience" / "if it sounds interesting, I'd love to jump on a call this week" / "value-add" / "I am writing to" / "seamless" / "authentic journey" / any bullet points or headers in the email

Return only valid JSON. No markdown.`;

  const prompt = `Write outreach from a NIL agent representing ${athlete.name} to ${brand}.

ATHLETE:
- ${athlete.name}, ${athlete.sport || 'athlete'}${athlete.position ? ' (' + athlete.position + ')' : ''}, ${athlete.school || 'college'}
${igFmt ? '- Instagram: ' + igFmt : ''}${ttFmt ? ' | TikTok: ' + ttFmt : ''}
- Engagement: ${athlete.engagement || 0}%
${statsSnippet ? '- Key stat: ' + statsSnippet : ''}

BRAND: ${brand} | Category: ${category || 'consumer brand'}
${contactFirstName ? 'Contact first name: ' + contactFirstName : ''}
${goal ? 'Deal goal: $' + parseInt(goal).toLocaleString() : ''}

EMAIL RULES:
- Open with one observational line about ${brand} — subtle, not flattering
- Introduce ${athlete.name} in 1–2 sentences, only the most relevant credential
- Describe one simple content idea in plain English, no over-explaining
- 1–2 lines connecting the athlete's audience to ${brand}
- Close with "Happy to share more if helpful." or similar — never pushy
- 140–170 words total. No headers. No bullets.

INSTAGRAM DM: Under 140 chars. Sounds like a real DM. References something specific about ${brand}. Not a pitch opener.

LINKEDIN: Under 180 chars. Professional but human. One sentence on why ${athlete.name} and ${brand} make sense.

Return ONLY this JSON:
{
  "emailSubject": "${athlete.name} × ${brand}",
  "email": "Full email body — 140-170 words, reads like a real human email",
  "instagram": "Under 140 char DM",
  "linkedin": "Under 180 char LinkedIn message"
}`;

  try {
    const raw = await ai.oneShot(prompt, system, 4000, ai.MODEL_STANDARD);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Generation failed' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// -- NIL Compliance --
app.post('/api/ai/compliance', requireAuth, aiLimiter, async (req, res) => {
  const { state, dealType, brand, value, description, athleteName, sport, school, schoolTier, signingDate } = req.body;

  // SPARTA 72-hour calculation
  let spartaSection = '';
  if (signingDate) {
    const signed = new Date(signingDate);
    const deadline = new Date(signed.getTime() + 72 * 60 * 60 * 1000);
    const now = new Date();
    const hoursLeft = Math.round((deadline - now) / (1000 * 60 * 60));
    const deadlineStr = deadline.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    spartaSection = `SPARTA COMPLIANCE:
- Signed: ${signed.toLocaleDateString()}
- 72-hour university notification deadline: ${deadlineStr}
- Hours remaining: ${hoursLeft > 0 ? hoursLeft + ' hours' : 'OVERDUE by ' + Math.abs(hoursLeft) + ' hours'}
- Status: ${hoursLeft > 24 ? 'On track' : hoursLeft > 0 ? 'URGENT - notify today' : 'DEADLINE PASSED'}`;
  }

  const prompt = 'Analyze this NIL deal for compliance in ' + state + ':\n' +
    'Athlete: ' + (athleteName||'Unknown') + ', ' + (sport||'Unknown') + ', ' + (school||'Unknown') + ' (' + (schoolTier||'unknown') + ')\n' +
    'Deal: ' + dealType + ' with ' + (brand||'unknown brand') + ' worth $' + (parseInt(value)||0) + '\n' +
    'Description: ' + (description||'not provided') + '\n' +
    (signingDate ? 'Signing Date: ' + signingDate + '\n' : '') + '\n' +
    'Check ALL of these: 1) State restrictions in ' + state + ' 2) Disclosure requirements 3) $600 NIL reporting threshold 4) Agent licensing requirements in ' + state + ' 5) Category restrictions (alcohol/gambling/tobacco/supplements/crypto) 6) SPARTA compliance - agent must notify ' + (school||'the university') + ' within 72 hours of signing 7) School-specific NIL policies\n\n' +
    'Return ONLY JSON: {"state":"' + state + '","status":"clear" or "warning" or "blocked","flags":[{"severity":"high" or "warning","issue":"short title","detail":"specific detail"}],"requirements":["required steps"],"disclosure":"exact disclosure language for contract or social post","spartaNotice":"exact letter/email text agent must send to university athletic department within 72 hours","sourceNote":"what laws this is based on"}';
  try {
    const result = await ai.oneShot(prompt, 'You are a NIL compliance expert with comprehensive knowledge of all 50 state NIL laws as of 2025-2026, plus the NCAA House settlement rules. Return only valid JSON.', 8000);
    const cleaned = result.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Failed to parse result' });
    const parsed = JSON.parse(match[0]);
    // Inject SPARTA timing data
    if (signingDate) {
      const signed = new Date(signingDate);
      const deadline = new Date(signed.getTime() + 72 * 60 * 60 * 1000);
      const hoursLeft = Math.round((deadline - new Date()) / (1000 * 60 * 60));
      parsed.sparta = {
        required: true,
        signingDate,
        deadline: deadline.toISOString(),
        deadlineFormatted: deadline.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
        hoursLeft,
        status: hoursLeft > 24 ? 'on-track' : hoursLeft > 0 ? 'urgent' : 'overdue'
      };
    }
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Player URL Fetch --
app.post('/api/ai/player-fetch', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    // ESPN, 247Sports, MaxPreps all block server scraping.
    // Extract player name + sport from the URL and run AI lookup instead.
    const knownBlocked = /espn\.com|247sports\.com|maxpreps\.com|on3\.com|rivals\.com/i.test(url);
    if (knownBlocked) {
      // ESPN: /college-football/player/_/id/123/nate-frazier
      // 247:  /player/nate-frazier-46123456/
      // MaxPreps: /nate-frazier/...
      const slugMatch = url.match(/\/([a-z]+-[a-z]+(?:-[a-z]+)*)\/?(?:\?|$|\d)/i)
        || url.match(/\/([a-z]+-[a-z]+(?:-[a-z]+)*)(?:-\d+)?\/?$/i);
      const rawName = slugMatch ? slugMatch[1].replace(/-/g, ' ') : '';

      const sportMatch = url.match(/college-(football|basketball|baseball|soccer|softball|volleyball|hockey|lacrosse|wrestling|gymnastics|swimming|tennis|golf|track)/i)
        || url.match(/\/(football|basketball|baseball|soccer|softball|volleyball|hockey|lacrosse|wrestling|gymnastics|swimming|tennis|golf|track)\//i);
      const sport = sportMatch ? sportMatch[1] : '';

      if (!rawName) return res.json({ found: false, error: 'Could not parse player name from URL — try the AI Lookup button instead.' });

      const prompt = `You are a college sports database. Look up: ${rawName}${sport ? ' (' + sport + ')' : ''}.

Pull ALL available seasons of stats — do not limit to one year. Format the stats field as a full career log:
"2023: [stats] | 2024: [stats] | 2025: [stats if available]"

For each season include the actual numbers (PPG/RPG/APG for basketball, rush yards/TDs/YPC or rec/yards/TDs for football, ERA/AVG/HR for baseball, etc). If a season is unavailable in your training data, omit it — do not fabricate numbers.

Also include:
- Transfer history (previous schools and when they transferred)
- Recruiting ranking (star rating, class year)
- Any awards or honors per season
- Draft projection if applicable

Return this JSON:
{
  "found": true,
  "name": "full name",
  "school": "current school",
  "previousSchool": "previous school if transfer, else null",
  "sport": "sport",
  "position": "position abbreviation",
  "year": "eligibility year (Freshman/Sophomore/Junior/Senior/Grad Transfer)",
  "stats": "full career stats log: 2023: X | 2024: X | 2025: X",
  "height": "e.g. 6-1",
  "weight": "e.g. 215 lbs",
  "hometown": "city, state",
  "instagram": 0,
  "tiktok": 0,
  "engagement": 0,
  "schoolTier": "p4-top10|p4-mid|p4-lower|mid-top|mid-lower|highmajor-top",
  "notes": "recruiting ranking, awards by season, transfer history, draft projection"
}

Return ONLY the JSON. No markdown, no explanation.`;
      const raw = await ai.oneShot(prompt, 'You are a precise college sports database. Return only verified career statistics across all seasons. Never fabricate numbers. Return only valid JSON.', 5000);
      const cleaned = raw.replace(/```json/g,'').replace(/```/g,'').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.json({ found: false });
      return res.json(JSON.parse(jsonMatch[0]));
    }

    // Non-blocked URL — attempt direct scrape
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    const pageText = await new Promise((resolve, reject) => {
      client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (r) => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => resolve(data));
      }).on('error', reject);
    });
    if (pageText.trim().startsWith('<!') || pageText.includes('Access Denied') || pageText.includes('403 Forbidden')) {
      return res.json({ found: false, error: 'This site blocks automated access. Use the AI Lookup button instead.' });
    }
    const text = pageText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 8000);
    const prompt = 'Extract college athlete info from this page text and return as JSON. Page: ' + text + '. Return this JSON: {"found":true,"name":"full name","school":"school","sport":"sport","position":"position","year":"year","stats":"key stats","notes":"bio and achievements"}. Return ONLY JSON.';
    const raw = await ai.oneShot(prompt, 'You extract structured athlete data from web pages. Return only valid JSON.');
    const cleaned = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ found: false });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -- Player Lookup --
app.post('/api/ai/player-lookup', requireAuth, aiLimiter, async (req, res) => {
  const { name, school, sport } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const prompt = `You are a college sports database. Look up this athlete and return ONLY accurate, verified data from your training knowledge. Do NOT guess or fabricate stats.

ATHLETE: ${name}${school ? ' — currently at ' + school : ''}${sport ? ' (' + sport + ')' : ''}

CRITICAL RULES:
- Pull ALL available seasons — format stats as a career log: "2023: [stats at School A] | 2024: [stats at School B] | 2025: [stats if available]"
- If this athlete transferred, include stats from EVERY school they played at, labeled by school and season
- "year" field = eligibility year (Freshman/Sophomore/Junior/Senior/Grad Transfer) — not years at current school
- Use real stat numbers (PPG/RPG/APG, rush yards/TDs/YPC, ERA/AVG, etc). If a season is not in your training data, omit it — do not invent numbers
- schoolTier for CURRENT school: p4-top10 = Alabama/Georgia/Ohio State tier | p4-mid = mid-P4 | p4-lower = lower P4 | highmajor-top = top Big East/A-10 | mid-top/mid-lower = mid-major

Return this JSON — use null for anything you cannot verify:
{"found":true,"name":"full legal name","school":"current school","previousSchool":"most recent previous school if transfer, else null","sport":"sport","position":"position abbreviation","year":"eligibility year","stats":"full career log: 2023 at X: stats | 2024 at Y: stats | 2025: stats if available","height":"e.g. 6-4","weight":"e.g. 215 lbs","hometown":"city, state","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-top10|p4-mid|p4-lower|mid-top|mid-lower|highmajor-top","notes":"recruiting ranking, awards by season, transfer history, draft projection"}

Return ONLY the JSON object. No markdown, no explanation.`;
  try {
    const raw = await ai.oneShot(prompt, 'You are a precise college sports database. Return only verified facts. Never fabricate statistics. Return only valid JSON.', 4000);
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ found: false });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── NILViewVal v4 Full Report ──────────────────────────────────
app.get('/api/nilviewval/:athleteId', requireAuth, async (req, res) => {
  try {
    const athlete = await store.getAthlete(req.params.athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const { nilViewVal } = require('./benchmarks');
    // Compute all key deliverable types
    const types = [
      'ig-reel', 'ig-post', 'ig-carousel', 'tiktok', 'tiktok-spark',
      'youtube-short', 'youtube-long', 'story-bundle', 'stories',
      'bundle', 'bundle-cross', 'retainer', 'ugc-video', 'ugc-photo',
      'appearance-inperson', 'camp-skills', 'collective-roster',
      'license-jersey', 'media-podcast', 'newsletter',
    ];
    const rates = {};
    for (const t of types) {
      const r = nilViewVal(athlete, t);
      rates[t] = { low: r.low, mid: r.mid, high: r.high };
    }
    const primary = nilViewVal(athlete, 'ig-reel'); // full object for scores
    res.json({
      athlete: { id: athlete.id, name: athlete.name, sport: athlete.sport, school: athlete.school },
      rates,
      scores: {
        marketabilityScore: primary.marketabilityScore,
        sponsorshipReadiness: primary.sponsorshipReadiness,
        audienceQuality: primary.audienceQuality,
        confidenceScore: primary.confidenceScore,
        archetypeScore: primary.archetypeScore,
        draftMult: primary.draftMult,
        statsMult: primary.statsMult,
      },
      sponsorCategories: primary.sponsorCategories,
      brandPartnershipTypes: primary.brandPartnershipTypes,
      breakdown: primary.breakdown,
      recommendation: primary.recommendation,
      floorApplied: primary.floorApplied,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI Athlete Brand Kit ───────────────────────────────────────
app.post('/api/ai/brand-kit', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, targetBrand, athletePhoto } = req.body;
  if (!athleteId) return res.status(400).json({ error: 'athleteId required' });
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  try {
    // Attach brand context to athlete object for AI generation
    const athleteWithBrand = { ...athlete, targetBrand: targetBrand || null, athletePhoto: athletePhoto || null };
    const kit = await ai.generateAthleteBrandKit(athleteWithBrand);
    // Pass brand + photo through to the response so pitch.html can use them
    res.json({ ...kit, targetBrand: targetBrand || null, athletePhoto: athletePhoto || null });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Generate Outreach (Enhanced) ───────────────────────────
app.post('/api/ai/generate-outreach', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, brand, category, outreachType, goal } = req.body;
  if (!athleteId || !brand) return res.status(400).json({ error: 'athleteId and brand required' });
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  try {
    const outreach = await ai.generateOutreach(athlete, brand, category, outreachType || 'email', goal);
    res.json(outreach);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Team Match endpoint ────────────────────────────────────────
app.post('/api/ai/team-match', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, sortBy } = req.body;
  const conf = req.body.conference && req.body.conference !== 'any' ? req.body.conference : null;
  const minNil = parseInt(req.body.minNil) || 0;
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  const { COLLECTIVES, getSportBudget } = require('./collectives');
  const { nilViewVal } = require('./benchmarks');
  const sport = (athlete.sport || 'basketball').toLowerCase();
  const position = (athlete.position || '').toLowerCase();

  // NIL trajectory based on year
  const year = (athlete.year || '').toLowerCase();
  const draftStatus = (athlete.draftStatus || '').toLowerCase();
  let trajectoryNote = 'Stable NIL window';
  if (draftStatus.includes('declared')) trajectoryNote = 'Pro transition imminent — structure deals accordingly';
  else if (year.includes('freshman') || year.includes('fr')) trajectoryNote = '3+ years of eligibility — high long-term NIL ceiling';
  else if (year.includes('sophomore') || year.includes('so')) trajectoryNote = '2+ years remaining — value grows with production';
  else if (year.includes('junior') || year.includes('jr')) trajectoryNote = 'Peak NIL window — maximize deals now';
  else if (year.includes('senior') || year.includes('sr')) trajectoryNote = 'Final year — prioritize multi-year or post-eligibility structures';

  // Sport-specific collective budgets for context
  const filtered = COLLECTIVES.filter(c => {
    if (conf && c.conf !== conf) return false;
    return true;
  });

  const collectiveContext = filtered.slice(0, 20).map(c => {
    const sb = getSportBudget(c, sport);
    return c.abbr + ' (' + c.conf + '): ' + sport + ' budget ~$' + Math.round(sb.low/1000) + 'K-$' + Math.round(sb.high/1000) + 'K';
  }).join('\n');

  // Transfer portal comps
  const { DEAL_COMPS } = require('./benchmarks');
  const athleteRate = nilViewVal(athlete, 'ig-reel');
  const reach = (athlete.instagram||0) + (athlete.tiktok||0);

  // Detect if athlete is from high school or has unknown tier — anchor to realistic programs
  const tierRaw = (athlete.schoolTier || '').toLowerCase();
  const isHighSchool = !tierRaw || tierRaw.includes('unknown') || tierRaw.includes('high school') || tierRaw === '';
  const realisticAnchor = isHighSchool
    ? '\nCRITICAL: This athlete is coming from a HIGH SCHOOL or has NO college history. ' +
      'You MUST suggest realistic entry-level college programs only. ' +
      'DO NOT suggest SEC, Big Ten, Big 12, or ACC programs unless the athlete has verifiable elite recruitment. ' +
      'Focus on: Mid-major programs (MAC, Sun Belt, CUSA, Big West, Horizon League, MAAC, Missouri Valley), ' +
      'low-major programs, and G5 schools. ' +
      'NIL values should be in the $0-$50K range for most positions. ' +
      'A high school athlete going to a mid-major starter role would earn $10K-$50K roster value. ' +
      'Be realistic — most high school athletes do not receive Power 4 offers.\n'
    : '';

  const prompt =
    'You are an expert NIL agent with deep knowledge of the 2024-26 transfer portal market.\n\n' +
    realisticAnchor +
    'Find the 6 best transfer portal destinations for this athlete:\n' +
    'Name: ' + athlete.name + '\n' +
    'Sport: ' + sport + ' | Position: ' + (position||'N/A') + '\n' +
    'Current school: ' + (athlete.school||'Unknown') + ' (' + (athlete.schoolTier||'') + ')\n' +
    'Year: ' + (year||'unknown') + ' | Draft status: ' + (draftStatus||'not declared') + '\n' +
    'Stats: PPG=' + (athlete.ppg||'?') + ' RPG=' + (athlete.rpg||'?') + ' APG=' + (athlete.apg||'?') + ' FG%=' + (athlete.fgPct||'?') + ' BPG=' + (athlete.bpg||'?') + '\n' +
    'Social: ' + reach.toLocaleString() + ' total reach | ' + (athlete.engagement||0) + '% ER\n' +
    'Archetype score: ' + (athleteRate.archetypeScore||'N/A') + '/99\n' +
    'NIL Trajectory: ' + trajectoryNote + '\n' +
    'Conference filter: ' + (conf||'any') + ' | Min NIL: $' + minNil.toLocaleString() + '\n\n' +
    'IMPORTANT CONTEXT — Sport-specific collective budgets:\n' + collectiveContext + '\n\n' +
    'REAL 2025-26 PORTAL ROSTER VALUE BENCHMARKS (use these as anchors):\n' +
    'BASKETBALL:\n' +
    '- Elite 5-star big/guard, lottery upside, P4: $2M-$5M+ (e.g. Aiden Sherrell $4M Indiana, Cooper Flagg $3M+ Duke)\n' +
    '- High major starter, strong stats, P4 top program: $500K-$2M\n' +
    '- Solid P4 starter, 10-15 PPG, mid-tier P4: $200K-$600K\n' +
    '- Role player, P4 program: $80K-$200K\n' +
    '- High major elite (Gonzaga, Dayton tier): $150K-$500K\n' +
    '- Mid major starter: $30K-$150K\n' +
    '- Mid major role player: $10K-$50K\n' +
    'FOOTBALL:\n' +
    '- Elite QB, P4 top 10 program: $1M-$4M\n' +
    '- Starter QB, P4 mid: $300K-$1M\n' +
    '- Elite skill (WR/RB/CB), P4 top 10: $300K-$1.5M\n' +
    '- Starter skill, P4 mid: $100K-$400K\n' +
    '- EDGE/DL starter, P4 top 10: $200K-$800K\n' +
    '- EDGE/DL starter, P4 mid: $80K-$300K\n' +
    '- OL starter, P4: $100K-$500K\n' +
    '- Role player, P4: $30K-$100K\n' +
    '- High major (AAC/MWC) starter: $20K-$100K\n' +
    'KEY FACTORS that move values up or down:\n' +
    '- Draft status: lottery/1st round = 2-3x multiplier\n' +
    '- Position scarcity: elite PG/QB/OT command premium\n' +
    '- Stat production: every 5 PPG above average = ~20% premium\n' +
    '- Market size: LA/NYC/Dallas programs pay 20-40% more\n' +
    '- Program prestige: top 10 programs pay premium to stay relevant\n\n' +
    'CRITICAL INSTRUCTIONS FOR NIL VALUATION:\n' +
    '1. Use ROSTER VALUE (what collectives pay athletes to be on the team) — NOT brand deal rates\n' +
    '2. Use your knowledge of real 2024-26 portal deals as anchors (e.g. Aiden Sherrell $4M Indiana, etc.)\n' +
    '3. Scale the athlete\'s roster value based on: their stats vs program need, collective budget for their sport, draft status, and position scarcity\n' +
    '4. A 5-star elite big with lottery upside at a top program = $1M-$5M roster value\n' +
    '5. A solid starter with good stats at a P4 program = $200K-$800K roster value\n' +
    '6. A role player at a mid-major = $50K-$200K roster value\n' +
    '7. Always filter by the sport-specific budget, not total collective budget\n\n' +
    'For each school provide:\n' +
    '- Accurate ROSTER VALUE range (nilLow/nilHigh) based on real market knowledge\n' +
    '- Specific roster need at this position\n' +
    '- What this collective has paid for similar players in recent portals\n' +
    '- How this program affects NIL trajectory\n' +
    '- A real portal comp player who took a similar path\n\n' +
    'Return ONLY JSON array of 6 schools. Sort by: ' + (sortBy||'fit') + '\n' +
    '[{"rank":1,"name":"Full School Name","conference":"SEC","confLabel":"SEC","tier":"reach|best-fit|safe","why":"2 specific sentences about this athlete fit","nilLow":1000000,"nilHigh":3000000,"nilBreakdown":[{"label":"Roster Value","val":"$1M-3M"}],"fitScore":92,"playingTimeOutlook":"Immediate starter","rosterNeed":"Lost 2 bigs to draft — critical need","collectiveDealHistory":"Paid $1.5M-2.5M for similar F/C archetypes in 2025 portal","trajectoryNote":"SEC exposure + elite coaching accelerates draft stock","portalComp":"Similar path to [Player] who signed $2M deal in 2025","metrics":[{"label":"Collective","val":"Elite"},{"label":"Market","val":"Major metro"},{"label":"Playing time","val":"High"}],"strengths":["2-3 specific strengths of this match for the athlete"],"weaknesses":["1-2 potential concerns or downsides"],"suggestedOpportunities":["2-3 specific NIL or brand opportunities unique to this school/market"]}]';

  // Add live search context to prompt

  let teams = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.oneShot(prompt, 'You are an expert NIL agent with deep knowledge of the 2024-26 transfer portal market. Return ONLY valid JSON array. No markdown. No preamble.', 8000);
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const si = cleaned.indexOf('[');
      const ei = cleaned.lastIndexOf(']');
      if (si === -1 || ei <= si) throw new Error('No JSON array');
      const parsed = JSON.parse(cleaned.substring(si, ei + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty');
      teams = parsed;
      break;
    } catch(e) { console.error('Team match error:', e.message); }
  }
  if (!teams) return res.json({ teams: [], error: 'AI service busy — please try again.' });
  res.json({ teams, liveData: true, trajectoryNote, archetypeScore: athleteRate.archetypeScore, marketabilityScore: athleteRate.marketabilityScore, sponsorshipReadiness: athleteRate.sponsorshipReadiness });
});
// ── Contract Generator ────────────────────────────────────────
app.post('/api/ai/contract', requireAuth, aiLimiter, async (req, res) => {
  const { athleteId, dealId, brand, value, deliverables, startDate, endDate,
          exclusivity, state, agentName, agentEmail, dealType, paymentTerms, usageRights } = req.body;

  const athlete = athleteId ? await store.getAthlete(athleteId) : null;
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  const prompt = `Generate a professional NIL representation contract with these exact details:

PARTIES:
- Athlete: ${athlete.name}, ${athlete.sport} athlete at ${athlete.school || 'their university'}
- Agent/Manager: ${agentName || 'Agent'} (${agentEmail || 'agent@email.com'})
- Brand/Company: ${brand}

DEAL TERMS:
- Deal Type: ${dealType || 'Social Media Endorsement'}
- Total Value: $${parseInt(value || 0).toLocaleString()}
- Deliverables: ${deliverables || '3 Instagram posts, 2 Instagram stories'}
- Start Date: ${startDate || 'TBD'}
- End Date: ${endDate || 'TBD'}
- Exclusivity: ${exclusivity || 'Non-exclusive'}
- Payment Terms: ${paymentTerms || '50% upfront, 50% on completion'}
- Usage Rights: ${usageRights || 'Social media and digital only'}
- Governing State: ${state || athlete.school || 'Georgia'}

Generate a complete, professional NIL contract with these sections:
1. PARTIES AND RECITALS
2. SCOPE OF SERVICES (specific deliverables, posting schedule, content requirements)
3. COMPENSATION (payment amount, schedule, method, late payment penalties)
4. TERM AND TERMINATION (start/end dates, early termination clause, 30-day notice)
5. EXCLUSIVITY AND COMPETING BRANDS
6. CONTENT APPROVAL PROCESS (brand approval timeline, revision rounds)
7. USAGE RIGHTS (platforms, duration, geographic scope)
8. ATHLETE OBLIGATIONS (FTC disclosure requirements, NCAA/school compliance)
9. BRAND OBLIGATIONS (payment timeline, content brief delivery)
10. REPRESENTATIONS AND WARRANTIES
11. INDEMNIFICATION
12. DISPUTE RESOLUTION (arbitration in ${state || 'Georgia'})
13. GOVERNING LAW
14. SIGNATURES (with date lines for both parties)

Use professional legal language. Include specific dollar amounts and dates. Add FTC disclosure language. Make it ready to sign.`;

  try {
    const contract = await ai.oneShot(prompt, 'You are a sports attorney specializing in NIL contracts. Generate complete, professional, legally sound NIL contracts ready for signature. Use precise legal language. Include all standard contract clauses.', 4000);
    if (!contract || contract.length < 100) throw new Error('Contract generation failed');
    res.json({ contract, athleteName: athlete.name, brand, value });
  } catch (err) {
    console.error('Contract error:', err.message);
    // Retry with shorter prompt
    try {
      const shortPrompt = 'Generate a professional NIL contract between ' + athlete.name + ' (' + athlete.sport + ' at ' + (athlete.school||'university') + ') and ' + brand + ' for $' + parseInt(value||0).toLocaleString() + '. Deal type: ' + (dealType||'Social Media') + '. Deliverables: ' + (deliverables||'3 Instagram posts') + '. Include: parties, scope, compensation, term, exclusivity, usage rights, FTC disclosure, and signature lines. Use professional legal language.';
      const contract = await ai.oneShot(shortPrompt, 'You are a sports attorney. Generate a complete NIL contract ready for signature.');
      res.json({ contract, athleteName: athlete.name, brand, value });
    } catch(err2) {
      res.status(503).json({ error: 'Contract generation temporarily unavailable. Please try again in 30 seconds.' });
    }
  }
});

// ── Contract PDF Download ─────────────────────────────────────
app.post('/api/ai/contract/pdf', requireAuth, async (req, res) => {
  const { contract, athleteName, brand } = req.body;
  if (!contract) return res.status(400).json({ error: 'No contract text provided' });

  const doc = new PDFDocument({ margin: 60, size: 'LETTER' });
  const filename = ((athleteName || 'athlete') + '-' + (brand || 'brand') + '-NIL-contract.pdf')
    .replace(/[^a-zA-Z0-9-_.]/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  doc.pipe(res);

  doc.fontSize(18).font('Helvetica-Bold').text('NIL REPRESENTATION AGREEMENT', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica').fillColor('#666666')
    .text('Generated by NILDash — For review purposes. Have a licensed attorney review before signing.', { align: 'center' });
  doc.moveDown(1);
  doc.moveTo(60, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(1);

  doc.fillColor('#000000').fontSize(10).font('Helvetica');
  const lines = contract.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { doc.moveDown(0.4); continue; }
    if (/^(\d+\.|[A-Z][A-Z\s]{4,}:?)$/.test(trimmed) || /^[A-Z\s]{6,}$/.test(trimmed)) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).text(trimmed).font('Helvetica').fontSize(10);
    } else {
      doc.text(trimmed, { align: 'justify' });
    }
  }

  doc.moveDown(2);
  doc.moveTo(60, doc.y).lineTo(550, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#999999').text('NILDash — NIL Intelligence Platform | mynildash.com', { align: 'center' });
  doc.end();
});

// ── Dashboard Follow-Ups ─────────────────────────────────────
app.get('/api/dashboard/followups', requireAuth, async (req, res) => {
  const agentId = req.session.userId;
  const followups = [];
  const now = new Date();

  try {
    // Deals stuck in an active stage for 7+ days
    const deals = await store.getDealsByAgent(agentId);
    const staleStages = ['Prospecting','Outreach','Negotiating','Sent'];
    for (const deal of deals) {
      const stage = deal.stage || deal.status || '';
      const updatedAt = deal.updatedAt || deal.createdAt || deal.created_at;
      if (staleStages.includes(stage) && updatedAt) {
        const daysSince = Math.floor((now - new Date(updatedAt)) / 86400000);
        if (daysSince >= 7) {
          followups.push({
            type: 'deal',
            label: `${deal.brand || 'Deal'} — ${stage}`,
            detail: `No update in ${daysSince} days`,
            urgency: daysSince >= 14 ? 'high' : 'medium',
          });
        }
      }
    }

    // Upcoming calendar events in next 7 days
    try {
      const upcoming = await store.pool.query(
        `SELECT * FROM calendar_events WHERE agent_id=$1 AND date >= $2 AND date <= $3 ORDER BY date ASC LIMIT 5`,
        [agentId, now.toISOString().slice(0,10), new Date(now.getTime() + 7*86400000).toISOString().slice(0,10)]
      );
      for (const ev of upcoming.rows) {
        const daysUntil = Math.floor((new Date(ev.date) - now) / 86400000);
        followups.push({
          type: 'calendar',
          label: ev.title,
          detail: daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`,
          urgency: daysUntil <= 1 ? 'high' : 'medium',
        });
      }
    } catch(e) {}

    // Athletes with no active deals
    const athletes = await store.getAthletesByAgent(agentId);
    const athleteIdsWithDeals = new Set(deals.filter(d => {
      const s = d.stage || d.status || '';
      return ['Prospecting','Outreach','Negotiating','Sent'].includes(s);
    }).map(d => d.athleteId));
    for (const ath of athletes) {
      if (!athleteIdsWithDeals.has(ath.id)) {
        followups.push({
          type: 'athlete',
          label: ath.name,
          detail: 'No active deals — consider outreach',
          urgency: 'low',
        });
      }
    }

    // Sort: high urgency first
    const order = { high: 0, medium: 1, low: 2 };
    followups.sort((a, b) => order[a.urgency] - order[b.urgency]);

    res.json({ followups: followups.slice(0, 6) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Catch-all → frontend ───────────────────────────────────────
// ── Calendar Events ───────────────────────────────────────────
app.get('/api/calendar/events', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query('SELECT * FROM calendar_events WHERE agent_id=$1 ORDER BY date ASC', [req.session.userId]);
    res.json({ events: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/calendar/events', requireAuth, async (req, res) => {
  const { title, date, notes, reminderDays } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'title and date required' });
  try {
    const r = await store.pool.query('INSERT INTO calendar_events (agent_id, title, date, notes, reminderdays) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.session.userId, title, date, notes||'', reminderDays !== '' && reminderDays !== undefined ? parseInt(reminderDays) : null]);
    res.json({ event: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/calendar/events/:id', requireAuth, async (req, res) => {
  try {
    await store.pool.query('DELETE FROM calendar_events WHERE id=$1 AND agent_id=$2', [req.params.id, req.session.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Password Reset ───────────────────────────────────────────
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await store.getUserByEmail(email);
    if (!user) return res.json({ ok: true }); // Don't reveal if email exists
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    await store.pool.query('INSERT INTO password_resets (email, token, expires_at) VALUES ($1,$2,$3)', [email, token, expires]);
    const resetUrl = (process.env.APP_URL || 'https://mynildash.com') + '/reset?token=' + token;
    await resend.emails.send({
      from: 'NILDash <noreply@mynildash.com>',
      to: email,
      subject: 'Reset your NILDash password',
      html: '<div style="font-family:monospace;max-width:500px;margin:0 auto;padding:40px">' +
        '<h2 style="color:#C8F135">NILDash</h2>' +
        '<p>You requested a password reset. Click the link below to set a new password:</p>' +
        '<a href="' + resetUrl + '" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#C8F135;color:#000;text-decoration:none;border-radius:40px;font-weight:700">Reset Password</a>' +
        '<p style="color:#666;font-size:12px">This link expires in 1 hour. If you did not request this, ignore this email.</p>' +
        '</div>'
    });
    res.json({ ok: true });
  } catch(e) { console.error('Reset error:', e.message); res.status(500).json({ error: 'Failed to send reset email' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  try {
    const r = await store.pool.query('SELECT * FROM password_resets WHERE token=$1 AND used=FALSE AND expires_at > NOW()', [token]);
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const { email } = r.rows[0];
    const hash = await bcrypt.hash(password, 10);
    const user = await store.getUserByEmail(email);
    if (!user) return res.status(400).json({ error: 'User not found' });
    await store.pool.query("UPDATE users SET data = jsonb_set(data, '{password}', $1) WHERE id=$2", [JSON.stringify(hash), user.id]);
    await store.pool.query('UPDATE password_resets SET used=TRUE WHERE token=$1', [token]);
    res.json({ ok: true });
  } catch(e) { console.error('Reset password error:', e.message); res.status(500).json({ error: 'Failed to reset password' }); }
});

// ── Request Access ───────────────────────────────────────────
app.post('/api/request-access', async (req, res) => {
  const { firstName, lastName, email, agency, athletes } = req.body;
  if (!firstName || !lastName || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    await store.pool.query('INSERT INTO access_requests (first_name, last_name, email, agency, athletes) VALUES ($1,$2,$3,$4,$5)', [firstName, lastName, email, agency||'', athletes||'']);
    console.log('ACCESS REQUEST:', firstName, lastName, email, agency, athletes);
    // Email notification to admin
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'noreply@mynildash.com',
        to: ADMIN_EMAIL,
        subject: 'New NILDash Access Request — ' + firstName + ' ' + lastName,
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
          '<h2 style="color:#15803d">New Access Request</h2>' +
          '<p><strong>Name:</strong> ' + firstName + ' ' + lastName + '</p>' +
          '<p><strong>Email:</strong> ' + email + '</p>' +
          '<p><strong>Agency:</strong> ' + (agency||'Not specified') + '</p>' +
          '<p><strong>Athletes:</strong> ' + (athletes||'Not specified') + '</p>' +
          '<br><a href="https://mynildash.com/admin" style="background:#15803d;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Approve in Admin Dashboard</a>' +
        '</div>'
      });
    } catch(emailErr) { console.error('Email notification failed:', emailErr.message); }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Deal Action Feedback ─────────────────────────────────────
app.post('/api/feedback/deal-action', requireAuth, async (req, res) => {
  try {
    const { brand, dealType, action, athleteId } = req.body;
    const athlete = athleteId ? await store.getAthlete(athleteId) : null;
    await store.pool.query(
      'INSERT INTO deal_scan_feedback (agent_id, athlete_id, brand, deal_type, action, sport, position, school_tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.session.userId, athleteId||'', brand||'', dealType||'', action||'',
       athlete?.sport||'', athlete?.position||'', athlete?.schoolTier||'']
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── Weekly Deal Comp Ingestion ───────────────────────────────
function scheduleWeeklyIngestion() {
  const now = new Date();
  const nextSunday = new Date(now);
  nextSunday.setDate(now.getDate() + (7 - now.getDay()) % 7 || 7);
  nextSunday.setHours(2, 0, 0, 0);
  const msUntil = nextSunday - now;
  console.log('Next NIL comp ingestion:', nextSunday.toISOString());
  setTimeout(async function runJob() {
    console.log('Running weekly NIL comp ingestion...');
    try {
      const { exec } = require('child_process');
      exec('node ' + require('path').join(__dirname, 'nilCompJob.js'), (err, stdout, stderr) => {
        if (err) console.error('Ingestion error:', err.message);
        else console.log('Ingestion complete:', stdout.slice(-200));
      });
    } catch(e) { console.error('Ingestion failed:', e.message); }
    setTimeout(runJob, 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
}
if (process.env.NODE_ENV === 'production') scheduleWeeklyIngestion();


// Dev endpoint: approve an email for testing (requires X-Dev-Secret header)
app.post('/api/dev/approve-email', async (req, res) => {
  const secret = req.headers['x-dev-secret'];
  if (secret !== process.env.DEV_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await store.pool.query(
      `INSERT INTO access_requests (first_name, last_name, email, agency, athletes, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'approved',NOW())
       ON CONFLICT (email) DO UPDATE SET status='approved'`,
      ['Dev', 'Test', email, 'DevAgency', 'n/a']
    );
    res.json({ ok: true, email });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Admin endpoint to trigger manually
app.post('/api/admin/run-ingestion', async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
    const { exec } = require('child_process');
    exec('node ' + require('path').join(__dirname, 'nilCompJob.js'), (err, stdout) => {
      if (err) console.error('Manual ingestion error:', err.message);
      else console.log('Manual ingestion done:', stdout.slice(-200));
    });
    res.json({ ok: true, message: 'Ingestion job started in background' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Plan management ──────────────────────────────────────────
app.post('/api/admin/set-plan', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    const user = await store.getUser(req.session.userId);
    if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
    let trialEndsAt = null;
    if (plan === 'trial') {
      trialEndsAt = new Date(Date.now() + 14 * 86400000).toISOString();
    }
    await store.pool.query('UPDATE users SET plan=$1, trial_ends_at=$2 WHERE id=$3', [plan, trialEndsAt, userId]);
    res.json({ ok: true, plan, trialEndsAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
    const r = await store.pool.query('SELECT id, name, email, plan, trial_ends_at, created_at FROM users ORDER BY created_at DESC');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin force delete ───────────────────────────────────────
app.delete('/api/admin/athlete/:id', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  try {
    await store.pool.query('DELETE FROM athletes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin cleanup ────────────────────────────────────────────
app.post('/api/admin/cleanup-duplicates', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await store.pool.query('SELECT id, data FROM athletes WHERE agent_id=$1 ORDER BY updated_at ASC', [req.session.userId]);
    const seen = {};
    const toDelete = [];
    for (const row of r.rows) {
      const name = (row.data.name || '').toLowerCase().trim();
      if (seen[name]) {
        toDelete.push(row.id);
      } else {
        seen[name] = true;
      }
    }
    for (const id of toDelete) {
      await store.pool.query('DELETE FROM athletes WHERE id=$1', [id]);
    }
    res.json({ deleted: toDelete.length, ids: toDelete });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Help AI ──────────────────────────────────────────────────
app.post('/api/ai/help', requireAuth, async (req, res) => {
  const { messages, system } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const response = await ai.oneShot(
      messages.map(m => m.role + ': ' + m.content).join('\n'),
      system || 'You are a helpful NILDash support assistant.'
    );
    res.json({ response });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Athlete Report ───────────────────────────────────────────
app.post('/api/reports/generate', requireAuth, async (req, res) => {
  const { athleteId, agentMessage } = req.body;
  if (!athleteId) return res.status(400).json({ error: 'athleteId required' });
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const agent = await store.getUser(req.session.userId);
  try {
    const token = require('crypto').randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    await store.pool.query('INSERT INTO athlete_reports (id, athlete_id, agent_id, agent_message, expires_at) VALUES ($1,$2,$3,$4,$5)', [token, athleteId, req.session.userId, agentMessage||'', expires]);
    res.json({ ok: true, token, url: (process.env.APP_URL || 'https://mynildash.com') + '/report/' + token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Athlete Portal ────────────────────────────────────────────

// Create invite token for an athlete
app.post('/api/athlete-portal/invite', requireAuth, async (req, res) => {
  const { athleteId, visibilitySettings } = req.body;
  if (!athleteId) return res.status(400).json({ error: 'athleteId required' });
  const user = await store.getUser(req.session.userId);
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const token = require('crypto').randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await store.pool.query(
    'INSERT INTO athlete_invites (id, athlete_id, agent_id, token, visibility, expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET token=$4, visibility=$5, expires_at=$6',
    ['invite-' + athleteId, athleteId, req.session.userId, token, JSON.stringify(visibilitySettings || { rate: true, deals: true, contracts: true, brands: false, compliance: true }), expires]
  );
  const inviteUrl = (process.env.APP_URL || 'https://mynildash.com') + '/athlete-signup?token=' + token;
  res.json({ ok: true, token, inviteUrl, athleteName: athlete.name });
});

// Get invite status for an athlete
app.get('/api/athlete-portal/invite/:athleteId', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query('SELECT * FROM athlete_invites WHERE athlete_id=$1', [req.params.athleteId]);
    if (!r.rows.length) return res.json({ invited: false });
    const invite = r.rows[0];
    const hasAccount = await store.pool.query('SELECT id FROM users WHERE athlete_id=$1', [req.params.athleteId]).catch(() => ({ rows: [] }));
    res.json({ invited: true, status: invite.status, visibility: invite.visibility, hasAccount: hasAccount.rows.length > 0, inviteUrl: (process.env.APP_URL || 'https://mynildash.com') + '/athlete-signup?token=' + invite.token });
  } catch(e) { res.json({ invited: false }); }
});

// Update visibility settings
app.patch('/api/athlete-portal/visibility/:athleteId', requireAuth, async (req, res) => {
  const { visibility } = req.body;
  await store.pool.query('UPDATE athlete_invites SET visibility=$1 WHERE athlete_id=$2 AND agent_id=$3', [JSON.stringify(visibility), req.params.athleteId, req.session.userId]);
  res.json({ ok: true });
});

// Accept invite and create athlete account
app.post('/api/athlete-portal/accept', async (req, res) => {
  const { token, name, email, password } = req.body;
  if (!token || !name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const r = await store.pool.query('SELECT * FROM athlete_invites WHERE token=$1 AND expires_at > NOW()', [token]);
  if (!r.rows.length) return res.status(400).json({ error: 'Invalid or expired invite link' });
  const invite = r.rows[0];
  if (await store.getUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const id = 'athlete-user-' + Date.now();
  const user = await store.saveUser(id, { id, name, email, password: hash, role: 'athlete', athleteId: invite.athlete_id, agentId: invite.agent_id, createdAt: new Date().toISOString() });
  await store.pool.query('UPDATE athlete_invites SET status=$1 WHERE token=$2', ['accepted', token]);
  req.session.userId = id;
  req.session.role = 'athlete';
  res.json({ ok: true, id, name, email, role: 'athlete', athleteId: invite.athlete_id });
});

// Validate invite token
app.get('/api/athlete-portal/validate/:token', async (req, res) => {
  try {
    const r = await store.pool.query("SELECT ai.*, a.data->>'name' as athlete_name, a.data->>'sport' as sport, a.data->>'school' as school FROM athlete_invites ai JOIN athletes a ON ai.athlete_id = a.id WHERE ai.token=$1 AND ai.expires_at > NOW()", [req.params.token]);
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid or expired invite' });
    res.json({ valid: true, athleteName: r.rows[0].athlete_name, sport: r.rows[0].sport, school: r.rows[0].school });
  } catch(e) { res.status(400).json({ error: 'Invalid invite' }); }
});

// Athlete dashboard data
app.get('/api/athlete-portal/dashboard', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (user.role !== 'athlete') return res.status(403).json({ error: 'Forbidden' });
  const athleteId = user.athleteId || user.athlete_id;
  const athlete = await store.getAthlete(athleteId);
  const deals = await store.getDealsByAthlete(athleteId).catch(() => []);
  const inviteR = await store.pool.query('SELECT visibility FROM athlete_invites WHERE athlete_id=$1', [athleteId]).catch(() => ({ rows: [] }));
  const visibility = inviteR.rows[0]?.visibility || { rate: true, deals: true, contracts: true, brands: false, compliance: true };
  const { nilViewVal } = require('./benchmarks');
  const rate = nilViewVal(athlete, 'ig-reel');
  res.json({ athlete, deals, visibility, rate });
});

app.get('/athlete-signup', (req, res) => {
  res.sendFile(require('path').join(__dirname, '..', 'public', 'athlete-signup.html'));
});

app.get('/report/:token', async (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'report.html'));
});

app.get('/api/reports/:token', async (req, res) => {
  try {
    const r = await store.pool.query('SELECT * FROM athlete_reports WHERE id=$1 AND expires_at > NOW()', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Report not found or expired' });
    const report = r.rows[0];
    const athlete = await store.getAthlete(report.athlete_id);
    const agent = await store.getUser(report.agent_id);
    const deals = await store.getDealsByAthlete(report.athlete_id);
    const { nilViewVal } = require('./benchmarks');
    const rate = nilViewVal(athlete, 'ig-reel');
    res.json({ athlete, agent: { name: agent?.name, email: agent?.email }, deals, rate, agentMessage: report.agent_message, createdAt: report.created_at, expiresAt: report.expires_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Quick rate endpoint ──────────────────────────────────────
app.get('/api/rate/:athleteId', requireAuth, async (req, res) => {
  try {
    const athlete = await store.getAthlete(req.params.athleteId);
    if (!athlete) return res.status(404).json({ error: 'Not found' });
    const { nilViewVal } = require('./benchmarks');
    const type = req.query.type || 'ig-reel';
    const rate = nilViewVal(athlete, type);
    res.json({
      low: rate.low, mid: rate.mid, high: rate.high,
      archetypeScore: rate.archetypeScore,
      marketabilityScore: rate.marketabilityScore,
      sponsorshipReadiness: rate.sponsorshipReadiness,
      audienceQuality: rate.audienceQuality,
      confidenceScore: rate.confidenceScore,
      floorApplied: rate.floorApplied,
      breakdown: rate.breakdown,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset page ──────────────────────────────────────────────
app.get('/reset', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reset.html'));
});

// ── Landing page ──────────────────────────────────────────────
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// ── Admin ────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/api/admin/requests', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await store.pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
    res.json({ requests: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/requests/:id/approve', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  await store.pool.query('UPDATE access_requests SET status=$1 WHERE id=$2', ['approved', req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/requests/:id/deny', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
  await store.pool.query('UPDATE access_requests SET status=$1 WHERE id=$2', ['denied', req.params.id]);
  res.json({ ok: true });
});


// ── Visual Demo Page ─────────────────────────────────────────────────────
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
});

// ── Pitch Deck (Shareable) ────────────────────────────────────────────────
app.get('/pitch/:athleteId', async (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pitch.html'));
});

app.get('/api/pitch-data/:athleteId', async (req, res) => {
  try {
    const athlete = await store.getAthlete(req.params.athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const { nilViewVal } = require('./benchmarks');
    const igReel = nilViewVal(athlete, 'ig-reel');
    const igPost = nilViewVal(athlete, 'ig-post');
    const tiktok = nilViewVal(athlete, 'tiktok');
    const story = nilViewVal(athlete, 'ig-story');
    const bundle = nilViewVal(athlete, 'bundle');
    const retainer = nilViewVal(athlete, 'retainer');
    // Return only non-sensitive fields
    res.json({
      name: athlete.name,
      sport: athlete.sport,
      school: athlete.school,
      position: athlete.position,
      year: athlete.year,
      instagram: athlete.instagram || 0,
      tiktok: athlete.tiktok || 0,
      engagement: athlete.engagement || 0,
      stats: athlete.stats || '',
      notes: athlete.notes || '',
      gpa: athlete.gpa || '',
      nilScores: {
        marketabilityScore: igReel.marketabilityScore,
        sponsorshipReadiness: igReel.sponsorshipReadiness,
        audienceQuality: igReel.audienceQuality,
        archetypeScore: igReel.archetypeScore,
        sponsorCategories: igReel.sponsorCategories || []
      },
      rates: {
        igReel:   { low: igReel.low,   mid: igReel.mid,   high: igReel.high },
        igPost:   { low: igPost.low,   mid: igPost.mid,   high: igPost.high },
        tiktok:   { low: tiktok.low,   mid: tiktok.mid,   high: tiktok.high },
        story:    { low: story.low,    mid: story.mid,    high: story.high },
        bundle:   { low: bundle.low,   mid: bundle.mid,   high: bundle.high },
        retainer: { low: retainer.low, mid: retainer.mid, high: retainer.high }
      }
    });
  } catch(err) {
    console.error('Pitch data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email Integration ─────────────────────────────────────────────────────────
// All email routes isolated in server/routes/email.js — no existing logic touched.
const emailRoutes = require('./routes/email');
// OAuth callbacks bypass session auth — identity is verified via the state param.
function emailAuthMiddleware(req, res, next) {
  const OAUTH_CALLBACKS = ['/oauth/gmail/callback', '/oauth/outlook/callback'];
  if (OAUTH_CALLBACKS.includes(req.path)) return next();
  return requireAuth(req, res, next);
}
app.use('/api/email', emailAuthMiddleware, emailRoutes);

// Start background email sync poller (fire-and-forget — never blocks startup)
try {
  const emailSync = require('./services/emailSync');
  emailSync.startPoller();
} catch (e) {
  console.warn('[email] Sync poller failed to start:', e.message);
}

// ── Outreach Automation Engine ────────────────────────────────────────────────
// Isolated route module — zero interference with existing routes above.
try {
  const outreachRoutes = require('./routes/outreach');
  app.use('/api/outreach', requireAuth, outreachRoutes);

  // Start follow-up automation poller (fire-and-forget)
  const followUpSvc = require('./services/followUpAutomation');
  followUpSvc.startPoller();

  console.log('[outreach] Outreach automation engine loaded');
} catch (e) {
  console.warn('[outreach] Engine failed to load:', e.message);
}

// ── University Mode Routes ────────────────────────────────────────────────────
// All routes gated by requireAuth + requireUniversityMode.
// Services enforced: ProgramAggregationService, ComplianceActivityService,
//                    ReadinessEngine, DataIntegrityLayer, BulkImportService,
//                    RosterSyncEngine, RosterSourceRegistry.
// Forbidden: NILViewVal, outreach_logs, brand_match_scores, brand_contacts,
//            company_enrichment, valuation, pricing.

const ProgramAggregationService  = require('./services/university/ProgramAggregationService');
const ComplianceActivityService   = require('./services/university/ComplianceActivityService');
const { computeReadiness, getDevelopmentRecommendations } = require('./services/university/ReadinessEngine');
const BulkImportService           = require('./services/university/BulkImportService');
const RosterSyncEngine            = require('./services/university/RosterSyncEngine');
const IngestionPipeline           = require('./services/university/IngestionPipeline');
const RosterAutomationScheduler   = require('./services/university/RosterAutomationScheduler');

// ── University context helper ─────────────────────────────────────────────
// Resolves the university_id for the current session user.
// University-role users have users.university_id set.
// Admin users may also have it set (e.g. admin linked to Samford for demo).
// Returns null if no university linked — caller should 400.
async function resolveSessionUniversity(userId) {
  try {
    const r = await store.pool.query(
      'SELECT university_id FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
    return r.rows[0]?.university_id || null;
  } catch (_) {
    return null;
  }
}

// ── Fetch athletes scoped to a university ──────────────────────────────────
// Reads from athletes table filtering by data->>'university_id'.
// This is the only correct read path for university-mode endpoints.
async function fetchUniversityAthletes(universityId) {
  const rows = await store.pool.query(
    `SELECT * FROM athletes
     WHERE data->>'university_id' = $1
     ORDER BY created_at DESC`,
    [universityId]
  );
  return rows.rows;
}

// GET /api/university/dashboard
// Full program overview — scoped to the user's university.
app.get('/api/university/dashboard', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId   = req.session.userId;
    const userRole = req.session.role;

    // Resolve university scope
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({
        error: 'Your account is not linked to a university. Contact your administrator.',
        code: 'NO_UNIVERSITY_LINKED',
      });
    }

    // Fetch athletes scoped to this university only
    const athletes = await fetchUniversityAthletes(universityId);

    // Fetch university record for display
    let university = null;
    try {
      const uRow = await store.pool.query('SELECT * FROM universities WHERE id = $1', [universityId]);
      university = uRow.rows[0] || null;
    } catch (_) {}

    // Activity counts from nil_activity_log (university-owned events only)
    // NOT from outreach_logs — that is agent-mode data
    let dealMap = {};
    try {
      const actRows = await store.pool.query(
        `SELECT athlete_id, COUNT(*) AS event_count
         FROM nil_activity_log WHERE user_id = $1 GROUP BY athlete_id`,
        [userId]
      );
      actRows.rows.forEach(r => { dealMap[r.athlete_id] = parseInt(r.event_count) || 0; });
    } catch (_) { /* nil_activity_log may not exist yet — migrations pending */ }

    // Build program overview via service layer
    const overview = await ProgramAggregationService.buildProgramOverview(athletes, dealMap, userRole);

    // Build per-athlete summaries with server-side readiness
    const athleteSummaries = athletes.map(a => {
      const d          = (a.data && typeof a.data === 'object') ? { ...a.data, id: a.id } : a;
      const dealsCount = dealMap[a.id] || 0;
      const readiness  = computeReadiness(a, dealsCount, userRole);
      return {
        id:           a.id,
        name:         d.name        || 'Unnamed Athlete',
        sport:        d.sport       || 'Unknown',
        position:     d.position    || '',
        school:       d.school      || '',
        instagram:    parseInt(d.instagram)    || 0,
        tiktok:       parseInt(d.tiktok)       || 0,
        engagement:   parseFloat(d.engagement) || 0,
        stats:        d.stats       || '',
        notes:        d.notes       || '',
        schoolTier:   d.schoolTier  || '',
        university_id: d.university_id || universityId,
        reach:        (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0),
        dealsCount,
        readiness,
        lastUpdatedAt: a.last_updated_at || null,
      };
    });

    // Attach sync status + roster state breakdown to dashboard response
    const syncStatus = await RosterSyncEngine.getSyncStatus(store.pool, universityId)
      .catch(() => null);

    // Roster state summary (from athlete_roster_states table)
    let rosterStateSummary = null;
    try {
      const stateRows = await store.pool.query(
        `SELECT status, COUNT(*) AS n
         FROM athlete_roster_states WHERE university_id = $1
         GROUP BY status`,
        [universityId]
      );
      rosterStateSummary = { active:0, probable:0, uncertain:0, inactive:0, unknown:0 };
      stateRows.rows.forEach(r => {
        const s = r.status;
        if (rosterStateSummary[s] !== undefined) rosterStateSummary[s] = parseInt(r.n);
      });
    } catch (_) {}

    res.json({
      university,
      universityId,
      athletes:          athleteSummaries,
      overview,
      syncStatus,
      rosterStateSummary,
      // Legacy flat fields preserved for backward compat with existing frontend
      sportBreakdown:    overview.sportBreakdown,
      totalAthletes:     overview.totalAthletes,
      avgEngagement:     overview.avgEngagementRate?.value ?? 0,
      programHealth:     overview.programHealth,
      dataReliability:   overview.dataReliability,
      generatedAt:       overview.generatedAt,
    });
  } catch (err) {
    console.error('[university] Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/athlete/:id/readiness
// Full readiness breakdown + development recommendations for one athlete.
// Verifies the athlete belongs to the user's university before serving.
app.get('/api/university/athlete/:id/readiness', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId   = req.session.userId;
    const userRole = req.session.role;

    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked to account', code: 'NO_UNIVERSITY_LINKED' });
    }

    // Fetch athlete — must belong to this university
    const athleteRow = await store.pool.query(
      `SELECT * FROM athletes WHERE id = $1 AND data->>'university_id' = $2 LIMIT 1`,
      [req.params.id, universityId]
    );
    if (!athleteRow.rows.length) {
      return res.status(404).json({ error: 'Athlete not found in your program' });
    }

    const athlete    = athleteRow.rows[0];
    let dealsCount   = 0;
    try {
      const ct = await store.pool.query(
        'SELECT COUNT(*) AS c FROM nil_activity_log WHERE athlete_id=$1 AND user_id=$2',
        [req.params.id, userId]
      );
      dealsCount = parseInt(ct.rows[0]?.c) || 0;
    } catch (_) {}

    const readiness = computeReadiness(athlete, dealsCount, userRole);
    const recs      = getDevelopmentRecommendations(athlete, readiness, userRole);

    // Log this readiness computation as a compliance event
    try {
      await ComplianceActivityService.logEvent(store.pool, {
        athleteId:    req.params.id,
        userId,
        eventType:    'readiness_computed',
        confidence:   readiness.overallConfidence,
        metadata:     { score: readiness.score, label: readiness.label },
      });
    } catch (_) {}

    res.json({ athleteId: req.params.id, readiness, recommendations: recs });
  } catch (err) {
    console.error('[university] Readiness error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/compliance
// Program-level compliance dashboard — scoped to user's university.
app.get('/api/university/compliance', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId   = req.session.userId;
    const userRole = req.session.role;

    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked to account', code: 'NO_UNIVERSITY_LINKED' });
    }

    const athletes = await fetchUniversityAthletes(universityId);

    const dashboard = await ComplianceActivityService.buildComplianceDashboard(
      store.pool,
      { athletes, userId },
      userRole
    );

    res.json(dashboard);
  } catch (err) {
    console.error('[university] Compliance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/bulk-import
// All data flows through the Ingestion Pipeline:
//   Parse CSV/JSON → ingestBatch (creates ingestion_events) →
//   processQueue (resolve + dedup + write athletes) → runSync (roster state)
//
// BulkImportService handles parse + validate only.
// IngestionPipeline handles write + dedup + entity resolution.
app.post('/api/university/bulk-import', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId   = req.session.userId;
    const userRole = req.session.role;

    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked to account', code: 'NO_UNIVERSITY_LINKED' });
    }

    const { format = 'csv', data: rawData } = req.body;
    if (!rawData || !rawData.trim()) {
      return res.status(400).json({ error: 'No data provided. Send { format, data } in request body.' });
    }
    if (!['csv', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }

    // ── Step 1: Parse raw input (validation + normalization from BulkImportService)
    // Use BulkImportService for parse+validate only — it still writes as fallback
    // for immediate UI feedback, then ingestion pipeline processes for dedup+sync.
    const parseResult = await BulkImportService.bulkImport(
      store.pool, rawData, format, userId, universityId, userRole
    );

    // ── Step 2: Route parsed records through the Ingestion Pipeline
    // Parse the raw data again for ingestion events (CSV/JSON → raw objects)
    let rawRecords = [];
    try {
      if (format === 'json') {
        rawRecords = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        if (!Array.isArray(rawRecords)) rawRecords = [];
      } else {
        // Re-use the internal CSV parser via a lightweight re-parse
        const lines   = rawData.replace(/^﻿/, '').trim().split(/\r?\n/).filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
        rawRecords = lines.slice(1).map(line => {
          const vals = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
          const obj  = {};
          headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
          return obj;
        });
      }
    } catch (_) {}

    // Create ingestion events for audit trail + entity resolution tracking
    let ingestionResult = { queued: 0, duplicates: 0, failed: 0 };
    if (rawRecords.length > 0) {
      ingestionResult = await IngestionPipeline.ingestBatch(store.pool, {
        records:      rawRecords,
        sourceType:   'bulk_import',
        sourceId:     'src-import',
        universityId,
        userId,
      }).catch(e => ({ queued: 0, error: e.message }));
    }

    console.log(`[university] Bulk import: ${parseResult.imported} written, ${ingestionResult.queued} events queued`);

    // ── Step 3: Trigger roster sync
    let syncResult = null;
    if (parseResult.imported > 0) {
      syncResult = await RosterSyncEngine.runSync(store.pool, {
        universityId,
        triggeredBy: 'import',
        userId,
      }).catch(e => ({ ok: false, error: e.message }));
    }

    res.json({
      ...parseResult,
      ingestionEvents: ingestionResult,
      syncResult,
      pipeline: 'ingestion_pipeline_v2',
    });
  } catch (err) {
    console.error('[university] Bulk import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/import-template
// Download CSV template with correct headers and one example row.
app.get('/api/university/import-template', requireAuth, requireUniversityMode, (req, res) => {
  const csv = BulkImportService.generateCSVTemplate();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="nildash-athlete-import-template.csv"');
  res.send(csv);
});

// ── Roster Sync Engine routes ─────────────────────────────────────────────

// POST /api/university/sync/trigger
// Manually trigger a full roster reconciliation.
app.post('/api/university/sync/trigger', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });
    }

    const { sport } = req.body; // optional sport filter
    const result = await RosterSyncEngine.runSync(store.pool, {
      universityId,
      sport: sport || null,
      triggeredBy: 'manual',
      userId,
    });

    res.json(result);
  } catch (err) {
    console.error('[university] Sync trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/sync/status
// Current sync health: last run, freshness score, snapshot summary.
app.get('/api/university/sync/status', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });
    }

    const status = await RosterSyncEngine.getSyncStatus(store.pool, universityId);
    res.json({ universityId, ...status });
  } catch (err) {
    console.error('[university] Sync status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/roster/snapshots
// Version history — list of snapshots for rollback/audit.
app.get('/api/university/roster/snapshots', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });
    }

    const limit     = Math.min(parseInt(req.query.limit) || 10, 50);
    const snapshots = await RosterSyncEngine.listSnapshots(store.pool, universityId, limit);
    res.json({ universityId, snapshots });
  } catch (err) {
    console.error('[university] Snapshots error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/rollback
// Restore roster to a previous snapshot state.
// Creates a new snapshot (never deletes history).
app.post('/api/university/roster/rollback', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });
    }

    const { snapshotId } = req.body;
    if (!snapshotId) {
      return res.status(400).json({ error: 'snapshotId is required' });
    }

    const result = await RosterSyncEngine.rollback(store.pool, {
      universityId,
      snapshotId,
      userId,
    });

    res.json(result);
  } catch (err) {
    console.error('[university] Rollback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/roster/state
// Current reconciled state for all athletes in the program.
// Includes status (active/probable/uncertain/inactive/unknown) + confidence scores.
app.get('/api/university/roster/state', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });
    }

    // Join athlete data with roster state
    const rows = await store.pool.query(
      `SELECT a.id, a.data, a.created_at, a.updated_at,
              ars.status, ars.confidence_score, ars.lifecycle_stage,
              ars.supporting_sources, ars.conflicting_sources,
              ars.last_reconciled_at
       FROM athletes a
       LEFT JOIN athlete_roster_states ars ON ars.athlete_id = a.id
       WHERE a.data->>'university_id' = $1
       ORDER BY a.created_at ASC`,
      [universityId]
    );

    const athletes = rows.rows.map(r => {
      const d = (r.data && typeof r.data === 'object') ? r.data : {};
      return {
        id:                r.id,
        name:              d.name        || 'Unknown',
        sport:             d.sport       || '',
        position:          d.position    || '',
        school:            d.school      || '',
        instagram:         parseInt(d.instagram)    || 0,
        tiktok:            parseInt(d.tiktok)       || 0,
        engagement:        parseFloat(d.engagement) || 0,
        status:            r.status            || 'unknown',
        confidenceScore:   r.confidence_score  || 0,
        lifecycleStage:    r.lifecycle_stage   || 'unknown',
        supportingSources: r.supporting_sources || [],
        conflictingSources: r.conflicting_sources || [],
        lastReconciledAt:  r.last_reconciled_at || null,
        hasConflict:       (r.conflicting_sources || []).length > 0,
      };
    });

    // State summary
    const summary = { active:0, probable:0, uncertain:0, inactive:0, unknown:0 };
    athletes.forEach(a => {
      if (summary[a.status] !== undefined) summary[a.status]++;
      else summary.unknown++;
    });

    const syncStatus = await RosterSyncEngine.getSyncStatus(store.pool, universityId);

    res.json({
      universityId,
      athletes,
      summary,
      syncStatus,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[university] Roster state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Ingestion Pipeline routes ─────────────────────────────────────────────

// POST /api/university/ingestion/ingest
// Manually submit a single athlete record through the ingestion pipeline.
// Creates an ingestion event — does NOT write to athletes table directly.
app.post('/api/university/ingestion/ingest', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const { payload, sourceType = 'manual' } = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload object required' });
    }

    const event = await IngestionPipeline.ingest(store.pool, {
      sourceType,
      sourceId:    sourceType === 'manual' ? 'src-manual' : 'src-import',
      rawPayload:  payload,
      universityId,
      userId,
    });

    res.json(event);
  } catch (err) {
    console.error('[university] Ingest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/ingestion/process
// Process the pending ingestion queue for this university.
// Resolves events → writes athletes → triggers sync.
app.post('/api/university/ingestion/process', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const result = await IngestionPipeline.processQueue(store.pool, {
      universityId,
      agentId: userId,
      limit:   parseInt(req.body?.limit) || 100,
    });

    // Auto-sync after processing
    if (result.committed > 0) {
      RosterSyncEngine.runSync(store.pool, {
        universityId,
        triggeredBy: 'import',
        userId,
      }).catch(e => console.warn('[university] Post-process sync failed:', e.message));
    }

    res.json(result);
  } catch (err) {
    console.error('[university] Ingestion process error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/ingestion/events
// Recent ingestion events with resolution decisions. Full audit trail.
app.get('/api/university/ingestion/events', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const events = await IngestionPipeline.getRecentEvents(store.pool, universityId, limit);
    const status = await IngestionPipeline.getQueueStatus(store.pool, universityId);

    res.json({ universityId, events, queueStatus: status });
  } catch (err) {
    console.error('[university] Ingestion events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/ingestion/queue
// Current queue status (counts by status).
app.get('/api/university/ingestion/queue', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const status = await IngestionPipeline.getQueueStatus(store.pool, universityId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Automation Scheduler routes ───────────────────────────────────────────

// GET /api/university/scheduler/status
// Full scheduler health: tick history, per-university sync times, isRunning flag.
app.get('/api/university/scheduler/status', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const status = await RosterAutomationScheduler.getStatus(store.pool);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/scheduler/trigger
// Force an immediate deep sync + queue processing for this university.
app.post('/api/university/scheduler/trigger', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const result = await RosterAutomationScheduler.forceTrigger(store.pool, { universityId, userId });
    res.json(result);
  } catch (err) {
    console.error('[university] Scheduler trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PWA static assets — explicit routes so catchall doesn't eat them ──
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, '..', 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});

app.use('/icons', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
}, require('express').static(path.join(__dirname, '..', 'public', 'icons')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, async () => {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('YOUR_KEY'));
  console.log(`
╔════════════════════════════════════╗
║   NILDash  v1.0.0                  ║
╠════════════════════════════════════╣
║  URL:    http://localhost:${PORT}      ║
║  AI Key: ${hasKey ? '✅ Ready' : '⚠️  Add to .env'}              ║
╚════════════════════════════════════╝`);

  // ── Auto-run idempotent migrations on startup ────────────────────
  // All SQL statements are IF NOT EXISTS — safe to run every boot.
  // Failure is logged but never crashes the server.
  try {
    const fs   = require('fs');
    const path = require('path');
    const migDir = path.join(__dirname, 'migrations');
    const files  = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
      await store.pool.query(sql);
      console.log(`[migrations] ✅ ${file}`);
    }
  } catch (err) {
    console.warn('[migrations] Migration run failed (non-fatal):', err.message);
  }

  // ── Start Roster Automation Scheduler ────────────────────────────
  // Runs inside this process — resilient across restarts via DB timestamps.
  // Light sync every 6h, deep sync every 24h, tick every 30min.
  try {
    RosterAutomationScheduler.start(store.pool);
    console.log('[scheduler] ✅ Roster Automation Scheduler started');
  } catch (err) {
    console.warn('[scheduler] Scheduler start failed (non-fatal):', err.message);
  }
});
