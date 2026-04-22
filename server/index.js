// server/index.js
require('dotenv').config();

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

const app  = express();
const PORT = process.env.PORT || 3000;

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

// AI tools: 30 requests per minute per user
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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
  cookie: { secure: process.env.NODE_ENV !== 'development', httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 },
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
  if (role !== 'agent')
    return res.status(400).json({ error: 'NILDash is for sports agents only' });
  if (await store.getUserByEmail(email))
    return res.status(400).json({ error: 'Email already registered' });
  // Check if email is approved
  try {
    await store.pool.query('CREATE TABLE IF NOT EXISTS access_requests (id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, agency TEXT, athletes TEXT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW())');
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
  const user = await store.getUserByEmail(email);
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
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
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
  if (athlete.agent_id !== req.session.userId && user.email !== 'johnmarkcompton@gmail.com') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await store.deleteAthlete(req.params.id);
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
  // Auto-save to deal comps when a deal is closed with a real value
  if (req.body.status === 'closed' && existing.status !== 'closed' && parseInt(req.body.value || existing.value) > 0) {
    const athlete = await store.getAthlete(existing.athleteId);
    if (athlete) {
      await store.saveComp({ ...existing, ...req.body }, athlete);
      console.log('Deal comp saved:', athlete.sport, athlete.schoolTier, req.body.value || existing.value);
    }
  }
  res.json(await store.saveDeal(req.params.id, { ...existing, ...req.body }));
});

app.delete('/api/deals/:id', requireAuth, async (req, res) => {
  const deal = await store.getDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Not found' });
  if (deal.agent_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
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
    const recommendations = await ai.getDealRecommendations(athlete, user.role);
    res.json({ recommendations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/rate', requireAuth, aiLimiter, async (req, res) => {
  const athlete = await store.getAthlete(req.body.athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const deliverableType = req.body.deliverableType || 'ig-reel';
  // Use static calculation only — live rate was causing 502s
  res.json({ ...ai.calculateRate(athlete, deliverableType), liveData: false });
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
    const playbook = await ai.oneShotWithSearch(prompt, 'You are an elite sports agent negotiation coach. Search for recent NIL deal rates and brand spending data to inform your negotiation strategy. Return practical word-for-word scripts.');
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
  const prompt = 'You are a sports agent writing cold outreach to ' + brand + ' for athlete ' + athlete.name + '.' +
    ' Athlete: ' + athlete.sport + ', ' + (athlete.position||'') + ', ' + (athlete.school||'') +
    ', ' + (athlete.instagram||0).toLocaleString() + ' Instagram, ' + (athlete.tiktok||0).toLocaleString() + ' TikTok, ' + (athlete.engagement||0) + '% engagement.' +
    ' Stats: ' + (athlete.stats||'not provided') + '.' +
    (contact ? ' Contact: ' + contact + '.' : '') +
    (goal ? ' Deal goal: $' + parseInt(goal).toLocaleString() + '.' : '') +
    ' Category: ' + (category||'general') + '.' +
    ' Return ONLY JSON: {"emailSubject":"subject","email":"full email","instagram":"DM under 150 chars","linkedin":"message under 200 chars"}' +
    ' Be specific to this athlete. Confident, not salesy. No placeholders.';
  try {
    const raw = await ai.oneShotWithSearch(prompt, "You are a sports agent writing brand outreach. Search for this brand's recent NIL activity and marketing campaigns to personalize the outreach. Return only valid JSON.");
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
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
    const result = await ai.oneShotWithSearch(prompt, 'You are a NIL compliance expert. Search for current 2026 NIL laws for this state before answering. Laws change frequently — always use the most current information. Return only valid JSON.');
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
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    const pageText = await new Promise((resolve, reject) => {
      client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    // Detect blocked HTML response
    if (pageText.trim().startsWith('<!') || pageText.includes('Access Denied') || pageText.includes('403 Forbidden')) {
      return res.status(422).json({ error: 'This site blocks automated access. Use the AI Lookup button instead.' });
    }
    // Strip HTML tags and limit length
    const text = pageText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 8000);
    const prompt = 'Extract college athlete info from this page text and return as JSON. Page: ' + text + '. Return this JSON: {"found":true,"name":"full name","school":"school","sport":"sport","position":"position","year":"year","stats":"key stats","height":"height","weight":"weight","hometown":"city state","notes":"bio and achievements"}. Return ONLY JSON.';
    const raw = await ai.oneShot(prompt, 'You extract structured athlete data from web pages. Return only valid JSON.');
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
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
  const prompt = 'Look up college athlete: ' + name + (school ? ' at ' + school : '') + (sport ? ' (' + sport + ')' : '') + '. Search ESPN, 247Sports, On3, and school athletic websites for their current 2025-26 stats. Also search for their Instagram and TikTok accounts. Return this JSON - use real verified data where available, and your training knowledge as fallback for anything you cannot find via search. Always return found:true. {"found":true,"name":"full name","school":"school name","sport":"sport","position":"position abbrev","year":"Freshman or Sophomore or Junior or Senior or Grad Transfer","stats":"current season stats if found, or career highlights","height":"height","weight":"weight","hometown":"city state","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-top10 or p4-mid or p4-lower or mid-top or mid-lower or highmajor-top","notes":"bio, awards, rankings"}. Return ONLY JSON no markdown.';
  try {
    const raw = await ai.oneShotWithSearch(prompt, 'You are a college sports database with web search. Search for the athlete first, then use your training knowledge as backup. Always return found:true with best available data. Return only valid JSON.');
    const cleaned = raw.replace(/`/g, '').replace(/json/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ found: false });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Lookup error:', err.message);
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
  const sport = (athlete.sport || 'football').toLowerCase();
  const position = (athlete.position || '').toLowerCase();

  // ROSTER VALUE model — what a collective pays an athlete to be on the team
  // Based on real 2025-26 portal market data (On3, NIL Network, Sports Illustrated)
  function athleteNil(collectiveBudget, athlete) {
    const b = collectiveBudget || 3000000;
    const ppg = parseFloat(athlete.ppg) || 0;
    const rpg = parseFloat(athlete.rpg) || 0;
    const apg = parseFloat(athlete.apg) || 0;
    const fgPct = parseFloat(athlete.fgPct) || 0;
    const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
    const draftStatus = (athlete.draftStatus || '').toLowerCase();
    const year = (athlete.year || '').toLowerCase();

    // Base roster value ranges by collective budget tier
    let baseLow, baseHigh;
    if (b >= 10000000)     { baseLow = 500000;  baseHigh = 5000000; }
    else if (b >= 7000000) { baseLow = 300000;  baseHigh = 3000000; }
    else if (b >= 5000000) { baseLow = 150000;  baseHigh = 1500000; }
    else if (b >= 3000000) { baseLow = 75000;   baseHigh = 700000;  }
    else if (b >= 1500000) { baseLow = 30000;   baseHigh = 300000;  }
    else                   { baseLow = 10000;   baseHigh = 100000;  }

    // Performance multiplier based on stats
    let perfMult = 0.5; // default — no stats entered
    if (ppg > 0 || rpg > 0) {
      perfMult = 0.3;
      if (sport.includes('basketball')) {
        // Elite: 20+ PPG or 10+ RPG or 5+ APG
        if (ppg >= 20 || (ppg >= 15 && rpg >= 8) || apg >= 5) perfMult = 1.0;
        else if (ppg >= 15 || rpg >= 8 || apg >= 3) perfMult = 0.75;
        else if (ppg >= 10 || rpg >= 6) perfMult = 0.55;
        else perfMult = 0.35;
        // Draft premium
        if (draftStatus.includes('lottery') || draftStatus.includes('first')) perfMult *= 2.5;
        else if (draftStatus.includes('second')) perfMult *= 1.5;
        else if (draftStatus.includes('declared')) perfMult *= 2.0;
      } else if (sport.includes('football')) {
        const isQB = position.includes('qb');
        const isSkill = position.includes('wr') || position.includes('rb') || position.includes('edge') || position.includes('cb');
        if (isQB) perfMult = ppg >= 30 ? 1.0 : ppg >= 20 ? 0.75 : 0.55;
        else if (isSkill) perfMult = ppg >= 15 ? 0.85 : ppg >= 8 ? 0.65 : 0.45;
        else perfMult = 0.40;
        if (draftStatus.includes('first') || draftStatus.includes('lottery')) perfMult *= 2.0;
        else if (draftStatus.includes('second')) perfMult *= 1.4;
      }
    }

    // Social media adds brand value on top of roster value
    const socialBonus = reach >= 500000 ? 1.3 : reach >= 100000 ? 1.15 : reach >= 25000 ? 1.05 : 1.0;

    const finalLow = Math.round(baseLow * perfMult * socialBonus);
    const finalHigh = Math.round(baseHigh * perfMult * socialBonus);
    return [finalLow, finalHigh];
  }

  // NIL trajectory — project value over remaining eligibility
  function nilTrajectory(athlete, currentLow, currentHigh) {
    const year = (athlete.year || '').toLowerCase();
    const draftStatus = (athlete.draftStatus || '').toLowerCase();
    if (draftStatus.includes('declared')) return { trend: 'Declared for draft', multiplier: 1.0, note: 'Pro transition imminent' };
    if (year.includes('freshman') || year.includes('fr')) return { trend: 'High growth potential', multiplier: 1.8, note: '3+ years of eligibility to build NIL value' };
    if (year.includes('sophomore') || year.includes('so')) return { trend: 'Growth phase', multiplier: 1.5, note: '2+ years remaining — value will increase with production' };
    if (year.includes('junior') || year.includes('jr')) return { trend: 'Peak NIL window', multiplier: 1.2, note: '1-2 years remaining — maximize deals now' };
    if (year.includes('senior') || year.includes('sr')) return { trend: 'Final year — act fast', multiplier: 1.0, note: 'Last eligibility year — prioritize multi-year deal structures' };
    return { trend: 'Stable', multiplier: 1.1, note: 'Build brand consistency to maximize value' };
  }

  // Transfer portal comps from deal comps database
  const { DEAL_COMPS } = require('./benchmarks');
  const athleteRate = nilViewVal(athlete, 'ig-reel');
  const similarComps = (DEAL_COMPS || []).filter(c => {
    return c.sport === sport &&
      Math.abs((c.followers || 0) - ((athlete.instagram || 0) + (athlete.tiktok || 0))) < 50000;
  }).slice(0, 3);

  const compContext = similarComps.length ?
    'Portal comps for similar athletes: ' + similarComps.map(c =>
      c.sport + ' at ' + c.school + ' (' + c.followers + ' followers, ' + c.engagement + '% ER): $' + c.value.toLocaleString() + ' for ' + c.dealType
    ).join('; ') :
    'Limited direct comps available — using model estimates';

  const trajectory = nilTrajectory(athlete, athleteRate.low, athleteRate.high);

  const filtered = COLLECTIVES.filter(c => {
    if (conf && c.conf !== conf) return false;
    if (minNil > 0) {
      const sportBudget = getSportBudget(c, sport);
      const range = athleteNil(sportBudget.high, athlete);
      if (range[1] < minNil) return false;
    }
    return true;
  });

  const context = filtered.slice(0, 25).map(c => {
    const sportBudget = getSportBudget(c, sport);
    const range = athleteNil(sportBudget.low, athlete);
    const rangeHigh = athleteNil(sportBudget.high, athlete);
    return c.abbr + ' (' + c.conf + '): ' + sport + ' collective budget ~$' + Math.round(sportBudget.low/1000) + 'K-$' + Math.round(sportBudget.high/1000) + 'K, roster value for this athlete ~$' + Math.round(range[0]/1000) + 'K-$' + Math.round(rangeHigh[1]/1000) + 'K, ' + c.strength + ' collective, ' + c.proExposure + ' pro exposure, ' + c.market + ' market';
  }).join('\n');

  const prompt = 'Find 6 best transfer destinations for ' + athlete.name + ', ' + sport + ' ' + position + ', from ' + (athlete.school||'unknown') + '.\n' +
    'Stats: PPG=' + (athlete.ppg||'N/A') + ' RPG=' + (athlete.rpg||'N/A') + ' APG=' + (athlete.apg||'N/A') + ' FG%=' + (athlete.fgPct||'N/A') + ' BPG=' + (athlete.bpg||'N/A') + '\n' +
    'Social: ' + ((athlete.instagram||0)+(athlete.tiktok||0)).toLocaleString() + ' total reach, ' + (athlete.engagement||0) + '% ER\n' +
    'Year: ' + (athlete.year||'unknown') + ' | Draft status: ' + (athlete.draftStatus||'not declared') + '\n' +
    'Transfer reason: ' + (athlete.transferReason||'not specified') + '\n' +
    'NIL Trajectory: ' + trajectory.trend + ' — ' + trajectory.note + '\n' +
    'Archetype score: ' + (athleteRate.archetypeScore || 'N/A') + '/99\n\n' +
    'TRANSFER PORTAL COMPS:\n' + compContext + '\n\n' +
    'REAL COLLECTIVE DATA (what this athlete earns per program):\n' + context + '\n\n' +
    'For each school return:\n' +
    '- nilLow/nilHigh: athlete earnings (not total budget)\n' +
    '- rosterNeed: specific depth chart need at ' + position + ' (e.g. "Lost starter to draft, need immediate replacement")\n' +
    '- collectiveDealHistory: what this collective has paid for similar ' + position + ' archetypes recently\n' +
    '- trajectoryNote: how this program accelerates or limits the athlete NIL trajectory\n' +
    '- portalComp: name one real portal player who took a similar path to this school\n\n' +
    'Rank by: ' + (sortBy||'fit') + '\n' +
    'Return ONLY JSON array of 6:\n' +
    '[{"rank":1,"name":"Full School Name","conference":"SEC","confLabel":"SEC","tier":"reach|best-fit|safe","why":"2 sentences specific to this athlete stats and situation","nilLow":80000,"nilHigh":250000,"nilBreakdown":[{"label":"Collective pay","val":"$80K-250K"}],"fitScore":88,"playingTimeOutlook":"Projected starter","rosterNeed":"Lost starter EDGE to NFL draft — immediate need","collectiveDealHistory":"Paid $120K-200K for similar EDGE prospects in 2025 portal","trajectoryNote":"SEC exposure accelerates NIL value 40% by senior year","portalComp":"Similar to [Player Name] who signed for $150K in 2025 portal","metrics":[{"label":"Collective","val":"Elite"},{"label":"Market","val":"Major"},{"label":"Playing time","val":"High"}]}]';

  let teams = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.oneShot(prompt, 'You are an expert NIL agent and transfer portal analyst. Return ONLY valid JSON array. No markdown.');
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
  res.json({ teams, liveData: true, trajectory, archetypeScore: athleteRate.archetypeScore });
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
    if (/^(d+.|[A-Z][A-Zs]{4,}:?)$/.test(trimmed) || /^[A-Zs]{6,}$/.test(trimmed)) {
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

// ── Catch-all → frontend ───────────────────────────────────────
// ── Calendar Events ───────────────────────────────────────────
app.get('/api/calendar/events', requireAuth, async (req, res) => {
  try {
    await store.pool.query('CREATE TABLE IF NOT EXISTS calendar_events (id SERIAL PRIMARY KEY, agent_id TEXT, title TEXT, date TEXT, notes TEXT, reminderdays INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())');
    const r = await store.pool.query('SELECT * FROM calendar_events WHERE agent_id=$1 ORDER BY date ASC', [req.session.userId]);
    res.json({ events: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/calendar/events', requireAuth, async (req, res) => {
  const { title, date, notes, reminderDays } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'title and date required' });
  try {
    await store.pool.query('CREATE TABLE IF NOT EXISTS calendar_events (id SERIAL PRIMARY KEY, agent_id TEXT, title TEXT, date TEXT, notes TEXT, reminderdays INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())');
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
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await store.getUserByEmail(email);
    if (!user) return res.json({ ok: true }); // Don't reveal if email exists
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    await store.pool.query('CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email TEXT, token TEXT, expires_at TIMESTAMPTZ, used BOOLEAN DEFAULT FALSE)');
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
    await store.pool.query('CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, email TEXT, token TEXT, expires_at TIMESTAMPTZ, used BOOLEAN DEFAULT FALSE)');
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
    await store.pool.query(`CREATE TABLE IF NOT EXISTS access_requests (id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, agency TEXT, athletes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await store.pool.query('INSERT INTO access_requests (first_name, last_name, email, agency, athletes) VALUES ($1,$2,$3,$4,$5)', [firstName, lastName, email, agency||'', athletes||'']);
    console.log('ACCESS REQUEST:', firstName, lastName, email, agency, athletes);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin force delete ───────────────────────────────────────
app.delete('/api/admin/athlete/:id', async (req, res) => {
  try {
    await store.pool.query('DELETE FROM athletes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin cleanup ────────────────────────────────────────────
app.post('/api/admin/cleanup-duplicates', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== 'johnmarkcompton@gmail.com') return res.status(403).json({ error: 'Forbidden' });
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
    await store.pool.query('CREATE TABLE IF NOT EXISTS athlete_reports (id TEXT PRIMARY KEY, athlete_id TEXT, agent_id TEXT, agent_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ)');
    const token = require('crypto').randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    await store.pool.query('INSERT INTO athlete_reports (id, athlete_id, agent_id, agent_message, expires_at) VALUES ($1,$2,$3,$4,$5)', [token, athleteId, req.session.userId, agentMessage||'', expires]);
    res.json({ ok: true, token, url: (process.env.APP_URL || 'https://mynildash.com') + '/report/' + token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/report/:token', async (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'report.html'));
});

app.get('/api/reports/:token', async (req, res) => {
  try {
    await store.pool.query('CREATE TABLE IF NOT EXISTS athlete_reports (id TEXT PRIMARY KEY, athlete_id TEXT, agent_id TEXT, agent_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ)');
    const r = await store.pool.query('SELECT * FROM athlete_reports WHERE id=$1 AND expires_at > NOW()', [req.params.token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Report not found or expired' });
    const report = r.rows[0];
    const athlete = await store.getAthlete(report.athlete_id);
    const agent = await store.getUser(report.agent_id);
    const deals = await store.getDealsByAthlete(report.athlete_id);
    const { calculateRate } = require('./ai');
    const rate = calculateRate(athlete, 'ig-reel');
    res.json({ athlete, agent: { name: agent?.name, email: agent?.email }, deals, rate, agentMessage: report.agent_message, createdAt: report.created_at, expiresAt: report.expires_at });
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
app.get('/admin', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== 'johnmarkcompton@gmail.com') return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/api/admin/requests', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== 'johnmarkcompton@gmail.com') return res.status(403).json({ error: 'Forbidden' });
  try {
    await store.pool.query(`CREATE TABLE IF NOT EXISTS access_requests (id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, agency TEXT, athletes TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW())`);
    const r = await store.pool.query('SELECT * FROM access_requests ORDER BY created_at DESC');
    res.json({ requests: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/requests/:id/approve', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== 'johnmarkcompton@gmail.com') return res.status(403).json({ error: 'Forbidden' });
  await store.pool.query('UPDATE access_requests SET status=$1 WHERE id=$2', ['approved', req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/requests/:id/deny', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || user.email !== 'johnmarkcompton@gmail.com') return res.status(403).json({ error: 'Forbidden' });
  await store.pool.query('UPDATE access_requests SET status=$1 WHERE id=$2', ['denied', req.params.id]);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('YOUR_KEY'));
  console.log(`
╔════════════════════════════════════╗
║   NILDash  v1.0.0                  ║
╠════════════════════════════════════╣
║  URL:    http://localhost:${PORT}      ║
║  AI Key: ${hasKey ? '✅ Ready' : '⚠️  Add to .env'}              ║
╚════════════════════════════════════╝`);
});
