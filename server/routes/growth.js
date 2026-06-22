// ── Growth Tab Routes ─────────────────────────────────────────────────────────
// Admin-only. Automates B2B outreach to NIL agents and schools.
// All routes require admin role.

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const ai      = require('../ai');
const { Resend } = require('resend');
const resend  = new Resend(process.env.RESEND_API_KEY);

const GROWTH_MODEL = 'claude-opus-4-8';
const FROM_EMAIL   = 'jmcompton04@gmail.com'; // TODO: swap to hello@comptongroupllc.com when Outlook is configured
const DAILY_SEND_LIMIT = 30;

// ── Admin guard ───────────────────────────────────────────────────────────────
// Uses the same session shape as the rest of the app:
// req.session.userId (set by requireAuth) + req.session.role (set on login).
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

router.use(requireAdmin);

// ── GET /api/growth/prospects ─────────────────────────────────────────────────
router.get('/prospects', async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT * FROM growth_prospects ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[growth/prospects GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/growth/find-prospects ──────────────────────────────────────────
// Uses AI to generate a list of prospects (agents or schools).
router.post('/find-prospects', async (req, res) => {
  const { type } = req.body; // 'agent' | 'school'
  if (!type || !['agent', 'school'].includes(type)) {
    return res.status(400).json({ error: 'type must be agent or school' });
  }

  const systemPrompt = `You are a B2B sales researcher for NILDash, a software platform that helps NIL sports agents manage their athletes' deals, compliance, and marketing. You identify prospects who would benefit from using NILDash.`;

  const userPrompt = type === 'agent'
    ? `Generate a list of 15 NIL sports agents or agencies in the United States who represent college athletes. For each, provide realistic professional contact details. Return a JSON array with this exact structure — no markdown, no explanation, just the JSON:
[
  {
    "name": "Full Name or Agency Name",
    "email": "contact@example.com",
    "website": "https://example.com",
    "location": "City, State",
    "notes": "Brief note about why they'd be a good fit for NILDash"
  }
]`
    : `Generate a list of 15 US university athletic departments or NCAA schools that have active NIL programs. For each, provide realistic professional contact details for their NIL Coordinator or Athletic Director. Return a JSON array with this exact structure — no markdown, no explanation, just the JSON:
[
  {
    "name": "School Name - NIL Department",
    "email": "nil@school.edu",
    "website": "https://athletics.school.edu",
    "location": "City, State",
    "notes": "Brief note about their NIL program and why NILDash would help"
  }
]`;

  try {
    const raw = await ai.oneShot(userPrompt, systemPrompt, 2000, GROWTH_MODEL);
    let prospects = [];
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) prospects = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[growth/find-prospects] JSON parse error:', parseErr.message);
      return res.status(500).json({ error: 'AI returned unparseable JSON' });
    }

    // Insert into DB, skip duplicates by email
    let inserted = 0;
    for (const p of prospects) {
      if (!p.email || !p.name) continue;
      try {
        await store.pool.query(
          `INSERT INTO growth_prospects (type, name, email, website, location, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           ON CONFLICT (email) DO NOTHING`,
          [type, p.name || '', p.email || '', p.website || '', p.location || '', p.notes || '']
        );
        inserted++;
      } catch (rowErr) {
        console.warn('[growth/find-prospects] row insert error:', rowErr.message);
      }
    }

    const all = await store.pool.query(`SELECT * FROM growth_prospects WHERE type=$1 ORDER BY created_at DESC`, [type]);
    res.json({ inserted, prospects: all.rows });
  } catch (e) {
    console.error('[growth/find-prospects]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/growth/prospects/:id/status ────────────────────────────────────
router.patch('/prospects/:id/status', async (req, res) => {
  const { status } = req.body; // 'approved' | 'skip' | 'replied' | 'converted' | 'pending'
  const allowed = ['approved', 'skip', 'replied', 'converted', 'pending'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const r = await store.pool.query(
      `UPDATE growth_prospects SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Prospect not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/growth/prospects/:id ─────────────────────────────────────────
router.delete('/prospects/:id', async (req, res) => {
  try {
    await store.pool.query('DELETE FROM growth_prospects WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/growth/sequences ─────────────────────────────────────────────────
router.get('/sequences', async (req, res) => {
  try {
    const r = await store.pool.query(`SELECT * FROM growth_sequences ORDER BY type ASC`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/growth/sequences ────────────────────────────────────────────────
// Upsert a sequence by type
router.post('/sequences', async (req, res) => {
  const { type, subject1, body1, subject2, body2, subject3, body3, name } = req.body;
  if (!type || !['agent', 'school'].includes(type)) {
    return res.status(400).json({ error: 'type must be agent or school' });
  }
  try {
    const r = await store.pool.query(
      `INSERT INTO growth_sequences (type, name, subject1, body1, subject2, body2, subject3, body3)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (type) DO UPDATE SET
         name=$2, subject1=$3, body1=$4, subject2=$5, body2=$6, subject3=$7, body3=$8, updated_at=NOW()
       RETURNING *`,
      [type, name || (type === 'agent' ? 'Agent Sequence' : 'School Sequence'),
       subject1 || '', body1 || '', subject2 || '', body2 || '', subject3 || '', body3 || '']
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/growth/draft-sequence ──────────────────────────────────────────
// AI drafts a 3-email sequence for agents or schools
router.post('/draft-sequence', async (req, res) => {
  const { type } = req.body;
  if (!type || !['agent', 'school'].includes(type)) {
    return res.status(400).json({ error: 'type must be agent or school' });
  }

  const systemPrompt = `You are an expert B2B SaaS sales copywriter. You write concise, compelling cold email sequences. Emails should be short (under 150 words each), personal, and focused on value. No fluff. No "I hope this email finds you well."`;

  const userPrompt = type === 'agent'
    ? `Write a 3-email cold outreach sequence for NILDash targeting NIL sports agents. NILDash is a platform that helps agents manage their athletes' deals, compliance, social media scheduling, and brand contracts all in one place.

Email 1 = Initial outreach (problem/curiosity hook)
Email 2 = Follow-up (social proof / feature highlight, sent 3 days later)
Email 3 = Final follow-up (soft ask, sent 7 days later)

Return JSON only — no markdown, no explanation:
{
  "subject1": "...", "body1": "...",
  "subject2": "...", "body2": "...",
  "subject3": "...", "body3": "..."
}`
    : `Write a 3-email cold outreach sequence for NILDash targeting university athletic departments and NIL coordinators. NILDash helps schools track athlete NIL activity, ensure compliance, manage deal pipelines, and provide branded athlete portals.

Email 1 = Initial outreach (problem/curiosity hook)
Email 2 = Follow-up (compliance angle, sent 3 days later)
Email 3 = Final follow-up (soft demo ask, sent 7 days later)

Return JSON only — no markdown, no explanation:
{
  "subject1": "...", "body1": "...",
  "subject2": "...", "body2": "...",
  "subject3": "...", "body3": "..."
}`;

  try {
    const raw = await ai.oneShot(userPrompt, systemPrompt, 1500, GROWTH_MODEL);
    let seq = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) seq = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[growth/draft-sequence] parse error:', parseErr.message);
      return res.status(500).json({ error: 'AI returned unparseable JSON' });
    }
    res.json(seq);
  } catch (e) {
    console.error('[growth/draft-sequence]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/growth/generate-social-posts ───────────────────────────────────
// AI generates 10 X (Twitter) posts with visual attachment instructions
router.post('/generate-social-posts', async (req, res) => {
  const { topics } = req.body; // accepted but not used — all 10 angles are fixed

  const systemPrompt = `You are the head of marketing for NILDash. NILDash is an AI-powered NIL management platform built for college athletes who are still building their brand.

THE BRAND MANIFESTO (internalize this, do not quote it directly):
The NIL industry made billions last year. The average college athlete saw almost none of it. Not because they were not talented enough. Because nobody built the tools for them. The analysis, the valuations, the media kits — the things that tell you what you are worth — used to cost thousands. NILDash was built for the athlete who is still building. The one brands have not discovered yet. The one who does not know what they are worth yet. The one who just wants to get paid for their work. NILDash analyzes your deal before you sign so you know if it is fair. $25/month. Just you and your NIL.

THE CORE MESSAGE:
The NIL world is confusing and most athletes are leaving money on the table every single day — because they do not know what they are worth or have the right tools. NILDash makes it simple. It works for every athlete, whether you manage your own NIL or work with an agent.

THE ENEMY — READ THIS CAREFULLY:
The enemy in every post is ALWAYS one of these: leaving money on the table, not knowing your worth, not having the right tools, getting caught unprepared. The enemy is NEVER a person or a role. Do NOT cast agents (or anyone) as the villain. Never imply an agent took money, missed something, overcharged, or ripped the athlete off. NILDash is a partner to athletes AND to agents — keep every post brand-safe for both. Lead with empowerment: know exactly what you are worth, find your own deals, take control of your NIL, get tools that used to cost thousands.

TONE AND VOICE:
- Confident. Direct. On the athlete's side.
- Sounds like a friend who knows the game, not a company selling something
- Never corporate. Never buzzwords. Never salesy.
- Short staccato lines. Each line should hit differently.
- Make athletes feel like they are behind if they do not have NILDash
- FOMO + empowerment combined

FORMAT RULES — NON NEGOTIABLE:
- Maximum 4 lines per post
- Each line is SHORT — 5 to 10 words maximum per line
- No full paragraph sentences
- Last line is always the link: mynildash.com/athletes
- Maximum 3 hashtags, always on the final hashtag line after the link
- Never more than 240 characters total including hashtags and link

REALISTIC DOLLAR AMOUNTS:
When using dollar examples use realistic college athlete NIL deal amounts:
- Small deals: $200 - $800
- Mid deals: $1,000 - $3,000
- The gap between what athletes ask for and what they are actually worth: often $500 - $2,000 left on the table
- Cost of pro-grade valuation/media-kit tools historically: thousands
- NILDash cost: $25/month flat
Frame dollar examples around money the athlete leaves on the table or saves by knowing their worth — never around a fee someone charged them.

HASHTAG RULES:
Only use these hashtags — pick the 3 most relevant per post:
#NILDash #NILMoney #NILDeal #CollegeNIL #NILAthlete #NILSeason #KnowYourWorth #CFB #CBB #WBB
Never use: #CollegeAthlete #StudentAthlete #GetPaid #CollegeSports #NILDeals — these are weak and overused. Never use #BeYourOwnAgent or any anti-agent hashtag.

Generate exactly 10 posts. Use these 4 post types — mix them so no two consecutive posts are the same type:

TYPE 1 — THE MATH POST (2-3 posts):
Make the cost of NOT knowing your worth feel real using realistic numbers. The enemy is money left on the table, never a person.
Formula: Show what the athlete settled for → show what they were actually worth → show NILDash cost → punchline
Example style:
'You took the first $500 offer.
You were worth $1,500.
NILDash shows you before you sign.
$25/month.
mynildash.com/athletes
#NILDash #NILMoney #KnowYourWorth'

TYPE 2 — THE PRODUCT DEMO POST (3 posts):
Show NILDash doing something impressive. Reference a specific feature. Make it feel like a reveal.
Features to reference: Deal Scan (analyzes NIL deals for fairness), Media Kit Builder (builds professional branded media kit in 60 seconds), Rate Calculator (tells athletes exactly what they are worth based on their sport and social following), Gmail Integration (send professional NIL outreach from your own Gmail)
Example style:
'Brands want a media kit.
You do not have one.
NILDash builds it in 60 seconds.
mynildash.com/athletes
#NILDash #NILSeason #CollegeNIL'

TYPE 3 — THE SOCIAL PROOF POST (2 posts):
Make athletes feel like the successful ones already use NILDash. Aspirational. FOMO heavy.
Example style:
'Athletes closing brand deals in 2026:
Know their rate before they negotiate.
Have a media kit ready to send.
mynildash.com/athletes
#NILDash #NILMoney #NILAthlete'

TYPE 4 — THE DIRECT CHALLENGE POST (3 posts):
Provocative. Challenge the athlete directly. Make them feel behind because they do not know their worth or do not have the tools yet — never because of someone else's actions.
Example style:
'Do you actually know what your NIL is worth?
Most athletes are guessing.
NILDash gives you the number.
mynildash.com/athletes
#NILDash #NILDeal #KnowYourWorth'

For each post also specify a VISUAL instruction. Be extremely specific about what to screenshot in NILDash:
- Deal Scan posts: 'Screenshot: Open Deal Scan, upload any PDF, show the AI analysis verdict screen with the fairness rating visible'
- Media Kit posts: 'Screenshot: Open Media Kit Builder, show a completed athlete media kit preview with photo, stats, and rate card visible'
- Rate Calculator posts: 'Screenshot: Open Rate Calculator, enter follower counts, show the calculated NIL value result'
- Gmail posts: 'Screenshot: Open Gmail Integration tab, show the connected Gmail outreach composer with a draft email visible'
- Math/value posts: 'Graphic: Create a simple dark background graphic with the dollar amounts from the post in large white and green text'
- Social proof posts: 'Screenshot: Open NILDash home dashboard showing all tools in the sidebar and the AI ready indicator'
- Challenge posts: 'Screenshot: Open Deal Scan showing the AI analyzing a deal with a clear verdict'

Return ONLY a valid JSON array of exactly 10 objects. Each object has exactly two string fields: post and visual. No markdown. No backticks. No numbering. No explanation. Pure JSON only starting with [ and ending with ]`;

  const userPrompt = 'Generate the 10 posts now.';

  try {
    const raw = await ai.oneShot(userPrompt, systemPrompt, 3500, GROWTH_MODEL);
    let posts = [];
    try {
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      if (arrMatch) posts = JSON.parse(arrMatch[0]);
    } catch (parseErr) {
      console.error('[growth/generate-social-posts] parse error:', parseErr.message, 'raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'AI returned unparseable JSON' });
    }
    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(500).json({ error: 'AI returned no posts' });
    }
    // Normalise: ensure each item has {post, visual} strings
    posts = posts.map(function(p) {
      if (typeof p === 'string') return { post: p, visual: '' };
      return { post: String(p.post || ''), visual: String(p.visual || '') };
    });
    res.json({ posts });
  } catch (e) {
    console.error('[growth/generate-social-posts]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/growth/outreach-log ──────────────────────────────────────────────
router.get('/outreach-log', async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT l.*, p.name AS prospect_name, p.email AS prospect_email, p.type AS prospect_type, p.status AS prospect_status
       FROM growth_outreach_log l
       JOIN growth_prospects p ON p.id = l.prospect_id
       ORDER BY l.sent_at DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/growth/send-daily ───────────────────────────────────────────────
// Sends today's batch of emails (up to 30 approved prospects not yet emailed today)
router.post('/send-daily', async (req, res) => {
  try {
    // Get approved prospects not emailed in the last 7 days
    const prospectsR = await store.pool.query(
      `SELECT p.* FROM growth_prospects p
       WHERE p.status = 'approved'
         AND p.id NOT IN (
           SELECT DISTINCT prospect_id FROM growth_outreach_log
           WHERE sent_at > NOW() - INTERVAL '7 days'
         )
       LIMIT $1`,
      [DAILY_SEND_LIMIT]
    );

    const prospects = prospectsR.rows;
    if (!prospects.length) {
      return res.json({ sent: 0, message: 'No approved prospects ready to email' });
    }

    // Load sequences
    const seqR = await store.pool.query(`SELECT * FROM growth_sequences`);
    const seqMap = {};
    for (const s of seqR.rows) seqMap[s.type] = s;

    let sent = 0;
    const errors = [];

    for (const prospect of prospects) {
      const seq = seqMap[prospect.type];
      if (!seq || !seq.subject1 || !seq.body1) {
        errors.push({ email: prospect.email, error: `No sequence configured for type: ${prospect.type}` });
        continue;
      }

      // Determine which step to send
      const logR = await store.pool.query(
        `SELECT sequence_step FROM growth_outreach_log WHERE prospect_id=$1 ORDER BY sent_at ASC`,
        [prospect.id]
      );
      const sentSteps = logR.rows.map(r => r.sequence_step);
      let step = 1;
      if (sentSteps.includes(1)) step = 2;
      if (sentSteps.includes(2)) step = 3;
      if (sentSteps.includes(3)) continue; // all steps sent

      const subject = seq[`subject${step}`];
      const body    = seq[`body${step}`];

      if (!subject || !body) {
        errors.push({ email: prospect.email, error: `No email content for step ${step}` });
        continue;
      }

      try {
        const sendResult = await resend.emails.send({
          from: `NILDash Growth <${FROM_EMAIL}>`,
          to:   prospect.email,
          subject,
          text: body,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6;color:#1a1a2e">${body.replace(/\n/g, '<br>')}<br><br><hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"><p style="font-size:11px;color:#6b7280">NILDash · The All-in-One NIL Management Platform · <a href="https://mynildash.com" style="color:#84CC16">mynildash.com</a></p></div>`
        });

        await store.pool.query(
          `INSERT INTO growth_outreach_log (prospect_id, sequence_step, resend_id)
           VALUES ($1, $2, $3)`,
          [prospect.id, step, sendResult?.data?.id || null]
        );
        sent++;
      } catch (sendErr) {
        console.error('[growth/send-daily] send error for', prospect.email, sendErr.message);
        errors.push({ email: prospect.email, error: sendErr.message });
      }
    }

    res.json({ sent, total_prospects: prospects.length, errors: errors.length ? errors : undefined });
  } catch (e) {
    console.error('[growth/send-daily]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/growth/badge ─────────────────────────────────────────────────────
// Returns count of prospects with status='replied' (for notification badge)
router.get('/badge', async (req, res) => {
  try {
    const r = await store.pool.query(
      `SELECT COUNT(*) AS cnt FROM growth_prospects WHERE status = 'replied'`
    );
    res.json({ replied: parseInt(r.rows[0].cnt) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
