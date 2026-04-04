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
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      console.error('Team match raw:', raw.substring(0, 300));
      throw new Error('No JSON array found');
    }
    const teams = JSON.parse(cleaned.substring(start, end + 1));
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
