// server/benchmarks.js — NILViewVal Model v5
// v5 overhaul: sharper scoring separation, real-deal comp anchoring, cross-platform bonuses,
// GPA/off-field signals, position-weighted stat impact, confidence-gated ranges,
// smarter sponsorship category engine with brand fit scoring.

const MARKET_RATES = {
  baseCPM: 12.0,

  seasonalCPM(sport) {
    const month = new Date().getMonth();
    if (sport === 'football') {
      return [13.5,13.0,11.0,10.5,10.0,10.5,11.5,12.5,15.0,15.5,14.5,13.5][month];
    }
    if (sport === 'basketball') {
      return [13.5,11.5,13.5,12.0,11.0,11.0,11.0,11.0,11.5,12.5,14.0,14.5][month];
    }
    if (sport === 'gymnastics' || sport === 'volleyball') {
      return [12.0,11.5,11.0,11.0,10.5,11.0,11.5,12.0,12.5,12.0,11.5,11.5][month];
    }
    return 12.0;
  },

  marketFactor: 1.06,

  positionMultiplier: {
    'qb': 2.00, 'quarterback': 2.00,
    'pg': 1.65, 'point guard': 1.65,
    'wr': 1.50, 'wide receiver': 1.50,
    'sg': 1.40, 'shooting guard': 1.40,
    'cb': 1.30, 'cornerback': 1.30,
    'edge': 1.35, 'de': 1.28, 'defensive end': 1.28,
    'rb': 1.25, 'running back': 1.25,
    'sf': 1.22, 'small forward': 1.22,
    'te': 1.18, 'tight end': 1.18,
    'lb': 1.12, 'linebacker': 1.12,
    'safety': 1.10, 's': 1.10, 'ss': 1.25,
    'pf': 1.08, 'power forward': 1.08,
    'center': 1.00,
    'sp': 1.32, 'starting pitcher': 1.32,
    'cf': 1.20, 'center field': 1.20,
    'catcher': 1.15, '1b': 1.10,
    'ol': 0.72, 'offensive line': 0.72, 'ot': 0.76, 'og': 0.72, 'c': 0.72,
    'dl': 0.82, 'defensive line': 0.82, 'dt': 0.80,
    'k': 0.68, 'kicker': 0.68, 'p': 0.65, 'punter': 0.65,
    'forward': 1.32, 'striker': 1.32,
    'midfielder': 1.12, 'goalkeeper': 1.05, 'defender': 0.95,
    'default': 1.00,
  },

  marketMultiplier: {
    'los angeles': 1.48, 'new york': 1.48, 'chicago': 1.42,
    'dallas': 1.40, 'houston': 1.37, 'atlanta': 1.34,
    'miami': 1.32, 'seattle': 1.30, 'boston': 1.30,
    'columbus': 1.38, 'tuscaloosa': 1.32, 'baton rouge': 1.30,
    'austin': 1.34, 'ann arbor': 1.28, 'norman': 1.24,
    'gainesville': 1.22, 'knoxville': 1.22, 'athens': 1.24,
    'durham': 1.27, 'chapel hill': 1.24, 'raleigh': 1.22,
    'south bend': 1.27, 'provo': 1.20, 'fort worth': 1.22,
    'nashville': 1.27, 'louisville': 1.17, 'lexington': 1.20,
    'clemson': 1.17, 'auburn': 1.17, 'starkville': 1.07,
    'columbia': 1.14, 'fayetteville': 1.17, 'stillwater': 1.12,
    'manhattan': 1.07, 'ames': 1.07, 'lincoln': 1.10,
    'birmingham': 1.10, 'memphis': 1.10, 'salt lake city': 1.14,
    'denver': 1.20, 'phoenix': 1.22, 'san diego': 1.24,
    'portland': 1.17, 'minneapolis': 1.17, 'detroit': 1.14,
    'pittsburgh': 1.14, 'baltimore': 1.17, 'washington': 1.27,
    'default': 1.00,
  },

  sportMultiplier: {
    'football': 1.50, 'basketball': 1.42,
    'womens basketball': 1.38, 'gymnastics': 1.45,
    'volleyball': 1.35, 'baseball': 1.18,
    'softball': 1.15, 'soccer': 1.08,
    'womens soccer': 1.12, 'lacrosse': 1.05,
    'wrestling': 0.94, 'swimming': 0.95,
    'womens swimming': 1.08,
    'track': 0.97, 'track & field': 0.97, 'womens track': 1.00,
    'golf': 0.97, 'tennis': 0.95,
    'womens golf': 1.02, 'womens tennis': 1.04,
    'cross country': 0.90,
  },

  schoolMultiplier: {
    'p4-top10':   1.55, 'p4-top25':   1.42, 'p4-mid':     1.28,
    'p4-lower':   1.12, 'highmajor-top': 1.07, 'highmajor-mid': 1.00,
    'mid-top':    0.92, 'mid-mid':    0.83, 'mid-lower':  0.76,
    'lowmajor-top': 0.70, 'lowmajor-lower': 0.64,
    'd2-elite':   0.58, 'd2-top':     0.52, 'd2-mid':     0.46, 'd2-lower':  0.40,
    'd3-top':     0.38, 'd3-mid':     0.33, 'd3-lower':   0.28,
    'naia-top':   0.36, 'naia-mid':   0.30,
    'juco-d1':    0.32, 'juco-d2':    0.26,
  },

  deliverableMultiplier: {
    'ig-post': 1.00, 'tiktok': 0.92, 'ig-reel': 1.35,
    'stories': 0.42, 'bundle': 2.50, 'retainer': 4.50,
    'youtube-long': 2.30, 'newsletter': 0.82,
    'podcast-host': 1.15, 'twitter-campaign': 0.68,
  },

  appearanceFees: {
    'appearance-inperson':   { p4top:[4000,9000],   p4mid:[1800,4500],  p4low:[900,2500],   mid:[450,1400] },
    'appearance-speaking':   { p4top:[6000,14000],  p4mid:[2500,6000],  p4low:[1200,3000],  mid:[600,1800] },
    'appearance-meetgreet':  { p4top:[2500,6000],   p4mid:[1000,3000],  p4low:[500,1500],   mid:[250,900]  },
    'appearance-campus':     { p4top:[1800,4500],   p4mid:[700,2000],   p4low:[350,1000],   mid:[175,600]  },
    'media-podcast':         { p4top:[1800,4500],   p4mid:[600,1800],   p4low:[300,950],    mid:[120,600]  },
    'media-youtube':         { p4top:[3000,7000],   p4mid:[1000,3000],  p4low:[500,1500],   mid:[250,850]  },
    'media-twitch':          { p4top:[1200,3500],   p4mid:[500,1400],   p4low:[250,800],    mid:[120,500]  },
    'media-pressday':        { p4top:[2500,6000],   p4mid:[900,2500],   p4low:[400,1200],   mid:[175,700]  },
    'license-jersey':        { p4top:[6000,25000],  p4mid:[2500,10000], p4low:[700,4000],   mid:[250,2000] },
    'license-merch':         { p4top:[3500,12000],  p4mid:[1200,6000],  p4low:[600,2500],   mid:[250,1200] },
    'license-codesign':      { p4top:[3000,10000],  p4mid:[1000,4000],  p4low:[400,2000],   mid:[175,850]  },
    'license-autograph':     { p4top:[2500,7000],   p4mid:[650,2500],   p4low:[250,1000],   mid:[120,500]  },
    'collective-roster':     { p4top:[3500,10000],  p4mid:[1200,5000],  p4low:[500,2000],   mid:[250,1000] },
    'collective-ambassador': { p4top:[2500,7000],   p4mid:[1000,3000],  p4low:[400,1200],   mid:[175,600]  },
    'collective-booster':    { p4top:[1800,5000],   p4mid:[600,1800],   p4low:[250,950],    mid:[120,500]  },
    'camp-skills':           { p4top:[3500,9000],   p4mid:[1200,4000],  p4low:[600,1800],   mid:[300,950]  },
    'camp-clinic':           { p4top:[3000,8000],   p4mid:[1000,3500],  p4low:[500,1500],   mid:[250,850]  },
    'camp-training':         { p4top:[5000,14000],  p4mid:[1800,6000],  p4low:[600,2500],   mid:[300,1200] },
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
    const pos = (athlete.position || '').toLowerCase();
    let mult = 1.0;

    if (sport.includes('basketball')) {
      if (ppg >= 25) mult += 0.60;
      else if (ppg >= 20) mult += 0.45;
      else if (ppg >= 15) mult += 0.28;
      else if (ppg >= 10) mult += 0.12;
      else if (ppg >= 5)  mult += 0.04;
      if (rpg >= 12) mult += 0.30;
      else if (rpg >= 9) mult += 0.20;
      else if (rpg >= 7) mult += 0.12;
      else if (rpg >= 5) mult += 0.05;
      const apgBonus = (pos.includes('pg') || pos.includes('guard')) ? 1.5 : 1.0;
      if (apg >= 8)  mult += 0.50 * apgBonus;
      else if (apg >= 6) mult += 0.38 * apgBonus;
      else if (apg >= 4) mult += 0.25 * apgBonus;
      else if (apg >= 2) mult += 0.12 * apgBonus;
      if (fgPct >= 0.58) mult += 0.18;
      else if (fgPct >= 0.52) mult += 0.10;
      else if (fgPct >= 0.47) mult += 0.04;
      if (bpg >= 3)  mult += 0.22;
      else if (bpg >= 2) mult += 0.15;
      if (spg >= 2)  mult += 0.15;
      else if (spg >= 1.5) mult += 0.08;
    } else if (sport.includes('football')) {
      if (ppg >= 2.0) mult += 0.45;
      else if (ppg >= 1.0) mult += 0.28;
      else if (ppg >= 0.5) mult += 0.12;
      if (rpg >= 150) mult += 0.45;
      else if (rpg >= 100) mult += 0.28;
      else if (rpg >= 60)  mult += 0.12;
      if (pos.includes('qb') && apg >= 70) mult += 0.35;
      else if (pos.includes('qb') && apg >= 60) mult += 0.18;
    } else if (sport.includes('baseball') || sport.includes('softball')) {
      if (ppg >= 0.35) mult += 0.25;
      else if (ppg >= 0.28) mult += 0.12;
      if (rpg >= 1.0) mult += 0.15;
    } else {
      if (ppg || rpg || apg) mult += 0.08;
    }
    return Math.min(mult, 3.0);
  },

  draftMultiplier(draftStatus) {
    if (!draftStatus) return 1.0;
    const s = draftStatus.toLowerCase();
    if (s.includes('top 3') || s.includes('top 5') || s.includes('lottery')) return 3.2;
    if (s.includes('declared') || s.includes('first round') || s.includes('1st round')) return 2.5;
    if (s.includes('second round') || s.includes('2nd round') || s.includes('prospect')) return 1.6;
    if (s.includes('fringe') || s.includes('undrafted')) return 1.2;
    return 1.0;
  },

  academicMultiplier(gpa) {
    const g = parseFloat(gpa) || 0;
    if (g >= 3.8) return 1.12;
    if (g >= 3.5) return 1.07;
    if (g >= 3.0) return 1.04;
    if (g >= 2.5) return 1.00;
    return 0.97;
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
    let score = 40;
    if (sport.includes('basketball')) {
      if (ppg >= 20) score += 20; else if (ppg >= 15) score += 13; else if (ppg >= 10) score += 7;
      if (rpg >= 10) score += 15; else if (rpg >= 7) score += 9; else if (rpg >= 5) score += 4;
      if (apg >= 5)  score += 15; else if (apg >= 3) score += 9; else if (apg >= 1.5) score += 4;
      if (fgPct >= 0.55) score += 8; else if (fgPct >= 0.48) score += 4;
      if (bpg >= 2) score += 8;
    } else if (sport.includes('football')) {
      if (ppg >= 2) score += 22; else if (ppg >= 1) score += 13;
      if (rpg >= 120) score += 18; else if (rpg >= 80) score += 10;
    }
    if (reach >= 200000) score += 12; else if (reach >= 100000) score += 9;
    else if (reach >= 50000) score += 6; else if (reach >= 25000) score += 3;
    const er = parseFloat(athlete.engagement) || 0;
    if (er >= 8) score += 8; else if (er >= 5) score += 4;
    return Math.min(score, 99);
  },

  engagementMultiplier(rate) {
    const ratio = (rate || 0) / 5.6;
    if (ratio >= 3.0) return 2.20;
    if (ratio >= 2.0) return 1.85;
    if (ratio >= 1.5) return 1.55;
    if (ratio >= 1.0) return 1.25;
    if (ratio >= 0.7) return 1.00;
    if (ratio >= 0.4) return 0.80;
    return 0.65;
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

// ─── NILViewVal v5 Main Valuation Function ────────────────────────────────────
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
  const statsMul = MARKET_RATES.statsMultiplier(athlete);
  const draftMul = MARKET_RATES.draftMultiplier(athlete.draftStatus || '');
  const acadMul = MARKET_RATES.academicMultiplier(athlete.gpa);
  const crossPlatformBonus = (ig > 0 && tt > 0) ? 1.12 : 1.0;

  let reachMult;
  if (totalReach >= 1000000)     reachMult = 2.20;
  else if (totalReach >= 500000) reachMult = 1.90;
  else if (totalReach >= 250000) reachMult = 1.60;
  else if (totalReach >= 100000) reachMult = 1.30;
  else if (totalReach >= 50000)  reachMult = 1.08;
  else if (totalReach >= 25000)  reachMult = 0.90;
  else if (totalReach >= 10000)  reachMult = 0.74;
  else if (totalReach >= 5000)   reachMult = 0.58;
  else                           reachMult = 0.42;

  const delivMult = MARKET_RATES.deliverableMultiplier[deliverableType] || 1.0;

  const totalMult = erMult * schoolMult * sportMult * posMult * marketMult
    * reachMult * delivMult * statsMul * draftMul * acadMul
    * crossPlatformBonus * MARKET_RATES.marketFactor;

  const valuePerView = (cpm * totalMult) / 1000;

  let viewRate;
  switch (deliverableType) {
    case 'ig-reel':   viewRate = 0.38; break;
    case 'tiktok':    viewRate = 0.45; break;
    case 'stories':   viewRate = 0.14; break;
    case 'ig-post':   viewRate = 0.22; break;
    default:          viewRate = 0.28;
  }

  const avgViews = totalReach > 0 ? totalReach * viewRate : 5000;
  const valuePerPost = valuePerView * avgViews;

  const dataScore =
    (ig > 0 ? 22 : 0) + (tt > 0 ? 14 : 0) + (er > 0 ? 20 : 0) +
    (tier && tier !== 'mid-mid' ? 20 : 10) + (position ? 14 : 0) +
    (school ? 10 : 0) + (athlete.stats || athlete.ppg ? 8 : 0) +
    (athlete.gpa ? 5 : 0) + 3;
  const confidenceScore = Math.max(45, Math.min(97, dataScore));

  const floorRates = {
    'p4-top10':      { low: 200, mid: 280, high: 420 },
    'p4-top25':      { low: 140, mid: 200, high: 300 },
    'p4-mid':        { low: 95,  mid: 140, high: 210 },
    'p4-lower':      { low: 65,  mid: 95,  high: 145 },
    'highmajor-top': { low: 50,  mid: 75,  high: 115 },
    'highmajor-mid': { low: 40,  mid: 60,  high: 90  },
    'mid-top':       { low: 32,  mid: 48,  high: 72  },
    'mid-mid':       { low: 26,  mid: 38,  high: 58  },
    'mid-lower':     { low: 20,  mid: 30,  high: 46  },
    'lowmajor-top':  { low: 16,  mid: 24,  high: 36  },
    'lowmajor-lower':{ low: 12,  mid: 18,  high: 28  },
    'd2-elite':      { low: 10,  mid: 15,  high: 24  },
    'd2-top':        { low: 8,   mid: 12,  high: 20  },
    'd2-mid':        { low: 5,   mid: 8,   high: 14  },
  };
  const floor = floorRates[tier] || { low: 15, mid: 22, high: 35 };
  const floorLow  = Math.round(floor.low  * delivMult);
  const floorMid  = Math.round(floor.mid  * delivMult);
  const floorHigh = Math.round(floor.high * delivMult);

  const rawLow  = Math.round(valuePerPost * 0.72);
  const rawMid  = Math.round(valuePerPost);
  const rawHigh = Math.round(valuePerPost * 1.40);

  const finalLow  = Math.max(rawLow,  floorLow);
  const finalMid  = Math.max(rawMid,  floorMid);
  const finalHigh = Math.max(rawHigh, floorHigh);
  const floorApplied = finalLow > rawLow;

  let recommendation = null;
  if (totalReach < 5000) {
    recommendation = 'Under 5K followers — social brand deals limited. Priority: (1) Collective roster deal $300-1K/mo, (2) Local appearances $150-400/event, (3) Campus ambassador $200-600/mo.';
  } else if (totalReach < 15000) {
    recommendation = 'Micro-level reach. Best: local/regional businesses, collective roster spots, campus ambassador roles. Per-post deals $50-250 range.';
  }

  // v5 Composite Scores
  let marketabilityScore = 0;
  if      (totalReach >= 500000) marketabilityScore += 35;
  else if (totalReach >= 200000) marketabilityScore += 29;
  else if (totalReach >= 100000) marketabilityScore += 23;
  else if (totalReach >= 50000)  marketabilityScore += 17;
  else if (totalReach >= 25000)  marketabilityScore += 12;
  else if (totalReach >= 10000)  marketabilityScore += 8;
  else if (totalReach >= 5000)   marketabilityScore += 4;
  else                           marketabilityScore += 1;

  if      (er >= 12) marketabilityScore += 22;
  else if (er >= 9)  marketabilityScore += 18;
  else if (er >= 7)  marketabilityScore += 14;
  else if (er >= 5)  marketabilityScore += 10;
  else if (er >= 3)  marketabilityScore += 6;
  else               marketabilityScore += 2;

  if (ig > 0 && tt > 0) marketabilityScore += 5;
  else if (ig > 0 || tt > 0) marketabilityScore += 2;

  if      (sportMult >= 1.45) marketabilityScore += 13;
  else if (sportMult >= 1.35) marketabilityScore += 10;
  else if (sportMult >= 1.20) marketabilityScore += 7;
  else if (sportMult >= 1.05) marketabilityScore += 4;
  else                        marketabilityScore += 2;

  if      (posMult >= 1.65) marketabilityScore += 8;
  else if (posMult >= 1.40) marketabilityScore += 6;
  else if (posMult >= 1.20) marketabilityScore += 4;
  else if (posMult >= 1.00) marketabilityScore += 2;
  else                       marketabilityScore += 1;

  if      (schoolMult >= 1.42) marketabilityScore += 12;
  else if (schoolMult >= 1.28) marketabilityScore += 9;
  else if (schoolMult >= 1.12) marketabilityScore += 6;
  else if (schoolMult >= 0.92) marketabilityScore += 3;
  else                         marketabilityScore += 1;

  if      (draftMul >= 2.8) marketabilityScore += 5;
  else if (draftMul >= 2.0) marketabilityScore += 3;
  else if (draftMul >= 1.5) marketabilityScore += 1;

  marketabilityScore = Math.min(99, marketabilityScore);

  let sponsorshipReadiness = 15;
  if (ig > 0)  sponsorshipReadiness += 18;
  if (tt > 0)  sponsorshipReadiness += 12;
  if (er >= 3) sponsorshipReadiness += 12;
  if (athlete.stats || athlete.ppg) sponsorshipReadiness += 10;
  if (athlete.school)   sponsorshipReadiness += 8;
  if (athlete.position) sponsorshipReadiness += 7;
  if (athlete.year)     sponsorshipReadiness += 5;
  if (athlete.gpa && parseFloat(athlete.gpa) >= 3.0) sponsorshipReadiness += 8;
  if (totalReach >= 10000) sponsorshipReadiness += 5;
  if (ig > 0 && tt > 0)   sponsorshipReadiness += 5;
  sponsorshipReadiness = Math.min(98, sponsorshipReadiness);

  let audienceQuality = 25;
  const erRatio = er / 5.6;
  if      (erRatio >= 3.0) audienceQuality += 38;
  else if (erRatio >= 2.0) audienceQuality += 28;
  else if (erRatio >= 1.5) audienceQuality += 20;
  else if (erRatio >= 1.0) audienceQuality += 14;
  else if (erRatio >= 0.7) audienceQuality += 8;
  else                     audienceQuality += 2;
  if (ig > 0 && tt > 0) audienceQuality += 14;
  else if (ig > 0)       audienceQuality += 7;
  const premiumSports = ['football','basketball','gymnastics','volleyball','womens basketball'];
  if (premiumSports.some(s => sport.includes(s))) audienceQuality += 14;
  else if (['baseball','soccer','softball','swimming'].some(s => sport.includes(s))) audienceQuality += 9;
  else audienceQuality += 4;
  if (totalReach >= 5000 && totalReach < 100000 && er >= 8) audienceQuality += 9;
  audienceQuality = Math.min(99, audienceQuality);

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
      reach: totalReach, sportMult: sportMult.toFixed(2),
      schoolMult: schoolMult.toFixed(2), posMult: posMult.toFixed(2),
      marketMult: marketMult.toFixed(2), engMult: erMult.toFixed(2),
      cpm: cpm.toFixed(2), statsMult: statsMul.toFixed(2),
      draftMult: draftMul.toFixed(2), acadMult: acadMul.toFixed(2),
      crossPlatform: crossPlatformBonus.toFixed(2),
    },
    multipliers: {
      er: erMult.toFixed(2), school: schoolMult, sport: sportMult,
      position: posMult, market: marketMult, reach: reachMult,
      total: totalMult.toFixed(2),
    }
  };
}

// ─── Sponsorship Category Engine v5 ──────────────────────────────────────────
function getSponsorshipCategories(athlete, sport, totalReach, er, tier, posMult) {
  const sportL = sport.toLowerCase();
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const isMicro = totalReach >= 5000 && totalReach < 100000;
  const isMacro = totalReach >= 100000;
  const gpa = parseFloat(athlete.gpa) || 0;
  const pos = (athlete.position || '').toLowerCase();
  const cats = [];

  if (sportL.includes('football') || sportL.includes('basketball')) {
    cats.push({ name: 'Sports Performance & Training', fit: 'Elite', score: 95, reason: 'Core audience expects performance content — natural and authentic' });
    cats.push({ name: 'Hydration & Sports Nutrition', fit: 'Elite', score: 93, reason: 'Game-day content + athlete lifestyle = perfect product match' });
  }
  if (sportL.includes('gymnastics') || sportL.includes('volleyball') || sportL.includes('swimming')) {
    cats.push({ name: 'Activewear & Fitness Fashion', fit: 'Elite', score: 94, reason: 'Aesthetic sport — high visual content value for apparel brands' });
    cats.push({ name: 'Beauty & Wellness', fit: 'Elite', score: 91, reason: 'Female-led sport with high-value female demographic — premium CPM' });
    cats.push({ name: 'Sports Performance & Training', fit: 'High', score: 82, reason: 'Athletic discipline aligns strongly with performance brands' });
  }
  if (sportL.includes('baseball') || sportL.includes('softball')) {
    cats.push({ name: 'Sports Equipment & Gear', fit: 'High', score: 85, reason: 'Equipment-heavy sport with authentic daily product use content' });
    cats.push({ name: 'Outdoor & Lifestyle', fit: 'High', score: 80, reason: 'Baseball culture aligns naturally with outdoor brand identity' });
  }
  if (sportL.includes('golf')) {
    cats.push({ name: 'Luxury & Premium Brands', fit: 'High', score: 82, reason: 'Golf audience skews high-income — luxury brands pay premium for this demo' });
    cats.push({ name: 'Sports Equipment & Gear', fit: 'Elite', score: 90, reason: 'Equipment-driven sport with high buyer intent in audience' });
  }
  if (pos.includes('qb') || (posMult >= 1.60)) {
    cats.push({ name: 'Automotive (National)', fit: 'Elite', score: 88, reason: 'QBs and star athletes command national auto campaigns — highest ROI position' });
  }

  cats.push({ name: 'Local Restaurant & Food', fit: totalReach < 50000 ? 'Elite' : 'High', score: totalReach < 50000 ? 90 : 78, reason: 'Local fans are core audience — food deals convert well at every reach level' });
  cats.push({ name: 'Apparel & Footwear', fit: er >= 6 ? 'Elite' : 'High', score: er >= 6 ? 88 : 76, reason: 'Athletes are the most natural fit for apparel — authentic content easy to create' });
  cats.push({ name: 'Protein & Supplements', fit: 'Medium', score: 65, reason: 'Ubiquitous in athlete marketing — easy entry point deal' });

  if (isMacro) {
    cats.push({ name: 'Energy Drinks & Beverages', fit: 'Elite', score: 89, reason: 'Celsius, Ghost, Body Armor, Prime — all actively running macro athlete NIL deals' });
    cats.push({ name: 'Fintech & Banking', fit: 'High', score: 82, reason: 'Regional credit unions + fintech apps actively recruit college athletes for NIL' });
    cats.push({ name: 'Gaming & Esports', fit: 'High', score: 80, reason: 'College-age audience — gaming brands pay premium for athlete authenticity' });
  }
  if (isP4) {
    cats.push({ name: 'Automotive (Regional Dealerships)', fit: 'High', score: 84, reason: 'Regional auto dealers consistently target P4 athletes — fast close, multi-month' });
    cats.push({ name: 'Collective & School Partnerships', fit: 'Elite', score: 92, reason: 'P4 collectives have active budgets — roster and ambassador deals move fast' });
  }
  if (gpa >= 3.2) {
    cats.push({ name: 'Education & EdTech', fit: 'High', score: 78, reason: 'Academic achievement = ideal fit for Chegg, Coursera, and ed-focused sponsors' });
  }
  if (isMicro && er >= 7) {
    cats.push({ name: 'Direct-to-Consumer Brands', fit: 'High', score: 83, reason: 'High-ER micro accounts deliver better DTC conversion than macro — brands know this' });
  }

  const seen = new Set();
  return cats
    .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

// ─── Brand Partnership Type Engine v5 ────────────────────────────────────────
function getBrandPartnershipTypes(totalReach, er, tier, sport) {
  const isP4 = tier && (tier.startsWith('p4') || tier.startsWith('highmajor'));
  const types = [];
  if (totalReach < 5000) {
    types.push({ type: 'Collective Roster Deal', description: "Join school's NIL collective — guaranteed monthly income, no social requirement", priority: 1 });
    types.push({ type: 'Local Business Ambassador', description: 'Campus restaurant, gym, barber, retail — $150-500/month + product', priority: 2 });
    types.push({ type: 'Paid Appearance', description: 'Local events, camps, youth clinics — $100-350/event at this level', priority: 3 });
  } else if (totalReach < 25000) {
    types.push({ type: 'Local Business Ambassador', description: 'Multi-month deal with local/regional brand — best ROI at this reach level', priority: 1 });
    types.push({ type: 'Collective Roster Spot', description: 'School collective for guaranteed monthly NIL income', priority: 2 });
    types.push({ type: 'Per-Post Sponsored Content', description: 'Individual sponsored posts — $75-400/post depending on ER and category', priority: 3 });
  } else if (totalReach < 100000) {
    types.push({ type: 'Brand Ambassador Retainer', description: 'Multi-month retainer with content deliverables — $500-2,500/month + exclusivity premium', priority: 1 });
    types.push({ type: 'Content Bundle Deal', description: '3-6 post packages across platforms — bundle pricing adds 2-3x per-post value', priority: 2 });
    types.push({ type: 'Regional Campaign Partner', description: 'Regional brand campaigns — micro-influencers earn higher CPM than macro', priority: 3 });
    if (er >= 7) types.push({ type: 'DTC Brand Partnership', description: 'High-ER micro accounts are DTC gold — brands pay for conversion data', priority: 4 });
  } else {
    types.push({ type: 'Annual Brand Retainer', description: 'Year-long ambassador deal — exclusivity clause adds 20-40% premium', priority: 1 });
    types.push({ type: 'National Campaign Partner', description: 'National brand campaigns with performance bonuses tied to impressions or conversions', priority: 2 });
    types.push({ type: 'Co-Creation & Licensing', description: 'Custom product lines, signature merch, licensed content — highest ceiling deals', priority: 3 });
    if (isP4) types.push({ type: 'Multimedia Exclusivity Package', description: 'TV + digital + OOH + social — regional/national brands pay 3-5x for full exclusivity', priority: 4 });
  }
  return types;
}

// ─── Deal Comps ───────────────────────────────────────────────────────────────
const DEAL_COMPS = [
  { sport:'basketball', school:'p4-top10',      followers:180000, engagement:5.8,  dealType:'ig-reel',  value:14500, year:2025 },
  { sport:'basketball', school:'p4-top10',      followers:95000,  engagement:6.9,  dealType:'ig-reel',  value:9200,  year:2025 },
  { sport:'basketball', school:'p4-mid',        followers:65000,  engagement:5.1,  dealType:'ig-post',  value:5800,  year:2024 },
  { sport:'basketball', school:'p4-top10',      followers:220000, engagement:4.2,  dealType:'retainer', value:28000, year:2025 },
  { sport:'football',   school:'p4-top10',      followers:310000, engagement:3.8,  dealType:'bundle',   value:42000, year:2025 },
  { sport:'football',   school:'p4-top10',      followers:125000, engagement:5.5,  dealType:'ig-post',  value:9500,  year:2024 },
  { sport:'football',   school:'p4-mid',        followers:88000,  engagement:4.7,  dealType:'retainer', value:18500, year:2025 },
  { sport:'basketball', school:'p4-top10',      followers:155000, engagement:7.1,  dealType:'ig-reel',  value:16800, year:2025 },
  { sport:'football',   school:'p4-mid',        followers:42000,  engagement:5.9,  dealType:'ig-post',  value:3800,  year:2026 },
  { sport:'basketball', school:'highmajor-top', followers:38000,  engagement:6.2,  dealType:'ig-reel',  value:3200,  year:2026 },
  { sport:'football',   school:'p4-lower',      followers:28000,  engagement:4.8,  dealType:'ig-post',  value:2100,  year:2026 },
  { sport:'basketball', school:'mid-top',       followers:22000,  engagement:7.1,  dealType:'ig-reel',  value:1800,  year:2026 },
  { sport:'gymnastics', school:'p4-top10',      followers:145000, engagement:9.2,  dealType:'ig-reel',  value:13200, year:2025 },
  { sport:'volleyball', school:'p4-mid',        followers:68000,  engagement:8.1,  dealType:'bundle',   value:8400,  year:2026 },
  { sport:'basketball', school:'p4-top25',      followers:52000,  engagement:11.4, dealType:'ig-reel',  value:6900,  year:2026 },
  { sport:'football',   school:'p4-top25',      followers:190000, engagement:4.1,  dealType:'retainer', value:32000, year:2026 },
];

const BRAND_WINDOWS = {
  nike:              'Back-to-school (Q3) is peak. New signings typically Jan & Aug.',
  adidas:            'College season launch in Q3. Spring drop in Q2.',
  gatorade:          'Pre-summer push. Q2 budget opens April 1.',
  'new balance':     'Holiday campaign Q4. Campus drops Q3.',
  beats:             'Back to school electronics peak Q3. Holiday Q4.',
  'cash app':        'Tax season (Q1) and summer spending pushes.',
  'prime hydration': 'Year-round. Heavy college football push Q3.',
  'fanatics':        'Championship windows (March, Bowl season). Q4 peak.',
  'draftkings':      'Football season Q3-Q1. March Madness Q1.',
  'celsius':         'Summer Q2-Q3. Year-round campus activations.',
  'ghost energy':    'Year-round. Gaming + athlete crossover campaigns.',
  'body armor':      'Q3 football season push. College partnerships active.',
  'ag1':             'Q1 New Year health push. Athlete testimonials year-round.',
  'crocs':           'Back to school Q3. Cultural moment campaigns.',
  'manscaped':       'Male athlete focus. Year-round. College portal season high.',
  'toyota':          'Q3-Q4 push. Regional dealers active year-round for NIL.',
  'ford':            'Truck/SUV campaigns heavy in Q3-Q4 college football season.',
};

module.exports = { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS, nilViewVal };
