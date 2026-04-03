// server/benchmarks.js
const MARKET_RATES = {
  basePer1kReach: 52,
  sportMultiplier: {
    basketball: 1.40, football: 1.35, baseball: 1.10,
    soccer: 1.05, swimming: 0.95, track: 1.00,
    volleyball: 1.05, wrestling: 0.90, tennis: 1.00,
  },
  schoolMultiplier: {
    'p4-top10': 1.50, 'p4-mid': 1.30, 'p4-lower': 1.15,
    'mid-top': 1.00, 'mid-lower': 0.85,
  },
  deliverableMultiplier: {
    'ig-post': 1.00, 'tiktok': 0.90, 'ig-reel': 1.30,
    'stories': 0.45, 'bundle': 2.40, 'retainer': 4.20,
    'youtube-long': 2.20, 'newsletter': 0.80,
    'podcast-host': 1.10, 'twitter-campaign': 0.70,
  },
  appearanceFees: {
    'appearance-inperson':   { p4top: [3500,7500],  p4mid: [1500,4000],  p4low: [750,2000],  mid: [400,1200] },
    'appearance-speaking':   { p4top: [5000,12000], p4mid: [2000,5000],  p4low: [1000,2500], mid: [500,1500] },
    'appearance-meetgreet':  { p4top: [2000,5000],  p4mid: [800,2500],   p4low: [400,1200],  mid: [200,800]  },
    'appearance-campus':     { p4top: [1500,4000],  p4mid: [600,1800],   p4low: [300,900],   mid: [150,500]  },
    'media-podcast':         { p4top: [1500,4000],  p4mid: [500,1500],   p4low: [250,800],   mid: [100,500]  },
    'media-youtube':         { p4top: [2500,6000],  p4mid: [800,2500],   p4low: [400,1200],  mid: [200,700]  },
    'media-twitch':          { p4top: [1000,3000],  p4mid: [400,1200],   p4low: [200,700],   mid: [100,400]  },
    'media-pressday':        { p4top: [2000,5000],  p4mid: [750,2000],   p4low: [350,1000],  mid: [150,600]  },
    'license-jersey':        { p4top: [5000,20000], p4mid: [2000,8000],  p4low: [500,3000],  mid: [200,1500] },
    'license-merch':         { p4top: [3000,10000], p4mid: [1000,5000],  p4low: [500,2000],  mid: [200,1000] },
    'license-codesign':      { p4top: [2500,8000],  p4mid: [800,3000],   p4low: [300,1500],  mid: [150,700]  },
    'license-autograph':     { p4top: [2000,6000],  p4mid: [500,2000],   p4low: [200,800],   mid: [100,400]  },
    'collective-roster':     { p4top: [3000,8000],  p4mid: [1000,4000],  p4low: [400,1500],  mid: [200,800]  },
    'collective-ambassador': { p4top: [2000,6000],  p4mid: [800,2500],   p4low: [300,1000],  mid: [150,500]  },
    'collective-booster':    { p4top: [1500,4000],  p4mid: [500,1500],   p4low: [200,800],   mid: [100,400]  },
    'camp-skills':           { p4top: [3000,8000],  p4mid: [1000,3500],  p4low: [500,1500],  mid: [250,800]  },
    'camp-clinic':           { p4top: [2500,7000],  p4mid: [800,3000],   p4low: [400,1200],  mid: [200,700]  },
    'camp-training':         { p4top: [4000,12000], p4mid: [1500,5000],  p4low: [500,2000],  mid: [250,1000] },
  },
  industryAvgEngagement: { instagram: 2.58, tiktok: 4.10, combined: 3.20 },
  engagementMultiplier(rate) {
    if (rate >= 8)   return 1.55;
    if (rate >= 6)   return 1.30;
    if (rate >= 4)   return 1.10;
    if (rate >= 2.5) return 1.00;
    return 0.80;
  },
};

const DEAL_COMPS = [
  { sport:'basketball', school:'p4-top10', followers:180000, engagement:5.8, dealType:'ig-reel',  value:14500, year:2025 },
  { sport:'basketball', school:'p4-top10', followers:95000,  engagement:6.9, dealType:'ig-reel',  value:9200,  year:2025 },
  { sport:'basketball', school:'p4-mid',   followers:65000,  engagement:5.1, dealType:'ig-post',  value:5800,  year:2024 },
  { sport:'basketball', school:'p4-top10', followers:220000, engagement:4.2, dealType:'retainer', value:28000, year:2025 },
  { sport:'football',   school:'p4-top10', followers:310000, engagement:3.8, dealType:'bundle',   value:42000, year:2025 },
  { sport:'football',   school:'p4-top10', followers:125000, engagement:5.5, dealType:'ig-post',  value:9500,  year:2024 },
  { sport:'football',   school:'p4-mid',   followers:88000,  engagement:4.7, dealType:'retainer', value:18500, year:2025 },
  { sport:'basketball', school:'p4-top10', followers:155000, engagement:7.1, dealType:'ig-reel',  value:16800, year:2025 },
];

const BRAND_WINDOWS = {
  nike:          'Back-to-school (Q3) is peak. New signings typically Jan & Aug.',
  adidas:        'College season launch in Q3. Spring drop in Q2.',
  gatorade:      'Pre-summer push. Q2 budget opens April 1.',
  'new balance': 'Holiday campaign Q4. Campus drops Q3.',
  beats:         'Back to school electronics peak Q3. Holiday Q4.',
  'cash app':    'Tax season (Q1) and summer spending pushes.',
};

module.exports = { MARKET_RATES, DEAL_COMPS, BRAND_WINDOWS };
