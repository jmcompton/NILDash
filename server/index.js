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

// ── BILLING FLAG ──────────────────────────────────────────────────────────
// The self-managed athlete portal is FREE. Stripe billing code below is kept
// fully intact but bypassed while this flag is off. To re-enable paid billing
// later, set env BILLING_ENABLED=true (no rebuild / no code changes needed):
// the athlete verify-email flow will resume creating Stripe checkout + trial.
const BILLING_ENABLED = process.env.BILLING_ENABLED === 'true';

// ── PLATFORM FEE (display / record only — OFF by default) ───────────────────
// Percentage NILDash records on each athlete deal for transparency in the
// money loop. Defaults to 0 (OFF). When > 0, each deal computes & stores
// fee_amount and net_amount and shows a breakdown (amount / fee / net).
// IMPORTANT: this is DISPLAY/RECORD ONLY. NILDash does NOT collect this fee.
// There is NO payment processing, NO Stripe Connect, NO payouts, NO money
// movement anywhere in this loop. To turn it on later set env PLATFORM_FEE_PCT
// (e.g. PLATFORM_FEE_PCT=5) — no rebuild required.
const PLATFORM_FEE_PCT = (function () {
  const v = parseFloat(process.env.PLATFORM_FEE_PCT || '0');
  if (!isFinite(v) || v < 0) return 0;
  return Math.min(v, 100); // clamp to a sane range
})();

// computeFee(amount) → { fee_pct, fee_amount, net_amount } for a given deal
// amount, using the configured PLATFORM_FEE_PCT. Pure math, no side effects.
function computeFee(amount) {
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) {
    return { fee_pct: PLATFORM_FEE_PCT, fee_amount: 0, net_amount: 0 };
  }
  const fee_amount = Math.round((amt * PLATFORM_FEE_PCT) / 100 * 100) / 100;
  const net_amount = Math.round((amt - fee_amount) * 100) / 100;
  return { fee_pct: PLATFORM_FEE_PCT, fee_amount, net_amount };
}

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

// Social stats fetch: each call spends an Anthropic web-search request, so keep
// it tight — a few per minute per user.
const statsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => req.session?.userId || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many stats lookups. Wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Stripe webhook — raw body MUST come before express.json() ─────────────
// This endpoint uses express.raw() to preserve the raw body for Stripe signature verification.
app.post('/api/athlete/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
  }
  let event;
  try {
    if (webhookSecret && sig) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (e) {
    console.error('[stripe-webhook] Signature verification failed:', e.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const athleteId = session.metadata && session.metadata.athlete_id;
    if (athleteId) {
      try {
        await store.pool.query(
          `UPDATE athletes SET
             stripe_subscription_id = $1,
             subscription_status = 'active',
             onboarding_complete = TRUE
           WHERE id = $2`,
          [session.subscription || null, athleteId]
        );
        console.log('[stripe-webhook] Activated athlete', athleteId, 'subscription', session.subscription);
      } catch (e) {
        console.error('[stripe-webhook] DB update failed:', e.message);
      }
    }

    const agentUserId = session.metadata && session.metadata.user_id;
    if (agentUserId) {
      try {
        await store.pool.query(
          `UPDATE users SET stripe_subscription_id = $1, subscription_status = 'active' WHERE id = $2`,
          [session.subscription || null, agentUserId]
        );
        console.log('[stripe-webhook] Activated agent user', agentUserId, 'subscription', session.subscription);
      } catch (e) {
        console.error('[stripe-webhook] agent DB update failed:', e.message);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
    const sub = event.data.object;
    try {
      await store.pool.query(
        `UPDATE athletes SET subscription_status = 'inactive' WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      await store.pool.query(
        `UPDATE users SET subscription_status = 'inactive' WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      console.log('[stripe-webhook] Deactivated subscription', sub.id);
    } catch (e) {
      console.error('[stripe-webhook] DB deactivation failed:', e.message);
    }
  }

  res.json({ received: true });
});

// Media kit saves carry base64 headshot + action-shot images, which blow past
// the default 50kb body limit (that was the root cause of images never
// persisting). Parse those routes with a larger limit BEFORE the global 50kb
// parser so it populates req.body and the global parser then skips them.
// Images are downscaled client-side, so real payloads stay well under this.
const mkImageJson = express.json({ limit: '12mb' });
app.use('/api/agent/athlete-media-kit', mkImageJson);
app.use('/api/athlete/media-kit/save', mkImageJson);

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

// ── Agent subscription gate ──────────────────────────────────
// Comp/demo accounts (admin role, or beta/comp plan) always have access.
// Everyone else must have an active subscription to use token-spending tools.
// Founder allowlist: these accounts always have full tool access regardless of plan.
// Set FOUNDER_EMAILS on Railway (comma-separated) so the email stays out of this public repo.
const FOUNDER_EMAILS = (process.env.FOUNDER_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function isFounderEmail(email) {
  return !!email && FOUNDER_EMAILS.includes(email.trim().toLowerCase());
}

function agentHasAccess(user) {
  if (!user) return false;
  if (isFounderEmail(user.email)) return true;   // founder allowlist (additive, never weakens the checks below)
  if (user.role === 'admin') return true;
  if (user.subscription_status === 'active') return true;
  // Only brand-new self-signup agents (plan 'free') are gated. Every existing
  // or comp account keeps access, so your own logins and demos never break.
  if (user.plan !== 'free') return true;
  // 7-day free trial for new self-signup agents (no card needed)
  if (user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  return false;
}

async function requireAgentSubscription(req, res, next) {
  try {
    if (!req.session || !req.session.userId) return next(); // requireAuth handles auth
    const user = await store.getUser(req.session.userId);
    if (!user) return next();
    if (agentHasAccess(user)) return next();
    return res.status(402).json({ error: 'subscription_required', message: 'Subscribe to unlock your NILDash tools.' });
  } catch (e) {
    console.error('[requireAgentSubscription] error:', e.message);
    return next(); // fail open on unexpected error so the app never hard-breaks
  }
}

// Gate every token-spending agent tool. These paths are agent-only (session auth).
app.use('/api/ai', requireAgentSubscription);
app.use('/api/deal-close', requireAgentSubscription);
app.use('/api/intelligence', requireAgentSubscription);
app.use('/api/reports', requireAgentSubscription);

// ── Agent subscription checkout ──────────────────────────────
app.post('/api/agent/create-checkout', requireAuth, async (req, res) => {
  try {
    const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    const agentPrice = (process.env.STRIPE_AGENT_PRICE_ID || '').trim();
    if (!stripeKey || !agentPrice) {
      return res.status(400).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_AGENT_PRICE_ID.' });
    }
    const stripe = require('stripe')(stripeKey);
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const user = await store.getUser(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || '',
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await store.pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: agentPrice, quantity: 1 }],
      success_url: `${appUrl}/api/agent/stripe-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/?subscribe=cancelled`,
      metadata: { user_id: user.id },
    });

    res.json({ url: checkoutSession.url });
  } catch (e) {
    console.error('[agent-checkout] failed:', e.type || '', e.code || '', e.message, e.raw && e.raw.message ? '| raw: ' + e.raw.message : '');
    res.status(500).json({
      error: 'Could not start checkout. ' + e.message,
      stripe_type: e.type || null,
      stripe_code: e.code || null,
      stripe_detail: (e.raw && e.raw.message) || e.detail || null
    });
  }
});

app.get('/api/agent/stripe-complete', requireAuth, async (req, res) => {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    const sessionId = req.query.session_id;
    if (stripeKey && sessionId) {
      const stripe = require('stripe')(stripeKey);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session && session.metadata && session.metadata.user_id) {
        await store.pool.query(
          `UPDATE users SET subscription_status = 'active',
             stripe_subscription_id = COALESCE(stripe_subscription_id, $1)
           WHERE id = $2`,
          [session.subscription || null, session.metadata.user_id]
        );
      }
    }
  } catch (e) {
    console.error('[agent-stripe-complete] failed:', e.message);
  }
  res.redirect('/?subscribed=1');
});

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

  const hash = await bcrypt.hash(password, 10);
  const id   = 'user-' + Date.now();
  const user = await store.saveUser(id, {
    id, name, email, password: hash, role,
    createdAt: new Date().toISOString(),
  });

  if (role === 'agent') {
    const trialEnds = new Date(Date.now() + 7 * 86400000).toISOString();
    await store.pool.query("UPDATE users SET plan = 'free', trial_ends_at = $2 WHERE id = $1", [id, trialEnds]).catch(() => {});
  }

  req.session.userId = id;
  req.session.role   = role;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = await store.getUserByEmailWithPassword(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  // Inactive athlete accounts (removed by agent)
  if (user.role === 'athlete' && user.agent_id) {
    const agentExists = await store.pool.query('SELECT id FROM users WHERE id=$1', [user.agent_id]).catch(() => ({ rows: [] }));
    // Don't block login here — agent account may just be inactive, keep access
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  req.session.userId = user.id;
  req.session.role   = user.role;
  res.json({
    id: user.id, name: user.name, email: user.email, role: user.role,
    passwordResetRequired: user.password_reset_required || false,
    athleteId: user.athlete_id || null,
    agentId: user.agent_id || null,
  });
});

// ── Force password reset (athlete first login) ────────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    const user = await store.getUserWithPassword(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // If currentPassword provided, verify it (skip check for forced-reset flow)
    if (currentPassword) {
      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await store.pool.query(
      'UPDATE users SET password=$1, password_reset_required=FALSE, updated_at=NOW() WHERE id=$2',
      [hash, req.session.userId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  res.json({
    id: user.id, name: user.name, email: user.email, role: user.role,
    passwordResetRequired: user.password_reset_required || false,
    athleteId: user.athlete_id || null,
    agentId: user.agent_id || null,
    plan: user.plan || 'basic', planTier: user.plan_tier || 'basic',
    subscription_status: user.subscription_status || 'inactive',
    agentAccess: agentHasAccess(user),
    isFounder: isFounderEmail(user.email),
  });

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

  // UNIVERSITY SIDE ONLY — writes to university_athletes, never to the agent athletes table
  let inserted = 0, updated = 0, failed = 0;
  for (const athlete of SAMFORD_ATHLETES) {
    const { id, name, sport, position, ...rest } = athlete;
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || null;
    const lastName  = nameParts.slice(1).join(' ') || null;
    try {
      await store.pool.query(
        `INSERT INTO university_athletes (id, university_id, first_name, last_name, name, sport, position, source, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, sport = EXCLUDED.sport, position = EXCLUDED.position,
           data = EXCLUDED.data, updated_at = NOW()`,
        [id, UNIV_ID, firstName, lastName, name, sport || null, position || null, JSON.stringify({ name, sport, position, ...rest })]
      );
      const existing = await store.pool.query('SELECT id FROM university_athletes WHERE id=$1', [id]);
      if (existing.rows.length) updated++; else inserted++;
    } catch (err) {
      console.error('[seed]', athlete.name, err.message);
      failed++;
    }
  }

  res.json({ ok: true, upserted: inserted + updated, failed, total: SAMFORD_ATHLETES.length, university: 'Samford University', university_id: UNIV_ID, adminLinked: true });
});

// ── University Compliance Portal Auth ─────────────────────────────────────
function requireUniversityAuth(req, res, next) {
  if (!req.session.universityUserId) return res.status(401).json({ error: 'University authentication required' });
  next();
}

app.post('/api/university/register', async (req, res) => {
  try {
    const { name, email, password, universityId } = req.body;
    if (!name || !email || !password || !universityId)
      return res.status(400).json({ error: 'All fields required' });

    const univCheck = await store.pool.query('SELECT id FROM universities WHERE id=$1', [universityId]);
    if (!univCheck.rows.length) return res.status(400).json({ error: 'Invalid university' });

    const existing = await store.pool.query('SELECT id FROM university_users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const id = 'univuser-' + require('crypto').randomBytes(8).toString('hex');
    await store.pool.query(
      'INSERT INTO university_users (id, university_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, universityId, email.toLowerCase(), hash, name, 'compliance_officer']
    );
    res.json({ ok: true });
  } catch(e) {
    console.error('[university/register]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/university/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const r = await store.pool.query(
      'SELECT u.*, univ.name as university_name FROM university_users u JOIN universities univ ON univ.id = u.university_id WHERE u.email=$1',
      [email.toLowerCase()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.universityUserId = user.id;
    req.session.universityId = user.university_id;
    req.session.universityRole = user.role;

    res.json({
      ok: true,
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      universityId: user.university_id,
      universityName: user.university_name
    });
  } catch(e) {
    console.error('[university/login]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/university/logout', (req, res) => {
  req.session.universityUserId = null;
  req.session.universityId = null;
  req.session.universityRole = null;
  res.json({ ok: true });
});

app.get('/api/university/me', async (req, res) => {
  if (!req.session.universityUserId) return res.status(401).json({ error: 'Not authenticated' });
  const r = await store.pool.query(
    'SELECT u.*, univ.name as university_name FROM university_users u JOIN universities univ ON univ.id = u.university_id WHERE u.id=$1',
    [req.session.universityUserId]
  );
  if (!r.rows.length) return res.status(401).json({ error: 'Not found' });
  const user = r.rows[0];
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, universityId: user.university_id, universityName: user.university_name });
});

app.get('/api/university/list', async (req, res) => {
  const r = await store.pool.query('SELECT id, name, conference FROM universities ORDER BY name ASC');
  res.json(r.rows);
});

// POST /api/university/ai/compliance-check
app.post('/api/university/ai/compliance-check', requireUniversityAuth, async (req, res) => {
  try {
    const { athleteId } = req.body;
    const universityId = req.session.universityId;
    if (!athleteId) return res.status(400).json({ error: 'athleteId required' });

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const athR = await store.pool.query('SELECT * FROM university_athletes WHERE id=$1', [athleteId]);
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const athlete = athR.rows[0];
    const athData = athlete.data || {};

    const dealsR = await store.pool.query(
      'SELECT * FROM deals WHERE athlete_id=$1 ORDER BY created_at DESC LIMIT 20',
      [athleteId]
    );

    const flagsR = await store.pool.query(
      'SELECT * FROM university_deal_flags WHERE athlete_id=$1 AND university_id=$2 AND resolved=false',
      [athleteId, universityId]
    );

    const athletePayload = {
      name: athData.name || athlete.id,
      sport: athData.sport,
      school: athData.school,
      instagram: athData.instagram,
      tiktok: athData.tiktok,
      deals: dealsR.rows.map(d => ({
        id: d.id,
        brand: d.brand || d.data?.brand,
        value: d.value || d.data?.value,
        category: d.category || d.data?.category,
        status: d.status || d.data?.status,
        exclusivity: d.data?.exclusivity,
        notes: d.data?.notes,
      })),
      existingFlags: flagsR.rows.length,
    };

    const systemPrompt = `You are an NCAA NIL compliance analyst. Your job is to review an athlete's NIL deal portfolio and flag any compliance risks. You understand NCAA rules, conference-specific NIL policies, and common contract conflicts. Be specific, cite the exact deals involved, and rate severity as low/medium/high. Return structured JSON only — no markdown, no explanation outside the JSON.`;

    const userPrompt = `Review this athlete's NIL deal portfolio and return a JSON array of compliance flags:\n\n${JSON.stringify(athletePayload, null, 2)}\n\nReturn ONLY a JSON array in this exact format:\n[{"flag_type":"conflict|exclusivity_breach|missing_disclosure|category_overlap","severity":"low|medium|high","deals_involved":["deal_id"],"summary":"one sentence plain English","recommended_action":"what the compliance officer should do"}]`;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    let flags = [];
    try {
      const text = msg.content[0].text.trim();
      const jsonStr = text.startsWith('[') ? text : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
      flags = JSON.parse(jsonStr);
    } catch(e) {
      return res.status(500).json({ error: 'AI returned unparseable response', raw: msg.content[0].text });
    }

    const saved = [];
    for (const flag of flags) {
      const flagId = 'flag-' + require('crypto').randomBytes(8).toString('hex');
      await store.pool.query(
        `INSERT INTO university_deal_flags (id, university_id, athlete_id, flag_type, severity, ai_summary, recommended_action, deals_involved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [flagId, universityId, athleteId, flag.flag_type, flag.severity, flag.summary, flag.recommended_action, flag.deals_involved || []]
      );
      saved.push({ id: flagId, ...flag });
    }

    res.json({ ok: true, flags: saved, athleteName: athData.name });
  } catch(e) {
    console.error('[university/ai/compliance-check]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/university/ai/deal-recommendations/:athleteId
app.post('/api/university/ai/deal-recommendations/:athleteId', requireUniversityAuth, async (req, res) => {
  try {
    const { athleteId } = req.params;

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const athR = await store.pool.query('SELECT * FROM university_athletes WHERE id=$1', [athleteId]);
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const athData = athR.rows[0].data || {};

    const dealsR = await store.pool.query('SELECT * FROM deals WHERE athlete_id=$1', [athleteId]);
    const existingBrands = dealsR.rows.map(d => d.brand || d.data?.brand).filter(Boolean);

    const athletePayload = {
      name: athData.name,
      sport: athData.sport,
      position: athData.position,
      school: athData.school,
      conference: athData.schoolTier,
      instagram: athData.instagram,
      tiktok: athData.tiktok,
      engagement: athData.engagement,
      existingBrands,
      notes: athData.notes,
    };

    const systemPrompt = `You are an NIL deal strategist helping a university compliance officer identify ideal brand partnership opportunities for their athletes. Recommend deals that are compliant, realistic for this athlete's market value, and additive to their existing portfolio. Return structured JSON only.`;

    const userPrompt = `Generate 5 ranked deal recommendations for this athlete:\n\n${JSON.stringify(athletePayload, null, 2)}\n\nReturn ONLY a JSON array:\n[{"rank":1,"brand_name":"...","category":"...","campaign_concept":"...","estimated_value_min":1000,"estimated_value_max":5000,"why_it_fits":"...","compliance_risk":"low|medium|high"}]`;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    let recommendations = [];
    try {
      const text = msg.content[0].text.trim();
      const jsonStr = text.startsWith('[') ? text : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
      recommendations = JSON.parse(jsonStr);
    } catch(e) {
      return res.status(500).json({ error: 'AI returned unparseable response' });
    }

    res.json({ ok: true, recommendations, athleteName: athData.name });
  } catch(e) {
    console.error('[university/ai/deal-recommendations]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/university/flags
app.get('/api/university/flags', requireUniversityAuth, async (req, res) => {
  try {
    const universityId = req.session.universityId;
    const { resolved, severity, athlete_id } = req.query;
    // UNIVERSITY SIDE ONLY — reads from university_athletes
    let sql = `SELECT f.*, a.name as athlete_name, a.sport
               FROM university_deal_flags f
               JOIN university_athletes a ON a.id = f.athlete_id
               WHERE f.university_id=$1`;
    const params = [universityId];
    if (resolved !== undefined) { params.push(resolved === 'true'); sql += ` AND f.resolved=$${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND f.severity=$${params.length}`; }
    if (athlete_id) { params.push(athlete_id); sql += ` AND f.athlete_id=$${params.length}`; }
    sql += ' ORDER BY f.created_at DESC';
    const r = await store.pool.query(sql, params);
    res.json(r.rows);
  } catch(e) {
    console.error('[university/flags]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/university/flags/:id/resolve', requireUniversityAuth, async (req, res) => {
  try {
    const universityId = req.session.universityId;
    await store.pool.query(
      'UPDATE university_deal_flags SET resolved=TRUE WHERE id=$1 AND university_id=$2',
      [req.params.id, universityId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/university/compliance-dashboard', requireUniversityAuth, async (req, res) => {
  try {
    const universityId = req.session.universityId;

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const athleteLinks = await store.pool.query(
      `SELECT ual.*, a.name, a.sport
       FROM university_athlete_links ual
       JOIN university_athletes a ON a.id = ual.athlete_id
       WHERE ual.university_id=$1
       ORDER BY ual.linked_at DESC`,
      [universityId]
    );

    const flagsSummary = await store.pool.query(
      `SELECT severity, COUNT(*) as count FROM university_deal_flags
       WHERE university_id=$1 AND resolved=false GROUP BY severity`,
      [universityId]
    );

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const topFlags = await store.pool.query(
      `SELECT f.*, a.name as athlete_name, a.sport
       FROM university_deal_flags f
       JOIN university_athletes a ON a.id = f.athlete_id
       WHERE f.university_id=$1 AND f.resolved=false
       ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, f.created_at DESC
       LIMIT 3`,
      [universityId]
    );

    res.json({
      athleteLinks: athleteLinks.rows,
      pendingLinks: athleteLinks.rows.filter(r => r.status === 'pending'),
      flagsSummary: flagsSummary.rows,
      topFlags: topFlags.rows,
      totalAthletes: athleteLinks.rows.filter(r => r.status === 'active').length,
    });
  } catch(e) {
    console.error('[university/compliance-dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/university/athlete-links/:id', requireUniversityAuth, async (req, res) => {
  try {
    const universityId = req.session.universityId;
    const { status } = req.body;
    await store.pool.query(
      'UPDATE university_athlete_links SET status=$1 WHERE id=$2 AND university_id=$3',
      [status, req.params.id, universityId]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Athletes ───────────────────────────────────────────────────
app.get('/api/athletes', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  let athletes;
  if (user.role === 'agent' || user.role === 'admin') {
    athletes = await store.getAthletesByAgent(user.id);
  } else {
    // FIXED: athlete users have athlete_id on their profile, not their own athletes roster
    const athleteId = user.athlete_id;
    if (!athleteId) return res.json([]);
    const athlete = await store.getAthlete(athleteId);
    athletes = athlete ? [athlete] : [];
  }
  res.json(athletes);
});

// ── Seat limit helper ─────────────────────────────────────────────────────
function getSeatLimit(plan) {
  if (!plan) return 10;
  const p = String(plan).toLowerCase();
  if (p.includes('unlimited') || p.includes('enterprise') || p.includes('599')) return null;
  if (p.includes('pro') || p.includes('499')) return 20;
  return 10; // basic, beta, $299, etc.
}

// ── Seat status endpoint ──────────────────────────────────────────────────
app.get('/api/agent/seat-status', requireAuth, async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const plan = user.plan_tier || user.plan || 'basic';
    const seatLimit = getSeatLimit(plan);
    const countR = await store.pool.query(
      `SELECT COUNT(*) FROM athletes WHERE agent_id=$1`,
      [req.session.userId]
    );
    const currentCount = parseInt(countR.rows[0].count, 10);
    res.json({
      plan, seatLimit, currentCount,
      hasSeats: seatLimit === null || currentCount < seatLimit,
      seatsFull: seatLimit !== null && currentCount >= seatLimit,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/athletes', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  const { name, sport, position, school, schoolTier, instagram, tiktok, engagement, notes, year, stats, transferReason, gpa,
          instagramHandle, brandRestrictions, igStatsSource, igStatsFetchedAt, hometown, tags, productWants } = req.body;
  if (!name || !sport) return res.status(400).json({ error: 'name and sport required' });

  // ── Seat limit check ─────────────────────────────────────────
  const plan = user.plan_tier || user.plan || 'basic';
  const seatLimit = getSeatLimit(plan);
  if (seatLimit !== null) {
    const countR = await store.pool.query(
      `SELECT COUNT(*) FROM athletes WHERE agent_id=$1`,
      [req.session.userId]
    );
    const currentCount = parseInt(countR.rows[0].count, 10);
    if (currentCount >= seatLimit) {
      return res.status(403).json({
        error: `You've reached your athlete limit (${seatLimit}) on your current plan. Upgrade to add more athletes.`,
        code: 'SEAT_LIMIT_REACHED',
        seatLimit,
        currentCount,
      });
    }
  }

  // ── Duplicate-submit guard ───────────────────────────────────
  // A slow save can let a double-click through and create two identical clients.
  // If this agent already created an athlete with the same name in the last 10
  // seconds, treat it as the same submission and return that existing row instead
  // of inserting a duplicate. A guard failure must never block a legitimate save,
  // so any error here just falls through to the normal insert below.
  try {
    const dupR = await store.pool.query(
      `SELECT id FROM athletes
         WHERE agent_id=$1 AND data->>'name'=$2 AND created_at > NOW() - INTERVAL '10 seconds'
         ORDER BY created_at DESC LIMIT 1`,
      [req.session.userId, name]
    );
    if (dupR.rows.length > 0) {
      const existing = await store.getAthlete(dupR.rows[0].id);
      if (existing) return res.status(200).json(existing);
    }
  } catch (e) {
    console.error('[create-athlete] duplicate guard failed:', e.message);
  }

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
    // Hometown powers the Deal Scan second market ("hometown hero" angle).
    hometown: (hometown ? String(hometown).trim() : ''),
    // Interest tags ("industry:sub" strings) and product wants feed Deal Scan.
    tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string').slice(0, 40) : [],
    productWants: (productWants ? String(productWants).trim().slice(0, 300) : ''),
    // Additive social/onboarding fields — default cleanly so the normal Add
    // Client flow (which does not send these) is unchanged.
    instagramHandle: (instagramHandle ? String(instagramHandle).trim().replace(/^@+/, '').toLowerCase() : ''),
    brandRestrictions: Array.isArray(brandRestrictions) ? brandRestrictions : [],
    igStatsSource: ['web_estimate', 'manual', 'instagram_page'].includes(igStatsSource) ? igStatsSource : null,
    igStatsFetchedAt: igStatsFetchedAt || null,
    createdAt: new Date().toISOString(),
  });
  checkOff(req.session.userId, 'add_athlete'); // Getting Started checklist
  res.status(201).json(athlete);
});

// ── Agent-initiated athlete account creation ──────────────────────────────
// Creates both the athlete profile AND the athlete login account, sends welcome email
app.post('/api/agent/create-athlete-account', requireAuth, async (req, res) => {
  try {
    const agent = await store.getUser(req.session.userId);
    if (!agent) return res.status(403).json({ error: 'Forbidden' });

    const { athleteId, email, name } = req.body;
    if (!athleteId || !email) return res.status(400).json({ error: 'athleteId and email required' });

    // Verify athlete belongs to this agent
    const athlete = await store.getAthlete(athleteId);
    if (!athlete || athlete.agentId !== req.session.userId)
      return res.status(403).json({ error: 'Athlete not found or not yours' });

    // Check if athlete already has an account
    const existing = await store.pool.query('SELECT id FROM users WHERE athlete_id=$1', [athleteId]);
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'This athlete already has an account' });

    // Check if email already used
    if (await store.getUserByEmail(email))
      return res.status(400).json({ error: 'Email already registered' });

    // Generate temp password
    const tempPassword = require('crypto').randomBytes(6).toString('hex'); // e.g. "a3f9b2c1d4"
    const hash = await bcrypt.hash(tempPassword, 10);
    const userId = 'athlete-user-' + Date.now();

    await store.saveUser(userId, {
      id: userId,
      name: name || athlete.name || email,
      email,
      password: hash,
      role: 'athlete',
      athleteId,
      agentId: req.session.userId,
      createdAt: new Date().toISOString(),
    });

    // Mark as requiring password reset
    await store.pool.query(
      'UPDATE users SET password_reset_required=TRUE WHERE id=$1',
      [userId]
    );

    // Send welcome email
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    try {
      await resend.emails.send({
        from: 'NILDash <noreply@mynildash.com>',
        to: [email],
        subject: `Welcome to NILDash — your athlete portal is ready`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
            <h2 style="color:#6366f1">Welcome to NILDash, ${athlete.name || name}!</h2>
            <p>Your agent <strong>${agent.name}</strong> has set up your personal NIL dashboard.</p>
            <p>Here are your login details:</p>
            <div style="background:#f4f4f5;border-radius:8px;padding:20px;margin:20px 0">
              <p style="margin:0 0 8px"><strong>Login page:</strong> <a href="${appUrl}">${appUrl}</a></p>
              <p style="margin:0 0 8px"><strong>Email:</strong> ${email}</p>
              <p style="margin:0"><strong>Temporary password:</strong> <code style="background:#e4e4e7;padding:2px 6px;border-radius:4px">${tempPassword}</code></p>
            </div>
            <p><strong>Important:</strong> You'll be asked to set a new password on your first login.</p>
            <p>Click "I'm an Athlete" on the login page and sign in with the credentials above.</p>
            <a href="${appUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Go to NILDash →</a>
          </div>
        `,
      });
    } catch(emailErr) {
      console.warn('[create-athlete-account] email send failed:', emailErr.message);
      // Don't fail the request if email fails
    }

    res.json({ ok: true, userId, tempPassword, message: 'Account created and welcome email sent' });
  } catch(e) {
    console.error('[create-athlete-account]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/athletes/:id', requireAuth, async (req, res) => {
  const existing = await store.getAthlete(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // FIXED: ownership check — agentId is camelCase from store.getAthlete()
  const user = await store.getUser(req.session.userId);
  if (existing.agentId !== req.session.userId && user.email !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });
  const updated = await store.saveAthlete(req.params.id, { ...existing, ...req.body });
  res.json(updated);
});

app.delete('/api/athletes/:id', requireAuth, async (req, res) => {
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Not found' });
  const user = await store.getUser(req.session.userId);
  // FIXED: agentId is camelCase from store.getAthlete() — was athlete.agent_id (undefined), causing 403 for owners
  if (athlete.agentId !== req.session.userId && user.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await store.deleteAthlete(req.params.id);
  res.json({ ok: true });
});

// ── Athlete note ─────────────────────────────────────────────
app.patch('/api/athletes/:id/note', requireAuth, async (req, res) => {
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Not found' });
  // FIXED: agentId is camelCase from store.getAthlete() — was athlete.agent_id (undefined), blocking all notes
  if (athlete.agentId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
  await store.saveAthlete(req.params.id, { ...athlete, agentNote: req.body.agentNote || '' });
  res.json({ ok: true });
});

// ── Agent-wide deals (used by Pipeline tab) ────────────────────
// Returns all deals for the current agent across all athletes.
// Same data source as /api/agent/home-data so Pipeline and Home stay in sync.
app.get('/api/agent/deals', requireAuth, async (req, res) => {
  try {
    const deals = await store.getDealsByAgent(req.session.userId);
    res.json(deals);
  } catch (e) {
    console.error('[agent/deals]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Deals ──────────────────────────────────────────────────────
app.get('/api/athletes/:id/deals', requireAuth, async (req, res) => {
  // FIXED: verify caller owns this athlete or is the athlete themselves
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Not found' });
  const user = await store.getUser(req.session.userId);
  const isOwner = athlete.agentId === req.session.userId;
  const isAthlete = user.role === 'athlete' && user.athlete_id === req.params.id;
  const isAdmin = user.email === ADMIN_EMAIL;
  if (!isOwner && !isAthlete && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
  res.json(await store.getDealsByAthlete(req.params.id));
});

app.post('/api/athletes/:id/deals', requireAuth, async (req, res) => {
  try {
    const { brand, campaign, stage, value, offeredValue } = req.body;
    if (!brand) return res.status(400).json({ error: 'Brand is required' });
    const athlete = await store.getAthlete(req.params.id);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    // FIXED: verify agent owns this athlete before adding deals
    if (athlete.agentId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
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
    checkOff(req.session.userId, 'log_deal'); // Getting Started checklist
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
  checkOff(req.session.userId, 'log_deal'); // Getting Started checklist
  res.json(deal);
});

app.patch('/api/deals/:id', requireAuth, async (req, res) => {
  const existing = await store.getDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // FIXED: ownership check — agentId is camelCase from store.getDeal()
  const user = await store.getUser(req.session.userId);
  if (existing.agentId && existing.agentId !== req.session.userId && user.email !== ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' });
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
  const user = await store.getUser(req.session.userId);
  const isAdmin = user && user.email === ADMIN_EMAIL;
  // FIXED: agentId is camelCase from store.getDeal() — was deal.agent_id (undefined), allowing anyone to delete any deal
  if (!isAdmin && deal.agentId && deal.agentId !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await store.deleteDeal(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING STATE (Parts A / C / E) + INSTAGRAM STATS FETCH (Part B)
// ═══════════════════════════════════════════════════════════════════════════

// Fire-and-forget checklist writer used by action handlers throughout the app.
// Never awaited on the request path — a checklist write must not slow or break
// the underlying action.
function checkOff(userId, item) {
  if (!userId) return;
  store.markChecklistItem(userId, item).catch(() => {});
}

// Wizard + checklist state for the current agent. Backfills historical activity
// on first read so long-time users don't see an empty checklist. Always returns
// a usable object — never blocks the dashboard.
app.get('/api/onboarding', requireAuth, async (req, res) => {
  const row = await store.getOnboarding(req.session.userId, { backfill: true });
  const hasAthletes = await store.pool
    .query(`SELECT 1 FROM athletes WHERE agent_id=$1 LIMIT 1`, [req.session.userId])
    .then(r => r.rows.length > 0).catch(() => false);
  res.json({
    wizardStep: row ? row.wizard_step : 0,
    wizardCompletedAt: row ? row.wizard_completed_at : null,
    checklist: (row && row.checklist) || {},
    checklistDismissed: row ? !!row.checklist_dismissed : false,
    tooltipsSeen: (row && row.tooltips_seen) || {},
    // Account-state signal so the client can decide whether to ever show the
    // wizard, independent of any local flag.
    hasAthletes,
  });
});

// Log a wizard step transition. body: { step, action } action in
// entered|completed|skipped. Also advances the persisted resume point.
app.post('/api/onboarding/step', requireAuth, async (req, res) => {
  const step = parseInt(req.body.step, 10);
  const action = String(req.body.action || 'entered');
  if (isNaN(step)) return res.status(400).json({ error: 'step required' });
  const ok = ['entered', 'completed', 'skipped'].includes(action) ? action : 'entered';
  await store.logWizardEvent(req.session.userId, step, ok);
  res.json({ ok: true });
});

app.post('/api/onboarding/complete', requireAuth, async (req, res) => {
  await store.completeWizard(req.session.userId);
  res.json({ ok: true });
});

// Dismiss/undismiss the Getting Started checklist. Declared before the
// ":item" route below so the literal "dismiss" path is not captured as an item.
app.post('/api/onboarding/checklist/dismiss', requireAuth, async (req, res) => {
  await store.dismissChecklist(req.session.userId, req.body.dismissed !== false);
  res.json({ ok: true });
});

// Manually mark a checklist item (also invoked server-side by action handlers).
app.post('/api/onboarding/checklist/:item', requireAuth, async (req, res) => {
  if (!store.CHECKLIST_ITEMS.includes(req.params.item)) {
    return res.status(400).json({ error: 'unknown item' });
  }
  await store.markChecklistItem(req.session.userId, req.params.item);
  res.json({ ok: true });
});

app.post('/api/onboarding/tooltip/:tool', requireAuth, async (req, res) => {
  await store.markTooltipSeen(req.session.userId, req.params.tool);
  res.json({ ok: true });
});

// Internal analytics: wizard step drop-off. Admin/founder only.
app.get('/api/onboarding/analytics', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || (user.email !== ADMIN_EMAIL && !isFounderEmail(user.email))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(await store.getOnboardingAnalytics());
});

// ── Instagram handle stats fetch (Part B) ──────────────────────────────────
// Handle in, followers + engagement rate out. Uses the Anthropic web search
// tool. Hard rule in the prompt: never estimate or fabricate — unknown fields
// come back null. :id may be a real athlete id (result is cached) or the literal
// "new" for the pre-save wizard flow (handle read from the body).
function normalizeHandle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/+$/, '')
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
}

// Parse abbreviated counts from Instagram metadata: "1,069", "12.4K", "1.2M".
function parseIgCount(numStr, suffix) {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const s = (suffix || '').toLowerCase();
  return Math.round(s === 'm' ? n * 1e6 : s === 'k' ? n * 1e3 : n);
}

// ── LANE 1: Instagram profile page metadata ─────────────────────────────────
// Instagram serves link-preview metadata (og:description) for public profiles
// without login: "X Followers, Y Following, Z Posts". Exact for ANY account
// size, unlike stat sites that only index big accounts. One attempt plus at
// most one retry on a fast network failure; hard 4s timeout per attempt so the
// lane resolves in under 5 seconds either way. Base URL is env-overridable for
// testing (IG_META_BASE_URL).
const IG_META_BASE = process.env.IG_META_BASE_URL || 'https://www.instagram.com';
const IG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchInstagramPageMeta(handle) {
  const t0 = Date.now();
  const attempt = async () => {
    const resp = await fetch(`${IG_META_BASE}/${encodeURIComponent(handle)}/`, {
      headers: { 'User-Agent': IG_UA, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(4000),
    });
    // Login wall / redirect to login = miss, not an error.
    if (resp.url && /\/accounts\/login/i.test(resp.url)) return { miss: 'login-wall' };
    if (!resp.ok) return { miss: `http-${resp.status}` };
    const html = (await resp.text()).slice(0, 400000);
    if (/\/accounts\/login/i.test(html.slice(0, 2000)) && !/Followers/i.test(html)) return { miss: 'login-page' };
    // og:description or plain description meta, attribute order tolerant.
    const metas = html.match(/<meta[^>]+content="[^"]*Followers[^"]*"[^>]*>/gi) || [];
    let desc = null;
    for (const tag of metas) {
      if (/property="og:description"|name="description"/i.test(tag)) {
        const cm = tag.match(/content="([^"]+)"/i);
        if (cm) { desc = cm[1]; break; }
      }
    }
    if (!desc && metas.length) { const cm = metas[0].match(/content="([^"]+)"/i); if (cm) desc = cm[1]; }
    if (!desc) return { miss: 'no-meta' };
    // "1,069 Followers, 344 Following, 32 Posts" (also 12.4K / 1.2M forms)
    const fm = desc.match(/([\d.,]+)\s*([KkMm])?\s+Followers?/);
    if (!fm) return { miss: 'no-follower-pattern' };
    const followers = parseIgCount(fm[1], fm[2]);
    if (followers === null) return { miss: 'unparseable-count' };
    const pm = desc.match(/([\d.,]+)\s*([KkMm])?\s+Posts?/);
    const posts = pm ? parseIgCount(pm[1], pm[2]) : null;
    return { followers, posts };
  };

  try {
    let r;
    try {
      r = await attempt();
    } catch (e1) {
      // One retry, only when the first attempt failed fast (connection reset
      // etc.), never after a full timeout — the lane stays under 5s total.
      if (Date.now() - t0 < 1500) r = await attempt();
      else throw e1;
    }
    if (r.miss) {
      console.log(`[social-stats] lane1 instagram_page MISS (${r.miss}) for @${handle} in ${Date.now() - t0}ms`);
      return null;
    }
    console.log(`[social-stats] lane1 instagram_page HIT for @${handle}: ${r.followers} followers${r.posts !== null ? `, ${r.posts} posts` : ''} in ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    console.log(`[social-stats] lane1 instagram_page failed (${e.name === 'TimeoutError' ? 'timeout' : e.message}) for @${handle} in ${Date.now() - t0}ms`);
    return null;
  }
}

// ── LANE 2: AI web search, profile-snippet-first ────────────────────────────
// Fallback when the direct page fetch misses. The prompt now targets the
// indexed Instagram profile result FIRST (its snippet carries the same
// "X Followers" metadata, so it works for small accounts), then stat sites and
// articles. Strict JSON, nulls when nothing real is found. Capped at ~15s.
async function fetchInstagramStatsViaSearch(handle) {
  const t0 = Date.now();
  const system = 'You are a precise research assistant that only reports numbers found on real, public web sources. You never estimate, guess, extrapolate, or fabricate a follower count or engagement rate. If you cannot find a real figure for the exact handle, you return null for that field. Output strict JSON only, no prose, no markdown.';
  const prompt = [
    `Find the public Instagram statistics for the exact handle "@${handle}".`,
    '',
    'Search strategy, in this order:',
    `1. FIRST search for the profile page itself: query "${handle}" together with instagram.com. The indexed Instagram result snippet shows "X Followers, Y Following, Z Posts" for the account. Extract the follower count from that snippet. This works for accounts of any size.`,
    `2. Only if step 1 finds nothing, search public stat sources: social stat trackers (e.g. socialblade, hypeauditor), influencer databases, NIL databases (e.g. On3), news articles, and college roster pages.`,
    `3. Only use numbers for the account whose handle string is exactly "${handle}". If several accounts appear, match the handle character for character. If none match exactly, treat it as not found.`,
    '4. Return STRICT JSON only, in exactly this shape:',
    '{',
    '  "followers": 1069,',
    '  "engagement_rate": 4.2,',
    '  "source": "short description of where the numbers came from",',
    '  "confidence": "high | medium | low",',
    '  "found": true',
    '}',
    '',
    'Hard rules:',
    '- If the follower count cannot be found from a real source, set "followers" to null.',
    '- If the engagement rate cannot be found from a real source, set "engagement_rate" to null. Exact engagement rates are usually NOT public for small accounts; null is the correct answer then.',
    '- Set "found" to false if you could not confirm this exact account exists on a real source.',
    '- Never estimate, never guess, never fabricate any number. A null is always better than an invented value.',
    '- "engagement_rate" is a percentage number (e.g. 4.2 means 4.2 percent), not a fraction.',
    '- Output only the JSON object. No explanation before or after.',
  ].join('\n');

  const empty = { followers: null, engagement_rate: null, source: null, confidence: 'low', found: false };
  let raw = '';
  try {
    raw = await Promise.race([
      ai.oneShotWebSearch(prompt, system, 900, 4, ai.MODEL_STANDARD),
      new Promise((resolve) => setTimeout(() => resolve(''), 15000)),
    ]);
  } catch (e) {
    console.warn(`[social-stats] lane2 web search failed for @${handle}:`, e.message);
    return empty;
  }
  if (!raw) {
    console.log(`[social-stats] lane2 web_search timed out for @${handle} in ${Date.now() - t0}ms`);
    return empty;
  }
  let parsed = null;
  try {
    const cleaned = String(raw).replace(/```json/gi, '').replace(/```/g, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch (e) {
    console.warn('[social-stats] lane2 JSON parse failed:', e.message);
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[, %]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const followers = toNum(parsed.followers);
  let engagement = toNum(parsed.engagement_rate);
  if (engagement !== null && (engagement > 100 || engagement < 0)) engagement = null;
  const found = parsed.found === true && (followers !== null || engagement !== null);
  console.log(`[social-stats] lane2 web_search ${found ? 'HIT' : 'MISS'} for @${handle} in ${Date.now() - t0}ms`);
  return {
    followers: followers === null ? null : Math.round(followers),
    engagement_rate: engagement === null ? null : Math.round(engagement * 10) / 10,
    source: found ? (parsed.source ? String(parsed.source).slice(0, 200) : 'Public web sources') : null,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    found,
  };
}

// ── LANE 3: honest engagement suggestion by follower tier ───────────────────
// Exact ER is not public for small accounts. This is a SUGGESTION shown as
// helper text in the UI, never data, never saved as a value.
function engagementSuggestion(followers) {
  if (!Number.isFinite(followers)) return 'No published rate found. Typical range is 1 to 5 percent.';
  if (followers < 10000) return 'No published rate found. Accounts this size typically run 4 to 8 percent.';
  if (followers <= 100000) return 'No published rate found. Accounts this size typically run 2 to 5 percent.';
  return 'No published rate found. Accounts this size typically run 1 to 3 percent.';
}

app.post('/api/athletes/:id/fetch-social-stats', requireAuth, statsLimiter, async (req, res) => {
  const handle = normalizeHandle(req.body.instagramHandle);
  if (!handle) return res.status(400).json({ error: 'instagramHandle required' });

  const id = req.params.id;
  const isNew = id === 'new';

  // For a real athlete, confirm ownership before spending an API call or caching.
  let athlete = null;
  if (!isNew) {
    athlete = await store.getAthlete(id);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const user = await store.getUser(req.session.userId);
    if (athlete.agentId !== req.session.userId && (!user || user.email !== ADMIN_EMAIL)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  // ── Layered pipeline ────────────────────────────────────────────────────
  // Lane 1: direct Instagram page metadata (exact, any account size, <5s).
  // Lane 2: AI web search targeting the profile snippet first (<15s).
  // Followers from lane 1 always win. Total budget ~20s worst case.
  const _t0 = Date.now();
  const page = await fetchInstagramPageMeta(handle);

  let followers = null, followersSource = null;
  let engagement = null, engagementSource = null;
  let posts = null, sourceText = null, confidence = 'low';

  if (page && page.followers !== null) {
    followers = page.followers;
    followersSource = 'instagram_page';
    posts = page.posts;
    sourceText = 'Instagram profile page metadata';
    confidence = 'high';
  } else {
    const search = await fetchInstagramStatsViaSearch(handle);
    if (search.followers !== null) { followers = search.followers; followersSource = 'web_search'; }
    if (search.engagement_rate !== null) { engagement = search.engagement_rate; engagementSource = 'web_search'; }
    sourceText = search.source;
    confidence = search.confidence;
  }
  const found = followers !== null || engagement !== null;
  const fetchedAt = new Date().toISOString();
  console.log(`[social-stats] @${handle} resolved via ${followersSource || 'none'} (followers=${followers === null ? 'null' : followers}, er=${engagement === null ? 'null' : engagement}) in ${Date.now() - _t0}ms`);

  // Cache onto the athlete record (agent-managed profile lives in data JSONB).
  // The handle always saves. Numbers, the source label, and the fetched-at
  // timestamp only update when a real value was actually found, so a failed
  // lookup never relabels a manually entered number.
  if (!isNew && athlete) {
    try {
      const merged = { ...athlete, agentId: athlete.agentId };
      merged.instagramHandle = handle;
      if (found) {
        if (followers !== null) merged.instagram = followers;
        if (engagement !== null) merged.engagement = engagement;
        merged.igStatsSource = followersSource === 'instagram_page' ? 'instagram_page' : 'web_estimate';
        merged.igStatsFetchedAt = fetchedAt;
      }
      // Posts count is exact page data; keep it whenever lane 1 saw it (useful
      // once Instagram OAuth lands).
      if (posts !== null) merged.igPosts = posts;
      await store.saveAthlete(id, merged);
    } catch (e) {
      console.warn('[social-stats] cache write failed:', e.message);
    }
  }

  res.json({
    handle,
    followers,
    engagement_rate: engagement,
    posts,
    followers_source: followersSource,
    engagement_source: engagementSource,
    // Suggestion only, shown as helper text in the UI, never saved as a value.
    engagement_suggestion: engagement === null ? engagementSuggestion(followers === null ? NaN : followers) : null,
    source: sourceText,
    confidence,
    found,
    // Legacy field kept for compatibility with older clients.
    stats_source: followersSource === 'instagram_page' ? 'instagram_page' : 'web_estimate',
    fetched_at: fetchedAt,
  });
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
  checkOff(req.session.userId, 'rate_calc'); // Getting Started checklist
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
app.post('/api/ai/ask', requireAuth, aiLimiter, async (req, res) => {
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
    checkOff(req.session.userId, 'ai_outreach'); // Getting Started checklist
    const parsedOut = JSON.parse(match[0]);
    // Attach the brand-personalized media kit link automatically when one exists
    const kitUrl = await findKitVariantUrl(athleteId, brand);
    if (kitUrl) {
      const firstName = (athlete.name || '').split(/\s+/)[0] || 'the athlete';
      if (parsedOut.email) parsedOut.email += `\n\nP.S. Here is ${firstName}'s media kit, put together for ${brand}: ${kitUrl}`;
      parsedOut.kitUrl = kitUrl;
    }
    res.json(parsedOut);
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
app.post('/api/ai/player-fetch', requireAuth, aiLimiter, async (req, res) => {
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
// ── Multi-Stage Athlete Entity Resolution ─────────────────────────────────
// Stage 1: Normalize inputs (school aliases, sport variants)
// Stage 2A: ESPN live roster fetch → name scoring (fast, authoritative)
// Stage 2B: AI enrichment/fallback (stats, social, career context)
// Stage 3: Merge, rank, return up to 3 candidates with confidence scores
app.post('/api/ai/player-lookup', requireAuth, aiLimiter, async (req, res) => {
  const { name, school, sport, position, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { resolveAthlete } = require('./services/athleteLookup');
    const result = await resolveAthlete(ai, { name, school, sport, position, year });
    res.json(result);
  } catch (err) {
    console.error('[player-lookup]', err.message);
    res.status(500).json({ found: false, candidates: [], message: 'Search unavailable. Please fill in details manually.' });
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

// ── Agent Intelligence: Daily Actions ─────────────────────────────
app.post('/api/intelligence/daily-actions', requireAuth, aiLimiter, async (req, res) => {
  try {
    const agentAthletes = await store.getAthletesByAgent(req.session.userId);
    const agentDeals    = await store.getDealsByAgent(req.session.userId);

    if (!agentAthletes.length) {
      return res.json({ actions: [], generated: new Date().toISOString() });
    }

    // Build concise CRM snapshot (cap at 20 athletes to keep prompt tight)
    const athleteContext = agentAthletes.slice(0, 20).map(a => {
      const myDeals   = agentDeals.filter(d => d.athleteId === a.id);
      const latest    = myDeals.reduce((best, d) => {
        const dt = new Date(d.updatedAt || d.createdAt || 0);
        return dt > best ? dt : best;
      }, new Date(0));
      const daysSince = myDeals.length ? Math.floor((Date.now() - latest.getTime()) / 86400000) : -1;
      const status    = a.relationshipStatus || (
        myDeals.some(d => d.stage === 'Closed')                                        ? 'signed' :
        myDeals.some(d => ['Closing', 'Negotiating'].includes(d.stage))                ? 'in-discussion' :
        myDeals.some(d => d.stage === 'Outreach Sent' || d.stage === 'Prospecting')    ? 'outreach-sent' :
        myDeals.length > 0                                                              ? 'outreach-sent' :
                                                                                          'not-contacted'
      );
      const activeDeals = myDeals.filter(d => d.stage && d.stage !== 'Closed').length;
      const yearFlag    = (a.year || '').toLowerCase().includes('sr') ? ' [SENIOR]' : '';
      return `${a.name} (${a.sport || 'unknown'}@${a.school || 'unknown'}${yearFlag}): ` +
             `status=${status} active_deals=${activeDeals} last_contact=${daysSince < 0 ? 'NEVER' : daysSince + 'd_ago'}`;
    }).join('\n');

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const prompt =
`You are an AI assistant for a professional NIL sports agent. Based on their CRM data, generate today's top 6 priority actions.

CRM SNAPSHOT (${agentAthletes.length} total athletes):
${athleteContext}

Today: ${today}

RULES:
- Reference specific athletes by name from the roster above
- Prioritize: athletes not contacted in 14+ days, stalled deals, seniors (graduation = lost client), hot opportunities
- Be concrete: "Text Marcus to schedule Nike call" not "follow up with client"
- Assign 2 HIGH, 3 MEDIUM, 1 LOW priorities
- Vary action types: mix phone calls, emails, deal reviews, and opportunity checks

Return ONLY a valid JSON array of exactly 6 objects:
[{"priority":"HIGH","action":"Call [Name] to follow up on [Brand] deal","why":"Deal stalled in Negotiating for 21 days — window closing fast","athlete":"[Name]","type":"follow-up"}]

Valid types: follow-up, outreach, review, opportunity, alert`;

    const raw = await ai.oneShot(
      prompt,
      'You are a NIL agent AI assistant. Return ONLY a valid JSON array. No markdown fences, no preamble, no explanation.',
      3000
    );

    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const si = cleaned.indexOf('[');
    const ei = cleaned.lastIndexOf(']');
    if (si === -1 || ei <= si) throw new Error('No JSON array in AI response');

    const actions = JSON.parse(cleaned.substring(si, ei + 1));
    res.json({ actions: actions.slice(0, 8), generated: new Date().toISOString() });
  } catch (e) {
    console.error('daily-actions error:', e.message);
    res.status(500).json({ error: 'AI service error: ' + e.message });
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

DRAFTING STYLE — draft this as a practicing sports and entertainment attorney would:
- Open with a formal preamble naming the parties and the Effective Date, then WHEREAS recitals, then a NOW, THEREFORE clause.
- Define and capitalize key terms on first use: the Athlete, the Brand, the Agency, this Agreement, the Term, the Services, the Compensation.
- Use operative legal language throughout: shall, shall not, including without limitation, notwithstanding the foregoing. Reference defined terms, not casual descriptions.
- Number every section with sub-sections (1, 1.1, 1.2). Clauses are precise and self-contained, with no commentary explaining what a clause does and no marketing language.
- Include the boilerplate parties expect: severability, entire agreement, amendment in writing, assignment, notices, force majeure, counterparts and electronic signature.
- This is a legally operative document, not a summary or description of one.

Use professional legal language. Include specific dollar amounts and dates. Add FTC disclosure language. Make it ready to sign.`;

  try {
    const contract = await ai.oneShot(prompt, "You are a practicing sports and entertainment attorney drafting a binding NIL endorsement agreement. Output ONLY the contract itself, exactly as it would appear in a law firm's document: formal recitals, defined and capitalized terms, numbered sections and sub-sections (1., 1.1, 1.2), and precise operative language using shall. Never use markdown, hashtags, bullet dashes, or em dashes. Never include explanatory or conversational text, and never write phrases a real contract would not contain (no 'in today's landscape', 'it is important to note', 'please note', 'this contract ensures', 'we'). Plain-text legal formatting only.", 4000);
    if (!contract || contract.length < 100) throw new Error('Contract generation failed');
    res.json({ contract, athleteName: athlete.name, brand, value });
  } catch (err) {
    console.error('Contract error:', err.message);
    // Retry with shorter prompt
    try {
      const shortPrompt = 'Generate a professional NIL contract between ' + athlete.name + ' (' + athlete.sport + ' at ' + (athlete.school||'university') + ') and ' + brand + ' for $' + parseInt(value||0).toLocaleString() + '. Deal type: ' + (dealType||'Social Media') + '. Deliverables: ' + (deliverables||'3 Instagram posts') + '. Include: parties, scope, compensation, term, exclusivity, usage rights, FTC disclosure, and signature lines. Use professional legal language.';
      const contract = await ai.oneShot(shortPrompt, "You are a practicing sports and entertainment attorney drafting a binding NIL endorsement agreement. Output ONLY the contract itself, exactly as it would appear in a law firm's document: formal recitals, defined and capitalized terms, numbered sections and sub-sections (1., 1.1, 1.2), and precise operative language using shall. Never use markdown, hashtags, bullet dashes, or em dashes. Never include explanatory or conversational text, and never write phrases a real contract would not contain (no 'in today's landscape', 'it is important to note', 'please note', 'this contract ensures', 'we'). Plain-text legal formatting only.");
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

// ── Contract Upload Pipeline (production-grade, idempotent) ──────────────
const multer  = require('multer');
const { processContractUpload, writeAudit } = require('./services/contractExtraction');
const { generateDates, toRRule, describeRRule } = require('./services/calendarRecurrence');

const contractUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' ||
               file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
               file.mimetype === 'application/msword';
    cb(ok ? null : new Error('Only PDF and DOCX files are accepted'), ok);
  },
});

// ── Ownership guard (reusable) ─────────────────────────────────────────────
async function requireAthleteOwner(req, res) {
  const athlete = await store.getAthlete(req.params.id);
  if (!athlete) { res.status(404).json({ error: 'Athlete not found' }); return null; }
  if (athlete.agentId !== req.session.userId) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return athlete;
}

// ── POST /api/athletes/:id/contracts/extract ──────────────────────────────
// Upload PDF/DOCX → AI extracts deliverables → atomic DB write → calendar events
app.post('/api/athletes/:id/contracts/extract', requireAuth, requireAgentSubscription, aiLimiter, contractUpload.single('contract'), async (req, res) => {
  try {
    const athleteId = req.params.id;
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await processContractUpload({
      pool:      store.pool,
      ai,
      athleteId,
      agentId:   req.session.userId,
      file:      req.file,
      brandHint: req.body.brand || null,
    });

    if (result.duplicate) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        message: 'Contract already processed. Returning existing data.',
        ...result,
      });
    }

    const statusCode = result.extractionStatus === 'completed' ? 200 : 202;
    checkOff(req.session.userId, 'contract_scan'); // Getting Started checklist
    res.status(statusCode).json({ ok: true, ...result });
  } catch (e) {
    console.error('[contract extract]', e.message);
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message || 'Contract extraction failed' });
  }
});

// ── GET /api/athletes/:id/contracts ──────────────────────────────────────
app.get('/api/athletes/:id/contracts', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;
    const r = await store.pool.query(
      `SELECT id, athlete_id, agent_id, filename, brand, start_date, end_date,
              extraction_status, uploaded_at
         FROM athlete_contracts
        WHERE athlete_id=$1 AND agent_id=$2
        ORDER BY uploaded_at DESC`,
      [req.params.id, req.session.userId]
    );
    res.json({ contracts: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/athletes/:id/contracts/:cid ───────────────────────────────
// Cascade: deletes deliverables + calendar events for this contract
app.delete('/api/athletes/:id/contracts/:cid', requireAuth, async (req, res) => {
  const client = await store.pool.connect();
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    await client.query('BEGIN');
    // Delete calendar events first (FK to deliverables)
    await client.query(
      `DELETE FROM athlete_calendar_events WHERE contract_id=$1 AND agent_id=$2`,
      [req.params.cid, req.session.userId]
    );
    // Delete deliverables
    await client.query(
      `DELETE FROM athlete_deliverables WHERE contract_id=$1 AND agent_id=$2`,
      [req.params.cid, req.session.userId]
    );
    // Delete contract
    await client.query(
      `DELETE FROM athlete_contracts WHERE id=$1 AND agent_id=$2`,
      [req.params.cid, req.session.userId]
    );
    await client.query('COMMIT');

    await writeAudit(store.pool, {
      agentId: req.session.userId, athleteId: req.params.id, contractId: req.params.cid,
      actionType: 'contract_deleted', status: 'deleted',
    });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── GET /api/athletes/:id/deliverables ────────────────────────────────────
app.get('/api/athletes/:id/deliverables', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    const { brand, status, contract_id } = req.query;
    let sql = `SELECT * FROM athlete_deliverables WHERE athlete_id=$1 AND agent_id=$2`;
    const params = [req.params.id, req.session.userId];
    if (brand)       { sql += ` AND brand ILIKE $${params.push('%' + brand + '%')}`; }
    if (status)      { sql += ` AND status=$${params.push(status)}`; }
    if (contract_id) { sql += ` AND contract_id=$${params.push(contract_id)}`; }
    sql += ` ORDER BY due_date ASC NULLS LAST, sort_order ASC`;

    const r = await store.pool.query(sql, params);
    res.json({ deliverables: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/athletes/:id/deliverables/:did ─────────────────────────────
app.patch('/api/athletes/:id/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    const allowed = ['status', 'due_date', 'brand', 'deliverable_description'];
    const updates = [];
    const params  = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        updates.push(`${field}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(true); updates.push(`manually_edited=$${params.length}`);
    params.push(req.params.did, req.params.id, req.session.userId);

    const r = await store.pool.query(
      `UPDATE athlete_deliverables SET ${updates.join(',')}
        WHERE id=$${params.length - 2} AND athlete_id=$${params.length - 1} AND agent_id=$${params.length}
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Deliverable not found' });
    res.json({ deliverable: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/athletes/:id/deliverables/:did ────────────────────────────
app.delete('/api/athletes/:id/deliverables/:did', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    // Remove associated generated calendar events too
    await store.pool.query(
      `DELETE FROM athlete_calendar_events WHERE deliverable_id=$1 AND agent_id=$2 AND manually_modified=FALSE`,
      [req.params.did, req.session.userId]
    );
    await store.pool.query(
      `DELETE FROM athlete_deliverables WHERE id=$1 AND athlete_id=$2 AND agent_id=$3`,
      [req.params.did, req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/athletes/:id/calendar ────────────────────────────────────────
// Returns calendar events for a given month (or all) — athlete-scoped, agent-owned
app.get('/api/athletes/:id/calendar', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    const { year, month, brand, contract_id } = req.query;
    let sql = `SELECT ace.*, ad.ai_confidence_score, ad.source as deliverable_source
                 FROM athlete_calendar_events ace
                 LEFT JOIN athlete_deliverables ad ON ad.id = ace.deliverable_id
                WHERE ace.athlete_id=$1 AND ace.agent_id=$2`;
    const params = [req.params.id, req.session.userId];

    if (year && month) {
      const y = parseInt(year, 10), m = parseInt(month, 10);
      const start = `${y}-${String(m).padStart(2,'0')}-01`;
      const endDt = new Date(y, m, 0);
      const end   = `${y}-${String(m).padStart(2,'0')}-${endDt.getDate()}`;
      params.push(start, end);
      sql += ` AND ace.event_date BETWEEN $${params.length - 1} AND $${params.length}`;
    }
    if (brand)       { params.push('%' + brand + '%');       sql += ` AND ace.brand ILIKE $${params.length}`; }
    if (contract_id) { params.push(contract_id);             sql += ` AND ace.contract_id=$${params.length}`; }
    sql += ` ORDER BY ace.event_date ASC, ace.brand ASC`;

    const r = await store.pool.query(sql, params);
    res.json({ events: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/athletes/:id/calendar/generate ──────────────────────────────
// Regenerate calendar events from all deliverables (preserves manually_modified)
app.post('/api/athletes/:id/calendar/generate', requireAuth, requireAgentSubscription, async (req, res) => {
  const client = await store.pool.connect();
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    const athleteId = req.params.id;
    const agentId   = req.session.userId;
    const { contract_id } = req.body; // optional: regenerate for one contract only

    await client.query('BEGIN');

    // Delete generated events that have NOT been manually modified
    let delSql = `DELETE FROM athlete_calendar_events
                   WHERE athlete_id=$1 AND agent_id=$2 AND is_generated=TRUE AND manually_modified=FALSE`;
    const delParams = [athleteId, agentId];
    if (contract_id) { delParams.push(contract_id); delSql += ` AND contract_id=$3`; }
    await client.query(delSql, delParams);

    // Fetch deliverables to regenerate
    let dSql = `SELECT * FROM athlete_deliverables WHERE athlete_id=$1 AND agent_id=$2`;
    const dParams = [athleteId, agentId];
    if (contract_id) { dParams.push(contract_id); dSql += ` AND contract_id=$3`; }
    const deliverables = await client.query(dSql, dParams);

    const { brandColor } = require('./services/contractExtraction');
    let generated = 0;
    const eventsToGCal = [];

    for (const d of deliverables.rows) {
      const rrule = d.recurrence_rule || toRRule(d.recurrence, null);
      if (!rrule || !d.due_date) continue;

      const dates = generateDates(rrule, d.due_date.toISOString().split('T')[0]);
      const color = brandColor(d.brand);

      for (const date of dates) {
        const id = 'evt-' + require('crypto').randomBytes(8).toString('hex');
        await client.query(
          `INSERT INTO athlete_calendar_events
             (id, athlete_id, agent_id, deliverable_id, contract_id, title, event_date,
              brand, color, status, is_generated, recurrence_instance, manually_modified)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',TRUE,TRUE,FALSE)
           ON CONFLICT (deliverable_id, event_date) DO NOTHING`,
          [id, athleteId, agentId, d.id, d.contract_id, d.deliverable_description,
           date, d.brand, color]
        );
        generated++;
        eventsToGCal.push({ id, title: d.deliverable_description, event_date: date, brand: d.brand, notes: d.notes || '' });
      }
    }

    await client.query('COMMIT');
    // Fire-and-forget: push newly generated events to athlete's Google Calendar (if connected)
    eventsToGCal.forEach(ev => _pushEventToGCal(athleteId, ev));

    await writeAudit(store.pool, {
      agentId, athleteId, contractId: contract_id || null,
      actionType: 'calendar_regenerated', status: 'completed',
      metadata: { generated, contract_id: contract_id || 'all' },
    });

    res.json({ ok: true, generated });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── PATCH /api/athletes/:id/calendar/:eid ────────────────────────────────
// Manual edit of a calendar event — marks manually_modified=TRUE so regen preserves it
app.patch('/api/athletes/:id/calendar/:eid', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;

    const allowed = ['title', 'event_date', 'status', 'notes', 'brand'];
    const updates = [];
    const params  = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        updates.push(`${field}=$${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(true); updates.push(`manually_modified=$${params.length}`);
    params.push(req.params.eid, req.params.id, req.session.userId);

    const r = await store.pool.query(
      `UPDATE athlete_calendar_events SET ${updates.join(',')}
        WHERE id=$${params.length - 2} AND athlete_id=$${params.length - 1} AND agent_id=$${params.length}
        RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Calendar event not found' });
    res.json({ event: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/athletes/:id/calendar/:eid ───────────────────────────────
app.delete('/api/athletes/:id/calendar/:eid', requireAuth, async (req, res) => {
  try {
    const athlete = await requireAthleteOwner(req, res);
    if (!athlete) return;
    await store.pool.query(
      `DELETE FROM athlete_calendar_events WHERE id=$1 AND athlete_id=$2 AND agent_id=$3`,
      [req.params.eid, req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/contracts/audit ─────────────────────────────────────────────
// Agent audit log — paginated, agent-scoped
app.get('/api/contracts/audit', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);
    const r = await store.pool.query(
      `SELECT * FROM contract_audit_log WHERE agent_id=$1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.session.userId, limit, offset]
    );
    res.json({ entries: r.rows, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── Admin: seed (or reset) the demo account ──────────────────
// Runs the idempotent demo seeder against this deployment so the marketing demo
// can be re-shot anytime. Everything it writes is fictional and scoped to the
// demo agent only. Admin/founder gated. See server/scripts/seedDemo.js.
app.post('/api/admin/seed-demo', requireAuth, async (req, res) => {
  const user = await store.getUser(req.session.userId);
  if (!user || (user.email !== ADMIN_EMAIL && !isFounderEmail(user.email) && user.role !== 'admin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { seedDemo } = require('./scripts/seedDemo');
    const result = await seedDemo(store.pool);
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    console.log(`[admin/seed-demo] demo account seeded by ${user.email}`);
    res.json({ ok: true, ...result, mediaKitUrl: appUrl + result.mediaKitUrl, averyKitUrl: appUrl + result.averyKitUrl });
  } catch (e) {
    console.error('[admin/seed-demo]', e.message);
    res.status(500).json({ error: e.message });
  }
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
app.post('/api/ai/help', requireAuth, aiLimiter, async (req, res) => {
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

app.get('/athletes', (req, res) => {
  res.sendFile(require('path').join(__dirname, '..', 'public', 'athletes.html'));
});

// ══════════════════════════════════════════════════════════════════
// ATHLETE SELF-SERVE AUTH ROUTES (JWT-based, separate from session auth)
// ══════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
// Fail closed: never fall back to a hardcoded secret (a known fallback lets
// anyone forge athlete tokens). Require a real secret from the environment.
const ATHLETE_JWT_SECRET = process.env.ATHLETE_JWT_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET;
if (!ATHLETE_JWT_SECRET) {
  throw new Error('ATHLETE_JWT_SECRET (or JWT_SECRET / SESSION_SECRET) must be set — refusing to start with an insecure default athlete-auth secret.');
}

// Middleware: verify athlete JWT from Authorization: Bearer header
function verifyAthleteToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Athlete token required' });
  try {
    const decoded = jwt.verify(auth.slice(7), ATHLETE_JWT_SECRET);
    if (decoded.role !== 'athlete') return res.status(403).json({ error: 'Not an athlete token' });
    req.athlete = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/athlete/verify-token/:token — public
app.get('/api/athlete/verify-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    console.log(`[athlete/verify-token] Verifying token: ...${token.slice(-12)}`);
    const r = await store.pool.query(
      `SELECT ait.*, a.data, a.agent_id,
              a.data->>'name' as athlete_name,
              a.data->>'sport' as sport,
              a.data->>'school' as school,
              a.data->>'position' as position,
              u.name as agent_name,
              NULL::TEXT as agency_name
       FROM athlete_invite_tokens ait
       JOIN athletes a ON ait.athlete_id = a.id
       LEFT JOIN users u ON a.agent_id = u.id
       WHERE ait.token = $1`,
      [token]
    );
    console.log(`[athlete/verify-token] Query returned ${r.rows.length} row(s)`);
    if (!r.rows.length) {
      console.log(`[athlete/verify-token] Token not found in athlete_invite_tokens`);
      return res.json({ valid: false, message: 'This invite link is invalid or has expired. Contact your agent for a new link.' });
    }
    const row = r.rows[0];
    if (row.used) {
      console.log(`[athlete/verify-token] Token already used for athlete=${row.athlete_id}`);
      return res.json({ valid: false, message: 'This invite link has already been used. Try logging in instead.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      console.log(`[athlete/verify-token] Token expired at ${row.expires_at}`);
      return res.json({ valid: false, message: 'This invite link has expired. Contact your agent for a new link.' });
    }

    // Extract first/last name from data
    const fullName = row.athlete_name || '';
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    console.log(`[athlete/verify-token] Valid token for athlete=${row.athlete_id} name="${row.athlete_name}"`);
    res.json({
      valid: true,
      athlete: { first_name: firstName, last_name: lastName, sport: row.sport, school: row.school, position: row.position, full_name: fullName },
      agent: { name: row.agent_name || 'Your Agent', agency_name: row.agency_name || '' },
    });
  } catch (e) {
    console.error('[athlete/verify-token] SQL error:', e.message);
    res.json({ valid: false, message: 'This invite link is invalid or has expired. Contact your agent for a new link.' });
  }
});

// POST /api/athlete/activate — public
app.post('/api/athlete/activate', authLimiter, async (req, res) => {
  try {
    const { token, email, password, phone, instagram_handle, tiktok_handle, twitter_handle } = req.body;
    console.log(`[athlete/activate] Called with token=...${(token||'').slice(-12)} email=${email}`);
    if (!token || !email || !password) return res.status(400).json({ error: 'token, email, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const r = await store.pool.query(
      `SELECT ait.*, a.data, a.agent_id,
              a.data->>'name' as athlete_name,
              u.name as agent_name,
              NULL::TEXT as agency_name,
              a.data->>'sport' as sport,
              a.data->>'school' as school
       FROM athlete_invite_tokens ait
       JOIN athletes a ON ait.athlete_id = a.id
       LEFT JOIN users u ON a.agent_id = u.id
       WHERE ait.token = $1`,
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid invite token' });
    const row = r.rows[0];
    if (row.used) return res.status(400).json({ error: 'This invite link has already been used. Try logging in.' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'This invite link has expired. Contact your agent.' });

    // Check email not already taken by another athlete
    const emailCheck = await store.pool.query('SELECT id FROM athletes WHERE email = $1 AND id != $2', [email.toLowerCase().trim(), row.athlete_id]);
    if (emailCheck.rows.length) return res.status(400).json({ error: 'This email is already registered. Try logging in instead.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const normalizedEmail = email.toLowerCase().trim();

    // Update athlete record with credentials + social handles
    await store.pool.query(
      `UPDATE athletes SET
         email = $1, password_hash = $2, phone = $3,
         instagram_handle = $4, tiktok_handle = $5, twitter_handle = $6,
         onboarding_complete = TRUE, account_activated_at = NOW()
       WHERE id = $7`,
      [normalizedEmail, passwordHash, phone || null,
       instagram_handle ? instagram_handle.replace(/^@/, '') : null,
       tiktok_handle ? tiktok_handle.replace(/^@/, '') : null,
       twitter_handle ? twitter_handle.replace(/^@/, '') : null,
       row.athlete_id]
    );

    // Mark token as used
    await store.pool.query('UPDATE athlete_invite_tokens SET used = TRUE, used_at = NOW() WHERE token = $1', [token]);

    // Issue JWT
    const jwtPayload = {
      id: row.athlete_id,
      email: normalizedEmail,
      role: 'athlete',
      agent_id: row.agent_id,
      athlete_name: row.athlete_name || '',
    };
    const athleteJwt = jwt.sign(jwtPayload, ATHLETE_JWT_SECRET, { expiresIn: '30d' });

    console.log(`[athlete/activate] activated athlete=${row.athlete_id} email=${normalizedEmail}`);
    res.json({
      token: athleteJwt,
      athlete: {
        id: row.athlete_id,
        name: row.athlete_name,
        sport: row.sport,
        school: row.school,
        agent_name: row.agent_name,
        agency_name: row.agency_name,
      },
    });
  } catch (e) {
    console.error('[athlete/activate]', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Activation failed' });
  }
});

// POST /api/athlete/login — public
app.post('/api/athlete/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const r = await store.pool.query(
      `SELECT a.*, a.data->>'name' as athlete_name, a.data->>'sport' as sport, a.data->>'school' as school,
              u.name as agent_name, NULL::TEXT as agency_name
       FROM athletes a
       LEFT JOIN users u ON a.agent_id = u.id
       WHERE a.email = $1 AND a.onboarding_complete = TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const athlete = r.rows[0];
    if (!athlete.password_hash) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, athlete.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Update last login
    await store.pool.query('UPDATE athletes SET last_login = NOW() WHERE id = $1', [athlete.id]);

    const jwtPayload = {
      id: athlete.id,
      email: athlete.email,
      role: 'athlete',
      agent_id: athlete.agent_id,
      athlete_name: athlete.athlete_name || '',
    };
    const athleteJwt = jwt.sign(jwtPayload, ATHLETE_JWT_SECRET, { expiresIn: '30d' });

    console.log(`[athlete/login] athlete=${athlete.id} email=${athlete.email}`);
    res.json({
      token: athleteJwt,
      athlete: {
        id: athlete.id,
        name: athlete.athlete_name,
        sport: athlete.sport,
        school: athlete.school,
        agent_name: athlete.agent_name,
        agency_name: athlete.agency_name,
      },
    });
  } catch (e) {
    console.error('[athlete/login]', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/athlete/me — requires verifyAthleteToken
app.get('/api/athlete/me', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT a.*, a.data->>'name' as athlete_name, a.data->>'sport' as sport,
              a.data->>'school' as school, a.data->>'position' as position,
              a.data->>'followers_ig' as followers_ig, a.data->>'followers_tiktok' as followers_tiktok,
              u.name as agent_name, NULL::TEXT as agency_name,
              ai.visibility,
              (SELECT slug FROM media_kits WHERE athlete_id = a.id AND slug IS NOT NULL LIMIT 1) as media_kit_slug
       FROM athletes a
       LEFT JOIN users u ON a.agent_id = u.id
       LEFT JOIN athlete_invites ai ON ai.athlete_id = a.id
       WHERE a.id = $1`,
      [req.athlete.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const ath = r.rows[0];
    const visibility = ath.visibility || { rate: true, deals: true, contracts: true, brands: false, compliance: true };

    // Get upcoming deliverables
    const deliverables = await store.pool.query(
      `SELECT ace.title, ace.event_date, ace.status, ace.brand
       FROM athlete_calendar_events ace
       WHERE ace.athlete_id = $1
         AND ace.event_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY ace.event_date ASC LIMIT 20`,
      [req.athlete.id]
    );

    res.json({
      id: ath.id,
      name: ath.athlete_name || (ath.data && ath.data.name) || '',
      sport: ath.sport,
      school: ath.school,
      position: ath.position,
      state: ath.state || null,
      email: ath.email,
      phone: ath.phone,
      instagram_handle: ath.instagram_handle,
      tiktok_handle: ath.tiktok_handle,
      twitter_handle: ath.twitter_handle,
      // Follower counts — prefer dedicated columns (self-signup), fall back to data JSON (agent-managed)
      instagram_followers: ath.instagram_followers != null ? ath.instagram_followers : (ath.followers_ig != null ? parseInt(ath.followers_ig) : null),
      tiktok_followers: ath.tiktok_followers != null ? ath.tiktok_followers : (ath.followers_tiktok != null ? parseInt(ath.followers_tiktok) : null),
      twitter_followers: ath.twitter_followers != null ? ath.twitter_followers : null,
      followers_ig: ath.followers_ig,
      agent_name: ath.agent_name,
      agency_name: ath.agency_name,
      agent_id: ath.agent_id,
      visibility,
      deliverables: deliverables.rows,
      onboarding_state: ath.onboarding_state || {},
      media_kit_slug: ath.media_kit_slug || null,
    });
  } catch (e) {
    console.error('[athlete/me]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ATHLETE SELF-SIGNUP FLOW
// ══════════════════════════════════════════════════════════════════

// POST /api/athlete/self-signup — public, creates unverified athlete + sends verification email
app.post('/api/athlete/self-signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password, school, sport, position,
            instagram_followers, tiktok_followers, twitter_followers } = req.body;

    if (!name || !email || !password || !school || !sport)
      return res.status(400).json({ error: 'Name, email, password, school, and sport are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const normalizedEmail = email.toLowerCase().trim();
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(normalizedEmail))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Check if email already registered (case-insensitive)
    const existing = await store.pool.query('SELECT id FROM athletes WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length)
      return res.status(400).json({ error: 'An account with this email already exists. Try logging in.' });

    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const athleteId = 'self-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');

    try {
      await store.pool.query(
        `INSERT INTO athletes (id, agent_id, data, email, password_hash,
           athlete_type, email_verified, email_verify_token, email_verify_expires,
           subscription_status, instagram_followers, tiktok_followers, twitter_followers,
           onboarding_complete, created_at, updated_at)
         VALUES ($1, NULL, $2, $3, $4, 'self_managed', FALSE, $5, $6,
                 'inactive', $7, $8, $9, FALSE, NOW(), NOW())`,
        [
          athleteId,
          JSON.stringify({ name, sport, school, position: position || null }),
          normalizedEmail,
          passwordHash,
          verifyToken,
          verifyExpires,
          instagram_followers ? parseInt(instagram_followers) : null,
          tiktok_followers ? parseInt(tiktok_followers) : null,
          twitter_followers ? parseInt(twitter_followers) : null,
        ]
      );
    } catch (insErr) {
      // Unique-violation = a concurrent signup won the race for this email.
      if (insErr.code === '23505')
        return res.status(400).json({ error: 'An account with this email already exists. Try logging in.' });
      throw insErr;
    }

    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const verifyUrl = `${appUrl}/api/athlete/verify-email?token=${verifyToken}`;

    // Always log the verify URL so we can manually verify during testing / if email fails
    console.log(`[self-signup] verify-url athlete=${athleteId} email=${normalizedEmail} url=${verifyUrl}`);

    try {
      const emailResult = await resend.emails.send({
        from: 'NILDash <noreply@mynildash.com>',
        to: normalizedEmail,
        subject: 'Verify your NILDash account',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#0A0E1A;margin-bottom:8px">
              NIL<span style="color:#C8FF00">DASH</span>
            </div>
            <h2 style="font-size:18px;font-weight:700;margin-bottom:16px;color:#0A0E1A">Verify your email to get started</h2>
            <p style="color:#374151;font-size:15px;line-height:1.6;margin-bottom:24px">
              Hi ${name.split(' ')[0]}, you're one step away from your free NILDash portal.
              Click below to verify your email and jump right in — no card required.
            </p>
            <a href="${verifyUrl}"
               style="display:inline-block;background:#C8FF00;color:#0A0E1A;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">
              Verify Email &amp; Continue →
            </a>
            <p style="color:#6B7280;font-size:12px;margin-top:24px">
              This link expires in 7 days. If you didn't sign up for NILDash, you can safely ignore this email.
            </p>
          </div>
        `,
      });
      console.log(`[self-signup] Email sent ok id=${emailResult && emailResult.id ? emailResult.id : 'n/a'} to=${normalizedEmail}`);
    } catch (emailErr) {
      // Log the full error object so Resend status codes / error codes are visible in Railway logs
      console.error('[self-signup] Email send failed — full error:', JSON.stringify(emailErr, Object.getOwnPropertyNames(emailErr)));
      console.error('[self-signup] Email message:', emailErr.message);
      // Fallback: verify URL already logged above — admin can paste it directly to verify the account
      console.log(`[self-signup] FALLBACK verify-url (email failed): ${verifyUrl}`);
      // Do NOT abort — account was created, athlete can resend or be manually verified
    }

    console.log(`[self-signup] Created athlete ${athleteId} email=${normalizedEmail}`);
    res.json({ ok: true, message: 'Check your email to verify your account.' });
  } catch (e) {
    console.error('[self-signup]', e.message, e.stack);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// POST /api/athlete/resend-verification — re-issue a verification email
// (e.g. the original Resend send failed). Always responds 200 to avoid leaking
// which emails are registered.
app.post('/api/athlete/resend-verification', authLimiter, async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const r = await store.pool.query(
      `SELECT id, data, email, email_verified FROM athletes WHERE LOWER(email) = $1`, [email]);
    const athlete = r.rows[0];

    // Only act for an existing, still-unverified account. Respond identically
    // either way so attackers can't enumerate accounts.
    if (athlete && !athlete.email_verified) {
      const crypto = require('crypto');
      const verifyToken = crypto.randomBytes(32).toString('hex');
      const verifyExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await store.pool.query(
        `UPDATE athletes SET email_verify_token=$1, email_verify_expires=$2, updated_at=NOW() WHERE id=$3`,
        [verifyToken, verifyExpires, athlete.id]
      );

      const appUrl = process.env.APP_URL || 'https://mynildash.com';
      const verifyUrl = `${appUrl}/api/athlete/verify-email?token=${verifyToken}`;
      const name = (athlete.data && athlete.data.name) ? athlete.data.name : 'there';
      console.log(`[resend-verification] verify-url athlete=${athlete.id} email=${email} url=${verifyUrl}`);

      try {
        await resend.emails.send({
          from: 'NILDash <noreply@mynildash.com>',
          to: email,
          subject: 'Verify your NILDash account',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
              <div style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#0A0E1A;margin-bottom:8px">
                NIL<span style="color:#C8FF00">DASH</span>
              </div>
              <h2 style="font-size:18px;font-weight:700;margin-bottom:16px;color:#0A0E1A">Verify your email to get started</h2>
              <p style="color:#374151;font-size:15px;line-height:1.6;margin-bottom:24px">
                Hi ${String(name).split(' ')[0]}, here's your verification link.
                Click below to verify your email and jump into your free portal.
              </p>
              <a href="${verifyUrl}"
                 style="display:inline-block;background:#C8FF00;color:#0A0E1A;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px">
                Verify Email &amp; Continue →
              </a>
              <p style="color:#6B7280;font-size:12px;margin-top:24px">
                This link expires in 7 days. If you didn't sign up for NILDash, you can safely ignore this email.
              </p>
            </div>
          `,
        });
      } catch (emailErr) {
        console.error('[resend-verification] Email send failed:', emailErr.message);
        console.log(`[resend-verification] FALLBACK verify-url (email failed): ${verifyUrl}`);
      }
    }

    res.json({ ok: true, message: 'If that account exists and is unverified, a new verification email is on its way.' });
  } catch (e) {
    console.error('[resend-verification]', e.message);
    res.status(500).json({ error: 'Could not resend verification. Please try again.' });
  }
});

// GET /api/athlete/verify-email?token= — verifies email, creates Stripe checkout, redirects
app.get('/api/athlete/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  console.log(`[verify] token received: ...${token.slice(-12)} (len=${token.length})`);

  try {
    // ── 1. Look up athlete by token ────────────────────────────────────────────
    // Primary query: token only, no type filter — avoids missing rows if
    // athlete_type was stored with an unexpected value
    const sql = 'SELECT * FROM athletes WHERE email_verify_token = $1';
    const params = [token];
    console.log('[verify] query:', sql, params);
    const r = await store.pool.query(sql, params);
    console.log(`[verify] DB query returned ${r.rows.length} row(s)`);

    // Diagnostic: if 0 rows, check whether the token column exists at all
    if (!r.rows.length) {
      try {
        const colCheck = await store.pool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name='athletes' AND column_name='email_verify_token'`
        );
        console.log(`[verify] email_verify_token column exists: ${colCheck.rows.length > 0}`);

        // Also check the most recent self_managed athletes so we can compare tokens
        const recent = await store.pool.query(
          `SELECT id, email, athlete_type, email_verify_token, email_verified, email_verify_expires
           FROM athletes WHERE athlete_type = 'self_managed' ORDER BY created_at DESC LIMIT 3`
        );
        console.log('[verify] recent self_managed athletes:', JSON.stringify(recent.rows.map(row => ({
          id: row.id,
          email: row.email,
          type: row.athlete_type,
          token_tail: row.email_verify_token ? row.email_verify_token.slice(-12) : null,
          verified: row.email_verified,
          expires: row.email_verify_expires,
        }))));
      } catch (diagErr) {
        console.error('[verify] diagnostic query failed:', diagErr.message);
      }
      return res.status(400).send('Invalid or expired verification link. Please sign up again.');
    }

    const athlete = r.rows[0];
    console.log(`[verify] athlete found id=${athlete.id} email=${athlete.email} verified=${athlete.email_verified}`);

    if (athlete.email_verified)
      return res.redirect('/athletes?verified=already');

    if (new Date(athlete.email_verify_expires) < new Date()) {
      console.log(`[verify] token expired at ${athlete.email_verify_expires}`);
      return res.status(400).send('This verification link has expired (7 days). Please sign up again.');
    }

    // ── 2. Mark email verified ─────────────────────────────────────────────────
    await store.pool.query(
      'UPDATE athletes SET email_verified = TRUE, email_verify_token = NULL WHERE id = $1',
      [athlete.id]
    );
    console.log(`[verify] email marked verified for athlete=${athlete.id}`);

    // Helper: issue JWT and redirect directly to dashboard (bypassing Stripe)
    const _issueJwtAndRedirect = async (status) => {
      await store.pool.query(
        'UPDATE athletes SET subscription_status = $1, onboarding_complete = TRUE WHERE id = $2',
        [status, athlete.id]
      );
      const jwtLib = require('jsonwebtoken');
      const athleteName = (athlete.data && athlete.data.name) ? athlete.data.name : '';
      const athleteJwt = jwtLib.sign({
        id: athlete.id,
        email: athlete.email,
        role: 'athlete',
        agent_id: null,
        athlete_name: athleteName,
        athlete_type: 'self_managed',
      }, ATHLETE_JWT_SECRET, { expiresIn: '30d' });
      console.log(`[verify] JWT issued for athlete=${athlete.id} status=${status}`);
      return res.redirect(`/athlete-dashboard.html?jwt=${athleteJwt}&new=1&welcome=1`);
    };

    // ── FREE PORTAL ───────────────────────────────────────────────────────────
    // Billing is disabled (BILLING_ENABLED=false): no card, no checkout, no trial.
    // Verified athletes go straight into the portal with permanent free access.
    // (The Stripe block below is preserved for when billing is re-enabled.)
    if (!BILLING_ENABLED) {
      console.log(`[verify] billing disabled — granting free access to athlete=${athlete.id}`);
      return await _issueJwtAndRedirect('free');
    }

    // ── 3. Stripe checkout — only attempted with a confirmed live key ─────────────
    // ANY other condition (test key, missing key, missing price, connection error)
    // falls through to the bypass and gets the athlete into the portal immediately.
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    const stripePrice = process.env.STRIPE_PRICE_ID || '';
    const isLiveKey = stripeKey.startsWith('sk_live_');

    console.log(`[verify] stripe key type=${isLiveKey ? 'live' : 'test/missing'} price=${stripePrice || 'missing'}`);

    let checkoutUrl = null;
    try {
      if (!isLiveKey || !stripePrice) {
        // Not a live key or no price ID — throw immediately to hit the bypass
        throw new Error('TEST_MODE_BYPASS');
      }

      const stripe = require('stripe')(stripeKey);
      const appUrl = process.env.APP_URL || 'https://mynildash.com';

      const customer = await stripe.customers.create({
        email: athlete.email,
        name: (athlete.data && athlete.data.name) ? athlete.data.name : '',
        metadata: { athlete_id: athlete.id },
      });
      console.log(`[verify] stripe customer created id=${customer.id}`);

      await store.pool.query(
        'UPDATE athletes SET stripe_customer_id = $1 WHERE id = $2',
        [customer.id, athlete.id]
      );

      const checkoutSession = await stripe.checkout.sessions.create({
        customer: customer.id,
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [{ price: stripePrice, quantity: 1 }],
        subscription_data: { trial_period_days: 30 },
        success_url: `${appUrl}/api/athlete/stripe-complete?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/athletes?cancelled=1`,
        metadata: { athlete_id: athlete.id },
      });

      checkoutUrl = checkoutSession.url;
      console.log(`[verify] stripe checkout session created id=${checkoutSession.id}`);

    } catch (stripeErr) {
      // Log everything — connection errors, test-mode throws, invalid price IDs, etc.
      if (stripeErr.message !== 'TEST_MODE_BYPASS') {
        console.error('[verify] Stripe error — full:', JSON.stringify(stripeErr, Object.getOwnPropertyNames(stripeErr)));
        console.error('[verify] Stripe error message:', stripeErr.message);
      }
      // Bypass: activate the athlete directly regardless of why Stripe failed
      console.log('[verify] bypassing Stripe — activating athlete directly');
      return await _issueJwtAndRedirect('trialing');
    }

    // ── 4. Redirect to Stripe checkout (live path only) ───────────────────────
    console.log(`[verify] redirecting athlete=${athlete.id} to Stripe checkout`);
    res.redirect(checkoutUrl);

  } catch (err) {
    // Catch-all: log the full error object (not just .message) so nothing is hidden
    console.error('[verify-email-error] Unhandled exception:', err);
    console.error('[verify-email-error] message:', err.message);
    console.error('[verify-email-error] stack:', err.stack);
    res.status(500).send('Something went wrong. Please try again or contact support@mynildash.com');
  }
});

// GET /api/athlete/stripe-complete?session_id= — exchange Stripe session for JWT, redirect to dashboard
app.get('/api/athlete/stripe-complete', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id)
    return res.redirect('/athletes?error=missing_session');

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (!session || session.status !== 'complete')
      return res.redirect('/athletes?error=payment_incomplete');

    const athleteId = session.metadata && session.metadata.athlete_id;
    if (!athleteId)
      return res.redirect('/athletes?error=invalid_session');

    const r = await store.pool.query('SELECT * FROM athletes WHERE id = $1', [athleteId]);
    if (!r.rows.length)
      return res.redirect('/athletes?error=athlete_not_found');

    const athlete = r.rows[0];

    // Update subscription status if webhook hasn't fired yet
    if (athlete.subscription_status !== 'active') {
      await store.pool.query(
        `UPDATE athletes SET subscription_status = 'active', onboarding_complete = TRUE,
           stripe_subscription_id = COALESCE(stripe_subscription_id, $1)
         WHERE id = $2`,
        [session.subscription || null, athleteId]
      );
    }

    const jwt = require('jsonwebtoken');
    const athleteJwt = jwt.sign({
      id: athlete.id,
      email: athlete.email,
      role: 'athlete',
      agent_id: null,
      athlete_name: athlete.data && athlete.data.name ? athlete.data.name : '',
      athlete_type: 'self_managed',
    }, ATHLETE_JWT_SECRET, { expiresIn: '30d' });

    console.log(`[stripe-complete] Issued JWT for athlete ${athleteId}`);
    // Redirect to dashboard with JWT in URL param; dashboard will extract and store it
    res.redirect(`/athlete-dashboard.html?jwt=${athleteJwt}&new=1`);
  } catch (e) {
    console.error('[stripe-complete]', e.message, e.stack);
    res.redirect('/athletes?error=server_error');
  }
});

// POST /api/agents/athletes/:id/invite-token — agent generates new invite token
app.post('/api/agents/athletes/:id/invite-token', requireAuth, async (req, res) => {
  try {
    const athleteId = req.params.id;
    const athlete = await store.getAthlete(athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    if (String(athlete.agentId) !== String(req.session.userId)) return res.status(403).json({ error: 'Forbidden' });

    // Invalidate any existing unused tokens for this athlete
    await store.pool.query(
      'UPDATE athlete_invite_tokens SET used = TRUE, used_at = NOW() WHERE athlete_id = $1 AND used = FALSE',
      [athleteId]
    );

    const token = require('crypto').randomBytes(32).toString('hex');
    console.log(`[invite-token] Generating token for athlete=${athleteId}, saving to athlete_invite_tokens`);
    await store.pool.query(
      `INSERT INTO athlete_invite_tokens (athlete_id, agent_id, token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`,
      [athleteId, req.session.userId, token]
    );

    // Confirm token was saved
    const confirm = await store.pool.query('SELECT id, athlete_id, expires_at FROM athlete_invite_tokens WHERE token = $1', [token]);
    if (confirm.rows.length) {
      console.log(`[invite-token] Confirmed saved: id=${confirm.rows[0].id} athlete=${confirm.rows[0].athlete_id} expires=${confirm.rows[0].expires_at} token=...${token.slice(-12)}`);
    } else {
      console.error(`[invite-token] WARNING: token not found after INSERT — athlete=${athleteId}`);
    }

    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const inviteUrl = `${appUrl}/athlete-signup.html?token=${token}`;

    // Also update legacy athlete_invites table for backward compat
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const vis = { rate: true, deals: true, contracts: true, brands: false, compliance: true };
    await store.pool.query(
      `INSERT INTO athlete_invites (id, athlete_id, agent_id, token, visibility, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET token=$4, expires_at=$6`,
      ['invite-' + athleteId, athleteId, req.session.userId, token, JSON.stringify(vis), expires]
    ).catch(() => {});

    console.log(`[invite-token] Done: agent=${req.session.userId} athlete=${athleteId} token=...${token.slice(-12)}`);
    res.json({ ok: true, token, inviteUrl, athleteName: athlete.name });
  } catch (e) {
    console.error('[invite-token] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/athletes/:id/invite-status — check activation status
app.get('/api/agents/athletes/:id/invite-status', requireAuth, async (req, res) => {
  try {
    const athleteId = req.params.id;
    // Check athlete activation from athletes table (new system)
    const athR = await store.pool.query(
      'SELECT onboarding_complete, email, account_activated_at FROM athletes WHERE id = $1',
      [athleteId]
    );
    const activated = athR.rows[0]?.onboarding_complete || false;

    // Get most recent non-used token
    const tokenR = await store.pool.query(
      `SELECT token, created_at, expires_at, used FROM athlete_invite_tokens
       WHERE athlete_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [athleteId]
    );

    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const latest = tokenR.rows[0];
    res.json({
      activated,
      has_token: !!latest,
      token_used: latest?.used || false,
      token_expired: latest ? new Date(latest.expires_at) < new Date() : false,
      created_at: latest?.created_at || null,
      invite_url: latest && !latest.used ? `${appUrl}/athlete-signup.html?token=${latest.token}` : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Athlete Brand Outreach ───────────────────────────────────────────────────

// POST /api/athlete/outreach — athlete initiates brand outreach
app.post('/api/athlete/outreach', verifyAthleteToken, async (req, res) => {
  try {
    const { brand_name, brand_contact_email, brand_website, sport_relevance, message_sent } = req.body;
    if (!brand_name || !message_sent) return res.status(400).json({ error: 'brand_name and message_sent are required' });

    // Get agent's approval setting (if stored)
    const r = await store.pool.query(
      `INSERT INTO athlete_brand_outreach
         (athlete_id, agent_id, brand_name, brand_contact_email, brand_website, sport_relevance, message_sent, initiated_by, status, agent_notified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'athlete','sent',FALSE)
       RETURNING *`,
      [req.athlete.id, req.athlete.agent_id, brand_name, brand_contact_email || null, brand_website || null, sport_relevance || null, message_sent]
    );
    console.log(`[athlete/outreach] athlete=${req.athlete.id} brand=${brand_name}`);
    res.json({ ok: true, outreach: r.rows[0] });
  } catch (e) {
    console.error('[athlete/outreach POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/athlete/write-outreach — AI generates 3-channel outreach (email, IG DM, LinkedIn)
app.post('/api/athlete/write-outreach', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { brand, category, contact, goal } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });
    // Use the canonical loader so dedicated follower columns (self-signup
    // athletes) are merged — building from data JSON alone reported 0 followers.
    const a = await _loadAthleteObjForAI(req.athlete.id);
    if (!a) return res.status(404).json({ error: 'Athlete not found' });
    const goalStr = goal ? `$${Number(goal).toLocaleString()}` : 'a fair NIL rate';
    const contactStr = contact ? `Contact: ${contact}` : '';
    const prompt = `Write sponsorship outreach for a college athlete targeting a brand deal.

Athlete: ${a.name} | Sport: ${a.sport} | School: ${a.school} | Position: ${a.position || 'N/A'}
Instagram followers: ${a.instagram || 0} | TikTok: ${a.tiktok || 0}
Brand: ${brand} | Category: ${category || 'general'} | ${contactStr}
Deal goal: ${goalStr}

Write three versions:
1. A professional email with a subject line
2. A casual Instagram DM (under 200 words)
3. A LinkedIn message (professional tone, under 150 words)

Return ONLY valid JSON (no markdown):
{
  "emailSubject": "...",
  "email": "...",
  "instagram": "...",
  "linkedin": "..."
}`;
    const raw = await ai.oneShot(prompt, 'You are an NIL sponsorship specialist. Return only valid JSON.');
    let result = {};
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch(e) {}
    if (!result.email && !result.instagram) return res.status(500).json({ error: 'AI failed to generate outreach' });
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'outreach_written',
      `AI wrote outreach for ${brand}`, { brand, category });
    res.json(result);
  } catch (e) { console.error('[athlete/write-outreach]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/outreach — athlete views their outreach history
app.get('/api/athlete/outreach', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT * FROM athlete_brand_outreach WHERE athlete_id = $1 ORDER BY created_at DESC',
      [req.athlete.id]
    );
    res.json({ outreach: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/athlete-outreach — agent views all athlete outreach
app.get('/api/agents/athlete-outreach', requireAuth, async (req, res) => {
  try {
    const { athlete_id, status } = req.query;
    let sql = `SELECT abo.*, a.data->>'name' as athlete_name, a.data->>'sport' as athlete_sport
               FROM athlete_brand_outreach abo
               JOIN athletes a ON abo.athlete_id = a.id
               WHERE abo.agent_id = $1`;
    const params = [req.session.userId];
    let idx = 2;
    if (athlete_id) { sql += ` AND abo.athlete_id = $${idx++}`; params.push(athlete_id); }
    if (status) { sql += ` AND abo.status = $${idx++}`; params.push(status); }
    sql += ' ORDER BY abo.created_at DESC';
    const r = await store.pool.query(sql, params);
    res.json({ outreach: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/agents/athlete-outreach/:id/approve
app.put('/api/agents/athlete-outreach/:id/approve', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query(
      `UPDATE athlete_brand_outreach SET agent_approved = TRUE, status = 'sent', updated_at = NOW()
       WHERE id = $1 AND agent_id = $2 RETURNING *`,
      [req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, outreach: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/agents/athlete-outreach/:id/reject
app.put('/api/agents/athlete-outreach/:id/reject', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query(
      `UPDATE athlete_brand_outreach SET agent_approved = FALSE, status = 'declined', updated_at = NOW()
       WHERE id = $1 AND agent_id = $2 RETURNING *`,
      [req.params.id, req.session.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, outreach: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/ai-draft-outreach — AI drafts outreach email
app.post('/api/athlete/ai-draft-outreach', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { brand_name, brand_website, sport_relevance } = req.body;
    if (!brand_name) return res.status(400).json({ error: 'brand_name required' });

    // Get athlete profile
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'school' as school,
              a.data->>'followers_ig' as followers_ig, a.instagram_handle, a.tiktok_handle
       FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const ath = athR.rows[0] || {};

    const systemPrompt = `You are an NIL outreach specialist. Write a professional, personable outreach email from a college athlete to a brand. The email should be concise (under 200 words), highlight the athlete's platform and relevance to the brand, and include a clear ask. Return only the email body, no subject line.`;
    const userPrompt = `Athlete: ${ath.name || 'the athlete'}, ${ath.sport || 'college sport'} at ${ath.school || 'their university'}. Instagram: @${ath.instagram_handle || 'handle'} (${ath.followers_ig || 'unknown'} followers). Brand: ${brand_name}${brand_website ? ` (${brand_website})` : ''}. Why it's a good fit: ${sport_relevance || 'strong brand alignment with the athlete\'s sport and audience'}.`;

    // Use the proven oneShot helper (matches the working /write-outreach
    // generator). The previous ai.chat() call did not exist on the ai module
    // and threw "ai.chat is not a function", surfacing as a generic 500.
    const response = await ai.oneShot(userPrompt, systemPrompt, 800);
    const draft = (response || '').trim();
    if (!draft) return res.status(502).json({ error: 'AI returned an empty draft. Please try again.' });
    res.json({ draft });
  } catch (e) {
    // Log the full error + stack so the true exception is visible in Railway logs.
    console.error('[ai-draft-outreach] FAILED:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'AI draft failed: ' + (e && e.message ? e.message : 'unknown error') });
  }
});

// ── Athlete Full Portal Routes ──────────────────────────────────────────────
// All use verifyAthleteToken. Athletes can ONLY see their own data.

// Internal helper: log what athletes do so agents have full visibility
async function logAthleteActivity(athleteId, agentId, type, description, metadata) {
  try {
    await store.pool.query(
      `INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [athleteId, agentId || null, type, description || null, JSON.stringify(metadata || {})]
    );
  } catch (e) { console.error('[logAthleteActivity]', e.message); }
}

// GET /api/athlete/calendar — athlete views own calendar/deliverables
app.get('/api/athlete/calendar', verifyAthleteToken, async (req, res) => {
  try {
    const { status, brand, from, to } = req.query;
    let sql = 'SELECT * FROM athlete_calendar_events WHERE athlete_id = $1';
    const params = [req.athlete.id];
    let idx = 2;
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (brand) { sql += ` AND LOWER(brand) LIKE $${idx++}`; params.push('%' + brand.toLowerCase() + '%'); }
    if (from) { sql += ` AND event_date >= $${idx++}`; params.push(from); }
    if (to) { sql += ` AND event_date <= $${idx++}`; params.push(to); }
    sql += ' ORDER BY event_date ASC';
    const r = await store.pool.query(sql, params);
    console.log(`[athlete/calendar] athlete=${req.athlete.id} events=${r.rows.length}`);
    res.json({ events: r.rows });
  } catch (e) { console.error('[athlete/calendar]', e.message); res.status(500).json({ error: e.message }); }
});

// PUT /api/athlete/calendar/:id/status — update deliverable status
app.put('/api/athlete/calendar/:id/status', verifyAthleteToken, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const r = await store.pool.query(
      'UPDATE athlete_calendar_events SET status = $1 WHERE id = $2 AND athlete_id = $3 RETURNING *',
      [status, req.params.id, req.athlete.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Event not found' });
    const ev = r.rows[0];
    if (status === 'completed') {
      await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deliverable_completed',
        `Completed: ${ev.title}`, { event_id: ev.id, brand: ev.brand });
    }
    console.log(`[athlete/calendar/status] id=${req.params.id} status=${status}`);
    res.json({ ok: true, event: ev });
  } catch (e) { console.error('[athlete/calendar/status]', e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ATHLETE-CREATED DELIVERABLES
// Lets a self-managed athlete create dated deliverables directly. These are
// written to the SAME table the calendar reads (athlete_calendar_events), so
// they appear on the in-app calendar immediately AND are picked up by the
// existing Google Calendar sync (which pushes rows where google_event_id IS NULL).
// We do NOT touch the working sync/auth — we just create rows in its source.
// ════════════════════════════════════════════════════════════════════════════
const ATHLETE_DELIVERABLE_TYPES = ['Instagram Post', 'Instagram Story', 'Instagram Reel', 'TikTok', 'Appearance', 'Other'];
function _normDeliverableType(t) {
  if (!t) return null;
  const match = ATHLETE_DELIVERABLE_TYPES.find(x => x.toLowerCase() === String(t).trim().toLowerCase());
  return match || String(t).trim().slice(0, 60);
}
function _dateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  // Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (datetime) — store the date part.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// GET /api/athlete/deliverables — list this athlete's calendar deliverables.
// (Same source as GET /api/athlete/calendar; provided as an explicit list endpoint.)
app.get('/api/athlete/deliverables', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT * FROM athlete_calendar_events WHERE athlete_id=$1 ORDER BY event_date ASC',
      [req.athlete.id]
    );
    res.json({ deliverables: r.rows });
  } catch (e) { console.error('[athlete/deliverables GET]', e.message); res.status(500).json({ error: e.message }); }
});

// Shared create helper — inserts one dated deliverable into athlete_calendar_events.
async function _createAthleteDeliverable(athlete, { title, due_date, event_type, notes, deal_id }) {
  const date = _dateOnly(due_date);
  if (!title || !String(title).trim()) { const e = new Error('title required'); e.status = 400; throw e; }
  if (!date) { const e = new Error('valid due date required'); e.status = 400; throw e; }

  // If linked to a money-loop deal, pull the brand for display/grouping.
  let brand = null, dealId = null;
  if (deal_id != null && deal_id !== '') {
    const dr = await store.pool.query(
      'SELECT id, brand_name FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [deal_id, athlete.id]
    );
    if (dr.rows.length) { brand = dr.rows[0].brand_name; dealId = dr.rows[0].id; }
  }

  let color = null;
  try { const { brandColor } = require('./services/contractExtraction'); color = brandColor(brand); } catch (e) {}

  const id = 'evt-' + require('crypto').randomBytes(8).toString('hex');
  const evType = _normDeliverableType(event_type);
  const r = await store.pool.query(
    `INSERT INTO athlete_calendar_events
       (id, athlete_id, agent_id, deal_id, title, event_date, brand, color, event_type,
        status, is_generated, manually_modified, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',FALSE,TRUE,$10) RETURNING *`,
    [id, athlete.id, athlete.agent_id || null, dealId, String(title).trim(), date, brand, color, evType, notes || null]
  );
  const ev = r.rows[0];
  // Best-effort immediate push to Google Calendar (no-op if not connected).
  _pushEventToGCal(athlete.id, ev).catch(() => {});
  await logAthleteActivity(athlete.id, athlete.agent_id, 'deliverable_created',
    `Added deliverable: ${ev.title}`, { event_id: ev.id, brand }).catch(() => {});
  return ev;
}

// POST /api/athlete/deliverables — create a dated deliverable
app.post('/api/athlete/deliverables', verifyAthleteToken, async (req, res) => {
  try {
    const b = req.body || {};
    const ev = await _createAthleteDeliverable(req.athlete, {
      title: b.title, due_date: b.due_date, event_type: b.event_type, notes: b.notes, deal_id: b.deal_id
    });
    console.log(`[athlete/deliverables] created id=${ev.id} athlete=${req.athlete.id}`);
    res.json({ ok: true, deliverable: ev });
  } catch (e) {
    console.error('[athlete/deliverables POST]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/athlete/deals/:id/deliverables — create a deliverable linked to a deal
app.post('/api/athlete/deals/:id/deliverables', verifyAthleteToken, async (req, res) => {
  try {
    const owns = await store.pool.query(
      'SELECT id FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]
    );
    if (!owns.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const b = req.body || {};
    const ev = await _createAthleteDeliverable(req.athlete, {
      title: b.title, due_date: b.due_date, event_type: b.event_type, notes: b.notes, deal_id: req.params.id
    });
    console.log(`[athlete/deals/deliverables] deal=${req.params.id} event=${ev.id}`);
    res.json({ ok: true, deliverable: ev });
  } catch (e) {
    console.error('[athlete/deals/deliverables POST]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PUT /api/athlete/deliverables/:id — edit a deliverable
app.put('/api/athlete/deliverables/:id', verifyAthleteToken, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await store.pool.query(
      'SELECT * FROM athlete_calendar_events WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Deliverable not found' });
    const date = (b.due_date != null && b.due_date !== '') ? _dateOnly(b.due_date) : null;
    if (b.due_date != null && b.due_date !== '' && !date) return res.status(400).json({ error: 'valid due date required' });
    const evType = (b.event_type != null) ? _normDeliverableType(b.event_type) : null;
    const r = await store.pool.query(
      `UPDATE athlete_calendar_events SET
         title=COALESCE($1,title), event_date=COALESCE($2::DATE,event_date),
         event_type=COALESCE($3,event_type), notes=COALESCE($4,notes),
         status=COALESCE($5,status), manually_modified=TRUE
       WHERE id=$6 AND athlete_id=$7 RETURNING *`,
      [b.title ? String(b.title).trim() : null, date, evType, (b.notes != null ? b.notes : null),
       b.status || null, req.params.id, req.athlete.id]
    );
    res.json({ ok: true, deliverable: r.rows[0] });
  } catch (e) { console.error('[athlete/deliverables PUT]', e.message); res.status(500).json({ error: e.message }); }
});

// DELETE /api/athlete/deliverables/:id — remove a deliverable
app.delete('/api/athlete/deliverables/:id', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'DELETE FROM athlete_calendar_events WHERE id=$1 AND athlete_id=$2 RETURNING id',
      [req.params.id, req.athlete.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Deliverable not found' });
    res.json({ ok: true });
  } catch (e) { console.error('[athlete/deliverables DELETE]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Google Calendar Integration ───────────────────────────────────────────────
// Athlete connects their Google Calendar → NILDash pushes deliverables as events.
// Agent connects → can subscribe to each athlete's dedicated "NIL — [Name]" calendar.
// Uses separate GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (distinct from Gmail).
// ─────────────────────────────────────────────────────────────────────────────

const gcal      = (() => { try { return require('./services/googleCalendar'); } catch(e) { return null; } })();
const gmailSend = (() => { try { return require('./services/gmailSend');      } catch(e) { return null; } })();

// Encode/decode OAuth state (same pattern as email.js)
function _gcalEncodeState(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function _gcalDecodeState(s)   { try { return JSON.parse(Buffer.from(s||'','base64url').toString('utf8')); } catch { return {}; } }

/**
 * Non-blocking helper — pushes a single athlete_calendar_events row to Google Calendar.
 * Skips silently if the athlete has no google_refresh_token or gcal is not configured.
 * Idempotent: skips rows that already have a google_event_id.
 */
async function _pushEventToGCal(athleteId, event) {
  if (!gcal || !gcal.isAvailable()) return;
  if (event.google_event_id) return; // already synced
  try {
    // Fetch athlete's Google Calendar credentials
    const athRow = await store.pool.query(
      'SELECT google_refresh_token, google_calendar_id, data FROM athletes WHERE id=$1',
      [athleteId]
    ).then(r => r.rows[0]);

    if (!athRow || !athRow.google_refresh_token) return; // not connected

    // Get or create the NIL calendar
    let calId = athRow.google_calendar_id;
    if (!calId) {
      const name = (athRow.data && athRow.data.name) || 'Athlete';
      calId = await gcal.getOrCreateNilCalendar(athRow.google_refresh_token, name);
      await store.pool.query('UPDATE athletes SET google_calendar_id=$1 WHERE id=$2', [calId, athleteId]);
    }

    // Create the event
    const gEventId = await gcal.createCalendarEvent(athRow.google_refresh_token, calId, event);

    // Store google_event_id so we don't push it again
    await store.pool.query(
      'UPDATE athlete_calendar_events SET google_event_id=$1 WHERE id=$2',
      [gEventId, event.id]
    );
    console.log(`[gcal] pushed event "${event.title}" → Google Calendar event ${gEventId}`);
  } catch (e) {
    console.error('[gcal] push failed for event', event.id, ':', e.message);
  }
}

// GET /api/athlete/calendar/google/status — is this athlete's Google Calendar connected?
app.get('/api/athlete/calendar/google/status', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT google_refresh_token, google_calendar_id FROM athletes WHERE id=$1',
      [req.athlete.id]
    );
    const row = r.rows[0] || {};
    res.json({
      connected:  !!row.google_refresh_token,
      calendarId: row.google_calendar_id || null,
      available:  !!(gcal && gcal.isAvailable()),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/calendar/google/connect — start OAuth for athlete
app.get('/api/athlete/calendar/google/connect', verifyAthleteToken, async (req, res) => {
  if (!gcal || !gcal.isAvailable()) {
    return res.status(501).json({ error: 'Google Calendar not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to environment variables.' });
  }
  const state = _gcalEncodeState({ athleteId: req.athlete.id, type: 'athlete' });
  const url   = gcal.getAthleteAuthUrl(state);
  res.json({ url });
});

// GET /auth/google/calendar/callback — OAuth callback (athlete + agent)
// No auth middleware — identity is verified via the state param.
app.get('/auth/google/calendar/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('[gcal/callback] OAuth error:', error);
    return res.redirect('/athlete-dashboard.html?gcal=error&reason=' + encodeURIComponent(error));
  }
  const { athleteId, agentId, type } = _gcalDecodeState(state);

  try {
    const tokens = await gcal.exchangeCode(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      // Can happen if user already authorized before; prompt=consent should prevent this.
      return res.redirect(
        type === 'agent'
          ? '/#calendar?gcal=error&reason=no_refresh_token'
          : '/athlete-dashboard.html?gcal=error&reason=no_refresh_token'
      );
    }

    if (type === 'athlete' && athleteId) {
      // Save refresh token
      await store.pool.query(
        'UPDATE athletes SET google_refresh_token=$1 WHERE id=$2',
        [refreshToken, athleteId]
      );

      // Create the NIL calendar immediately
      const nameRow = await store.pool.query(
        `SELECT data->>'name' AS name FROM athletes WHERE id=$1`, [athleteId]
      ).then(r => r.rows[0]);
      const athleteName = nameRow ? nameRow.name : 'Athlete';
      const calId = await gcal.getOrCreateNilCalendar(refreshToken, athleteName);
      await store.pool.query(
        'UPDATE athletes SET google_calendar_id=$1 WHERE id=$2',
        [calId, athleteId]
      );
      console.log(`[gcal] athlete ${athleteId} connected Google Calendar, calId=${calId}`);

      // Background sync: push all existing unpushed events
      store.pool.query(
        'SELECT * FROM athlete_calendar_events WHERE athlete_id=$1 AND google_event_id IS NULL ORDER BY event_date ASC',
        [athleteId]
      ).then(r => {
        r.rows.forEach(ev => _pushEventToGCal(athleteId, ev));
      }).catch(() => {});

      return res.redirect('/athlete-dashboard.html?gcal=connected');

    } else if (type === 'agent' && agentId) {
      await store.pool.query(
        'UPDATE users SET gcal_refresh_token=$1 WHERE id=$2',
        [refreshToken, agentId]
      );
      console.log(`[gcal] agent ${agentId} connected Google Calendar`);
      checkOff(agentId, 'connect_google'); // Getting Started checklist
      return res.redirect('/#calendar?gcal=connected');
    }

    res.redirect('/');
  } catch (e) {
    console.error('[gcal/callback]', e.message);
    const dest = type === 'agent' ? '/#calendar' : '/athlete-dashboard.html';
    res.redirect(dest + '?gcal=error&reason=' + encodeURIComponent(e.message));
  }
});

// POST /api/athlete/calendar/google/sync — re-push all unpushed events for this athlete
app.post('/api/athlete/calendar/google/sync', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT * FROM athlete_calendar_events WHERE athlete_id=$1 AND google_event_id IS NULL ORDER BY event_date ASC',
      [req.athlete.id]
    );
    // Fire and forget — response is immediate
    r.rows.forEach(ev => _pushEventToGCal(req.athlete.id, ev));
    res.json({ ok: true, queued: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/athlete/calendar/google/disconnect — revoke athlete's Google Calendar connection
app.delete('/api/athlete/calendar/google/disconnect', verifyAthleteToken, async (req, res) => {
  try {
    await store.pool.query(
      'UPDATE athletes SET google_refresh_token=NULL, google_calendar_id=NULL WHERE id=$1',
      [req.athlete.id]
    );
    // Clear stored google_event_id references so events can be re-pushed on reconnect
    await store.pool.query(
      'UPDATE athlete_calendar_events SET google_event_id=NULL WHERE athlete_id=$1',
      [req.athlete.id]
    );
    console.log(`[gcal] athlete ${req.athlete.id} disconnected Google Calendar`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[gcal/disconnect]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATHLETE GMAIL SEND INTEGRATION
// Athletes connect their personal Gmail so emails sent from the portal
// actually originate from the athlete's own Gmail address.
// ─────────────────────────────────────────────────────────────────────────────

function _gmailEncodeState(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function _gmailDecodeState(s)   { try { return JSON.parse(Buffer.from(s||'','base64url').toString('utf8')); } catch { return {}; } }

// GET /api/athlete/gmail/status — is this athlete's Gmail connected?
app.get('/api/athlete/gmail/status', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT gmail_refresh_token, gmail_address FROM athletes WHERE id=$1',
      [req.athlete.id]
    );
    const row = r.rows[0] || {};
    res.json({
      connected: !!row.gmail_refresh_token,
      email:     row.gmail_address || null,
      available: !!(gmailSend && gmailSend.isAvailable()),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/gmail/connect — start OAuth for athlete Gmail send
app.get('/api/athlete/gmail/connect', verifyAthleteToken, async (req, res) => {
  if (!gmailSend || !gmailSend.isAvailable()) {
    return res.status(501).json({ error: 'Gmail integration not configured.' });
  }
  const state = _gmailEncodeState({ athleteId: req.athlete.id, type: 'athlete-gmail' });
  const url   = gmailSend.getAthleteGmailAuthUrl(state);
  res.json({ url });
});

// GET /auth/google/athlete-gmail/callback — OAuth callback for athlete Gmail connect
// No auth middleware — identity is in the state parameter.
app.get('/auth/google/athlete-gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('[gmail/callback] OAuth error:', error);
    return res.redirect('/athlete-dashboard.html?gmail=error&reason=' + encodeURIComponent(error));
  }
  const { athleteId, type } = _gmailDecodeState(state);
  if (type !== 'athlete-gmail' || !athleteId) {
    return res.redirect('/athlete-dashboard.html?gmail=error&reason=invalid_state');
  }
  try {
    const tokens       = await gmailSend.exchangeCode(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      return res.redirect('/athlete-dashboard.html?gmail=error&reason=no_refresh_token');
    }
    // Get athlete's Gmail address from token identity
    const gmailAddress = await gmailSend.getGmailAddress(tokens.access_token);
    // Save to DB
    await store.pool.query(
      'UPDATE athletes SET gmail_refresh_token=$1, gmail_address=$2 WHERE id=$3',
      [refreshToken, gmailAddress, athleteId]
    );
    console.log(`[gmail] athlete ${athleteId} connected Gmail as ${gmailAddress}`);
    res.redirect('/athlete-dashboard.html?gmail=connected');
  } catch (e) {
    console.error('[gmail/callback]', e.message);
    res.redirect('/athlete-dashboard.html?gmail=error&reason=' + encodeURIComponent(e.message));
  }
});

// POST /api/athlete/gmail/disconnect — clear athlete's Gmail connection
app.post('/api/athlete/gmail/disconnect', verifyAthleteToken, async (req, res) => {
  try {
    await store.pool.query(
      'UPDATE athletes SET gmail_refresh_token=NULL, gmail_address=NULL WHERE id=$1',
      [req.athlete.id]
    );
    console.log(`[gmail] athlete ${req.athlete.id} disconnected Gmail`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[gmail/disconnect]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/calendar/google/status — is this agent's Google Calendar connected?
app.get('/api/agent/calendar/google/status', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT gcal_refresh_token FROM users WHERE id=$1',
      [req.session.userId]
    );
    const row = r.rows[0] || {};
    res.json({
      connected: !!row.gcal_refresh_token,
      available: !!(gcal && gcal.isAvailable()),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/calendar/google/connect — start OAuth for agent.
// Reuses the SINGLE combined "Connect Google" flow: /api/email/oauth/gmail requests
// gmail.send + calendar.events + userinfo.email and its callback stores the refresh
// token as BOTH the email account and the agent's gcal_refresh_token. One consent
// powers email + calendar. This also fixes the old redirect_uri mismatch (the
// separate calendar flow used to request a full-calendar scope and point its
// redirect at the gmail callback).
app.get('/api/agent/calendar/google/connect', requireAuth, async (req, res) => {
  if (!gcal || !gcal.isAvailable()) {
    return res.status(501).json({ error: 'Google Calendar not configured.' });
  }
  res.json({ url: '/api/email/oauth/gmail' });
});

// POST /api/agent/google/disconnect - clear this agent's stored Google connection
// (Gmail + Calendar). Removes any connected Gmail/Google email accounts and nulls
// the agent's Google Calendar refresh token, so the status endpoints report
// not-connected and the UI flips back to the Connect state. The next Connect runs
// the full consent flow again: the OAuth URL builder always sends prompt=consent
// with access_type=offline, so Google re-shows the account chooser and consent
// screen with all scopes rather than silently re-authorizing.
app.post('/api/agent/google/disconnect', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const emailStore = require('./services/emailStore');

    // Remove connected Gmail/Google email accounts (deleteEmailAccount also cleans
    // up the account's drafts, threads, emails and sync logs).
    let removedAccounts = 0;
    try {
      const accounts = await emailStore.getEmailAccountsByUser(userId);
      for (const acc of accounts) {
        const provider = String(acc.provider || '');
        if (provider === 'gmail' || /google|gmail/i.test(provider)) {
          await emailStore.deleteEmailAccount(acc.id, userId);
          removedAccounts++;
        }
      }
    } catch (e) {
      console.warn('[google/disconnect] email account cleanup failed:', e.message);
    }

    // Clear the agent's Google Calendar refresh token.
    await store.pool.query('UPDATE users SET gcal_refresh_token=NULL WHERE id=$1', [userId]);

    console.log(`[google] agent ${userId} disconnected Google (removed ${removedAccounts} email account(s), cleared calendar token)`);
    res.json({ ok: true, removedAccounts });
  } catch (e) {
    console.error('[agent/google/disconnect]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/calendar/google/athletes — list this agent's athletes with their gcal status
app.get('/api/agent/calendar/google/athletes', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT id,
              data->>'name'   AS name,
              data->>'sport'  AS sport,
              data->>'school' AS school,
              google_calendar_id,
              CASE WHEN google_refresh_token IS NOT NULL THEN TRUE ELSE FALSE END AS gcal_connected
       FROM athletes WHERE agent_id=$1 ORDER BY (data->>'name') ASC`,
      [req.session.userId]
    );
    res.json({ athletes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/calendar/google/subscribe/:athleteId — subscribe agent to athlete's NIL calendar
app.post('/api/agent/calendar/google/subscribe/:athleteId', requireAuth, async (req, res) => {
  try {
    if (!gcal || !gcal.isAvailable()) return res.status(501).json({ error: 'Google Calendar not configured.' });
    // SCOPE NOTE: subscribing uses calendarList (managing the user's calendar
    // list), which requires the full 'calendar' scope. Disabled under the
    // declared calendar.events scope — short-circuit before any Google call.
    return res.status(501).json({ error: 'Calendar subscription requires broader Google permissions and is currently unavailable.' });

    // Verify athlete belongs to this agent
    const athRow = await store.pool.query(
      'SELECT google_calendar_id, data FROM athletes WHERE id=$1 AND agent_id=$2',
      [req.params.athleteId, req.session.userId]
    ).then(r => r.rows[0]);
    if (!athRow) return res.status(404).json({ error: 'Athlete not found' });
    if (!athRow.google_calendar_id) return res.status(400).json({ error: 'Athlete has not connected Google Calendar yet' });

    // Get agent's refresh token
    const agentRow = await store.pool.query(
      'SELECT gcal_refresh_token FROM users WHERE id=$1',
      [req.session.userId]
    ).then(r => r.rows[0]);
    if (!agentRow || !agentRow.gcal_refresh_token) return res.status(400).json({ error: 'Connect your Google Calendar first' });

    const result = await gcal.subscribeToCalendar(agentRow.gcal_refresh_token, athRow.google_calendar_id);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[gcal/subscribe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/agent/calendar/google/subscribe/:athleteId — unsubscribe
app.delete('/api/agent/calendar/google/subscribe/:athleteId', requireAuth, async (req, res) => {
  try {
    if (!gcal || !gcal.isAvailable()) return res.status(501).json({ error: 'Google Calendar not configured.' });
    // SCOPE NOTE: unsubscribing uses calendarList (full 'calendar' scope).
    // Disabled under calendar.events — short-circuit before any Google call.
    return res.status(501).json({ error: 'Calendar subscription requires broader Google permissions and is currently unavailable.' });

    const athRow = await store.pool.query(
      'SELECT google_calendar_id FROM athletes WHERE id=$1 AND agent_id=$2',
      [req.params.athleteId, req.session.userId]
    ).then(r => r.rows[0]);
    if (!athRow || !athRow.google_calendar_id) return res.status(404).json({ error: 'Athlete calendar not found' });

    const agentRow = await store.pool.query(
      'SELECT gcal_refresh_token FROM users WHERE id=$1',
      [req.session.userId]
    ).then(r => r.rows[0]);
    if (!agentRow || !agentRow.gcal_refresh_token) return res.status(400).json({ error: 'Agent not connected to Google Calendar' });

    await gcal.unsubscribeFromCalendar(agentRow.gcal_refresh_token, athRow.google_calendar_id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[gcal/unsubscribe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/athlete/deals — athlete's self-managed deals
app.get('/api/athlete/deals', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE athlete_id = $1 ORDER BY created_at DESC',
      [req.athlete.id]
    );
    res.json({ deals: r.rows, platform_fee_pct: PLATFORM_FEE_PCT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deals — create self-managed deal
app.post('/api/athlete/deals', verifyAthleteToken, async (req, res) => {
  try {
    const { brand_name, deal_type, value, stage, description, start_date, notes, deliverables, timeline } = req.body;
    if (!brand_name) return res.status(400).json({ error: 'brand_name required' });
    const stageHistory = [{ stage: stage || 'Prospect', date: new Date().toISOString(), note: 'Deal created' }];
    const fee = computeFee(value); // display/record only
    const r = await store.pool.query(
      `INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, deal_type, value, stage, description, start_date, notes, stage_history, deliverables, timeline, fee_pct, fee_amount, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.athlete.id, req.athlete.agent_id, brand_name, deal_type || 'Other', value || null,
       stage || 'Prospect', description || null, start_date || null, notes || null, JSON.stringify(stageHistory),
       deliverables || null, timeline || null, fee.fee_pct, value ? fee.fee_amount : null, value ? fee.net_amount : null]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_added',
      `Added deal: ${brand_name}`, { deal_id: r.rows[0].id, brand: brand_name, value });
    console.log(`[athlete/deals] created brand=${brand_name} athlete=${req.athlete.id}`);
    res.json({ ok: true, deal: r.rows[0] });
  } catch (e) { console.error('[athlete/deals POST]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deals/from-scan — "+ Track" a Deal Scan opportunity into
// Brand Tracker at the Outreach stage (Prospect). Single source of truth: this
// replaces the old separate athlete_deal_pipeline write. Dedupes on
// athlete + normalized brand name.
app.post('/api/athlete/deals/from-scan', verifyAthleteToken, async (req, res) => {
  try {
    const o = req.body || {};
    const brandName = (o.brand || o.brand_name || '').trim();
    if (!brandName) return res.status(400).json({ error: 'brand name required' });

    const fitScore = (o.fitScore != null && !isNaN(parseInt(o.fitScore))) ? parseInt(o.fitScore) : null;
    const isLocal = (o.isLocal === false) ? false : true; // scan marks local unless explicitly national

    // Dedupe: case/whitespace-insensitive match for this athlete.
    const existing = await store.pool.query(
      `SELECT * FROM athlete_self_deals
       WHERE athlete_id=$1 AND LOWER(TRIM(brand_name))=LOWER(TRIM($2)) LIMIT 1`,
      [req.athlete.id, brandName]
    );
    if (existing.rows.length) {
      // Already tracked — optionally refresh the fit score, but never duplicate.
      if (fitScore != null) {
        await store.pool.query(
          `UPDATE athlete_self_deals SET fit_score=$1, updated_at=NOW() WHERE id=$2 AND athlete_id=$3`,
          [fitScore, existing.rows[0].id, req.athlete.id]
        ).catch(() => {});
      }
      return res.json({ ok: true, existed: true, deal: existing.rows[0] });
    }

    // Map the rate range: store numeric midpoint in value, keep range text + idea
    // + approach in notes/description so nothing is lost.
    const lo = parseInt(o.estimatedValueLow) || null;
    const hi = parseInt(o.estimatedValueHigh) || null;
    let value = null, rangeText = null;
    if (lo && hi) { value = Math.round((lo + hi) / 2); rangeText = '$' + lo.toLocaleString() + '–$' + hi.toLocaleString() + ' per post'; }
    else if (lo || hi) { value = lo || hi; rangeText = '$' + (lo || hi).toLocaleString() + ' per post'; }

    const description = o.rationale || null;
    const laneLabel = o.lane === 'social' ? 'Social brand' : o.lane === 'topnil' ? 'Top NIL spender' : (isLocal ? 'Local business' : null);
    const noteParts = [];
    if (laneLabel) noteParts.push('Source lane: ' + laneLabel);
    if (rangeText) noteParts.push('Estimated rate: ' + rangeText);
    if (o.campaign) noteParts.push('Idea: ' + o.campaign);
    if (o.contactApproach) noteParts.push('Approach: ' + o.contactApproach);
    if (fitScore != null) noteParts.push('Fit score: ' + fitScore);
    const notes = noteParts.join('\n\n') || null;

    const stage = 'Prospect'; // Outreach-stage entry point
    const stageHistory = JSON.stringify([{ stage, date: new Date().toISOString(), note: 'Tracked from Deal Scan' }]);
    const r = await store.pool.query(
      `INSERT INTO athlete_self_deals
         (athlete_id, agent_id, brand_name, deal_type, value, stage, description, notes,
          category, contact_name, contact_email, fit_score, source, is_local, stage_history)
       VALUES ($1,$2,$3,'Other',$4,$5,$6,$7,$8,$9,$10,$11,'deal_scan',$12,$13) RETURNING *`,
      [req.athlete.id, req.athlete.agent_id || null, brandName, value, stage,
       description, notes, o.category || null, o.contactName || null,
       o.contactEmail || null, fitScore, isLocal, stageHistory]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_tracked_from_scan',
      `Tracked ${brandName} from Deal Scan`, { deal_id: r.rows[0].id, brand: brandName }).catch(() => {});
    console.log(`[athlete/deals/from-scan] tracked brand=${brandName} athlete=${req.athlete.id}`);
    res.json({ ok: true, existed: false, deal: r.rows[0] });
  } catch (e) {
    console.error('[athlete/deals/from-scan]', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Could not track deal: ' + (e && e.message ? e.message : 'unknown error') });
  }
});

// PUT /api/athlete/deals/:id — update deal
app.put('/api/athlete/deals/:id', verifyAthleteToken, async (req, res) => {
  try {
    const { brand_name, deal_type, value, stage, description, notes, start_date, deliverables, timeline } = req.body;
    const cur = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE id = $1 AND athlete_id = $2',
      [req.params.id, req.athlete.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const existing = cur.rows[0];
    let stageHistory = existing.stage_history || [];
    if (stage && stage !== existing.stage) {
      stageHistory = [...stageHistory, { stage, date: new Date().toISOString(), note: 'Stage updated' }];
      await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_stage_changed',
        `${existing.brand_name}: ${existing.stage} → ${stage}`, { deal_id: existing.id });
    }
    // Recompute fee breakdown when the deal amount changes (display/record only).
    const newValue = (value != null) ? value : existing.value;
    const fee = computeFee(newValue);
    // Once a deal reaches Agreed/Contract, disclosure becomes required (prompt
    // the athlete to disclose to their school). Don't downgrade an existing status.
    let disclosureStatus = existing.disclosure_status || 'not_required';
    const newStage = stage || existing.stage;
    if ((newStage === 'Agreed' || newStage === 'Contract') && disclosureStatus === 'not_required') {
      disclosureStatus = 'pending';
    }
    const r = await store.pool.query(
      `UPDATE athlete_self_deals SET
         brand_name=COALESCE($1,brand_name), deal_type=COALESCE($2,deal_type),
         value=COALESCE($3,value), stage=COALESCE($4,stage), description=COALESCE($5,description),
         notes=COALESCE($6,notes), start_date=COALESCE($7::DATE,start_date),
         deliverables=COALESCE($8,deliverables), timeline=COALESCE($9,timeline),
         fee_pct=$10, fee_amount=$11, net_amount=$12, disclosure_status=$13,
         stage_history=$14, updated_at=NOW()
       WHERE id=$15 AND athlete_id=$16 RETURNING *`,
      [brand_name||null, deal_type||null, value||null, stage||null, description||null,
       notes||null, start_date||null, deliverables||null, timeline||null,
       fee.fee_pct, (newValue ? fee.fee_amount : null), (newValue ? fee.net_amount : null),
       disclosureStatus, JSON.stringify(stageHistory), req.params.id, req.athlete.id]
    );
    res.json({ ok: true, deal: r.rows[0], platform_fee_pct: PLATFORM_FEE_PCT });
  } catch (e) { console.error('[athlete/deals PUT]', e.message); res.status(500).json({ error: e.message }); }
});

// DELETE /api/athlete/deals/:id
app.delete('/api/athlete/deals/:id', verifyAthleteToken, async (req, res) => {
  try {
    await store.pool.query('DELETE FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY LOOP — agreement → invoice → paid → earnings (+ disclosure)
// Deterministic, plain-language document generation. NO payment processing,
// NO Stripe Connect, NO payouts, NO money movement. Generate / store / display
// only. The platform fee (PLATFORM_FEE_PCT) is record/display only.
// ════════════════════════════════════════════════════════════════════════════

// Fetch this athlete's identity (name/school/sport) for documents.
async function _getAthleteIdentity(athleteId) {
  const r = await store.pool.query(
    `SELECT a.email, a.phone,
            a.data->>'name' as name, a.data->>'sport' as sport,
            a.data->>'school' as school, a.data->>'position' as position,
            a.state as state
     FROM athletes a WHERE a.id = $1`, [athleteId]
  );
  return r.rows[0] || {};
}

function _money(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _today() { return new Date().toISOString().slice(0, 10); }
function _fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return String(d); }
}

// Build the plain-language NIL deal agreement text.
function _buildAgreementText({ athlete, deal, deliverables, amount, timeline, terms }) {
  const fee = computeFee(amount);
  const lines = [];
  lines.push('NIL DEAL AGREEMENT');
  lines.push('==================');
  lines.push('');
  lines.push('Date: ' + _fmtDate(_today()));
  lines.push('');
  lines.push('PARTIES');
  lines.push('-------');
  lines.push('Athlete: ' + (athlete.name || '—'));
  if (athlete.school) lines.push('School: ' + athlete.school);
  if (athlete.sport) lines.push('Sport: ' + athlete.sport + (athlete.position ? ' (' + athlete.position + ')' : ''));
  lines.push('Brand / Partner: ' + (deal.brand_name || '—'));
  lines.push('');
  lines.push('DELIVERABLES');
  lines.push('------------');
  lines.push(deliverables || deal.deliverables || deal.description || 'See description provided by the parties.');
  lines.push('');
  lines.push('COMPENSATION');
  lines.push('------------');
  lines.push('Total deal amount: ' + _money(amount));
  if (fee.fee_pct > 0) {
    lines.push('NILDash platform fee (' + fee.fee_pct + '%): ' + _money(fee.fee_amount) + ' (record only — not collected by NILDash)');
    lines.push('Net to athlete: ' + _money(fee.net_amount));
  }
  lines.push('');
  lines.push('TIMELINE');
  lines.push('--------');
  lines.push(timeline || deal.timeline || 'To be agreed by the parties.');
  lines.push('');
  lines.push('BASIC TERMS');
  lines.push('-----------');
  lines.push('1. The athlete will complete the deliverables described above in good faith.');
  lines.push('2. The brand will pay the total deal amount per the timeline and any invoice issued.');
  lines.push('3. The athlete retains ownership of their name, image, and likeness except as');
  lines.push('   licensed for the specific deliverables in this agreement.');
  lines.push('4. The athlete will include any disclosures required by the FTC and by their');
  lines.push('   school/conference/state NIL rules (e.g. #ad / #sponsored).');
  lines.push('5. Either party may end the agreement in writing if the other materially breaches it.');
  if (terms && String(terms).trim()) {
    lines.push('6. Additional terms: ' + String(terms).trim());
  }
  lines.push('');
  lines.push('SIGNATURES');
  lines.push('----------');
  lines.push('Athlete: ____________________________   Date: ____________');
  lines.push('Brand:   ____________________________   Date: ____________');
  lines.push('');
  lines.push('---');
  lines.push('This is not legal advice. This is a plain-language template to help you');
  lines.push('organize a NIL deal. Review it with a qualified professional (and your');
  lines.push('school compliance office) before signing.');
  return lines.join('\n');
}

// POST /api/athlete/deals/:id/agreement — generate & store a deal agreement
app.post('/api/athlete/deals/:id/agreement', verifyAthleteToken, async (req, res) => {
  try {
    const cur = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = cur.rows[0];
    const athlete = await _getAthleteIdentity(req.athlete.id);
    const b = req.body || {};
    const amount = (b.amount != null && b.amount !== '') ? Number(b.amount) : (deal.value || 0);
    const deliverables = (b.deliverables || deal.deliverables || deal.description || '').trim() || null;
    const timeline = (b.timeline || deal.timeline || '').trim() || null;
    const terms = (b.terms || '').trim() || null;
    const text = _buildAgreementText({ athlete, deal, deliverables, amount, timeline, terms });
    const json = { athlete: { name: athlete.name, school: athlete.school, sport: athlete.sport },
                   brand: deal.brand_name, deliverables, amount, timeline, terms,
                   fee: computeFee(amount), generated_at: new Date().toISOString() };
    const fee = computeFee(amount);
    const r = await store.pool.query(
      `UPDATE athlete_self_deals SET
         agreement_text=$1, agreement_json=$2, agreement_generated_at=NOW(),
         deliverables=COALESCE($3,deliverables), timeline=COALESCE($4,timeline),
         value=COALESCE($5,value), fee_pct=$6, fee_amount=$7, net_amount=$8, updated_at=NOW()
       WHERE id=$9 AND athlete_id=$10 RETURNING *`,
      [text, JSON.stringify(json), deliverables, timeline, amount || null,
       fee.fee_pct, amount ? fee.fee_amount : null, amount ? fee.net_amount : null,
       req.params.id, req.athlete.id]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_agreement_generated',
      `Generated agreement for ${deal.brand_name}`, { deal_id: deal.id }).catch(() => {});
    res.json({ ok: true, agreement: text, deal: r.rows[0] });
  } catch (e) { console.error('[athlete/deals agreement]', e.message); res.status(500).json({ error: e.message }); }
});

// Build the invoice text.
function _buildInvoiceText({ athlete, deal, invoiceNumber, issueDate, dueDate, deliverables, amount, payeeInfo }) {
  const fee = computeFee(amount);
  const lines = [];
  lines.push('INVOICE');
  lines.push('=======');
  lines.push('');
  lines.push('Invoice #: ' + invoiceNumber);
  lines.push('Issue date: ' + _fmtDate(issueDate));
  lines.push('Due date: ' + _fmtDate(dueDate));
  lines.push('');
  lines.push('FROM (PAYEE)');
  lines.push('------------');
  lines.push(athlete.name || '—');
  if (athlete.school) lines.push(athlete.school + (athlete.sport ? ' — ' + athlete.sport : ''));
  if (athlete.email) lines.push(athlete.email);
  if (athlete.phone) lines.push(athlete.phone);
  lines.push('');
  lines.push('BILL TO (PAYER)');
  lines.push('---------------');
  lines.push(deal.brand_name || '—');
  if (deal.contact_name) lines.push('Attn: ' + deal.contact_name);
  if (deal.contact_email) lines.push(deal.contact_email);
  lines.push('');
  lines.push('DESCRIPTION');
  lines.push('-----------');
  lines.push(deliverables || deal.deliverables || deal.description || 'NIL deliverables');
  lines.push('');
  lines.push('AMOUNT');
  lines.push('------');
  lines.push('Amount due: ' + _money(amount));
  if (fee.fee_pct > 0) {
    lines.push('(NILDash platform fee ' + fee.fee_pct + '%: ' + _money(fee.fee_amount) + ' — record only; net to athlete ' + _money(fee.net_amount) + ')');
  }
  lines.push('');
  lines.push('PAYMENT INSTRUCTIONS');
  lines.push('--------------------');
  lines.push(payeeInfo || 'See payment details provided by the athlete.');
  lines.push('');
  lines.push('Please reference invoice #' + invoiceNumber + ' with your payment. Thank you!');
  return lines.join('\n');
}

// POST /api/athlete/deals/:id/invoice — generate & store an invoice
app.post('/api/athlete/deals/:id/invoice', verifyAthleteToken, async (req, res) => {
  try {
    const cur = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = cur.rows[0];
    const athlete = await _getAthleteIdentity(req.athlete.id);
    const b = req.body || {};
    const payeeInfo = (b.payee_info || deal.payee_info || '').trim() || null;
    if (!payeeInfo) return res.status(400).json({ error: 'Payment instructions (payee_info) are required to generate an invoice.' });
    const amount = (b.amount != null && b.amount !== '') ? Number(b.amount) : (deal.value || 0);
    const deliverables = (b.deliverables || deal.deliverables || deal.description || '').trim() || null;
    const invoiceNumber = (b.invoice_number || deal.invoice_number || ('INV-' + String(deal.id).padStart(4, '0') + '-' + _today().replace(/-/g, ''))).trim();
    const issueDate = b.issue_date || deal.invoice_issue_date || _today();
    let dueDate = b.due_date || deal.invoice_due_date || null;
    if (!dueDate) { const d = new Date(); d.setDate(d.getDate() + 30); dueDate = d.toISOString().slice(0, 10); }
    const text = _buildInvoiceText({ athlete, deal, invoiceNumber, issueDate, dueDate, deliverables, amount, payeeInfo });
    const json = { invoiceNumber, issueDate, dueDate, deliverables, amount, payeeInfo,
                   payer: deal.brand_name, fee: computeFee(amount), generated_at: new Date().toISOString() };
    const fee = computeFee(amount);
    // Generating an invoice advances the deal to "Invoiced" (unless already Paid/Completed).
    let newStage = deal.stage;
    let stageHistory = deal.stage_history || [];
    if (['Prospect', 'Pitched', 'In Talks', 'Agreed', 'Contract'].indexOf(deal.stage) > -1) {
      newStage = 'Invoiced';
      stageHistory = [...stageHistory, { stage: newStage, date: new Date().toISOString(), note: 'Invoice generated' }];
    }
    const r = await store.pool.query(
      `UPDATE athlete_self_deals SET
         invoice_text=$1, invoice_json=$2, invoice_number=$3,
         invoice_issue_date=$4::DATE, invoice_due_date=$5::DATE, payee_info=$6,
         deliverables=COALESCE($7,deliverables), value=COALESCE($8,value),
         fee_pct=$9, fee_amount=$10, net_amount=$11, stage=$12, stage_history=$13, updated_at=NOW()
       WHERE id=$14 AND athlete_id=$15 RETURNING *`,
      [text, JSON.stringify(json), invoiceNumber, issueDate, dueDate, payeeInfo,
       deliverables, amount || null, fee.fee_pct, amount ? fee.fee_amount : null, amount ? fee.net_amount : null,
       newStage, JSON.stringify(stageHistory), req.params.id, req.athlete.id]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_invoice_generated',
      `Generated invoice ${invoiceNumber} for ${deal.brand_name}`, { deal_id: deal.id }).catch(() => {});
    res.json({ ok: true, invoice: text, deal: r.rows[0] });
  } catch (e) { console.error('[athlete/deals invoice]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deals/:id/mark-paid — record payment received (no money movement)
app.post('/api/athlete/deals/:id/mark-paid', verifyAthleteToken, async (req, res) => {
  try {
    const cur = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE id=$1 AND athlete_id=$2',
      [req.params.id, req.athlete.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = cur.rows[0];
    const b = req.body || {};
    const paidDate = b.paid_date || _today();
    const amountReceived = (b.amount_received != null && b.amount_received !== '') ? Number(b.amount_received) : (deal.value || 0);
    const fee = computeFee(amountReceived); // recompute against what was actually received
    const newStage = (b.stage === 'Completed') ? 'Completed' : 'Paid';
    const stageHistory = [...(deal.stage_history || []),
      { stage: newStage, date: new Date().toISOString(), note: 'Marked paid: ' + _money(amountReceived) }];
    const r = await store.pool.query(
      `UPDATE athlete_self_deals SET
         paid_date=$1::DATE, amount_received=$2, value=COALESCE(value,$2),
         fee_pct=$3, fee_amount=$4, net_amount=$5, stage=$6, stage_history=$7, updated_at=NOW()
       WHERE id=$8 AND athlete_id=$9 RETURNING *`,
      [paidDate, amountReceived, fee.fee_pct, fee.fee_amount, fee.net_amount,
       newStage, JSON.stringify(stageHistory), req.params.id, req.athlete.id]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_marked_paid',
      `${deal.brand_name} marked paid: ${_money(amountReceived)}`, { deal_id: deal.id }).catch(() => {});
    res.json({ ok: true, deal: r.rows[0] });
  } catch (e) { console.error('[athlete/deals mark-paid]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deals/:id/disclosure — update school-disclosure status
app.post('/api/athlete/deals/:id/disclosure', verifyAthleteToken, async (req, res) => {
  try {
    const allowed = ['not_required', 'pending', 'disclosed'];
    const status = (req.body && req.body.disclosure_status) || '';
    if (allowed.indexOf(status) === -1) return res.status(400).json({ error: 'Invalid disclosure_status' });
    const disclosureDate = status === 'disclosed' ? (req.body.disclosure_date || _today()) : null;
    const r = await store.pool.query(
      `UPDATE athlete_self_deals SET disclosure_status=$1, disclosure_date=$2::DATE, updated_at=NOW()
       WHERE id=$3 AND athlete_id=$4 RETURNING *`,
      [status, disclosureDate, req.params.id, req.athlete.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Deal not found' });
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_disclosure_updated',
      `${r.rows[0].brand_name} disclosure: ${status}`, { deal_id: r.rows[0].id }).catch(() => {});
    res.json({ ok: true, deal: r.rows[0] });
  } catch (e) { console.error('[athlete/deals disclosure]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/earnings — system-of-record earnings summary (math from deals)
app.get('/api/athlete/earnings', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      'SELECT * FROM athlete_self_deals WHERE athlete_id=$1', [req.athlete.id]
    );
    const deals = r.rows;
    const PAID = ['Paid', 'Completed'];
    const PENDING = ['Agreed', 'Contract', 'Invoiced'];
    const year = new Date().getFullYear();
    let totalEarned = 0, totalPending = 0, ytdEarned = 0, dealsClosed = 0, totalFees = 0, totalNet = 0;
    const byYear = {}; // year -> { earned, net, fees, count }
    const paidList = [];
    for (const d of deals) {
      if (PAID.indexOf(d.stage) > -1) {
        const received = Number(d.amount_received != null ? d.amount_received : (d.value || 0)) || 0;
        const fee = Number(d.fee_amount || 0);
        const net = Number(d.net_amount != null ? d.net_amount : received) || received;
        totalEarned += received;
        totalFees += fee;
        totalNet += net;
        dealsClosed += 1;
        const py = d.paid_date ? new Date(d.paid_date).getFullYear() : (d.updated_at ? new Date(d.updated_at).getFullYear() : year);
        if (py === year) ytdEarned += received;
        if (!byYear[py]) byYear[py] = { year: py, earned: 0, net: 0, fees: 0, count: 0 };
        byYear[py].earned += received; byYear[py].net += net; byYear[py].fees += fee; byYear[py].count += 1;
        paidList.push({ id: d.id, brand: d.brand_name, amount: received, fee, net,
                        paid_date: d.paid_date, stage: d.stage });
      } else if (PENDING.indexOf(d.stage) > -1) {
        totalPending += Number(d.value || 0) || 0;
      }
    }
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    res.json({
      platform_fee_pct: PLATFORM_FEE_PCT,
      current_year: year,
      total_earned: round2(totalEarned),
      total_net: round2(totalNet),
      total_fees: round2(totalFees),
      total_pending: round2(totalPending),
      deals_closed: dealsClosed,
      ytd_earned: round2(ytdEarned),
      by_year: Object.values(byYear).sort((a, b) => b.year - a.year)
        .map(y => ({ year: y.year, earned: round2(y.earned), net: round2(y.net), fees: round2(y.fees), count: y.count })),
      paid_deals: paidList.sort((a, b) => new Date(b.paid_date || 0) - new Date(a.paid_date || 0)),
    });
  } catch (e) { console.error('[athlete/earnings]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/command — athlete AI command (SSE stream)
app.post('/api/athlete/command', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const athR = await store.pool.query(
      `SELECT a.data, a.instagram_handle, a.tiktok_handle,
              a.instagram_followers, a.tiktok_followers,
              a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'position' as position,
              a.data->>'school' as school, a.data->>'year' as year,
              a.data->>'instagram' as ig, a.data->>'tiktok' as tt
       FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const ath = athR.rows[0] || {};
    // Followers: prefer data JSON (agent-managed), fall back to dedicated columns (self-signup)
    const ig = parseInt(ath.ig || 0) || ath.instagram_followers || 0;
    const tt = parseInt(ath.tt || 0) || ath.tiktok_followers || 0;
    const nilLow = Math.round(ig * 0.01 / 10) * 10;
    const nilHigh = Math.round(ig * 0.03 / 10) * 10;
    const nilEst = nilLow > 0 ? `$${nilLow.toLocaleString()}–$${nilHigh.toLocaleString()} per post` : 'TBD (add followers to profile)';

    const system = `You are a sharp, knowledgeable NIL advisor talking directly to a college athlete. You know everything about NIL deals, brand partnerships, contracts, and how to build a personal brand.

The athlete you are talking to: ${ath.name || 'the athlete'}, ${ath.year || 'college'} ${ath.position || 'athlete'} at ${ath.school || 'their university'} playing ${ath.sport || 'their sport'}. Estimated NIL value: ${nilEst}. Instagram: ${ig.toLocaleString()} followers. TikTok: ${tt.toLocaleString()} followers.

Your communication style:
- Talk like a smart friend who knows the game, not a consultant
- Short paragraphs, no walls of text
- Never use markdown headers (##, ###) or bullet point dashes (-)
- Never use formal opening lines like "Great question!" or "I hope this message finds you well"
- Use numbered lists only when walking through steps — never for general information
- Be direct and confident — give real advice, not generic platitudes
- Speak to the athlete like they are smart and capable
- Use natural conversational language

Example of WRONG tone:
"## Your Brand Strategy
- Leverage your social media presence
- Engage with potential partners
- Build authentic connections"

Example of RIGHT tone:
"Here is what actually works for athletes at your level. Start local — brands near your campus are the easiest first deals and they move fast. Coffee shops, gyms, local apparel stores. Get one deal done, add it to your media kit, then use that to pitch bigger brands. The first deal is always the hardest."

Never give legal advice but help them understand what questions to ask.`;

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = anthropicClient.messages.stream({
      model: 'claude-opus-4-8', max_tokens: 1024, system,
      messages: [{ role: 'user', content: message }],
    });
    stream.on('text', text => res.write(`data: ${JSON.stringify({ text })}\n\n`));
    stream.on('error', err => { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); });
    await stream.finalMessage();
    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`[athlete/command] athlete=${req.athlete.id} msg="${message.substring(0,60)}"`);
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'ai_command', 'Used AI Command', {}).catch(() => {});
  } catch (e) {
    console.error('[athlete/command]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Shared helper: build the athleteObj shape ai.getDealRecommendations() expects.
// Also returns agentId for ownership checks in the agent endpoint.
async function loadDealScanAthlete(athleteId) {
  const athR = await store.pool.query(
    `SELECT a.data, a.agent_id, a.instagram_handle, a.tiktok_handle,
            a.instagram_followers, a.tiktok_followers, a.twitter_followers,
            a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'school' as school,
            a.data->>'schoolTier' as school_tier, a.data->>'instagram' as ig,
            a.data->>'tiktok' as tt, a.data->>'position' as position, a.data->>'year' as year,
            a.data->>'engagement' as engagement, a.data->>'stats' as stats,
            a.data->>'hometown' as hometown, a.data->>'notes' as notes,
            a.data->'tags' as tags, a.data->>'productWants' as product_wants
     FROM athletes a WHERE a.id = $1`,
    [athleteId]
  );
  const ath = athR.rows[0];
  if (!ath) return null;
  // Followers: prefer data JSON (agent-managed), fall back to dedicated columns (self-signup)
  const dsIg = parseInt(ath.ig) || ath.instagram_followers || 0;
  const dsTt = parseInt(ath.tt) || ath.tiktok_followers || 0;
  const athleteObj = {
    name: ath.name,
    sport: ath.sport,
    position: ath.position,
    year: ath.year,
    school: ath.school,
    schoolTier: ath.school_tier,
    instagram: dsIg,
    tiktok: dsTt,
    engagement: parseFloat(ath.engagement) || 0,
    stats: ath.stats || '',
    // hometown drives the Deal Scan second market; notes drive category
    // weighting. Omitting them here is what silently disabled hometown
    // results in production.
    hometown: ath.hometown || '',
    notes: ath.notes || '',
    // Interest tags + product wants drive search emphasis and scoring boosts.
    // Defensive read: the dedicated jsonb projection first, then the full data
    // blob (also selected above), then a JSON-string unwrap, so tags reach the
    // scan no matter how this row's shape or the driver's parsing behaves.
    tags: (() => {
      let t = ath.tags;
      if (!Array.isArray(t) && ath.data && Array.isArray(ath.data.tags)) t = ath.data.tags;
      if (typeof t === 'string') { try { t = JSON.parse(t); } catch (_) { t = []; } }
      return Array.isArray(t) ? t.filter((x) => typeof x === 'string') : [];
    })(),
    productWants: ath.product_wants || (ath.data && typeof ath.data.productWants === 'string' ? ath.data.productWants : '') || '',
  };
  return { agentId: ath.agent_id, athleteObj };
}

// POST /api/athlete/deal-scan — find brand deals for this athlete
app.post('/api/athlete/deal-scan', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const loaded = await loadDealScanAthlete(req.athlete.id);
    if (!loaded) return res.status(404).json({ error: 'Athlete not found' });
    const athleteObj = loaded.athleteObj;

    const excludeBrands = req.body.exclude_brands || [];
    // Lane: 'local' (default when omitted), 'social', or 'topnil'. An
    // unrecognized value is a 400, never a silent full local run.
    if (req.body.lane !== undefined && req.body.lane !== null && !['local', 'social', 'topnil'].includes(req.body.lane)) {
      return res.status(400).json({ error: 'Invalid lane. Must be one of: local, social, topnil.' });
    }
    const lane = req.body.lane || 'local';
    console.log(`[athlete/deal-scan] athlete=${req.athlete.id} lane=${lane} name=${athleteObj.name} sport=${athleteObj.sport} school=${athleteObj.school}`);
    let recommendations = await ai.getDealRecommendations(athleteObj, 'athlete', excludeBrands, lane);
    // Unconditional matchedTags derivation at the route boundary (same as the
    // agent route): every lane, every source, right before persist/response.
    const _tagSubs = ai.validTagSubs(athleteObj.tags);
    console.log(`[dealScan] derivation input lane=${lane} (athlete portal): athleteTags=${JSON.stringify(athleteObj.tags)} -> validSubs=${JSON.stringify(_tagSubs)}`);
    recommendations = (recommendations || []).map((o) => ({
      ...o,
      matchedTags: ai.deriveMatchedTags(o, { evidence: o.evidence || null }, _tagSubs),
    }));
    console.log(`[dealScan] derivation: ${_tagSubs.length} athlete tags -> ${recommendations.filter((o) => o.matchedTags.length).length} results tagged (${recommendations.reduce((n, o) => n + o.matchedTags.length, 0)} chips total)`);
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_scan', `Ran deal scan (${lane})`, {});
    console.log(`[athlete/deal-scan] lane=${lane} found=${recommendations.length}`);
    // Persist this lane's results so re-entering Deal Scan / reloading re-hydrates
    // the athlete's opportunities. NON-DESTRUCTIVE: only overwrite when we got
    // genuine results, so a transient empty refresh never wipes a good cache.
    if (recommendations.length) {
      await store.pool.query(
        `UPDATE athletes SET deal_scan_cache = COALESCE(deal_scan_cache, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [lane]: { opportunities: recommendations, ts: Date.now() } }), req.athlete.id]
      ).catch(e => console.error('[athlete/deal-scan] cache persist:', e.message));
    }
    const rateCard = await _athleteRateCard(req.athlete.id);
    res.json({ opportunities: recommendations, lane, rateCard });
  } catch (e) { console.error('[athlete/deal-scan]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/deal-scan/cache — hydrate the last persisted scan + rate card
app.get('/api/athlete/deal-scan/cache', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query('SELECT deal_scan_cache, data->\'tags\' as tags FROM athletes WHERE id = $1', [req.athlete.id]);
    const cache = rederiveScanCacheTags((r.rows[0] && r.rows[0].deal_scan_cache) || {}, (r.rows[0] && r.rows[0].tags) || []);
    const rateCard = await _athleteRateCard(req.athlete.id);
    res.json({ cache, rateCard });
  } catch (e) { console.error('[athlete/deal-scan/cache]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/agent/deal-scan — agent-side three-lane deal scan for a client athlete
app.post('/api/agent/deal-scan', requireAuth, requireAgentSubscription, aiLimiter, async (req, res) => {
  try {
    const { athleteId, lane, exclude_brands } = req.body;
    const loaded = await loadDealScanAthlete(athleteId);
    if (!loaded) return res.status(404).json({ error: 'Athlete not found' });
    const _ru = await store.getUser(req.session.userId);
    const _isAdmin = _ru && (_ru.role === 'admin' || isFounderEmail(_ru.email));
    if (loaded.agentId !== req.session.userId && !_isAdmin) return res.status(403).json({ error: 'Forbidden' });
    // Lane must be one of the known set. A missing lane defaults to 'local' for
    // backward compatibility; a PRESENT but unrecognized value is a 400 so a bad
    // client cannot silently burn a full local pipeline run.
    if (lane !== undefined && lane !== null && !['local', 'social', 'topnil'].includes(lane)) {
      return res.status(400).json({ error: 'Invalid lane. Must be one of: local, social, topnil.' });
    }
    const validLane = lane || 'local';
    const excludeBrands = Array.isArray(exclude_brands) ? exclude_brands : [];
    let recommendations = await ai.getDealRecommendations(loaded.athleteObj, 'agent', excludeBrands, validLane);
    // Keep Refresh full: if excluding shown brands leaves a thin lane, top up from a no-exclude
    // run, newest first, de-duped, up to TARGET so lanes don't shrink on repeated refreshes.
    // Lane targets: Local is primary (8-10), Social shows up to 6, Top NIL up to 4.
    const TARGET = validLane === 'local' ? 8 : validLane === 'social' ? 6 : 4;
    if (recommendations.length < TARGET && excludeBrands.length) {
      const fresh = await ai.getDealRecommendations(loaded.athleteObj, 'agent', [], validLane);
      const seen = new Set(recommendations.map(r => (r.brand || '').toLowerCase()));
      for (const f of (fresh || [])) {
        if (recommendations.length >= TARGET) break;
        const key = (f.brand || '').toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); recommendations.push(f); }
      }
    }
    // Unconditional matchedTags derivation at the route boundary, applied to
    // the final array for EVERY lane and EVERY source (web, knowledge,
    // fallback). This is the single spot every scan response passes through,
    // so a lane path that forgets derivation can no longer ship empty tags.
    const _tagSubs = ai.validTagSubs(loaded.athleteObj.tags);
    // Instrumentation: log the ACTUAL derivation inputs (tag values, not
    // truthiness, plus the first candidate's strings) so one production scan
    // proves where empty chips come from.
    const _first = (recommendations || [])[0] || {};
    console.log(`[dealScan] derivation input lane=${validLane}: athleteTags=${JSON.stringify(loaded.athleteObj.tags)} -> validSubs=${JSON.stringify(_tagSubs)} | first candidate name="${_first.brand || ''}" category="${_first.category || ''}" evidence="${String(_first.evidence || '').slice(0, 60)}"`);
    recommendations = (recommendations || []).map((o) => ({
      ...o,
      matchedTags: ai.deriveMatchedTags(o, { evidence: o.evidence || null }, _tagSubs),
    }));
    const _taggedN = recommendations.filter((o) => o.matchedTags.length).length;
    const _chipsN = recommendations.reduce((n, o) => n + o.matchedTags.length, 0);
    console.log(`[dealScan] derivation: ${_tagSubs.length} athlete tags -> ${_taggedN} results tagged (${_chipsN} chips total)`);
    if (recommendations.length) {
      await store.pool.query(
        `UPDATE athletes SET deal_scan_cache = COALESCE(deal_scan_cache, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [validLane]: { opportunities: recommendations, ts: Date.now() } }), athleteId]
      ).catch(e => console.error('[agent/deal-scan] cache persist:', e.message));
    }
    const rateCard = await _athleteRateCard(athleteId);
    checkOff(req.session.userId, 'deal_scan'); // Getting Started checklist
    res.json({ opportunities: recommendations, lane: validLane, rateCard });
  } catch (e) { console.error('[agent/deal-scan]', e.message); res.status(500).json({ error: e.message }); }
});

// Re-derive matchedTags on saved scan results at response-assembly time, so
// historical scans (from any code version) and tag edits after a scan still
// show correct chips. Purely additive: derivation is grounded in the result's
// own strings and the athlete's REAL tags; with no tags it yields [].
function rederiveScanCacheTags(cache, athleteTags) {
  try {
    const subs = ai.validTagSubs(athleteTags);
    for (const laneKey of Object.keys(cache || {})) {
      const opps = cache[laneKey] && cache[laneKey].opportunities;
      if (!Array.isArray(opps)) continue;
      for (const o of opps) {
        o.matchedTags = ai.deriveMatchedTags(o, { evidence: o.evidence || null }, subs);
      }
    }
  } catch (e) { console.warn('[deal-scan/cache] tag rederive failed:', e.message); }
  return cache;
}

// GET /api/agent/deal-scan/cache — hydrate last persisted scan for a client athlete
app.get('/api/agent/deal-scan/cache', requireAuth, async (req, res) => {
  try {
    const athleteId = req.query.athleteId;
    const athlete = await store.getAthlete(athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const _ru = await store.getUser(req.session.userId);
    const _isAdmin = _ru && (_ru.role === 'admin' || isFounderEmail(_ru.email));
    if (athlete.agentId !== req.session.userId && !_isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const r = await store.pool.query('SELECT deal_scan_cache FROM athletes WHERE id = $1', [athleteId]);
    const cache = rederiveScanCacheTags((r.rows[0] && r.rows[0].deal_scan_cache) || {}, athlete.tags);
    const rateCard = await _athleteRateCard(athleteId);
    res.json({ cache, rateCard });
  } catch (e) { console.error('[agent/deal-scan/cache]', e.message); res.status(500).json({ error: e.message }); }
});

// Build the athlete's per-deliverable rate card using the SAME model the Rate
// Calculator uses (benchmarks.nilViewVal + cleanRange) — single source of truth.
// Returns { rates:{deliverable:{low,high}}, dealValueLow, dealValueHigh }.
// dealValueLow ≈ a single deliverable; dealValueHigh ≈ a multi-deliverable bundle.
async function _athleteRateCard(athleteId) {
  try {
    const row = await store.pool.query('SELECT * FROM athletes WHERE id = $1', [athleteId]);
    if (!row.rows.length) return null;
    const dbRow = row.rows[0];
    const a = { id: dbRow.id, ...(dbRow.data || {}) };
    if (a.instagram == null && dbRow.instagram_followers != null) a.instagram = dbRow.instagram_followers;
    if (a.tiktok == null && dbRow.tiktok_followers != null) a.tiktok = dbRow.tiktok_followers;
    if (a.twitter == null && dbRow.twitter_followers != null) a.twitter = dbRow.twitter_followers;
    const { nilViewVal, cleanRange } = require('./benchmarks');
    const cr = (t) => { const r = nilViewVal(a, t); return cleanRange(r.low, r.high); };
    const rates = {
      'ig-post': cr('ig-post'), 'ig-reel': cr('ig-reel'), 'stories': cr('stories'),
      'tiktok': cr('tiktok'), 'appearance-inperson': cr('appearance-inperson'), 'bundle': cr('bundle'),
    };
    const singleLows = ['ig-post', 'ig-reel', 'stories', 'tiktok']
      .map(k => rates[k] && rates[k].low).filter(Boolean);
    let dealValueLow = singleLows.length ? Math.min(...singleLows) : ((rates['ig-post'] && rates['ig-post'].low) || 0);
    let dealValueHigh = (rates['bundle'] && rates['bundle'].high) || 0;
    if (!dealValueHigh || dealValueHigh <= dealValueLow) {
      const allHighs = Object.values(rates).map(r => r && r.high).filter(Boolean);
      dealValueHigh = allHighs.length ? Math.max(...allHighs) : dealValueLow * 3;
    }
    if (dealValueHigh <= dealValueLow) dealValueHigh = dealValueLow * 3;
    return { rates, dealValueLow, dealValueHigh };
  } catch (e) { console.error('[_athleteRateCard]', e.message); return null; }
}

// Helper: load an athlete object for AI calls (followers from data JSON or columns)
async function _loadAthleteObjForAI(athleteId) {
  const r = await store.pool.query(
    `SELECT a.data, a.instagram_followers, a.tiktok_followers, a.twitter_followers,
            a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'school' as school,
            a.data->>'instagram' as ig, a.data->>'tiktok' as tt, a.data->>'position' as position,
            a.data->>'year' as year, a.data->>'engagement' as engagement, a.data->>'stats' as stats
     FROM athletes a WHERE a.id = $1`, [athleteId]);
  const ath = r.rows[0];
  if (!ath) return null;
  return {
    name: ath.name, sport: ath.sport, position: ath.position, year: ath.year,
    school: ath.school,
    instagram: parseInt(ath.ig) || ath.instagram_followers || 0,
    tiktok: parseInt(ath.tt) || ath.tiktok_followers || 0,
    twitter: ath.twitter_followers || 0,
    engagement: parseFloat(ath.engagement) || 0,
    stats: ath.stats || '',
  };
}

// POST /api/athlete/deal-pitch — generate a personalized pitch for a brand (preview)
app.post('/api/athlete/deal-pitch', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const brand = req.body.brand || {};
    if (!brand.brand && !brand.brand_name) return res.status(400).json({ error: 'brand required' });
    const athleteObj = await _loadAthleteObjForAI(req.athlete.id);
    if (!athleteObj) return res.status(404).json({ error: 'Athlete not found' });
    const pitch = await ai.generateDealPitch(athleteObj, brand);
    res.json({ pitch });
  } catch (e) { console.error('[athlete/deal-pitch]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/deal-pipeline — list this athlete's pipeline
app.get('/api/athlete/deal-pipeline', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT * FROM athlete_deal_pipeline WHERE athlete_id=$1 ORDER BY
         CASE status WHEN 'deal_closed' THEN 0 WHEN 'in_talks' THEN 1 WHEN 'pitched' THEN 2
                     WHEN 'not_contacted' THEN 3 WHEN 'no_response' THEN 4 ELSE 5 END,
         updated_at DESC`,
      [req.athlete.id]
    );
    res.json({ pipeline: r.rows });
  } catch (e) { console.error('[deal-pipeline GET]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deal-pipeline — add/save a brand to pipeline
app.post('/api/athlete/deal-pipeline', verifyAthleteToken, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.brand_name) return res.status(400).json({ error: 'brand_name required' });
    // Avoid duplicates: if this brand already exists for athlete, return it
    const existing = await store.pool.query(
      `SELECT * FROM athlete_deal_pipeline WHERE athlete_id=$1 AND LOWER(brand_name)=LOWER($2) LIMIT 1`,
      [req.athlete.id, b.brand_name]
    );
    if (existing.rows.length) return res.json({ entry: existing.rows[0], existed: true });
    const status = b.status || 'not_contacted';
    const pitchedAt = status === 'pitched' ? new Date() : null;
    const r = await store.pool.query(
      `INSERT INTO athlete_deal_pipeline
         (athlete_id, agent_id, brand_name, brand_category, contact_email, contact_name,
          status, deal_value, pitch_subject, pitch_body, pitched_at, last_contact_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [req.athlete.id, req.athlete.agent_id || null, b.brand_name, b.brand_category || null,
       b.contact_email || null, b.contact_name || null, status, b.deal_value || null,
       b.pitch_subject || null, b.pitch_body || null, pitchedAt]
    );
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'deal_pipeline_add', `Added ${b.brand_name} to deal pipeline`, {}).catch(()=>{});
    res.json({ entry: r.rows[0] });
  } catch (e) { console.error('[deal-pipeline POST]', e.message); res.status(500).json({ error: e.message }); }
});

// PUT /api/athlete/deal-pipeline/:id — update status / notes
app.put('/api/athlete/deal-pipeline/:id', verifyAthleteToken, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const own = await store.pool.query('SELECT * FROM athlete_deal_pipeline WHERE id=$1 AND athlete_id=$2', [id, req.athlete.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
    const cur = own.rows[0];
    const status = b.status || cur.status;
    // When transitioning to pitched, record pitched_at if not already set
    const pitchedAt = (status === 'pitched' && !cur.pitched_at) ? new Date() : cur.pitched_at;
    const lastContact = (b.touch || status === 'pitched') ? new Date() : cur.last_contact_at;
    const r = await store.pool.query(
      `UPDATE athlete_deal_pipeline
         SET status=$1, notes=COALESCE($2,notes), deal_value=COALESCE($3,deal_value),
             pitched_at=$4, last_contact_at=$5, updated_at=NOW()
       WHERE id=$6 AND athlete_id=$7 RETURNING *`,
      [status, b.notes ?? null, b.deal_value ?? null, pitchedAt, lastContact, id, req.athlete.id]
    );
    res.json({ entry: r.rows[0] });
  } catch (e) { console.error('[deal-pipeline PUT]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/deal-pipeline/:id/followup — generate (and optionally send) a follow-up
app.post('/api/athlete/deal-pipeline/:id/followup', verifyAthleteToken, async (req, res) => {
  try {
    const id = req.params.id;
    const own = await store.pool.query('SELECT * FROM athlete_deal_pipeline WHERE id=$1 AND athlete_id=$2', [id, req.athlete.id]);
    if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
    const entry = own.rows[0];
    const athleteObj = await _loadAthleteObjForAI(req.athlete.id);
    const followup = await ai.generateFollowUp(athleteObj, entry);
    // If send=true and we have a contact email, send it via the shared email path
    if (req.body.send && entry.contact_email) {
      await _sendAthleteEmail(req.athlete, entry.contact_email, followup.subject, followup.body);
      await store.pool.query(
        `UPDATE athlete_deal_pipeline SET last_contact_at=NOW(), updated_at=NOW() WHERE id=$1 AND athlete_id=$2`,
        [id, req.athlete.id]
      );
      return res.json({ followup, sent: true });
    }
    res.json({ followup, sent: false });
  } catch (e) { console.error('[deal-pipeline followup]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/rate-calculator — calculate athlete's own rates (full benchmarks)
app.post('/api/athlete/rate-calculator', verifyAthleteToken, async (req, res) => {
  try {
    const delivType = req.body.deliverable_type || 'ig-reel';
    const row = await store.pool.query('SELECT * FROM athletes WHERE id = $1', [req.athlete.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const dbRow = row.rows[0];
    const athleteObj = { id: dbRow.id, agentId: dbRow.agent_id, ...dbRow.data };
    // Merge dedicated follower columns (self-signup) — nilViewVal reads .instagram/.tiktok/.twitter
    // Prefer the data JSON value if present (agent-managed), otherwise use the dedicated column.
    if (athleteObj.instagram == null && dbRow.instagram_followers != null) athleteObj.instagram = dbRow.instagram_followers;
    if (athleteObj.tiktok == null && dbRow.tiktok_followers != null) athleteObj.tiktok = dbRow.tiktok_followers;
    if (athleteObj.twitter == null && dbRow.twitter_followers != null) athleteObj.twitter = dbRow.twitter_followers;
    const {
      nilViewVal, cleanRange, generateRateDrivers, generateRateLimitations,
      calcMarketReliabilityScore, generateConfidenceTypes, generateComparableNote,
      generateMomentumSignal, generatePricingStrategy
    } = require('./benchmarks');
    const rate = nilViewVal(athleteObj, delivType);
    const cleaned = cleanRange(rate.low, rate.high);
    const compCount = 0; // no actual comps yet — honest
    const rateDrivers   = generateRateDrivers(athleteObj, rate);
    const rateLimits    = generateRateLimitations(athleteObj, rate, compCount);
    const reliability   = calcMarketReliabilityScore(athleteObj, rate, compCount);
    const confTypes     = generateConfidenceTypes(athleteObj, rate, compCount);
    const compNote      = generateComparableNote(athleteObj, rate);
    const momentum      = generateMomentumSignal(athleteObj);
    const pricingStrategy = generatePricingStrategy(rate);
    const cr = (t) => { const r2 = nilViewVal(athleteObj, t); return cleanRange(r2.low, r2.high); };
    const deal_type_rates = {
      'ig-reel': cr('ig-reel'), 'ig-post': cr('ig-post'), 'stories': cr('stories'),
      'tiktok': cr('tiktok'), 'bundle': cr('bundle'), 'appearance-inperson': cr('appearance-inperson'),
    };
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'valuation_run',
      `Ran rate calculator (${delivType})`, { deliverable_type: delivType });
    res.json({
      ok: true, deliverable_type: delivType,
      rate: cleaned, cleanLow: cleaned.low, cleanHigh: cleaned.high,
      deal_type_rates, rateDrivers, rateLimits, reliability, confTypes,
      compNote, momentum, pricingStrategy,
      floorApplied: rate.floorApplied || false,
      recommendation: rate.recommendation || null,
      athlete: { name: athleteObj.name, sport: athleteObj.sport, school: athleteObj.school,
        instagram: athleteObj.instagram || 0, tiktok: athleteObj.tiktok || 0 }
    });
  } catch (e) { console.error('[athlete/rate-calculator]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/rate-talking-points — generate negotiation talking points
app.post('/api/athlete/rate-talking-points', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { deliverable_type } = req.body;
    // Canonical loader merges dedicated follower columns (self-signup athletes).
    const a = await _loadAthleteObjForAI(req.athlete.id);
    if (!a) return res.status(404).json({ error: 'Athlete not found' });
    const { nilViewVal, cleanRange } = require('./benchmarks');
    const rate = nilViewVal(a, deliverable_type || 'ig-reel');
    const cleaned = cleanRange(rate.low, rate.high);
    const prompt = `Generate negotiation talking points for a college athlete in a brand deal negotiation.

Athlete: ${a.name} | Sport: ${a.sport} | School: ${a.school}
Instagram: ${a.instagram || 0} followers | TikTok: ${a.tiktok || 0} followers
Deliverable: ${deliverable_type || 'IG Reel'}
Market rate estimate: $${cleaned.low.toLocaleString()} – $${cleaned.high.toLocaleString()}

Write 5-7 specific, confident talking points they can use when negotiating with a brand.
Include: how to anchor high, what to say about their audience value, how to handle "we have a limited budget", and when to walk away.
Be direct and practical. Write in first-person so the athlete can say it directly.`;

    const talking_points = await ai.oneShot(prompt, 'You are an NIL negotiation coach. Write practical, confident scripts.');
    await logAthleteActivity(req.athlete.id, req.athlete.agent_id, 'talking_points_generated',
      `Generated talking points for ${deliverable_type || 'ig-reel'}`, { deliverable_type });
    res.json({ talking_points });
  } catch (e) { console.error('[athlete/rate-talking-points]', e.message); res.status(500).json({ error: e.message }); }
});

// NOTE: POST /api/athlete/team-match removed — the athlete-portal Team Match
// view was hidden (display:none) and unreachable. The agent-portal Team Match
// (/api/ai/team-match) remains active and untouched.

// POST /api/athlete/marketing/content-ideas
app.post('/api/athlete/marketing/content-ideas', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'school' as school,
              a.instagram_handle, a.tiktok_handle FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const ath = athR.rows[0] || {};
    const dealsR = await store.pool.query(
      `SELECT brand FROM athlete_calendar_events WHERE athlete_id=$1 AND brand IS NOT NULL GROUP BY brand LIMIT 5`,
      [req.athlete.id]
    );
    const brands = dealsR.rows.map(r => r.brand).join(', ') || 'various brands';
    const prompt = `Generate 8 NIL content ideas for this college athlete.\n\nName: ${ath.name} | Sport: ${ath.sport} | School: ${ath.school}\nInstagram: @${ath.instagram_handle || 'N/A'} | TikTok: @${ath.tiktok_handle || 'N/A'}\nActive partnerships: ${brands}\n\nReturn ONLY a valid JSON array:\n[{"platform":"Instagram/TikTok/YouTube","content_type":"Reel/Story/Post","idea":"Brief idea","caption":"Draft caption + hashtags","best_time":"Best posting time"}]`;

    const raw = await ai.oneShot(prompt, 'You are a college athlete social media strategist. Return only valid JSON.');
    let ideas = [];
    try { const m = raw.match(/\[[\s\S]*\]/); if (m) ideas = JSON.parse(m[0]); } catch(e) {}
    res.json({ ideas });
  } catch (e) { console.error('[athlete/marketing]', e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/athlete/marketing/generate-caption — Caption Generator
app.post('/api/athlete/marketing/generate-caption', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { brand, deliverable_type, context } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport,
              a.data->>'school' as school, a.data->>'position' as position
       FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const ath = athR.rows[0] || {};
    const postType = deliverable_type || 'Instagram Post';
    const contextLine = context ? `Context: ${context}` : '';
    const prompt = `Write 3 ${postType} caption options for ${ath.name}, a ${ath.position ? ath.position + ' ' : ''}${ath.sport || 'college'} athlete at ${ath.school || 'their university'}, for their ${brand} NIL deal.
${contextLine}

Each caption should be 2-4 sentences, sound completely authentic (like a real 20-year-old college athlete wrote it), and include 3-5 relevant hashtags at the end.
Number them 1, 2, 3.`;

    const system = `You are a social media copywriter for college athletes. Write captions that sound exactly like a real college athlete wrote them — casual, authentic, genuine. Never corporate. Never over-enthusiastic. Use natural language a 20-year-old would actually use. Don't use phrases like "super excited" or "amazing opportunity" or "blessed". Make it sound like they dashed it off between practice and class.`;

    const raw = await ai.oneShot(prompt, system, 800, 'claude-sonnet-4-6');
    console.log('[generate-caption] brand:', brand, 'type:', postType, 'athlete:', req.athlete.id);
    res.json({ captions: raw || '' });
  } catch (e) {
    console.error('[generate-caption]', e.message);
    res.status(500).json({ error: 'Caption generation failed' });
  }
});

// POST /api/athlete/compliance — NIL compliance check (athlete auth)
// Mirrors /api/ai/compliance but uses athlete token and auto-resolves state from school
app.post('/api/athlete/compliance', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { dealType, brand, value, description, signingDate, universityNotified } = req.body;

    // Fetch athlete info for state resolution (includes the editable `state` column)
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport,
              a.data->>'school' as school, a.data->>'schoolTier' as school_tier,
              a.state as state
       FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const ath = athR.rows[0] || {};
    const school = ath.school || '';

    // School → State mapping
    const SCHOOL_STATES = {
      'University of Connecticut': 'Connecticut', 'UConn': 'Connecticut',
      'Yale University': 'Connecticut', 'University of Alabama': 'Alabama',
      'Auburn University': 'Alabama', 'Samford University': 'Alabama', 'Samford': 'Alabama',
      'University of Georgia': 'Georgia',
      'Georgia Tech': 'Georgia', 'University of Florida': 'Florida',
      'Florida State University': 'Florida', 'University of Miami': 'Florida',
      'University of Tennessee': 'Tennessee', 'Vanderbilt University': 'Tennessee',
      'University of Kentucky': 'Kentucky', 'University of South Carolina': 'South Carolina',
      'Clemson University': 'South Carolina', 'University of North Carolina': 'North Carolina',
      'North Carolina State University': 'North Carolina', 'Duke University': 'North Carolina',
      'Wake Forest University': 'North Carolina', 'University of Virginia': 'Virginia',
      'Virginia Tech': 'Virginia', 'Penn State University': 'Pennsylvania',
      'University of Pittsburgh': 'Pennsylvania', 'Temple University': 'Pennsylvania',
      'Ohio State University': 'Ohio', 'University of Cincinnati': 'Ohio',
      'Michigan State University': 'Michigan', 'University of Michigan': 'Michigan',
      'University of Notre Dame': 'Indiana', 'Purdue University': 'Indiana',
      'Indiana University': 'Indiana', 'University of Wisconsin': 'Wisconsin',
      'Northwestern University': 'Illinois', 'University of Illinois': 'Illinois',
      'University of Iowa': 'Iowa', 'University of Minnesota': 'Minnesota',
      'University of Nebraska': 'Nebraska', 'University of Kansas': 'Kansas',
      'Kansas State University': 'Kansas', 'University of Missouri': 'Missouri',
      'University of Arkansas': 'Arkansas', 'Louisiana State University': 'Louisiana',
      'University of Mississippi': 'Mississippi', 'Mississippi State University': 'Mississippi',
      'Texas A&M University': 'Texas', 'University of Texas': 'Texas',
      'Texas Christian University': 'Texas', 'Baylor University': 'Texas',
      'University of Oklahoma': 'Oklahoma', 'Oklahoma State University': 'Oklahoma',
      'University of Colorado': 'Colorado', 'Colorado State University': 'Colorado',
      'University of Utah': 'Utah', 'Brigham Young University': 'Utah',
      'University of Arizona': 'Arizona', 'Arizona State University': 'Arizona',
      'University of Oregon': 'Oregon', 'Oregon State University': 'Oregon',
      'University of Washington': 'Washington', 'Washington State University': 'Washington',
      'University of California': 'California', 'UCLA': 'California',
      'University of Southern California': 'California', 'Stanford University': 'California',
      'San Diego State University': 'California', 'Boston College': 'Massachusetts',
      'Boston University': 'Massachusetts', 'University of Massachusetts': 'Massachusetts',
    };

    // Resolution order: explicit request state > saved profile state column >
    // school→state map (exact, then partial). Manual entry ALWAYS wins over
    // auto-detect. If nothing resolves we fall back to a federal/SPARTA-only
    // check (no hard block).
    let state = (req.body.state && req.body.state.trim()) || (ath.state && ath.state.trim()) || '';
    if (!state) {
      state = SCHOOL_STATES[school] || '';
    }
    if (!state) {
      // Try partial match
      for (const [k, v] of Object.entries(SCHOOL_STATES)) {
        if (school.includes(k) || k.includes(school)) { state = v; break; }
      }
    }
    const stateResolved = !!state;
    const stateLabel = stateResolved ? state : 'your state (unspecified)';

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

    const notificationNote = universityNotified === false
      ? '\n- ATHLETE NOTE: University has NOT been notified. Remind athlete to notify athletic department within 72 hours of signing.'
      : '';

    const checksLine = stateResolved
      ? 'Check ALL of these: 1) State restrictions in ' + state + ' 2) Disclosure requirements 3) $600 NIL reporting threshold 4) Category restrictions (alcohol/gambling/tobacco/supplements/crypto) 5) SPARTA compliance - notify ' + school + ' within 72 hours of signing 6) School-specific NIL policies\n\n'
      : 'NOTE: The athlete\'s state could not be determined, so do a FEDERAL-LEVEL and SPARTA-only review (do not invent state-specific laws). Check: 1) Federal disclosure requirements 2) $600 NIL reporting threshold 3) Category restrictions (alcohol/gambling/tobacco/supplements/crypto) 4) SPARTA compliance - notify ' + school + ' within 72 hours of signing 5) NCAA House settlement rules. Recommend the athlete add their State in Profile for a state-specific check.\n\n';

    const prompt = 'Analyze this NIL deal for compliance' + (stateResolved ? ' in ' + state : ' (state unknown — federal/SPARTA scope only)') + ':\n' +
      'Athlete: ' + (ath.name||'Unknown') + ', ' + (ath.sport||'Unknown') + ', ' + school + ' (' + (ath.school_tier||'unknown') + ')\n' +
      'Deal: ' + (dealType||'general') + ' with ' + (brand||'unknown brand') + ' worth $' + (parseInt(value)||0) + '\n' +
      'Description: ' + (description||'not provided') + '\n' +
      (signingDate ? 'Signing Date: ' + signingDate + '\n' : '') +
      notificationNote + '\n' +
      checksLine +
      'Return ONLY JSON: {"state":"' + (stateResolved ? state : 'Federal (state unspecified)') + '","status":"clear" or "warning" or "blocked","flags":[{"severity":"high" or "warning","issue":"short title","detail":"specific detail"}],"requirements":["required steps"],"disclosure":"exact disclosure language for contract or social post","spartaNotice":"exact letter/email text athlete must send to university athletic department within 72 hours","sourceNote":"what laws this is based on"}';

    const result = await ai.oneShot(prompt, 'You are a NIL compliance expert with comprehensive knowledge of all 50 state NIL laws as of 2025-2026, plus the NCAA House settlement rules. Return only valid JSON.', 8000);
    const cleaned = result.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Failed to parse result' });
    const parsed = JSON.parse(match[0]);

    if (signingDate) {
      const signed = new Date(signingDate);
      const deadline = new Date(signed.getTime() + 72 * 60 * 60 * 1000);
      const hoursLeft = Math.round((deadline - new Date()) / (1000 * 60 * 60));
      parsed.sparta = {
        required: true, signingDate, deadline: deadline.toISOString(),
        deadlineFormatted: deadline.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
        hoursLeft, status: hoursLeft > 24 ? 'on-track' : hoursLeft > 0 ? 'urgent' : 'overdue'
      };
    }
    parsed.resolvedState = stateResolved ? state : '';
    if (!stateResolved) {
      parsed.stateNote = 'State could not be determined automatically. This is a federal/SPARTA-level review only. Add your State in My Profile for a state-specific compliance check.';
    }
    console.log('[athlete/compliance] state:', stateResolved ? state : '(unresolved → federal)', 'status:', parsed.status);
    res.json(parsed);
  } catch (e) {
    console.error('[athlete/compliance]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Shared athlete email send: Gmail-if-connected, else Resend. Logs + saves to agent inbox.
// Returns { via } and throws on failure (caller handles HTTP).
async function _sendAthleteEmail(athlete, to, subject, body, opts = {}) {
  const athleteId = athlete.id;
  let agentId = athlete.agent_id;
  if (!agentId) {
    const ag = await store.pool.query('SELECT agent_id FROM athletes WHERE id=$1', [athleteId]).catch(() => ({ rows: [] }));
    agentId = ag.rows[0]?.agent_id || null;
  }
  let athleteName = athlete.athlete_name || athlete.name || null;
  if (!athleteName) {
    const nr = await store.pool.query(`SELECT data->>'name' AS name FROM athletes WHERE id=$1`, [athleteId]).catch(() => ({ rows: [] }));
    athleteName = nr.rows[0]?.name || null;
  }
  const athleteEmail = athlete.email || null;

  let agentEmail = null;
  if (opts.cc_agent && agentId) {
    const ar = await store.pool.query('SELECT email FROM users WHERE id=$1', [agentId]).catch(() => ({ rows: [] }));
    agentEmail = ar.rows[0]?.email || null;
  }

  const athRow = await store.pool.query(
    'SELECT gmail_refresh_token, gmail_address FROM athletes WHERE id=$1', [athleteId]
  ).then(r => r.rows[0] || {});
  const gmailRefreshToken = athRow.gmail_refresh_token || null;

  if (gmailSend && gmailSend.isAvailable() && gmailRefreshToken) {
    await gmailSend.sendEmail({ refreshToken: gmailRefreshToken, to, subject, body, cc: agentEmail || undefined });
    console.log(`[athlete/email] sent via Gmail as ${athRow.gmail_address} to=${to} subject="${subject}" athlete=${athleteId}`);
  } else {
    const fromDisplay = athleteName ? `${athleteName} via NILDash` : 'NILDash Athlete';
    // Escape, then auto-linkify any http(s) URL (e.g. the appended Media Kit
    // link) so it renders as a clickable link in the HTML email. The Gmail
    // path sends text/plain, where Gmail auto-links bare URLs on its own.
    const _escHtml = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const _linkedHtml = _escHtml.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb">$1</a>');
    const emailPayload = {
      from:    `${fromDisplay} <noreply@mynildash.com>`,
      replyTo: athleteEmail || undefined,
      to:      [to],
      subject,
      text: body,
      html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${_linkedHtml.replace(/\n/g,'<br>')}</div>`,
    };
    if (agentEmail) emailPayload.cc = [agentEmail];
    await resend.emails.send(emailPayload);
    console.log(`[athlete/email] sent via Resend from="${fromDisplay}" replyTo=${athleteEmail} to=${to} subject="${subject}" athlete=${athleteId}`);
  }

  await store.pool.query(
    `INSERT INTO athlete_brand_outreach (athlete_id, agent_id, brand_name, brand_contact_email, message_sent, initiated_by, status)
     VALUES ($1,$2,$3,$4,$5,'athlete','sent')`,
    [athleteId, agentId, opts.brand_name || subject, to, body]
  ).catch(() => {});

  const senderEmail = gmailRefreshToken ? (athRow.gmail_address || athleteEmail) : athleteEmail;
  if (agentId) {
    await store.pool.query(
      `INSERT INTO athlete_messages (athlete_id, athlete_name, athlete_email, agent_id, to_address, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [athleteId, athleteName, senderEmail, agentId, to, subject, body]
    ).catch(() => {});
  }

  await logAthleteActivity(athleteId, agentId, 'email_sent',
    `Sent email to ${to}: "${subject}"`, { to, subject, via: gmailRefreshToken ? 'gmail' : 'resend' }).catch(()=>{});

  return { via: gmailRefreshToken ? 'gmail' : 'resend' };
}

// POST /api/athlete/deal-pitch/send — send a pitch to a brand and record/upsert in pipeline
app.post('/api/athlete/deal-pitch/send', verifyAthleteToken, async (req, res) => {
  try {
    const { to, subject, body, brand } = req.body || {};
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body required' });
    await _sendAthleteEmail(req.athlete, to, subject, body, { brand_name: (brand && (brand.brand || brand.brand_name)) || subject });

    // Upsert into Brand Tracker (single source of truth). Sending a pitch moves
    // the deal to the "Contacted" stage (still in the Outreach group). If the
    // deal is already further along (Negotiating/Signed/etc.) we leave its stage.
    const brandName = (brand && (brand.brand || brand.brand_name)) || to;
    const existing = await store.pool.query(
      `SELECT * FROM athlete_self_deals
       WHERE athlete_id=$1 AND LOWER(TRIM(brand_name))=LOWER(TRIM($2)) LIMIT 1`,
      [req.athlete.id, brandName]
    );
    let entry;
    if (existing.rows.length) {
      const cur = existing.rows[0];
      const advanceFrom = ['Prospect']; // only auto-advance from the very first stage
      const newStage = advanceFrom.indexOf(cur.stage) > -1 ? 'Contacted' : cur.stage;
      let stageHistory = cur.stage_history || [];
      if (newStage !== cur.stage) {
        stageHistory = [...stageHistory, { stage: newStage, date: new Date().toISOString(), note: 'Pitch sent' }];
      }
      entry = (await store.pool.query(
        `UPDATE athlete_self_deals SET stage=$1, contact_email=COALESCE(contact_email,$2),
           stage_history=$3, updated_at=NOW()
         WHERE id=$4 AND athlete_id=$5 RETURNING *`,
        [newStage, to, JSON.stringify(stageHistory), cur.id, req.athlete.id]
      )).rows[0];
    } else {
      const lo = brand && parseInt(brand.estimatedValueLow);
      const hi = brand && parseInt(brand.estimatedValueHigh);
      let value = null, rangeText = null;
      if (lo && hi) { value = Math.round((lo + hi) / 2); rangeText = '$' + lo.toLocaleString() + '–$' + hi.toLocaleString() + ' per post'; }
      else if (lo || hi) { value = lo || hi; }
      const notes = [rangeText ? 'Estimated rate: ' + rangeText : null, 'Pitched ' + new Date().toLocaleDateString()].filter(Boolean).join('\n\n');
      const stageHistory = JSON.stringify([{ stage: 'Contacted', date: new Date().toISOString(), note: 'Pitch sent from Deal Scan' }]);
      entry = (await store.pool.query(
        `INSERT INTO athlete_self_deals
           (athlete_id, agent_id, brand_name, deal_type, value, stage, notes,
            category, contact_name, contact_email, source, stage_history)
         VALUES ($1,$2,$3,'Other',$4,'Contacted',$5,$6,$7,$8,'deal_scan',$9) RETURNING *`,
        [req.athlete.id, req.athlete.agent_id || null, brandName, value, notes,
         brand?.category || null, brand?.contactName || null, to, stageHistory]
      )).rows[0];
    }
    res.json({ ok: true, entry });
  } catch (e) {
    console.error('[deal-pitch/send]', e.message);
    if (e.code === 'GMAIL_TOKEN_EXPIRED') return res.status(401).json({ error: 'gmail_token_expired' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/athlete/email/send — athlete sends tracked email
// • If the athlete has connected their Gmail → sends via Gmail API (from their real address)
// • Otherwise → falls back to Resend (from noreply@mynildash.com with reply-to set)
app.post('/api/athlete/email/send', verifyAthleteToken, async (req, res) => {
  try {
    const { to, subject, body, cc_agent } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body required' });
    await _sendAthleteEmail(req.athlete, to, subject, body, { cc_agent });
    res.json({ ok: true, message: 'Email sent.' });
  } catch (e) {
    console.error('[athlete/email]', e.message);
    // Distinguish token-expired errors so the frontend can prompt reconnect
    if (e.code === 'GMAIL_TOKEN_EXPIRED') {
      return res.status(401).json({ error: 'gmail_token_expired', message: 'Your Gmail connection has expired. Please reconnect.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/athlete/deal-close/analyze — athlete analyzes a deal
app.post('/api/athlete/deal-close/analyze', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { brand, dealScanData } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand required' });

    const athleteId = req.athlete.id;

    // Pull athlete data from DB
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport, a.data->>'school' as school,
              a.data->>'schoolTier' as school_tier, a.data->>'instagram' as ig, a.data->>'tiktok' as tt,
              a.data->>'position' as position, a.data->>'year' as year, a.data->>'engagement' as engagement,
              a.data->>'stats' as stats
       FROM athletes a WHERE a.id = $1`,
      [athleteId]
    );
    const athRow = athR.rows[0];
    if (!athRow) return res.status(404).json({ error: 'Athlete not found' });

    const athlete = {
      name: athRow.name, sport: athRow.sport, school: athRow.school,
      schoolTier: athRow.school_tier, instagram: parseInt(athRow.ig) || 0,
      tiktok: parseInt(athRow.tt) || 0, position: athRow.position,
      year: athRow.year, engagement: parseFloat(athRow.engagement) || 0,
      stats: athRow.stats || '',
    };

    // Pull athlete's own outreach history for this brand
    const outreachRows = await store.pool.query(
      `SELECT brand_name, status, created_at FROM athlete_brand_outreach
       WHERE athlete_id=$1 AND brand_name ILIKE $2 ORDER BY created_at DESC LIMIT 3`,
      [athleteId, brand]
    ).then(r => r.rows).catch(() => []);

    // Rate estimate + full reasoning layer (same functions as agent route)
    const {
      nilViewVal: _nvv, cleanRange, generatePricingStrategy,
      generateRateDrivers, generateRateLimitations,
      calcMarketReliabilityScore, generateConfidenceTypes,
      generateComparableNote, generateMomentumSignal,
      decomposeFitScore,
    } = require('./benchmarks');

    const rawRate    = _nvv(athlete, dealScanData?.dealType || 'ig-reel');
    const cleaned    = cleanRange(rawRate.low, rawRate.high);
    const pricing    = generatePricingStrategy(rawRate);
    const rateDrivers  = generateRateDrivers(athlete, rawRate);
    const rateLimits   = generateRateLimitations(athlete, rawRate, 0);
    const reliability  = calcMarketReliabilityScore(athlete, rawRate, 0);
    const confTypes    = generateConfidenceTypes(athlete, rawRate, 0);
    const compNote     = generateComparableNote(athlete, rawRate);
    const momentum     = generateMomentumSignal(athlete);
    const fitBreakdown = decomposeFitScore(athlete, null, null, dealScanData);

    // AI: negotiation coaching adapted for athlete self-representation
    const reach = ((athlete.instagram || 0) + (athlete.tiktok || 0)).toLocaleString();
    const engagement = athlete.engagement || 4.2;
    const campaignConcept = dealScanData?.campaign || 'brand ambassador partnership';
    const fitScore = dealScanData?.fitScore || 78;
    const rationale = dealScanData?.rationale || 'Strong fit identified';

    const aiPrompt = `You are coaching a college athlete on how to negotiate their own NIL deal with ${brand}.

CONTEXT:
- Athlete: ${athlete.name}, ${athlete.sport || 'athlete'}, ${athlete.school || 'college'}
- Combined social reach: approximately ${reach}
- Engagement: ${engagement}%
- Brand: ${brand}
- Campaign concept: ${campaignConcept}
- Estimated market range: $${cleaned.low.toLocaleString()}–$${cleaned.high.toLocaleString()} per deliverable
- Why this brand was flagged: ${rationale}

Write practical deal-close coaching for the athlete negotiating directly. Tone: confident, grounded, actionable. No hype.

Also identify the best 1–3 people to contact at ${brand} for NIL partnerships, sponsorships, or influencer marketing. Use your knowledge of major brand partnership teams. Provide real names and titles if known; otherwise use likely title patterns (e.g. "NIL Partnerships Manager"). Provide real email addresses if known; otherwise leave null.

Return ONLY valid JSON (no markdown):
{
  "contacts": [
    { "name": "Full Name or null", "title": "Job title such as NIL Partnerships Manager", "email": "email@brand.com or null", "linkedin": "https://linkedin.com/in/handle or null" }
  ],
  "negotiation_points": [
    "One specific, data-grounded point the athlete should make",
    "Second point",
    "Third point",
    "Fourth point",
    "Fifth point"
  ],
  "opening_line": "Natural, confident way to open the conversation — not scripted, not corporate",
  "objection_handling": [
    { "objection": "Your rate feels high", "response": "Concise, grounded response — one or two sentences" },
    { "objection": "We're not sure about fit", "response": "One or two sentences" },
    { "objection": "We need internal approval", "response": "One or two sentences" },
    { "objection": "We already work with influencers", "response": "One or two sentences" }
  ],
  "ask_anchor": "One sentence: where to open the rate conversation and why that number",
  "walk_away_line": "Soft, non-aggressive sentence to close the conversation if it isn't going anywhere"
}`;

    let aiData = null;
    try {
      const raw = await ai.oneShot(aiPrompt, 'You are an elite NIL deal coach. Return only valid JSON. Format all text fields as clean natural sentences. Never use bullet points, arrows, dashes as list items, numbered lists, or excessive formatting. Write like a knowledgeable human advisor.', 2000, ai.MODEL_FAST);
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      aiData = JSON.parse(clean);
    } catch (e) {
      console.error('[athlete-deal-close] AI parse failed:', e.message);
      aiData = {
        negotiation_points: [
          `${athlete.name}'s ${engagement}% engagement is ${(engagement / 2.1).toFixed(1)}x the industry average for paid influencers`,
          `Combined reach of ${reach} delivers strong organic CPM versus paid advertising rates`,
          `${fitScore}/100 fit score — audience demographics align with ${brand}'s core market`,
          campaignConcept,
          rationale,
        ],
        opening_line: `Thanks for taking the time — I wanted to walk you through why I think I'm a strong fit for ${brand} right now.`,
        objection_handling: [
          { objection: 'Your rate is too high', response: `The $${cleaned.low.toLocaleString()}–$${cleaned.high.toLocaleString()} range reflects my ${engagement}% engagement, which is above industry average. You're getting authentic college-level content at a fraction of macro-influencer pricing.` },
          { objection: 'We need to think about it', response: `Totally understand — what specific questions can I answer today to help you move forward?` },
        ],
        contacts: [],
        ask_anchor: `Open at $${cleaned.high.toLocaleString()} and signal flexibility down to $${cleaned.low.toLocaleString()} if they need to adjust scope.`,
        walk_away_line: `I hear you — let's stay in touch and revisit this when timing makes more sense.`,
      };
    }

    await logAthleteActivity(athleteId, req.athlete.agent_id, 'deal_close_analyze', `Analyzed deal with ${brand}`, { brand });

    res.json({
      athlete: { name: athlete.name, sport: athlete.sport, school: athlete.school, instagram: athlete.instagram, tiktok: athlete.tiktok, engagement: athlete.engagement, position: athlete.position, stats: athlete.stats },
      brand:   { name: brand },
      contacts: aiData.contacts || [],
      outreach: outreachRows,
      pricing:  { low: cleaned.low, high: cleaned.high, mid: pricing.target, start: pricing.start, target: pricing.target, stretch: pricing.stretch, dealType: dealScanData?.dealType || 'ig-reel' },
      dealScan: dealScanData || null,
      ai:       aiData,
      hasExistingData: outreachRows.length > 0,
      marketRange:  { low: cleaned.low, high: cleaned.high },
      rateDrivers, rateLimits, reliability, confTypes, compNote, momentum, fitBreakdown,
    });
  } catch (e) {
    console.error('[athlete-deal-close]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/athlete/profile — athlete updates own editable fields
app.put('/api/athlete/profile', verifyAthleteToken, async (req, res) => {
  try {
    const { phone, instagram_handle, tiktok_handle, twitter_handle, instagram_followers, tiktok_followers, bio, state, name, sport, school, position } = req.body;
    await store.pool.query(
      `UPDATE athletes SET phone=COALESCE($1,phone), instagram_handle=COALESCE($2,instagram_handle),
       tiktok_handle=COALESCE($3,tiktok_handle), twitter_handle=COALESCE($4,twitter_handle), updated_at=NOW()
       WHERE id=$5`,
      [phone||null, instagram_handle||null, tiktok_handle||null, twitter_handle||null, req.athlete.id]
    );
    // State is explicitly set (allow clearing back to null). Only touch the
    // column when the field was sent so other saves don't wipe it.
    if (state !== undefined) {
      await store.pool.query(
        `UPDATE athletes SET state=$1, updated_at=NOW() WHERE id=$2`,
        [state || null, req.athlete.id]
      );
    }
    // Persist follower counts to the dedicated columns (canonical store for
    // self-signup athletes) so edits survive reload and are visible to every
    // read path. Also mirror into the JSONB data so agent-managed reads stay
    // consistent.
    if (instagram_followers !== undefined) {
      const v = parseInt(instagram_followers) || 0;
      await store.pool.query(
        `UPDATE athletes SET instagram_followers=$1, data = jsonb_set(COALESCE(data,'{}'), '{instagram}', $2::jsonb), updated_at=NOW() WHERE id=$3`,
        [v, JSON.stringify(v), req.athlete.id]
      );
    }
    if (tiktok_followers !== undefined) {
      const v = parseInt(tiktok_followers) || 0;
      await store.pool.query(
        `UPDATE athletes SET tiktok_followers=$1, data = jsonb_set(COALESCE(data,'{}'), '{tiktok}', $2::jsonb), updated_at=NOW() WHERE id=$3`,
        [v, JSON.stringify(v), req.athlete.id]
      );
    }
    if (bio !== undefined) {
      await store.pool.query(
        `UPDATE athletes SET data = jsonb_set(COALESCE(data,'{}'), '{bio}', $1::jsonb), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(bio), req.athlete.id]
      );
    }
    // Identity fields live in the data JSONB (used by media kit, deal scan,
    // rates). The onboarding setup wizard sets these; only touch a key when it
    // was explicitly sent so partial saves never wipe other fields.
    const identity = { name, sport, school, position };
    for (const [key, val] of Object.entries(identity)) {
      if (val !== undefined) {
        await store.pool.query(
          `UPDATE athletes SET data = jsonb_set(COALESCE(data,'{}'), $1, $2::jsonb), updated_at=NOW() WHERE id=$3`,
          [`{${key}}`, JSON.stringify(val || ''), req.athlete.id]
        );
      }
    }
    console.log(`[athlete/profile] updated athlete=${req.athlete.id}`);
    res.json({ ok: true });
  } catch (e) { console.error('[athlete/profile]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/athlete/onboarding — current first-run onboarding state
app.get('/api/athlete/onboarding', verifyAthleteToken, async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT onboarding_state FROM athletes WHERE id=$1`, [req.athlete.id]
    );
    res.json({ onboarding_state: (r.rows[0] && r.rows[0].onboarding_state) || {} });
  } catch (e) { console.error('[athlete/onboarding:get]', e.message); res.status(500).json({ error: e.message }); }
});

// PUT /api/athlete/onboarding — shallow-merge a partial state patch
app.put('/api/athlete/onboarding', verifyAthleteToken, async (req, res) => {
  try {
    const patch = (req.body && typeof req.body === 'object') ? req.body : {};
    const r = await store.pool.query(
      `UPDATE athletes
         SET onboarding_state = COALESCE(onboarding_state, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id=$2
       RETURNING onboarding_state`,
      [JSON.stringify(patch), req.athlete.id]
    );
    res.json({ ok: true, onboarding_state: (r.rows[0] && r.rows[0].onboarding_state) || {} });
  } catch (e) { console.error('[athlete/onboarding:put]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/agents/athlete-activity — agent sees all athlete activity
app.get('/api/agents/athlete-activity', requireAuth, async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT aal.*, a.data->>'name' as athlete_name, a.data->>'sport' as sport
       FROM athlete_activity_log aal
       JOIN athletes a ON aal.athlete_id = a.id
       WHERE aal.agent_id = $1
       ORDER BY aal.created_at DESC LIMIT 50`,
      [req.session.userId]
    );
    console.log(`[agents/athlete-activity] agent=${req.session.userId} activities=${r.rows.length}`);
    res.json({ activities: r.rows });
  } catch (e) { console.error('[agents/athlete-activity]', e.message); res.status(500).json({ error: e.message }); }
});
// ── /Athlete Full Portal Routes ─────────────────────────────────────────────

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

// ── Privacy policy ───────────────────────────────────────────
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
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

// ── Athlete Messages ──────────────────────────────────────────────────────────
// Messages sent from athlete portals; viewable by the agent in Email Inbox.

app.post('/api/athlete-messages', verifyAthleteToken, async (req, res) => {
  try {
    const { toAddress, subject, body } = req.body;
    // Pull identity from the verified JWT — never trust the frontend for IDs
    const athleteId   = req.athlete.id;
    const agentId     = req.athlete.agent_id;
    const athleteEmail = req.athlete.email || null;
    // athlete_name may be in the JWT or we fall back to a DB lookup
    let athleteName = req.athlete.athlete_name || req.athlete.name || null;
    if (!athleteName) {
      const row = await store.pool.query(
        `SELECT data->>'name' as name FROM athletes WHERE id = $1`, [athleteId]
      ).then(r => r.rows[0]).catch(() => null);
      athleteName = row ? row.name : null;
    }
    console.log('[athlete-messages POST]', { athleteId, agentId, athleteName, toAddress, subject });
    if (!agentId || !toAddress || !subject || !body)
      return res.status(400).json({ error: 'agentId, toAddress, subject, and body are required' });
    const r = await store.pool.query(
      `INSERT INTO athlete_messages (athlete_id, athlete_name, athlete_email, agent_id, to_address, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [athleteId, athleteName, athleteEmail, agentId, toAddress, subject, body]
    );
    console.log('[athlete-messages POST] saved id=' + r.rows[0].id + ' agentId=' + agentId);
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) {
    console.error('[athlete-messages/post]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/athlete-messages/unread-count', requireAuth, async (req, res) => {
  try {
    const { agentId } = req.query;
    console.log('[athlete-messages/unread-count] agentId:', agentId);
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const r = await store.pool.query(
      `SELECT COUNT(*) AS count FROM athlete_messages WHERE agent_id = $1 AND is_read = FALSE`,
      [agentId]
    );
    res.json({ count: parseInt(r.rows[0].count) });
  } catch (e) {
    console.error('[athlete-messages/unread-count]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/athlete-messages', requireAuth, async (req, res) => {
  try {
    const { agentId } = req.query;
    console.log('[athlete-messages/get] agentId:', agentId);
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const r = await store.pool.query(
      `SELECT * FROM athlete_messages WHERE agent_id = $1 ORDER BY sent_at DESC`,
      [agentId]
    );
    console.log('[athlete-messages/get] rows:', r.rows.length);
    res.json(r.rows);
  } catch (e) {
    console.error('[athlete-messages/get]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/athlete-messages/:id/read', requireAuth, async (req, res) => {
  try {
    await store.pool.query(
      `UPDATE athlete_messages SET is_read = TRUE WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[athlete-messages/read]', e.message);
    res.status(500).json({ error: e.message });
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

// ── Growth Tab (Admin-only B2B Outreach) ──────────────────────────────────────
try {
  const growthRoutes = require('./routes/growth');
  app.use('/api/growth', requireAuth, growthRoutes);
  console.log('[growth] Growth tab routes loaded');
} catch (e) {
  console.warn('[growth] Failed to load growth routes:', e.message);
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
const RosterIntelligenceService   = require('./services/university/RosterIntelligenceService');
const NILDirectorService          = require('./services/university/NILDirectorService');

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
// UNIVERSITY SIDE ONLY — reads from university_athletes, never from the agent athletes table.
async function fetchUniversityAthletes(universityId) {
  const rows = await store.pool.query(
    `SELECT * FROM university_athletes
     WHERE university_id = $1
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

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const athleteRow = await store.pool.query(
      `SELECT * FROM university_athletes WHERE id = $1 AND university_id = $2 LIMIT 1`,
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

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const rows = await store.pool.query(
      `SELECT a.id, a.data, a.created_at, a.updated_at,
              ars.status, ars.confidence_score, ars.lifecycle_stage,
              ars.supporting_sources, ars.conflicting_sources,
              ars.last_reconciled_at
       FROM university_athletes a
       LEFT JOIN athlete_roster_states ars ON ars.athlete_id = a.id
       WHERE a.university_id = $1
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

const ESPNRosterService = require('./services/university/ESPNRosterService');

// ── Roster Intelligence routes ────────────────────────────────────────────

// POST /api/university/roster/espn
// Fully automated: school name + sport → ESPN API → structured athlete list.
// Returns preview array; call /import-commit to write to DB.
app.post('/api/university/roster/espn', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const { schoolName, sport } = req.body;
    if (!schoolName) return res.status(400).json({ error: 'schoolName is required' });
    if (!sport)      return res.status(400).json({ error: 'sport is required' });

    const result = await ESPNRosterService.getRoster(schoolName, sport);
    if (result.error && !result.athletes?.length) {
      return res.status(422).json({ error: result.error });
    }
    res.json({
      athletes: result.athletes,
      team:     result.team,
      season:   result.season,
      espnTs:   result.espnTs,
      count:    result.athletes.length,
    });
  } catch (err) {
    console.error('[roster/espn]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/import-commit
// Takes an athletes preview array and commits them to the CRM.
app.post('/api/university/roster/import-commit', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId = req.session.userId;
    let universityId = await resolveSessionUniversity(userId);
    const { athletes, schoolName, sport } = req.body;
    if (!Array.isArray(athletes) || !athletes.length) {
      return res.status(400).json({ error: 'No athletes to import' });
    }

    if (!universityId && schoolName) {
      // Try to find or create the university record
      let univRow = await store.pool.query(
        'SELECT id FROM universities WHERE LOWER(name) = LOWER($1) LIMIT 1', [schoolName]
      );
      if (!univRow.rows[0]) {
        // Create university record on the fly so all future reads use the same ID
        const newUnivId = 'univ-' + schoolName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await store.pool.query(
          `INSERT INTO universities (id, name, short_name) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`,
          [newUnivId, schoolName]
        ).catch(() => {});
        universityId = newUnivId;
      } else {
        universityId = univRow.rows[0].id;
      }
      // Stamp university_id onto the user so CRM reads and future imports use the same scope
      await store.pool.query(
        `UPDATE users SET university_id = $1 WHERE id = $2`,
        [universityId, userId]
      ).catch(() => {});
    }

    if (!universityId) {
      return res.status(400).json({
        error: 'Your account is not linked to a university. Go to Overview → run the setup, or contact your administrator.',
        code: 'NO_UNIVERSITY_LINKED',
      });
    }

    // UNIVERSITY SIDE ONLY — reads from university_athletes
    const existingRows = await store.pool.query(
      `SELECT name FROM university_athletes WHERE university_id = $1`,
      [universityId]
    );
    const existingNames = new Set(existingRows.rows.map(r => (r.name || '').toLowerCase().trim()));

    let inserted = 0, skipped = 0;
    const skippedNames = [];
    for (const a of athletes) {
      const cleanName = (a.name || '').trim();
      if (cleanName.length < 2) { skipped++; skippedNames.push(a.name || '(blank)'); continue; }

      // Skip duplicates — same name already in this university's roster
      if (existingNames.has(cleanName.toLowerCase())) { skipped++; skippedNames.push(cleanName + ' (duplicate)'); continue; }
      existingNames.add(cleanName.toLowerCase()); // prevent dupes within this batch too

      const id = 'ath-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const athleteSport  = sport || a.sport || 'Unknown';
      const athleteYear   = a.year     || null;
      const athleteNumber = a.number   || null;
      const extData = {
        name:         cleanName,
        sport:        athleteSport,
        school:       schoolName || 'Unknown',
        position:     a.position || null,
        number:       athleteNumber,
        year:         athleteYear,
        height:       a.height   || null,
        weight:       a.weight   || null,
        hometown:     a.hometown || null,
        high_school:  a.high_school || null,
        major:        a.major    || null,
        espn_id:      a.espn_id  || null,
        source:       'espn_import',
      };
      try {
        // UNIVERSITY SIDE ONLY — writes to university_athletes, never to the agent athletes table
        await store.pool.query(
          `INSERT INTO university_athletes (id, university_id, name, sport, position, year, jersey_number, source, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'espn_import', $8, NOW(), NOW())`,
          [id, universityId, cleanName, athleteSport, a.position || null, athleteYear, athleteNumber, JSON.stringify(extData)]
        );
        inserted++;
      } catch { skipped++; }
    }

    res.json({ ok: true, inserted, skipped, skippedNames, total: athletes.length, universityId });
  } catch (err) {
    console.error('[roster/import-commit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/university/roster/clear
// Wipes ALL roster-imported athletes for this university so the director can re-import clean.
// Only deletes athletes whose data->>'source' is a roster import source.
app.delete('/api/university/roster/clear', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    // UNIVERSITY SIDE ONLY — deletes from university_athletes, never from the agent athletes table
    const result = await store.pool.query(
      `DELETE FROM university_athletes WHERE university_id = $1`,
      [universityId]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Roster Import (Preview + Confirm) ─────────────────────────────────
// Two-step flow: upload file → Claude maps columns → frontend shows preview
// → compliance officer confirms → records written to DB.

const rosterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|xlsx|xls|txt)$/i.test(file.originalname) ||
               file.mimetype === 'text/csv' ||
               file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
               file.mimetype === 'application/vnd.ms-excel' ||
               file.mimetype === 'text/plain';
    cb(ok ? null : new Error('Only CSV or Excel files are accepted'), ok);
  },
});

// POST /api/university/roster/preview
// Step 1: Accept file upload → parse to text → Claude maps columns → return preview JSON.
// Does NOT write to database.
app.post('/api/university/roster/preview', requireAuth, requireUniversityMode, rosterUpload.single('roster'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Parse file to raw text
    let rawText = '';
    const fname = req.file.originalname.toLowerCase();
    if (fname.endsWith('.xlsx') || fname.endsWith('.xls')) {
      const XLSX = require('xlsx');
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rawText = XLSX.utils.sheet_to_csv(ws);
    } else {
      rawText = req.file.buffer.toString('utf8');
    }

    rawText = rawText.trim();
    if (!rawText || rawText.length < 10) {
      return res.status(400).json({ error: 'The file appears to be empty. Please upload a file with athlete data.' });
    }

    // Truncate to 12KB to stay well inside Claude's context
    if (rawText.length > 12000) rawText = rawText.slice(0, 12000) + '\n[truncated]';

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const systemPrompt = `You are a data mapping assistant. You will receive a raw roster file from a university athletics department. Map the data to this schema and return ONLY a JSON array, no markdown, no explanation:
[{
  "first_name": string or null,
  "last_name": string or null,
  "sport": string or null,
  "position": string or null,
  "year": string or null,
  "jersey_number": string or null,
  "email": string or null
}]
If a field is missing or unclear, set it to null. Combine any full name fields into first_name and last_name. Be flexible — column names vary by school. If you cannot determine the structure at all, return an empty array [].`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Map this roster file:\n\n${rawText}` }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    let athletes = [];
    try {
      // Strip any accidental markdown fences
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const start = jsonStr.indexOf('[');
      const end   = jsonStr.lastIndexOf(']');
      if (start === -1 || end === -1) throw new Error('No JSON array found');
      athletes = JSON.parse(jsonStr.slice(start, end + 1));
    } catch (e) {
      return res.status(422).json({
        error: "We couldn't read this file format. Try exporting as CSV from your system.",
        detail: e.message,
      });
    }

    if (!Array.isArray(athletes) || athletes.length === 0) {
      return res.status(422).json({ error: "We couldn't read this file format. Try exporting as CSV from your system." });
    }

    res.json({ ok: true, preview: athletes, total: athletes.length });
  } catch (e) {
    console.error('[roster/preview]', e.message);
    if (e.message?.includes('file size')) {
      return res.status(413).json({ error: 'File is too large. Maximum size is 5MB.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/university/roster/confirm
// Step 2: Confirmed preview array → write athletes + university_athlete_links.
app.post('/api/university/roster/confirm', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked to account' });

    const { athletes } = req.body;
    if (!Array.isArray(athletes) || !athletes.length) {
      return res.status(400).json({ error: 'No athletes to import' });
    }

    const crypto = require('crypto');
    let imported = 0, skipped = 0;
    const errors = [];

    for (const a of athletes) {
      const firstName = (a.first_name || '').trim();
      const lastName  = (a.last_name  || '').trim();
      const fullName  = [firstName, lastName].filter(Boolean).join(' ');
      if (!fullName || fullName.length < 2) { skipped++; continue; }

      const athleteId = 'ath-ai-' + crypto.randomBytes(6).toString('hex');
      const data = {
        name:          fullName,
        sport:         a.sport         || null,
        position:      a.position      || null,
        year:          a.year          || null,
        jersey_number: a.jersey_number || null,
        email:         a.email         || null,
        university_id: universityId,
        source:        'university_import',
      };

      try {
        // UNIVERSITY SIDE ONLY — dedup checks and writes go to university_athletes only
        let existingId = null;
        if (a.email) {
          const existing = await store.pool.query(
            `SELECT id FROM university_athletes WHERE email = $1 AND university_id = $2 LIMIT 1`,
            [a.email, universityId]
          );
          if (existing.rows.length) existingId = existing.rows[0].id;
        }
        if (!existingId) {
          const existing = await store.pool.query(
            `SELECT id FROM university_athletes WHERE name = $1 AND university_id = $2 LIMIT 1`,
            [fullName, universityId]
          );
          if (existing.rows.length) existingId = existing.rows[0].id;
        }

        const finalAthleteId = existingId || athleteId;
        if (!existingId) {
          const extData = {
            name:          fullName,
            sport:         a.sport         || null,
            position:      a.position      || null,
            year:          a.year          || null,
            jersey_number: a.jersey_number || null,
            email:         a.email         || null,
            source:        'csv_import',
          };
          await store.pool.query(
            `INSERT INTO university_athletes (id, university_id, first_name, last_name, name, sport, position, year, jersey_number, email, source, data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'csv_import', $11, NOW(), NOW())
             ON CONFLICT (id) DO NOTHING`,
            [finalAthleteId, universityId, firstName, lastName, fullName,
             a.sport || null, a.position || null, a.year || null, a.jersey_number || null,
             a.email || null, JSON.stringify(extData)]
          );
        }

        imported++;
      } catch (e) {
        errors.push({ name: fullName, error: e.message });
        skipped++;
      }
    }

    res.json({ ok: true, imported, skipped, errors, total: athletes.length });
  } catch (e) {
    console.error('[roster/confirm]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/university/roster/purge-imports
// Admin-only: removes all university-imported roster athletes from the DB.
// These are athletes with source='espn_import' or 'university_import' that should
// never appear in the agent portal.
app.delete('/api/university/roster/purge-imports', requireAuth, async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (user.role !== 'admin' && user.role !== 'university') {
      return res.status(403).json({ error: 'Admin or university role required' });
    }
    // UNIVERSITY SIDE ONLY — purges from university_athletes table
    const result = await store.pool.query(
      `DELETE FROM university_athletes
       WHERE source IN ('espn_import','csv_import','university_import')
       RETURNING id`
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/parse-text
// Director pastes copied roster text → Claude extracts athletes → preview returned.
// No scraping, no bot issues — director provides the content directly.
app.post('/api/university/roster/parse-text', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const { text, sport = 'Unknown', universityName = 'Unknown University' } = req.body;
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Please paste some roster text first.' });
    }
    // Re-use Claude extraction but pass text directly (skip HTTP fetch)
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const prompt = `You are extracting structured athlete roster data that a user has copied and pasted from a university athletics website.

University: ${universityName}
Sport: ${sport}

The text below was pasted directly from a roster page — it may include HTML fragments, table text, or plain text in various formats. Extract every athlete you can find.

Pasted content:
---
${text.slice(0, 80000)}
---

For each athlete, return a JSON object with:
- name: full name (string, required)
- number: jersey number (string or null)
- position: position abbreviation or full name (string or null)
- year: academic year — Fr, So, Jr, Sr, Grad, RS Fr, etc. (string or null)
- height: height like "6-2" (string or null)
- weight: weight in lbs as integer (or null)
- hometown: city, state (string or null)
- high_school: high school name (string or null)
- major: academic major (string or null)

Rules:
1. Extract players/roster members only — not coaches or staff.
2. Use null for missing fields — do not guess.
3. Return ONLY valid JSON, no markdown, no explanation.

Return format: {"athletes": [...], "note": "optional note"}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse athletes from that text. Try selecting more of the page.' });

    const parsed = JSON.parse(jsonMatch[0]);
    const athletes = (parsed.athletes || []).filter(a => a.name && a.name.trim().length > 1);

    res.json({ athletes, count: athletes.length, note: parsed.note || null });
  } catch (err) {
    console.error('[roster/parse-text]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/fetch-url
// Director provides a direct URL → we fetch + Claude extracts → preview returned.
app.post('/api/university/roster/fetch-url', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const { url, sport = 'Unknown', universityName = 'Unknown University' } = req.body;
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'A valid URL is required.' });
    const { fetchAndExtract } = require('./services/university/WebExtractionService');
    const result = await fetchAndExtract(url, { universityName, sport, sourceUrl: url, isJson: false });
    if (!result.ok) return res.status(422).json({ error: `Could not reach that URL (${result.error || result.status}). Try pasting the text instead.` });
    res.json({ athletes: result.athletes, count: result.athletes.length, note: result.extractionNotes });
  } catch (err) {
    console.error('[roster/fetch-url]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/discover
// Start a new roster discovery job for a university + sport.
// Returns immediately with jobId. Poll GET /discovery/:jobId for status.
app.post('/api/university/roster/discover', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { sport, universityName } = req.body;
    if (!sport) return res.status(400).json({ error: 'sport is required' });
    if (!universityName) return res.status(400).json({ error: 'universityName is required' });

    // Resolve university_id: prefer linked account, fall back to DB name lookup,
    // then derive a stable slug so the job can always proceed.
    let universityId = await resolveSessionUniversity(userId);
    if (!universityId) {
      const byName = await store.pool.query(
        'SELECT id FROM universities WHERE LOWER(name) = LOWER($1) LIMIT 1',
        [universityName]
      );
      universityId = byName.rows[0]?.id
        || ('univ-' + universityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }

    // Resolve the canonical display name (linked account or provided string)
    let univName = universityName;
    if (!univName) {
      const univRow = await store.pool.query('SELECT name FROM universities WHERE id = $1', [universityId]);
      univName = univRow.rows[0]?.name || 'Unknown University';
    }

    const jobId = await RosterIntelligenceService.startDiscoveryJob(store.pool, {
      universityId,
      universityName: univName,
      sport,
      triggeredBy: 'manual',
      agentId: userId,
    });

    res.json({ jobId, status: 'queued', message: 'Discovery job started' });
  } catch (err) {
    console.error('[university] Roster discover error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/roster/discovery/:jobId
// Poll job status — returns current status, counters, and source details.
app.get('/api/university/roster/discovery/:jobId', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const job = await RosterIntelligenceService.getJobStatus(store.pool, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/roster/discovery
// List recent discovery jobs for this university.
app.get('/api/university/roster/discovery', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const jobs  = await RosterIntelligenceService.listJobs(store.pool, { universityId, limit });
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/roster/review-queue
// Pending athletes awaiting human approval.
app.get('/api/university/roster/review-queue', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId       = req.session.userId;
    const universityId = await resolveSessionUniversity(userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked', code: 'NO_UNIVERSITY_LINKED' });

    const status = req.query.status || 'pending';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const items  = await RosterIntelligenceService.getReviewQueue(store.pool, { universityId, status, limit });
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/review/:id/approve
// Approve a queued athlete — imports into CRM.
app.post('/api/university/roster/review/:id/approve', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId = req.session.userId;
    const result = await RosterIntelligenceService.approveReviewItem(store.pool, {
      reviewId:   parseInt(req.params.id, 10),
      reviewedBy: userId,
      agentId:    userId,
    });
    res.json(result);
  } catch (err) {
    console.error('[university] Review approve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/roster/review/:id/reject
// Reject a queued athlete — marks as rejected, no import.
app.post('/api/university/roster/review/:id/reject', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const userId = req.session.userId;
    const result = await RosterIntelligenceService.rejectReviewItem(store.pool, {
      reviewId:   parseInt(req.params.id, 10),
      reviewedBy: userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// NIL DIRECTOR DASHBOARD ROUTES
// All require university mode. Scope is always the session user's university.
// ════════════════════════════════════════════════════════════════════════

// GET /api/university/nil-dashboard
// Full dashboard metrics: athletes, deals, monthly activity, top earners,
// under-monetized athletes, sport breakdown.
app.get('/api/university/nil-dashboard', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const data = await NILDirectorService.getDashboardMetrics(store.pool, universityId);
    res.json(data);
  } catch (err) {
    console.error('[NILDirector] dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/athletes/crm
// Athlete CRM with enriched deal data, contact status, risk flags.
// Query params: search, sport, status (active|idle|no_deals|flagged)
app.get('/api/university/athletes/crm', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const { search = '', sport = '', status = '' } = req.query;
    const athletes = await NILDirectorService.getAthleteCRM(store.pool, universityId, { search, sport, status });
    res.json({ athletes, count: athletes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/deal-pipeline
// All deals for this university. Query params: status, search, athleteId
app.get('/api/university/deal-pipeline', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const { status = '', search = '', athleteId = '' } = req.query;
    const deals = await NILDirectorService.getDealPipeline(store.pool, universityId, { status, search, athleteId });
    res.json({ deals, count: deals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/deal-pipeline
// Create a new university deal record.
app.post('/api/university/deal-pipeline', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const { athleteId, brand, dealValue, dealType, status, startDate, endDate, disclosureStatus, notes } = req.body;
    if (!athleteId || !brand) return res.status(400).json({ error: 'athleteId and brand are required' });
    const result = await NILDirectorService.createDeal(store.pool, universityId, {
      athleteId, brand, dealValue, dealType, status, startDate, endDate, disclosureStatus, notes,
    }, req.session.userId);
    res.status(201).json(result);
  } catch (err) {
    console.error('[NILDirector] create deal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/university/deal-pipeline/:id
// Update a deal (status, disclosure, dates, notes, value).
app.patch('/api/university/deal-pipeline/:id', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    await NILDirectorService.updateDeal(store.pool, req.params.id, req.body, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/university/deal-pipeline/:id
app.delete('/api/university/deal-pipeline/:id', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    await NILDirectorService.deleteDeal(store.pool, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/daily-actions
// Computed action queue for today. Regenerates from CRM state on each call.
app.get('/api/university/daily-actions', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const actions = await NILDirectorService.getDailyActions(store.pool, universityId);
    res.json({ actions, count: actions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/daily-actions/:id/dismiss
app.post('/api/university/daily-actions/:id/dismiss', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    await NILDirectorService.dismissAction(store.pool, req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/opportunities
// AI-generated insights: under-monetized, high potential, brand opportunities.
app.get('/api/university/opportunities', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const univRow = await store.pool.query('SELECT name FROM universities WHERE id = $1', [universityId]);
    const univName = univRow.rows[0]?.name || 'University';
    const insights = await NILDirectorService.getOpportunityInsights(store.pool, universityId, univName);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/compliance-alerts
// Compliance issues: missing disclosures, expiring deals, at-risk athletes.
app.get('/api/university/compliance-alerts', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const alerts = await NILDirectorService.getComplianceAlerts(store.pool, universityId);
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/activity-feed
// Recent staff notes, calls, emails across all athletes.
app.get('/api/university/activity-feed', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const feed = await NILDirectorService.getActivityFeed(store.pool, universityId, limit);
    res.json({ feed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/university/athlete-notes/:athleteId
app.get('/api/university/athlete-notes/:athleteId', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    const notes = await NILDirectorService.getNotes(store.pool, universityId, req.params.athleteId);
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/university/athlete-notes/:athleteId
app.post('/api/university/athlete-notes/:athleteId', requireAuth, requireUniversityMode, async (req, res) => {
  try {
    const universityId = await resolveSessionUniversity(req.session.userId);
    if (!universityId) return res.status(400).json({ error: 'No university linked' });
    if (!req.body.body) return res.status(400).json({ error: 'body is required' });
    const note = await NILDirectorService.addNote(
      store.pool, universityId, req.params.athleteId,
      { contactType: req.body.contactType, subject: req.body.subject, body: req.body.body, isPinned: req.body.isPinned },
      req.session.userId
    );
    res.status(201).json(note);
  } catch (err) {
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

// ── PDF Contract Scanner — standalone (no athlete required) ──────────────
// POST /api/pdf/analyze
// Upload any PDF contract → extract text → AI extracts deliverables +
// runs market rate analysis → returns structured JSON.
// Does NOT write to DB — purely analytical / read-only.
const pdfScanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' ||
               file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
               file.mimetype === 'application/msword';
    cb(ok ? null : new Error('Only PDF and DOCX files accepted'), ok);
  },
});

app.post('/api/pdf/analyze', requireAuth, aiLimiter, pdfScanUpload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { buffer, mimetype, originalname } = req.file;

    // ── Step 1: Extract raw text ────────────────────────────────────
    let rawText = '';
    if (mimetype === 'application/pdf') {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
          { type: 'text', text: 'Extract all text from this contract document verbatim. Return only the raw text.' },
        ]}],
      });
      rawText = resp.content[0]?.text || '';
    } else {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      rawText = result.value || '';
    }

    if (!rawText || rawText.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this file.' });
    }

    // ── Step 2: Deliverable extraction ─────────────────────────────
    const extractPrompt = `You are a senior sports attorney analyzing an NIL contract.

CONTRACT TEXT:
${rawText.substring(0, 14000)}

Extract ALL deliverables, obligations, and payment milestones. Return JSON:
{
  "brand": "brand name",
  "start_date": "YYYY-MM-DD or null",
  "end_date": "YYYY-MM-DD or null",
  "total_compensation": 0,
  "payment_schedule": "description or null",
  "exclusivity": "none | category | full | null",
  "territory": "description or null",
  "deliverables": [
    {
      "description": "exactly what athlete must do",
      "type": "social_post | story | appearance | content | payment | other",
      "due_date": "YYYY-MM-DD or null",
      "recurrence": "monthly | weekly | biweekly | one-time | null",
      "contract_duration_months": null,
      "platform": "instagram | tiktok | youtube | in-person | null",
      "confidence": 90
    }
  ],
  "key_terms": ["list of notable clauses"],
  "risk_flags": [
    { "severity": "high | medium | low", "issue": "short description", "detail": "explanation" }
  ]
}

Return ONLY valid JSON. No markdown.`;

    // Run extraction AI call
    const extractRaw = await ai.oneShot(extractPrompt, 'You are a legal contract analyst. Return only valid JSON. No markdown.', 3500);

    // Parse extraction
    let extracted = {};
    try {
      const clean = extractRaw.replace(/```json/gi,'').replace(/```/g,'').trim();
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) extracted = JSON.parse(m[0]);
    } catch (e) { extracted = { deliverables: [], risk_flags: [] }; }

    // Normalize deliverable_type field (server uses "type", frontend expects "deliverable_type")
    if (Array.isArray(extracted.deliverables)) {
      extracted.deliverables = extracted.deliverables.map(d => ({
        ...d,
        deliverable_type: d.deliverable_type || d.type || 'other',
        confidence_score: d.confidence_score || d.confidence || 0,
      }));
    }
    // Flatten risk_flags to string array if objects
    if (Array.isArray(extracted.risk_flags)) {
      extracted.risk_flags = extracted.risk_flags.map(r =>
        typeof r === 'string' ? r : (r.issue ? `[${(r.severity||'').toUpperCase()}] ${r.issue}: ${r.detail||''}` : JSON.stringify(r))
      );
    }

    res.json({
      ok: true,
      filename: originalname,
      textLength: rawText.length,
      extraction: {
        brand: extracted.brand || null,
        start_date: extracted.start_date || null,
        end_date: extracted.end_date || null,
        total_value: extracted.total_compensation ? `$${Number(extracted.total_compensation).toLocaleString()}` : null,
        deliverables: extracted.deliverables || [],
        key_terms: extracted.key_terms || [],
        risk_flags: extracted.risk_flags || [],
      },
    });
  } catch (e) {
    console.error('[pdf/analyze]', e.message);
    res.status(500).json({ error: e.message || 'PDF analysis failed' });
  }
});

// ── AGENT GLOBAL OPS CALENDAR ────────────────────────────────────────────
app.get('/api/agent/calendar', requireAuth, async (req, res) => {
  try {
    const agentId = req.session.userId;
    const { year, month, athlete_id, brand, status } = req.query;

    let sql = `SELECT ace.*, a.data->>'name' as athlete_name FROM athlete_calendar_events ace JOIN athletes a ON ace.athlete_id = a.id WHERE ace.agent_id=$1`;
    const params = [agentId];
    let idx = 2;

    if (year && month) {
      sql += ` AND EXTRACT(YEAR FROM ace.event_date) = $${idx} AND EXTRACT(MONTH FROM ace.event_date) = $${idx+1}`;
      params.push(parseInt(year), parseInt(month));
      idx += 2;
    } else if (year) {
      sql += ` AND EXTRACT(YEAR FROM ace.event_date) = $${idx}`;
      params.push(parseInt(year));
      idx++;
    }
    if (athlete_id) { sql += ` AND ace.athlete_id = $${idx}`; params.push(athlete_id); idx++; }
    if (brand)      { sql += ` AND ace.brand = $${idx}`;      params.push(brand);      idx++; }
    if (status)     { sql += ` AND ace.status = $${idx}`;     params.push(status);     idx++; }

    sql += ` ORDER BY ace.event_date ASC`;

    const eventsResult = await store.pool.query(sql, params);

    // Always return ALL athletes under this agent (not just those with events)
    // FIXED: removed stale espn_import/university_import source filters — isolation is now structural (university_athletes table)
    const athleteListResult = await store.pool.query(
      `SELECT id, data->>'name' as name FROM athletes WHERE agent_id=$1 ORDER BY (data->>'name') ASC`,
      [agentId]
    );

    res.json({ events: eventsResult.rows, athleteList: athleteListResult.rows.map(r => ({ id: r.id, name: r.name })) });
  } catch (e) {
    console.error('[agent/calendar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ATHLETE-SCOPED CALENDAR ───────────────────────────────────────────────
app.get('/api/athlete-portal/calendar', requireAuth, async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user || user.role !== 'athlete') return res.status(403).json({ error: 'Athletes only' });
    const athleteId = user.athlete_id || user.athleteId;
    if (!athleteId) return res.status(400).json({ error: 'No athlete profile linked' });

    const { year, month } = req.query;
    let sql = `SELECT * FROM athlete_calendar_events WHERE athlete_id=$1`;
    const params = [athleteId];
    let idx = 2;

    if (year && month) {
      sql += ` AND EXTRACT(YEAR FROM event_date) = $${idx} AND EXTRACT(MONTH FROM event_date) = $${idx+1}`;
      params.push(parseInt(year), parseInt(month));
      idx += 2;
    } else if (year) {
      sql += ` AND EXTRACT(YEAR FROM event_date) = $${idx}`;
      params.push(parseInt(year));
      idx++;
    }
    sql += ` ORDER BY event_date ASC`;

    const r = await store.pool.query(sql, params);
    res.json({ events: r.rows });
  } catch (e) {
    console.error('[athlete-portal/calendar]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ATHLETE POST OUTREACH ─────────────────────────────────────────────────
app.post('/api/athlete-portal/outreach', requireAuth, async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user || user.role !== 'athlete') return res.status(403).json({ error: 'Athletes only' });
    const athleteId = user.athlete_id || user.athleteId;
    const agentId   = user.agent_id  || user.agentId;
    if (!athleteId) return res.status(400).json({ error: 'No athlete profile linked' });

    const { subject, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const id = 'out-' + require('crypto').randomBytes(8).toString('hex');
    await store.pool.query(
      `INSERT INTO athlete_outreach (id, athlete_id, agent_id, subject, message, status) VALUES ($1,$2,$3,$4,$5,'sent')`,
      [id, athleteId, agentId || null, subject || null, message.trim()]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('[athlete-portal/outreach POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ATHLETE READ OWN OUTREACH ─────────────────────────────────────────────
app.get('/api/athlete-portal/outreach', requireAuth, async (req, res) => {
  try {
    const user = await store.getUser(req.session.userId);
    if (!user || user.role !== 'athlete') return res.status(403).json({ error: 'Athletes only' });
    const athleteId = user.athlete_id || user.athleteId;
    if (!athleteId) return res.status(400).json({ error: 'No athlete profile linked' });

    const r = await store.pool.query(
      `SELECT * FROM athlete_outreach WHERE athlete_id=$1 ORDER BY created_at DESC`,
      [athleteId]
    );
    res.json({ messages: r.rows });
  } catch (e) {
    console.error('[athlete-portal/outreach GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AGENT READ ALL ATHLETE OUTREACH ──────────────────────────────────────
app.get('/api/agent/outreach', requireAuth, async (req, res) => {
  try {
    const agentId = req.session.userId;
    const r = await store.pool.query(
      `SELECT ao.*, a.data->>'name' as athlete_name FROM athlete_outreach ao JOIN athletes a ON ao.athlete_id = a.id WHERE ao.agent_id=$1 ORDER BY ao.created_at DESC`,
      [agentId]
    );
    res.json({ messages: r.rows });
  } catch (e) {
    console.error('[agent/outreach]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/pdf/save ───────────────────────────────────────────────────
// Saves PDF Scanner extraction results to DB: contract record + deliverables + calendar events

// Normalize any date string to YYYY-MM-DD for PostgreSQL.
// Handles: "YYYY-MM-DD", "June 15, 2025", "15 June 2025", "6/15/2025", ISO timestamps, etc.
function normalizeDateForDB(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Strip time if present (e.g. "2025-06-15T00:00:00Z")
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.split('T')[0];
  // Let JS Date parse human-readable strings ("June 15, 2025", "6/15/2025", etc.)
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  } catch (_) {}
  console.warn('[pdf/save] Could not parse date:', s);
  return null;
}

app.post('/api/pdf/save', requireAuth, async (req, res) => {
  try {
    const { athleteId, filename, brand, deliverables } = req.body;
    console.log(`[pdf/save] agent=${req.session.userId} athlete=${athleteId} deliverables=${Array.isArray(deliverables) ? deliverables.length : 'none'}`);

    if (!athleteId) return res.status(400).json({ error: 'athleteId required' });
    if (!Array.isArray(deliverables) || !deliverables.length)
      return res.status(400).json({ error: 'No deliverables to save' });

    const agentId = String(req.session.userId);
    const athlete = await store.getAthlete(athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    // Compare as strings to avoid type-mismatch (session userId vs DB agent_id)
    if (String(athlete.agentId) !== agentId)
      return res.status(403).json({ error: 'Forbidden — athlete does not belong to this agent' });

    const { brandColor } = require('./services/contractExtraction');
    const { toRRule, generateDates } = require('./services/calendarRecurrence');
    const crypto = require('crypto');

    // Create contract record
    const contractId = 'contract-' + crypto.randomBytes(8).toString('hex');
    const contractBrand = brand || 'Unknown Brand';
    await store.pool.query(
      `INSERT INTO athlete_contracts
         (id, athlete_id, agent_id, filename, brand, extraction_status, extraction_attempts, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,'completed',1,NOW())
       ON CONFLICT (id) DO NOTHING`,
      [contractId, athleteId, agentId, filename || 'PDF Scanner Upload', contractBrand]
    );
    console.log(`[pdf/save] contract record created: ${contractId}`);

    let savedDeliverables = 0;
    let savedEvents = 0;
    let skippedDeliverables = 0;
    const eventsToGCal = [];

    const client = await store.pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < deliverables.length; i++) {
        const d = deliverables[i];
        const desc = (d.description || d.deliverable_description || '').trim();
        if (!desc) { skippedDeliverables++; continue; }

        const recurrence = d.recurrence && d.recurrence !== 'one-time' ? d.recurrence : null;
        const rrule = toRRule(recurrence, d.contract_duration_months || null);
        // Normalize date — handles "June 15, 2025", "YYYY-MM-DD", ISO timestamps, etc.
        const dueDate = normalizeDateForDB(d.due_date);
        const evBrand = contractBrand;
        const confidence = parseInt(d.confidence_score || d.confidence || 0, 10);

        console.log(`[pdf/save] deliverable[${i}]: "${desc.substring(0,40)}" due=${dueDate || 'none'}`);

        // contractId is random per upload so duplicates are impossible — no ON CONFLICT needed
        const dr = await client.query(
          `INSERT INTO athlete_deliverables
             (athlete_id, agent_id, contract_id, deliverable_description, due_date, brand,
              status, recurrence, recurrence_rule, ai_confidence_score, source, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,'pdf_scanner',$10)
           RETURNING id`,
          [athleteId, agentId, contractId, desc, dueDate, evBrand,
           recurrence, rrule, confidence, i]
        );

        if (dr.rows.length) {
          savedDeliverables++;
          const deliverableId = dr.rows[0].id;
          const color = brandColor(evBrand);

          // Generate calendar events for this deliverable
          if (dueDate) {
            const dates = rrule
              ? generateDates(rrule, dueDate, { durationMonths: d.contract_duration_months })
              : [dueDate];

            for (const date of dates) {
              const normalizedDate = normalizeDateForDB(date);
              if (!normalizedDate) continue;
              const evId = 'evt-' + crypto.randomBytes(8).toString('hex');
              await client.query(
                `INSERT INTO athlete_calendar_events
                   (id, athlete_id, agent_id, deliverable_id, contract_id, title, event_date,
                    brand, color, status, is_generated, recurrence_instance, manually_modified)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',TRUE,$10,FALSE)
                 ON CONFLICT (deliverable_id, event_date) WHERE deliverable_id IS NOT NULL DO NOTHING`,
                [evId, athleteId, agentId, deliverableId, contractId, desc, normalizedDate,
                 evBrand, color, dates.length > 1]
              );
              savedEvents++;
              eventsToGCal.push({ id: evId, title: desc, event_date: normalizedDate, brand: evBrand, notes: '' });
            }
          }
        }
      }

      await client.query('COMMIT');
      // Fire-and-forget: push newly saved events to athlete's Google Calendar (if connected)
      eventsToGCal.forEach(ev => _pushEventToGCal(athleteId, ev));
    } catch (txErr) {
      await client.query('ROLLBACK');
      console.error('[pdf/save] transaction error:', txErr.message);
      throw txErr;
    } finally {
      client.release();
    }

    console.log(`[pdf/save] done — saved ${savedDeliverables} deliverables, ${savedEvents} events (skipped ${skippedDeliverables})`);
    res.json({
      ok: true,
      contractId,
      savedDeliverables,
      savedEvents,
      skippedDeliverables,
      athleteName: athlete.name,
    });
  } catch (e) {
    console.error('[pdf/save] ERROR:', e.message, e.stack);
    res.status(500).json({ error: e.message || 'Save failed' });
  }
});

app.use('/icons', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  next();
}, require('express').static(path.join(__dirname, '..', 'public', 'icons')));

// ── Media Kit Routes ──────────────────────────────────────────────────────

// GET /api/athlete/media-kit — load saved media kit (athlete auth)
app.get('/api/athlete/media-kit', verifyAthleteToken, async (req, res) => {
  try {
    const mkR = await store.pool.query(
      'SELECT * FROM media_kits WHERE athlete_id = $1',
      [req.athlete.id]
    );
    if (!mkR.rows.length) return res.json({ mediaKit: null, rateCards: [] });
    const mk = mkR.rows[0];
    const rcR = await store.pool.query(
      'SELECT * FROM media_kit_rate_cards WHERE media_kit_id = $1 ORDER BY id',
      [mk.id]
    );
    res.json({ mediaKit: mk, rateCards: rcR.rows });
  } catch (e) {
    console.error('[media-kit GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/athlete/media-kit/save — save/update media kit (athlete auth)
app.post('/api/athlete/media-kit/save', verifyAthleteToken, async (req, res) => {
  try {
    const {
      instagram_handle, instagram_followers, instagram_engagement,
      tiktok_handle, tiktok_followers,
      twitter_handle, twitter_followers,
      bio, primary_color, secondary_color,
      headshot_data, action_shot_data, theme
    } = req.body;
    // Theme is optional: only 'school'|'nildash' are stored; anything else (or
    // absent) leaves the saved theme untouched via COALESCE in the upsert.
    const themeUpdate = (theme === 'school' || theme === 'nildash') ? theme : null;

    // Fetch athlete name for slug generation
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name FROM athletes a WHERE a.id = $1`,
      [req.athlete.id]
    );
    const athleteName = athR.rows[0]?.name || req.athlete.id;
    const baseSlug = athleteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-nil';

    // Build headshot/action updates (only update if a new value was supplied;
    // null means "leave unchanged", empty string means "clear photo")
    const headshotUpdate = headshot_data !== undefined ? headshot_data || null : undefined;
    const actionUpdate   = action_shot_data !== undefined ? action_shot_data || null : undefined;

    // Upsert media kit
    const mkR = await store.pool.query(
      `INSERT INTO media_kits
         (athlete_id, instagram_handle, instagram_followers, instagram_engagement,
          tiktok_handle, tiktok_followers, twitter_handle, twitter_followers,
          bio, primary_color, secondary_color, headshot_url, action_shot_data, slug, theme, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (athlete_id) DO UPDATE SET
         instagram_handle = EXCLUDED.instagram_handle,
         instagram_followers = EXCLUDED.instagram_followers,
         instagram_engagement = EXCLUDED.instagram_engagement,
         tiktok_handle = EXCLUDED.tiktok_handle,
         tiktok_followers = EXCLUDED.tiktok_followers,
         twitter_handle = EXCLUDED.twitter_handle,
         twitter_followers = EXCLUDED.twitter_followers,
         bio = EXCLUDED.bio,
         primary_color = EXCLUDED.primary_color,
         secondary_color = EXCLUDED.secondary_color,
         headshot_url = CASE WHEN EXCLUDED.headshot_url IS NOT NULL THEN EXCLUDED.headshot_url ELSE media_kits.headshot_url END,
         action_shot_data = CASE WHEN EXCLUDED.action_shot_data IS NOT NULL THEN EXCLUDED.action_shot_data ELSE media_kits.action_shot_data END,
         slug = COALESCE(media_kits.slug, EXCLUDED.slug),
         theme = COALESCE(EXCLUDED.theme, media_kits.theme),
         updated_at = NOW()
       RETURNING *`,
      [req.athlete.id, instagram_handle||null, instagram_followers||null, instagram_engagement||null,
       tiktok_handle||null, tiktok_followers||null, twitter_handle||null, twitter_followers||null,
       bio||null, primary_color||null, secondary_color||null,
       headshotUpdate !== undefined ? headshotUpdate : null,
       actionUpdate   !== undefined ? actionUpdate   : null,
       baseSlug, themeUpdate]
    );
    const mk = mkR.rows[0];

    // Replace rate cards (accept rateCards | rates | rate_cards, normalized)
    const cleanRates = normalizeRateCardsPayload(req.body);
    await store.pool.query('DELETE FROM media_kit_rate_cards WHERE media_kit_id = $1', [mk.id]);
    for (const rc of cleanRates) {
      await store.pool.query(
        'INSERT INTO media_kit_rate_cards (media_kit_id, service_type, price, notes) VALUES ($1,$2,$3,$4)',
        [mk.id, rc.service_type, rc.price, rc.notes]
      );
    }

    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const shareUrl = `${appUrl}/media-kit/${mk.slug}`;
    console.log(`[media-kit save] athlete=${req.athlete.id} slug=${mk.slug}`);
    res.json({ ok: true, slug: mk.slug, shareUrl });
  } catch (e) {
    console.error('[media-kit save]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/athlete/generate-bio — AI-generated NIL bio (athlete auth)
app.post('/api/athlete/generate-bio', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const { story } = req.body;
    const storyText = (story || '').trim();
    console.log('[generate-bio] athlete id:', req.athlete.id, '— story provided:', !!storyText);

    // Fetch athlete profile + most current follower counts (media_kit values take priority over athletes.data)
    const athR = await store.pool.query(
      `SELECT
         a.data->>'name'     as name,
         a.data->>'sport'    as sport,
         a.data->>'school'   as school,
         a.data->>'position' as position,
         COALESCE(mk.instagram_followers, (a.data->>'instagram')::int, 0) as ig_followers,
         COALESCE(mk.tiktok_followers,    (a.data->>'tiktok')::int,    0) as tt_followers,
         COALESCE(mk.twitter_followers,   0)                              as tw_followers
       FROM athletes a
       LEFT JOIN media_kits mk ON mk.athlete_id = a.id
       WHERE a.id = $1`,
      [req.athlete.id]
    );
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const ath = athR.rows[0];
    console.log('[generate-bio] data:', JSON.stringify(ath), '— story:', storyText || '(none)');

    const name     = ath.name     || 'this athlete';
    const sport    = ath.sport    || 'college';
    const school   = ath.school   || 'their university';
    const position = ath.position || '';
    const igCount  = parseInt(ath.ig_followers) || 0;
    const ttCount  = parseInt(ath.tt_followers) || 0;
    const twCount  = parseInt(ath.tw_followers) || 0;

    // Build social stats string
    const socialParts = [];
    if (igCount > 0) socialParts.push(`${igCount.toLocaleString()} Instagram followers`);
    if (ttCount > 0) socialParts.push(`${ttCount.toLocaleString()} TikTok followers`);
    if (twCount > 0) socialParts.push(`${twCount.toLocaleString()} Twitter/X followers`);
    const socialStr = socialParts.length > 0 ? socialParts.join(', ') : '';

    const system = `You are a professional NIL sports marketing copywriter who writes athlete bios for brand partnership media kits. Your bios do three things: tell the athlete's story, show their value to brands, and create an emotional hook that makes brands want to reach out. Write like a human, not a marketer. Be specific, confident, and authentic. Never generic. Return only the bio text — no quotes, no labels, no commentary.`;

    let prompt;
    if (storyText) {
      prompt = `Write a 2-3 sentence NIL media kit bio for ${name}, a${position ? ' ' + position : ''} ${sport} athlete at ${school}.

Their story: ${storyText}${socialStr ? `\n\nTheir stats: ${socialStr}.` : ''}

The bio must:
- Open with or reference their personal story in a way that creates an emotional hook
- Show why their audience is valuable to brands
- End with a line that makes a brand want to reach out
- Sound like the athlete wrote it — confident, real, human
- Never use corporate language or clichés like "passionate about" or "dedicated to"

Under 200 characters total.`;
    } else {
      prompt = `Write a 2-3 sentence NIL media kit bio for ${name}, a${position ? ' ' + position : ''} ${sport} athlete at ${school}${socialStr ? ` with ${socialStr}` : ''}.

The bio must:
- Open with a strong hook that immediately tells a brand why this athlete is worth their attention
- Show why their audience is valuable to brands
- End with a line that makes a brand want to reach out
- Sound like the athlete wrote it — confident, real, human
- Never use corporate language or clichés

Under 200 characters total.`;
    }

    const bio = await ai.oneShot(prompt, system, 200, 'claude-sonnet-4-6');
    console.log('[generate-bio] success — bio length:', (bio||'').length, '— preview:', (bio||'').substring(0, 60));
    res.json({ bio: (bio || '').trim().slice(0, 500) });
  } catch (e) {
    console.error('[generate-bio] error:', e.message);
    res.status(500).json({ error: 'Bio generation failed' });
  }
});

// ── Media kit view tracking helpers ─────────────────────────────────────────
// Privacy: only a salted hash of IP + user agent is ever stored, never the raw
// IP, and the public page sets no cookies. Repeat views from the same hash
// within 30 minutes count once. Views from the kit's own logged-in agent are
// not recorded at all.
function mkSessionHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ua = req.headers['user-agent'] || '';
  const salt = process.env.SESSION_SECRET || 'nildash-mkv';
  return require('crypto').createHash('sha256').update(salt + '|' + ip + '|' + ua).digest('hex');
}

async function recordKitView(req, mk, variantSlug, variantBrand) {
  try {
    if (req.session && req.session.userId && req.session.userId === mk.agent_id) return; // agent's own view
    const hash = mkSessionHash(req);
    const dup = await store.pool.query(
      `SELECT 1 FROM media_kit_views
        WHERE kit_slug = $1 AND session_hash = $2 AND viewed_at > NOW() - INTERVAL '30 minutes'
        LIMIT 1`,
      [mk.slug, hash]
    );
    if (dup.rows.length) return;
    await store.pool.query(
      `INSERT INTO media_kit_views (kit_slug, athlete_id, agent_id, variant, variant_brand, session_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [mk.slug, mk.athlete_id, mk.agent_id || null, variantSlug || null, variantBrand || null, hash]
    );
  } catch (e) {
    console.warn('[media-kit views] record failed:', e.message);
  }
}

// Normalize rate cards from a save payload into clean {service_type, price, notes}
// rows. Reads from whichever key the client sent (rateCards, rates, rate_cards),
// tolerates alternate field names and a JSON-string payload, coerces messy
// prices, and drops rows with no service label or no positive price. Keeping the
// tolerance on the SAVE side means a stray key never silently drops the rates.
function normalizeRateCardsPayload(body) {
  let raw = (body && (body.rateCards != null ? body.rateCards
    : body.rates != null ? body.rates
    : body.rate_cards)) || [];
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = []; } }
  if (!Array.isArray(raw)) return [];
  return raw.map((rc) => {
    rc = rc || {};
    const service_type = String(rc.service_type || rc.label || rc.service || rc.name || '').trim();
    let price = Number(rc.price != null ? rc.price : (rc.amount != null ? rc.amount : rc.rate));
    if (!Number.isFinite(price)) price = Number(String(rc.price != null ? rc.price : (rc.amount != null ? rc.amount : rc.rate) || '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(price)) price = 0;
    return { service_type, price: Math.round(price), notes: rc.notes || rc.note || '' };
  }).filter((rc) => rc.service_type && rc.price > 0);
}

// GET /api/media-kit/:slug — public data endpoint (no auth)
app.get('/api/media-kit/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const mkR = await store.pool.query(
      `SELECT mk.*, a.agent_id FROM media_kits mk
        LEFT JOIN athletes a ON a.id = mk.athlete_id
       WHERE mk.slug = $1`, [slug]);
    if (!mkR.rows.length) return res.status(404).json({ error: 'Media kit not found' });
    const mk = mkR.rows[0];

    // Get athlete name/sport/school/position + agent first name (for the
    // inquiry confirmation copy)
    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport,
              a.data->>'school' as school, a.data->>'position' as position,
              u.name as agent_name
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
       WHERE a.id = $1`,
      [mk.athlete_id]
    );
    const ath = athR.rows[0] || {};

    const rcR = await store.pool.query(
      'SELECT * FROM media_kit_rate_cards WHERE media_kit_id = $1 ORDER BY id',
      [mk.id]
    );

    // Per-brand variant (?for=<brandSlug>): personalization only, the base kit
    // record is never modified. Unknown slugs fall back to the base kit.
    const forSlug = String(req.query.for || '').trim().toLowerCase();
    const variants = (mk.variants && typeof mk.variants === 'object') ? mk.variants : {};
    const variant = forSlug && variants[forSlug] ? { ...variants[forSlug], slug: forSlug } : null;

    // Record the view; failures never break the page
    recordKitView(req, mk, variant ? forSlug : null, variant ? variant.brand : null);

    const { variants: _v, ...mkPublic } = mk;
    res.json({
      ...mkPublic,
      athlete_name: ath.name || '',
      sport: ath.sport || '',
      school: ath.school || '',
      position: ath.position || '',
      agent_first_name: (ath.agent_name || '').split(/\s+/)[0] || '',
      rateCards: rcR.rows,
      variant,
    });
  } catch (e) {
    console.error('[api/media-kit/:slug]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/athletes/media-kit-status — agent: check which athletes have media kits
app.get('/api/agents/media-kit-status', requireAuth, async (req, res) => {
  try {
    const athR = await store.pool.query(
      'SELECT id FROM athletes WHERE agent_id = $1',
      [req.session.userId]
    );
    const ids = athR.rows.map(r => r.id);
    if (!ids.length) return res.json({ kits: {} });
    const mkR = await store.pool.query(
      'SELECT athlete_id, slug FROM media_kits WHERE athlete_id = ANY($1)',
      [ids]
    );
    const kits = {};
    mkR.rows.forEach(r => { kits[r.athlete_id] = r.slug; });
    res.json({ kits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/athlete-media-kit/:athleteId — agent loads an athlete's saved media kit
app.get('/api/agent/athlete-media-kit/:athleteId', requireAuth, async (req, res) => {
  try {
    const { athleteId } = req.params;
    const athR = await store.pool.query(
      'SELECT id, data FROM athletes WHERE id=$1 AND agent_id=$2',
      [athleteId, req.session.userId]
    );
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const mkR = await store.pool.query('SELECT * FROM media_kits WHERE athlete_id=$1', [athleteId]);
    if (!mkR.rows.length) return res.json({ mediaKit: null, rateCards: [], athlete: athR.rows[0].data || {} });
    const mk = mkR.rows[0];
    const rcR = await store.pool.query('SELECT * FROM media_kit_rate_cards WHERE media_kit_id=$1 ORDER BY id', [mk.id]);

    // View stats for the kit card: total, last viewed, per-brand-variant counts
    let viewStats = null;
    if (mk.slug) {
      try {
        const vs = await store.pool.query(
          `SELECT COUNT(*)::int AS total, MAX(viewed_at) AS last_viewed_at
             FROM media_kit_views WHERE kit_slug = $1`, [mk.slug]);
        const vv = await store.pool.query(
          `SELECT variant_brand, COUNT(*)::int AS count
             FROM media_kit_views WHERE kit_slug = $1 AND variant_brand IS NOT NULL
            GROUP BY variant_brand ORDER BY count DESC LIMIT 8`, [mk.slug]);
        viewStats = {
          total: vs.rows[0] ? vs.rows[0].total : 0,
          lastViewedAt: vs.rows[0] ? vs.rows[0].last_viewed_at : null,
          variants: vv.rows,
        };
      } catch (e) { /* views table may be one deploy behind; card just omits stats */ }
    }
    res.json({ mediaKit: mk, rateCards: rcR.rows, athlete: athR.rows[0].data || {}, viewStats });
  } catch (e) {
    console.error('[agent/athlete-media-kit GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/home-notices — read-time home feed: kits first viewed today
// and inbound inquiries from the last 48 hours. No stored notification state.
app.get('/api/agent/home-notices', requireAuth, async (req, res) => {
  const notices = [];
  try {
    const kv = await store.pool.query(
      `SELECT v.kit_slug, a.data->>'name' AS athlete_name,
              COUNT(*)::int AS views_today, MAX(v.viewed_at) AS last_viewed_at
         FROM media_kit_views v
         JOIN athletes a ON a.id = v.athlete_id
        WHERE v.agent_id = $1 AND v.viewed_at >= date_trunc('day', NOW())
        GROUP BY v.kit_slug, a.data->>'name'
        ORDER BY MAX(v.viewed_at) DESC LIMIT 6`,
      [req.session.userId]);
    for (const r of kv.rows) {
      notices.push({
        type: 'kit_view',
        text: `${r.athlete_name || 'An athlete'}'s media kit was viewed today`,
        detail: r.views_today > 1 ? `${r.views_today} views today` : null,
        at: r.last_viewed_at,
      });
    }
  } catch (e) { /* table may be one deploy behind */ }
  try {
    const inb = await store.pool.query(
      `SELECT d.data->>'brand' AS brand, a.data->>'name' AS athlete_name, d.created_at
         FROM deals d LEFT JOIN athletes a ON a.id = d.athlete_id
        WHERE d.agent_id = $1 AND d.data->>'stage' = 'Inbound'
          AND d.created_at >= NOW() - INTERVAL '48 hours'
        ORDER BY d.created_at DESC LIMIT 6`,
      [req.session.userId]);
    for (const r of inb.rows) {
      notices.push({
        type: 'inbound',
        text: `New inbound inquiry for ${r.athlete_name || 'your athlete'} from ${r.brand || 'a brand'}`,
        detail: null,
        at: r.created_at,
      });
    }
  } catch (e) { /* ignore */ }
  notices.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ notices: notices.slice(0, 8) });
});

// POST /api/agent/athlete-media-kit/:athleteId — agent saves an athlete's media kit
app.post('/api/agent/athlete-media-kit/:athleteId', requireAuth, async (req, res) => {
  try {
    const { athleteId } = req.params;
    const athR = await store.pool.query(
      `SELECT id, data->>'name' as name FROM athletes WHERE id=$1 AND agent_id=$2`,
      [athleteId, req.session.userId]
    );
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const athleteName = athR.rows[0].name || String(athleteId);
    const baseSlug = athleteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-nil';

    const {
      instagram_handle, instagram_followers, instagram_engagement,
      tiktok_handle, tiktok_followers, twitter_handle, twitter_followers,
      bio, primary_color, secondary_color,
      headshot_data, action_shot_data, theme
    } = req.body;

    const headshotUpdate = headshot_data !== undefined ? headshot_data || null : undefined;
    const actionUpdate   = action_shot_data !== undefined ? action_shot_data || null : undefined;
    // Theme is optional: only 'school'|'nildash' are stored; anything else (or
    // absent) leaves the saved theme untouched via COALESCE below.
    const themeUpdate = (theme === 'school' || theme === 'nildash') ? theme : null;

    const mkR = await store.pool.query(
      `INSERT INTO media_kits
         (athlete_id, instagram_handle, instagram_followers, instagram_engagement,
          tiktok_handle, tiktok_followers, twitter_handle, twitter_followers,
          bio, primary_color, secondary_color, headshot_url, action_shot_data, slug, theme, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (athlete_id) DO UPDATE SET
         instagram_handle = EXCLUDED.instagram_handle,
         instagram_followers = EXCLUDED.instagram_followers,
         instagram_engagement = EXCLUDED.instagram_engagement,
         tiktok_handle = EXCLUDED.tiktok_handle,
         tiktok_followers = EXCLUDED.tiktok_followers,
         twitter_handle = EXCLUDED.twitter_handle,
         twitter_followers = EXCLUDED.twitter_followers,
         bio = EXCLUDED.bio,
         primary_color = EXCLUDED.primary_color,
         secondary_color = EXCLUDED.secondary_color,
         headshot_url = CASE WHEN EXCLUDED.headshot_url IS NOT NULL THEN EXCLUDED.headshot_url ELSE media_kits.headshot_url END,
         action_shot_data = CASE WHEN EXCLUDED.action_shot_data IS NOT NULL THEN EXCLUDED.action_shot_data ELSE media_kits.action_shot_data END,
         slug = COALESCE(media_kits.slug, EXCLUDED.slug),
         theme = COALESCE(EXCLUDED.theme, media_kits.theme),
         updated_at = NOW()
       RETURNING *`,
      [athleteId, instagram_handle||null, instagram_followers||null, instagram_engagement||null,
       tiktok_handle||null, tiktok_followers||null, twitter_handle||null, twitter_followers||null,
       bio||null, primary_color||null, secondary_color||null,
       headshotUpdate !== undefined ? headshotUpdate : null,
       actionUpdate   !== undefined ? actionUpdate   : null,
       baseSlug, themeUpdate]
    );
    const mk = mkR.rows[0];

    // Replace rate cards (accept rateCards | rates | rate_cards, normalized)
    const cleanRates = normalizeRateCardsPayload(req.body);
    await store.pool.query('DELETE FROM media_kit_rate_cards WHERE media_kit_id=$1', [mk.id]);
    for (const rc of cleanRates) {
      await store.pool.query(
        'INSERT INTO media_kit_rate_cards (media_kit_id, service_type, price, notes) VALUES ($1,$2,$3,$4)',
        [mk.id, rc.service_type, rc.price, rc.notes]
      );
    }

    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    checkOff(req.session.userId, 'media_kit'); // Getting Started checklist
    res.json({ ok: true, slug: mk.slug, shareUrl: `${appUrl}/media-kit/${mk.slug}` });
  } catch (e) {
    console.error('[agent/athlete-media-kit POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Per-brand media kit variants (Deal Scan "Send kit") ─────────────────────
// Generates a brand-personalized variant of an existing kit: an AI opening
// line for the About section (Haiku, profile facts only, never fabricated),
// the matched interest tags, and a rate-card lead order for the brand's
// category. Stored in media_kits.variants JSONB so the base kit is untouched.
const VARIANT_SOCIAL_CATS = ['supplements','apparel','energydrink','app','accessories','beauty','nutrition','fitness','dtc','social','topnil','tech','snacks'];
function variantRateLead(category, lane) {
  const cat = String(category || '').toLowerCase();
  if (lane === 'social' || lane === 'topnil' || VARIANT_SOCIAL_CATS.includes(cat)) {
    return ['reel', 'tiktok', 'story', 'post']; // social-first brand leads with IG Reel
  }
  return ['post', 'appearance', 'story', 'reel']; // local business leads with IG Post + appearance
}

app.post('/api/agent/media-kit/:athleteId/variant', requireAuth, aiLimiter, async (req, res) => {
  try {
    const { athleteId } = req.params;
    const brand = String(req.body.brand || '').trim();
    if (!brand) return res.status(400).json({ error: 'brand required' });
    const category = String(req.body.category || '').trim();
    const lane = String(req.body.lane || '').trim();

    const athlete = await store.getAthlete(athleteId);
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    const user = await store.getUser(req.session.userId);
    if (athlete.agentId !== req.session.userId && (!user || user.email !== ADMIN_EMAIL)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const mkR = await store.pool.query('SELECT * FROM media_kits WHERE athlete_id=$1', [athleteId]);
    const mk = mkR.rows[0];
    if (!mk || !mk.slug) {
      return res.status(404).json({ error: 'No media kit yet', code: 'NO_KIT' });
    }

    const brandSlug = brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'brand';
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    const url = `${appUrl}/media-kit/${mk.slug}?for=${brandSlug}`;

    // Idempotent: an existing variant for this brand is reused, not regenerated.
    const variants = (mk.variants && typeof mk.variants === 'object') ? mk.variants : {};
    if (variants[brandSlug]) {
      return res.json({ ok: true, brandSlug, url, variant: variants[brandSlug], reused: true });
    }

    // Matched tags: only tags actually on the athlete's profile — no inventing.
    const athleteTags = Array.isArray(athlete.tags) ? athlete.tags.map(t => String(t).toLowerCase()) : [];
    const requestTags = Array.isArray(req.body.matchedTags) ? req.body.matchedTags.map(t => String(t).toLowerCase()) : [];
    const matchedTags = requestTags.filter(t => athleteTags.includes(t)).slice(0, 5);

    // AI opening line (Haiku: cheap and fast). Facts only, from the profile.
    const name = athlete.name || 'This athlete';
    const first = name.split(/\s+/)[0];
    const productWants = String(athlete.productWants || '').trim().slice(0, 200);
    let opener = '';
    try {
      const prompt = `Write ONE opening sentence (max 170 characters) for ${name}'s NIL media kit, personalized for the brand "${brand}"${category ? ` (${category})` : ''}.

FACTS you may use (nothing else, never invent stats or claims):
- ${name}, ${athlete.sport || 'college'} athlete at ${athlete.school || 'their school'}
${matchedTags.length ? `- Interests that match this brand: ${matchedTags.join(', ')}` : ''}
${productWants ? `- Products they already use: ${productWants}` : ''}
${mk.bio ? `- Bio excerpt: ${String(mk.bio).slice(0, 200)}` : ''}

Rules: plain, direct, human language. No em dashes. No exclamation marks. No invented numbers. Speak to why this athlete fits ${brand}'s space. Output ONLY the sentence, no quotes.`;
      opener = (await ai.oneShot(prompt, 'You write one plain, factual sentence. Output only the sentence. Never use em dashes. Never invent facts.', 120, ai.MODEL_FAST) || '').trim();
      opener = opener.replace(/^["']|["']$/g, '').replace(/—|–/g, ',').slice(0, 220);
    } catch (e) {
      console.warn('[media-kit variant] opener AI failed, using template:', e.message);
    }
    if (!opener) {
      // Template fallback: profile facts only, no fabrication
      opener = `${first} is a ${athlete.sport || 'college'} athlete at ${athlete.school || 'their school'} with an audience that lines up naturally with ${brand}.`;
    }

    const variant = {
      brand,
      category: category || null,
      opener,
      matchedTags,
      rateLead: variantRateLead(category, lane),
      createdAt: new Date().toISOString(),
    };
    await store.pool.query(
      `UPDATE media_kits
          SET variants = COALESCE(variants, '{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb)
        WHERE athlete_id = $3`,
      [brandSlug, JSON.stringify(variant), athleteId]
    );
    console.log(`[media-kit variant] created ${mk.slug}?for=${brandSlug} for agent=${req.session.userId}`);
    res.json({ ok: true, brandSlug, url, variant });
  } catch (e) {
    console.error('[media-kit variant]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Look up an existing brand variant URL for (athleteId, brand). Used to attach
// kit links to AI outreach emails automatically.
async function findKitVariantUrl(athleteId, brand) {
  try {
    if (!athleteId || !brand) return null;
    const mkR = await store.pool.query('SELECT slug, variants FROM media_kits WHERE athlete_id=$1', [athleteId]);
    const mk = mkR.rows[0];
    if (!mk || !mk.slug) return null;
    const brandSlug = String(brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const variants = (mk.variants && typeof mk.variants === 'object') ? mk.variants : {};
    if (!variants[brandSlug]) return null;
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    return `${appUrl}/media-kit/${mk.slug}?for=${brandSlug}`;
  } catch (e) { return null; }
}

// POST /api/agent/generate-bio/:athleteId — agent generates AI bio for an athlete
app.post('/api/agent/generate-bio/:athleteId', requireAuth, requireAgentSubscription, aiLimiter, async (req, res) => {
  try {
    const { athleteId } = req.params;
    const athR = await store.pool.query(
      `SELECT data FROM athletes WHERE id=$1 AND agent_id=$2`,
      [athleteId, req.session.userId]
    );
    if (!athR.rows.length) return res.status(404).json({ error: 'Athlete not found' });
    const d = athR.rows[0].data || {};
    const { story } = req.body;
    const storyPart = story ? `\nAthlete story: "${story}"` : '';
    const prompt = `Write a 2-sentence NIL media kit bio for ${d.name || 'this athlete'}, a ${d.year || 'college'} ${d.position || 'athlete'} at ${d.school || 'their university'} playing ${d.sport || 'their sport'}.${storyPart}\nInstagram: ${d.followers_ig || d.instagram || 0} followers. TikTok: ${d.followers_tt || d.tiktok || 0} followers. Engagement: ${d.engagement || 4}%.\nThe bio should be compelling for brand partnerships — authentic, achievement-focused, and 40-60 words. Return only the bio text, nothing else.`;
    const bio = await ai.oneShot(prompt, 'You are an NIL brand partnership specialist writing athlete bios.', 200, ai.MODEL_FAST);
    res.json({ bio: bio.trim() });
  } catch (e) {
    console.error('[agent/generate-bio]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Public route: /media-kit/:slug serves the standalone media kit page
app.get('/media-kit/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'media-kit.html'));
});

// ── Inquiry spam protection: 3 submissions per hour per session hash per kit.
// In-memory is fine for the single-instance deploy; restarts just reset the
// window. The honeypot check happens in the route below.
const _inquiryHits = new Map(); // key: hash|slug -> [timestamps]
function inquiryRateLimited(hash, slug) {
  const key = hash + '|' + slug;
  const now = Date.now();
  const hits = (_inquiryHits.get(key) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 3) { _inquiryHits.set(key, hits); return true; }
  hits.push(now);
  _inquiryHits.set(key, hits);
  if (_inquiryHits.size > 5000) { // prune oldest entries on the rare huge map
    for (const k of _inquiryHits.keys()) { _inquiryHits.delete(k); if (_inquiryHits.size <= 2500) break; }
  }
  return false;
}

// Budget dropdown value -> deal value midpoint
const INQUIRY_BUDGET_MIDPOINTS = {
  'Under $500': 250,
  '$500-1,000': 750,
  '$1,000-5,000': 3000,
  '$5,000+': 7500,
  'Not sure': 0,
};

// POST /api/media-kit/contact — brand inquiry from the public media kit
// (no auth). Creates an Inbound deal in the agent's Pipeline and emails the
// agent. Backward compatible with the old field names.
app.post('/api/media-kit/contact', async (req, res) => {
  try {
    const { slug, message, budget, website } = req.body;
    // New field names with old-name fallbacks so nothing in flight breaks
    const brandName    = (req.body.brand_name || req.body.sender_company || '').trim();
    const contactName  = (req.body.contact_name || req.body.sender_name || '').trim();
    const senderEmail  = (req.body.email || req.body.sender_email || '').trim();
    const interestText = (req.body.interest || message || '').trim();

    // Honeypot: bots fill the hidden "website" field. Pretend success, drop it.
    if (website && String(website).trim()) return res.json({ ok: true });

    if (!slug || !brandName || !senderEmail)
      return res.status(400).json({ error: 'Brand name and email are required' });

    // Rate limit: 3 submissions per hour per session hash per kit
    const hash = mkSessionHash(req);
    if (inquiryRateLimited(hash, slug)) {
      return res.status(429).json({ error: 'Too many submissions. Try again later.' });
    }

    // Look up the media kit + athlete + agent
    const mkR = await store.pool.query(
      `SELECT mk.*, a.agent_id FROM media_kits mk
        LEFT JOIN athletes a ON a.id = mk.athlete_id
       WHERE mk.slug = $1`, [slug]);
    if (!mkR.rows.length) return res.status(404).json({ error: 'Media kit not found' });
    const mk = mkR.rows[0];

    const athR = await store.pool.query(
      `SELECT a.data->>'name' as name, a.data->>'sport' as sport, a.email as email,
              u.email as agent_email, u.name as agent_name
       FROM athletes a LEFT JOIN users u ON a.agent_id = u.id
       WHERE a.id = $1`,
      [mk.athlete_id]
    );
    const ath = athR.rows[0] || {};
    const toEmail = ath.agent_email || ath.email || process.env.ADMIN_EMAIL || 'hello@mynildash.com';

    // ── Create the Inbound deal in the agent's Pipeline ──────────────────────
    if (mk.agent_id) {
      try {
        const budgetLabel = INQUIRY_BUDGET_MIDPOINTS.hasOwnProperty(budget) ? budget : 'Not sure';
        const noteLines = [
          'Inbound inquiry from the public media kit.',
          contactName ? `Contact: ${contactName}` : null,
          `Email: ${senderEmail}`,
          `Budget: ${budgetLabel}`,
          interestText ? `Interested in: ${interestText}` : null,
        ].filter(Boolean);
        const dealId = 'deal-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        await store.saveDeal(dealId, {
          id: dealId,
          athleteId: mk.athlete_id,
          agentId: mk.agent_id,
          brand: brandName,
          campaign: 'Media kit inquiry',
          stage: 'Inbound',
          value: INQUIRY_BUDGET_MIDPOINTS[budgetLabel] || 0,
          notes: noteLines.join('\n'),
          source: 'media_kit_inquiry',
          contactName: contactName || null,
          contactEmail: senderEmail,
          createdAt: new Date().toISOString(),
        });
        console.log(`[media-kit contact] Inbound deal created for agent=${mk.agent_id} brand=${brandName}`);
      } catch (dealErr) {
        console.error('[media-kit contact] deal create failed:', dealErr.message);
      }
    }

    // Keep old email variable names for the notification below
    const sender_name = contactName || brandName;
    const sender_company = brandName;
    const sender_email = senderEmail;
    const messageForEmail = [interestText || '(no details provided)', budget ? `Budget: ${budget}` : null].filter(Boolean).join('\n');

    const emailBody = `
<div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="background:#0A0E1A;padding:16px 24px;border-radius:8px 8px 0 0;margin-bottom:0">
    <span style="font-family:Bebas Neue,sans-serif;font-size:20px;letter-spacing:0.04em;color:#fff">NIL<span style="color:#84CC16">Dash</span></span>
    <span style="font-size:11px;font-weight:700;color:#84CC16;margin-left:10px;text-transform:uppercase;letter-spacing:0.08em">Media Kit Inquiry</span>
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:28px 24px">
    <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a">New brand inquiry for ${ath.name || 'your athlete'}</h2>
    <p style="color:#64748b;font-size:13px;margin:0 0 24px">Someone found their media kit on NILDash and wants to work together.</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr><td style="padding:8px 12px;background:#f8fafc;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;width:120px">From</td><td style="padding:8px 12px;background:#f8fafc;font-size:14px;color:#1e293b;font-weight:600">${sender_name}</td></tr>
      <tr><td style="padding:8px 12px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em">Company</td><td style="padding:8px 12px;font-size:14px;color:#1e293b">${sender_company || '(not provided)'}</td></tr>
      <tr><td style="padding:8px 12px;background:#f8fafc;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em">Email</td><td style="padding:8px 12px;background:#f8fafc;font-size:14px"><a href="mailto:${sender_email}" style="color:#2563eb">${sender_email}</a></td></tr>
    </table>
    <div style="background:#f1f5f9;border-left:4px solid #84CC16;padding:14px 18px;border-radius:4px;margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Message</div>
      <p style="margin:0;font-size:14px;color:#334155;line-height:1.6">${messageForEmail.replace(/\n/g,'<br>')}</p>
    </div>
    <a href="mailto:${sender_email}?subject=Re: NIL Partnership — ${ath.name || ''}&body=Hi ${sender_name}," style="display:inline-block;background:#84CC16;color:#0A0E1A;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none">Reply to ${sender_name}</a>
  </div>
  <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">Powered by <a href="https://mynildash.com" style="color:#84CC16">NILDash</a></p>
</div>`;

    await resend.emails.send({
      from: 'NILDash <noreply@mynildash.com>',
      to: [toEmail],
      reply_to: sender_email,
      subject: `Brand inquiry for ${ath.name || 'your athlete'} — ${sender_company || sender_name}`,
      html: emailBody,
    });

    console.log(`[media-kit contact] slug=${slug} from=${sender_email} to=${toEmail}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[media-kit contact]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /Media Kit Routes ─────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// HOME DATA ROUTES
// ══════════════════════════════════════════════════════════════════════════

// GET /api/agent/home-data — Agent-wide stats + week deliverables for Home page
app.get('/api/agent/home-data', requireAuth, async (req, res) => {
  try {
    const agentId = req.session.userId;
    const [pipelineR, clientsR, nilR, weekDelivsR] = await Promise.all([
      // Pipeline value + active deal count
      store.pool.query(
        `SELECT COUNT(*) AS deal_count,
                COALESCE(SUM(NULLIF(data->>'value','')::numeric), 0) AS total_value
         FROM deals
         WHERE agent_id = $1
           AND data->>'stage' NOT IN ('Closed','Lost')`,
        [agentId]
      ),
      // Client count
      store.pool.query(
        `SELECT COUNT(*) AS count FROM athletes WHERE agent_id = $1`,
        [agentId]
      ),
      // Total NIL earned (closed deals)
      store.pool.query(
        `SELECT COALESCE(SUM(NULLIF(data->>'value','')::numeric), 0) AS total
         FROM deals
         WHERE agent_id = $1
           AND data->>'stage' = 'Closed'`,
        [agentId]
      ),
      // Deliverables this week (Mon–Sun)
      store.pool.query(
        `SELECT ace.id, ace.title, ace.brand, ace.event_date::text, ace.status,
                a.data->>'name' AS athlete_name
         FROM athlete_calendar_events ace
         JOIN athletes a ON ace.athlete_id = a.id
         WHERE ace.agent_id = $1
           AND ace.event_date >= DATE_TRUNC('week', CURRENT_DATE)
           AND ace.event_date <  DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
         ORDER BY ace.event_date ASC
         LIMIT 20`,
        [agentId]
      ),
    ]);

    const dealCount   = parseInt(pipelineR.rows[0]?.deal_count   || 0);
    const pipelineVal = parseFloat(pipelineR.rows[0]?.total_value || 0);
    const clientCount = parseInt(clientsR.rows[0]?.count         || 0);
    const nilEarned   = parseFloat(nilR.rows[0]?.total           || 0);

    const fmt = v => v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'K' : '$' + Math.round(v);

    res.json({
      pipeline:         fmt(pipelineVal),
      dealCount,
      clientCount,
      nilEarned:        fmt(nilEarned),
      weekDeliverables: weekDelivsR.rows,
    });
  } catch (e) {
    console.error('[agent/home-data]', e.message);
    res.json({ pipeline: '$0', dealCount: 0, clientCount: 0, nilEarned: '$0', weekDeliverables: [] });
  }
});

// GET /api/athlete/home-data — Athlete stats + deliverables + deals for Home page
app.get('/api/athlete/home-data', verifyAthleteToken, async (req, res) => {
  try {
    const athleteId = req.athlete.id;
    const [statsR, nilR, dealsR, agentR, weekDelivsR] = await Promise.all([
      // Deliverable counts + upcoming list
      store.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_date < CURRENT_DATE AND status != 'completed') AS overdue,
           COUNT(*) FILTER (WHERE event_date >= CURRENT_DATE
                              AND event_date <= CURRENT_DATE + INTERVAL '30 days'
                              AND status != 'completed') AS upcoming,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COALESCE(
             JSON_AGG(
               JSON_BUILD_OBJECT(
                 'title', title, 'brand', brand,
                 'event_date', event_date::text, 'status', status
               ) ORDER BY event_date ASC
             ) FILTER (WHERE event_date >= CURRENT_DATE AND status != 'completed'),
             '[]'::json
           ) AS upcoming_list
         FROM athlete_calendar_events
         WHERE athlete_id = $1`,
        [athleteId]
      ),
      // Total NIL value
      store.pool.query(
        `SELECT COALESCE(SUM(value), 0) AS total FROM athlete_self_deals WHERE athlete_id = $1`,
        [athleteId]
      ),
      // Active deals
      store.pool.query(
        `SELECT brand_name, deal_type, value, stage
         FROM athlete_self_deals
         WHERE athlete_id = $1
           AND stage NOT IN ('Completed','Lost')
         ORDER BY updated_at DESC LIMIT 8`,
        [athleteId]
      ),
      // Agent name
      store.pool.query(
        `SELECT u.name AS agent_name
         FROM athletes a
         JOIN users u ON a.agent_id = u.id
         WHERE a.id = $1`,
        [athleteId]
      ),
      // All deliverables for current week (Mon–Sun) — for mini calendar
      store.pool.query(
        `SELECT id, title, brand, event_date::text, status
         FROM athlete_calendar_events
         WHERE athlete_id = $1
           AND event_date >= DATE_TRUNC('week', CURRENT_DATE)
           AND event_date <  DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
         ORDER BY event_date ASC
         LIMIT 30`,
        [athleteId]
      ),
    ]);

    const stats    = statsR.rows[0] || {};
    const nilTotal = parseFloat(nilR.rows[0]?.total || 0);
    const fmt      = v => v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'K' : '$' + Math.round(v);

    res.json({
      overdueCount:     parseInt(stats.overdue   || 0),
      upcomingCount:    parseInt(stats.upcoming  || 0),
      completedCount:   parseInt(stats.completed || 0),
      nilValue:         fmt(nilTotal),
      upcomingDelivs:   (stats.upcoming_list || []).slice(0, 5),
      activeDeals:      dealsR.rows,
      agentName:        agentR.rows[0]?.agent_name || null,
      weekDeliverables: weekDelivsR.rows,
    });
  } catch (e) {
    console.error('[athlete/home-data]', e.message);
    res.json({ overdueCount: 0, upcomingCount: 0, completedCount: 0, nilValue: '$0', upcomingDelivs: [], activeDeals: [], agentName: null, weekDeliverables: [] });
  }
});

// DAILY BRIEF ROUTES
// ══════════════════════════════════════════════════════════════════════════

// POST /api/agent/daily-brief — AI-generated morning brief for agents
app.post('/api/agent/daily-brief', requireAuth, aiLimiter, async (req, res) => {
  try {
    const agentId = req.session.userId;

    // ── Fetch all data in parallel ────────────────────────────────────────
    const [
      todayDelivR, overdueR, msgsR, staleDealsR,
      weekDelivR, closingDealsR, pipelineR, clientsR, agentUser
    ] = await Promise.all([
      // 1. Deliverables due today
      store.pool.query(
        `SELECT ace.title, ace.brand, a.data->>'name' AS athlete_name
         FROM athlete_calendar_events ace
         JOIN athletes a ON ace.athlete_id = a.id
         WHERE ace.agent_id = $1
           AND ace.event_date = CURRENT_DATE
           AND ace.status != 'completed'
         ORDER BY ace.event_date ASC LIMIT 10`,
        [agentId]
      ),
      // 2. Overdue deliverables
      store.pool.query(
        `SELECT ace.title, ace.brand, ace.event_date, a.data->>'name' AS athlete_name
         FROM athlete_calendar_events ace
         JOIN athletes a ON ace.athlete_id = a.id
         WHERE ace.agent_id = $1
           AND ace.event_date < CURRENT_DATE
           AND ace.status != 'completed'
         ORDER BY ace.event_date ASC LIMIT 8`,
        [agentId]
      ),
      // 3. Athlete messages received today
      store.pool.query(
        `SELECT DISTINCT athlete_name FROM athlete_messages
         WHERE agent_id = $1
           AND DATE(sent_at) = CURRENT_DATE`,
        [agentId]
      ),
      // 4. Deals stuck in active stage 7+ days
      store.pool.query(
        `SELECT data->>'brand' AS brand, data->>'stage' AS stage, updated_at
         FROM deals
         WHERE agent_id = $1
           AND data->>'stage' IN ('Prospecting','Outreach','Negotiating','Sent')
           AND updated_at < NOW() - INTERVAL '7 days'
         ORDER BY updated_at ASC LIMIT 6`,
        [agentId]
      ),
      // 5. Deliverables due this week — Mon–Sun window, matching the Home
      //    "Deliverables This Week" panel (/api/agent/home-data). Previously this
      //    used a forward-only CURRENT_DATE..+7d window, which dropped items earlier
      //    this week and made the brief say "none" while the panel listed several.
      store.pool.query(
        `SELECT COUNT(*) AS count,
                ARRAY(SELECT DISTINCT a2.data->>'name'
                      FROM athlete_calendar_events ace2
                      JOIN athletes a2 ON ace2.athlete_id = a2.id
                      WHERE ace2.agent_id = $1
                        AND ace2.event_date >= DATE_TRUNC('week', CURRENT_DATE)
                        AND ace2.event_date <  DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
                        AND ace2.status != 'completed'
                      LIMIT 5) AS athlete_names
         FROM athlete_calendar_events ace
         JOIN athletes a ON ace.athlete_id = a.id
         WHERE ace.agent_id = $1
           AND ace.event_date >= DATE_TRUNC('week', CURRENT_DATE)
           AND ace.event_date <  DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
           AND ace.status != 'completed'`,
        [agentId]
      ),
      // 6. Deals in Closing stage
      store.pool.query(
        `SELECT data->>'brand' AS brand
         FROM deals
         WHERE agent_id = $1
           AND data->>'stage' = 'Closing'`,
        [agentId]
      ),
      // 7. Pipeline totals
      store.pool.query(
        `SELECT COUNT(*) AS deal_count,
                COALESCE(SUM(NULLIF(data->>'value','')::numeric), 0) AS total_value
         FROM deals
         WHERE agent_id = $1
           AND data->>'stage' NOT IN ('Closed','Lost')`,
        [agentId]
      ),
      // 8. Client count
      store.pool.query(
        `SELECT COUNT(*) AS count FROM athletes WHERE agent_id = $1`,
        [agentId]
      ),
      // 9. Agent user record
      store.getUser(agentId),
    ]);

    const firstName   = ((agentUser && agentUser.name) || 'there').split(' ')[0];
    const clientCount = parseInt(clientsR.rows[0]?.count || 0);
    const pipelineVal = parseFloat(pipelineR.rows[0]?.total_value || 0);
    const activeDealCt = parseInt(pipelineR.rows[0]?.deal_count || 0);

    const todayDelivs   = todayDelivR.rows;
    const overdueDelivs = overdueR.rows;
    const todayMsgs     = msgsR.rows;
    const staleDeals    = staleDealsR.rows;
    const weekDelivCt   = parseInt(weekDelivR.rows[0]?.count || 0);
    const weekAthletes  = (weekDelivR.rows[0]?.athlete_names || []).filter(Boolean);
    const closingDeals  = closingDealsR.rows;

    // ── Build context strings ─────────────────────────────────────────────
    const todayDelivsStr = todayDelivs.length
      ? todayDelivs.map(d => `${d.athlete_name}: ${d.title}${d.brand ? ' for ' + d.brand : ''}`).join('; ')
      : 'none';
    const overdueStr = overdueDelivs.length
      ? overdueDelivs.slice(0, 5).map(d => `${d.athlete_name}: ${d.title}${d.brand ? ' ('+d.brand+')' : ''}`).join('; ')
      : 'none';
    const msgsStr = todayMsgs.length
      ? `${todayMsgs.length} new message${todayMsgs.length > 1 ? 's' : ''} from ${todayMsgs.slice(0,3).map(m => m.athlete_name).join(', ')}`
      : 'none';
    const staleStr = staleDeals.length
      ? staleDeals.map(d => `${d.brand || 'unnamed deal'} (${d.stage})`).join(', ')
      : 'none';
    const weekDelivStr = weekDelivCt > 0
      ? `${weekDelivCt} deliverable${weekDelivCt !== 1 ? 's' : ''} for ${weekAthletes.slice(0,4).join(', ')}`
      : 'none';
    const closingStr = closingDeals.length
      ? closingDeals.map(d => d.brand || 'unnamed').join(', ')
      : 'none';
    const pipelineStr = pipelineVal > 0 ? '$' + (pipelineVal / 1000).toFixed(0) + 'K' : '$0';

    const prompt = `Write exactly 4 one-sentence status bullets for sports agent ${firstName}'s morning brief. Each sentence must be under 15 words. Return ONLY 4 lines — no dashes, no numbers, no labels, no extra text.

Line 1 (urgent/overdue — be specific): Overdue deliverables today: ${overdueStr}
Line 2 (deals needing action — name the brands): Stale deals (7+ days no update): ${staleStr}
Line 3 (upcoming deliverables — be specific): Deliverables this week: ${weekDelivStr}. Closing soon: ${closingStr}
Line 4 (big picture — pipeline and messages): Pipeline: ${pipelineStr} across ${activeDealCt} active deal${activeDealCt !== 1 ? 's' : ''}. Messages today: ${msgsStr}

Return only 4 plain sentences, one per line, nothing else.`;

    const system = "You are a concise morning brief assistant for a sports agent. Write 4 short, specific status updates — exactly one per line. Each sentence must be under 15 words. Be direct and specific with names and numbers. No filler, no formatting, no labels. Return only 4 lines.";

    const rawBrief = await ai.oneShot(prompt, system, 200, ai.MODEL_FAST);
    const bullets = (rawBrief || '').trim()
      .split('\n')
      .map(b => b.replace(/^[-–•*\d.)\]]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4);
    const fallbacks = [
      'No overdue deliverables — you\'re caught up.',
      'All active deals are moving — no stale activity.',
      `${weekDelivCt} deliverable${weekDelivCt !== 1 ? 's' : ''} due this week.`,
      `${activeDealCt} active deal${activeDealCt !== 1 ? 's' : ''} totaling ${pipelineStr} in pipeline.`,
    ];
    while (bullets.length < 4) bullets.push(fallbacks[bullets.length]);
    res.json({ bullets, generatedAt: new Date().toISOString() });

  } catch (e) {
    console.error('[agent/daily-brief]', e.message);
    res.json({
      bullets: [
        'No overdue deliverables — you\'re caught up.',
        'All active deals are moving — no stale activity.',
        'Check your calendar for upcoming deliverables this week.',
        'Welcome back — your NILDash dashboard is ready.',
      ],
      generatedAt: new Date().toISOString(),
    });
  }
});

// POST /api/athlete/daily-brief — AI-generated morning brief for athletes (JWT auth)
app.post('/api/athlete/daily-brief', verifyAthleteToken, aiLimiter, async (req, res) => {
  try {
    const athleteId = req.athlete.id;

    // ── Fetch athlete profile ─────────────────────────────────────────────
    const athR = await store.pool.query(
      `SELECT a.data->>'name' AS name, a.data->>'sport' AS sport,
              a.data->>'school' AS school, a.data->>'position' AS position
       FROM athletes a WHERE a.id = $1`,
      [athleteId]
    );
    const ath = athR.rows[0] || {};
    const firstName = (ath.name || 'Athlete').split(' ')[0];

    // ── Fetch all data in parallel ────────────────────────────────────────
    const [todayR, overdueR, dealsR, weekR, nilR, outreachR] = await Promise.all([
      // 1. Deliverables due today
      store.pool.query(
        `SELECT title, brand, event_date FROM athlete_calendar_events
         WHERE athlete_id = $1
           AND event_date = CURRENT_DATE
           AND status != 'completed'
         ORDER BY event_date ASC LIMIT 8`,
        [athleteId]
      ),
      // 2. Overdue deliverables
      store.pool.query(
        `SELECT title, brand, event_date FROM athlete_calendar_events
         WHERE athlete_id = $1
           AND event_date < CURRENT_DATE
           AND status != 'completed'
         ORDER BY event_date ASC LIMIT 5`,
        [athleteId]
      ),
      // 3. Active self-managed deals
      store.pool.query(
        `SELECT brand_name, deal_type, value, stage FROM athlete_self_deals
         WHERE athlete_id = $1
           AND stage NOT IN ('Completed','Lost')
         ORDER BY updated_at DESC LIMIT 6`,
        [athleteId]
      ),
      // 4. Deliverables due this week
      store.pool.query(
        `SELECT COUNT(*) AS count,
                ARRAY_AGG(DISTINCT brand) FILTER (WHERE brand IS NOT NULL) AS brands
         FROM athlete_calendar_events
         WHERE athlete_id = $1
           AND event_date >= CURRENT_DATE
           AND event_date <= CURRENT_DATE + INTERVAL '7 days'
           AND status != 'completed'`,
        [athleteId]
      ),
      // 5. Total NIL value from self-managed deals
      store.pool.query(
        `SELECT COALESCE(SUM(value), 0) AS total FROM athlete_self_deals
         WHERE athlete_id = $1`,
        [athleteId]
      ),
      // 6. Outreach sent this week
      store.pool.query(
        `SELECT COUNT(*) AS count FROM athlete_brand_outreach
         WHERE athlete_id = $1
           AND created_at >= NOW() - INTERVAL '7 days'`,
        [athleteId]
      ),
    ]);

    const todayDelivs   = todayR.rows;
    const overdueDelivs = overdueR.rows;
    const activeDeals   = dealsR.rows;
    const weekDelivCt   = parseInt(weekR.rows[0]?.count || 0);
    const weekBrands    = (weekR.rows[0]?.brands || []).filter(Boolean);
    const totalNIL      = parseFloat(nilR.rows[0]?.total || 0);
    const outreachCt    = parseInt(outreachR.rows[0]?.count || 0);

    // ── Build context strings ─────────────────────────────────────────────
    const todayStr = todayDelivs.length
      ? todayDelivs.map(d => `${d.title}${d.brand ? ' for ' + d.brand : ''}`).join('; ')
      : 'nothing due today';
    const overdueStr = overdueDelivs.length
      ? overdueDelivs.map(d => `${d.title}${d.brand ? ' ('+d.brand+')' : ''}`).join('; ')
      : 'none';
    const dealsStr = activeDeals.length
      ? activeDeals.map(d => `${d.brand_name} (${d.stage}${d.value ? ', $'+Number(d.value).toLocaleString() : ''})`).join(', ')
      : 'none';
    const weekStr = weekDelivCt > 0
      ? `${weekDelivCt} deliverable${weekDelivCt !== 1 ? 's' : ''}${weekBrands.length ? ' for ' + weekBrands.slice(0,4).join(', ') : ''}`
      : 'none';
    const nilStr = totalNIL > 0
      ? '$' + (totalNIL >= 1000 ? (totalNIL / 1000).toFixed(0) + 'K' : totalNIL.toFixed(0))
      : '$0';
    const negotiatingDeals = activeDeals.filter(d => d.stage === 'Negotiating' || d.stage === 'Closing');

    const prompt = `Write exactly 4 one-sentence status bullets for ${firstName}'s morning NIL brief. Each sentence must be under 15 words. Return ONLY 4 lines — no dashes, no numbers, no labels, no extra text.

Line 1 (urgent/overdue — be specific, use brand names): Overdue deliverables: ${overdueStr}. Due today: ${todayStr}
Line 2 (deals needing attention — name the brands): Active deals: ${dealsStr}. Deals in negotiation: ${negotiatingDeals.length ? negotiatingDeals.map(d => d.brand_name).join(', ') : 'none'}
Line 3 (upcoming this week — be specific): Deliverables this week: ${weekStr}
Line 4 (big picture — NIL value and outreach): Total NIL tracked: ${nilStr}. Outreach sent this week: ${outreachCt}

Return only 4 plain sentences, one per line, nothing else.`;

    const system = "You are a concise morning brief assistant for a college athlete managing their NIL. Write 4 short, specific status updates — exactly one per line. Each sentence must be under 15 words. Be encouraging and specific with brand names. No filler, no formatting, no labels. Return only 4 lines.";

    const rawBrief = await ai.oneShot(prompt, system, 200, ai.MODEL_FAST);
    const bullets = (rawBrief || '').trim()
      .split('\n')
      .map(b => b.replace(/^[-–•*\d.)\]]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4);
    const fallbacks = [
      overdueDelivs.length ? `${overdueDelivs.length} overdue deliverable${overdueDelivs.length !== 1 ? 's' : ''} need your attention.` : 'No overdue deliverables — you\'re on track.',
      activeDeals.length ? `${activeDeals.length} active deal${activeDeals.length !== 1 ? 's' : ''} in progress.` : 'No active deals — time to start outreach.',
      weekDelivCt > 0 ? `${weekDelivCt} deliverable${weekDelivCt !== 1 ? 's' : ''} due this week.` : 'No deliverables due this week.',
      `Total NIL value tracked: ${nilStr}.`,
    ];
    while (bullets.length < 4) bullets.push(fallbacks[bullets.length]);
    res.json({ bullets, generatedAt: new Date().toISOString() });

  } catch (e) {
    console.error('[athlete/daily-brief]', e.message);
    res.json({
      bullets: [
        'No overdue deliverables — you\'re on track.',
        'Check your active deals and keep momentum going.',
        'Review your calendar for upcoming deliverables this week.',
        'Welcome back — your NIL dashboard is ready.',
      ],
      generatedAt: new Date().toISOString(),
    });
  }
});

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
    // Continue-on-error: a single failing migration must NEVER abort the loop
    // and block every later migration (this previously hid migrations 007-011
    // behind the is_dismissed index failure).
    for (const file of files) {
      try {
        const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
        await store.pool.query(sql);
        console.log(`[migrations] ✅ ${file}`);
      } catch (mErr) {
        console.warn(`[migrations] ⚠️  ${file} failed (non-fatal, continuing):`, mErr.message);
      }
    }
  } catch (err) {
    console.warn('[migrations] Migration run failed (non-fatal):', err.message);
  }

  // ── Growth Tab DB Tables ──────────────────────────────────────────
  try {
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS growth_prospects (
        id         SERIAL PRIMARY KEY,
        type       TEXT NOT NULL DEFAULT 'agent',
        name       TEXT NOT NULL,
        email      TEXT NOT NULL UNIQUE,
        website    TEXT,
        location   TEXT,
        notes      TEXT,
        status     TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS growth_sequences (
        id         SERIAL PRIMARY KEY,
        type       TEXT NOT NULL UNIQUE,
        name       TEXT,
        subject1   TEXT, body1 TEXT,
        subject2   TEXT, body2 TEXT,
        subject3   TEXT, body3 TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await store.pool.query(`
      CREATE TABLE IF NOT EXISTS growth_outreach_log (
        id            SERIAL PRIMARY KEY,
        prospect_id   INTEGER NOT NULL REFERENCES growth_prospects(id) ON DELETE CASCADE,
        sequence_step INTEGER NOT NULL DEFAULT 1,
        sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resend_id     TEXT,
        status        TEXT NOT NULL DEFAULT 'sent'
      )
    `);
    console.log('[growth] ✅ Growth DB tables ready');
  } catch (err) {
    console.warn('[growth] DB table creation failed (non-fatal):', err.message);
  }

  // ── Fix 2025 deliverable dates → 2026 (one-time data correction) ──
  // Amber Bretton and any other athlete whose dates were extracted with
  // wrong year (2025) due to stale AI prompt examples.  Safe to run
  // every boot — only rows with year=2025 are touched; subsequent boots
  // find no matching rows and update 0 rows.
  try {
    const delFix = await store.pool.query(
      `UPDATE athlete_deliverables
       SET due_date = due_date + INTERVAL '1 year'
       WHERE due_date IS NOT NULL
         AND EXTRACT(YEAR FROM due_date) = 2025`
    );
    const evtFix = await store.pool.query(
      `UPDATE athlete_calendar_events
       SET event_date = event_date + INTERVAL '1 year'
       WHERE event_date IS NOT NULL
         AND EXTRACT(YEAR FROM event_date) = 2025`
    );
    console.log(`[dateFix] ✅ Updated ${delFix.rowCount} deliverable(s) and ${evtFix.rowCount} calendar event(s) from 2025 → 2026`);
  } catch (err) {
    console.warn('[dateFix] Date fix failed (non-fatal):', err.message);
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

  // ── Data isolation check ──────────────────────────────────────────
  // University athletes now live in university_athletes — agent athletes table is isolated.
  try {
    const agentCheck = await store.pool.query(
      `SELECT COUNT(*) AS cnt FROM athletes WHERE data->>'university_id' IS NOT NULL AND data->>'university_id' != ''`
    );
    const leaked = parseInt(agentCheck.rows[0]?.cnt) || 0;
    if (leaked > 0) {
      console.warn(`[isolation] ⚠️  ${leaked} athletes with university_id still exist in the agent athletes table. Run migration 007 to clean them up.`);
    } else {
      console.log('[isolation] ✅ Agent-side athletes table is now isolated. University athletes live in university_athletes.');
      console.log('[isolation]    Agent roster is clean at /roster — please verify your athletes are intact.');
    }
  } catch (_) {}
});
