// server/index.js
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const cors     = require('cors');
const path     = require('path');
const store    = require('./store');
const ai       = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
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
  if (!['agent', 'athlete'].includes(role))
    return res.status(400).json({ error: 'Role must be agent or athlete' });
  if (store.getUserByEmail(email))
    return res.status(400).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const id   = 'user-' + Date.now();
  const user = store.saveUser(id, {
    id, name, email, password: hash, role,
    createdAt: new Date().toISOString(),
  });

  req.session.userId = id;
  req.session.role   = role;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = store.getUserByEmail(email);
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

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = store.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ── Athletes ───────────────────────────────────────────────────
app.get('/api/athletes', requireAuth, (req, res) => {
  const user = store.getUser(req.session.userId);
  let athletes;
  if (user.role === 'agent') {
    athletes = store.getAthletesByAgent(user.id);
  } else {
    // Athlete sees only their own profile
    athletes = store.getAthletesByAgent(user.id); // athleteId stored under their userId
  }
  res.json(athletes);
});

app.post('/api/athletes', requireAuth, (req, res) => {
  const user = store.getUser(req.session.userId);
  const { name, sport, position, school, schoolTier, instagram, tiktok, engagement, notes, year, stats, transferReason, gpa } = req.body;
  if (!name || !sport) return res.status(400).json({ error: 'name and sport required' });
  const id = 'ath-' + Date.now();
  const athlete = store.saveAthlete(id, {
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

app.put('/api/athletes/:id', requireAuth, (req, res) => {
  const existing = store.getAthlete(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = store.saveAthlete(req.params.id, { ...existing, ...req.body });
  res.json(updated);
});

app.delete('/api/athletes/:id', requireAuth, (req, res) => {
  store.deleteAthlete(req.params.id);
  res.json({ ok: true });
});

// ── Deals ──────────────────────────────────────────────────────
app.get('/api/athletes/:id/deals', requireAuth, (req, res) => {
  res.json(store.getDealsByAthlete(req.params.id));
});

app.post('/api/athletes/:id/deals', requireAuth, (req, res) => {
  const { brand, campaign, stage, value, offeredValue } = req.body;
  const id = 'deal-' + Date.now();
  const deal = store.saveDeal(id, {
    id, athleteId: req.params.id,
    brand: brand || '', campaign: campaign || '',
    stage: stage || 'Prospecting',
    value: parseInt(value) || 0,
    offeredValue: parseInt(offeredValue) || 0,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(deal);
});

app.patch('/api/deals/:id', requireAuth, (req, res) => {
  const existing = store.getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  res.json(store.saveDeal(req.params.id, { ...existing, ...req.body }));
});

app.delete('/api/deals/:id', requireAuth, (req, res) => {
  store.deleteDeal(req.params.id);
  res.json({ ok: true });
});

// ── AI endpoints ───────────────────────────────────────────────
app.post('/api/ai/command', requireAuth, async (req, res) => {
  const { athleteId, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const athlete = athleteId ? store.getAthlete(athleteId) : null;
  const eff = athlete || { name:'General', sport:'basketball', position:'',
    school:'Unknown', schoolTier:'p4-mid', instagram:0, tiktok:0, engagement:4.0, notes:'' };
  const user = store.getUser(req.session.userId);
  try {
    await ai.streamResponse(eff, message, user.role, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/deals', requireAuth, async (req, res) => {
  const athlete = store.getAthlete(req.body.athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const user = store.getUser(req.session.userId);
  try {
    const recommendations = await ai.getDealRecommendations(athlete, user.role);
    res.json({ recommendations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/rate', requireAuth, async (req, res) => {
  const athlete = store.getAthlete(req.body.athleteId);
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

app.post('/api/ai/negotiate', requireAuth, async (req, res) => {
  const { athleteId, brand, theirOffer, agentTarget } = req.body;
  const athlete = store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  const user = store.getUser(req.session.userId);
  const prompt = `The ${user.role} has a call in 30 minutes negotiating with ${brand}.
Their offer: ${theirOffer} | Target: ${agentTarget}
Give a 4-part playbook:
1. OPENING LINE — exact words
2. PUSHBACK RESPONSE — data to cite, exact words
3. CONCESSION MOVE — non-cash thing to offer
4. WALK-AWAY LINE — exact sentence
Include 3 KEY DATA POINTS to quote. Word-for-word scripts only.`;
  try {
    const playbook = await ai.oneShot(prompt, ai.buildSystemPrompt(athlete, user.role));
    res.json({ playbook });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI ask (non-streaming, works on all hosting) ──────────────
app.post('/api/ai/ask', requireAuth, async (req, res) => {
  const { athleteId, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const athlete = athleteId ? store.getAthlete(athleteId) : null;
  const eff = athlete || { name:'General', sport:'basketball', position:'',
    school:'Unknown', schoolTier:'p4-mid', instagram:0, tiktok:0, engagement:4.0, notes:'' };
  const user = store.getUser(req.session.userId);
  try {
    const response = await ai.oneShot(message, ai.buildSystemPrompt(eff, user.role));
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





// ── Brand Outreach ─────────────────────────────────────────────
app.post('/api/ai/outreach', requireAuth, async (req, res) => {
  const { athleteId, brand, category, contact, goal } = req.body;
  const athlete = store.getAthlete(athleteId);
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
    const raw = await ai.oneShot(prompt, ai.buildSystemPrompt(athlete, 'agent'));
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Generation failed' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// -- NIL Compliance --
app.post('/api/ai/compliance', requireAuth, async (req, res) => {
  const { state, dealType, brand, value, description, athleteName, sport, school, schoolTier } = req.body;
  const prompt = 'Analyze this NIL deal for compliance in ' + state + ':\n' +
    'Athlete: ' + (athleteName||'Unknown') + ', ' + (sport||'Unknown') + ', ' + (school||'Unknown') + ' (' + (schoolTier||'unknown') + ')\n' +
    'Deal: ' + dealType + ' with ' + (brand||'unknown brand') + ' worth $' + (parseInt(value)||0) + '\n' +
    'Description: ' + (description||'not provided') + '\n\n' +
    'Check: 1) Is this deal restricted in ' + state + '? 2) Disclosure requirements? 3) Does $' + (parseInt(value)||0) + ' trigger NIL Go $600 reporting? 4) Agent licensing? 5) Category restrictions (alcohol/gambling/tobacco/supplements/crypto)?\n\n' +
    'Return ONLY JSON: {"state":"' + state + '","status":"clear" or "warning" or "blocked","flags":[{"severity":"high" or "warning","issue":"short title","detail":"specific detail"}],"requirements":["required steps"],"disclosure":"exact disclosure language for contract or social post","sourceNote":"what laws this is based on"}';
  try {
    const result = await ai.oneShot(prompt, 'You are a NIL compliance expert with current knowledge of all 50 state NIL laws and NCAA/CSC rules as of 2026. Return only valid JSON.');
    const cleaned = result.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Failed to parse result' });
    res.json(JSON.parse(match[0]));
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
app.post('/api/ai/player-lookup', requireAuth, async (req, res) => {
  const { name, school, sport } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const prompt = 'Look up college athlete: ' + name + (school ? ' at ' + school : '') + (sport ? ' (' + sport + ')' : '') + '. Return this JSON with found:true always, estimate anything unknown: {"found":true,"name":"full name","school":"school name","sport":"sport","position":"position abbrev","year":"Freshman or Sophomore or Junior or Senior or Grad Transfer","stats":"stats est. if unsure","height":"height","weight":"weight","hometown":"city state","instagram":5000,"tiktok":2000,"engagement":4.2,"schoolTier":"p4-top10 or p4-top25 or p4-mid or p4-lower or highmajor-top or mid-top or mid-mid or mid-lower or lowmajor-top or lowmajor-lower or d2-elite or d2-mid or d2-lower","notes":"2-3 sentences"}. Return ONLY JSON no markdown.';
  try {
    const raw = await ai.oneShot(prompt, 'You are a college sports database D1 through D2. Return only valid JSON.');
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
app.post('/api/ai/team-match', requireAuth, async (req, res) => {
  const { athleteId, conference, minNil, sortBy } = req.body;
  const athlete = store.getAthlete(athleteId);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  const prompt = `Search the web for current 2026 NIL collective budgets and transfer portal activity for ${athlete.sport} programs. Find:
1) Current collective guarantee amounts at ${conference !== 'any' && conference ? conference : 'major'} conference schools for ${athlete.sport} in 2026
2) Recent transfer portal activity for ${athlete.position || athlete.sport} players - which schools are actively recruiting
3) On3 NIL valuations for comparable ${athlete.sport} athletes at this level
4) Collective sizes and recent payout amounts for ${conference !== 'any' && conference ? conference : 'top'} programs

Now use that live data to find the 6 best landing spots for this athlete.

ATHLETE: ${athlete.name} | ${athlete.sport} | ${athlete.position || 'Unknown position'} | Year: ${athlete.year || 'Unknown'} | School: ${athlete.school || 'Unknown'} (${athlete.schoolTier || 'Unknown tier'})
STATS: ${athlete.stats || athlete.notes || 'Not provided'}
PORTAL STATUS: ${athlete.transferReason || 'Unknown'}
SOCIAL: ${athlete.instagram || 0} IG followers, ${athlete.tiktok || 0} TikTok, ${athlete.engagement || 0}% engagement
FILTERS: Conference: ${conference || 'Any'} | Min NIL: $${(minNil||0).toLocaleString()} | Sort: ${sortBy || 'fit'}

Rules: Use real NIL collective budgets. Mix 2 reach, 2 best-fit, 2 safe options. Be specific to this athlete stats.

Return ONLY a JSON array:
[{"rank":1,"name":"School","conference":"ACC","confLabel":"ACC","tier":"reach or best-fit or safe","why":"2 sentences specific to this athlete stats and this school roster need","nilLow":150000,"nilHigh":300000,"nilBreakdown":[{"label":"Collective","val":"$150K"},{"label":"Brand deals","val":"$100K+"}],"fitScore":88,"playingTimeOutlook":"Immediate starter","rosterNeed":"Lost starter to NBA","metrics":[{"label":"Collective strength","val":"Strong"},{"label":"Pro picks 3yr","val":"4"},{"label":"Avg NIL/player","val":"$180K"},{"label":"Market","val":"Major metro"},{"label":"Playing time","val":"High"},{"label":"Academics","val":"Strong"}]}]`;

  try {
    const raw = await ai.oneShotWithSearch(prompt, 'You are a precise NIL recruitment analyst with access to current 2026 NIL data via web search. Search for live collective budgets and portal activity before recommending. Return only valid JSON arrays.');
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    const teams = JSON.parse(match[0]);
    res.json({ teams, liveData: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
