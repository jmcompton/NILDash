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
const { oneShot, oneShotWebSearch } = require('../ai');

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
  // Only trust cached contacts if the best one has a real email. A cached
  // "no email found" result is stale and useless, so clear it and re-research.
  const existing = await getByEnrichmentId(enrichmentRecord.id);
  if (existing.length > 0 && existing.some(c => c.email)) {
    logEvent(null, agentId, 'contact_discovery_cache_hit', { enrichmentId: enrichmentRecord.id });
    return existing;
  }
  if (existing.length > 0) {
    await pool.query('DELETE FROM brand_contacts WHERE enrichment_id=$1', [enrichmentRecord.id]).catch(() => {});
  }

  // Run AI discovery
  const contacts = await runDiscovery(enrichmentRecord);

  // For a local business, the web-researched enrichment may have found the real
  // best contact email. Prefer it over any role-inferred address so outreach lands
  // in the right inbox.
  if (enrichmentRecord.brand_size === 'local' && enrichmentRecord.general_email && contacts.length) {
    contacts[0].email = enrichmentRecord.general_email;
    contacts[0].source = 'web_research';
    if (!contacts[0].confidence_score || contacts[0].confidence_score < 0.6) {
      contacts[0].confidence_score = 0.6;
    }
  }

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
  const industry = enrichmentRecord.industry || '';
  const description = enrichmentRecord.description || '';
  const website = enrichmentRecord.website || '';

  const system = `You are a contact-research specialist. You use web search to find the REAL, current best contact for sending a college athlete NIL / sponsorship partnership pitch to a specific business. Return ONLY a valid JSON array. No markdown, no preamble, no commentary after the array.`;

  const prompt = `Find the best real contact to email an NIL / sponsorship partnership proposal at this business:

BUSINESS: "${brand}"
${website ? `Website: ${website}` : ''}
${industry ? `Industry: ${industry}` : ''}
${description ? `Context: ${description}` : ''}

STEP 1 - Search the web for this exact business. Find its official website and its contact / about / team page.
STEP 2 - Find the best place to send a partnership pitch:
  - If it is a LOCAL or single-location business (a specific car dealership, gym, restaurant, studio, salon, or one franchise location): find the business's REAL public email from its website (often info@, sales@, contact@, or a marketing / general-manager address) and the General Manager or Marketing Manager by name if the site lists them.
  - If it is a NATIONAL or REGIONAL brand: find the partnerships, sponsorship, sports-marketing, or influencer-marketing contact. A real named person if you can find one, otherwise the real partnerships@ or marketing@ inbox.
STEP 3 - Prefer a REAL email you actually find on the web over any guess. A real general business inbox (info@, sales@) is BETTER than a blank or an invented address. Only infer an email format if you found the company domain but no posted address, and lower the confidence when you do.

Do NOT target the CEO, owner, or founder of a large company. For a tiny local shop the owner may be the only contact, which is fine.

Return a JSON array of up to 4 contacts, best first:
[
  {
    "name": "Real person's name, or null if you only found a department or shared inbox",
    "title": "Role, e.g. General Manager, Marketing Manager, Brand Partnerships",
    "email": "the REAL email you found, or a clearly-inferred one, or null",
    "phone": null,
    "linkedin": "https://linkedin.com/in/... or null",
    "contact_type": "athlete_relations|nil|partnership|sponsorship|sports_marketing|influencer|marketing_director|marketing|general",
    "confidence_score": 0.0 to 1.0 (0.85 = real email found on their own site, 0.6 = real shared inbox, 0.4 = inferred format, 0.2 = guess),
    "source": "company_website|public_record|linkedin|web_search|ai_inference",
    "outreach_notes": "1-2 sentences: who this is, the best angle, and where you found the email"
  }
]

Always return at least one contact with the best emailable address you can actually find.`;

  let raw;
  try {
    raw = await oneShotWebSearch(prompt, system, 3000, 4, 'claude-sonnet-4-6');
  } catch (e) {
    console.error('[contactDiscovery] web search failed, falling back to model knowledge:', e.message);
    try {
      raw = await oneShot(prompt, system, 2500);
    } catch (e2) {
      console.error('[contactDiscovery] AI call failed:', e2.message);
      return buildFallbackContacts(brand);
    }
  }

  const contacts = parseContacts(raw, brand);
  return contacts.length ? contacts : buildFallbackContacts(brand);
}

function parseContacts(raw, brandName) {
  try {
    let clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Web search responses often narrate before the JSON; extract the array.
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) clean = clean.slice(start, end + 1);
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
      title: 'Marketing Manager',
      email: null,
      phone: null,
      linkedin: null,
      contact_type: 'marketing',
      confidence_score: 0.45,
      source: 'ai_inference',
      outreach_notes: `Call or visit ${brandName} and ask for the person who handles marketing and local sponsorships.`,
    },
    {
      name: null,
      title: 'General Manager',
      email: null,
      phone: null,
      linkedin: null,
      contact_type: 'general',
      confidence_score: 0.4,
      source: 'ai_inference',
      outreach_notes: `The GM at ${brandName} can approve a local sponsorship or point you to the right person.`,
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
