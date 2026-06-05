// ── Growth Tab Routes ─────────────────────────────────────────────────────────
// Admin-only. Automates B2B outreach to NIL agents and schools.
// All routes require admin role.

const express = require('express');
const router  = express.Router();
const store   = require('../store');
const ai      = require('../ai');
const { Resend } = require('resend');
const resend  = new Resend(process.env.RESEND_API_KEY);

const GROWTH_MODEL = 'claude-opus-4-5';
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
