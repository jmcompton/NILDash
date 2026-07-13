// server/scripts/seedDemo.js
//
// Reusable, idempotent demo-account seeder for screen-capture demos.
//
// Creates ONE dedicated agent account (demo@comptongroupllc.com) pre-loaded with
// fictional athletes (with fictional PII), media kits, pipeline deals, an inbound
// inquiry, kit view records, a parsed contract with calendar deliverables, and
// commission data, so a demo video shows full, professional screens with zero
// real athlete PII. The athletes attend REAL schools in REAL markets so the Deal
// Scan demo shows the product at its best: a deep real pool with real rotation.
//
// SAFETY
//  - Athlete identities (names, handles, stats), media kits, pipeline deals and
//    contracts are fictional. The athletes' SCHOOLS and MARKETS are real
//    (Kennesaw State / Kennesaw, Georgia State / Atlanta, Mercer / Macon) so a
//    LIVE Deal Scan builds a genuine deep pool and rotates real businesses.
//  - The Deal Scan demo cache uses REAL local businesses in each athlete's real
//    school and hometown market. Contact discovery (state registry, local news,
//    Facebook, Google) can only find a named owner for a business that actually
//    exists, so a fictional brand would always show an empty contact. The real
//    contacts are discovered LIVE at view time; no contact data is hard-coded.
//  - All writes are scoped to the demo agent's id. Re-running deletes this
//    account's prior demo data and recreates it, so the state is always the same
//    clean baseline. No other account is ever touched.
//  - No outbound: this writes rows directly, it never sends email or calls Stripe.
//
// Usage (module):  const { seedDemo } = require('./seedDemo'); await seedDemo(pool);
// Usage (CLI):     node server/scripts/seed-demo.js

'use strict';

const bcrypt = require('bcryptjs');

const DEMO_EMAIL = 'demo@comptongroupllc.com';
const DEMO_PASSWORD = 'NILDashDemo2026';
const DEMO_NAME = 'NILDash Demo';

// Deterministic ids so re-runs replace cleanly.
const ATH = {
  jordan: 'demo-ath-jordan-blake',
  avery:  'demo-ath-avery-reese',
  marcus: 'demo-ath-marcus-wells',
};
const CONTRACT_ID = 'demo-contract-forge-jordan';

// yyyy-mm-dd for a date `days` from now (local).
function isoDay(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
// ISO timestamp `hours` ago.
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function seedDemo(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Demo agent account ────────────────────────────────────────────────
    // Reuse the existing id if the account was created before, otherwise mint a
    // stable one. Always reset name/role/plan/password to the known baseline.
    const existing = await client.query('SELECT id FROM users WHERE email=$1', [DEMO_EMAIL]);
    const agentId = existing.rows[0] ? existing.rows[0].id : 'demo-agent-comptongroup';
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    if (existing.rows[0]) {
      await client.query(
        `UPDATE users SET name=$2, password=$3, role='agent', plan='beta', plan_tier='pro',
                subscription_status='active', trial_ends_at=NULL, updated_at=NOW()
           WHERE id=$1`,
        [agentId, DEMO_NAME, passwordHash]
      );
    } else {
      await client.query(
        `INSERT INTO users (id, name, email, password, role, plan, plan_tier, subscription_status)
         VALUES ($1,$2,$3,$4,'agent','beta','pro','active')`,
        [agentId, DEMO_NAME, DEMO_EMAIL, passwordHash]
      );
    }

    // ── 2. Reset prior demo data (scoped to this agent only) ──────────────────
    const priorAth = await client.query('SELECT id FROM athletes WHERE agent_id=$1', [agentId]);
    const priorAthIds = priorAth.rows.map(r => r.id);
    const priorKits = await client.query('SELECT id, slug FROM media_kits WHERE athlete_id = ANY($1)', [priorAthIds.length ? priorAthIds : ['']]);
    const priorKitIds = priorKits.rows.map(r => r.id);
    const priorSlugs = priorKits.rows.map(r => r.slug).filter(Boolean);

    await client.query('DELETE FROM media_kit_views WHERE agent_id=$1 OR kit_slug = ANY($2)', [agentId, priorSlugs.length ? priorSlugs : ['']]);
    await client.query('DELETE FROM media_kit_rate_cards WHERE media_kit_id = ANY($1)', [priorKitIds.length ? priorKitIds : [-1]]);
    await client.query('DELETE FROM media_kits WHERE athlete_id = ANY($1)', [priorAthIds.length ? priorAthIds : ['']]);
    await client.query('DELETE FROM athlete_calendar_events WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM athlete_deliverables WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM athlete_contracts WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM deals WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM calendar_events WHERE agent_id=$1', [agentId]);
    await client.query('DELETE FROM contract_audit_log WHERE agent_id=$1', [agentId]).catch(() => {});
    await client.query('DELETE FROM athletes WHERE agent_id=$1', [agentId]);

    // ── 3. Fictional athletes (every field filled) ────────────────────────────
    const athletes = [
      {
        id: ATH.jordan,
        name: 'Jordan Blake', sport: 'Basketball', position: 'Guard',
        school: 'Kennesaw State University', schoolTier: 'mid-mid',
        instagram: 18400, tiktok: 31200, engagement: 6.3,
        hometown: 'Marietta, Georgia',
        instagramHandle: 'jordanblake',
        tags: ['fitness:gyms', 'fitness:supplements', 'foodbev:smoothies', 'fashion:sneakers'],
        productWants: 'creatine, protein bars, local smoothie spot',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Junior',
        stats: '15.2 ppg, 4.8 apg, 41 percent from three (2024-25)',
        bio: 'Jordan Blake is a junior guard at Kennesaw State University with a fast-growing following and strong ties to the Marietta community. Known for high-energy content and authentic brand fit, Jordan connects with an engaged audience of college sports fans, fitness enthusiasts, and local supporters. Open to partnerships in fitness, nutrition, apparel, and local business.',
      },
      {
        id: ATH.avery,
        name: 'Avery Reese', sport: 'Basketball', position: 'Guard',
        school: 'Georgia State University', schoolTier: 'mid-mid',
        instagram: 21600, tiktok: 38900, engagement: 6.1,
        hometown: 'Alpharetta, Georgia',
        instagramHandle: 'averyreese',
        tags: ['beauty:skincare', 'fitness:apparel', 'wellness:recovery'],
        productWants: 'skincare, athleisure, recovery products',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Sophomore',
        stats: '12.7 ppg, 5.1 rpg, 3.2 apg (2024-25)',
        bio: 'Avery Reese is a sophomore guard at Georgia State University with a loyal and engaged following. Avery pairs on-court poise with wellness and lifestyle content that resonates with young women, fitness fans, and local supporters. Open to partnerships in skincare, apparel, wellness, and recovery.',
      },
      {
        id: ATH.marcus,
        name: 'Marcus Wells', sport: 'Football', position: 'Wide Receiver',
        school: 'Mercer University', schoolTier: 'mid-mid',
        instagram: 12900, tiktok: 9800, engagement: 5.4,
        hometown: 'Macon, Georgia',
        instagramHandle: 'marcuswells',
        tags: ['fitness:gyms', 'foodbev:snacks', 'tech:gaming'],
        productWants: 'gaming gear, local eats, training apparel',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Senior',
        stats: '54 rec, 812 yds, 7 TD (2024)',
        bio: 'Marcus Wells is a senior wide receiver at Mercer University with an authentic voice and a growing audience across Georgia. Marcus mixes training clips, gaming streams, and local food content that connects with college sports fans and everyday supporters. Open to partnerships in fitness, food and beverage, and gaming.',
      },
    ];

    const now = new Date().toISOString();
    for (const a of athletes) {
      const data = {
        id: a.id, name: a.name, sport: a.sport, position: a.position,
        school: a.school, schoolTier: a.schoolTier,
        instagram: a.instagram, tiktok: a.tiktok, engagement: a.engagement,
        notes: '', year: a.year, stats: a.stats, transferReason: '', gpa: '',
        hometown: a.hometown, tags: a.tags, productWants: a.productWants,
        instagramHandle: a.instagramHandle, brandRestrictions: a.brandRestrictions,
        igStatsSource: 'manual', igStatsFetchedAt: now, createdAt: now,
      };
      await client.query(
        'INSERT INTO athletes (id, agent_id, data, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW())',
        [a.id, agentId, data]
      );
    }

    // ── 4. Media kits (Jordan + Avery), theme nildash, gradient hero ──────────
    // Slug matches the app's generator: name lowercased, non-alnum -> '-', + '-nil'.
    function kitSlug(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-nil';
    }
    const jordanSlug = kitSlug('Jordan Blake');
    const averySlug = kitSlug('Avery Reese');

    // Jordan's kit carries a per-brand variant so the variant view demo lands.
    const jordanVariants = {
      'peach-state-smoothies': {
        brand: 'Peach State Smoothies',
        category: 'foodbev',
        opener: 'Peach State Smoothies and Jordan Blake share the same crowd: active, local, and always on the move.',
        matchedTags: ['smoothies', 'supplements', 'gyms'],
        rateLead: ['post', 'appearance', 'story', 'reel'],
        createdAt: now,
      },
    };

    const kits = [
      {
        slug: jordanSlug, athlete: athletes[0], variants: jordanVariants,
        rates: [
          ['Instagram Post', 650, 'One in-feed post with story cross-promotion'],
          ['Instagram Reel', 950, 'One produced Reel, up to 30 seconds'],
          ['TikTok Video', 800, 'One TikTok with trending audio'],
          ['Personal Appearance', 1500, 'Two hour in-person appearance, local'],
        ],
      },
      {
        slug: averySlug, athlete: athletes[1], variants: {},
        rates: [
          ['Instagram Post', 700, 'One in-feed post with story cross-promotion'],
          ['Instagram Reel', 1000, 'One produced Reel, up to 30 seconds'],
          ['TikTok Video', 850, 'One TikTok with trending audio'],
          ['Personal Appearance', 1500, 'Two hour in-person appearance, local'],
        ],
      },
    ];

    const kitIdBySlug = {};
    for (const k of kits) {
      const a = k.athlete;
      const kitRes = await client.query(
        `INSERT INTO media_kits
           (athlete_id, instagram_handle, instagram_followers, instagram_engagement,
            tiktok_handle, tiktok_followers, bio, primary_color, secondary_color,
            slug, theme, variants, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'nildash',$11,NOW(),NOW())
         RETURNING id`,
        [a.id, a.instagramHandle, a.instagram, a.engagement.toFixed(1) + '%',
         a.instagramHandle, a.tiktok, a.bio, '#84CC16', '#0A0E1A',
         k.slug, JSON.stringify(k.variants)]
      );
      const kitId = kitRes.rows[0].id;
      kitIdBySlug[k.slug] = kitId;
      for (const [service, price, notes] of k.rates) {
        await client.query(
          'INSERT INTO media_kit_rate_cards (media_kit_id, service_type, price, notes) VALUES ($1,$2,$3,$4)',
          [kitId, service, price, notes]
        );
      }
    }

    // ── 5. Media kit view tracking for Jordan's kit ───────────────────────────
    // 7 views: most recent 2 hours ago, two today, spread over the last few days.
    // 3 of them are Peach State Smoothies variant views.
    const views = [
      { at: hoursAgo(2),        brand: 'Peach State Smoothies', variant: 'peach-state-smoothies' },
      { at: hoursAgo(5),        brand: null,                    variant: null },
      { at: hoursAgo(26),       brand: 'Peach State Smoothies', variant: 'peach-state-smoothies' },
      { at: hoursAgo(49),       brand: null,                    variant: null },
      { at: hoursAgo(74),       brand: 'Peach State Smoothies', variant: 'peach-state-smoothies' },
      { at: hoursAgo(98),       brand: null,                    variant: null },
      { at: hoursAgo(140),      brand: null,                    variant: null },
    ];
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      await client.query(
        `INSERT INTO media_kit_views (kit_slug, athlete_id, agent_id, variant, variant_brand, session_hash, viewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [jordanSlug, ATH.jordan, agentId, v.variant, v.brand, 'demo-view-' + i + '-' + jordanSlug, v.at]
      );
    }

    // ── 6. Pipeline deals (all fictional brands) ──────────────────────────────
    const deals = [
      { id: 'demo-deal-forge',   athleteId: ATH.jordan, brand: 'Forge Athletics Club',  stage: 'Negotiating',   value: 1200, campaign: 'Spring training series', source: 'manual', notes: 'Local gym partnership. Two Reels plus one appearance at the spring open house.' },
      { id: 'demo-deal-peach',   athleteId: ATH.jordan, brand: 'Peach State Smoothies', stage: 'Closed',        value: 800,  campaign: 'Game day fuel',        source: 'manual', notes: 'Recurring smoothie feature. Post plus story on game days.' },
      { id: 'demo-deal-glow',    athleteId: ATH.avery,  brand: 'Glow Skincare Co',      stage: 'Outreach Sent', value: 1500, campaign: 'Recovery and glow',    source: 'manual', notes: 'Skincare and recovery bundle. Awaiting brand reply.' },
      { id: 'demo-deal-iron',    athleteId: ATH.marcus, brand: 'Iron Works Fitness',    stage: 'Prospecting',   value: 600,  campaign: 'Offseason training',   source: 'manual', notes: 'Early conversation about a training content package.' },
      {
        id: 'demo-deal-summit', athleteId: ATH.jordan, brand: 'Summit Nutrition', stage: 'Inbound', value: 3000,
        campaign: 'Media kit inquiry', source: 'media_kit_inquiry',
        contactName: 'Taylor Brooks', contactEmail: 'taylor@summitnutrition.example.com',
        notes: [
          'Inbound inquiry from the public media kit.',
          'Contact: Taylor Brooks',
          'Email: taylor@summitnutrition.example.com',
          'Budget: $1,000-5,000',
          'Interested in: Interested in a 3-post partnership around your pre-game routine.',
        ].join('\n'),
      },
    ];
    for (const d of deals) {
      const data = {
        id: d.id, brand: d.brand, campaign: d.campaign, value: d.value,
        stage: d.stage, notes: d.notes, source: d.source,
        status: d.stage === 'Closed' ? 'closed' : 'active',
        createdAt: now,
      };
      if (d.contactName) data.contactName = d.contactName;
      if (d.contactEmail) data.contactEmail = d.contactEmail;
      await client.query(
        'INSERT INTO deals (id, athlete_id, agent_id, data, created_at, updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())',
        [d.id, d.athleteId, agentId, data]
      );
    }

    // ── 7. Parsed contract + deliverables + calendar events ───────────────────
    // Jordan x Forge Athletics Club. Dates land inside the current month grid.
    await client.query(
      `INSERT INTO athlete_contracts
         (id, athlete_id, agent_id, filename, brand, raw_text, start_date, end_date, extraction_status, extraction_attempts, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',1,NOW())`,
      [CONTRACT_ID, ATH.jordan, agentId, 'Forge Athletics Club - Jordan Blake NIL Agreement.pdf',
       'Forge Athletics Club',
       'NIL partnership agreement between Jordan Blake and Forge Athletics Club. Term of 60 days. Deliverables: two Instagram posts and one in person appearance. Compensation of 1200 dollars.',
       isoDay(-4), isoDay(56)]
    );

    // Deliverables with due dates spread across the next few weeks (this month).
    const deliverables = [
      { desc: 'Instagram post featuring the spring training series', due: isoDay(6),  order: 0, evtTitle: 'IG Post due: Forge Athletics Club' },
      { desc: 'Instagram post recapping the open house appearance',  due: isoDay(20), order: 1, evtTitle: 'IG Post due: Forge Athletics Club' },
      { desc: 'In person appearance at the Forge spring open house',  due: isoDay(13), order: 2, evtTitle: 'Appearance: Forge Athletics Club' },
    ];
    for (const dv of deliverables) {
      const delRes = await client.query(
        `INSERT INTO athlete_deliverables
           (athlete_id, agent_id, contract_id, deliverable_description, due_date, brand, status, source, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,'pending','pdf_scanner',$7)
         RETURNING id`,
        [ATH.jordan, agentId, CONTRACT_ID, dv.desc, dv.due, 'Forge Athletics Club', dv.order]
      );
      const deliverableId = delRes.rows[0].id;
      await client.query(
        `INSERT INTO athlete_calendar_events
           (id, athlete_id, agent_id, deliverable_id, contract_id, title, event_date, brand, color, status, is_generated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'#84CC16','pending',TRUE)`,
        ['demo-evt-' + dv.order + '-forge', ATH.jordan, agentId, deliverableId, CONTRACT_ID, dv.evtTitle, dv.due, 'Forge Athletics Club']
      );
    }

    // ── 8. Deal Scan demo cache: REAL businesses in each athlete's REAL market ─
    // The demo athletes now attend REAL schools (Kennesaw State, Georgia State,
    // Mercer) in REAL markets, so a LIVE Deal Scan during a screen-share builds a
    // genuine deep pool from web search and rotates real businesses on Refresh.
    // This pre-cache is the instant first paint: every business is real and in the
    // athlete's school or hometown market, so the lazy per-brand contact search
    // (state registry, local news, Facebook, Google Maps) can surface a real
    // owner/manager. Contact fields are null ON PURPOSE, filled live at view time;
    // each region carries a state so the phone locality check runs. "shown" is
    // seeded with these brands so the FIRST Refresh pages past them into freshly
    // searched businesses, demoing real rotation, not a repeat of the seed set.
    const mkCard = (rank, brand, category, region, market, marketLabel, isFranchise, fitScore, campaign, rationale, matched) => ({
      rank, brand, tier: 'local', lane: 'local', resultType: 'local', isLocal: true,
      category, dealType: 'post', campaign, rationale,
      estimatedValueLow: 250, estimatedValueHigh: 1000,
      fitScore, market, marketLabel,
      region, isFranchise, website: null,
      contactName: null, contactTitle: null, contactEmail: null, contactApproach: null,
      matchedTags: matched || [], activelyMarketing: true, evidence: null,
      suggestedRate: { low: 250, high: 1000 }, source: 'web',
    });
    // Jordan Blake: Kennesaw State (Kennesaw), hometown Marietta.
    const jordanScan = [
      mkCard(1, 'D1 Training', 'gym', 'Kennesaw, Georgia', 'school', 'Near Kennesaw', true, 90,
        'Athlete training ambassador', 'D1 Training runs sport-specific athlete programs near campus and already works with local athletes, so a college guard is a natural ambassador fit.', ['gyms']),
      mkCard(2, 'Big Shanty Smokehouse', 'restaurant', 'Kennesaw, Georgia', 'school', 'Near Kennesaw', false, 84,
        'Game day content series', 'A popular Kennesaw restaurant minutes from campus with a strong local following for a community-driven post.', []),
      mkCard(3, 'Marietta Diner', 'restaurant', 'Marietta, Georgia', 'hometown', 'Hometown - Marietta', false, 85,
        'Hometown feature', 'An iconic Marietta spot the whole community knows, ideal for a hometown-hero content angle.', []),
      mkCard(4, 'Ed Voyles Honda', 'auto', 'Marietta, Georgia', 'hometown', 'Hometown - Marietta', false, 83,
        'Dealership appearance and posts', 'A Marietta dealership that runs steady local advertising and sponsors area sports, a common local NIL spender.', []),
      mkCard(5, 'Smoothie King', 'nutrition', 'Marietta, Georgia', 'hometown', 'Hometown - Marietta', true, 81,
        'Recovery smoothie feature', "Matches Jordan's interest in a local smoothie spot and supplements, with an easy on-camera product.", ['smoothies', 'supplements']),
      mkCard(6, 'Fox Bros Bar-B-Q', 'restaurant', 'Atlanta, Georgia', 'hometown', 'Hometown - Marietta', false, 79,
        'Atlanta content series', 'A well-known Atlanta restaurant with a large local following and a history of community sponsorships.', []),
    ];
    // Avery Reese: Georgia State (Atlanta), hometown Alpharetta.
    const averyScan = [
      mkCard(1, 'Orangetheory Fitness', 'fitness', 'Alpharetta, Georgia', 'hometown', 'Hometown - Alpharetta', true, 89,
        'Recovery and training partnership', "Fits Avery's fitness apparel and recovery focus, and the Alpharetta studio markets to exactly her hometown audience.", ['apparel', 'recovery']),
      mkCard(2, 'Lululemon', 'apparel', 'Alpharetta, Georgia', 'hometown', 'Hometown - Alpharetta', true, 86,
        'Athleisure lookbook', 'The Avalon store is a natural fit for athleisure content aimed at young, active local followers.', ['apparel']),
      mkCard(3, 'European Wax Center', 'beauty', 'Alpharetta, Georgia', 'hometown', 'Hometown - Alpharetta', true, 83,
        'Skincare and self-care feature', "Matches Avery's skincare interest with an easy in-studio appointment and content angle.", ['skincare']),
      mkCard(4, 'Sweetgreen', 'restaurant', 'Atlanta, Georgia', 'school', 'Near Atlanta', true, 82,
        'Fuel and recovery series', 'A healthy fast-casual spot near campus that markets to students and pairs well with a wellness message.', ['recovery']),
      mkCard(5, 'Kale Me Crazy', 'restaurant', 'Atlanta, Georgia', 'school', 'Near Atlanta', false, 80,
        'Wellness smoothie post', 'An Atlanta health-food cafe with a wellness audience that overlaps with her following.', []),
      mkCard(6, 'Drybar', 'beauty', 'Atlanta, Georgia', 'school', 'Near Atlanta', true, 78,
        'Game day glam feature', 'A beauty brand with Atlanta locations for a lifestyle content collaboration.', []),
    ];
    // Marcus Wells: Mercer (Macon), hometown Macon.
    const marcusScan = [
      mkCard(1, 'Planet Fitness', 'gym', 'Macon, Georgia', 'school', 'Near Macon', true, 88,
        'Offseason training series', "Matches Marcus's gym focus with a Macon location that markets to the exact local student audience.", ['gyms']),
      mkCard(2, 'Nu-Way Weiners', 'restaurant', 'Macon, Georgia', 'hometown', 'Hometown - Macon', false, 85,
        'Hometown snack feature', 'An iconic Macon institution the whole community knows, ideal for a hometown-hero food post.', ['snacks']),
      mkCard(3, 'The Rookery', 'restaurant', 'Macon, Georgia', 'hometown', 'Hometown - Macon', false, 83,
        'Downtown Macon post', 'A well-known downtown Macon restaurant with strong local ties for a community-driven post.', []),
      mkCard(4, 'Fresh Air Bar-B-Que', 'restaurant', 'Macon, Georgia', 'school', 'Near Macon', false, 81,
        'Game day content series', 'A Middle Georgia barbecue staple with a large local following for game day content.', []),
      mkCard(5, 'Ingleside Village Pizza', 'restaurant', 'Macon, Georgia', 'hometown', 'Hometown - Macon', false, 79,
        'Local eats feature', 'A beloved Macon pizza spot that fits his local food content and student audience.', []),
      mkCard(6, "Jeneane's Cafe", 'restaurant', 'Macon, Georgia', 'hometown', 'Hometown - Macon', false, 77,
        'Breakfast recap post', 'A long-running Macon breakfast spot with steady community traffic for an easy local post.', []),
    ];
    const scanByAthlete = { [ATH.jordan]: jordanScan, [ATH.avery]: averyScan, [ATH.marcus]: marcusScan };
    for (const [athId, cards] of Object.entries(scanByAthlete)) {
      await client.query(
        `UPDATE athletes SET deal_scan_cache = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ local: { opportunities: cards, ts: Date.now(), shown: cards.map((c) => c.brand) } }), athId]
      );
    }
    const demoScanCards = jordanScan.concat(averyScan, marcusScan);

    await client.query('COMMIT');

    return {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      agentId,
      mediaKitUrl: '/media-kit/' + jordanSlug,
      mediaKitSlug: jordanSlug,
      averyKitUrl: '/media-kit/' + averySlug,
      // Echo the seeded athlete -> real school so a re-seed is self-verifying:
      // the response confirms the displayed names are corrected (Kennesaw State,
      // Georgia State, Mercer), not the old fictional schools.
      roster: athletes.map((a) => ({ name: a.name, school: a.school, hometown: a.hometown })),
      counts: {
        athletes: athletes.length,
        mediaKits: kits.length,
        deals: deals.length,
        kitViews: views.length,
        deliverables: deliverables.length,
        dealScanCards: demoScanCards.length,
      },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { seedDemo, DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME };
