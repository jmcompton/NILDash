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
const { oneShot, oneShotWebSearch, getBrandContacts } = require('../ai');

// A generic mailbox local-part must never be presented as a named person's
// address (mirror of the shared rule in ai.js). Used to purge stale cache rows
// written by the old inferred-info@ path.
function _looksGeneric(email) {
  return typeof email === 'string' && /^(info|contact|hello|hi|sales|support|admin|team|marketing|press|media|partnerships?|pr|office|general|inquiries|enquiries|service)@/i.test(email.trim());
}
function _contactTypeFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/partnership|sponsor/.test(t)) return 'partnership';
  if (/marketing/.test(t)) return 'marketing';
  return 'general';
}

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
  const existing = await getByEnrichmentId(enrichmentRecord.id);
  // Purge cache written by the OLD path that inferred info@ or attached a generic
  // inbox to a named person; otherwise trust the cache.
  const stale = existing.some((c) => c.source === 'inferred_domain' || (c.name && _looksGeneric(c.email)));
  if (existing.length > 0 && !stale) {
    logEvent(null, agentId, 'contact_discovery_cache_hit', { enrichmentId: enrichmentRecord.id });
    return existing;
  }
  if (existing.length > 0) {
    await pool.query('DELETE FROM brand_contacts WHERE enrichment_id=$1', [enrichmentRecord.id]).catch(() => {});
  }

  // ONE contact system. Use the SAME resolver Deal Scan uses: published personal
  // emails only, generic inboxes never attached to a person, phones locality
  // checked, nothing fabricated. No second implementation, no inferred info@.
  let shared = { contacts: [], businessPhone: null, genericInbox: null };
  try {
    shared = await getBrandContacts(enrichmentRecord.brand_name, enrichmentRecord.website || null, enrichmentRecord.location || '', {});
  } catch (e) {
    console.error('[contactDiscovery] getBrandContacts failed:', e.message);
  }

  // Build ranked rows: named people first (best when they carry a published
  // email), then the business phone as a phone-only contact, then the generic
  // inbox LAST and clearly labeled. A generic inbox is never given a person's name.
  const rows = [];
  let rank = 1;
  for (const c of (shared.contacts || [])) {
    rows.push({
      name: c.name, title: c.title,
      email: c.email || null,           // published personal email, or null; NEVER a generic inbox
      phone: c.phone || null,
      linkedin: c.linkedinUrl || null,
      contact_type: _contactTypeFromTitle(c.title),
      confidence_score: c.email ? 0.9 : (c.phone ? 0.6 : 0.5),
      source: c.sourceUrl ? 'published' : 'shared',
      priority: rank++,
    });
  }
  if (shared.businessPhone && !rows.some((r) => r.phone)) {
    rows.push({ name: null, title: 'Business line', email: null, phone: shared.businessPhone, linkedin: null, contact_type: 'general', confidence_score: 0.5, source: 'published', priority: 50 });
  }
  if (shared.genericInbox) {
    rows.push({ name: null, title: 'Generic inbox (no named contact)', email: shared.genericInbox, phone: null, linkedin: null, contact_type: 'general', confidence_score: 0.2, source: 'published', priority: 99 });
  }

  const saved = [];
  for (const contact of rows) {
    const id = 'con_' + crypto.randomBytes(8).toString('hex');
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
          contact.confidence_score, contact.source, contact.priority,
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
STEP 3 - The top contact MUST have a usable email. Prefer a REAL email you actually find on the web. If you cannot find a posted email but you found the business's official website, infer its standard general inbox (info@theirdomain.com, or sales@theirdomain.com for a dealership) and lower the confidence. Only leave email null if you could not even determine the business's website domain.

Do NOT target the CEO, owner, or founder of a large company. For a tiny local shop the owner may be the only contact, which is fine.

Return a JSON array of up to 4 contacts, best first:
[
  {
    "name": "Real person's name, or null if you only found a department or shared inbox",
    "title": "Role, e.g. General Manager, Marketing Manager, Brand Partnerships",
    "email": "a REAL email found on the web, OR an inferred general inbox (info@/sales@ their domain) if none is posted. null ONLY if you found no website domain at all",
    "phone": null,
    "linkedin": "https://linkedin.com/in/... or null",
    "contact_type": "athlete_relations|nil|partnership|sponsorship|sports_marketing|influencer|marketing_director|marketing|general",
    "confidence_score": 0.0 to 1.0 (0.85 = real email found on their own site, 0.6 = real shared inbox, 0.4 = inferred format, 0.2 = guess),
    "source": "company_website|public_record|linkedin|web_search|ai_inference",
    "outreach_notes": "1-2 sentences: who this is, the best angle, and where you found the email"
  }
]

Always return at least one contact, and the top contact's email must be filled whenever you found the business's website. Never leave the best contact's email null when you know their domain.`;

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

function domainFromWebsite(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).startsWith('http') ? url : 'https://' + url);
    const host = u.hostname.replace(/^www\./, '');
    return /\.[a-z]{2,}$/i.test(host) ? host : null;
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
