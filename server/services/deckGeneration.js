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
    const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ACCENT = '#BA0C2F'; // NIL crimson — matches pitch.html --uni color
    const DARK   = '#06080F';
    const SURF   = '#0D1020';
    const WHITE  = '#F4F6FF';
    const MUTED  = '#8B91A8';
    const W      = doc.page.width;   // 612
    const H      = doc.page.height;  // 792
    const PAD    = 56;

    // ── Slide 1: Cover (headline + intro) ────────────────────────────────────
    doc.rect(0, 0, W, H).fill(DARK);
    // accent bar top
    doc.rect(0, 0, W, 6).fill(ACCENT);

    const headline = (kit.slide1?.headline || `${athleteData.name} × ${enrichment.brand_name}`);
    const intro    = kit.slide1?.intro || '';
    const score    = matchScore?.compatibility_score;

    // athlete name big
    doc.fill(ACCENT).fontSize(11).font('Helvetica-Bold')
       .text('NIL PARTNERSHIP PROPOSAL', PAD, 60, { characterSpacing: 2 });
    doc.rect(PAD, 80, 48, 2).fill(ACCENT);

    doc.fill(WHITE).fontSize(36).font('Helvetica-Bold')
       .text(headline, PAD, 110, { width: W - PAD * 2, lineGap: 4 });

    if (intro) {
      doc.fill(MUTED).fontSize(13).font('Helvetica')
         .text(intro, PAD, doc.y + 18, { width: W - PAD * 2, lineGap: 5 });
    }

    // Stats row from athlete data
    const statY = 380;
    const statItems = [
      { label: 'SPORT',      value: (athleteData.sport || 'N/A').toUpperCase() },
      { label: 'SCHOOL',     value: athleteData.school || 'N/A' },
      { label: 'INSTAGRAM',  value: formatFollowers(athleteData.instagram) },
      { label: 'TIKTOK',     value: formatFollowers(athleteData.tiktok) },
    ];
    const boxW = (W - PAD * 2 - 12 * 3) / 4;
    statItems.forEach((s, i) => {
      const bx = PAD + i * (boxW + 12);
      doc.rect(bx, statY, boxW, 70).fill(SURF);
      doc.rect(bx, statY, boxW, 3).fill(ACCENT);
      doc.fill(ACCENT).fontSize(22).font('Helvetica-Bold')
         .text(s.value, bx + 10, statY + 14, { width: boxW - 20, align: 'center' });
      doc.fill(MUTED).fontSize(8).font('Helvetica')
         .text(s.label, bx + 10, statY + 46, { width: boxW - 20, align: 'center', characterSpacing: 1.5 });
    });

    if (score) {
      const bx = PAD;
      doc.rect(bx, statY + 86, 100, 36).fill(ACCENT);
      doc.fill(DARK).fontSize(13).font('Helvetica-Bold')
         .text(`${score}% MATCH`, bx, statY + 97, { width: 100, align: 'center' });
    }

    doc.fill(MUTED).fontSize(8).font('Helvetica')
       .text('Prepared by NILDash — AI-Powered NIL Intelligence', PAD, H - 32,
             { width: W - PAD * 2, align: 'center', characterSpacing: 1 });

    // ── Slide 2: Why Us (bullets) ────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, W, H).fill(SURF);
    doc.rect(0, 0, W, 6).fill(ACCENT);
    brandKitHeader(doc, 'WHY THIS PARTNERSHIP', `${athleteData.name} × ${enrichment.brand_name}`, ACCENT, WHITE, MUTED, PAD);

    const bullets = safeParseArray(kit.slide2?.bullets);
    let by = 140;
    bullets.slice(0, 5).forEach((bullet, i) => {
      // numbered card
      doc.rect(PAD, by, W - PAD * 2, 64).fill(DARK);
      doc.rect(PAD, by, 4, 64).fill(ACCENT);
      doc.fill(ACCENT).fontSize(22).font('Helvetica-Bold')
         .text(String(i + 1).padStart(2, '0'), PAD + 16, by + 10);
      const bulletText = typeof bullet === 'string' ? bullet : (bullet.text || JSON.stringify(bullet));
      const [lead, ...rest] = bulletText.split(' — ');
      doc.fill(WHITE).fontSize(11).font('Helvetica-Bold')
         .text(lead, PAD + 56, by + 10, { width: W - PAD * 2 - 72 });
      if (rest.length) {
        doc.fill(MUTED).fontSize(10).font('Helvetica')
           .text(rest.join(' — '), PAD + 56, doc.y + 2, { width: W - PAD * 2 - 72 });
      }
      by += 76;
    });

    // ── Slide 3: Performance / Stats ─────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, W, H).fill(DARK);
    doc.rect(0, 0, W, 6).fill(ACCENT);
    brandKitHeader(doc, 'ON-FIELD PERFORMANCE', 'Competitive credentials that matter', ACCENT, WHITE, MUTED, PAD);

    const perfStats = safeParseArray(kit.slide3?.stats);
    const role      = kit.slide3?.role || '';
    const pboxW     = (W - PAD * 2 - 14 * 2) / 3;
    perfStats.slice(0, 3).forEach((stat, i) => {
      const bx = PAD + i * (pboxW + 14);
      doc.rect(bx, 140, pboxW, 90).fill(SURF);
      doc.rect(bx, 140, pboxW, 3).fill(ACCENT);
      const statText = typeof stat === 'string' ? stat : JSON.stringify(stat);
      // Split on common patterns: "12 PPG", "3x All-Conference"
      const parts = statText.match(/^(\S+(?:\s\S+)?)\s+(.+)$/) || [null, statText, ''];
      doc.fill(ACCENT).fontSize(28).font('Helvetica-Bold')
         .text(parts[1] || statText, bx + 8, 152, { width: pboxW - 16, align: 'center' });
      if (parts[2]) {
        doc.fill(MUTED).fontSize(9).font('Helvetica')
           .text(parts[2].toUpperCase(), bx + 8, 190, { width: pboxW - 16, align: 'center', characterSpacing: 1 });
      }
    });

    if (role) {
      doc.rect(PAD, 252, W - PAD * 2, 1).fill('#1C2030');
      doc.fill(WHITE).fontSize(14).font('Helvetica')
         .text(role, PAD, 270, { width: W - PAD * 2, lineGap: 4 });
    }

    // Athlete detail table
    const details = [
      ['Position', athleteData.position || 'N/A'],
      ['Year',     athleteData.year || 'N/A'],
      ['School',   athleteData.school || 'N/A'],
      ['Stats',    athleteData.stats || 'See full profile'],
    ];
    let dy = 340;
    details.forEach(([lbl, val]) => {
      doc.fill(MUTED).fontSize(9).font('Helvetica').text(lbl.toUpperCase(), PAD, dy, { characterSpacing: 1 });
      doc.fill(WHITE).fontSize(11).font('Helvetica-Bold').text(val, PAD + 100, dy);
      doc.rect(PAD, dy + 18, W - PAD * 2, 1).fill('#1C2030');
      dy += 28;
    });

    // ── Slide 4: Audience & Social ───────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, W, H).fill(SURF);
    doc.rect(0, 0, W, 6).fill(ACCENT);
    brandKitHeader(doc, 'AUDIENCE & REACH', 'Why this audience is valuable to your brand', ACCENT, WHITE, MUTED, PAD);

    // Platform boxes
    const platforms = [
      { label: 'INSTAGRAM', value: formatFollowers(athleteData.instagram || kit.slide4?.instagram), sub: 'Followers' },
      { label: 'TIKTOK',    value: formatFollowers(athleteData.tiktok || kit.slide4?.tiktok),    sub: 'Followers' },
      { label: 'ENGAGEMENT', value: (athleteData.engagement || kit.slide4?.engagement || 'N/A') + '%', sub: 'Avg Rate' },
    ];
    const platW = (W - PAD * 2 - 14 * 2) / 3;
    platforms.forEach((p, i) => {
      const bx = PAD + i * (platW + 14);
      doc.rect(bx, 140, platW, 80).fill(DARK);
      doc.fill(MUTED).fontSize(8).font('Helvetica').text(p.label, bx + 8, 152, { width: platW - 16, align: 'center', characterSpacing: 1.5 });
      doc.fill(WHITE).fontSize(30).font('Helvetica-Bold').text(p.value, bx + 8, 166, { width: platW - 16, align: 'center' });
      doc.fill(MUTED).fontSize(9).font('Helvetica').text(p.sub, bx + 8, 200, { width: platW - 16, align: 'center' });
    });

    if (kit.slide4?.audienceSummary) {
      doc.rect(PAD, 242, W - PAD * 2, 1).fill('#1C2030');
      doc.fill(WHITE).fontSize(13).font('Helvetica')
         .text(kit.slide4.audienceSummary, PAD, 258, { width: W - PAD * 2, lineGap: 4 });
    }
    if (kit.slide4?.growthSignal) {
      doc.fill(ACCENT).fontSize(11).font('Helvetica-Bold')
         .text('↑  ' + kit.slide4.growthSignal, PAD, doc.y + 16, { width: W - PAD * 2 });
    }

    // ── Slide 5: Brand Categories ─────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, W, H).fill(DARK);
    doc.rect(0, 0, W, 6).fill(ACCENT);
    brandKitHeader(doc, 'PARTNERSHIP CATEGORIES', `Tailored to ${enrichment.brand_name}`, ACCENT, WHITE, MUTED, PAD);

    const cats = safeParseArray(kit.slide5?.categories);
    let cy = 140;
    cats.slice(0, 4).forEach(cat => {
      const name   = typeof cat === 'string' ? cat : (cat.name || 'Category');
      const reason = typeof cat === 'object' ? (cat.reason || '') : '';
      doc.rect(PAD, cy, W - PAD * 2, reason ? 68 : 44).fill(SURF);
      doc.rect(PAD, cy, 4, reason ? 68 : 44).fill(ACCENT);
      doc.fill(WHITE).fontSize(12).font('Helvetica-Bold').text(name, PAD + 16, cy + 10, { width: W - PAD * 2 - 32 });
      if (reason) {
        doc.fill(MUTED).fontSize(10).font('Helvetica')
           .text(reason, PAD + 16, cy + 28, { width: W - PAD * 2 - 32, lineGap: 3 });
      }
      cy += (reason ? 68 : 44) + 10;
    });

    // ── Slide 6: Activations / CTA ────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, W, H).fill(SURF);
    doc.rect(0, 0, W, 6).fill(ACCENT);
    brandKitHeader(doc, 'CAMPAIGN ACTIVATIONS', `What we can build together`, ACCENT, WHITE, MUTED, PAD);

    const activations = safeParseArray(kit.slide6?.activations);
    let av = 140;
    activations.slice(0, 3).forEach(act => {
      const title = typeof act === 'string' ? act : (act.title || 'Campaign Idea');
      const desc  = typeof act === 'object' ? (act.description || '') : '';
      const boxH  = desc ? 90 : 50;
      doc.rect(PAD, av, W - PAD * 2, boxH).fill(DARK);
      doc.rect(PAD, av, W - PAD * 2, 3).fill(ACCENT);
      doc.fill(WHITE).fontSize(13).font('Helvetica-Bold').text(title, PAD + 16, av + 14, { width: W - PAD * 2 - 32 });
      if (desc) {
        doc.fill(MUTED).fontSize(11).font('Helvetica')
           .text(desc, PAD + 16, av + 34, { width: W - PAD * 2 - 32, lineGap: 3 });
      }
      av += boxH + 12;
    });

    // CTA footer
    const ctaY = H - 120;
    doc.rect(PAD, ctaY, W - PAD * 2, 56).fill(ACCENT);
    doc.fill(DARK).fontSize(16).font('Helvetica-Bold')
       .text(`Let's discuss how ${athleteData.name} can represent ${enrichment.brand_name}`, PAD + 20, ctaY + 10, { width: W - PAD * 2 - 40, align: 'center', lineGap: 3 });

    doc.fill(MUTED).fontSize(8).font('Helvetica')
       .text('NILDash — AI-Powered NIL Intelligence', PAD, H - 32,
             { width: W - PAD * 2, align: 'center', characterSpacing: 1 });

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
