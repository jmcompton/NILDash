// NILDash — Automated Deal Comp Ingestion Job
// Runs weekly to pull disclosed NIL deals from web search and store as calibration data
// Called by: node ./server/nilCompJob.js
require('dotenv').config();

const { pool } = require('./store');
// THE LEDGER NEEDS A POOL, AND ONLY ai.js WIRES ONE. This job runs as its own
// process and never loads ai.js, so without this every ledger row it queued
// would sit unflushed until process.exit dropped it.
const Ledger = require('./services/aiLedger');
Ledger.usePool(pool);
const Anthropic = require('@anthropic-ai/sdk');

// Built on first use, so requiring this file (tests read acceptDeal) never
// constructs a client without a key.
let _client = null;
const client = { get messages() { if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); return _client.messages; } };

// ── BRANDS THAT BUY ENDORSEMENTS, NOT WHOEVER WAS IN THE STORY ─────────────
// These queries used to ask for collective payments, transfer-portal values
// and On3 valuations, and the extraction asked for "collective name or brand
// name". The national lane then served collectives, athletic programs, On3
// and "College Football 2026 Cover Star" as sponsor prospects. The job exists
// to find COMPANIES THAT PAY ATHLETES FOR ENDORSEMENTS, so that is what it
// searches for and what it keeps (acceptDeal, below).
const SEARCH_QUERIES = [
  "brand signs college athlete NIL endorsement deal 2026",
  "company announces NIL partnership college athletes 2026 roster",
  "NIL endorsement deal brand ambassador college athlete 2026 signed",
  "consumer brand NIL deal women's college athlete 2026",
  "local business NIL sponsorship college athlete 2026 announced",
  "national brand NIL campaign college football basketball players 2026",
  "restaurant chain NIL deal college athletes 2026",
  "apparel beverage brand NIL deal college athlete 2026 amount",
];

const POSITIONS = ['qb','wr','rb','cb','edge','de','dt','ol','lb','s','pg','sg','sf','pf','c','f/c'];
const SPORTS = ['football','basketball','baseball','soccer','volleyball','softball','lacrosse','gymnastics'];
const TIERS = ['p4-top10','p4-top25','p4-mid','p4-lower','highmajor-top','highmajor-mid','mid-top','mid-mid'];

async function searchAndExtract(query) {
  try {
    // ── RECORDED EXPLICITLY, NOT RE-ROUTED ──────────────────────────────────
    // This uses Anthropic's server-side web_search tool. oneShotWebSearch would
    // move it to DeepSeek + Serper, which is a change of provider, not a change
    // of bookkeeping. It stays where it is and the ledger is written by hand --
    // including the searches, which Ledger.record reads off server_tool_use and
    // prices at Anthropic's $10 a thousand.
    const _t0 = Date.now();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      system: `You are a NIL market data researcher. Search for disclosed NIL deals and extract structured data.
Return ONLY a JSON array of deals found. Each deal must have these exact fields:
{
  "athlete_name": "string",
  "sport": "football|basketball|baseball|soccer|volleyball|other",
  "position": "string (e.g. QB, WR, PG, C, etc)",
  "school": "string",
  "school_tier": "p4-top10|p4-top25|p4-mid|p4-lower|highmajor-top|highmajor-mid|mid-top|mid-mid|unknown",
  "deal_value": number (annual value in dollars, 0 if unknown),
  "deal_type": "collective-roster|ig-reel|ig-post|retainer|bundle|appearance|endorsement|other",
  "brand": "string: the COMPANY that paid the athlete for an endorsement (e.g. a restaurant chain, an apparel or beverage brand, a car dealership, a bank). NEVER an NIL collective, a school, an athletic department, a team, a media or valuation site (On3, 247Sports), an NIL marketplace or agency, or an event. If the payer is not a company buying an endorsement, use null.",
  "payer_type": "brand|collective|school|media|platform|other",
  "followers": number (estimated social following, 0 if unknown),
  "engagement": number (engagement rate 0-10, 3 if unknown),
  "year_in_school": "freshman|sophomore|junior|senior|unknown",
  "draft_status": "declared|first-round|second-round|not-eligible|unknown",
  "source_url": "string"
}
Only include deals where a COMPANY paid for an endorsement. Deals paid by a collective, a school or a platform are NOT wanted: leave them out. Only include deals with a real dollar amount disclosed. Return [] if no valid deals found.`,
      messages: [{ role: 'user', content: `Search for and extract NIL deal data from this query: "${query}". Find NIL endorsement deals a company paid for, and name the company.` }]
    });
    Ledger.record(response,
      { model: 'claude-haiku-4-5-20251001', ms: Date.now() - _t0, site: 'nilcomps' });

    // Extract text from response
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (!textBlocks.length) return [];
    
    const text = textBlocks.map(b => b.text).join('');
    const jsonMatch = text.match(/\[.*\]/s);
    if (!jsonMatch) return [];
    
    const deals = JSON.parse(jsonMatch[0]);
    return Array.isArray(deals) ? deals : [];
  } catch(e) {
    // null, not []: a search that failed found nothing about the market, and
    // the run must be able to tell a quiet week from a broken one
    // (services/ourFault).
    console.error('Search error for query:', query, e.message);
    _searchErrors.push(e.message);
    return null;
  }
}
const _searchErrors = [];

async function saveDealsToComps(deals) {
  if (!deals.length) return 0;
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_comps (
      id SERIAL PRIMARY KEY,
      sport TEXT, school_tier TEXT, school TEXT, position TEXT,
      followers INTEGER, engagement NUMERIC, deal_type TEXT,
      deal_value INTEGER, brand TEXT, year_in_school TEXT,
      draft_status TEXT, ppg NUMERIC, rpg NUMERIC, apg NUMERIC,
      source TEXT, athlete_name TEXT, auto_ingested BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await pool.query(`ALTER TABLE deal_comps ADD COLUMN IF NOT EXISTS source TEXT`);
  await pool.query(`ALTER TABLE deal_comps ADD COLUMN IF NOT EXISTS athlete_name TEXT`);
  await pool.query(`ALTER TABLE deal_comps ADD COLUMN IF NOT EXISTS auto_ingested BOOLEAN DEFAULT false`);

  let saved = 0;
  for (const deal of deals) {
    try {
      // ONLY A COMPANY THAT BOUGHT AN ENDORSEMENT (acceptDeal).
      const why = acceptDeal(deal);
      if (why) { console.log(`Skipped: ${deal.brand || '(no brand)'} for ${deal.athlete_name || '?'}: ${why}`); continue; }
      // deal_comps is also the rate-calibration table: a deal with no disclosed
      // amount would pull those averages down, so the $1,000 floor stays.
      if (!deal.deal_value || deal.deal_value < 1000) continue;
      
      // Check for duplicate (same athlete + value + deal_type)
      const exists = await pool.query(
        'SELECT id FROM deal_comps WHERE athlete_name=$1 AND deal_value=$2 AND deal_type=$3',
        [deal.athlete_name || '', deal.deal_value, deal.deal_type || 'other']
      );
      if (exists.rows.length) continue;

      await pool.query(`
        INSERT INTO deal_comps (sport, school_tier, school, position, followers, engagement, deal_type, deal_value, brand, year_in_school, draft_status, source, athlete_name, auto_ingested)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
      `, [
        deal.sport || 'unknown',
        deal.school_tier || 'unknown',
        deal.school || '',
        deal.position || '',
        parseInt(deal.followers) || 0,
        parseFloat(deal.engagement) || 3.0,
        deal.deal_type || 'other',
        parseInt(deal.deal_value) || 0,
        deal.brand || '',
        deal.year_in_school || 'unknown',
        deal.draft_status || 'unknown',
        deal.source_url || '',
        deal.athlete_name || ''
      ]);
      saved++;
      console.log(`Saved: ${deal.athlete_name} - ${deal.sport} - $${deal.deal_value.toLocaleString()} (${deal.deal_type})`);
    } catch(e) {
      console.error('Save error:', e.message);
    }
  }
  return saved;
}

async function runIngestionJob() {
  console.log('NILDash Deal Comp Ingestion Job starting...', new Date().toISOString());
  let totalSaved = 0;
  let failedQueries = 0;

  for (const query of SEARCH_QUERIES) {
    console.log('Searching:', query);
    const deals = await searchAndExtract(query);
    if (deals === null) { failedQueries++; continue; }
    console.log(`Found ${deals.length} deals`);
    const saved = await saveDealsToComps(deals);
    totalSaved += saved;
    // Rate limit — wait 2 seconds between searches
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`Job complete. Total new comps saved: ${totalSaved}`);
  
  // Log job run
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_log (id SERIAL PRIMARY KEY, run_at TIMESTAMPTZ DEFAULT NOW(), comps_saved INTEGER)
  `);
  // The failures ride on the row: comps_saved=0 with failed_queries=12 is a
  // broken week, not a quiet one.
  await pool.query(`ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS failed_queries INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE ingestion_log ADD COLUMN IF NOT EXISTS error TEXT`).catch(() => {});
  await pool.query('INSERT INTO ingestion_log (comps_saved, failed_queries, error) VALUES ($1, $2, $3)',
    [totalSaved, failedQueries, _searchErrors[0] ? String(_searchErrors[0]).slice(0, 500) : null]);
  if (failedQueries && failedQueries >= SEARCH_QUERIES.length) {
    console.error(`Job FAILED: all ${failedQueries} searches failed on our side: ${_searchErrors[0]}`);
    await pool.query(`INSERT INTO service_faults (service, reason, context) VALUES ('nil-comps', $1, 'nilCompJob')`,
      [`all ${failedQueries} searches failed: ${String(_searchErrors[0] || '').slice(0, 400)}`]).catch(() => {});
    await Ledger.drain();
    process.exit(1);
  }

  // Written before exit, or the searches this run paid for never reach the
  // ledger: process.exit does not wait for the flush that record() scheduled.
  await Ledger.drain();
  process.exit(0);
}

// null when the deal is a company buying an endorsement, else why it is not.
// (The $1,000 disclosed-value floor is applied separately, in the save.)
function acceptDeal(deal) {
  const d = deal || {};
  const brand = String(d.brand || '').trim();
  if (!brand) return 'no company named as the payer';
  const pt = String(d.payer_type || 'brand').toLowerCase();
  if (pt && pt !== 'brand') return `paid by a ${pt}, not a company buying an endorsement`;
  const hit = require('./services/notASponsor').detect(brand, {});
  if (hit) return hit.why;
  if (!String(d.athlete_name || '').trim()) return 'no athlete named';
  return null;
}

module.exports = { acceptDeal, SEARCH_QUERIES };

if (require.main === module) {
  runIngestionJob().catch(async (e) => {
    console.error('Job failed:', e);
    // A failed run still spent what it spent.
    await Ledger.drain().catch(() => {});
    process.exit(1);
  });
}
