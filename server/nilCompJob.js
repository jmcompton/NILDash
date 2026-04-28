// NILDash — Automated Deal Comp Ingestion Job
// Runs weekly to pull disclosed NIL deals from web search and store as calibration data
// Called by: node ./server/nilCompJob.js

const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SEARCH_QUERIES = [
  "disclosed NIL deal 2026 college football transfer portal value",
  "NIL contract signed 2026 basketball player collective payment",
  "college athlete NIL deal announced 2026 dollar amount",
  "NIL collective payment 2026 transfer portal disclosed",
  "SEC Big Ten ACC NIL deal disclosed 2026 athlete signed",
  "NIL deal basketball 2026 signed announced value",
  "NIL deal football quarterback wide receiver 2026 disclosed",
  "On3 NIL valuation 2026 transfer portal deal signed",
];

const POSITIONS = ['qb','wr','rb','cb','edge','de','dt','ol','lb','s','pg','sg','sf','pf','c','f/c'];
const SPORTS = ['football','basketball','baseball','soccer','volleyball','softball','lacrosse','gymnastics'];
const TIERS = ['p4-top10','p4-top25','p4-mid','p4-lower','highmajor-top','highmajor-mid','mid-top','mid-mid'];

async function searchAndExtract(query) {
  try {
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
  "brand": "string (collective name or brand name)",
  "followers": number (estimated social following, 0 if unknown),
  "engagement": number (engagement rate 0-10, 3 if unknown),
  "year_in_school": "freshman|sophomore|junior|senior|unknown",
  "draft_status": "declared|first-round|second-round|not-eligible|unknown",
  "source_url": "string"
}
Only include deals with a real dollar amount disclosed. Return [] if no valid deals found.`,
      messages: [{ role: 'user', content: `Search for and extract NIL deal data from this query: "${query}". Find any disclosed NIL deals with specific dollar amounts mentioned.` }]
    });

    // Extract text from response
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (!textBlocks.length) return [];
    
    const text = textBlocks.map(b => b.text).join('');
    const jsonMatch = text.match(/\[.*\]/s);
    if (!jsonMatch) return [];
    
    const deals = JSON.parse(jsonMatch[0]);
    return Array.isArray(deals) ? deals : [];
  } catch(e) {
    console.error('Search error for query:', query, e.message);
    return [];
  }
}

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
      // Skip deals with no real value
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

  for (const query of SEARCH_QUERIES) {
    console.log('Searching:', query);
    const deals = await searchAndExtract(query);
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
  await pool.query('INSERT INTO ingestion_log (comps_saved) VALUES ($1)', [totalSaved]);
  
  process.exit(0);
}

// Load env vars
require('dotenv').config();
const { Pool } = require('pg');
const pg = new Pool({ connectionString: process.env.DATABASE_URL });
// Override pool with actual connection
Object.assign(pool, pg);

runIngestionJob().catch(e => {
  console.error('Job failed:', e);
  process.exit(1);
});
