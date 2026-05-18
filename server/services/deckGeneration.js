// server/services/deckGeneration.js
// DeckGenerationService — Part 5 of the NIL Outreach Automation Engine.
//
// Generates a brand-specific pitch deck PDF for athlete + brand pairs.
// Uses the SAME generateAthleteBrandKit() AI function as the Marketing tab pitch deck,
// then renders the resulting 6-slide JSON into a PDF with pdfkit.
//
// SAFETY: reads from brand_match_scores, company_enrichment.
//         writes only to pitch_decks (new table).
//         uses existing pdfkit — no new npm packages.
//         does NOT overwrite existing files (versioned filenames).

'use strict';

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { pool } = require('../store');
const { generateAthleteBrandKit } = require('../ai');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) {
  console.warn('[deckGeneration] pdfkit not available:', e.message);
}

const OUTPUT_DIR = process.env.DECK_OUTPUT_DIR || '/tmp/nildash-decks';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * generateDeck(inputs)
 *
 * inputs: {
 *   agentId, athleteId,
 *   athlete:     athlete data object
 *   enrichment:  company_enrichment row
 *   matchScore:  brand_match_scores row
 *   pitch:       pitch object from PitchGenerationService
 * }
 *
 * Uses the SAME generateAthleteBrandKit() AI as the Marketing tab — sets
 * athlete.targetBrand to the brand name so the deck is fully brand-specific.
 *
 * Returns pitch_decks DB record with file_path.
 */
async function generateDeck(inputs) {
  const { agentId, athleteId, athlete, enrichment, matchScore, pitch } = inputs;
  const athleteData = extractAthleteData(athlete);

  ensureOutputDir();

  // ── Call the same AI as the Marketing tab pitch deck ──────────────────────
  // Set targetBrand so generateAthleteBrandKit tailors every slide to this brand
  const athleteForKit = { ...athleteData, targetBrand: enrichment.brand_name };
  let slideData;
  try {
    slideData = await generateAthleteBrandKit(athleteForKit);
  } catch (e) {
    console.error('[deckGeneration] generateAthleteBrandKit failed:', e.message);
    // Fall back to a minimal slide structure so the rest of the pipeline continues
    slideData = buildFallbackSlideData(athleteData, enrichment, matchScore, pitch);
  }

  const id       = 'deck_' + crypto.randomBytes(8).toString('hex');
  const version  = await getNextVersion(agentId, athleteId, enrichment.brand_name);
  const filename = `${id}_v${version}.pdf`;
  const filePath = path.join(OUTPUT_DIR, filename);

  if (PDFDocument) {
    await renderBrandKitPDF(filePath, athleteData, enrichment, matchScore, slideData);
  } else {
    console.warn('[deckGeneration] pdfkit unavailable — saving slide data only');
  }

  const r = await pool.query(
    `INSERT INTO pitch_decks (
       id, agent_id, athlete_id, brand_name, enrichment_id, match_score_id,
       file_path, slide_data, version, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     RETURNING *`,
    [
      id, agentId, athleteId, enrichment.brand_name,
      enrichment.id, matchScore?.id,
      PDFDocument ? filePath : null,
      JSON.stringify(slideData),
      version,
    ]
  );

  logEvent(null, agentId, 'deck_generated', { id, brand: enrichment.brand_name, athleteId });
  return r.rows[0];
}

/**
 * getDeckById(id)
 */
async function getDeckById(id) {
  const r = await pool.query('SELECT * FROM pitch_decks WHERE id=$1', [id]);
  return r.rows[0] || null;
}

/**
 * getDecksForAthleteBrand(agentId, athleteId, brandName)
 */
async function getDecksForAthleteBrand(agentId, athleteId, brandName) {
  const r = await pool.query(
    `SELECT * FROM pitch_decks
     WHERE agent_id=$1 AND athlete_id=$2 AND LOWER(brand_name)=LOWER($3)
     ORDER BY version DESC`,
    [agentId, athleteId, brandName]
  );
  return r.rows;
}

// ── PDF Rendering — mirrors the Marketing tab pitch deck (generateAthleteBrandKit format) ─────

/**
 * renderBrandKitPDF — renders the 6-slide JSON from generateAthleteBrandKit() into a PDF.
 * Slide structure:
 *   slide1: { headline, intro }
 *   slide2: { bullets[] }
 *   slide3: { stats[], role }
 *   slide4: { instagram, tiktok, engagement, audienceSummary, growthSignal }
 *   slide5: { categories[]: { name, reason } }
 *   slide6: { activations[]: { title, description } }
 */
async function renderBrandKitPDF(filePath, athleteData, enrichment, matchScore, kit) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ACCENT = '#BA0C2F';
    const DARK   = '#06080F';
    const SURF   = '#0D1020';
    const WHITE  = '#F4F6FF';
    const MUTED  = '#8B91A8';
    const W = 612; const H = 792; const PAD = 50; const CW = W - PAD * 2;

    function tr(text, max) {
      if (!text) return '';
      const s = String(text);
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function slideBackground(useDark) {
      doc.rect(0, 0, W, H).fill(useDark ? DARK : SURF);
      doc.rect(0, 0, W, 5).fill(ACCENT);
    }

    function slideHeader(title, sub) {
      doc.fill(ACCENT).fontSize(8).font('Helvetica-Bold')
         .text(title, PAD, 18, { width: CW, characterSpacing: 2 });
      doc.rect(PAD, 32, 40, 1.5).fill(ACCENT);
      if (sub) {
        doc.fill(MUTED).fontSize(10).font('Helvetica')
           .text(tr(sub, 80), PAD, 38, { width: CW });
      }
    }

    function footer() {
      doc.fill(MUTED).fontSize(7.5).font('Helvetica')
         .text('NILDash — Powered by AI', PAD, H - 22, { width: CW, align: 'center', characterSpacing: 0.5 });
    }

    // ── SLIDE 1: COVER ────────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(DARK);
    doc.rect(0, 0, W, 5).fill(ACCENT);
    doc.fill(ACCENT).fontSize(8).font('Helvetica-Bold')
       .text('NIL PARTNERSHIP PROPOSAL', PAD, 22, { width: CW, characterSpacing: 2 });
    doc.rect(PAD, 36, 40, 1.5).fill(ACCENT);

    const headline = tr(kit.slide1?.headline || `${athleteData.name} × ${enrichment.brand_name}`, 72);
    doc.fill(WHITE).fontSize(28).font('Helvetica-Bold')
       .text(headline, PAD, 80, { width: CW, lineGap: 3 });

    const intro = tr(kit.slide1?.intro || '', 200);
    doc.fill(MUTED).fontSize(11.5).font('Helvetica')
       .text(intro || ' ', PAD, 164, { width: CW, lineGap: 3 });

    doc.rect(PAD, 248, CW, 0.75).fill('#1C2030');

    // 4 stat boxes
    const bW = (CW - 12 * 3) / 4;
    [
      { label: 'SPORT',     value: tr((athleteData.sport || 'N/A').toUpperCase(), 12) },
      { label: 'SCHOOL',    value: tr(athleteData.school || 'N/A', 14) },
      { label: 'INSTAGRAM', value: formatFollowers(athleteData.instagram) },
      { label: 'TIKTOK',    value: formatFollowers(athleteData.tiktok) },
    ].forEach((s, i) => {
      const bX = PAD + i * (bW + 12);
      doc.rect(bX, 268, bW, 70).fill(SURF);
      doc.rect(bX, 268, bW, 3).fill(ACCENT);
      doc.fill(ACCENT).fontSize(18).font('Helvetica-Bold')
         .text(s.value, bX + 6, 282, { width: bW - 12, align: 'center' });
      doc.fill(MUTED).fontSize(7).font('Helvetica')
         .text(s.label, bX + 6, 320, { width: bW - 12, align: 'center', characterSpacing: 1.5 });
    });

    // Match score + engagement badges
    if (matchScore?.compatibility_score) {
      doc.rect(PAD, 358, 120, 32).fill(ACCENT);
      doc.fill(DARK).fontSize(12).font('Helvetica-Bold')
         .text(`${matchScore.compatibility_score}% MATCH`, PAD, 367, { width: 120, align: 'center' });
    }
    if (athleteData.engagement) {
      const ex = matchScore?.compatibility_score ? PAD + 132 : PAD;
      doc.rect(ex, 358, 120, 32).fill(SURF);
      doc.rect(ex, 358, 120, 2).fill(ACCENT);
      doc.fill(WHITE).fontSize(12).font('Helvetica-Bold')
         .text(`${athleteData.engagement}% ENG`, ex, 367, { width: 120, align: 'center' });
    }

    footer();

    // ── SLIDE 2: WHY THIS PARTNERSHIP ─────────────────────────────────────────
    doc.addPage();
    slideBackground(false);
    slideHeader('WHY THIS PARTNERSHIP', `${athleteData.name} × ${enrichment.brand_name}`);

    const bullets = safeParseArray(kit.slide2?.bullets).slice(0, 5);
    const bulletCardH = bullets.length > 4 ? 106 : 116;
    bullets.forEach((bullet, i) => {
      const bText = typeof bullet === 'string' ? bullet : (bullet.text || '');
      const dashIdx = bText.indexOf(' — ');
      const lead = dashIdx > 0 ? bText.slice(0, dashIdx) : bText;
      const body = dashIdx > 0 ? bText.slice(dashIdx + 3) : '';
      const cardY = 58 + i * (bulletCardH + 7);
      doc.rect(PAD, cardY, CW, bulletCardH).fill(DARK);
      doc.rect(PAD, cardY, 4, bulletCardH).fill(ACCENT);
      doc.fill(ACCENT).fontSize(20).font('Helvetica-Bold')
         .text(String(i + 1).padStart(2, '0'), PAD + 10, cardY + 10, { width: 28 });
      doc.fill(WHITE).fontSize(11).font('Helvetica-Bold')
         .text(tr(lead, 80), PAD + 46, cardY + 10, { width: CW - 58 });
      if (body) {
        doc.fill(MUTED).fontSize(10).font('Helvetica')
           .text(tr(body, 160), PAD + 46, cardY + 28, { width: CW - 58, lineGap: 2 });
      }
    });

    footer();

    // ── SLIDE 3: ON-FIELD PERFORMANCE ─────────────────────────────────────────
    doc.addPage();
    slideBackground(true);
    slideHeader('ON-FIELD PERFORMANCE', 'The competitive credentials that matter');

    const perfStats = safeParseArray(kit.slide3?.stats).slice(0, 3);
    const pW = (CW - 14 * 2) / 3;
    perfStats.forEach((stat, i) => {
      const pX = PAD + i * (pW + 14);
      const st = typeof stat === 'string' ? stat : JSON.stringify(stat);
      const m = st.match(/^([0-9,.x\-]+\s*(?:x|st|nd|rd|th|%|K|M|pts?|yds?|rec|TD|ppg|reb|ast|blk)?)\s+(.+)$/i);
      const num = m ? m[1].trim() : st.slice(0, 10);
      const lbl = m ? tr(m[2].trim(), 28) : '';
      doc.rect(pX, 56, pW, 86).fill(SURF);
      doc.rect(pX, 56, pW, 3).fill(ACCENT);
      doc.fill(ACCENT).fontSize(26).font('Helvetica-Bold')
         .text(num, pX + 6, 70, { width: pW - 12, align: 'center' });
      if (lbl) {
        doc.fill(MUTED).fontSize(8.5).font('Helvetica')
           .text(lbl.toUpperCase(), pX + 6, 104, { width: pW - 12, align: 'center', characterSpacing: 0.5 });
      }
    });

    const role = tr(kit.slide3?.role || '', 180);
    if (role) {
      doc.rect(PAD, 152, CW, 0.75).fill('#1C2030');
      doc.fill(WHITE).fontSize(12.5).font('Helvetica')
         .text(role, PAD, 162, { width: CW, lineGap: 3 });
    }

    const details = [
      ['Sport',    athleteData.sport    || 'N/A'],
      ['Position', athleteData.position || 'N/A'],
      ['Year',     athleteData.year     || 'N/A'],
      ['School',   tr(athleteData.school || 'N/A', 40)],
      ['Stats',    tr(athleteData.stats  || 'See full profile', 60)],
    ];
    let dY = 222;
    details.forEach(([lbl, val]) => {
      doc.fill(MUTED).fontSize(8).font('Helvetica')
         .text(lbl.toUpperCase(), PAD, dY, { width: 90, characterSpacing: 1 });
      doc.fill(WHITE).fontSize(11).font('Helvetica-Bold')
         .text(val, PAD + 100, dY, { width: CW - 100 });
      doc.rect(PAD, dY + 17, CW, 0.5).fill('#1C2030');
      dY += 28;
    });

    footer();

    // ── SLIDE 4: AUDIENCE & REACH ─────────────────────────────────────────────
    doc.addPage();
    slideBackground(false);
    slideHeader('AUDIENCE & REACH', `Why ${tr(enrichment.brand_name, 30)} needs this audience`);

    const platforms = [
      { label: 'INSTAGRAM',   value: formatFollowers(athleteData.instagram || kit.slide4?.instagram), sub: 'Followers' },
      { label: 'TIKTOK',      value: formatFollowers(athleteData.tiktok    || kit.slide4?.tiktok),    sub: 'Followers' },
      { label: 'ENGAGEMENT',  value: `${athleteData.engagement || kit.slide4?.engagement || '—'}%`,  sub: 'Avg Engagement' },
    ];
    const platW = (CW - 14 * 2) / 3;
    platforms.forEach((p, i) => {
      const pX = PAD + i * (platW + 14);
      doc.rect(pX, 56, platW, 78).fill(DARK);
      doc.rect(pX, 56, platW, 3).fill(ACCENT);
      doc.fill(MUTED).fontSize(7).font('Helvetica')
         .text(p.label, pX + 6, 68, { width: platW - 12, align: 'center', characterSpacing: 1.5 });
      doc.fill(WHITE).fontSize(26).font('Helvetica-Bold')
         .text(p.value, pX + 6, 80, { width: platW - 12, align: 'center' });
      doc.fill(MUTED).fontSize(8).font('Helvetica')
         .text(p.sub, pX + 6, 116, { width: platW - 12, align: 'center' });
    });

    const audSum = tr(kit.slide4?.audienceSummary || '', 260);
    doc.rect(PAD, 146, CW, 0.75).fill('#1C2030');
    doc.fill(WHITE).fontSize(12.5).font('Helvetica')
       .text(audSum || ' ', PAD, 158, { width: CW, lineGap: 3 });

    const grow = tr(kit.slide4?.growthSignal || '', 120);
    if (grow) {
      doc.rect(PAD, 248, CW, 36).fill(DARK);
      doc.rect(PAD, 248, 3, 36).fill(ACCENT);
      doc.fill(ACCENT).fontSize(11).font('Helvetica-Bold')
         .text('↑  ' + grow, PAD + 14, 260, { width: CW - 20 });
    }

    footer();

    // ── SLIDE 5: PARTNERSHIP CATEGORIES ──────────────────────────────────────
    doc.addPage();
    slideBackground(true);
    slideHeader('PARTNERSHIP CATEGORIES', `Tailored to ${tr(enrichment.brand_name, 30)}`);

    const cats = safeParseArray(kit.slide5?.categories).slice(0, 4);
    cats.forEach((cat, i) => {
      const name   = typeof cat === 'string' ? cat : (cat.name   || 'Category');
      const reason = typeof cat === 'object'  ? (cat.reason || '') : '';
      const cY = 56 + i * 152;
      doc.rect(PAD, cY, CW, 142).fill(SURF);
      doc.rect(PAD, cY, 4, 142).fill(ACCENT);
      doc.fill(WHITE).fontSize(13).font('Helvetica-Bold')
         .text(tr(name, 60), PAD + 14, cY + 14, { width: CW - 28 });
      doc.fill(MUTED).fontSize(10.5).font('Helvetica')
         .text(tr(reason, 220), PAD + 14, cY + 34, { width: CW - 28, lineGap: 2 });
    });

    footer();

    // ── SLIDE 6: CAMPAIGN ACTIVATIONS ─────────────────────────────────────────
    doc.addPage();
    slideBackground(false);
    slideHeader('CAMPAIGN ACTIVATIONS', 'What we build together');

    const acts = safeParseArray(kit.slide6?.activations).slice(0, 3);
    acts.forEach((act, i) => {
      const title = typeof act === 'string' ? act : tr(act.title || 'Campaign', 60);
      const desc  = typeof act === 'object'  ? tr(act.description || '', 240) : '';
      const aY = 56 + i * 150;
      doc.rect(PAD, aY, CW, 140).fill(DARK);
      doc.rect(PAD, aY, CW, 3).fill(ACCENT);
      doc.fill(WHITE).fontSize(13).font('Helvetica-Bold')
         .text(title, PAD + 14, aY + 14, { width: CW - 28 });
      doc.fill(MUTED).fontSize(10.5).font('Helvetica')
         .text(desc || ' ', PAD + 14, aY + 34, { width: CW - 28, lineGap: 2 });
    });

    // CTA
    const ctaY = 56 + acts.length * 150 + 14;
    if (ctaY + 58 < H - 36) {
      doc.rect(PAD, ctaY, CW, 56).fill(ACCENT);
      doc.fill(DARK).fontSize(12.5).font('Helvetica-Bold')
         .text(
           tr(`Ready to discuss how ${athleteData.name} can represent ${enrichment.brand_name}?`, 90),
           PAD + 16, ctaY + 14, { width: CW - 32, align: 'center', lineGap: 3 }
         );
    }

    footer();

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ── PDF shared header helper ──────────────────────────────────────────────────

function brandKitHeader(doc, title, subtitle, accent, white, muted, pad) {
  doc.fill(accent).fontSize(10).font('Helvetica-Bold')
     .text(title, pad, 28, { characterSpacing: 2 });
  doc.rect(pad, 46, 48, 2).fill(accent);
  if (subtitle) {
    doc.fill(muted).fontSize(11).font('Helvetica')
       .text(subtitle, pad, 56, { width: doc.page.width - pad * 2 });
  }
}

// ── Fallback slide data (if AI call fails) ────────────────────────────────────

function buildFallbackSlideData(athleteData, enrichment, matchScore, pitch) {
  return {
    slide1: { headline: `${athleteData.name} × ${enrichment.brand_name}`, intro: pitch?.value_proposition || 'A compelling NIL partnership opportunity.' },
    slide2: { bullets: safeParseArray(matchScore?.campaign_ideas).map(i => typeof i === 'string' ? i : JSON.stringify(i)) },
    slide3: { stats: [athleteData.stats || 'Top performer'], role: matchScore?.reasoning || '' },
    slide4: { instagram: String(athleteData.instagram || 0), tiktok: String(athleteData.tiktok || 0), engagement: String(athleteData.engagement || 0), audienceSummary: pitch?.audience_alignment || '', growthSignal: '' },
    slide5: { categories: safeParseArray(matchScore?.partnership_opportunities).map(o => typeof o === 'string' ? { name: o, reason: '' } : { name: o.type || o.description || '', reason: o.estimated_value_range || '' }) },
    slide6: { activations: safeParseArray(pitch?.campaign_ideas || []).map(a => typeof a === 'string' ? { title: a, description: '' } : a) },
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) {
      console.warn('[deckGeneration] Cannot create output dir:', e.message);
    }
  }
}

async function getNextVersion(agentId, athleteId, brandName) {
  const r = await pool.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM pitch_decks WHERE agent_id=$1 AND athlete_id=$2 AND LOWER(brand_name)=LOWER($3)`,
    [agentId, athleteId, brandName]
  );
  return r.rows[0]?.next_version || 1;
}

function extractAthleteData(athlete) {
  if (athlete.data && typeof athlete.data === 'object') return { ...athlete.data, id: athlete.id };
  return athlete;
}

function safeParseArray(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

function formatFollowers(n) {
  const num = parseInt(n) || 0;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num > 0 ? String(num) : '—';
}

function logEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { generateDeck, getDeckById, getDecksForAthleteBrand };
