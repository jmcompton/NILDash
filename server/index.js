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
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
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
  if (athlete.agent_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
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
  try {
    const liveRate = await ai.calculateRateLive(athlete, deliverableType);
    if (liveRate && liveRate.mid) {
      return res.json({ ...liveRate, liveData: true });
    }
  } catch (err) {
    console.error('Live rate failed:', err.message);
  }
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
  const { athleteId, conference, minNil, sortBy } = req.body;
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  const conf = conference && conference !== 'any' ? conference : 'major';
  const prompt = `Find 6 best transfer destinations for ${athlete.name}, ${athlete.sport} ${athlete.position||''}, ${athlete.year||''}, from ${athlete.school||'unknown'}, stats: ${(athlete.stats||athlete.notes||'N/A').substring(0,80)}, portal: ${athlete.transferReason||'unknown'}, conf: ${conf}, min NIL: $${(minNil||0).toLocaleString()}. Search for 2026 NIL collective budgets. Return ONLY JSON array: [{"rank":1,"name":"School","conference":"ACC","confLabel":"ACC","tier":"reach or best-fit or safe","why":"2 sentences","nilLow":150000,"nilHigh":300000,"nilBreakdown":[{"label":"Collective","val":"$150K"}],"fitScore":88,"playingTimeOutlook":"Starter","rosterNeed":"need","metrics":[{"label":"Collective strength","val":"Strong"},{"label":"Market","val":"Major metro"},{"label":"Playing time","val":"High"}]}]`;

  let teams = null;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.oneShotWithSearch(prompt, 'Return ONLY a valid JSON array starting with [ and ending with ]. No markdown, no preamble. Just the JSON array.');
      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const si = cleaned.indexOf('[');
      const ei = cleaned.lastIndexOf(']');
      if (si === -1 || ei <= si) throw new Error('No JSON array found');
      const parsed = JSON.parse(cleaned.substring(si, ei + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');
      teams = parsed;
      break;
    } catch (err) {
      lastError = err.message;
    }
  }
  if (!teams) return res.status(200).json({ teams: [], error: 'Try again — AI returned unexpected format.', raw: lastError });
  res.json({ teams, liveData: true });
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
    const contract = await ai.oneShot(prompt, 'You are a sports attorney specializing in NIL contracts. Generate complete, professional, legally sound NIL contracts ready for signature. Use precise legal language. Include all standard contract clauses.');
    res.json({ contract, athleteName: athlete.name, brand, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── Landing page ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// ── Catch-all → frontend ───────────────────────────────────────
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
