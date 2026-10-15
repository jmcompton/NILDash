'use strict';
// Runs against the local test Postgres (the slate reads the database).
//
//   node tests/dealmix.js
//
// ── THE THREE-LANE DEAL MIX (services/dealMix, MARKET_MIX_ON) ───────────────
// The tier splits the five slots between local, social and national; brand
// size matches the tier (never a national brand for a Local Star); a social
// or national card needs an official application page or a named
// partnerships / influencer / marketing contact; every pitch rests on a
// researched reason the athlete fits the brand (services/fitReasons).
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store');
const DM = require(REPO + 'server/services/dealMix');
const Fit = require(REPO + 'server/services/fitReasons');
const Scout = require(REPO + 'server/services/scout');
const MR = require(REPO + 'server/services/dealMixReport');
const PW = require(REPO + 'server/services/pitchWriter');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  // ── 1. THE SPLIT ──────────────────────────────────────────────────────────
  OUT.push('-- the five slots, by tier --');
  const m = (t) => DM.mixFor(t);
  ok('Local Star: 4 local, 1 social', m('local_star').local === 4 && m('local_star').social === 1 && m('local_star').national === 0);
  ok('Rising: 3 local, 2 social', m('rising').local === 3 && m('rising').social === 2 && m('rising').national === 0);
  ok('Regional: 2 local, 2 social, 1 national', m('regional').local === 2 && m('regional').social === 2 && m('regional').national === 1);
  ok('National: 1 local, 2 social, 2 national', m('national').local === 1 && m('national').social === 2 && m('national').national === 2);
  ok('every tier is five', ['local_star', 'rising', 'regional', 'national'].every((t) => m(t).local + m(t).social + m(t).national === 5));
  ok('an unknown tier is a Local Star', DM.mixFor('nonsense') === DM.MIX.local_star);
  ok('held cards come off their lane\'s seats', JSON.stringify(DM.remaining('regional', { local: 1, social: 2, national: 0 })) === JSON.stringify({ local: 1, social: 0, national: 1 }));
  ok('  never below zero (old cards past a lane\'s seats)', DM.remaining('local_star', { national: 2 }).national === 0);
  ok('a Local Star\'s lanes: no national; Rising: no national; Regional and National: all three',
    !DM.lanesFor('local_star').national && DM.lanesFor('local_star').social && !DM.lanesFor('rising').national && DM.lanesFor('regional').national && DM.lanesFor('national').national);

  // ── 2. BRAND SIZE MATCHES THE TIER ────────────────────────────────────────
  OUT.push('', '-- brand size matches the tier --');
  const soc = (o) => ({ lane: 'social', brand_name: 'Mx Brand', ...o });
  const nat = (o) => ({ lane: 'national', brand_name: 'Mx Brand', ...o });
  ok('size: recorded by the index first, else 20+ logged deals national, 3-19 mid, else unknown',
    DM.sizeOf(soc({ brandSize: 'small', dealCount: 40 })).size === 'small' && DM.sizeOf(soc({ brandSize: 'national' })).size === 'national'
    && DM.sizeOf(soc({ dealCount: 25 })).size === 'national' && DM.sizeOf(soc({ dealCount: 5 })).size === 'mid' && DM.sizeOf(soc({ dealCount: 2 })).size === null);
  ok('a household incumbent is never sized as anything but incumbent', DM.sizeOf(nat({ brand_name: 'Nike' })).size === 'incumbent');
  ok('Local Star: a small social brand takes the seat', DM.seatOk('local_star', soc({ brandSize: 'small' })).ok);
  const lsNat = DM.seatOk('local_star', soc({ brandSize: 'national' }));
  ok('  never a national brand for a Local Star, and the reason says so', !lsNat.ok && /Local Star/.test(lsNat.why), lsNat);
  ok('  nor a mid-size one', !DM.seatOk('local_star', soc({ dealCount: 8 })).ok);
  ok('  nor any national-lane brand (a Local Star has no national seats)', !DM.seatOk('local_star', nat({ brandSize: 'small' })).ok);
  const lsChain = DM.seatOk('local_star', { lane: 'local', brand_name: 'Chick-fil-A' });
  ok('  nor a national chain location in the local lane', !lsChain.ok && /national/.test(lsChain.why), lsChain);
  ok('  an independent local business is fine', DM.seatOk('local_star', { lane: 'local', brand_name: 'Mx Corner Cafe' }).ok);
  ok('Rising: small to mid social brands, never national', DM.seatOk('rising', soc({ brandSize: 'small' })).ok && DM.seatOk('rising', soc({ dealCount: 6 })).ok && !DM.seatOk('rising', soc({ brandSize: 'national' })).ok);
  ok('Regional: national lane takes mid or national; social small or mid',
    DM.seatOk('regional', nat({ dealCount: 30 })).ok && DM.seatOk('regional', nat({ dealCount: 4 })).ok && !DM.seatOk('regional', nat({ brandSize: 'small' })).ok
    && DM.seatOk('regional', soc({ brandSize: 'small' })).ok && !DM.seatOk('regional', soc({ brandSize: 'national' })).ok);
  ok('National: mid to national on both brand lanes', DM.seatOk('national', soc({ brandSize: 'national' })).ok && DM.seatOk('national', nat({ dealCount: 25 })).ok
    && !DM.seatOk('national', soc({ brandSize: 'small' })).ok);
  const unknownSize = DM.seatOk('national', nat({ dealCount: 1 }));
  ok('a brand whose size we cannot read takes no size-limited seat, and says why', !unknownSize.ok && /cannot be matched/.test(unknownSize.why), unknownSize);
  ok('an incumbent is never pitched, on any tier', ['local_star', 'rising', 'regional', 'national'].every((t) => !DM.seatOk(t, nat({ brand_name: 'Gatorade', brandSize: 'national' })).ok));

  // ── 3. THE SAME BAR ON EVERY LANE ─────────────────────────────────────────
  OUT.push('', '-- the same bar on every lane --');
  const off = (u, w) => DM.isOfficialProgramPage(u, w).ok;
  ok('an ambassador page on the brand\'s own domain is an official application page', off('https://www.glowbars.com/pages/athlete-ambassadors', 'https://glowbars.com'));
  ok('  so is an apply page on a creator platform the brand runs its program on', off('https://glowbars.grin.live/apply', null) || off('https://creators.grin.co/glowbars', null));
  ok('  the brand\'s home page is not', !off('https://glowbars.com/', 'https://glowbars.com'));
  ok('  a page on someone else\'s domain is not', !off('https://nilmarketplace.example/glowbars-ambassador', 'https://glowbars.com'));
  ok('  a non-program page on the brand\'s domain is not', !off('https://glowbars.com/products/bar', 'https://glowbars.com'));
  ok('the scout\'s website fallback is never read as an application page: only the index\'s verified page counts',
    DM.officialPageOf({ programUrl: 'https://glowbars.com', website: 'https://glowbars.com', proofUrl: null }).url === null
    && DM.officialPageOf({ proofUrl: 'https://glowbars.com/ambassadors', website: 'https://glowbars.com' }).url === 'https://glowbars.com/ambassadors');
  const t = (x) => DM.contactTitleOk(x).ok;
  ok('a named partnerships, influencer or marketing contact passes', t('Director of Athlete Partnerships') && t('Influencer Marketing Manager') && t('VP Marketing') && t('Brand Partnerships Lead') && t('Sponsorship Manager'));
  ok('  a founder, a CEO, a sales rep or an intern does not', !t('Founder & CEO') && !t('Chief Executive Officer') && !t('Sales Representative') && !t('Marketing Intern') && !t(''));
  ok('under EMAIL_FIVE_ON a verified email or an official program card holds a slot; a DM, a call or an unverified email does not',
    DM.holdsUnderMix({ channel: 'email', email_verified: true }, { five: true }) && DM.holdsUnderMix({ channel: 'program', program_url: 'https://x.com/ambassadors' }, { five: true })
    && !DM.holdsUnderMix({ channel: 'dm' }, { five: true }) && !DM.holdsUnderMix({ channel: 'call' }, { five: true })
    && !DM.holdsUnderMix({ channel: 'email', email_verified: false }, { five: true }) && !DM.holdsUnderMix({ channel: 'program', program_url: 'https://x.com/' }, { five: true }));
  ok('  without it every queued card holds, as before', DM.holdsUnderMix({ channel: 'dm' }, { five: false }));
  ok('held cards are counted by lane (a card with no lane is local)', JSON.stringify(DM.heldByLane([{ channel: 'email', email_verified: true, lane: 'social' },
    { channel: 'email', email_verified: true, lane: null }, { channel: 'dm', lane: 'national' }], { five: true })) === JSON.stringify({ local: 1, social: 1, national: 0 }));
  const EF = require(REPO + 'server/services/emailFinder');
  const ca = EF.passes({ verdict: 'catch-all', built: true, patternConfirmed: true, realName: true, validOnly: true });
  ok('a brand contact\'s address must verify valid: a catch-all built from a confirmed pattern does not pass', !ca.ok && /must verify as valid/.test(ca.why), ca);
  ok('  (the local lane\'s rule is unchanged: that address passes there)', EF.passes({ verdict: 'catch-all', built: true, patternConfirmed: true, realName: true }).ok);

  // ── 4. WHY THIS ATHLETE FITS THIS BRAND ───────────────────────────────────
  OUT.push('', '-- why this athlete fits this brand --');
  const ath = { name: 'Mx Jordan', sport: 'Softball', instagram: 8000, tiktok: 0, stateCode: 'TX' };
  const cand = { brand_name: 'Mx Glow Bars', lane: 'social', sports: ['softball', 'volleyball'], offerSummary: 'Free product and a commission code for college athletes',
    signingEvidence: [
      { kind: 'program', source: 'https://glowbars.com/ambassadors', date: '2026-09-02', range: [2000, 50000] },
      { kind: 'deal', athlete: 'Kay Smith', followers: 9000, sport: 'Softball', school: 'Texas Tech University', source: 'https://www.on3.com/nil/x', date: '2026-08-10' },
      { kind: 'deal', athlete: 'Lee Park', followers: 12000, sport: 'Volleyball', school: 'Baylor University', source: 'https://www.on3.com/nil/y', date: '2026-07-01' },
    ] };
  const fit = Fit.build(cand, ath, { verifiedIg: { followers: 8100, asOf: '2026-10-10', avgReachPerPost: 2300 } });
  ok('past campaigns, audience, sport and region are all found', ['audience', 'campaign', 'sport', 'region'].every((k) => fit.kinds.includes(k)), fit);
  ok('  the audience fact pairs the athlete\'s reach with the range the program states', fit.reasons.some((r) => /^Audience: 8,000 followers is inside the 2,000-50,000 range/.test(r)), fit.reasons);
  ok('  the region fact is a signing at a school in the athlete\'s state', fit.reasons.some((r) => /^Region: they signed an athlete at Texas Tech University, in the athlete's state \(TX\)/.test(r)), fit.reasons);
  ok('  the connected Instagram\'s own numbers are on the card', fit.reasons.some((r) => /8,100 Instagram followers from the connected account/.test(r)));
  ok('the writer\'s lines are about the brand, three at most, with no follower numbers',
    fit.lines.length <= 3 && fit.lines.every((l) => !/\d{1,3},\d{3}|\d{4,}/.test(l.replace(/\b20\d\d\b/g, ''))), fit.lines);
  ok('  another athlete\'s sport is named only when it is ours (the writer refuses any other sport)',
    fit.lines.some((l) => /Signed Kay Smith, a softball athlete, at Texas Tech University/.test(l)) && !fit.lines.some((l) => /volleyball/i.test(l) && /Lee Park/.test(l)), fit.lines);
  ok('  and the writer\'s own fact check accepts a pitch that states one', PW.verifyAthleteFacts(`Hi Dana, you ${fit.lines[0].charAt(0).toLowerCase() + fit.lines[0].slice(1)}. Jordan plays softball.`, { ...ath, sport: 'Softball' }).ok,
    PW.verifyAthleteFacts(`Hi Dana, you ${fit.lines[0]}. Jordan plays softball.`, { ...ath, sport: 'Softball' }));
  const bare = Fit.build({ brand_name: 'Mx Nofit', lane: 'social', sports: ['all'], offerSummary: 'Free product for athletes' }, ath, {});
  ok('no past campaign, audience range, sport or region fact: not researched (no card), however good the offer reads', !Fit.researched(bare) && Fit.researched(fit), bare);
  ok('after writing: a pitch that states one of the lines passes', Fit.statesFit({ message: 'Hi', evidenceUsed: 2 }, fit).ok && Fit.statesFit({ message: 'Hi', evidenceUsed: 2 }, fit).line === fit.lines[1]);
  const nofit = Fit.statesFit({ message: 'Hi Dana, Jordan would love to work with you.', evidenceUsed: 0 }, fit);
  ok('  one that states none of them is refused: no filler', !nofit.ok && /does not say why this athlete fits/.test(nofit.why), nofit);
  const lr = Fit.localReasons({ sponsorSignal: { kind: 'reported-deal-at-school', detail: 'Signed a Baylor quarterback in 2026' } }, { market: 'Waco, TX' }, { evidence: ['Sponsors Waco High athletics'], evidenceUsed: 1 });
  ok('a local card\'s fit: the town, the marketing line the pitch stated, a deal at the school',
    lr[0] === 'Region: in Waco, TX, where the athlete goes to school' && lr[1] === 'Their marketing: Sponsors Waco High athletics' && /^Past campaign/.test(lr[2]), lr);

  // ── 5. THE SLATE UNDER THE MIX ────────────────────────────────────────────
  OUT.push('', '-- the slate under the mix --');
  const P = store.pool;
  const KEY = 'mxslate, tx';
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]);
  for (let i = 0; i < 20; i++) await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [KEY, `Mx Slate Diner ${i}`]);
  const socialRows = [
    { brand: 'Mx Small One', brand_size: 'small', website: 'https://mxsmallone.com', proof_url: 'https://mxsmallone.com/ambassadors', sports: ['all'] },
    { brand: 'Mx Small Two', brand_size: 'small', website: 'https://mxsmalltwo.com', proof_url: 'https://mxsmalltwo.com/creators', sports: ['all'] },
    { brand: 'Mx Big Social', brand_size: 'national', website: 'https://mxbigsocial.com', proof_url: 'https://mxbigsocial.com/athletes', sports: ['all'] },
  ];
  const fakeStore = { ...store,
    getSocialBrandPool: async () => socialRows.map((r) => ({ ...r, lane: 'social' })),
    getTopNilComps: async () => [{ brand: 'Mx Comp Brand', count: 25, deals: [] }, { brand: 'Nike', count: 90, deals: [] }],
    loadSkipSignals: async () => ({ identities: new Set(), athleteCats: new Map(), agentCats: new Map() }),
  };
  // 25 logged deals: a national-size brand by the deal count.
  await P.query(`DELETE FROM deal_comps WHERE brand = 'Mx Comp Brand'`);
  for (let i = 0; i < 25; i++) {
    await P.query(`INSERT INTO deal_comps (brand, athlete_name, sport, followers, source) VALUES ('Mx Comp Brand', $1, 'Football', 18000, 'https://www.on3.com/nil/mx')`, ['Mx Comp Athlete ' + i]);
  }
  const athlete = { id: 'mx-slate-1', name: 'Mx Slater', sport: 'Football', school: 'Baylor University', market: 'Mxslate, TX', marketKey: KEY, hasLocalMarket: true, instagram: 20000 };
  const draw = (mix) => Scout.assembleSlate(P, { agentId: 'mx-slate-agent', athlete, store: fakeStore, limit: 15, mix });
  const ls = await draw({ tier: 'local_star', seats: { local: 4, social: 1, national: 0 } });
  ok('Local Star: the national lane is not drawn, the national-size social brand is refused by name, small brands seated first',
    !ls.picks.some((p) => p.lane === 'national') && !ls.picks.some((p) => p.brand_name === 'Mx Big Social')
    && ls.evidenceRefused.some((r) => r.brand === 'Mx Big Social' && /Local Star/.test(r.why)) && ls.picks[0].lane === 'social',
  { picks: ls.picks.map((p) => `${p.lane}:${p.brand_name}`), refused: ls.evidenceRefused });
  ok('  one social seat\'s share of the attempts, the rest local', ls.picks.filter((p) => p.lane === 'social').length === 2 && ls.picks.filter((p) => p.lane === 'local').length === 13 && ls.shape.mix.perSeat === 3,
    { picks: ls.picks.map((p) => p.lane), shape: ls.shape.mix });
  const nt = await draw({ tier: 'national', seats: { local: 1, social: 2, national: 2 } });
  ok('National: the national lane is drawn (a 25-deal brand is national size), Nike is refused as an incumbent, small social brands are refused',
    nt.picks.some((p) => p.lane === 'national' && p.brand_name === 'Mx Comp Brand') && !nt.picks.some((p) => /nike/i.test(p.brand_name))
    && nt.picks.some((p) => p.brand_name === 'Mx Big Social') && !nt.picks.some((p) => p.brand_name === 'Mx Small One'),
  { picks: nt.picks.map((p) => `${p.lane}:${p.brand_name}`), refused: nt.evidenceRefused.map((r) => `${r.brand}: ${r.why}`) });
  const noLocal = await draw({ tier: 'national', seats: { local: 0, social: 2, national: 2 } });
  ok('a lane with no seat left tonight is not drawn at all', !noLocal.picks.some((p) => p.lane === 'local'), noLocal.picks.map((p) => p.lane));
  const plain = await Scout.assembleSlate(P, { agentId: 'mx-slate-agent', athlete, store: fakeStore, limit: 15, localOnly: true });
  ok('without the mix, localOnly (EMAIL_FIVE_ON) still draws the local lane only', plain.picks.length && plain.picks.every((p) => p.lane === 'local'));
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]);
  await P.query(`DELETE FROM deal_comps WHERE brand = 'Mx Comp Brand'`);

  // ── 6. THE DRY RUN, PRINTED ───────────────────────────────────────────────
  OUT.push('', '-- the dry run, printed --');
  const txt = MR.formatAthlete({ name: 'Mx Jordan', score: { score: 44, tier: 'rising', tierLabel: 'Rising', confidence: 0.59, reasons: ['+15 level: Texas Tech, Power 4'], missing: ['news mentions'] },
    cards: [
      { lane: 'social', brandName: 'Mx Glow Bars', brandSize: 'small', channel: 'program', programUrl: 'https://glowbars.com/ambassadors', contactName: 'Riley Stone', contactTitle: 'Influencer Marketing Manager', fitReasons: fit.reasons, fitLine: fit.lines[0] },
      { lane: 'local', brandName: 'Mx Corner Cafe', brandSize: 'small', channel: 'email', email: 'dana@cornercafe.com', emailVerified: true, contactName: 'Dana Reed', contactTitle: 'Owner', fitReasons: ['Region: in Lubbock, TX, where the athlete goes to school'] },
    ],
    result: { loop: { stop: 'ladder', mix: { short: ['social 1 of 2'] } }, tried: [{ brand: 'Mx Big', lane: 'social', result: 'rejected', reason: 'a national brand; a Rising\'s social seats take small or mid' }] },
    spend: { usd: 0.42, calls: 9, searches: 6 }, ms: 95000 });
  ok('per athlete: the score, the tier, the mix, what drove it, the cards in lane order with contact and fit, the short lanes, what was turned down, the spend',
    /^=== Mx Jordan: 44\/100, Rising \(confidence 59%\) ===/.test(txt) && /Mix: Rising: 3 local, 2 social \(small\/mid\)/.test(txt)
    && /1\. \[local\]\s+Mx Corner Cafe \(small\): email to Dana Reed \(Owner\) <dana@cornercafe\.com>, verified/.test(txt)
    && /2\. \[social\]\s+Mx Glow Bars \(small\): program application https:\/\/glowbars\.com\/ambassadors/.test(txt)
    && /Why they fit: Audience/.test(txt) && /Short: social 1 of 2/.test(txt) && /social 1: 1x a national brand/.test(txt) && /Spent: \$0\.42/.test(txt), txt);
  const D = require(REPO + 'server/scripts/admin/market-mix-dryrun.js');
  ok('the admin script market-mix-dryrun: one descriptor', D.name === 'market-mix-dryrun' && fs.existsSync(REPO + D.file)
    && D.args({ agent: 'jm@x.com', limit: '3', verbose: '1' }).join(' ') === '--agent jm@x.com --limit 3 --verbose' && D.args({ limit: '500' }).length === 0);
  const S = fs.readFileSync(REPO + D.file, 'utf8');
  ok('  it never places or sends: dry, a throwaway athlete id, the agent\'s cards not aged, the score not stored, its claims removed',
    /dryRun: true, keepStale: true/.test(S) && /'mixdry:' \+ crypto\.randomBytes/.test(S) && /computeFor\(pool, row, \{ save: false/.test(S)
    && /DELETE FROM research_claims WHERE athlete_id = \$1/.test(S) && !/insertCard|sendOne|releaseDue/.test(S));
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
