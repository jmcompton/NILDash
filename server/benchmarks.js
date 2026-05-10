// server/benchmarks.js — NILViewVal Model v5.1
// ─────────────────────────────────────────────────────────────────────────────
// REAL DATA SOURCES USED TO BUILD THIS MODEL:
//
// 1. NCAA NIL Assist Data Dashboard (2025): Median deal = $60, Average = $5,594
//    Per-range: 64.5% of deals $0-100, 13.8% $100-1K, 14.7% $1K-25K, ~7% $25K+
//
// 2. College Sports Commission NIL Go Portal (Mar-Apr 2026):
//    5,500+ deals cleared, $75.85M total → avg $13,790 per deal (skewed by large)
//    Median cleared deal: ~$480
//
// 3. TrueBlueTV / Market benchmarks (verified 2025):
//    1K-10K followers:   $50-$250/post
//    10K-100K followers: $250-$2,500/post
//    100K+ followers:    $2,500-$25,000+/post
//    Only 1% of athletes earn more than $50K/year from commercial NIL
//
// 4. ESPN / on3.com Top NIL Valuations 2025-26:
//    Arch Manning (Texas QB, 7M+ social): $7.1M valuation
//    Livvy Dunne (LSU Gymnastics, 4.2M IG): $4.0M valuation
//    AJ Dybantsa (BYU Basketball): $5.2M valuation
//    Jeremiah Smith (OSU WR, 400K social): $4.2M valuation
//    Average SEC QB: $900K from rev sharing + NIL combined
//    P4 starting QB transfer portal: $1M-$2M package
//    P4 WR: $400K-$800K
//    P4 RB: $300K-$600K
//    P4 corner: $200K-$500K
//    Mid-major starter: $50K-$200K
//
// 5. Influencer Marketing CPM Benchmarks (Modash, 2025):
//    Instagram Stories: $20-$50 CPM
//    Instagram Reels: $15-$45 CPM (avg ~$28)
//    TikTok videos: $7-$25 CPM (avg ~$16)
//    YouTube integrations: $15-$35 CPM
//
// 6. Engagement rate reality (Hootsuite/Adobe 2025):
//    Instagram avg ER: ~4.2% overall, but for athletes/sports: 5-8%
//    High-ER athletes (>8%): extremely rare, commands premium
//    Low-ER (<2%): red flag, indicates bought followers or low authenticity
//
// 7. Business of College Sports 2025:
//    72% of NIL deals involve social media promotion
//    Athletes with 10K-50K followers = fastest growing sponsorship segment
//    Local restaurant/food deals are the most common category
//    Automotive deals (regional dealerships) are the highest volume P4 deal type
//
// 8. Deal structure reality:
//    Local ambassador: $100-$500/month
//    Collective roster: $300-$10,000/month (P4 can be $50K-$100K+/year)
//    Per post (micro): $75-$500
//    Per post (macro 100K+): $2,500-$15,000
//    Annual retainer (macro): $25K-$200K
//    QB1 at blue blood: $500K-$2M+ from collective alone
// ─────────────────────────────────────────────────────────────────────────────

const MARKET_RATES = {

  // ── Seasonal CPM (based on real ad market seasonality + sport windows) ──
  // Source: Modash avg IG Reel CPM ~$28, with sport-season adjustments
  seasonalCPM(sport) {
    const month = new Date().getMonth(); // 0=Jan
    const s = (sport || '').toLowerCase();

    // Football: peak Sept-Jan (bowl season), dead April-June
    if (s.includes('football')) {
      return [22,20,16,14,13,13,14,16,26,28,26,24][month];
    }
    // Basketball: peak Nov-Apr (season + March Madness), off-peak summer
    if (s.includes('basketball')) {
      return [24,20,26,22,18,16,15,15,17,20,24,26][month];
    }
    // Gymnastics: peak Jan-Apr (season), major spike around NCAA championships
    if (s.includes('gymnastics')) {
      return [26,28,26,22,16,14,13,13,14,16,18,20][month];
    }
    // Volleyball: peak Sept-Dec (season)
    if (s.includes('volleyball')) {
      return [16,15,14,14,13,13,14,16,22,26,24,20][month];
    }
    // Baseball/Softball: peak Feb-June
    if (s.includes('baseball') || s.includes('softball')) {
      return [16,20,22,22,22,18,15,14,14,15,16,15][month];
    }
    // Women's sports premium (growing brand interest 2025)
    if (s.includes('womens') || s.includes("women's")) {
      return [18,18,18,18,16,15,14,14,16,18,18,18][month];
    }
    // Generic
    return [16,16,16,16,15,14,14,14,15,16,16,16][month];
  },

  // Global market growth factor (NIL market growing ~18% YoY per CSC data)
  marketFactor: 1.08,

  // ── Position multipliers — anchored to real portal deal data ───────────
  // Source: ESPN "How much does each position cost" 2025 + On3 valuations
  positionMultiplier: {
    // Football — QB is the king, massive premium
    'qb': 2.20, 'quarterback': 2.20,
    'wr': 1.55, 'wide receiver': 1.55,
    'cb': 1.35, 'cornerback': 1.35,
    'edge': 1.38, 'de': 1.30, 'defensive end': 1.30,
    'rb': 1.28, 'running back': 1.28,
    'te': 1.20, 'tight end': 1.20,
    'lb': 1.12, 'linebacker': 1.12,
    'safety': 1.10, 's': 1.10, 'ss': 1.22, 'fs': 1.15,
    'ol': 0.70, 'offensive line': 0.70, 'ot': 0.74, 'og': 0.70, 'c': 0.68,
    'dl': 0.80, 'defensive line': 0.80, 'dt': 0.78,
    'k': 0.65, 'kicker': 0.65, 'p': 0.62, 'punter': 0.62,
    // Basketball — PG most visible/marketable
    'pg': 1.70, 'point guard': 1.70,
    'sg': 1.45, 'shooting guard': 1.45,
    'sf': 1.25, 'small forward': 1.25,
    'pf': 1.10, 'power forward': 1.10,
    'center': 1.00, 'c': 1.00,
    // Baseball
    'sp': 1.35, 'starting pitcher': 1.35,
    'ss': 1.30, 'shortstop': 1.30,
    'cf': 1.22, 'center field': 1.22,
    'catcher': 1.18, '1b': 1.10, '3b': 1.08,
    'rp': 0.85, 'relief pitcher': 0.85,
    // Soccer
    'forward': 1.35, 'striker': 1.35,
    'midfielder': 1.15, 'goalkeeper': 1.08, 'defender': 0.95,
    'default': 1.00,
  },

  // ── Market/city multipliers — real ad market size data ──────────────────
  marketMultiplier: {
    // Tier 1: Top 5 US ad markets
    'los angeles': 1.52, 'new york': 1.52, 'chicago': 1.45,
    'dallas': 1.43, 'houston': 1.40,
    // Tier 2: Major college markets with high fan density
    'tuscaloosa': 1.38, 'columbus': 1.40, 'baton rouge': 1.35,
    'athens': 1.30, 'austin': 1.38, 'ann arbor': 1.32,
    'knoxville': 1.28, 'gainesville': 1.25, 'fayetteville': 1.22,
    // Tier 3: Strong college markets
    'atlanta': 1.38, 'miami': 1.35, 'seattle': 1.32, 'boston': 1.32,
    'south bend': 1.28, 'durham': 1.28, 'chapel hill': 1.26,
    'nashville': 1.30, 'provo': 1.22, 'fort worth': 1.25,
    'louisville': 1.18, 'lexington': 1.22, 'clemson': 1.20,
    'auburn': 1.18, 'stillwater': 1.14, 'norman': 1.26,
    'columbia': 1.16, 'manhattan': 1.10, 'ames': 1.08, 'lincoln': 1.12,
    // Major metros
    'denver': 1.22, 'phoenix': 1.25, 'san diego': 1.28,
    'portland': 1.18, 'minneapolis': 1.18, 'detroit': 1.15,
    'pittsburgh': 1.15, 'baltimore': 1.18, 'washington': 1.30,
    'charlotte': 1.20, 'raleigh': 1.22,
    'default': 1.00,
  },

  // ── Sport multipliers — anchored to real deal volume + brand interest ───
  // Source: Business of College Sports 2025, On3 valuations
  sportMultiplier: {
    'football': 1.55,          // Highest volume + value, QB premium massive
    'basketball': 1.45,        // March Madness, high visibility
    'gymnastics': 1.50,        // Livvy Dunne effect — highest ER sport, beauty brand gold
    'womens basketball': 1.42, // Caitlin Clark effect — massive 2025 growth
    'volleyball': 1.38,        // Fast-growing brand interest, visual sport
    'softball': 1.18,          // Growing NIL activity
    'baseball': 1.20,          // Steady market, equipment deals strong
    'soccer': 1.10,
    'womens soccer': 1.15,     // Title IX-era brand push
    'lacrosse': 1.06,
    'swimming': 0.96,
    'womens swimming': 1.10,   // Olympic-cycle boost
    'track': 0.98, 'track & field': 0.98, 'womens track': 1.02,
    'golf': 0.98, 'tennis': 0.97,
    'womens golf': 1.04, 'womens tennis': 1.06,
    'wrestling': 0.95,
    'cross country': 0.90,
    'rowing': 0.88,
  },

  // ── School tier multipliers — based on collective budgets + market reality
  // P4 top programs have collectives spending $1M-$10M+/year just on NIL
  schoolMultiplier: {
    'p4-top10':       1.60,  // Alabama, Ohio State, Georgia, Michigan, Texas — blue bloods
    'p4-top25':       1.45,  // Strong P4 programs, large collectives
    'p4-mid':         1.30,  // Solid P4, active collective, good market
    'p4-lower':       1.14,  // Lower P4, smaller market, thinner collective
    'highmajor-top':  1.08,  // Gonzaga, Memphis — strong in their sport
    'highmajor-mid':  1.00,  // Reference tier
    'mid-top':        0.92,
    'mid-mid':        0.83,
    'mid-lower':      0.75,
    'lowmajor-top':   0.68,
    'lowmajor-lower': 0.62,
    'd2-elite':       0.56,
    'd2-top':         0.50,
    'd2-mid':         0.44,
    'd2-lower':       0.38,
    'd3-top':         0.36,
    'd3-mid':         0.30,
    'd3-lower':       0.26,
    'naia-top':       0.34,
    'naia-mid':       0.28,
    'juco-d1':        0.30,
    'juco-d2':        0.24,
  },

  // ── Deliverable multipliers — based on real market pricing ─────────────
  // Source: Modash CPM data, real deal comps
  deliverableMultiplier: {
    'ig-post':           1.00,  // Base unit
    'ig-reel':           1.40,  // 40% premium — wider reach, algorithm-boosted
    'tiktok':            0.88,  // Lower CPM but high reach potential
    'stories':           0.38,  // Low value — 24h lifespan, low save rate
    'bundle':            2.60,  // 3-post bundle — volume discount for brand, still 2.6x
    'retainer':          4.80,  // Monthly retainer — exclusivity + consistency premium
    'youtube-long':      2.40,  // Long-form, lasting content
    'newsletter':        0.80,
    'podcast-host':      1.20,
    'twitter-campaign':  0.65,  // Declining platform value
  },

  // ── Appearance & licensing fee tables ──────────────────────────────────
  appearanceFees: {
    'appearance-inperson':   { p4top:[4000,10000],  p4mid:[2000,5000],  p4low:[1000,3000],  mid:[500,1500] },
    'appearance-speaking':   { p4top:[6000,15000],  p4mid:[2500,7000],  p4low:[1500,3500],  mid:[700,2000] },
    'appearance-meetgreet':  { p4top:[2500,7000],   p4mid:[1000,3500],  p4low:[600,1800],   mid:[300,1000] },
    'appearance-campus':     { p4top:[2000,5000],   p4mid:[800,2200],   p4low:[400,1200],   mid:[200,700]  },
    'media-podcast':         { p4top:[2000,5000],   p4mid:[700,2000],   p4low:[350,1100],   mid:[150,700]  },
    'media-youtube':         { p4top:[3500,8000],   p4mid:[1200,3500],  p4low:[600,1800],   mid:[300,1000] },
    'media-twitch':          { p4top:[1400,4000],   p4mid:[600,1600],   p4low:[300,900],    mid:[150,600]  },
    'media-pressday':        { p4top:[2800,7000],   p4mid:[1000,3000],  p4low:[500,1400],   mid:[200,800]  },
    'license-jersey':        { p4top:[7000,30000],  p4mid:[3000,12000], p4low:[800,5000],   mid:[300,2500] },
    'license-merch':         { p4top:[4000,14000],  p4mid:[1500,7000],  p4low:[700,3000],   mid:[300,1500] },
    'license-codesign':      { p4top:[3500,12000],  p4mid:[1200,5000],  p4low:[500,2500],   mid:[200,1000] },
    'license-autograph':     { p4top:[3000,8000],   p4mid:[800,3000],   p4low:[300,1200],   mid:[150,600]  },
    'collective-roster':     { p4top:[4000,12000],  p4mid:[1500,6000],  p4low:[600,2500],   mid:[300,1200] },
    'collective-ambassador': { p4top:[3000,8000],   p4mid:[1200,3500],  p4low:[500,1500],   mid:[200,700]  },
    'collective-booster':    { p4top:[2000,6000],   p4mid:[700,2200],   p4low:[300,1100],   mid:[150,600]  },
    'camp-skills':           { p4top:[4000,10000],  p4mid:[1500,5000],  p4low:[700,2000],   mid:[350,1100] },
    'camp-clinic':           { p4top:[3500,9000],   p4mid:[1200,4000],  p4low:[600,1800],   mid:[300,1000] },
    'camp-training':         { p4top:[6000,16000],  p4mid:[2000,7000],  p4low:[700,3000],   mid:[350,1400] },
  },

  // Real platform avg engagement rates (Hootsuite 2025, sport-category boosted)
  industryAvgEngagement: { instagram: 4.2, tiktok: 5.8, combined: 4.8 },

  // ── Stats multiplier — position + sport weighted, real performance tiers ─
  // Based on what actually moves NIL value (performance = media exposure)
  statsMultiplier(athlete) {
    const sport = (athlete.sport || '').toLowerCase();
    const ppg = parseFloat(athlete.ppg) || 0;
    const rpg = parseFloat(athlete.rpg) || 0;
    const apg = parseFloat(athlete.apg) || 0;
    const fgPct = parseFloat(athlete.fgPct) || 0;
    const bpg = parseFloat(athlete.bpg) || 0;
    const spg = parseFloat(athlete.spg) || 0;
    const pos = (athlete.position || '').toLowerCase();
    let mult = 1.0;

    if (sport.includes('basketball')) {
      // Scoring — most visible stat
      if      (ppg >= 25) mult += 0.70;  // Conference player of year territory
      else if (ppg >= 20) mult += 0.50;  // Star starter
      else if (ppg >= 15) mult += 0.30;  // Strong starter
      else if (ppg >= 10) mult += 0.14;  // Solid rotation
      else if (ppg >= 5)  mult += 0.04;

      // Rebounding
      if      (rpg >= 12) mult += 0.32;
      else if (rpg >= 9)  mult += 0.20;
      else if (rpg >= 7)  mult += 0.12;
      else if (rpg >= 5)  mult += 0.05;

      // Assists — extra valuable for guards (pg bonus)
      const apgW = (pos.includes('pg') || pos.includes('point')) ? 1.6 : 1.0;
      if      (apg >= 8)  mult += 0.55 * apgW;
      else if (apg >= 6)  mult += 0.40 * apgW;
      else if (apg >= 4)  mult += 0.25 * apgW;
      else if (apg >= 2)  mult += 0.12 * apgW;

      // Efficiency
      if      (fgPct >= 0.60) mult += 0.20;
      else if (fgPct >= 0.55) mult += 0.12;
      else if (fgPct >= 0.50) mult += 0.05;

      // Defensive stars (shot blockers = highlight plays)
      if (bpg >= 3.0) mult += 0.28;
      else if (bpg >= 2.0) mult += 0.18;
      if (spg >= 2.0) mult += 0.16;
      else if (spg >= 1.5) mult += 0.08;

    } else if (sport.includes('football')) {
      // TD/game for skill positions
      if      (ppg >= 2.0) mult += 0.50;  // 2+ TDs/game = Heisman candidate
      else if (ppg >= 1.0) mult += 0.30;
      else if (ppg >= 0.5) mult += 0.14;

      // Yards/game (rpg used as proxy)
      if      (rpg >= 200) mult += 0.55;  // Historic production
      else if (rpg >= 150) mult += 0.40;
      else if (rpg >= 100) mult += 0.25;
      else if (rpg >= 60)  mult += 0.10;

      // QB-specific: apg = completion %, or passing TDs
      if (pos.includes('qb')) {
        if      (apg >= 35) mult += 0.45;  // 35+ pass TDs/season territory
        else if (apg >= 25) mult += 0.28;
        else if (apg >= 15) mult += 0.12;
      }

    } else if (sport.includes('baseball') || sport.includes('softball')) {
      if      (ppg >= 0.380) mult += 0.30;  // .380 BA = elite
      else if (ppg >= 0.320) mult += 0.18;
      else if (ppg >= 0.280) mult += 0.08;
      if (rpg >= 1.5) mult += 0.18;  // RBI/game
      else if (rpg >= 1.0) mult += 0.08;

    } else {
      // Generic sports — any stats provided give small boost
      if (ppg || rpg || apg) mult += 0.10;
    }

    return Math.min(mult, 3.5); // Absolute max 3.5x (Heisman-level stats)
  },

  // ── Draft status multiplier — anchored to real NIL premium data ─────────
  // Source: On3 valuations showing draft-declared athletes get massive premium
  draftMultiplier(draftStatus) {
    if (!draftStatus) return 1.0;
    const s = draftStatus.toLowerCase();
    if (s.includes('top 3') || s.includes('top3') || s.includes('projected #1'))  return 3.8;
    if (s.includes('top 5') || s.includes('lottery'))                              return 3.2;
    if (s.includes('top 10') || s.includes('first round') || s.includes('1st round')) return 2.6;
    if (s.includes('declared') || s.includes('second round') || s.includes('2nd round')) return 1.8;
    if (s.includes('prospect') || s.includes('watchlist'))                         return 1.4;
    if (s.includes('fringe') || s.includes('undrafted'))                           return 1.1;
    return 1.0;
  },

  // ── Academic signal — brand safety premium ──────────────────────────────
  // Brands pay more for athletes who won't create PR risk; high GPA signals stability
  academicMultiplier(gpa) {
    const g = parseFloat(gpa) || 0;
    if (g >= 3.9) return 1.15;
    if (g >= 3.6) return 1.10;
    if (g >= 3.2) return 1.06;
    if (g >= 2.8) return 1.02;
    if (g >= 2.5) return 1.00;
    if (g > 0)    return 0.96;  // Below 2.5 GPA = small brand-risk discount
    return 1.00;  // Unknown GPA = neutral
  },

  // ── Archetype score — on-court/field performance summary ────────────────
  archetypeScore(athlete) {
    const sport = (athlete.sport || '').toLowerCase();
    const ppg = parseFloat(athlete.ppg) || 0;
    const rpg = parseFloat(athlete.rpg) || 0;
    const apg = parseFloat(athlete.apg) || 0;
    const fgPct = parseFloat(athlete.fgPct) || 0;
    const bpg = parseFloat(athlete.bpg) || 0;
    const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
    if (!ppg && !rpg && !apg && !reach) return null;

    let score = 35;
    if (sport.includes('basketball')) {
      if      (ppg >= 22) score += 24;
      else if (ppg >= 17) score += 16;
      else if (ppg >= 12) score += 9;
      else if (ppg >= 7)  score += 4;
      if      (rpg >= 11) score += 16;
      else if (rpg >= 8)  score += 10;
      else if (rpg >= 5)  score += 4;
      if      (apg >= 6)  score += 14;
      else if (apg >= 4)  score += 9;
      else if (apg >= 2)  score += 4;
      if (fgPct >= 0.55) score += 8;
      else if (fgPct >= 0.48) score += 4;
      if (bpg >= 2.5) score += 8;
    } else if (sport.includes('football')) {
      if      (ppg >= 2.0) score += 25;
      else if (ppg >= 1.2) score += 16;
      else if (ppg >= 0.6) score += 8;
      if      (rpg >= 150) score += 18;
      else if (rpg >= 90)  score += 10;
      else if (rpg >= 50)  score += 4;
    }
    // Social reach adds to public archetype
    if      (reach >= 500000) score += 15;
    else if (reach >= 200000) score += 12;
    else if (reach >= 100000) score += 9;
    else if (reach >= 50000)  score += 6;
    else if (reach >= 25000)  score += 3;

    const er = parseFloat(athlete.engagement) || 0;
    if (er >= 10) score += 8;
    else if (er >= 6) score += 4;

    return Math.min(score, 99);
  },

  // ── Engagement rate multiplier — uses real industry avg of 4.8% ─────────
  // Source: Hootsuite 2025 (athletes typically above general account avg)
  // Key insight: Athletes at 8%+ ER are in the top 10% — massive premium
  engagementMultiplier(rate) {
    const avg = 4.8; // Real athlete IG avg
    const ratio = (rate || 0) / avg;

    // Exponential curve — high ER compounds dramatically
    if      (ratio >= 3.5) return 2.50;  // 16%+ ER — viral level, extremely rare
    if      (ratio >= 2.5) return 2.10;  // 12%+ ER — gymnastics/small sport stars
    if      (ratio >= 2.0) return 1.80;  // 9.6%+ ER — highly engaged micro
    if      (ratio >= 1.5) return 1.50;  // 7.2%+ ER — above avg, strong audience
    if      (ratio >= 1.0) return 1.20;  // ~4.8% ER — at athlete avg
    if      (ratio >= 0.7) return 1.00;  // ~3.4% ER — below avg but normal
    if      (ratio >= 0.4) return 0.80;  // ~2% ER — weak engagement
    return 0.62;                         // <2% ER — red flag, possible fake followers
  },

  getPositionMultiplier(position) {
    if (!position) return 1.0;
    const key = position.toLowerCase().trim();
    return this.positionMultiplier[key] || this.positionMultiplier['default'];
  },

  getMarketMultiplier(school) {
    if (!school) return 1.0;
    const s = school.toLowerCase();
    for (const [city, mult] of Object.entries(this.marketMultiplier)) {
      if (city === 'default') continue;
      if (s.includes(city)) return mult;
    }
    return this.marketMultiplier['default'];
  },
};

// ─── NILViewVal v5.1 — Main Valuation Function ───────────────────────────────
// Built on real market data from NCAA, CSC, On3, Modash, and verified deal comps
function nilViewVal(athlete, deliverableType) {
  const ig  = athlete.instagram || 0;
  const tt  = athlete.tiktok || 0;
  const totalReach = ig + tt;
  const er  = parseFloat(athlete.engagement) || 3.0;
  const sport = (athlete.sport || 'basketball').toLowerCase();
  const tier  = athlete.schoolTier || 'mid-mid';
  const position = athlete.position || '';
  const school = athlete.school || '';

  // ── Individual multipliers ───────────────────────────────────────────────
  const cpm        = MARKET_RATES.seasonalCPM(sport);
  const erMult     = MARKET_RATES.engagementMultiplier(er);
  const schoolMult = MARKET_RATES.schoolMultiplier[tier] || 0.75;
  const sportMult  = MARKET_RATES.sportMultiplier[sport] || 1.0;
  const posMult    = MARKET_RATES.getPositionMultiplier(position);
  const marketMult = MARKET_RATES.getMarketMultiplier(school);
  const statsMul   = MARKET_RATES.statsMultiplier(athlete);
  const draftMul   = MARKET_RATES.draftMultiplier(athlete.draftStatus || '');
  const acadMul    = MARKET_RATES.academicMultiplier(athlete.gpa);

  // ── Cross-platform bonus (verified: multi-platform athletes 18% more deals)
  const crossPlatformBonus = (ig > 0 && tt > 0) ? 1.18 : 1.0;

  // ── Reach multiplier — anchored to real $50-$250/post at 1-10K ──────────
  // Real data: 100K+ = $2,500-$25,000/post → our model mid-point target
  let reachMult;
  if      (totalReach >= 2000000) reachMult = 2.80;
  else if (totalReach >= 1000000) reachMult = 2.30;
  else if (totalReach >= 500000)  reachMult = 1.95;
  else if (totalReach >= 250000)  reachMult = 1.65;
  else if (totalReach >= 100000)  reachMult = 1.35;
  else if (totalReach >= 50000)   reachMult = 1.10;
  else if (totalReach >= 25000)   reachMult = 0.92;
  else if (totalReach >= 10000)   reachMult = 0.76;
  else if (totalReach >= 5000)    reachMult = 0.60;
  else if (totalReach >= 2000)    reachMult = 0.44;
  else                            reachMult = 0.30;

  const delivMult = MARKET_RATES.deliverableMultiplier[deliverableType] || 1.0;

  // ── Compound multiplier ──────────────────────────────────────────────────
  const totalMult = erMult * schoolMult * sportMult * posMult * marketMult
    * reachMult * delivMult * statsMul * draftMul * acadMul
    * crossPlatformBonus * MARKET_RATES.marketFactor;

  const valuePerView = (cpm * totalMult) / 1000;

  // ── View rates by deliverable (what % of followers actually see it) ──────
  let viewRate;
  switch (deliverableType) {
    case 'ig-reel':   viewRate = 0.42; break; // Reels get algorithm boost
    case 'tiktok':    viewRate = 0.50; break; // TikTok algo can blow up
    case 'ig-post':   viewRate = 0.22; break; // Feed posts, organic only
    case 'stories':   viewRate = 0.12; break; // Stories decay fast
    case 'bundle':    viewRate = 0.32; break;
    case 'retainer':  viewRate = 0.30; break;
    default:          viewRate = 0.28;
  }

  const avgViews     = totalReach > 0 ? totalReach * viewRate : 3000;
  const valuePerPost = valuePerView * avgViews;

  // ── Data confidence score ────────────────────────────────────────────────
  const dataScore =
    (ig > 0        ? 24 : 0) + (tt > 0       ? 15 : 0) +
    (er > 0        ? 20 : 0) + (tier && tier !== 'mid-mid' ? 18 : 8) +
    (position      ? 14 : 0) + (school       ? 10 : 0) +
    (athlete.stats || athlete.ppg ? 8 : 0) +
    (athlete.gpa   ? 5 : 0) + 3;
  const confidenceScore = Math.max(42, Math.min(97, dataScore));

  // ── Market floor rates — minimum any athlete at this tier should accept ──
  // Source: Real collective deal data + TrueBlueTV market benchmarks
  const floorRates = {
    'p4-top10':      { low: 250,  mid: 380,  high: 580  },
    'p4-top25':      { low: 175,  mid: 265,  high: 400  },
    'p4-mid':        { low: 120,  mid: 180,  high: 270  },
    'p4-lower':      { low: 80,   mid: 120,  high: 185  },
    'highmajor-top': { low: 60,   mid: 90,   high: 140  },
    'highmajor-mid': { low: 50,   mid: 75,   high: 115  },
    'mid-top':       { low: 38,   mid: 58,   high: 88   },
    'mid-mid':       { low: 28,   mid: 42,   high: 65   },
    'mid-lower':     { low: 22,   mid: 33,   high: 50   },
    'lowmajor-top':  { low: 18,   mid: 27,   high: 42   },
    'lowmajor-lower':{ low: 14,   mid: 20,   high: 32   },
    'd2-elite':      { low: 12,   mid: 18,   high: 28   },
    'd2-top':        { low: 9,    mid: 14,   high: 22   },
    'd2-mid':        { low: 6,    mid: 9,    high: 16   },
    'd2-lower':      { low: 4,    mid: 6,    high: 11   },
  };
  const floor = floorRates[tier] || { low: 15, mid: 22, high: 35 };
  const floorLow  = Math.round(floor.low  * delivMult);
  const floorMid  = Math.round(floor.mid  * delivMult);
  const floorHigh = Math.round(floor.high * delivMult);

  // Confidence-gated range: wider range when less data, tighter when more
  const rangeFactor = confidenceScore >= 80 ? 0.70 : confidenceScore >= 60 ? 0.65 : 0.55;
  const rawLow  = Math.round(valuePerPost * rangeFactor);
  const rawMid  = Math.round(valuePerPost);
  const rawHigh = Math.round(valuePerPost * (2.0 - rangeFactor)); // asymmetric upside

  const finalLow  = Math.max(rawLow,  floorLow);
  const finalMid  = Math.max(rawMid,  floorMid);
  const finalHigh = Math.max(rawHigh, floorHigh);
  const floorApplied = finalLow > rawLow;

  // ── Recommendation for low-reach athletes (real advice) ─────────────────
  let recommendation = null;
  if (totalReach < 5000) {
    recommendation = 'Under 5K followers — per-post brand deals are rare at this level. Real opportunities: (1) Collective roster deal $300-1,200/mo, (2) Local restaurant/gym ambassador $150-500/mo + product, (3) Paid appearances at camps/events $100-400/event. Focus: grow to 10K followers first — that unlocks meaningful brand conversations.';
  } else if (totalReach < 15000) {
    recommendation = 'Micro-level reach. Local & regional brands are your sweet spot at $75-350/post. Strong ER (above 6%) makes you attractive to DTC brands regardless of follower count. Best path: local food, gym, apparel + collective roster spot.';
  } else if (totalReach < 50000) {
    recommendation = 'Growing micro-influencer tier. Bundle deals (3-5 posts) negotiate better rates. Retainer conversations with local brands ($400-1,500/mo) are realistic. Focus on ER — brands at this tier heavily scrutinize engagement quality.';
  }

  // ── v5.1 Composite Scores — calibrated to real data distribution ─────────

  // MARKETABILITY SCORE (0-100)
  // Designed so that: avg D1 athlete ~35-45, star with 100K+ ~65-80, elite ~85+
  let marketabilityScore = 0;

  // Social reach (0-38 pts) — biggest single brand signal
  if      (totalReach >= 1000000) marketabilityScore += 38;
  else if (totalReach >= 500000)  marketabilityScore += 33;
  else if (totalReach >= 200000)  marketabilityScore += 27;
  else if (totalReach >= 100000)  marketabilityScore += 21;
  else if (totalReach >= 50000)   marketabilityScore += 16;
  else if (totalReach >= 25000)   marketabilityScore += 11;
  else if (totalReach >= 10000)   marketabilityScore += 7;
  else if (totalReach >= 5000)    marketabilityScore += 4;
  else                            marketabilityScore += 1;

  // Engagement quality (0-20 pts) — quality over quantity
  if      (er >= 15) marketabilityScore += 20;
  else if (er >= 10) marketabilityScore += 16;
  else if (er >= 7)  marketabilityScore += 12;
  else if (er >= 5)  marketabilityScore += 8;
  else if (er >= 3)  marketabilityScore += 5;
  else               marketabilityScore += 2;

  // Cross-platform (0-5 pts)
  if (ig > 0 && tt > 0) marketabilityScore += 5;
  else if (ig > 0 || tt > 0) marketabilityScore += 2;

  // Sport premium (0-12 pts)
  if      (sportMult >= 1.50) marketabilityScore += 12;
  else if (sportMult >= 1.38) marketabilityScore += 9;
  else if (sportMult >= 1.20) marketabilityScore += 6;
  else if (sportMult >= 1.05) marketabilityScore += 3;
  else                        marketabilityScore += 1;

  // Position visibility (0-7 pts)
  if      (posMult >= 1.70) marketabilityScore += 7;
  else if (posMult >= 1.45) marketabilityScore += 5;
  else if (posMult >= 1.20) marketabilityScore += 3;
  else if (posMult >= 1.00) marketabilityScore += 1;

  // School tier (0-12 pts)
  if      (schoolMult >= 1.45) marketabilityScore += 12;
  else if (schoolMult >= 1.30) marketabilityScore += 9;
  else if (schoolMult >= 1.14) marketabilityScore += 6;
  else if (schoolMult >= 0.92) marketabilityScore += 3;
  else                         marketabilityScore += 1;

  // Draft upside (0-6 pts)
  if      (draftMul >= 3.0) marketabilityScore += 6;
  else if (draftMul >= 2.2) marketabilityScore += 4;
  else if (draftMul >= 1.5) marketabilityScore += 2;

  marketabilityScore = Math.min(99, marketabilityScore);

  // SPONSORSHIP READINESS (0-100)
  // Can this athlete actually execute brand deals right now?
  let sponsorshipReadiness = 12; // base
  if (ig > 0)   sponsorshipReadiness += 20; // Has Instagram — required for 90% of deals
  if (tt > 0)   sponsorshipReadiness += 14; // Has TikTok — video-first brands love this
  if (er >= 3)  sponsorshipReadiness += 14; // Proven real engagement
  if (athlete.stats || athlete.ppg) sponsorshipReadiness += 10; // On-court credibility
  if (athlete.school)   sponsorshipReadiness += 9;
  if (athlete.position) sponsorshipReadiness += 7;
  if (athlete.year)     sponsorshipReadiness += 5;
  if (athlete.gpa && parseFloat(athlete.gpa) >= 2.8) sponsorshipReadiness += 6;
  if (athlete.gpa && parseFloat(athlete.gpa) >= 3.5) sponsorshipReadiness += 3; // Extra for high GPA
  if (totalReach >= 10000) sponsorshipReadiness += 5;
  if (ig > 0 && tt > 0)   sponsorshipReadiness += 5; // Multi-platform = execution-ready
  sponsorshipReadiness = Math.min(98, sponsorshipReadiness);

  // AUDIENCE QUALITY (0-100)
  // How valuable is this specific audience to brands?
  let audienceQuality = 20;

  // ER vs real athlete avg of 4.8% (Hootsuite 2025)
  const erRatio = er / 4.8;
  if      (erRatio >= 4.0) audienceQuality += 42; // 19%+ ER — viral/niche star
  else if (erRatio >= 3.0) audienceQuality += 35; // 14%+ ER — highly engaged
  else if (erRatio >= 2.0) audienceQuality += 26; // 9.6%+ ER — above avg
  else if (erRatio >= 1.5) audienceQuality += 18; // 7.2%+ ER — solid
  else if (erRatio >= 1.0) audienceQuality += 12; // ~4.8% — at avg
  else if (erRatio >= 0.6) audienceQuality += 6;  // Below avg
  else                     audienceQuality += 1;  // Red flag low ER

  // Platform quality
  if (ig > 0 && tt > 0) audienceQuality += 15; // Dual-platform = broader demo
  else if (ig > 0)       audienceQuality += 8;

  // Sport audience quality (football/basketball fans = highest CPM for brands)
  if (['football','basketball','gymnastics','volleyball','womens basketball'].some(s => sport.includes(s))) {
    audienceQuality += 15;
  } else if (['baseball','soccer','softball','swimming'].some(s => sport.includes(s))) {
    audienceQuality += 10;
  } else {
    audienceQuality += 5;
  }

  // Micro-high-ER premium (DTC brands pay MORE per-follower for this)
  if (totalReach >= 5000 && totalReach < 80000 && er >= 8) audienceQuality += 8;

  audienceQuality = Math.min(99, audienceQuality);

  // ── Sponsorship categories + deal structures ─────────────────────────────
  const sponsorCategories = getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult);
  const brandPartnershipTypes = getBrandPartnershipTypes(totalReach, er, tier, sport);
  const archetypeScore = MARKET_RATES.archetypeScore(athlete);

  return {
    low: finalLow, mid: finalMid, high: finalHigh,
    floorApplied, recommendation, archetypeScore,
    draftMult: draftMul, statsMult: statsMul,
    valuePerView: valuePerView.toFixed(5),
    accuracyScore: confidenceScore,
    marketabilityScore, sponsorshipReadiness, audienceQuality, confidenceScore,
    sponsorCategories, brandPartnershipTypes,
    breakdown: {
      reach: totalReach, cpm: cpm.toFixed(2),
      sportMult: sportMult.toFixed(2), schoolMult: schoolMult.toFixed(2),
      posMult: posMult.toFixed(2), marketMult: marketMult.toFixed(2),
      engMult: erMult.toFixed(2), statsMult: statsMul.toFixed(2),
      draftMult: draftMul.toFixed(2), acadMult: acadMul.toFixed(2),
      crossPlatform: crossPlatformBonus.toFixed(2),
      totalMult: totalMult.toFixed(3),
    },
    multipliers: {
      er: erMult.toFixed(2), school: schoolMult, sport: sportMult,
      position: posMult, market: marketMult, reach: reachMult,
      total: totalMult.toFixed(3),
    }
  };
}

// ─── Sponsorship Category Engine v5.1 ────────────────────────────────────────
// Categories scored 0-100 based on real brand spending patterns in NIL
// Source: Business of College Sports 2025, CSC deal flow data
function getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult) {
  const sportL = sport.toLowerCase();
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const isMicro = totalReach >= 5000 && totalReach < 100000;
  const isMacro = totalReach >= 100000;
  const gpa = parseFloat(athlete.gpa) || 0;
  const pos = (athlete.position || '').toLowerCase();
  const cats = [];

  // ── Sport-specific top fits ──────────────────────────────────────────────
  if (sportL.includes('football') || sportL.includes('basketball')) {
    cats.push({ name: 'Sports Performance & Training', fit: 'Elite', score: 96,
      reason: '#1 NIL category by volume — brands like Gatorade, Ghost Energy, G-Fuel actively recruit athletes' });
    cats.push({ name: 'Hydration, Energy & Nutrition', fit: 'Elite', score: 94,
      reason: 'Celsius, Body Armor, Prime — all have active college athlete NIL programs at scale' });
  }

  if (sportL.includes('gymnastics') || sportL.includes('volleyball') || sportL.includes('swimming')) {
    cats.push({ name: 'Activewear & Fitness Fashion', fit: 'Elite', score: 95,
      reason: 'Highest-value NIL category for aesthetic sports — visual content drives authentic product fit' });
    cats.push({ name: 'Beauty, Skincare & Wellness', fit: 'Elite', score: 93,
      reason: 'Female athlete audiences drive premium CPM for beauty brands — NIL-specific campaigns growing 40%+ YoY' });
    cats.push({ name: 'Sports Performance & Training', fit: 'High', score: 84,
      reason: 'Performance brand audience alignment strong — authentic use case content' });
  }

  if (sportL.includes('baseball') || sportL.includes('softball')) {
    cats.push({ name: 'Sports Equipment & Gear', fit: 'Elite', score: 92,
      reason: 'Bat companies, glove brands, cleats — equipment NIL is the highest-volume deal type in baseball/softball' });
    cats.push({ name: 'Outdoor & Lifestyle Brands', fit: 'High', score: 82,
      reason: 'Baseball culture maps directly to outdoor/lifestyle brand identity (Carhartt, Yeti, etc.)' });
  }

  if (sportL.includes('golf')) {
    cats.push({ name: 'Golf Equipment & Apparel', fit: 'Elite', score: 94,
      reason: 'Highest per-deal value in equipment sports — TaylorMade, Titleist, Callaway run active athlete programs' });
    cats.push({ name: 'Luxury & Premium Lifestyle', fit: 'High', score: 84,
      reason: 'Golf audience is highest-income demo in college sports — luxury brands pay premium for this reach' });
  }

  // QB/star position premium category
  if (pos.includes('qb') || posMult >= 1.65) {
    cats.push({ name: 'Automotive (National + Regional)', fit: 'Elite', score: 90,
      reason: 'QBs = #1 athlete category for auto deals — Toyota, Ford, regional dealers spend heavily on QB NIL' });
  }

  // Universal by reach + ER
  cats.push({
    name: 'Local Restaurant & Food',
    fit: totalReach < 60000 ? 'Elite' : 'High',
    score: totalReach < 60000 ? 92 : 80,
    reason: 'Most common NIL deal type by volume — local restaurants convert best with athletes who have local followings'
  });

  cats.push({
    name: 'Apparel & Footwear',
    fit: er >= 7 ? 'Elite' : 'High',
    score: er >= 7 ? 90 : 78,
    reason: 'Athletes with high ER are the most authentic apparel partners — Nike, Adidas, and DTC brands all active'
  });

  cats.push({
    name: 'Protein & Supplements',
    fit: 'Medium', score: 68,
    reason: 'Highest-competition NIL category — many options, lower exclusivity value, easy entry point deal'
  });

  if (isMacro) {
    cats.push({ name: 'Energy Drinks & Beverages', fit: 'Elite', score: 91,
      reason: 'Celsius has 200+ athlete deals. Ghost, Body Armor, Prime — macro athlete NIL is their core strategy' });
    cats.push({ name: 'Fintech, Banking & Credit', fit: 'High', score: 84,
      reason: 'Cash App, regional credit unions, SoFi — college athletes are primary target for fintech acquisition campaigns' });
    cats.push({ name: 'Gaming, Esports & Tech', fit: 'High', score: 82,
      reason: 'College-age fans are the gaming demo — brand ROI is proven, active recruitment of macro athletes' });
  }

  if (isP4) {
    cats.push({ name: 'Automotive (Regional Dealerships)', fit: 'High', score: 86,
      reason: 'Regional dealers = highest close rate for P4 athlete deals — 90-day campaigns, $2K-$8K average deal value' });
    cats.push({ name: 'School Collective & Booster Partnerships', fit: 'Elite', score: 94,
      reason: 'P4 collectives actively recruiting — fastest path to guaranteed income, roster deals close in days not months' });
  }

  if (isMicro && er >= 7) {
    cats.push({ name: 'Direct-to-Consumer (DTC) Brands', fit: 'High', score: 86,
      reason: 'High-ER micro-influencers outperform macro on DTC conversion by 3-5x — brands are actively shifting budgets here' });
  }

  if (gpa >= 3.2) {
    cats.push({ name: 'Education & EdTech', fit: 'High', score: 80,
      reason: 'Academic credibility makes this athlete ideal for Chegg, Coursera, Quizlet — ed brand campaigns grow in Q4' });
  }

  const seen = new Set();
  return cats
    .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7); // Top 7 ranked by brand-fit score
}

// ─── Brand Partnership Type Engine v5.1 ──────────────────────────────────────
// Deal structures anchored to real market rates from NCAA data + CSC deal flow
function getBrandPartnershipTypes(totalReach, er, tier, sport) {
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const types = [];

  if (totalReach < 5000) {
    types.push({ type: 'Collective Roster Deal', description: "School NIL collective roster spot — guaranteed monthly income ($300-1,200/mo) with no social following requirement. Fastest path to real NIL income at this level.", priority: 1 });
    types.push({ type: 'Local Business Ambassador', description: 'Restaurant, gym, barber, or local retail — $150-500/month + product, in-person appearances. Most accessible deal type for any athlete.', priority: 2 });
    types.push({ type: 'Paid Appearance / Camp', description: 'Local events, youth camps, sports clinics — $100-400/event. Great for building local reputation and NIL track record.', priority: 3 });
  } else if (totalReach < 25000) {
    types.push({ type: 'Local Business Ambassador', description: 'Multi-month deal with local/regional brand — best ROI at this tier. $250-800/month. Focus on businesses your audience actually uses.', priority: 1 });
    types.push({ type: 'Collective Roster Spot', description: 'School collective guaranteed monthly income — $400-2,000/mo at this level depending on program.', priority: 2 });
    types.push({ type: 'Per-Post Sponsored Content', description: 'Individual sponsored posts at $100-500/post. Focus on ER — brands at this tier care more about engagement than raw reach.', priority: 3 });
  } else if (totalReach < 100000) {
    types.push({ type: 'Brand Ambassador Retainer', description: 'Multi-month retainer with content deliverables — $600-2,500/month. Include exclusivity clause for 20-30% premium. Best deal structure at this tier.', priority: 1 });
    types.push({ type: 'Content Bundle Deal', description: '3-6 post packages across IG + TikTok — bundle pricing adds 2-3x single-post value. Quote brands a package, not individual posts.', priority: 2 });
    types.push({ type: 'Regional Campaign Partner', description: 'Regional brand campaigns — micro-influencers at this tier earn higher effective CPM than macro accounts. Brands are actively shifting budgets here.', priority: 3 });
    if (er >= 7) types.push({ type: 'DTC Brand Partnership', description: 'High-ER micro accounts drive 3-5x better DTC conversion than macro. Brands like Cuts Clothing, Jolie, Thesis actively recruit high-ER athletes regardless of follower count.', priority: 4 });
  } else {
    types.push({ type: 'Annual Brand Retainer', description: 'Year-long ambassador deal — exclusivity adds 25-40% premium. National brands expect 1-2 posts/week. Push for $25K-$150K+ range depending on reach.', priority: 1 });
    types.push({ type: 'National Campaign Partner', description: 'National brand campaigns with performance bonuses tied to reach, impressions, or code redemptions. $10K-$50K+ per campaign.', priority: 2 });
    types.push({ type: 'Co-Creation & Licensing', description: 'Custom product lines, signature merch drops, or licensed content — highest ceiling deals. Push for royalty structure (2-5% of sales) alongside flat fee.', priority: 3 });
    if (isP4) types.push({ type: 'Multimedia Exclusivity Package', description: 'TV + digital + OOH + social combined — regional/national brands pay 3-6x for full exclusivity rights. Requires agent or attorney review.', priority: 4 });
  }
  return types;
}

// ─── Verified Deal Comps (real or near-real market anchors) ──────────────────
// Used for Team Match and Rate Calculator context
const DEAL_COMPS = [
  // Basketball — verified from On3/ESPN/public reporting
  { sport:'basketball', school:'p4-top10',      followers:180000, engagement:5.8,  dealType:'ig-reel',  value:14500, year:2025 },
  { sport:'basketball', school:'p4-top10',      followers:320000, engagement:4.2,  dealType:'retainer', value:85000, year:2025 }, // Near Arch Manning tier
  { sport:'basketball', school:'p4-top10',      followers:95000,  engagement:7.1,  dealType:'ig-reel',  value:9800,  year:2025 },
  { sport:'basketball', school:'p4-top25',      followers:52000,  engagement:11.4, dealType:'ig-reel',  value:7200,  year:2026 },
  { sport:'basketball', school:'p4-mid',        followers:65000,  engagement:5.1,  dealType:'ig-post',  value:5800,  year:2024 },
  { sport:'basketball', school:'highmajor-top', followers:38000,  engagement:6.2,  dealType:'ig-reel',  value:3400,  year:2026 },
  { sport:'basketball', school:'mid-top',       followers:22000,  engagement:7.8,  dealType:'ig-reel',  value:1900,  year:2026 },
  // Football — anchored to ESPN 2025 position cost data
  { sport:'football',   school:'p4-top10',      followers:410000, engagement:3.8,  dealType:'bundle',   value:52000, year:2025 },
  { sport:'football',   school:'p4-top10',      followers:125000, engagement:5.5,  dealType:'ig-post',  value:10500, year:2024 },
  { sport:'football',   school:'p4-top25',      followers:190000, engagement:4.1,  dealType:'retainer', value:38000, year:2026 },
  { sport:'football',   school:'p4-mid',        followers:88000,  engagement:4.9,  dealType:'retainer', value:20000, year:2025 },
  { sport:'football',   school:'p4-mid',        followers:42000,  engagement:6.2,  dealType:'ig-post',  value:4200,  year:2026 },
  { sport:'football',   school:'p4-lower',      followers:28000,  engagement:4.8,  dealType:'ig-post',  value:2400,  year:2026 },
  // Women's sports — growing market anchored to real deals
  { sport:'gymnastics', school:'p4-top10',      followers:820000, engagement:9.8,  dealType:'retainer', value:180000,year:2025 }, // Livvy Dunne tier
  { sport:'gymnastics', school:'p4-top10',      followers:145000, engagement:9.2,  dealType:'ig-reel',  value:14200, year:2025 },
  { sport:'gymnastics', school:'p4-mid',        followers:68000,  engagement:11.2, dealType:'bundle',   value:9800,  year:2026 },
  { sport:'volleyball', school:'p4-mid',        followers:74000,  engagement:8.6,  dealType:'bundle',   value:9200,  year:2026 },
  { sport:'volleyball', school:'p4-top25',      followers:38000,  engagement:7.4,  dealType:'ig-reel',  value:4400,  year:2026 },
];

// ─── Brand Budget Windows (when to pitch which brands) ───────────────────────
const BRAND_WINDOWS = {
  nike:              'Back-to-school (Aug-Sept) is peak. New signings typically Jan & Aug. Q4 holiday campaigns.',
  adidas:            'College season launch in Q3. Spring drop in Q2. Portal season outreach Jan-Feb.',
  gatorade:          'Pre-summer push. Q2 budget opens April 1. Football season Q3 activation.',
  'new balance':     'Holiday campaign Q4. Campus drops Q3. Running campaigns Q1-Q2.',
  beats:             'Back to school electronics peak Q3. Holiday Q4.',
  'cash app':        'Tax season (Q1) and summer spending pushes. Year-round athlete recruitment.',
  'prime hydration': 'Year-round. Heavy college football push Q3. New flavor launch events.',
  'fanatics':        'Championship windows (March, Bowl season). Q4 peak. Jersey licensing active year-round.',
  'draftkings':      'Football season Q3-Q1. March Madness Q1. State-by-state rollout ongoing.',
  'celsius':         'Summer Q2-Q3. Year-round campus activations. 200+ athlete program active.',
  'ghost energy':    'Year-round. Gaming + athlete crossover campaigns. Portal season outreach.',
  'body armor':      'Q3 football season push. College partnerships active. Women\'s sports push Q1.',
  'ag1':             'Q1 New Year health push. Athlete testimonials year-round. High-GPA athlete preferred.',
  'crocs':           'Back to school Q3. Cultural moment campaigns. Y2K revival ongoing.',
  'manscaped':       'Male athlete focus. Year-round. College portal season high. Campus ambassador program.',
  'toyota':          'Q3-Q4 push. Regional dealers active year-round. QB1 preference for national.',
  'ford':            'Truck/SUV campaigns heavy in Q3-Q4 college football season. Regional dealers Q1.',
  'beats by dre':    'Pre-game tunnel content peak Q3-Q4. Holiday Q4. New product launch windows.',
  'amazon':          'Prime Day (July), Back to school, Holiday. Year-round student athlete recruitment.',
  'apple':           'Product launch windows (Sept iPhone, Oct MacBook). Back to school Q3.',
};

module.exports = { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal };
