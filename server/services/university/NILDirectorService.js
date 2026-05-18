// server/services/university/NILDirectorService.js
// Core service layer for the University NIL Director Dashboard.
//
// DESIGN:
//   All data sourced from CRM first. No external API calls except for the
//   AI Opportunity Engine (which uses real CRM context as its input).
//
//   Reads:  athletes (scoped by university_id), university_deal_pipeline,
//           athlete_contact_log, university_daily_actions, deals (read-only view
//           of agent-created deals linked to university athletes)
//   Writes: university_deal_pipeline, athlete_contact_log, university_daily_actions
//
// FORBIDDEN: Do NOT write to athletes, deals, outreach_logs, brand_contacts,
//            brand_match_scores, or any agent CRM table.

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getClient }  = require('../../ai');

// ── Constants ─────────────────────────────────────────────────────────────
const EXPIRING_DAYS      = 30;  // deals ending within N days = "expiring"
const IDLE_DAYS          = 45;  // athletes not contacted in N days = idle
const INACTIVE_DEAL_DAYS = 60;  // athletes with no deal activity in N days

// ── Helpers ───────────────────────────────────────────────────────────────
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── 1. Dashboard Overview Metrics ─────────────────────────────────────────
async function getDashboardMetrics(pool, universityId) {
  try {
    // Athletes
    const athleteRow = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE (data->>'instagram')::int > 0 OR (data->>'tiktok')::int > 0) AS with_social
       FROM athletes WHERE data->>'university_id' = $1`,
      [universityId]
    );

    // Deal pipeline
    const dealRow = await pool.query(
      `SELECT
         COUNT(*)                                          AS total_deals,
         COUNT(*) FILTER (WHERE status = 'active')         AS active_deals,
         COUNT(*) FILTER (WHERE status = 'pending')        AS pending_deals,
         COUNT(*) FILTER (WHERE status = 'expiring')       AS expiring_deals,
         COUNT(*) FILTER (WHERE status = 'completed')      AS completed_deals,
         COALESCE(SUM(deal_value) FILTER (WHERE status IN ('active','completed')), 0) AS total_value,
         COALESCE(SUM(deal_value) FILTER (WHERE status = 'active'), 0)                AS active_value,
         COUNT(*) FILTER (WHERE disclosure_status = 'pending') AS disclosure_pending,
         COUNT(*) FILTER (WHERE disclosure_status = 'missing') AS disclosure_missing,
         COUNT(*) FILTER (WHERE end_date <= $2)            AS expiring_soon
       FROM university_deal_pipeline
       WHERE university_id = $1`,
      [universityId, daysFromNow(EXPIRING_DAYS)]
    );

    // Monthly deal activity (last 6 months)
    const monthlyRow = await pool.query(
      `SELECT DATE_TRUNC('month', created_at) AS month,
              COUNT(*) AS new_deals,
              COALESCE(SUM(deal_value), 0) AS monthly_value
       FROM university_deal_pipeline
       WHERE university_id = $1
         AND created_at >= NOW() - INTERVAL '6 months'
       GROUP BY 1 ORDER BY 1`,
      [universityId]
    );

    // Top earners (athletes with highest total active deal value)
    const topEarnersRow = await pool.query(
      `SELECT a.id AS athlete_id,
              a.data->>'name' AS name,
              a.data->>'sport' AS sport,
              a.data->>'position' AS position,
              COUNT(d.id) AS deal_count,
              COALESCE(SUM(d.deal_value), 0) AS total_value
       FROM athletes a
       JOIN university_deal_pipeline d ON d.athlete_id = a.id
         AND d.university_id = $1
         AND d.status IN ('active', 'completed')
       WHERE a.data->>'university_id' = $1
       GROUP BY a.id, a.data->>'name', a.data->>'sport', a.data->>'position'
       ORDER BY total_value DESC
       LIMIT 5`,
      [universityId]
    );

    // Under-monetized: athletes with high social reach but zero or few deals
    const underMonRow = await pool.query(
      `SELECT a.id AS athlete_id,
              a.data->>'name' AS name,
              a.data->>'sport' AS sport,
              COALESCE((a.data->>'instagram')::int, 0) + COALESCE((a.data->>'tiktok')::int, 0) AS reach,
              COALESCE((a.data->>'engagement')::numeric, 0) AS engagement,
              COUNT(d.id) AS deal_count
       FROM athletes a
       LEFT JOIN university_deal_pipeline d ON d.athlete_id = a.id
         AND d.university_id = $1 AND d.status = 'active'
       WHERE a.data->>'university_id' = $1
       GROUP BY a.id, a.data
       HAVING (COALESCE((a.data->>'instagram')::int, 0) + COALESCE((a.data->>'tiktok')::int, 0)) > 2000
          AND COUNT(d.id) = 0
       ORDER BY reach DESC
       LIMIT 5`,
      [universityId]
    );

    // Athletes by sport breakdown
    const sportBreakdown = await pool.query(
      `SELECT data->>'sport' AS sport, COUNT(*) AS count
       FROM athletes WHERE data->>'university_id' = $1
         AND data->>'sport' IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC`,
      [universityId]
    );

    const m = dealRow.rows[0] || {};
    const a = athleteRow.rows[0] || {};

    return {
      athletes: {
        total:      parseInt(a.total) || 0,
        withSocial: parseInt(a.with_social) || 0,
      },
      deals: {
        total:             parseInt(m.total_deals) || 0,
        active:            parseInt(m.active_deals) || 0,
        pending:           parseInt(m.pending_deals) || 0,
        expiring:          parseInt(m.expiring_deals) || 0,
        completed:         parseInt(m.completed_deals) || 0,
        totalValue:        parseInt(m.total_value) || 0,
        activeValue:       parseInt(m.active_value) || 0,
        disclosurePending: parseInt(m.disclosure_pending) || 0,
        disclosureMissing: parseInt(m.disclosure_missing) || 0,
        expiringSoon:      parseInt(m.expiring_soon) || 0,
      },
      monthlyActivity: monthlyRow.rows.map(r => ({
        month:        r.month,
        newDeals:     parseInt(r.new_deals),
        monthlyValue: parseInt(r.monthly_value),
      })),
      topEarners:    topEarnersRow.rows,
      underMonetized: underMonRow.rows,
      sportBreakdown: sportBreakdown.rows,
    };
  } catch (err) {
    console.error('[NILDirector] getDashboardMetrics error:', err.message);
    return { athletes: {}, deals: {}, monthlyActivity: [], topEarners: [], underMonetized: [], sportBreakdown: [] };
  }
}

// ── 2. Athlete CRM ─────────────────────────────────────────────────────────
// Returns athletes enriched with deal data, contact status, and risk flags.
async function getAthleteCRM(pool, universityId, { search = '', sport = '', status = '' } = {}) {
  try {
    // Build WHERE clauses
    const conditions = [`a.data->>'university_id' = $1`];
    const params     = [universityId];
    let   idx        = 2;

    if (search) {
      conditions.push(`(a.data->>'name' ILIKE $${idx} OR a.data->>'sport' ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (sport) {
      conditions.push(`a.data->>'sport' ILIKE $${idx}`);
      params.push(`%${sport}%`);
      idx++;
    }

    const athletes = await pool.query(
      `SELECT a.id, a.data, a.created_at, a.updated_at, a.last_updated_at,
              -- Deal summary
              COALESCE(d.deal_count, 0)  AS deal_count,
              COALESCE(d.active_deals, 0) AS active_deals,
              COALESCE(d.total_value, 0)  AS total_nil_value,
              d.latest_deal_brand,
              d.latest_deal_status,
              -- Last contact
              cl.last_contact_at,
              cl.last_contact_type,
              cl.note_count
       FROM athletes a
       LEFT JOIN (
         SELECT athlete_id,
                COUNT(*) AS deal_count,
                COUNT(*) FILTER (WHERE status = 'active') AS active_deals,
                SUM(deal_value) AS total_value,
                MAX(brand) FILTER (WHERE updated_at = (SELECT MAX(updated_at) FROM university_deal_pipeline d2 WHERE d2.athlete_id = university_deal_pipeline.athlete_id)) AS latest_deal_brand,
                MAX(status) FILTER (WHERE updated_at = (SELECT MAX(updated_at) FROM university_deal_pipeline d2 WHERE d2.athlete_id = university_deal_pipeline.athlete_id)) AS latest_deal_status
         FROM university_deal_pipeline
         WHERE university_id = $1
         GROUP BY athlete_id
       ) d ON d.athlete_id = a.id
       LEFT JOIN (
         SELECT athlete_id,
                MAX(created_at) AS last_contact_at,
                MAX(contact_type) FILTER (WHERE created_at = (SELECT MAX(created_at) FROM athlete_contact_log cl2 WHERE cl2.athlete_id = athlete_contact_log.athlete_id)) AS last_contact_type,
                COUNT(*) AS note_count
         FROM athlete_contact_log
         WHERE university_id = $1
         GROUP BY athlete_id
       ) cl ON cl.athlete_id = a.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.data->>'name' ASC`,
      params
    );

    // Enrich each athlete with risk flags and NIL status
    return athletes.rows.map(row => {
      const d    = row.data || {};
      const reach = (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0);
      const flags = [];

      // Risk flags
      if (!d.instagram && !d.tiktok)        flags.push({ type: 'warning', msg: 'No social accounts' });
      if (!d.sport)                          flags.push({ type: 'error',   msg: 'Missing sport' });
      if (!d.position)                       flags.push({ type: 'info',    msg: 'Missing position' });
      if (parseInt(row.active_deals) === 0 && reach > 5000)
                                             flags.push({ type: 'warning', msg: 'High reach, no active deals' });
      if (row.last_contact_at && new Date(row.last_contact_at) < new Date(daysAgo(IDLE_DAYS)) && parseInt(row.active_deals) === 0)
                                             flags.push({ type: 'warning', msg: `No contact in ${IDLE_DAYS}+ days` });

      // NIL status
      let nilStatus = 'no_deals';
      if (parseInt(row.active_deals) > 0)    nilStatus = 'active';
      else if (parseInt(row.deal_count) > 0) nilStatus = 'idle';

      // Contact status (inferred from log)
      let contactStatus = 'not_contacted';
      if (parseInt(row.active_deals) > 0)    contactStatus = 'active';
      else if (row.last_contact_at && new Date(row.last_contact_at) > new Date(daysAgo(IDLE_DAYS)))
                                             contactStatus = 'in_progress';
      else if (row.note_count > 0)           contactStatus = 'contacted';

      // Filter by status if requested
      if (status && status !== 'all') {
        if (status === 'active'   && nilStatus !== 'active')   return null;
        if (status === 'idle'     && nilStatus !== 'idle')     return null;
        if (status === 'no_deals' && nilStatus !== 'no_deals') return null;
        if (status === 'flagged'  && flags.length === 0)       return null;
      }

      return {
        id:             row.id,
        name:           d.name || '—',
        sport:          d.sport || '—',
        position:       d.position || null,
        year:           d.year || null,
        instagram:      parseInt(d.instagram) || 0,
        tiktok:         parseInt(d.tiktok) || 0,
        engagement:     parseFloat(d.engagement) || 0,
        reach,
        nilStatus,
        contactStatus,
        dealCount:      parseInt(row.deal_count) || 0,
        activeDeals:    parseInt(row.active_deals) || 0,
        totalNilValue:  parseInt(row.total_nil_value) || 0,
        lastDealBrand:  row.latest_deal_brand || null,
        lastContactAt:  row.last_contact_at || null,
        lastContactType: row.last_contact_type || null,
        noteCount:      parseInt(row.note_count) || 0,
        flags,
        createdAt:      row.created_at,
      };
    }).filter(Boolean);
  } catch (err) {
    console.error('[NILDirector] getAthleteCRM error:', err.message);
    return [];
  }
}

// ── 3. Deal Pipeline ───────────────────────────────────────────────────────
async function getDealPipeline(pool, universityId, { status = '', search = '', athleteId = '' } = {}) {
  try {
    const conditions = ['d.university_id = $1'];
    const params     = [universityId];
    let   idx        = 2;

    if (status && status !== 'all') {
      conditions.push(`d.status = $${idx}`);
      params.push(status);
      idx++;
    }
    if (search) {
      conditions.push(`(d.brand ILIKE $${idx} OR a.data->>'name' ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (athleteId) {
      conditions.push(`d.athlete_id = $${idx}`);
      params.push(athleteId);
      idx++;
    }

    const rows = await pool.query(
      `SELECT d.*,
              a.data->>'name'     AS athlete_name,
              a.data->>'sport'    AS athlete_sport,
              a.data->>'position' AS athlete_position,
              -- Auto-flag expiring
              CASE WHEN d.end_date <= CURRENT_DATE + INTERVAL '${EXPIRING_DAYS} days'
                    AND d.status = 'active' THEN true ELSE false END AS is_expiring_soon
       FROM university_deal_pipeline d
       LEFT JOIN athletes a ON a.id = d.athlete_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE d.status
           WHEN 'active'    THEN 1
           WHEN 'expiring'  THEN 2
           WHEN 'pending'   THEN 3
           WHEN 'completed' THEN 4
           WHEN 'rejected'  THEN 5
         END,
         d.updated_at DESC`,
      params
    );

    return rows.rows.map(r => ({
      id:               r.id,
      athleteId:        r.athlete_id,
      athleteName:      r.athlete_name || '—',
      athleteSport:     r.athlete_sport || '—',
      athletePosition:  r.athlete_position || null,
      brand:            r.brand,
      dealValue:        r.deal_value,
      dealType:         r.deal_type,
      status:           r.status,
      startDate:        r.start_date,
      endDate:          r.end_date,
      disclosureStatus: r.disclosure_status,
      notes:            r.notes,
      createdBy:        r.created_by,
      createdAt:        r.created_at,
      updatedAt:        r.updated_at,
      isExpiringSoon:   r.is_expiring_soon,
    }));
  } catch (err) {
    console.error('[NILDirector] getDealPipeline error:', err.message);
    return [];
  }
}

async function createDeal(pool, universityId, dealData, userId) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO university_deal_pipeline
       (id, university_id, athlete_id, brand, deal_value, deal_type, status,
        start_date, end_date, disclosure_status, notes, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
    [
      id,
      universityId,
      dealData.athleteId,
      dealData.brand,
      parseInt(dealData.dealValue) || 0,
      dealData.dealType || 'other',
      dealData.status || 'pending',
      dealData.startDate || null,
      dealData.endDate   || null,
      dealData.disclosureStatus || 'pending',
      dealData.notes || null,
      userId,
    ]
  );

  // Log a system note on the athlete's contact log
  await addNote(pool, universityId, dealData.athleteId, {
    contactType: 'system',
    subject:     `Deal added: ${dealData.brand}`,
    body:        `New deal added — ${dealData.brand}, $${(parseInt(dealData.dealValue)||0).toLocaleString()}, status: ${dealData.status || 'pending'}`,
  }, userId);

  return { id };
}

async function updateDeal(pool, dealId, updateData, userId) {
  const sets   = [];
  const params = [];
  let   idx    = 1;

  const allowed = ['brand','deal_value','deal_type','status','start_date','end_date','disclosure_status','notes'];
  const fieldMap = {
    brand: 'brand', dealValue: 'deal_value', dealType: 'deal_type',
    status: 'status', startDate: 'start_date', endDate: 'end_date',
    disclosureStatus: 'disclosure_status', notes: 'notes',
  };

  for (const [jsKey, col] of Object.entries(fieldMap)) {
    if (updateData[jsKey] !== undefined) {
      sets.push(`${col} = $${idx}`);
      params.push(jsKey === 'dealValue' ? parseInt(updateData[jsKey]) : updateData[jsKey]);
      idx++;
    }
  }

  if (!sets.length) return;

  sets.push(`updated_at = NOW()`);
  params.push(dealId);

  await pool.query(
    `UPDATE university_deal_pipeline SET ${sets.join(', ')} WHERE id = $${idx}`,
    params
  );
}

async function deleteDeal(pool, dealId) {
  await pool.query('DELETE FROM university_deal_pipeline WHERE id = $1', [dealId]);
}

// ── 4. Daily Actions (computed) ────────────────────────────────────────────
// Regenerates the action queue from live CRM state. Called on-demand (not scheduled)
// to keep actions fresh without a background job.
async function computeDailyActions(pool, universityId) {
  const actions = [];
  const now     = new Date();

  try {
    // Delete stale auto-generated actions older than 24h before rebuilding
    await pool.query(
      `DELETE FROM university_daily_actions
       WHERE university_id = $1
         AND auto_generated = true
         AND is_dismissed = false
         AND created_at < NOW() - INTERVAL '24 hours'`,
      [universityId]
    );

    // --- Action: Athletes with no contact in IDLE_DAYS and no active deals ---
    const idleAthletes = await pool.query(
      `SELECT a.id, a.data->>'name' AS name, a.data->>'sport' AS sport
       FROM athletes a
       LEFT JOIN athlete_contact_log cl
         ON cl.athlete_id = a.id AND cl.university_id = $1
       WHERE a.data->>'university_id' = $1
       GROUP BY a.id, a.data
       HAVING MAX(cl.created_at) IS NULL
           OR MAX(cl.created_at) < NOW() - INTERVAL '${IDLE_DAYS} days'
       LIMIT 10`,
      [universityId]
    );
    for (const ath of idleAthletes.rows) {
      actions.push({
        action_type: 'outreach',
        priority:    6,
        title:       `Reach out to ${ath.name}`,
        detail:      `${ath.sport} — no staff contact logged in ${IDLE_DAYS}+ days`,
        athlete_id:  ath.id,
        due_date:    daysFromNow(3),
      });
    }

    // --- Action: Deals expiring within EXPIRING_DAYS ---
    const expiringDeals = await pool.query(
      `SELECT d.id, d.brand, d.end_date, a.data->>'name' AS athlete_name
       FROM university_deal_pipeline d
       JOIN athletes a ON a.id = d.athlete_id
       WHERE d.university_id = $1
         AND d.status = 'active'
         AND d.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${EXPIRING_DAYS} days'
       ORDER BY d.end_date ASC
       LIMIT 10`,
      [universityId]
    );
    for (const deal of expiringDeals.rows) {
      const daysLeft = Math.ceil((new Date(deal.end_date) - now) / 86400000);
      actions.push({
        action_type: 'renewal',
        priority:    daysLeft <= 7 ? 9 : 7,
        title:       `Renew deal: ${deal.athlete_name} × ${deal.brand}`,
        detail:      `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${deal.end_date})`,
        athlete_id:  null,
        deal_id:     deal.id,
        due_date:    deal.end_date,
      });
    }

    // --- Action: Pending deals needing review ---
    const pendingDeals = await pool.query(
      `SELECT d.id, d.brand, a.data->>'name' AS athlete_name
       FROM university_deal_pipeline d
       JOIN athletes a ON a.id = d.athlete_id
       WHERE d.university_id = $1 AND d.status = 'pending'
       ORDER BY d.created_at ASC LIMIT 10`,
      [universityId]
    );
    for (const deal of pendingDeals.rows) {
      actions.push({
        action_type: 'deal_review',
        priority:    7,
        title:       `Review pending deal: ${deal.athlete_name} × ${deal.brand}`,
        detail:      'Approve, activate, or reject this deal',
        deal_id:     deal.id,
        due_date:    daysFromNow(1),
      });
    }

    // --- Action: Missing disclosures ---
    const missingDisclosure = await pool.query(
      `SELECT d.id, d.brand, a.data->>'name' AS athlete_name
       FROM university_deal_pipeline d
       JOIN athletes a ON a.id = d.athlete_id
       WHERE d.university_id = $1
         AND d.status = 'active'
         AND d.disclosure_status IN ('pending','missing')
       ORDER BY d.created_at ASC LIMIT 10`,
      [universityId]
    );
    for (const deal of missingDisclosure.rows) {
      actions.push({
        action_type: 'compliance',
        priority:    8,
        title:       `Disclosure needed: ${deal.athlete_name} × ${deal.brand}`,
        detail:      'Active deal missing institutional disclosure filing',
        deal_id:     deal.id,
        due_date:    daysFromNow(2),
      });
    }

    // --- Action: Roster review queue items ---
    const reviewQueue = await pool.query(
      `SELECT COUNT(*) AS cnt FROM roster_review_queue
       WHERE university_id = $1 AND status = 'pending'`,
      [universityId]
    ).catch(() => ({ rows: [{ cnt: 0 }] }));
    const queueCount = parseInt(reviewQueue.rows[0]?.cnt) || 0;
    if (queueCount > 0) {
      actions.push({
        action_type: 'approval',
        priority:    6,
        title:       `Review ${queueCount} athlete${queueCount > 1 ? 's' : ''} in roster queue`,
        detail:      'Auto-Import found athletes needing manual approval',
        due_date:    daysFromNow(2),
      });
    }

    // Bulk insert actions (skip duplicates by title)
    for (const action of actions) {
      await pool.query(
        `INSERT INTO university_daily_actions
           (university_id, action_type, priority, title, detail,
            athlete_id, deal_id, due_date, auto_generated, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true, NOW() + INTERVAL '48 hours', NOW())
         ON CONFLICT DO NOTHING`,
        [
          universityId,
          action.action_type,
          action.priority,
          action.title,
          action.detail || null,
          action.athlete_id || null,
          action.deal_id || null,
          action.due_date || null,
        ]
      ).catch(() => {}); // ignore duplicate key errors
    }

  } catch (err) {
    console.error('[NILDirector] computeDailyActions error:', err.message);
  }
}

async function getDailyActions(pool, universityId) {
  // Compute fresh actions then return undismissed queue
  await computeDailyActions(pool, universityId);

  const rows = await pool.query(
    `SELECT * FROM university_daily_actions
     WHERE university_id = $1
       AND is_dismissed = false
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY priority DESC, due_date ASC NULLS LAST
     LIMIT 20`,
    [universityId]
  );

  return rows.rows;
}

async function dismissAction(pool, actionId, userId) {
  await pool.query(
    `UPDATE university_daily_actions
     SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW()
     WHERE id = $2`,
    [userId, actionId]
  );
}

// ── 5. AI Opportunity Engine ───────────────────────────────────────────────
async function getOpportunityInsights(pool, universityId, universityName) {
  // Build CRM context from real data
  const athletes = await getAthleteCRM(pool, universityId);
  const metrics  = await getDashboardMetrics(pool, universityId);

  const totalAthletes  = athletes.length;
  const withDeals      = athletes.filter(a => a.dealCount > 0).length;
  const noDeals        = athletes.filter(a => a.dealCount === 0);
  const highReach      = athletes.filter(a => a.reach > 10000).sort((a,b) => b.reach - a.reach).slice(0, 5);
  const highEngagement = athletes.filter(a => a.engagement > 5).sort((a,b) => b.engagement - a.engagement).slice(0, 5);

  const contextSummary = `
University: ${universityName}
Total athletes: ${totalAthletes}
Athletes with NIL deals: ${withDeals}
Athletes with NO deals: ${noDeals.length}
Total program NIL value: $${(metrics.deals?.totalValue || 0).toLocaleString()}
Active deals: ${metrics.deals?.active || 0}

Top 5 by social reach (no active deals):
${highReach.filter(a => a.activeDeals === 0).slice(0, 5).map(a =>
  `  ${a.name} (${a.sport}) — ${a.reach.toLocaleString()} reach, ${a.engagement}% engagement`
).join('\n') || '  None'}

Top 5 by engagement rate:
${highEngagement.map(a =>
  `  ${a.name} (${a.sport}) — ${a.engagement}% ER, ${a.reach.toLocaleString()} reach, ${a.dealCount} deals`
).join('\n') || '  None'}

Athletes with most deals:
${metrics.topEarners.slice(0, 3).map(a =>
  `  ${a.name} (${a.sport}) — ${a.deal_count} deals, $${parseInt(a.total_value).toLocaleString()}`
).join('\n') || '  None'}
`.trim();

  const prompt = `You are an expert NIL program advisor for ${universityName}. Based on this real CRM data, generate specific, actionable insights for the NIL director.

CRM DATA:
${contextSummary}

Generate a JSON response with exactly these 4 arrays:

1. "underMonetized": Up to 4 athletes who are clearly under-monetized given their reach/engagement. Include specific suggested action.
2. "highPotential": Up to 4 athletes with highest NIL potential based on sport + social data. Include specific brand category suggestions.
3. "brandOpportunities": Up to 5 specific brand or deal type opportunities for this program overall (not individual athletes). Base on the sports mix and market.
4. "programInsights": 3-4 strategic program-level observations and recommendations.

Return ONLY valid JSON:
{
  "underMonetized": [{"athleteName":"","sport":"","reach":0,"reason":"","suggestedAction":""}],
  "highPotential": [{"athleteName":"","sport":"","why":"","brandCategories":[""],"estimatedRange":""}],
  "brandOpportunities": [{"title":"","description":"","targetSports":[""],"priority":"high|medium|low"}],
  "programInsights": [{"insight":"","action":""}]
}`;

  try {
    const client = getClient();
    const msg = await client.messages.create({
      model:     'claude-opus-4-5',
      max_tokens: 2048,
      messages:  [{ role: 'user', content: prompt }],
    });
    const raw = msg.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[NILDirector] AI Insights error:', err.message);
    // Return lightweight fallback from CRM data
    return {
      underMonetized: noDeals.slice(0, 4).map(a => ({
        athleteName:     a.name,
        sport:           a.sport,
        reach:           a.reach,
        reason:          `${a.reach.toLocaleString()} reach with zero NIL deals`,
        suggestedAction: 'Initiate brand outreach conversation',
      })),
      highPotential: highEngagement.slice(0, 4).map(a => ({
        athleteName:     a.name,
        sport:           a.sport,
        why:             `${a.engagement}% engagement rate above 5% threshold`,
        brandCategories: ['Local business', 'Nutrition', 'Apparel'],
        estimatedRange:  '$500–$2,500',
      })),
      brandOpportunities: [
        { title: 'Local restaurant partnerships', description: 'High visibility, easy activation for any sport', targetSports: [], priority: 'high' },
        { title: 'Nutrition + supplement brands', description: 'Strong fit for all athletic programs', targetSports: [], priority: 'medium' },
      ],
      programInsights: [
        { insight: `${noDeals.length} of ${totalAthletes} athletes have zero NIL deals`, action: 'Schedule group NIL education session' },
      ],
    };
  }
}

// ── 6. Communication + Activity Log ───────────────────────────────────────
async function addNote(pool, universityId, athleteId, noteData, userId) {
  const result = await pool.query(
    `INSERT INTO athlete_contact_log
       (university_id, athlete_id, staff_user_id, contact_type, subject, body, is_pinned, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     RETURNING id`,
    [
      universityId,
      athleteId,
      noteData.contactType === 'system' ? null : userId,
      noteData.contactType || 'note',
      noteData.subject || null,
      noteData.body,
      noteData.isPinned || false,
    ]
  );
  return result.rows[0];
}

async function getNotes(pool, universityId, athleteId, limit = 20) {
  const rows = await pool.query(
    `SELECT cl.*, u.email AS staff_email
     FROM athlete_contact_log cl
     LEFT JOIN users u ON u.id = cl.staff_user_id
     WHERE cl.university_id = $1 AND cl.athlete_id = $2
     ORDER BY cl.is_pinned DESC, cl.created_at DESC
     LIMIT $3`,
    [universityId, athleteId, limit]
  );
  return rows.rows;
}

async function getActivityFeed(pool, universityId, limit = 50) {
  const rows = await pool.query(
    `SELECT cl.*, a.data->>'name' AS athlete_name, a.data->>'sport' AS athlete_sport,
            u.email AS staff_email
     FROM athlete_contact_log cl
     LEFT JOIN athletes a ON a.id = cl.athlete_id
     LEFT JOIN users u ON u.id = cl.staff_user_id
     WHERE cl.university_id = $1
     ORDER BY cl.created_at DESC
     LIMIT $2`,
    [universityId, limit]
  );
  return rows.rows;
}

// ── 7. Compliance Alerts ───────────────────────────────────────────────────
async function getComplianceAlerts(pool, universityId) {
  const alerts = [];

  // Missing disclosures
  const missing = await pool.query(
    `SELECT d.id, d.brand, d.deal_value, d.disclosure_status,
            a.data->>'name' AS athlete_name, a.data->>'sport' AS sport
     FROM university_deal_pipeline d
     JOIN athletes a ON a.id = d.athlete_id
     WHERE d.university_id = $1
       AND d.status = 'active'
       AND d.disclosure_status IN ('pending','missing')
     ORDER BY d.created_at ASC`,
    [universityId]
  );
  for (const r of missing.rows) {
    alerts.push({
      type:     'compliance',
      severity: r.disclosure_status === 'missing' ? 'high' : 'medium',
      title:    `Disclosure ${r.disclosure_status}: ${r.athlete_name} × ${r.brand}`,
      detail:   `Active deal ($${r.deal_value?.toLocaleString()}) — needs institutional disclosure`,
      athleteName: r.athlete_name,
      sport:    r.sport,
      dealId:   r.id,
    });
  }

  // Expiring deals
  const expiring = await pool.query(
    `SELECT d.id, d.brand, d.end_date, d.deal_value,
            a.data->>'name' AS athlete_name, a.data->>'sport' AS sport
     FROM university_deal_pipeline d
     JOIN athletes a ON a.id = d.athlete_id
     WHERE d.university_id = $1
       AND d.status = 'active'
       AND d.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${EXPIRING_DAYS} days'
     ORDER BY d.end_date ASC`,
    [universityId]
  );
  for (const r of expiring.rows) {
    const daysLeft = Math.ceil((new Date(r.end_date) - new Date()) / 86400000);
    alerts.push({
      type:     'expiring',
      severity: daysLeft <= 7 ? 'high' : 'medium',
      title:    `Deal expiring in ${daysLeft}d: ${r.athlete_name} × ${r.brand}`,
      detail:   `$${r.deal_value?.toLocaleString()} deal ends ${r.end_date}`,
      athleteName: r.athlete_name,
      sport:    r.sport,
      dealId:   r.id,
    });
  }

  // Inactive athletes (no deals, high reach, no contact)
  const inactive = await pool.query(
    `SELECT a.id, a.data->>'name' AS name, a.data->>'sport' AS sport,
            COALESCE((a.data->>'instagram')::int,0) + COALESCE((a.data->>'tiktok')::int,0) AS reach
     FROM athletes a
     LEFT JOIN university_deal_pipeline d
       ON d.athlete_id = a.id AND d.university_id = $1 AND d.status = 'active'
     WHERE a.data->>'university_id' = $1
       AND d.id IS NULL
       AND (COALESCE((a.data->>'instagram')::int,0) + COALESCE((a.data->>'tiktok')::int,0)) > 5000
     ORDER BY reach DESC
     LIMIT 10`,
    [universityId]
  );
  for (const r of inactive.rows) {
    alerts.push({
      type:     'inactive',
      severity: 'low',
      title:    `Inactive: ${r.name}`,
      detail:   `${r.reach.toLocaleString()} social reach with no active NIL deals`,
      athleteName: r.name,
      sport:    r.sport,
    });
  }

  return alerts.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] || 2) - (sev[b.severity] || 2);
  });
}

module.exports = {
  getDashboardMetrics,
  getAthleteCRM,
  getDealPipeline,
  createDeal,
  updateDeal,
  deleteDeal,
  getDailyActions,
  dismissAction,
  getOpportunityInsights,
  addNote,
  getNotes,
  getActivityFeed,
  getComplianceAlerts,
};
