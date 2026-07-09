// NILDash — Deal Scan evidence pre-warm job
// Pre-populates brand_evidence_cache for the seed brands so common Social and
// Top NIL brands are always a cache hit at scan time. This removes the dominant
// cold-scan cost (a live web search per brand). Run weekly, the same cadence as
// nilCompJob.
//
//   node ./server/dealEvidenceWarm.js
//
// Railway: add a scheduled/cron service that runs this command weekly.
require('dotenv').config();

const ai = require('./ai');
const { pool } = require('./store');

(async () => {
  console.log('NILDash Deal Scan evidence pre-warm starting…', new Date().toISOString());
  try {
    const tally = await ai.prewarmDealEvidence({ force: true });
    // Record the run so we can see the cache is being kept warm.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deal_evidence_warm_log (
        id SERIAL PRIMARY KEY,
        run_at TIMESTAMPTZ DEFAULT NOW(),
        tally JSONB
      )
    `).catch(() => {});
    await pool.query('INSERT INTO deal_evidence_warm_log (tally) VALUES ($1)', [JSON.stringify(tally)]).catch(() => {});
    console.log('Pre-warm complete.', JSON.stringify(tally));
    process.exit(0);
  } catch (e) {
    console.error('Pre-warm failed:', e);
    process.exit(1);
  }
})();
