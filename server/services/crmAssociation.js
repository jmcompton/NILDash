// server/services/crmAssociation.js
// Matches email addresses to athletes/deals in the existing CRM.
// Pure lookup — never modifies athlete or deal records.

'use strict';
const { pool } = require('../store');

/**
 * Given an array of email addresses (from/to/cc), return the first matching
 * athleteId and dealId found in the database for this agent's roster.
 */
async function associateEmail(userId, addresses) {
  if (!addresses || !addresses.length) return { athleteId: null, dealId: null };

  // Normalize addresses — lowercase, strip display names
  const normalized = addresses
    .map(a => {
      const match = a.match(/<(.+?)>/) || a.match(/([^\s]+@[^\s]+)/);
      return match ? match[1].toLowerCase().trim() : a.toLowerCase().trim();
    })
    .filter(Boolean);

  if (!normalized.length) return { athleteId: null, dealId: null };

  // Check if any address appears in the athlete data JSONB (email field)
  // Athletes store their data as JSONB — search within it
  try {
    const r = await pool.query(`
      SELECT id FROM athletes
      WHERE agent_id = $1
        AND (
          data->>'email' = ANY($2::text[])
          OR data->>'contactEmail' = ANY($2::text[])
        )
      LIMIT 1
    `, [userId, normalized]);

    if (r.rows.length) {
      return { athleteId: r.rows[0].id, dealId: null };
    }
  } catch (e) {
    // Silently continue — JSONB field may not exist for all records
  }

  return { athleteId: null, dealId: null };
}

/**
 * Returns a map of { emailAddress → athleteId } for all athletes on this
 * agent's roster that have an email address stored.
 * Used to pre-build a lookup cache during sync.
 */
async function buildAthleteEmailMap(userId) {
  const map = {};
  try {
    const r = await pool.query(`
      SELECT id, data->>'email' AS email, data->>'contactEmail' AS contact_email
      FROM athletes WHERE agent_id=$1
    `, [userId]);
    for (const row of r.rows) {
      if (row.email) map[row.email.toLowerCase()] = row.id;
      if (row.contact_email) map[row.contact_email.toLowerCase()] = row.id;
    }
  } catch (e) {
    console.error('[crmAssociation] buildAthleteEmailMap error:', e.message);
  }
  return map;
}

module.exports = { associateEmail, buildAthleteEmailMap };
