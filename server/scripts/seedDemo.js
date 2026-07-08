// server/scripts/seedDemo.js
//
// Reusable, idempotent demo-account seeder for screen-capture demos.
//
// Creates ONE dedicated agent account (demo@comptongroupllc.com) pre-loaded with
// fully FICTIONAL athletes, media kits, pipeline deals, an inbound inquiry, kit
// view records, a parsed contract with calendar deliverables, and commission
// data, so a demo video shows full, professional screens with zero real athlete
// or brand data.
//
// SAFETY
//  - Everything seeded is fictional. No real athletes, no real brand names.
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
        school: 'Riverton College', schoolTier: 'mid-mid',
        instagram: 18400, tiktok: 31200, engagement: 6.3,
        hometown: 'Marietta, Georgia',
        instagramHandle: 'jordanblake',
        tags: ['fitness:gyms', 'fitness:supplements', 'foodbev:smoothies', 'fashion:sneakers'],
        productWants: 'creatine, protein bars, local smoothie spot',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Junior',
        stats: '15.2 ppg, 4.8 apg, 41 percent from three (2024-25)',
        bio: 'Jordan Blake is a junior guard at Riverton College with a fast-growing following and strong ties to the Marietta community. Known for high-energy content and authentic brand fit, Jordan connects with an engaged audience of college sports fans, fitness enthusiasts, and local supporters. Open to partnerships in fitness, nutrition, apparel, and local business.',
      },
      {
        id: ATH.avery,
        name: 'Avery Reese', sport: 'Basketball', position: 'Guard',
        school: 'Riverton College', schoolTier: 'mid-mid',
        instagram: 21600, tiktok: 38900, engagement: 6.1,
        hometown: 'Alpharetta, Georgia',
        instagramHandle: 'averyreese',
        tags: ['beauty:skincare', 'fitness:apparel', 'wellness:recovery'],
        productWants: 'skincare, athleisure, recovery products',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Sophomore',
        stats: '12.7 ppg, 5.1 rpg, 3.2 apg (2024-25)',
        bio: 'Avery Reese is a sophomore guard at Riverton College with a loyal and engaged following. Avery pairs on-court poise with wellness and lifestyle content that resonates with young women, fitness fans, and local supporters. Open to partnerships in skincare, apparel, wellness, and recovery.',
      },
      {
        id: ATH.marcus,
        name: 'Marcus Wells', sport: 'Football', position: 'Wide Receiver',
        school: 'Fielder State', schoolTier: 'mid-mid',
        instagram: 12900, tiktok: 9800, engagement: 5.4,
        hometown: 'Macon, Georgia',
        instagramHandle: 'marcuswells',
        tags: ['fitness:gyms', 'foodbev:snacks', 'tech:gaming'],
        productWants: 'gaming gear, local eats, training apparel',
        brandRestrictions: ['alcohol', 'tobacco', 'gambling'],
        year: 'Senior',
        stats: '54 rec, 812 yds, 7 TD (2024)',
        bio: 'Marcus Wells is a senior wide receiver at Fielder State with an authentic voice and a growing audience across Georgia. Marcus mixes training clips, gaming streams, and local food content that connects with college sports fans and everyday supporters. Open to partnerships in fitness, food and beverage, and gaming.',
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

    await client.query('COMMIT');

    return {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      agentId,
      mediaKitUrl: '/media-kit/' + jordanSlug,
      mediaKitSlug: jordanSlug,
      averyKitUrl: '/media-kit/' + averySlug,
      counts: {
        athletes: athletes.length,
        mediaKits: kits.length,
        deals: deals.length,
        kitViews: views.length,
        deliverables: deliverables.length,
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
