// server/benchmarks.js — NILViewVal Model v4
// v4 upgrades: marketability score, sponsorship readiness, audience quality, confidence score
// top sponsorship categories, engagement growth signals, posting consistency, brand friendliness

const MARKET_RATES = {
  baseCPM: 12.0,

  seasonalCPM(sport) {
    const month = new Date().getMonth();
    if (sport === 'football') {
      return [14.5,14.0,11.5,11.0,10.5,10.5,11.0,11.5,14.5,15.0,14.0,13.5][month];
    }
    if (sport === 'basketball') {
      return [13.0,11.0,11.0,13.0,12.5,11.5,11.0,11.0,11.5,12.0,13.5,14.0][month];
    }
    return 12.0;
  },

  athleteAvgEngagement: 5.6,
  marketFactor: 1.05,

  positionMultiplier: {
    'qb': 1.85, 'quarterback': 1.85,
    'wr': 1.40, 'wide receiver': 1.40,
    'cb': 1.25, 'cornerback': 1.25,
    'rb': 1.20, 'running back': 1.20,
    'edge': 1.30, 'de': 1.25, 'defensive end': 1.25,
    'lb': 1.10, 'linebacker': 1.10,
    'safety': 1.10, 's': 1.10,
    'te': 1.15, 'tight end': 1.15,
    'ol': 0.75, 'offensive line': 0.75, 'ot': 0.78, 'og': 0.75, 'c': 0.75,
    'dl': 0.85, 'defensive line': 0.85, 'dt': 0.82,
    'k': 0.70, 'kicker': 0.70, 'p': 0.68, 'punter': 0.68,
    'pg': 1.50, 'point guard': 1.50,
    'sg': 1.35, 'shooting guard': 1.35,
    'sf': 1.20, 'small forward': 1.20,
    'pf': 1.05, 'power forward': 1.05,
    'center': 1.00,
    'sp': 1.30, 'starting pitcher': 1.30,
    'ss': 1.25, 'shortstop': 1.25,
    'cf': 1.20, 'center field': 1.20,
    '1b': 1.10, 'catcher': 1.15,
    'forward': 1.30, 'striker': 1.30,
    'midfielder': 1.10, 'goalkeeper': 1.05, 'defender': 0.95,
    'default': 1.00,
  },

  marketMultiplier: {
    'los angeles': 1.45, 'new york': 1.45, 'chicago': 1.40,
    'dallas': 1.38, 'houston': 1.35, 'atlanta': 1.32,
    'miami': 1.30, 'seattle': 1.28, 'boston': 1.28,
    'columbus': 1.35, 'tuscaloosa': 1.30, 'baton rouge': 1.28,
    'austin': 1.32, 'ann arbor': 1.25, 'norman': 1.22,
    'gainesville': 1.20, 'knoxville': 1.20, 'athens': 1.22,
    'durham': 1.25, 'chapel hill': 1.22, 'raleigh': 1.20,
    'south bend': 1.25, 'provo': 1.18, 'fort worth': 1.20,
    'nashville': 1.25, 'louisville': 1.15, 'lexington': 1.18,
    'clemson': 1.15, 'auburn': 1.15, 'starkville': 1.05,
    'columbia': 1.12, 'fayetteville': 1.15, 'stillwater': 1.10,
    'manhattan': 1.05, 'ames': 1.05, 'lincoln': 1.08,
    'birmingham': 1.08, 'memphis': 1.08, 'salt lake city': 1.12,
    'denver': 1.18, 'phoenix': 1.20, 'san diego': 1.22,
    'portland': 1.15, 'minneapolis': 1.15, 'detroit': 1.12,
    'pittsburgh': 1.12, 'baltimore': 1.15, 'washington': 1.25,
    'default': 1.00,
  },

  sportMultiplier: {
    football: 1.45, basketball: 1.40,
    baseball: 1.15, soccer: 1.05, lacrosse: 1.00,
    wrestling: 0.92, swimming: 0.90, track: 0.95,
    'track & field': 0.95, golf: 0.95, tennis: 0.92,
    gymnastics: 1.35, volleyball: 1.28, softball: 1.10,
    'womens basketball': 1.25, 'womens soccer': 1.10,
    'womens swimming': 1.05, 'womens tennis': 1.02,
    'womens golf': 1.00, 'womens track': 1.00,
  },

  schoolMultiplier: {
    'p4-top10': 1.50, 'p4-top25': 1.38, 'p4-mid': 1.25, 'p4-lower': 1.10,
    'highmajor-top': 1.05, 'highmajor-mid': 0.98,
    'mid-top': 0.90, 'mid-mid': 0.82, 'mid-lower': 0.75,
    'lowmajor-top': 0.70, 'lowmajor-lower': 0.65,
    'd2-elite': 0.60, 'd2-top': 0.55, 'd2-mid': 0.50, 'd2-lower': 0.45,
    'd3-top': 0.40, 'd3-mid': 0.35, 'd3-lower': 0.30,
    'naia-top': 0.38, 'naia-mid': 0.32,
    'juco-d1': 0.35, 'juco-d2': 0.28,
  },

  deliverableMultiplier: {
    'ig-post': 1.00, 'tiktok': 0.90, 'ig-reel': 1.30,
    'stories': 0.45, 'bundle': 2.40, 'retainer': 4.20,
    'youtube-long': 2.20, 'newsletter': 0.80,
    'podcast-host': 1.10, 'twitter-campaign': 0.70,
  },

  appearanceFees: {
    'appearance-inperson':   { p4top:[3500,7500],  p4mid:[1500,4000],  p4low:[750,2000],  mid:[400,1200] },
    'appearance-speaking':   { p4top:[5000,12000], p4mid:[2000,5000],  p4low:[1000,2500], mid:[500,1500] },
    'appearance-meetgreet':  { p4top:[2000,5000],  p4mid:[800,2500],   p4low:[400,1200],  mid:[200,800]  },
    'appearance-campus':     { p4top:[1500,4000],  p4mid:[600,1800],   p4low:[300,900],   mid:[150,500]  },
    'media-podcast':         { p4top:[1500,4000],  p4mid:[500,1500],   p4low:[250,800],   mid:[100,500]  },
    'media-youtube':         { p4top:[2500,6000],  p4mid:[800,2500],   p4low:[400,1200],  mid:[200,700]  },
    'media-twitch':          { p4top:[1000,3000],  p4mid:[400,1200],   p4low:[200,700],   mid:[100,400]  },
    'media-pressday':        { p4top:[2000,5000],  p4mid:[750,2000],   p4low:[350,1000],  mid:[150,600]  },
    'license-jersey':        { p4top:[5000,20000], p4mid:[2000,8000],  p4low:[500,3000],  mid:[200,1500] },
    'license-merch':         { p4top:[3000,10000], p4mid:[1000,5000],  p4low:[500,2000],  mid:[200,1000] },
    'license-codesign':      { p4top:[2500,8000],  p4mid:[800,3000],   p4low:[300,1500],  mid:[150,700]  },
    'license-autograph':     { p4top:[2000,6000],  p4mid:[500,2000],   p4low:[200,800],   mid:[100,400]  },
    'collective-roster':     { p4top:[3000,8000],  p4mid:[1000,4000],  p4low:[400,1500],  mid:[200,800]  },
    'collective-ambassador': { p4top:[2000,6000],  p4mid:[800,2500],   p4low:[300,1000],  mid:[150,500]  },
    'collective-booster':    { p4top:[1500,4000],  p4mid:[500,1500],   p4low:[200,800],   mid:[100,400]  },
    'camp-skills':           { p4top:[3000,8000],  p4mid:[1000,3500],  p4low:[500,1500],  mid:[250,800]  },
    'camp-clinic':           { p4top:[2500,7000],  p4mid:[800,3000],   p4low:[400,1200],  mid:[200,700]  },
    'camp-training':         { p4top:[4000,12000], p4mid:[1500,5000],  p4low:[500,2000],  mid:[250,1000] },
  },

  industryAvgEngagement: { instagram: 2.58, tiktok: 4.10, combined: 3.20 },

  statsMultiplier(athlete) {
    const sport = (athlete.sport || '').toLowerCase();
    const ppg = parseFloat(athlete.ppg) || 0;
    const rpg = parseFloat(athlete.rpg) || 0;
    const apg = parseFloat(athlete.apg) || 0;
    const fgPct = parseFloat(athlete.fgPct) || 0;
    const bpg = parseFloat(athlete.bpg) || 0;
    const spg = parseFloat(athlete.spg) || 0;
    let mult = 1.0;
    if (sport.includes('basketball')) {
      if (ppg >= 20) mult += 0.40;
      else if (ppg >= 15) mult += 0.25;
      else if (ppg >= 10) mult += 0.10;
      if (rpg >= 9) mult += 0.20;
      else if (rpg >= 7) mult += 0.10;
      if (apg >= 5) mult += 0.35;
      else if (apg >= 3) mult += 0.20;
      else if (apg >= 1.5) mult += 0.08;
      if (fgPct >= 0.55) mult += 0.15;
      else if (fgPct >= 0.50) mult += 0.08;
      if (bpg >= 2) mult += 0.15;
      if (spg >= 1.5) mult += 0.10;
    } else if (sport.includes('football')) {
      if (ppg >= 15) mult += 0.30;
      if (rpg >= 100) mult += 0.20;
      if (apg >= 10) mult += 0.15;
    }
    return Math.min(mult, 2.5);
  },

  draftMultiplier(draftStatus) {
    if (!draftStatus) return 1.0;
    const s = draftStatus.toLowerCase();
    if (s.includes('declared') || s.includes('top 5') || s.includes('lottery')) return 2.8;
    if (s.includes('first round') || s.includes('1st round')) return 2.2;
    if (s.includes('second round') || s.includes('2nd round') || s.includes('prospect')) return 1.5;
    if (s.includes('fringe') || s.includes('undrafted')) return 1.2;
    return 1.0;
  },

  archetypeScore(athlete) {
    const sport = (athlete.sport || '').toLowerCase();
    const ppg = parseFloat(athlete.ppg) || 0;
    const rpg = parseFloat(athlete.rpg) || 0;
    const apg = parseFloat(athlete.apg) || 0;
    const fgPct = parseFloat(athlete.fgPct) || 0;
    const bpg = parseFloat(athlete.bpg) || 0;
    const reach = (athlete.instagram || 0) + (athlete.tiktok || 0);
    if (!ppg && !rpg && !apg) return null;
    let score = 50;
    if (sport.includes('basketball')) {
      if (ppg >= 15) score += 15; else if (ppg >= 10) score += 8;
      if (rpg >= 7) score += 12; else if (rpg >= 5) score += 6;
      if (apg >= 3) score += 15; else if (apg >= 1.5) score += 7;
      if (fgPct >= 0.50) score += 8; else if (fgPct >= 0.45) score += 4;
      if (bpg >= 1.5) score += 8;
      if (reach >= 100000) score += 10; else if (reach >= 25000) score += 5;
    } else if (sport.includes('football')) {
      if (ppg >= 15) score += 20;
      else if (ppg >= 10) score += 12;
      if (rpg >= 100) score += 15;
      else if (rpg >= 60) score += 8;
      if (apg >= 10) score += 10;
      if (reach >= 100000) score += 10; else if (reach >= 25000) score += 5;
    } else {
      // Generic scoring for other sports
      if (reach >= 100000) score += 15;
      else if (reach >= 25000) score += 8;
      else if (reach >= 5000) score += 3;
      const er = parseFloat(athlete.engagement) || 0;
      if (er >= 8) score += 12;
      else if (er >= 5) score += 6;
    }
    return Math.min(score, 99);
  },

  engagementMultiplier(rate) {
    const ratio = (rate || 0) / 5.6;
    return Math.max(0.7, Math.min(1.8, ratio));
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

// ─── NILViewVal v4 — adds composite scores ───────────────────────────────────
function nilViewVal(athlete, deliverableType) {
  const ig = athlete.instagram || 0;
  const tt = athlete.tiktok || 0;
  const totalReach = ig + tt;
  const er = parseFloat(athlete.engagement) || 3.0;
  const sport = (athlete.sport || 'basketball').toLowerCase();
  const tier = athlete.schoolTier || 'mid-mid';
  const position = athlete.position || '';
  const school = athlete.school || '';

  const cpm = MARKET_RATES.seasonalCPM(sport);
  const erMult = MARKET_RATES.engagementMultiplier(er);
  const schoolMult = MARKET_RATES.schoolMultiplier[tier] || 0.75;
  const sportMult = MARKET_RATES.sportMultiplier[sport] || 1.0;
  const posMult = MARKET_RATES.getPositionMultiplier(position);
  const marketMult = MARKET_RATES.getMarketMultiplier(school);

  let reachMult;
  if (totalReach >= 500000)      reachMult = 1.80;
  else if (totalReach >= 200000) reachMult = 1.50;
  else if (totalReach >= 100000) reachMult = 1.25;
  else if (totalReach >= 50000)  reachMult = 1.05;
  else if (totalReach >= 25000)  reachMult = 0.90;
  else if (totalReach >= 10000)  reachMult = 0.75;
  else                           reachMult = 0.60;

  const delivMult = MARKET_RATES.deliverableMultiplier[deliverableType] || 1.0;
  const statsMul = MARKET_RATES.statsMultiplier(athlete);
  const draftMul = MARKET_RATES.draftMultiplier(athlete.draftStatus || '');
  const totalMult = erMult * schoolMult * sportMult * posMult * marketMult * reachMult * delivMult * statsMul * draftMul * MARKET_RATES.marketFactor;

  const valuePerView = (cpm * totalMult) / 1000;

  let viewRate = 0.30;
  if (deliverableType === 'ig-reel') viewRate = 0.35;
  else if (deliverableType === 'tiktok') viewRate = 0.40;
  else if (deliverableType === 'stories') viewRate = 0.15;
  else if (deliverableType === 'ig-post') viewRate = 0.25;

  const avgViews = totalReach > 0 ? totalReach * viewRate : 5000;
  const valuePerPost = valuePerView * avgViews;

  const dataScore =
    (ig > 0 ? 20 : 0) +
    (tt > 0 ? 12 : 0) +
    (er > 0 ? 18 : 0) +
    (tier !== 'mid-mid' ? 18 : 8) +
    (position ? 15 : 0) +
    (school ? 12 : 0) +
    5;
  const accuracyScore = Math.max(50, Math.min(97, dataScore));

  const floorRates = {
    'p4-top10':   { low: 150, mid: 200, high: 300 },
    'p4-top25':   { low: 100, mid: 150, high: 225 },
    'p4-mid':     { low:  75, mid: 110, high: 165 },
    'p4-lower':   { low:  50, mid:  75, high: 110 },
    'highmajor-top': { low: 40, mid: 60, high: 90 },
    'highmajor-mid': { low: 35, mid: 50, high: 75 },
    'mid-top':    { low: 30, mid: 45, high: 65 },
    'mid-mid':    { low: 25, mid: 35, high: 55 },
    'mid-lower':  { low: 20, mid: 30, high: 45 },
    'lowmajor-top': { low: 15, mid: 25, high: 35 },
    'lowmajor-lower': { low: 12, mid: 18, high: 28 },
    'd2-elite':   { low: 10, mid: 15, high: 25 },
    'd2-top':     { low:  8, mid: 12, high: 20 },
    'd2-mid':     { low:  5, mid:  8, high: 15 },
  };
  const floor = floorRates[tier] || { low: 15, mid: 22, high: 35 };
  const floorDelivMult = MARKET_RATES.deliverableMultiplier[deliverableType] || 1.0;
  const floorLow  = Math.round(floor.low  * floorDelivMult);
  const floorMid  = Math.round(floor.mid  * floorDelivMult);
  const floorHigh = Math.round(floor.high * floorDelivMult);

  const finalLow  = Math.max(Math.round(valuePerPost * 0.75), floorLow);
  const finalMid  = Math.max(Math.round(valuePerPost), floorMid);
  const finalHigh = Math.max(Math.round(valuePerPost * 1.35), floorHigh);
  const floorApplied = finalLow > Math.round(valuePerPost * 0.75);
  const archetypeScore = MARKET_RATES.archetypeScore(athlete);

  let recommendation = null;
  if (totalReach < 5000) {
    recommendation = 'With under 5K followers, social media brand deals are limited. Focus on: (1) Collective roster deals ($300-1K/mo guaranteed), (2) Local business appearances ($150-400/event), (3) Campus ambassador roles ($200-600/mo).';
  } else if (totalReach < 15000) {
    recommendation = 'At this reach level, local and regional brands offer the best opportunities. Consider collective roster deals, local restaurant partnerships, and campus ambassador programs.';
  }

  // ── NEW v4: Composite scores ─────────────────────────────────────────────

  // 1. Marketability Score (0-100)
  // Weights: social reach + engagement + sport premium + position + school tier + draft status
  let marketabilityScore = 0;
  // Reach (30 pts)
  if (totalReach >= 500000) marketabilityScore += 30;
  else if (totalReach >= 200000) marketabilityScore += 25;
  else if (totalReach >= 100000) marketabilityScore += 20;
  else if (totalReach >= 50000) marketabilityScore += 15;
  else if (totalReach >= 25000) marketabilityScore += 10;
  else if (totalReach >= 10000) marketabilityScore += 6;
  else marketabilityScore += 2;
  // Engagement (20 pts)
  if (er >= 10) marketabilityScore += 20;
  else if (er >= 7) marketabilityScore += 16;
  else if (er >= 5) marketabilityScore += 12;
  else if (er >= 3) marketabilityScore += 7;
  else marketabilityScore += 3;
  // Sport premium (15 pts)
  const sportPremium = MARKET_RATES.sportMultiplier[sport] || 1.0;
  if (sportPremium >= 1.35) marketabilityScore += 15;
  else if (sportPremium >= 1.20) marketabilityScore += 11;
  else if (sportPremium >= 1.05) marketabilityScore += 7;
  else marketabilityScore += 4;
  // Position (10 pts)
  if (posMult >= 1.50) marketabilityScore += 10;
  else if (posMult >= 1.25) marketabilityScore += 7;
  else if (posMult >= 1.10) marketabilityScore += 5;
  else marketabilityScore += 3;
  // School tier (15 pts)
  if (schoolMult >= 1.38) marketabilityScore += 15;
  else if (schoolMult >= 1.25) marketabilityScore += 11;
  else if (schoolMult >= 1.10) marketabilityScore += 7;
  else if (schoolMult >= 0.90) marketabilityScore += 4;
  else marketabilityScore += 2;
  // Draft status (10 pts)
  if (draftMul >= 2.5) marketabilityScore += 10;
  else if (draftMul >= 2.0) marketabilityScore += 7;
  else if (draftMul >= 1.5) marketabilityScore += 5;
  else marketabilityScore += 2;
  marketabilityScore = Math.min(99, marketabilityScore);

  // 2. Sponsorship Readiness Score (0-100)
  // Based on profile completeness + social presence + professionalism signals
  let sponsorshipReadiness = 20; // base
  if (ig > 0) sponsorshipReadiness += 15;
  if (tt > 0) sponsorshipReadiness += 10;
  if (er >= 3) sponsorshipReadiness += 10;
  if (athlete.stats) sponsorshipReadiness += 10;
  if (athlete.school) sponsorshipReadiness += 8;
  if (athlete.position) sponsorshipReadiness += 7;
  if (athlete.year) sponsorshipReadiness += 5;
  if (athlete.gpa && parseFloat(athlete.gpa) >= 3.0) sponsorshipReadiness += 8;
  if (totalReach >= 10000) sponsorshipReadiness += 7;
  sponsorshipReadiness = Math.min(98, sponsorshipReadiness);

  // 3. Audience Quality Score (0-100)
  // Signals: engagement vs reach ratio, platform mix, sport fanbase quality
  let audienceQuality = 30;
  // Engagement quality (vs industry average 5.6%)
  const erVsAvg = er / 5.6;
  if (erVsAvg >= 2.0) audienceQuality += 30;
  else if (erVsAvg >= 1.5) audienceQuality += 22;
  else if (erVsAvg >= 1.0) audienceQuality += 15;
  else if (erVsAvg >= 0.7) audienceQuality += 8;
  else audienceQuality += 2;
  // Platform quality mix (having both IG + TikTok = broader audience)
  if (ig > 0 && tt > 0) audienceQuality += 15;
  else if (ig > 0) audienceQuality += 8;
  // Sport fanbase quality (some sports have more brand-relevant audiences)
  if (['football','basketball','gymnastics','volleyball'].some(s => sport.includes(s))) audienceQuality += 15;
  else if (['baseball','soccer','softball'].some(s => sport.includes(s))) audienceQuality += 10;
  else audienceQuality += 5;
  // Reach to ER ratio — small audiences with high ER are better quality than large with low ER
  if (totalReach > 0 && er >= 8 && totalReach < 100000) audienceQuality += 10; // micro with high ER = gold
  audienceQuality = Math.min(99, audienceQuality);

  // 4. Confidence Score (how reliable is this valuation based on data provided)
  const confidenceScore = accuracyScore;

  // 5. Top Sponsorship Categories
  const sponsorCategories = getSponsorshipCategories(athlete, sport, totalReach, er, tier);

  // 6. Ideal Brand Partnership Types
  const brandPartnershipTypes = getBrandPartnershipTypes(totalReach, er, tier, sport);

  return {
    low: finalLow,
    mid: finalMid,
    high: finalHigh,
    floorApplied,
    recommendation,
    archetypeScore,
    draftMult: draftMul,
    statsMult: statsMul,
    valuePerView: valuePerView.toFixed(5),
    accuracyScore,
    // NEW v4 scores
    marketabilityScore,
    sponsorshipReadiness,
    audienceQuality,
    confidenceScore,
    sponsorCategories,
    brandPartnershipTypes,
    breakdown: {
      reach: totalReach,
      sportMult: sportMult.toFixed(2),
      schoolMult: schoolMult.toFixed(2),
      posMult: posMult.toFixed(2),
      marketMult: marketMult.toFixed(2),
      engMult: erMult.toFixed(2),
      cpm: cpm.toFixed(2),
      statsMult: statsMul.toFixed(2),
      draftMult: draftMul.toFixed(2),
    },
    multipliers: {
      er: erMult.toFixed(2),
      school: schoolMult,
      sport: sportMult,
      position: posMult,
      market: marketMult,
      reach: reachMult,
      total: totalMult.toFixed(2)
    }
  };
}

// ─── Sponsorship Category Engine ─────────────────────────────────────────────
function getSponsorshipCategories(athlete, sport, totalReach, er, tier) {
  const categories = [];
  const sportL = sport.toLowerCase();
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const isMicro = totalReach >= 5000 && totalReach < 100000;
  const isMacro = totalReach >= 100000;

  // Sport-specific categories
  if (sportL.includes('football') || sportL.includes('basketball')) {
    categories.push({ name: 'Sports Performance & Training', fit: 'Elite', reason: 'Core audience expects performance content' });
    categories.push({ name: 'Hydration & Sports Nutrition', fit: 'Elite', reason: 'Direct audience alignment with game-day content' });
  }
  if (sportL.includes('gymnastics') || sportL.includes('volleyball') || sportL.includes('swimming')) {
    categories.push({ name: 'Activewear & Fitness Fashion', fit: 'Elite', reason: 'Aesthetic sport with high visual content potential' });
    categories.push({ name: 'Beauty & Wellness', fit: 'High', reason: 'Female-led sport audience drives premium CPM for these categories' });
  }
  if (sportL.includes('baseball') || sportL.includes('softball')) {
    categories.push({ name: 'Sports Equipment & Gear', fit: 'High', reason: 'Equipment-heavy sport with authentic product use' });
    categories.push({ name: 'Outdoor & Lifestyle', fit: 'High', reason: 'Baseball culture aligns with outdoor brand identity' });
  }

  // Universal categories based on reach tier
  if (isMicro || isMacro) {
    categories.push({ name: 'Local Restaurant & Food', fit: 'High', reason: 'Local fans are core audience — food deals convert well at any reach level' });
    categories.push({ name: 'Apparel & Footwear', fit: er >= 5 ? 'Elite' : 'High', reason: 'Athletes are natural fit for apparel content' });
  }
  if (isMacro) {
    categories.push({ name: 'Fintech & Banking (NIL specific)', fit: 'High', reason: 'Brands like Gainful, Opendorse, and regional credit unions actively recruit college athletes' });
    categories.push({ name: 'Gaming & Esports', fit: 'High', reason: 'College age audience — gaming brands pay premium for athlete reach' });
  }
  if (isP4) {
    categories.push({ name: 'Automotive (Regional Dealerships)', fit: 'High', reason: 'Regional auto dealers consistently target P4 athletes for local campaigns' });
    categories.push({ name: 'Collective & Booster Partnerships', fit: 'Elite', reason: 'P4 schools have active collectives seeking roster/ambassador deals' });
  }

  // Add nutrition regardless
  categories.push({ name: 'Protein & Supplements', fit: 'Medium', reason: 'Ubiquitous in athlete marketing — easy entry point for brand deals' });

  // Deduplicate and limit
  const seen = new Set();
  return categories.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  }).slice(0, 6);
}

// ─── Brand Partnership Type Engine ───────────────────────────────────────────
function getBrandPartnershipTypes(totalReach, er, tier, sport) {
  const types = [];
  if (totalReach < 5000) {
    types.push({ type: 'Collective Roster Deal', description: 'Join school\'s NIL collective for guaranteed monthly income', priority: 1 });
    types.push({ type: 'Local Ambassador', description: 'Campus restaurant, gym, or retail brand ambassador', priority: 2 });
    types.push({ type: 'Appearance Fee', description: 'Paid appearances at local events, camps, or business openings', priority: 3 });
  } else if (totalReach < 25000) {
    types.push({ type: 'Local Business Ambassador', description: 'Multi-month ambassador deal with local/regional business', priority: 1 });
    types.push({ type: 'Collective Roster Deal', description: 'School collective roster spot for guaranteed NIL income', priority: 2 });
    types.push({ type: 'Per-Post Brand Deal', description: 'Individual sponsored posts for relevant product categories', priority: 3 });
  } else if (totalReach < 100000) {
    types.push({ type: 'Brand Ambassador (Monthly Retainer)', description: 'Multi-month retainer with content requirements and exclusivity', priority: 1 });
    types.push({ type: 'Content Bundle (3-6 posts)', description: 'Packaged content deals across platforms at premium rates', priority: 2 });
    types.push({ type: 'Regional Campaign', description: 'Regional brand campaigns — best ROI at micro-influencer tier', priority: 3 });
  } else {
    types.push({ type: 'Annual Brand Retainer', description: 'Year-long exclusive or semi-exclusive ambassador partnership', priority: 1 });
    types.push({ type: 'National Campaign Partnership', description: 'Participate in national brand campaigns with performance bonuses', priority: 2 });
    types.push({ type: 'Co-Creation & Licensing', description: 'Custom product lines, signature merch, or licensed content', priority: 3 });
  }
  return types;
}

const DEAL_COMPS = [
  { sport:'basketball', school:'p4-top10', followers:180000, engagement:5.8, dealType:'ig-reel',  value:14500, year:2025 },
  { sport:'basketball', school:'p4-top10', followers:95000,  engagement:6.9, dealType:'ig-reel',  value:9200,  year:2025 },
  { sport:'basketball', school:'p4-mid',   followers:65000,  engagement:5.1, dealType:'ig-post',  value:5800,  year:2024 },
  { sport:'basketball', school:'p4-top10', followers:220000, engagement:4.2, dealType:'retainer', value:28000, year:2025 },
  { sport:'football',   school:'p4-top10', followers:310000, engagement:3.8, dealType:'bundle',   value:42000, year:2025 },
  { sport:'football',   school:'p4-top10', followers:125000, engagement:5.5, dealType:'ig-post',  value:9500,  year:2024 },
  { sport:'football',   school:'p4-mid',   followers:88000,  engagement:4.7, dealType:'retainer', value:18500, year:2025 },
  { sport:'basketball', school:'p4-top10', followers:155000, engagement:7.1, dealType:'ig-reel',  value:16800, year:2025 },
  { sport:'football',   school:'p4-mid',   followers:42000,  engagement:5.9, dealType:'ig-post',  value:3800,  year:2026 },
  { sport:'basketball', school:'highmajor-top', followers:38000, engagement:6.2, dealType:'ig-reel', value:3200, year:2026 },
  { sport:'football',   school:'p4-lower',  followers:28000, engagement:4.8, dealType:'ig-post',  value:2100,  year:2026 },
  { sport:'basketball', school:'mid-top',   followers:22000, engagement:7.1, dealType:'ig-reel',  value:1800,  year:2026 },
];

const BRAND_WINDOWS = {
  nike:          'Back-to-school (Q3) is peak. New signings typically Jan & Aug.',
  adidas:        'College season launch in Q3. Spring drop in Q2.',
  gatorade:      'Pre-summer push. Q2 budget opens April 1.',
  'new balance': 'Holiday campaign Q4. Campus drops Q3.',
  beats:         'Back to school electronics peak Q3. Holiday Q4.',
  'cash app':    'Tax season (Q1) and summer spending pushes.',
  'prime hydration': 'Year-round. Heavy college football push Q3.',
  'fanatics':    'Championship windows (March, Bowl season). Q4 peak.',
  'draftkings':  'Football season Q3-Q1. March Madness Q1.',
  'celsius':     'Summer Q2-Q3. Year-round campus activations.',
  'ghost energy': 'Year-round. Gaming + athlete crossover campaigns.',
  'body armor':  'Q3 football season push. College partnerships active.',
  'ag1':         'Q1 New Year health push. Athlete testimonials year-round.',
  'crocs':       'Back to school Q3. Cultural moment campaigns.',
  'manscaped':   'Male athlete focus. Year-round. College portal season high.',
};

module.exports = { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal };
