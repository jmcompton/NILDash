'use strict';
// ── THE ADDRESS THE DRAFT NEVER CARRIED ──────────────────────────────────────
//
// 115 of 120 drafts were skipped by the Closer for "no email address on file",
// while /admin/local-coverage reported 268 of 387 validated businesses WITH a
// working email. Both were true. The addresses exist; they were never written
// onto the outreach row.
//
// draftPrewarm's INSERT names eleven columns and none of them is sent_to_email,
// contact_id or enrichment_id. So every nightly draft was born with no address,
// and the Closer's batch query -- which reads COALESCE(brand_contacts.email,
// outreach_logs.sent_to_email) through a contact_id that is always NULL --
// correctly found nothing, every time.
//
// brand_contacts IS populated, but only on the AI Outreach workflow path
// (workflowOrchestrator), never on the nightly one. So the nightly drafts had no
// route to an address at all.
//
// WHERE THE ADDRESSES ACTUALLY ARE. siteEmail writes them to
// brand_evidence_cache under lane 'siteemail', keyed by site root rather than by
// brand, with the display name in the `brand` column and the address in
// evidence->>'email'. That is the join this file makes.
//
// IT NEVER INVENTS ONE. A brand with no cached address gets null and the draft
// says so; guessing info@<brand>.com would be a fabricated address on a real
// business, and the bounce would land on the agent's own sending reputation.

// A corporate address on a franchise is not the local owner. It is still a real
// address and still worth having, but it is TAGGED so the Closer and the writer
// can treat it differently rather than discovering it at the reply.
function classify(ev) {
  if (!ev) return null;
  if (!ev.email) return null;
  return {
    email: String(ev.email).trim().toLowerCase(),
    kind: ev.corporate ? 'corporate' : (ev.type === 'personal' ? 'personal' : 'generic'),
    corporate: !!ev.corporate,
    sourceUrl: ev.sourceUrl || null,
    formUrl: ev.formUrl || null,
    siteRoot: ev.siteRoot || null,
  };
}

// One query for many brands. Matched on the display name, because the cache key
// is the site root and the outreach row only knows the brand.
async function lookupMany(pool, brands) {
  const names = [...new Set((brands || [])
    .map((b) => String(b || '').trim().toLowerCase()).filter(Boolean))];
  if (!names.length) return new Map();
  const out = new Map();
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (LOWER(brand)) LOWER(brand) AS key, evidence, refreshed_at
         FROM brand_evidence_cache
        WHERE lane = 'siteemail' AND brand IS NOT NULL
          AND LOWER(brand) = ANY($1::text[])
        ORDER BY LOWER(brand), refreshed_at DESC`, [names]);
    for (const row of r.rows) {
      const hit = classify(row.evidence || {});
      if (hit) out.set(row.key, hit);
    }
  } catch (e) {
    console.error('[draftAddress] lookupMany:', e.message);
  }
  return out;
}

async function lookupOne(pool, brand) {
  const m = await lookupMany(pool, [brand]);
  return m.get(String(brand || '').trim().toLowerCase()) || null;
}

// Stamp an address onto rows that have none. Used at draft time and by the
// backfill; both go through here so the two cannot drift.
//
// ONLY WHERE IT IS MISSING. An address already on a row was put there by
// something that knew more than this does -- the workflow path attaches a real
// contact_id -- and must not be overwritten by a site-wide generic inbox.
async function attach(pool, { agentId, ids = null, limit = 500 } = {}) {
  const rows = (await pool.query(
    `SELECT id, brand_name FROM outreach_logs
      WHERE agent_id = $1
        AND (sent_to_email IS NULL OR sent_to_email = '')
        AND status IN ('draft','approved')
        AND ($2::text[] IS NULL OR id = ANY($2::text[]))
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, ids, limit])).rows;
  if (!rows.length) return { considered: 0, attached: 0, missing: 0, details: [] };

  const found = await lookupMany(pool, rows.map((r) => r.brand_name));
  const out = { considered: rows.length, attached: 0, missing: 0, corporate: 0, details: [] };
  for (const r of rows) {
    const hit = found.get(String(r.brand_name || '').trim().toLowerCase());
    if (!hit) {
      out.missing++;
      out.details.push({ id: r.id, brand: r.brand_name, result: 'no-address' });
      continue;
    }
    await pool.query(
      `UPDATE outreach_logs
          SET sent_to_email = $2, email_kind = $3, updated_at = NOW()
        WHERE id = $1 AND (sent_to_email IS NULL OR sent_to_email = '')`,
      [r.id, hit.email, hit.kind]).catch((e) =>
      console.error('[draftAddress] attach ' + r.id + ':', e.message));
    out.attached++;
    if (hit.corporate) out.corporate++;
    out.details.push({ id: r.id, brand: r.brand_name, result: 'attached',
      email: hit.email, kind: hit.kind });
  }
  return out;
}

module.exports = { attach, lookupOne, lookupMany, classify };
