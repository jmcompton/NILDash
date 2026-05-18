// server/benchmarks.js — NILViewVal Model v5.2
// ─────────────────────────────────────────────────────────────────────────────
// REAL DATA SOURCES:
// • NCAA NIL Assist Dashboard 2025: Median deal=$60, Average=$5,594
// • CSC NIL Go Portal Mar-Apr 2026: 5,500+ deals, $75.85M total
// • TrueBlueTV / Market data 2025: 1K-10K=$50-250/post, 10K-100K=$250-2,500, 100K+=$2,500-25K+
// • On3/ESPN Top NIL Valuations 2025-26: Arch Manning $7.1M, Livvy Dunne $4M, Jeremiah Smith $4.2M
// • ESPN 2025: P4 QB portal = $1M-$2M, WR = $400K-$800K, RB = $300-600K
// • Modash CPM Benchmarks 2025: IG Reels $15-45, Stories $20-50, TikTok $7-25
// • Influenceflow Rate Cards 2025: Nano $200-800/Reel, Micro $1K-5K/Reel, Mid $5K-25K/Reel
// • Hootsuite 2025: Athlete avg IG ER = 4.2%, TikTok 5-8%
// • Business of College Sports 2025: 72% deals = social, 10K-50K fastest growing tier
// • EA Sports CFB 26: $1,500/player for video game licensing (base rate)
// • StudentAthleteInsights 2025: Athletes want fewer, better deals; finance/tech/beverage top wanted
// ─────────────────────────────────────────────────────────────────────────────

const MARKET_RATES = {
  baseCPM: 28.0, // Real IG Reel avg CPM (Modash 2025)

  seasonalCPM(sport) {
    const month = new Date().getMonth();
    const s = (sport || '').toLowerCase();
    if (s.includes('football'))
      return [22,20,16,14,13,13,14,16,26,28,26,24][month];
    if (s.includes('basketball'))
      return [24,20,26,22,18,16,15,15,17,20,24,26][month];
    if (s.includes('gymnastics'))
      return [26,28,26,22,16,14,13,13,14,16,18,20][month];
    if (s.includes('volleyball'))
      return [16,15,14,14,13,13,14,16,22,26,24,20][month];
    if (s.includes('baseball') || s.includes('softball'))
      return [16,20,22,22,22,18,15,14,14,15,16,15][month];
    if (s.includes('womens') || s.includes("women's"))
      return [18,18,18,18,16,15,14,14,16,18,18,18][month];
    return [16,16,16,16,15,14,14,14,15,16,16,16][month];
  },

  marketFactor: 1.08,

  // ── Position multipliers (ESPN portal data 2025) ─────────────────────────
  positionMultiplier: {
    'qb': 2.20, 'quarterback': 2.20,
    'pg': 1.70, 'point guard': 1.70,
    'wr': 1.55, 'wide receiver': 1.55,
    'sg': 1.45, 'shooting guard': 1.45,
    'cb': 1.35, 'cornerback': 1.35,
    'edge': 1.38, 'de': 1.30, 'defensive end': 1.30,
    'rb': 1.28, 'running back': 1.28,
    'sf': 1.25, 'small forward': 1.25,
    'te': 1.20, 'tight end': 1.20,
    'lb': 1.12, 'linebacker': 1.12,
    'safety': 1.10, 's': 1.10, 'ss': 1.22, 'fs': 1.15,
    'pf': 1.10, 'power forward': 1.10,
    'center': 1.00, 'c': 1.00,
    'sp': 1.35, 'starting pitcher': 1.35,
    'cf': 1.22, 'center field': 1.22,
    'catcher': 1.18, '1b': 1.10, '3b': 1.08,
    'ol': 0.70, 'offensive line': 0.70, 'ot': 0.74, 'og': 0.70,
    'dl': 0.80, 'defensive line': 0.80, 'dt': 0.78,
    'k': 0.65, 'kicker': 0.65, 'p': 0.62, 'punter': 0.62,
    'forward': 1.35, 'striker': 1.35,
    'midfielder': 1.15, 'goalkeeper': 1.08, 'defender': 0.95,
    'default': 1.00,
  },

  // ── Market multipliers ───────────────────────────────────────────────────
  marketMultiplier: {
    'los angeles': 1.52, 'new york': 1.52, 'chicago': 1.45,
    'dallas': 1.43, 'houston': 1.40, 'tuscaloosa': 1.38,
    'columbus': 1.40, 'baton rouge': 1.35, 'athens': 1.30,
    'austin': 1.38, 'ann arbor': 1.32, 'knoxville': 1.28,
    'gainesville': 1.25, 'fayetteville': 1.22, 'atlanta': 1.38,
    'miami': 1.35, 'seattle': 1.32, 'boston': 1.32,
    'south bend': 1.28, 'durham': 1.28, 'chapel hill': 1.26,
    'nashville': 1.30, 'provo': 1.22, 'fort worth': 1.25,
    'louisville': 1.18, 'lexington': 1.22, 'clemson': 1.20,
    'auburn': 1.18, 'stillwater': 1.14, 'norman': 1.26,
    'columbia': 1.16, 'manhattan': 1.10, 'ames': 1.08, 'lincoln': 1.12,
    'denver': 1.22, 'phoenix': 1.25, 'san diego': 1.28,
    'portland': 1.18, 'minneapolis': 1.18, 'detroit': 1.15,
    'pittsburgh': 1.15, 'baltimore': 1.18, 'washington': 1.30,
    'charlotte': 1.20, 'raleigh': 1.22, 'starkville': 1.07,
    'default': 1.00,
  },

  // ── Sport multipliers ────────────────────────────────────────────────────
  sportMultiplier: {
    'football': 1.55, 'basketball': 1.45,
    'gymnastics': 1.50, 'womens basketball': 1.42,
    'volleyball': 1.38, 'baseball': 1.20,
    'softball': 1.18, 'soccer': 1.10,
    'womens soccer': 1.15, 'lacrosse': 1.06,
    'swimming': 0.96, 'womens swimming': 1.10,
    'track': 0.98, 'track & field': 0.98, 'womens track': 1.02,
    'golf': 0.98, 'tennis': 0.97,
    'womens golf': 1.04, 'womens tennis': 1.06,
    'wrestling': 0.95, 'cross country': 0.90, 'rowing': 0.88,
  },

  // ── School tier multipliers ──────────────────────────────────────────────
  schoolMultiplier: {
    'p4-top10': 1.60, 'p4-top25': 1.45, 'p4-mid': 1.30, 'p4-lower': 1.14,
    'highmajor-top': 1.08, 'highmajor-mid': 1.00,
    'mid-top': 0.92, 'mid-mid': 0.83, 'mid-lower': 0.75,
    'lowmajor-top': 0.68, 'lowmajor-lower': 0.62,
    'd2-elite': 0.56, 'd2-top': 0.50, 'd2-mid': 0.44, 'd2-lower': 0.38,
    'd3-top': 0.36, 'd3-mid': 0.30, 'd3-lower': 0.26,
    'naia-top': 0.34, 'naia-mid': 0.28,
    'juco-d1': 0.30, 'juco-d2': 0.24,
  },

  // ── Social media deliverable multipliers (CPM-based) ────────────────────
  // Source: Modash 2025, Influenceflow 2025
  // These are used for CPM-math deliverables only.
  // Non-social deliverables use flat-fee tables (see nilViewVal switch).
  socialDeliverableMult: {
    'ig-reel':         1.40,  // Algorithm-boosted, wider reach, premium format
    'ig-post':         1.00,  // Base unit
    'ig-carousel':     1.15,  // Multi-image posts save faster, higher engagement
    'tiktok':          0.88,  // Lower CPM but high organic reach potential
    'tiktok-spark':    1.20,  // Spark ads (paid boost) = higher effective value
    'youtube-short':   0.75,  // Shorts: high reach, lower brand recall than long-form
    'youtube-long':    2.40,  // Dedicated 8-15 min video — highest brand recall
    'youtube-int':     1.35,  // YouTube integration (60-90 sec mid-roll mention)
    'stories':         0.38,  // 24h lifespan, low save rate — always bundle
    'story-bundle':    0.65,  // 5-7 story sequence with link — better than singles
    'newsletter':      0.80,  // Email feature — niche but high conversion
    'podcast-host':    1.20,  // Host-read ad — high trust, long shelf life
    'twitter-campaign':0.55,  // X/Twitter declining; still relevant for sports
    'threads':         0.50,  // Early-stage platform, low brand spend
    'bundle':          2.60,  // IG Reel + Post + Story — standard bundle
    'bundle-cross':    3.20,  // IG + TikTok + Story — cross-platform premium
    'retainer':        4.80,  // Monthly retainer — exclusivity + volume discount
    // UGC — paid for content rights, not distribution
    'ugc-photo':       0.90,  // Brand uses your photo in their ads
    'ugc-video':       1.80,  // Brand uses your video in their ads (highest DTC value)
  },

  // ── Appearance & flat-fee tables by school tier ──────────────────────────
  // Source: TrueBlueTV, ESPN, verified NIL market data
  appearanceFees: {
    // Social / content (non-CPM flat rates for specific deliverable types)
    'ig-reel':         null,  // CPM-based
    'ig-post':         null,
    'tiktok':          null,
    'stories':         null,
    'story-bundle':    null,
    'ig-carousel':     null,
    'tiktok-spark':    null,
    'youtube-short':   null,
    'youtube-long':    null,
    'youtube-int':     null,
    'newsletter':      null,
    'podcast-host':    null,
    'twitter-campaign':null,
    'threads':         null,
    'bundle':          null,
    'bundle-cross':    null,
    'retainer':        null,
    'ugc-photo':       null,
    'ugc-video':       null,

    // Appearances & Events (flat fee, not CPM)
    'appearance-inperson':   { p4top:[4500,12000], p4mid:[2000,5500],  p4low:[1000,3000],  mid:[500,1600],   low:[200,700]  },
    'appearance-speaking':   { p4top:[7000,18000], p4mid:[3000,8000],  p4low:[1500,4000],  mid:[800,2200],   low:[300,900]  },
    'appearance-meetgreet':  { p4top:[3000,8000],  p4mid:[1200,3500],  p4low:[600,2000],   mid:[300,1100],   low:[150,500]  },
    'appearance-campus':     { p4top:[2000,5500],  p4mid:[800,2500],   p4low:[400,1200],   mid:[200,750],    low:[100,350]  },
    'appearance-virtual':    { p4top:[1000,3000],  p4mid:[500,1500],   p4low:[250,800],    mid:[100,400],    low:[50,200]   },

    // Content & Media (flat fee)
    'media-podcast':         { p4top:[2000,5500],  p4mid:[700,2200],   p4low:[350,1200],   mid:[150,700],    low:[50,300]   },
    'media-youtube':         { p4top:[4000,10000], p4mid:[1500,4000],  p4low:[700,2000],   mid:[300,1200],   low:[100,500]  },
    'media-twitch':          { p4top:[1500,4500],  p4mid:[700,1800],   p4low:[300,1000],   mid:[150,650],    low:[50,250]   },
    'media-pressday':        { p4top:[3000,8000],  p4mid:[1200,3000],  p4low:[500,1500],   mid:[200,900],    low:[75,350]   },
    'media-documentary':     { p4top:[5000,20000], p4mid:[2000,8000],  p4low:[1000,4000],  mid:[400,2000],   low:[150,700]  },

    // Licensing & Brand (flat fee or royalty)
    'license-jersey':        { p4top:[8000,35000], p4mid:[3000,14000], p4low:[900,5000],   mid:[300,2500],   low:[100,800]  },
    'license-merch':         { p4top:[5000,16000], p4mid:[2000,8000],  p4low:[800,3500],   mid:[300,1800],   low:[100,600]  },
    'license-codesign':      { p4top:[4000,14000], p4mid:[1500,6000],  p4low:[600,3000],   mid:[250,1500],   low:[100,500]  },
    'license-autograph':     { p4top:[3500,10000], p4mid:[1000,3500],  p4low:[350,1400],   mid:[150,700],    low:[50,250]   },
    'license-videogame':     { p4top:[2000,8000],  p4mid:[1500,4000],  p4low:[1500,3000],  mid:[600,2000],   low:[300,800]  }, // EA Sports: $1,500 base, stars negotiate up
    'license-trading-card':  { p4top:[1500,6000],  p4mid:[800,2500],   p4low:[400,1200],   mid:[150,600],    low:[50,200]   },
    'license-nft-digital':   { p4top:[2000,8000],  p4mid:[800,3000],   p4low:[300,1200],   mid:[100,500],    low:[50,200]   },

    // Collective / School (monthly flat)
    'collective-roster':     { p4top:[4500,14000], p4mid:[1800,7000],  p4low:[700,3000],   mid:[300,1500],   low:[150,600]  },
    'collective-ambassador': { p4top:[3500,10000], p4mid:[1500,4000],  p4low:[600,2000],   mid:[250,900],    low:[100,400]  },
    'collective-booster':    { p4top:[2500,7000],  p4mid:[900,2500],   p4low:[350,1300],   mid:[150,700],    low:[75,300]   },
    'collective-exclusive':  { p4top:[8000,25000], p4mid:[3000,10000], p4low:[1200,5000],  mid:[500,2500],   low:[200,900]  },

    // Camps & Clinics (per event)
    'camp-skills':           { p4top:[4500,12000], p4mid:[1800,5000],  p4low:[800,2500],   mid:[400,1300],   low:[150,600]  },
    'camp-clinic':           { p4top:[4000,10000], p4mid:[1500,4500],  p4low:[700,2000],   mid:[300,1200],   low:[125,500]  },
    'camp-training':         { p4top:[7000,20000], p4mid:[2500,8000],  p4low:[900,3500],   mid:[400,1800],   low:[150,700]  },
    'camp-elite':            { p4top:[10000,30000],p4mid:[4000,12000], p4low:[1500,6000],  mid:[600,3000],   low:[200,1000] },
  },

  industryAvgEngagement: { instagram: 4.2, tiktok: 5.8, combined: 4.8 },

  // ── Stats multiplier ─────────────────────────────────────────────────────
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
      if (ppg >= 25) mult += 0.70; else if (ppg >= 20) mult += 0.50;
      else if (ppg >= 15) mult += 0.30; else if (ppg >= 10) mult += 0.14; else if (ppg >= 5) mult += 0.04;
      if (rpg >= 12) mult += 0.32; else if (rpg >= 9) mult += 0.20;
      else if (rpg >= 7) mult += 0.12; else if (rpg >= 5) mult += 0.05;
      const apgW = (pos.includes('pg') || pos.includes('point')) ? 1.6 : 1.0;
      if (apg >= 8) mult += 0.55 * apgW; else if (apg >= 6) mult += 0.40 * apgW;
      else if (apg >= 4) mult += 0.25 * apgW; else if (apg >= 2) mult += 0.12 * apgW;
      if (fgPct >= 0.60) mult += 0.20; else if (fgPct >= 0.55) mult += 0.12; else if (fgPct >= 0.50) mult += 0.05;
      if (bpg >= 3.0) mult += 0.28; else if (bpg >= 2.0) mult += 0.18;
      if (spg >= 2.0) mult += 0.16; else if (spg >= 1.5) mult += 0.08;
    } else if (sport.includes('football')) {
      if (ppg >= 2.0) mult += 0.50; else if (ppg >= 1.0) mult += 0.30; else if (ppg >= 0.5) mult += 0.14;
      if (rpg >= 200) mult += 0.55; else if (rpg >= 150) mult += 0.40;
      else if (rpg >= 100) mult += 0.25; else if (rpg >= 60) mult += 0.10;
      if (pos.includes('qb')) {
        if (apg >= 35) mult += 0.45; else if (apg >= 25) mult += 0.28; else if (apg >= 15) mult += 0.12;
      }
    } else if (sport.includes('baseball') || sport.includes('softball')) {
      if (ppg >= 0.380) mult += 0.30; else if (ppg >= 0.320) mult += 0.18; else if (ppg >= 0.280) mult += 0.08;
      if (rpg >= 1.5) mult += 0.18; else if (rpg >= 1.0) mult += 0.08;
    } else {
      if (ppg || rpg || apg) mult += 0.10;
    }
    return Math.min(mult, 3.5);
  },

  draftMultiplier(draftStatus) {
    if (!draftStatus) return 1.0;
    const s = draftStatus.toLowerCase();
    if (s.includes('top 3') || s.includes('projected #1')) return 3.8;
    if (s.includes('top 5') || s.includes('lottery')) return 3.2;
    if (s.includes('top 10') || s.includes('first round') || s.includes('1st round')) return 2.6;
    if (s.includes('declared') || s.includes('second round') || s.includes('2nd round')) return 1.8;
    if (s.includes('prospect') || s.includes('watchlist')) return 1.4;
    if (s.includes('fringe') || s.includes('undrafted')) return 1.1;
    return 1.0;
  },

  academicMultiplier(gpa) {
    const g = parseFloat(gpa) || 0;
    if (g >= 3.9) return 1.15; if (g >= 3.6) return 1.10;
    if (g >= 3.2) return 1.06; if (g >= 2.8) return 1.02;
    if (g >= 2.5) return 1.00; if (g > 0) return 0.96;
    return 1.00;
  },

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
      if (ppg >= 22) score += 24; else if (ppg >= 17) score += 16;
      else if (ppg >= 12) score += 9; else if (ppg >= 7) score += 4;
      if (rpg >= 11) score += 16; else if (rpg >= 8) score += 10; else if (rpg >= 5) score += 4;
      if (apg >= 6) score += 14; else if (apg >= 4) score += 9; else if (apg >= 2) score += 4;
      if (fgPct >= 0.55) score += 8; else if (fgPct >= 0.48) score += 4;
      if (bpg >= 2.5) score += 8;
    } else if (sport.includes('football')) {
      if (ppg >= 2.0) score += 25; else if (ppg >= 1.2) score += 16; else if (ppg >= 0.6) score += 8;
      if (rpg >= 150) score += 18; else if (rpg >= 90) score += 10; else if (rpg >= 50) score += 4;
    }
    if (reach >= 500000) score += 15; else if (reach >= 200000) score += 12;
    else if (reach >= 100000) score += 9; else if (reach >= 50000) score += 6;
    else if (reach >= 25000) score += 3;
    const er = parseFloat(athlete.engagement) || 0;
    if (er >= 10) score += 8; else if (er >= 6) score += 4;
    return Math.min(score, 99);
  },

  engagementMultiplier(rate) {
    const avg = 4.8;
    const ratio = (rate || 0) / avg;
    if (ratio >= 3.5) return 2.50;
    if (ratio >= 2.5) return 2.10;
    if (ratio >= 2.0) return 1.80;
    if (ratio >= 1.5) return 1.50;
    if (ratio >= 1.0) return 1.20;
    if (ratio >= 0.7) return 1.00;
    if (ratio >= 0.4) return 0.80;
    return 0.62;
  },

  getPositionMultiplier(position) {
    if (!position) return 1.0;
    return this.positionMultiplier[position.toLowerCase().trim()] || this.positionMultiplier['default'];
  },

  getMarketMultiplier(school) {
    if (!school) return 1.0;
    const s = school.toLowerCase();
    for (const [city, mult] of Object.entries(this.marketMultiplier)) {
      if (city !== 'default' && s.includes(city)) return mult;
    }
    return this.marketMultiplier['default'];
  },

  // ── Helper: tier key for flat-fee table lookup ────────────────────────
  getTierKey(tier) {
    if (!tier) return 'mid';
    const t = tier.toLowerCase();
    if (t.startsWith('p4-top1') || t === 'p4-top10') return 'p4top';
    if (t.startsWith('p4') || t.startsWith('highmajor')) return 'p4mid';
    if (t.startsWith('mid')) return 'p4low';
    if (t.startsWith('low') || t.startsWith('d2')) return 'mid';
    return 'low';
  },
};

// ─── Deliverable Type Classifier ─────────────────────────────────────────────
// Returns 'social' (CPM-math) or 'flat' (use appearance fee table)
function getDeliverableClass(type) {
  const socialTypes = new Set([
    'ig-reel','ig-post','ig-carousel','tiktok','tiktok-spark',
    'youtube-short','youtube-long','youtube-int',
    'stories','story-bundle','newsletter','podcast-host',
    'twitter-campaign','threads','bundle','bundle-cross','retainer',
    'ugc-photo','ugc-video'
  ]);
  return socialTypes.has(type) ? 'social' : 'flat';
}

// ─── NILViewVal v5.2 — Main Valuation Function ───────────────────────────────
function nilViewVal(athlete, deliverableType) {
  const ig  = athlete.instagram || 0;
  const tt  = athlete.tiktok || 0;
  const totalReach = ig + tt;
  const er  = parseFloat(athlete.engagement) || 3.0;
  const sport = (athlete.sport || 'basketball').toLowerCase();
  const tier  = athlete.schoolTier || 'mid-mid';
  const position = athlete.position || '';
  const school = athlete.school || '';

  const delivClass = getDeliverableClass(deliverableType);

  // ── FLAT FEE PATH: appearances, licensing, camps, collectives, media ────
  if (delivClass === 'flat') {
    const feeTable = MARKET_RATES.appearanceFees[deliverableType];
    if (feeTable) {
      const tierKey = MARKET_RATES.getTierKey(tier);
      const range = feeTable[tierKey] || feeTable['mid'] || [100, 400];

      // Apply sport, draft, and stats modifiers to the flat rate
      const sportMult  = MARKET_RATES.sportMultiplier[sport] || 1.0;
      const draftMul   = MARKET_RATES.draftMultiplier(athlete.draftStatus || '');
      const statsMul   = MARKET_RATES.statsMultiplier(athlete);
      const posMult    = MARKET_RATES.getPositionMultiplier(position);
      const acadMul    = MARKET_RATES.academicMultiplier(athlete.gpa);
      const erMult     = MARKET_RATES.engagementMultiplier(er);
      const marketMult = MARKET_RATES.getMarketMultiplier(school);

      // For flat fee, only use the performance-related mults (not reach-based)
      const flatMod = (sportMult * posMult * draftMul * statsMul * acadMul * erMult * marketMult * MARKET_RATES.marketFactor);
      const clampedMod = Math.max(0.5, Math.min(flatMod, 4.0)); // cap extreme swings

      const finalLow  = Math.round(range[0] * clampedMod);
      const finalMid  = Math.round((range[0] + range[1]) / 2 * clampedMod);
      const finalHigh = Math.round(range[1] * clampedMod);

      const dataScore = (ig > 0 ? 18 : 0) + (tier && tier !== 'mid-mid' ? 22 : 10) +
        (position ? 16 : 0) + (school ? 12 : 0) + (athlete.ppg ? 8 : 0) + (athlete.gpa ? 5 : 0) + 5;
      const confidenceScore = Math.max(42, Math.min(95, dataScore));

      const sponsorCategories = getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult);
      const brandPartnershipTypes = getBrandPartnershipTypes(totalReach, er, tier, sport);
      const archetypeScore = MARKET_RATES.archetypeScore(athlete);

      const { mkt, spr, aq } = calcCompositeScores(ig, tt, totalReach, er, sport, sportMult, posMult, tier, draftMul, school);

      return {
        low: finalLow, mid: finalMid, high: finalHigh,
        floorApplied: false, recommendation: null, archetypeScore,
        draftMult: draftMul, statsMult: statsMul,
        valuePerView: '0.00000', accuracyScore: confidenceScore,
        marketabilityScore: mkt, sponsorshipReadiness: spr, audienceQuality: aq,
        confidenceScore, sponsorCategories, brandPartnershipTypes,
        breakdown: {
          reach: totalReach, sportMult: sportMult.toFixed(2),
          schoolMult: MARKET_RATES.schoolMultiplier[tier]?.toFixed(2) || '0.83',
          posMult: posMult.toFixed(2), marketMult: marketMult.toFixed(2),
          engMult: erMult.toFixed(2), cpm: 'N/A (flat fee)',
          statsMult: statsMul.toFixed(2), draftMult: draftMul.toFixed(2),
          acadMult: acadMul.toFixed(2), crossPlatform: '1.00',
          totalMult: clampedMod.toFixed(3),
        },
        multipliers: { er: erMult.toFixed(2), school: MARKET_RATES.schoolMultiplier[tier] || 0.83,
          sport: sportMult, position: posMult, market: marketMult, reach: 1.0,
          total: clampedMod.toFixed(3) }
      };
    }
  }

  // ── SOCIAL / CPM PATH ────────────────────────────────────────────────────
  const cpm        = MARKET_RATES.seasonalCPM(sport);
  const erMult     = MARKET_RATES.engagementMultiplier(er);
  const schoolMult = MARKET_RATES.schoolMultiplier[tier] || 0.75;
  const sportMult  = MARKET_RATES.sportMultiplier[sport] || 1.0;
  const posMult    = MARKET_RATES.getPositionMultiplier(position);
  const marketMult = MARKET_RATES.getMarketMultiplier(school);
  const statsMul   = MARKET_RATES.statsMultiplier(athlete);
  const draftMul   = MARKET_RATES.draftMultiplier(athlete.draftStatus || '');
  const acadMul    = MARKET_RATES.academicMultiplier(athlete.gpa);
  const crossPlatformBonus = (ig > 0 && tt > 0) ? 1.18 : 1.0;

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

  const delivMult = MARKET_RATES.socialDeliverableMult[deliverableType] || 1.00;

  const totalMult = erMult * schoolMult * sportMult * posMult * marketMult
    * reachMult * delivMult * statsMul * draftMul * acadMul
    * crossPlatformBonus * MARKET_RATES.marketFactor;

  const valuePerView = (cpm * totalMult) / 1000;

  let viewRate;
  switch (deliverableType) {
    case 'ig-reel':      viewRate = 0.42; break;
    case 'ig-carousel':  viewRate = 0.35; break;
    case 'tiktok':       viewRate = 0.50; break;
    case 'tiktok-spark': viewRate = 0.65; break;
    case 'youtube-short':viewRate = 0.55; break;
    case 'youtube-long': viewRate = 0.30; break;
    case 'youtube-int':  viewRate = 0.32; break;
    case 'ig-post':      viewRate = 0.22; break;
    case 'stories':      viewRate = 0.12; break;
    case 'story-bundle': viewRate = 0.18; break;
    case 'ugc-photo':    viewRate = 0.10; break; // UGC = brand audience, not athlete's
    case 'ugc-video':    viewRate = 0.10; break;
    default:             viewRate = 0.28;
  }

  const avgViews     = totalReach > 0 ? totalReach * viewRate : 3000;
  const valuePerPost = valuePerView * avgViews;

  const dataScore =
    (ig > 0 ? 24 : 0) + (tt > 0 ? 15 : 0) + (er > 0 ? 20 : 0) +
    (tier && tier !== 'mid-mid' ? 18 : 8) + (position ? 14 : 0) +
    (school ? 10 : 0) + (athlete.ppg ? 8 : 0) + (athlete.gpa ? 5 : 0) + 3;
  const confidenceScore = Math.max(42, Math.min(97, dataScore));

  // ── Social floor rates anchored to real market data ──────────────────────
  // Source: TrueBlueTV: 1K-10K=$50-250/post, 10K-100K=$250-2500, 100K+=$2500-25K+
  // Floors are per BASE unit (ig-post). delivMult applied to scale other formats.
  const floorRates = {
    'p4-top10':       { low: 250,  mid: 380,  high: 580  },
    'p4-top25':       { low: 175,  mid: 265,  high: 400  },
    'p4-mid':         { low: 120,  mid: 180,  high: 270  },
    'p4-lower':       { low: 80,   mid: 120,  high: 185  },
    'highmajor-top':  { low: 60,   mid: 90,   high: 140  },
    'highmajor-mid':  { low: 50,   mid: 75,   high: 115  },
    'mid-top':        { low: 38,   mid: 58,   high: 88   },
    'mid-mid':        { low: 28,   mid: 42,   high: 65   },
    'mid-lower':      { low: 22,   mid: 33,   high: 50   },
    'lowmajor-top':   { low: 18,   mid: 27,   high: 42   },
    'lowmajor-lower': { low: 14,   mid: 20,   high: 32   },
    'd2-elite':       { low: 12,   mid: 18,   high: 28   },
    'd2-top':         { low: 9,    mid: 14,   high: 22   },
    'd2-mid':         { low: 6,    mid: 9,    high: 16   },
    'd2-lower':       { low: 4,    mid: 6,    high: 11   },
  };
  const floor = floorRates[tier] || { low: 15, mid: 22, high: 35 };
  const floorLow  = Math.round(floor.low  * delivMult);
  const floorMid  = Math.round(floor.mid  * delivMult);
  const floorHigh = Math.round(floor.high * delivMult);

  const rangeFactor = confidenceScore >= 80 ? 0.70 : confidenceScore >= 60 ? 0.65 : 0.55;
  const rawLow  = Math.round(valuePerPost * rangeFactor);
  const rawMid  = Math.round(valuePerPost);
  const rawHigh = Math.round(valuePerPost * (2.0 - rangeFactor));

  const finalLow  = Math.max(rawLow,  floorLow);
  const finalMid  = Math.max(rawMid,  floorMid);
  const finalHigh = Math.max(rawHigh, floorHigh);
  const floorApplied = finalLow > rawLow;

  let recommendation = null;
  if (totalReach < 5000) {
    recommendation = 'Under 5K followers — per-post brand deals are rare. Focus on: (1) Collective roster deal $300-1,200/mo, (2) Local ambassador $150-500/mo + product, (3) Paid appearances $100-400/event. Grow to 10K first.';
  } else if (totalReach < 15000) {
    recommendation = 'Micro-level reach. Local & regional brands your sweet spot at $75-400/post. Strong ER (6%+) makes you attractive to DTC brands regardless of follower count.';
  } else if (totalReach < 50000) {
    recommendation = 'Growing micro tier. Bundle deals (3-5 posts) negotiate better. Retainer conversations ($500-1,500/mo) are realistic. Focus on ER — brands scrutinize engagement quality at this level.';
  }

  const { mkt, spr, aq } = calcCompositeScores(ig, tt, totalReach, er, sport, sportMult, posMult, tier, draftMul, school);

  const sponsorCategories = getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult);
  const brandPartnershipTypes = getBrandPartnershipTypes(totalReach, er, tier, sport);
  const archetypeScore = MARKET_RATES.archetypeScore(athlete);

  return {
    low: finalLow, mid: finalMid, high: finalHigh,
    floorApplied, recommendation, archetypeScore,
    draftMult: draftMul, statsMult: statsMul,
    valuePerView: valuePerView.toFixed(5), accuracyScore: confidenceScore,
    marketabilityScore: mkt, sponsorshipReadiness: spr, audienceQuality: aq,
    confidenceScore, sponsorCategories, brandPartnershipTypes,
    breakdown: {
      reach: totalReach, cpm: cpm.toFixed(2),
      sportMult: sportMult.toFixed(2), schoolMult: schoolMult.toFixed(2),
      posMult: posMult.toFixed(2), marketMult: marketMult.toFixed(2),
      engMult: erMult.toFixed(2), statsMult: statsMul.toFixed(2),
      draftMult: draftMul.toFixed(2), acadMult: acadMul.toFixed(2),
      crossPlatform: crossPlatformBonus.toFixed(2), totalMult: totalMult.toFixed(3),
    },
    multipliers: {
      er: erMult.toFixed(2), school: schoolMult, sport: sportMult,
      position: posMult, market: marketMult, reach: reachMult,
      total: totalMult.toFixed(3),
    }
  };
}

// ─── Composite Score Calculator (shared between social + flat paths) ──────────
function calcCompositeScores(ig, tt, totalReach, er, sport, sportMult, posMult, tier, draftMul, school) {
  const schoolMult = MARKET_RATES.schoolMultiplier[tier] || 0.83;

  let mkt = 0;
  if      (totalReach >= 1000000) mkt += 38; else if (totalReach >= 500000)  mkt += 33;
  else if (totalReach >= 200000)  mkt += 27; else if (totalReach >= 100000)  mkt += 21;
  else if (totalReach >= 50000)   mkt += 16; else if (totalReach >= 25000)   mkt += 11;
  else if (totalReach >= 10000)   mkt += 7;  else if (totalReach >= 5000)    mkt += 4;
  else mkt += 1;
  if (er >= 15) mkt += 20; else if (er >= 10) mkt += 16; else if (er >= 7) mkt += 12;
  else if (er >= 5) mkt += 8; else if (er >= 3) mkt += 5; else mkt += 2;
  if (ig > 0 && tt > 0) mkt += 5; else if (ig > 0 || tt > 0) mkt += 2;
  if (sportMult >= 1.50) mkt += 12; else if (sportMult >= 1.38) mkt += 9;
  else if (sportMult >= 1.20) mkt += 6; else if (sportMult >= 1.05) mkt += 3; else mkt += 1;
  if (posMult >= 1.70) mkt += 7; else if (posMult >= 1.45) mkt += 5;
  else if (posMult >= 1.20) mkt += 3; else if (posMult >= 1.00) mkt += 1;
  if (schoolMult >= 1.45) mkt += 12; else if (schoolMult >= 1.30) mkt += 9;
  else if (schoolMult >= 1.14) mkt += 6; else if (schoolMult >= 0.92) mkt += 3; else mkt += 1;
  if (draftMul >= 3.0) mkt += 6; else if (draftMul >= 2.2) mkt += 4; else if (draftMul >= 1.5) mkt += 2;
  mkt = Math.min(99, mkt);

  let spr = 12;
  if (ig > 0) spr += 20; if (tt > 0) spr += 14; if (er >= 3) spr += 14;
  spr += (totalReach >= 10000 ? 5 : 0) + (ig > 0 && tt > 0 ? 5 : 0);
  spr = Math.min(98, spr);

  let aq = 20;
  const erRatio = er / 4.8;
  if (erRatio >= 4.0) aq += 42; else if (erRatio >= 3.0) aq += 35;
  else if (erRatio >= 2.0) aq += 26; else if (erRatio >= 1.5) aq += 18;
  else if (erRatio >= 1.0) aq += 12; else if (erRatio >= 0.6) aq += 6; else aq += 1;
  if (ig > 0 && tt > 0) aq += 15; else if (ig > 0) aq += 8;
  const sportL = sport.toLowerCase();
  if (['football','basketball','gymnastics','volleyball','womens basketball'].some(s => sportL.includes(s))) aq += 15;
  else if (['baseball','soccer','softball','swimming'].some(s => sportL.includes(s))) aq += 10;
  else aq += 5;
  if (totalReach >= 5000 && totalReach < 80000 && er >= 8) aq += 8;
  aq = Math.min(99, aq);

  return { mkt, spr, aq };
}

// ─── Sponsorship Category Engine ─────────────────────────────────────────────
function getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult) {
  const sportL = sport.toLowerCase();
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const isMicro = totalReach >= 5000 && totalReach < 100000;
  const isMacro = totalReach >= 100000;
  const gpa = parseFloat(athlete.gpa) || 0;
  const pos = (athlete.position || '').toLowerCase();
  const cats = [];

  if (sportL.includes('football') || sportL.includes('basketball')) {
    cats.push({ name: 'Sports Performance & Training', fit: 'Elite', score: 96, reason: '#1 NIL category by volume — Gatorade, Ghost, G-Fuel all actively recruit' });
    cats.push({ name: 'Hydration, Energy & Nutrition', fit: 'Elite', score: 94, reason: 'Celsius has 200+ athlete deals. Body Armor, Prime, Ghost = active NIL programs' });
  }
  if (sportL.includes('gymnastics') || sportL.includes('volleyball') || sportL.includes('swimming')) {
    cats.push({ name: 'Activewear & Fitness Fashion', fit: 'Elite', score: 95, reason: 'Highest-value NIL category for aesthetic sports — visual content drives authentic fit' });
    cats.push({ name: 'Beauty, Skincare & Wellness', fit: 'Elite', score: 93, reason: 'Female athlete audience = premium CPM for beauty brands — NIL campaigns up 40%+ YoY' });
  }
  if (sportL.includes('baseball') || sportL.includes('softball')) {
    cats.push({ name: 'Sports Equipment & Gear', fit: 'Elite', score: 92, reason: 'Equipment NIL is highest-volume deal type in baseball — bat/glove/cleat brands active' });
    cats.push({ name: 'Outdoor & Lifestyle Brands', fit: 'High', score: 82, reason: 'Baseball culture maps directly to outdoor brand identity (Carhartt, Yeti, etc.)' });
  }
  if (sportL.includes('golf')) {
    cats.push({ name: 'Golf Equipment & Apparel', fit: 'Elite', score: 94, reason: 'TaylorMade, Titleist, Callaway = active athlete programs, highest per-deal in equipment' });
    cats.push({ name: 'Luxury & Premium Lifestyle', fit: 'High', score: 84, reason: 'Golf audience = highest-income demo in college sports — luxury brands pay premium CPM' });
  }
  if (pos.includes('qb') || posMult >= 1.65) {
    cats.push({ name: 'Automotive (National + Regional)', fit: 'Elite', score: 90, reason: 'QBs = #1 athlete category for auto deals — Toyota, Ford, regional dealers spend heavily' });
  }
  cats.push({ name: 'Local Restaurant & Food', fit: totalReach < 60000 ? 'Elite' : 'High', score: totalReach < 60000 ? 92 : 80, reason: 'Most common NIL deal type by volume — local food converts best with local followings' });
  cats.push({ name: 'Apparel & Footwear', fit: er >= 7 ? 'Elite' : 'High', score: er >= 7 ? 90 : 78, reason: 'High-ER athletes are the most authentic apparel partners — Nike, Adidas, DTC brands active' });
  cats.push({ name: 'Protein & Supplements', fit: 'Medium', score: 68, reason: 'Highest-competition NIL category — easy entry point but low exclusivity value' });
  if (isMacro) {
    cats.push({ name: 'Energy Drinks & Beverages', fit: 'Elite', score: 91, reason: 'Celsius (200+ athletes), Ghost, Body Armor, Prime — macro athlete NIL is their core strategy' });
    cats.push({ name: 'Fintech, Banking & Credit', fit: 'High', score: 84, reason: '#1 most-wanted brand category by athletes (StudentAthleteInsights 2025) — Cash App, SoFi, regional CUs active' });
    cats.push({ name: 'Gaming & Esports', fit: 'High', score: 82, reason: 'College-age fans = gaming demo. EA Sports, Logitech, NZXT actively recruit macro athletes' });
  }
  if (isP4) {
    cats.push({ name: 'Automotive (Regional Dealerships)', fit: 'High', score: 86, reason: 'Regional dealers = highest close rate for P4 deals — 90-day campaigns, $2K-$8K avg value' });
    cats.push({ name: 'School Collective & Booster Partnerships', fit: 'Elite', score: 94, reason: 'P4 collectives recruiting actively — fastest path to guaranteed income, closes in days' });
  }
  if (isMicro && er >= 7) {
    cats.push({ name: 'Direct-to-Consumer (DTC) Brands', fit: 'High', score: 86, reason: 'High-ER micro outperforms macro on DTC conversion 3-5x — brands shifting budgets here' });
  }
  if (gpa >= 3.2) {
    cats.push({ name: 'Education & EdTech', fit: 'High', score: 80, reason: 'Academic credibility = ideal for Chegg, Coursera, Quizlet — ed brands push hard Q4' });
  }
  const seen = new Set();
  return cats
    .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7);
}

// ─── Brand Partnership Type Engine ───────────────────────────────────────────
function getBrandPartnershipTypes(totalReach, er, tier, sport) {
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const types = [];
  if (totalReach < 5000) {
    types.push({ type: 'Collective Roster Deal', description: "School NIL collective roster spot — guaranteed monthly income ($300-1,200/mo) with no social requirement. Fastest path to real NIL income.", priority: 1 });
    types.push({ type: 'Local Business Ambassador', description: 'Restaurant, gym, barber, local retail — $150-500/month + product. Most accessible deal type at this reach.', priority: 2 });
    types.push({ type: 'Paid Appearance / Camp', description: 'Local events, youth camps, clinics — $100-400/event. Builds local reputation and NIL track record.', priority: 3 });
  } else if (totalReach < 25000) {
    types.push({ type: 'Local Business Ambassador', description: 'Multi-month deal with local/regional brand — best ROI at this tier. $250-800/month. Target businesses your audience uses.', priority: 1 });
    types.push({ type: 'Collective Roster Spot', description: 'School collective guaranteed monthly income — $400-2,000/mo depending on program.', priority: 2 });
    types.push({ type: 'Per-Post Sponsored Content', description: 'Individual posts at $100-500/post. ER matters more than reach — brands at this tier care about engagement quality.', priority: 3 });
  } else if (totalReach < 100000) {
    types.push({ type: 'Brand Ambassador Retainer', description: 'Multi-month retainer with content deliverables — $600-2,500/month. Add exclusivity clause for 20-30% premium.', priority: 1 });
    types.push({ type: 'Cross-Platform Bundle Deal', description: 'IG Reel + TikTok + Story packages — cross-platform bundles add 40-60% vs single-post rates. Quote packages not individual posts.', priority: 2 });
    types.push({ type: 'Regional Campaign Partner', description: 'Regional brands pay higher CPM to micro-influencers than macro — actively shifting budgets here in 2025.', priority: 3 });
    if (er >= 7) types.push({ type: 'UGC Content License', description: 'Brands buy your content to run in their ads — separate from posting fee. $500-2,000/video for usage rights. DTC brands especially active.', priority: 4 });
  } else {
    types.push({ type: 'Annual Brand Retainer', description: 'Year-long ambassador deal — exclusivity adds 25-40% premium. National brands expect 1-2 posts/week. Target $25K-$150K+ range.', priority: 1 });
    types.push({ type: 'National Campaign Partner', description: 'Brand campaigns with performance bonuses tied to impressions or code redemptions. $10K-$50K+ per campaign.', priority: 2 });
    types.push({ type: 'Co-Creation & Licensing', description: 'Custom product lines, signature merch, licensed content — highest ceiling deals. Push for royalty structure (2-5%) + flat fee.', priority: 3 });
    if (isP4) types.push({ type: 'Multimedia Exclusivity Package', description: 'TV + digital + OOH + social combined — regional/national brands pay 3-6x for full exclusivity. Requires attorney review.', priority: 4 });
  }
  return types;
}

// ─── Deal Comps ───────────────────────────────────────────────────────────────
const DEAL_COMPS = [
  { sport:'basketball', school:'p4-top10',      followers:180000, engagement:5.8,  dealType:'ig-reel',  value:14500,  year:2025 },
  { sport:'basketball', school:'p4-top10',      followers:320000, engagement:4.2,  dealType:'retainer', value:85000,  year:2025 },
  { sport:'basketball', school:'p4-top10',      followers:95000,  engagement:7.1,  dealType:'ig-reel',  value:9800,   year:2025 },
  { sport:'basketball', school:'p4-top25',      followers:52000,  engagement:11.4, dealType:'ig-reel',  value:7200,   year:2026 },
  { sport:'basketball', school:'p4-mid',        followers:65000,  engagement:5.1,  dealType:'ig-post',  value:5800,   year:2024 },
  { sport:'basketball', school:'highmajor-top', followers:38000,  engagement:6.2,  dealType:'ig-reel',  value:3400,   year:2026 },
  { sport:'basketball', school:'mid-top',       followers:22000,  engagement:7.8,  dealType:'ig-reel',  value:1900,   year:2026 },
  { sport:'football',   school:'p4-top10',      followers:410000, engagement:3.8,  dealType:'bundle',   value:52000,  year:2025 },
  { sport:'football',   school:'p4-top10',      followers:125000, engagement:5.5,  dealType:'ig-post',  value:10500,  year:2024 },
  { sport:'football',   school:'p4-top25',      followers:190000, engagement:4.1,  dealType:'retainer', value:38000,  year:2026 },
  { sport:'football',   school:'p4-mid',        followers:88000,  engagement:4.9,  dealType:'retainer', value:20000,  year:2025 },
  { sport:'football',   school:'p4-mid',        followers:42000,  engagement:6.2,  dealType:'ig-post',  value:4200,   year:2026 },
  { sport:'football',   school:'p4-lower',      followers:28000,  engagement:4.8,  dealType:'ig-post',  value:2400,   year:2026 },
  { sport:'gymnastics', school:'p4-top10',      followers:820000, engagement:9.8,  dealType:'retainer', value:180000, year:2025 },
  { sport:'gymnastics', school:'p4-top10',      followers:145000, engagement:9.2,  dealType:'ig-reel',  value:14200,  year:2025 },
  { sport:'gymnastics', school:'p4-mid',        followers:68000,  engagement:11.2, dealType:'bundle',   value:9800,   year:2026 },
  { sport:'volleyball', school:'p4-mid',        followers:74000,  engagement:8.6,  dealType:'bundle',   value:9200,   year:2026 },
  { sport:'volleyball', school:'p4-top25',      followers:38000,  engagement:7.4,  dealType:'ig-reel',  value:4400,   year:2026 },
  { sport:'football',   school:'p4-top10',      followers:180000, engagement:6.1,  dealType:'appearance-inperson', value:8500, year:2026 },
  { sport:'basketball', school:'p4-top10',      followers:95000,  engagement:5.8,  dealType:'camp-skills', value:6000, year:2025 },
];

// ─── Brand Budget Windows ─────────────────────────────────────────────────────
const BRAND_WINDOWS = {
  nike:              'Back-to-school (Aug-Sept) is peak. New signings Jan & Aug. Q4 holiday campaigns.',
  adidas:            'College season launch Q3. Spring drop Q2. Portal season outreach Jan-Feb.',
  gatorade:          'Pre-summer push. Q2 budget opens April 1. Football season Q3 activation.',
  'new balance':     'Holiday campaign Q4. Campus drops Q3. Running campaigns Q1-Q2.',
  beats:             'Back to school electronics peak Q3. Holiday Q4.',
  'cash app':        'Tax season Q1 and summer spending pushes. Year-round athlete recruitment.',
  'prime hydration': 'Year-round. Heavy college football push Q3. New flavor launch events.',
  'fanatics':        'Championship windows (March, Bowl season). Q4 peak.',
  'draftkings':      'Football season Q3-Q1. March Madness Q1.',
  'celsius':         'Summer Q2-Q3. Year-round campus activations. 200+ athlete program.',
  'ghost energy':    'Year-round. Gaming + athlete crossover. Portal season outreach.',
  'body armor':      'Q3 football season push. College partnerships active. Women\'s sports Q1.',
  'ag1':             'Q1 New Year health push. High-GPA athlete preferred.',
  'crocs':           'Back to school Q3. Cultural moment campaigns.',
  'manscaped':       'Male athlete focus. Year-round. College portal season high.',
  'toyota':          'Q3-Q4 push. Regional dealers active year-round. QB1 preference for national.',
  'ford':            'Truck/SUV campaigns heavy Q3-Q4. Regional dealers Q1.',
  'amazon':          'Prime Day July, Back to school, Holiday. Year-round student athlete recruitment.',
  'apple':           'Product launch windows Sept (iPhone), Oct (MacBook). Back to school Q3.',
  'ea sports':       'CFB launch (July), roster updates Oct-Jan. $1,500 base + star negotiation.',
};

// ─── Trustworthy Output Layer ─────────────────────────────────────────────────
// Added to NILViewVal v5.2 — replaces fake precision with transparent estimation.
// ALL functions below are ADDITIVE — zero changes to existing functions above.

/** Round a dollar amount to a clean, believable number */
function roundToClean(n) {
  const num = Math.round(n) || 0;
  if (num >= 50000) return Math.round(num / 2500) * 2500;
  if (num >= 10000) return Math.round(num / 1000) * 1000;
  if (num >= 5000)  return Math.round(num / 500)  * 500;
  if (num >= 2000)  return Math.round(num / 250)  * 250;
  if (num >= 500)   return Math.round(num / 50)   * 50;
  if (num >= 100)   return Math.round(num / 25)   * 25;
  return Math.round(num / 10) * 10;
}

/** Apply rounding to a rate pair — ensures low != high after rounding */
function cleanRange(low, high) {
  let cLow  = roundToClean(low  || 0);
  let cHigh = roundToClean(high || 0);
  if (cHigh <= cLow && cLow > 0) cHigh = cLow + roundToClean(cLow * 0.4);
  return { low: cLow, high: cHigh };
}

/** Inline follower formatter (mirrors the one in nilViewVal scope) */
function _fmtK(n) {
  const num = parseInt(n) || 0;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return Math.round(num / 1000) + 'K';
  return String(num);
}

/**
 * Generate human-readable rate drivers — what pushed the rate UP.
 * Returns array of plain-English strings (max 5).
 */
function generateRateDrivers(athlete, rate) {
  const drivers = [];
  const sport  = (athlete.sport     || '').toLowerCase();
  const tier   = (athlete.schoolTier || '').toLowerCase();
  const pos    = (athlete.position  || '').toLowerCase();
  const school = (athlete.school    || '').toLowerCase();
  const er     = parseFloat(athlete.engagement) || 0;
  const ig     = parseInt(athlete.instagram)    || 0;
  const tt     = parseInt(athlete.tiktok)       || 0;
  const reach  = ig + tt;
  const b      = rate.breakdown || {};
  const dMult  = parseFloat(b.draftMult)  || 1.0;
  const sMult  = parseFloat(b.statsMult)  || 1.0;
  const mMult  = parseFloat(b.marketMult) || 1.0;

  // School visibility
  if (tier.startsWith('p4-top10'))       drivers.push('P4 Top-10 program visibility');
  else if (tier.startsWith('p4-top25'))  drivers.push('Power 4 Top-25 program market');
  else if (tier.startsWith('p4'))        drivers.push('Power 4 school visibility');
  else if (tier.startsWith('highmajor')) drivers.push('High-major program recognition');

  // Conference premium
  const secSchools = ['georgia','alabama','lsu','florida','tennessee','auburn','ole miss','mississippi state','arkansas','missouri','vanderbilt','kentucky','south carolina','texas a&m','texas','oklahoma'];
  const b10Schools = ['ohio state','michigan','penn state','michigan state','iowa','wisconsin','minnesota','illinois','northwestern','indiana','purdue','nebraska','rutgers','maryland'];
  const accSchools = ['clemson','duke','north carolina','miami','virginia tech','florida state','georgia tech','nc state','syracuse','boston college','wake forest','pittsburgh','louisville','california'];
  const b12Schools = ['byu','kansas state','iowa state','oklahoma state','kansas','tcu','baylor','texas tech','utah','colorado','west virginia','cincinnati','houston','ucf'];
  if (secSchools.some(s => school.includes(s)))      drivers.push('SEC conference premium');
  else if (b10Schools.some(s => school.includes(s))) drivers.push('Big Ten conference visibility');
  else if (accSchools.some(s => school.includes(s))) drivers.push('ACC program market');
  else if (b12Schools.some(s => school.includes(s))) drivers.push('Big 12 conference reach');

  // Sport demand
  if      (sport.includes('football'))          drivers.push('High football brand demand');
  else if (sport.includes('basketball'))        drivers.push('Strong basketball NIL market');
  else if (sport.includes('gymnastics'))        drivers.push('Elite gymnastics audience profile');
  else if (sport.includes('volleyball'))        drivers.push('Growing volleyball NIL market');
  else if (sport.includes('baseball'))          drivers.push('Active baseball NIL market');

  // Position premium
  if      (pos.includes('qb') || pos.includes('quarterback'))    drivers.push('QB position commands maximum premium');
  else if (pos.includes('pg') || pos.includes('point guard'))    drivers.push('Point guard visibility premium');
  else if (pos.includes('wr') || pos.includes('wide receiver'))  drivers.push('Wide receiver brand demand');
  else if (pos.includes('edge') || pos.includes('cb'))           drivers.push('Premium defensive position');

  // Engagement quality
  if      (er >= 10) drivers.push('Exceptional engagement (' + er.toFixed(1) + '% — 2×+ avg)');
  else if (er >= 6)  drivers.push('Strong engagement (' + er.toFixed(1) + '% vs. 4.8% avg)');
  else if (er >= 4)  drivers.push('Above-average engagement rate');

  // Reach tier
  if      (reach >= 500000) drivers.push('Major-tier reach (' + _fmtK(reach) + ' combined)');
  else if (reach >= 100000) drivers.push('Mid-tier social following (' + _fmtK(reach) + ')');
  else if (reach >= 25000)  drivers.push('Micro-influencer niche authority');

  // Cross-platform bonus
  if (ig > 0 && tt > 0) drivers.push('Cross-platform presence (IG + TikTok)');

  // Draft / stats signals
  if (dMult >= 2.5)  drivers.push('Top draft prospect premium');
  else if (dMult >= 1.5) drivers.push('Draft prospect visibility boost');
  if (sMult >= 1.3)  drivers.push('Elite on-field performance metrics');

  // Market geography
  if (mMult >= 1.35) {
    const bigCities = [['athens','Athens market'],['tuscaloosa','Tuscaloosa market'],['columbus','Columbus market'],
      ['baton rouge','Baton Rouge market'],['austin','Austin market'],['dallas','Dallas market'],
      ['los angeles','Los Angeles market'],['new york','New York market'],['atlanta','Atlanta market'],
      ['miami','Miami market']];
    const cityMatch = bigCities.find(([c]) => school.includes(c));
    drivers.push(cityMatch ? cityMatch[1] + ' concentration' : 'Major market geography');
  }

  return drivers.slice(0, 5);
}

/**
 * Generate human-readable limitations — what constrained the rate.
 * Returns array of plain-English strings (max 4).
 */
function generateRateLimitations(athlete, rate, compCount) {
  const limits = [];
  const reach = (parseInt(athlete.instagram) || 0) + (parseInt(athlete.tiktok) || 0);
  const er    = parseFloat(athlete.engagement) || 0;
  const tier  = (athlete.schoolTier || '').toLowerCase();
  const ig    = parseInt(athlete.instagram) || 0;
  const tt    = parseInt(athlete.tiktok)   || 0;

  if (compCount < 5)                          limits.push('Benchmark coverage developing for this sport/tier');
  if (reach < 10000)                          limits.push('Building social reach — local partnerships most accessible');
  else if (reach < 25000 && er < 5)          limits.push('Growing audience tier — micro-market most viable');
  if (er < 3 && er > 0)                      limits.push('Engagement trending below platform average');
  if (!ig)                                    limits.push('Instagram data not yet on file');
  if (!tt)                                    limits.push('Single-platform presence — TikTok data not on file');
  if (tier && !tier.startsWith('p4') && !tier.startsWith('highmajor'))
                                              limits.push('Non-P4 school tier — regional brands strongest fit');
  if (!athlete.position)                      limits.push('Position not specified — market average applied');
  if (!athlete.ppg && !athlete.rpg)          limits.push('Performance stats not yet added to profile');
  limits.push('Sponsorship history not yet established');

  return limits.slice(0, 4);
}

/**
 * Market Reliability Score — 1.0–10.0
 * Measures how much real data backs the estimate.
 */
function calcMarketReliabilityScore(athlete, rate, compCount) {
  const ig    = parseInt(athlete.instagram) || 0;
  const tt    = parseInt(athlete.tiktok)   || 0;
  const reach = ig + tt;
  const er    = parseFloat(athlete.engagement) || 0;
  const tier  = (athlete.schoolTier || '').toLowerCase();

  let score = 2.5; // honest starting base

  // Social signal quality (up to +3.0)
  if (ig > 0)    score += 1.2;
  if (tt > 0)    score += 0.8;
  if (er > 0)    score += 0.6;
  if (reach >= 10000) score += 0.4;

  // School/sport anchor (up to +2.0)
  if (tier.startsWith('p4'))        score += 1.0;
  else if (tier.startsWith('highmajor')) score += 0.6;
  else if (tier.startsWith('mid'))  score += 0.3;
  if (athlete.sport)                score += 0.5;
  if (athlete.position)             score += 0.5;

  // Historical deal data (up to +1.5)
  if (compCount >= 20)      score += 1.5;
  else if (compCount >= 10) score += 1.0;
  else if (compCount >= 5)  score += 0.6;
  else if (compCount >= 1)  score += 0.2;

  // Supplementary profile data (up to +1.0)
  if (athlete.ppg || athlete.rpg) score += 0.4;
  if (athlete.gpa)                score += 0.3;
  if (athlete.draftStatus)        score += 0.3;

  const strengths = [];
  const weaknesses = [];
  if (ig > 0 || tt > 0) strengths.push('Social following verified');
  if (er >= 4)          strengths.push('Engagement metrics on file');
  else                  weaknesses.push('Engagement data thin or absent');
  if (tier.startsWith('p4') || tier.startsWith('highmajor')) strengths.push('School visibility benchmarks available');
  if (athlete.sport)    strengths.push('Sport-specific market benchmarks');
  if (compCount >= 5)   strengths.push(compCount + ' comparable closed deals');
  else                  weaknesses.push('Few comparable closed deals on record');
  weaknesses.push('No individual deal history on file');
  if (!tt)              weaknesses.push('TikTok data absent (single-platform)');

  const finalScore = Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;
  const label =
    finalScore >= 7.5 ? 'Very Strong' :
    finalScore >= 6.0 ? 'Strong'      :
    finalScore >= 4.0 ? 'Moderate'    : 'Low';

  return {
    score: finalScore,
    label,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
  };
}

/**
 * Separate confidence types — replaces single fake-precision score.
 * Returns per-dimension confidence percentages + overall label.
 */
function generateConfidenceTypes(athlete, rate, compCount) {
  const ig    = parseInt(athlete.instagram) || 0;
  const tt    = parseInt(athlete.tiktok)   || 0;
  const er    = parseFloat(athlete.engagement) || 0;

  // Social confidence — how complete is the social footprint?
  let social = 15;
  if (ig > 0) social += 38;
  if (tt > 0) social += 22;
  if (er > 0) social += 20;
  if (ig > 0 && tt > 0) social += 5; // cross-platform completeness bonus
  social = Math.min(92, social);

  // Market confidence — school, sport, position known?
  let market = 38;
  if (athlete.schoolTier) market += 15;
  if (athlete.sport)      market += 15;
  if (athlete.position)   market += 10;
  if (ig > 0 || tt > 0)  market += 6;
  market = Math.min(80, market);

  // Comparable confidence — actual closed deal data
  let comparable = 0;
  if      (compCount >= 20) comparable = 85;
  else if (compCount >= 10) comparable = 68;
  else if (compCount >= 5)  comparable = 50;
  else if (compCount >= 1)  comparable = 30;
  else                      comparable = 0; // honest zero

  // Historical deal confidence — always unavailable until we have it
  const historical = 0;

  // Overall weighted label
  const weighted = (social * 0.40) + (market * 0.35) + (comparable * 0.25);
  const overall = weighted >= 68 ? 'High' : weighted >= 48 ? 'Moderate' : 'Low';

  // Human-readable comparable label — avoids showing "0%"
  const comparableLabel =
    comparable >= 50 ? 'Moderate coverage'   :
    comparable > 0   ? 'Developing dataset'  : 'Developing dataset';

  return { social, market, comparable, comparableLabel, historical, overall, weighted: Math.round(weighted) };
}

/**
 * Comparable market context note for the UI "Comparable Market" panel.
 */
function generateComparableNote(athlete, rate) {
  const tier   = (athlete.schoolTier || '').toLowerCase();
  const sport  = (athlete.sport || '').toLowerCase();
  const reach  = (parseInt(athlete.instagram) || 0) + (parseInt(athlete.tiktok) || 0);

  const tierLabel =
    tier.startsWith('p4-top10') ? 'P4 Top-10' :
    tier.startsWith('p4-top25') ? 'P4 Top-25' :
    tier.startsWith('p4')       ? 'Power 4'   :
    tier.startsWith('highmajor')? 'High-Major' :
    tier.startsWith('mid')      ? 'Mid-Major'  : 'similar tier';

  const sportLabel =
    sport.includes('football')   ? 'football athletes'   :
    sport.includes('basketball') ? 'basketball athletes' :
    sport.includes('gymnastics') ? 'gymnastics athletes' :
    sport.includes('volleyball') ? 'volleyball athletes' :
    sport.includes('baseball')   ? 'baseball athletes'   : 'athletes in this sport';

  const reachLabel =
    reach >= 200000 ? '150K–400K followers' :
    reach >= 100000 ? '75K–200K followers'  :
    reach >= 50000  ? '35K–80K followers'   :
    reach >= 25000  ? '15K–45K followers'   :
    reach >= 10000  ? '8K–25K followers'    : 'similar reach tier';

  return { tierLabel, sportLabel, reachLabel, source: '2025 NIL benchmark data' };
}

/**
 * Momentum signal — derived from available engagement + profile signals.
 * Never fabricates: returns 'Insufficient data' when inputs are thin.
 */
function generateMomentumSignal(athlete) {
  const ig     = parseInt(athlete.instagram) || 0;
  const tt     = parseInt(athlete.tiktok)   || 0;
  const er     = parseFloat(athlete.engagement) || 0;
  const reach  = ig + tt;
  const hasDraft = athlete.draftStatus && athlete.draftStatus.toLowerCase().includes('prospect');
  const hasStats = !!(athlete.ppg || athlete.rpg);

  // Require some social data to say anything meaningful
  if (!ig && !tt) return { signal: 'Insufficient data', reason: 'Social data not yet on file' };
  if (!er)        return { signal: 'Insufficient data', reason: 'Engagement data not available' };

  // Strong upward signals
  if (er >= 8 && ig > 0 && tt > 0) {
    return { signal: 'Trending Up', reason: 'High engagement across multiple platforms' };
  }
  if (er >= 8 && (hasDraft || hasStats)) {
    return { signal: 'Trending Up', reason: 'Strong engagement with performance credibility' };
  }
  if (er >= 6 && reach >= 50000) {
    return { signal: 'Trending Up', reason: 'Above-average engagement at growing scale' };
  }
  // Emerging — high engagement but early reach
  if (er >= 7 && reach < 25000) {
    return { signal: 'Emerging', reason: 'Strong engagement signals early audience loyalty' };
  }
  if (er >= 5 && reach < 10000) {
    return { signal: 'Emerging', reason: 'High-quality audience forming at micro-level' };
  }
  // Stable — solid but no strong growth signal
  if (er >= 4 && reach >= 10000) {
    return { signal: 'Stable', reason: 'Consistent engagement at established reach level' };
  }
  if (er >= 3) {
    return { signal: 'Stable', reason: 'Average engagement — market rate applies' };
  }

  return { signal: 'Insufficient data', reason: 'Limited signals available for trend analysis' };
}

/**
 * Suggested pricing strategy — start / target / stretch anchored to valuation range.
 * Uses existing low/mid/high — no new math, just presentation framing.
 */
function generatePricingStrategy(rate) {
  const low  = rate.low  || 0;
  const mid  = rate.mid  || Math.round((low + (rate.high || 0)) / 2);
  const high = rate.high || 0;

  // Start: the floor you should never go below (rounded low)
  // Target: the fair market value (rounded mid)
  // Stretch: aspirational — add ~20% for exclusivity / premium negotiation room
  const start   = roundToClean(low);
  const target  = roundToClean(mid);
  const stretch = roundToClean(Math.round(high * 1.20));

  return { start, target, stretch };
}

module.exports = {
  MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal,
  // Trustworthy output layer
  roundToClean, cleanRange,
  generateRateDrivers, generateRateLimitations,
  calcMarketReliabilityScore, generateConfidenceTypes,
  generateComparableNote, generateMomentumSignal, generatePricingStrategy,
};
