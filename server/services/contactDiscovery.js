// server/services/contactDiscovery.js
// ContactDiscoveryService — Part 2 of the NIL Outreach Automation Engine.
//
// Responsibilities:
//   - discover decision makers from enriched company data
//   - rank contacts by relevance to NIL/athlete partnerships
//   - assign confidence scores
//   - deduplicate contacts per enrichment record
//   - return ranked list of best contacts to reach
//
// Priority order (per spec):
//   1. partnership  2. athlete relations  3. sponsorship  4. marketing leadership
//
// SAFETY: reads from company_enrichment only.
//         writes only to brand_contacts (new table).
//         zero modifications to any existing service or route.

'use strict';

const crypto = require('crypto');
const { pool } = require('../store');
const { oneShot } = require('../ai');

// Contact type priority for ranking
const PRIORITY_MAP = {
  'athlete_relations':   1,
  'partnership':         2,
  'nil':                 3,
  'sponsorship':         4,
  'sports_marketing':    5,
  'influencer':          6,
  'marketing_director':  7,
  'marketing':           8,
  'pr':                  9,
  'general':             10,
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * discoverContacts(agentId, enrichmentRecord)
 *
 * Runs AI contact discovery using the enriched company profile.
 * Returns array of ranked contact records (saved to DB).
 */
async function discoverContacts(agentId, enrichmentRecord) {
  // Check if we already have contacts for this enrichment
  const existing = await getByEnrichmentId(enrichmentRecord.id);
  if (existing.length > 0) {
    logEvent(null, agentId, 'contact_discovery_cache_hit', { enrichmentId: enrichmentRecord.id });
    return existing;
  }

  // Run AI discovery
  const contacts = await runDiscovery(enrichmentRecord);

  // Save and rank
  const saved = [];
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const id = 'con_' + crypto.randomBytes(8).toString('hex');
    const priority = PRIORITY_MAP[contact.contact_type] || 10;
    try {
      const r = await pool.query(
        `INSERT INTO brand_contacts (
           id, enrichment_id, agent_id, brand_name, name, title, email,
           phone, linkedin, contact_type, confidence_score, source, priority_rank, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         RETURNING *`,
        [
          id, enrichmentRecord.id, agentId, enrichmentRecord.brand_name,
          contact.name, contact.title, contact.email, contact.phone,
          contact.linkedin, contact.contact_type,
          contact.confidence_score || 0,
          contact.source || 'ai_inference',
          priority,
        ]
      );
      saved.push(r.rows[0]);
    } catch (e) {
      console.error('[contactDiscovery] Failed to save contact:', e.message);
    }
  }

  logEvent(null, agentId, 'contact_discovery_complete', {
    enrichmentId: enrichmentRecord.id,
    count: saved.length,
  });

  return saved.sort((a, b) => a.priority_rank - b.priority_rank);
}

/**
 * getBestContact(agentId, enrichmentId)
 * Returns the single highest-priority contact for an enrichment record.
 */
async function getBestContact(agentId, enrichmentId) {
  const r = await pool.query(
    `SELECT * FROM brand_contacts
     WHERE enrichment_id=$1 AND agent_id=$2
     ORDER BY priority_rank ASC, confidence_score DESC
     LIMIT 1`,
    [enrichmentId, agentId]
  );
  return r.rows[0] || null;
}

/**
 * getByEnrichmentId(enrichmentId)
 * Returns all contacts for an enrichment, sorted by priority.
 */
async function getByEnrichmentId(enrichmentId) {
  const r = await pool.query(
    `SELECT * FROM brand_contacts
     WHERE enrichment_id=$1
     ORDER BY priority_rank ASC, confidence_score DESC`,
    [enrichmentId]
  );
  return r.rows;
}

/**
 * getById(id)
 */
async function getById(id) {
  const r = await pool.query('SELECT * FROM brand_contacts WHERE id=$1', [id]);
  return r.rows[0] || null;
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function runDiscovery(enrichmentRecord) {
  const brand = enrichmentRecord.brand_name;
  const industry = enrichmentRecord.industry || 'consumer brand';
  const size = enrichmentRecord.brand_size || 'regional';
  const description = enrichmentRecord.description || '';
  const website = enrichmentRecord.website || '';
  const socialLinks = enrichmentRecord.social_links
    ? (typeof enrichmentRecord.social_links === 'string'
        ? enrichmentRecord.social_links
        : JSON.stringify(enrichmentRecord.social_links))
    : '';

  const system = `You are an elite sports marketing intelligence agent with deep knowledge of brand marketing teams.
Your job is to identify REAL, NAMED individuals who handle NIL deals and athlete sponsorships at companies.
Return ONLY a valid JSON array. No markdown, no explanation, no preamble.

RULES:
- Always try to return a real person's name and title. Use your knowledge of the company's marketing leadership.
- For well-known brands (Nike, Gatorade, Red Bull, national retail chains, major CPG brands), you likely know who runs their sports marketing or partnerships team — use that knowledge.
- For email: infer the corporate format if you know it (e.g. first@company.com, first.last@company.com). Set confidence low if inferred.
- For LinkedIn: only include a URL if you are confident it is accurate (https://linkedin.com/in/firstname-lastname-XXXXXX format).
- Never fabricate phone numbers — always null.
- Sort contacts by relevance: NIL/athlete-relations contacts first, then broader partnerships, then general marketing.
- NEVER return the CEO, founder, co-founder, President, or owner as the outreach contact, unless the brand is a small local business with no marketing or partnerships staff. Cold-pitching an NIL micro-deal to an executive gets ignored. Always prefer the person who runs partnerships, sponsorships, sports marketing, or influencer/creator marketing.
- If you cannot name the right partnerships person, return the partnerships TEAM (name: null, title: 'Brand Partnerships Team') as the primary contact rather than naming an executive.`;

  const prompt = `I need to send a college athlete NIL partnership proposal to someone at "${brand}".

Company profile:
- Industry: ${industry}
- Size: ${size}
- Website: ${website}
- Description: ${description}
${socialLinks ? `- Social/links: ${socialLinks}` : ''}

YOUR TASK: Identify the REAL person at "${brand}" who would actually receive an athlete NIL partnership proposal:
1. NIL / athlete relations / college partnerships lead (HIGHEST PRIORITY)
2. Brand partnerships or sponsorship manager
3. Sports marketing or influencer/creator marketing manager
4. Marketing manager or brand manager (not the CMO unless it is a small company)
Do NOT target the CEO, founder, co-founder, President, or owner. They do not handle inbound NIL micro-deals.

For EACH person, think:
- What is their actual name? (LinkedIn, press releases, company website "About" page, news coverage of sponsorship announcements)
- What is their exact title?
- What email format does ${brand} use? (firstname@, f.lastname@, firstname.lastname@?)
- Do they have a public LinkedIn profile?

Return a JSON array of up to 5 contacts:
[
  {
    "name": "First Last (REAL person's name, or null only if truly unknown)",
    "title": "Exact job title",
    "email": "inferred or known email address, or null",
    "phone": null,
    "linkedin": "https://linkedin.com/in/profile or null",
    "contact_type": "athlete_relations" | "nil" | "partnership" | "sponsorship" | "sports_marketing" | "influencer" | "marketing_director" | "marketing" | "pr" | "general",
    "confidence_score": 0.0 to 1.0 (0.8+ = known from public record, 0.5 = inferred from role/company, 0.2 = speculative),
    "source": "public_record" | "company_website" | "linkedin" | "ai_inference",
    "outreach_notes": "1-2 sentences: why this person handles NIL deals at ${brand} and the best angle to approach them"
  }
]

IMPORTANT: Name the real partnerships, sponsorship, or marketing person if you know them. If you only know executives (CEO/founder/President), do NOT return them — return the 'Brand Partnerships Team' instead. Do not return generic placeholders if you can name the real partnerships contact. Always return at least 2 contacts.`;

  let raw;
  try {
    raw = await oneShot(prompt, system, 2500);
  } catch (e) {
    console.error('[contactDiscovery] AI call failed:', e.message);
    return buildFallbackContacts(brand);
  }

  return parseContacts(raw, brand);
}

function parseContacts(raw, brandName) {
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) throw new Error('Not an array');

    return parsed.map(c => ({
      name:             strNull(c.name),
      title:            strNull(c.title) || 'Marketing / Partnerships',
      email:            validateEmail(c.email),
      phone:            null, // never accept AI-generated phone numbers
      linkedin:         validateUrl(c.linkedin),
      contact_type:     validateContactType(c.contact_type),
      confidence_score: clampScore(c.confidence_score),
      source:           strNull(c.source) || 'ai_inference',
      outreach_notes:   strNull(c.outreach_notes),
    })).slice(0, 6);
  } catch (e) {
    console.error('[contactDiscovery] JSON parse failed:', e.message);
    return buildFallbackContacts(brandName);
  }
}

function buildFallbackContacts(brandName) {
  return [
    {
      name: null,
      title: 'Brand Partnerships Team',
      email: null,
      phone: null,
      linkedin: null,
      contact_type: 'partnership',
      confidence_score: 0.2,
      source: 'ai_inference',
      outreach_notes: `Reach out to ${brandName}'s general partnerships team.`,
    },
    {
      name: null,
      title: 'Marketing Director',
      email: null,
      phone: null,
      linkedin: null,
      contact_type: 'marketing_director',
      confidence_score: 0.2,
      source: 'ai_inference',
      outreach_notes: `${brandName}'s marketing leadership may handle sponsorship decisions.`,
    },
  ];
}

// ── Sanitizers ────────────────────────────────────────────────────────────────

function strNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

function validateEmail(v) {
  const s = strNull(v);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
}

function validateUrl(v) {
  const s = strNull(v);
  if (!s) return null;
  try {
    const url = new URL(s.startsWith('http') ? s : 'https://' + s);
    return url.hostname.includes('linkedin.com') ? url.href : null;
  } catch { return null; }
}

function validateContactType(v) {
  const valid = Object.keys(PRIORITY_MAP);
  const s = strNull(v);
  return valid.includes(s) ? s : 'general';
}

function clampScore(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return 0.3;
  return Math.min(1, Math.max(0, n));
}

// ── Event logging (fire-and-forget) ──────────────────────────────────────────

function logEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { discoverContacts, getBestContact, getByEnrichmentId, getById };
