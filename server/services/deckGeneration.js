// server/services/deckGeneration.js
// DeckGenerationService — Part 5 of the NIL Outreach Automation Engine.
//
// Generates a brand-specific pitch deck PDF for athlete + brand pairs.
// Uses pdfkit (already in package.json — no new dependencies).
// Saves PDF to /tmp/ (Railway ephemeral storage) and records metadata in pitch_decks.
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
 * Returns pitch_decks DB record with file_path.
 */
async function generateDeck(inputs) {
  const { agentId, athleteId, athlete, enrichment, matchScore, pitch } = inputs;
  const athleteData = extractAthleteData(athlete);

  ensureOutputDir();

  const id       = 'deck_' + crypto.randomBytes(8).toString('hex');
  const version  = await getNextVersion(agentId, athleteId, enrichment.brand_name);
  const filename = `${id}_v${version}.pdf`;
  const filePath = path.join(OUTPUT_DIR, filename);

  const slideData = buildSlideData(athleteData, enrichment, matchScore, pitch);

  if (PDFDocument) {
    await renderPDF(filePath, athleteData, enrichment, matchScore, pitch, slideData);
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

// ── PDF Rendering ─────────────────────────────────────────────────────────────

async function renderPDF(filePath, athleteData, enrichment, matchScore, pitch, slideData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ACCENT  = '#84CC16'; // NILDash lime green
    const DARK    = '#111827';
    const MUTED   = '#6B7280';
    const WHITE   = '#FFFFFF';
    const SURFACE = '#1F2937';

    // ── Slide 1: Cover ──────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(DARK);
    doc.fill(ACCENT).fontSize(32).font('Helvetica-Bold')
       .text(athleteData.name || 'Athlete', 50, 180, { align: 'center', width: doc.page.width - 100 });
    doc.fill(WHITE).fontSize(18).font('Helvetica')
       .text('×', 50, 225, { align: 'center', width: doc.page.width - 100 });
    doc.fill(WHITE).fontSize(26).font('Helvetica-Bold')
       .text(enrichment.brand_name, 50, 250, { align: 'center', width: doc.page.width - 100 });
    doc.fill(MUTED).fontSize(13).font('Helvetica')
       .text('NIL Partnership Proposal', 50, 300, { align: 'center', width: doc.page.width - 100 });
    doc.fill(MUTED).fontSize(10)
       .text(`${athleteData.sport || ''} | ${athleteData.school || ''}`, 50, 325, { align: 'center', width: doc.page.width - 100 });

    // Score badge
    if (matchScore?.compatibility_score) {
      doc.fill(ACCENT).roundedRect(doc.page.width / 2 - 40, 380, 80, 40, 8).fill(ACCENT);
      doc.fill(DARK).fontSize(14).font('Helvetica-Bold')
         .text(`${matchScore.compatibility_score}% FIT`, doc.page.width / 2 - 40, 394, { width: 80, align: 'center' });
    }

    doc.fill(MUTED).fontSize(9).font('Helvetica')
       .text('Prepared by NILDash', 50, doc.page.height - 60, { align: 'center', width: doc.page.width - 100 });

    // ── Slide 2: Athlete Overview ────────────────────────────────────────────
    doc.addPage();
    slideHeader(doc, 'ATHLETE OVERVIEW', ACCENT, DARK, WHITE);

    const stats = [
      ['Sport',        athleteData.sport || 'N/A'],
      ['School',       athleteData.school || 'N/A'],
      ['Position',     athleteData.position || 'N/A'],
      ['Year',         athleteData.year || 'N/A'],
      ['Instagram',    formatFollowers(athleteData.instagram) + ' followers'],
      ['TikTok',       formatFollowers(athleteData.tiktok) + ' followers'],
      ['Engagement',   (athleteData.engagement || 0) + '%'],
      ['Stats',        athleteData.stats || 'N/A'],
    ];

    let y = 130;
    for (const [label, value] of stats) {
      doc.fill(MUTED).fontSize(9).font('Helvetica').text(label.toUpperCase(), 50, y);
      doc.fill(WHITE).fontSize(12).font('Helvetica-Bold').text(value, 160, y);
      y += 28;
    }

    // ── Slide 3: Audience Analytics ──────────────────────────────────────────
    doc.addPage();
    slideHeader(doc, 'AUDIENCE & REACH', ACCENT, DARK, WHITE);

    addBodyText(doc, pitch.audience_alignment || 'Strong audience alignment identified.', WHITE, 130);
    addBodyText(doc, pitch.value_proposition || '', MUTED, 220);

    // ── Slide 4: Brand Alignment ─────────────────────────────────────────────
    doc.addPage();
    slideHeader(doc, 'BRAND ALIGNMENT', ACCENT, DARK, WHITE);

    addBodyText(doc, pitch.athlete_fit || '', WHITE, 130);
    addBodyText(doc, matchScore?.reasoning || '', MUTED, 220);

    if (pitch.deck_talking_points?.length) {
      doc.fill(ACCENT).fontSize(10).font('Helvetica-Bold').text('KEY POINTS', 50, 310);
      let py = 330;
      for (const point of pitch.deck_talking_points.slice(0, 5)) {
        doc.fill(WHITE).fontSize(11).font('Helvetica')
           .text('• ' + point, 50, py, { width: doc.page.width - 100 });
        py += 22;
      }
    }

    // ── Slide 5: Partnership Opportunities ───────────────────────────────────
    doc.addPage();
    slideHeader(doc, 'PARTNERSHIP OPPORTUNITIES', ACCENT, DARK, WHITE);

    const ideas = safeParseArray(matchScore?.campaign_ideas);
    const opps  = safeParseArray(matchScore?.partnership_opportunities);

    let oy = 130;
    doc.fill(ACCENT).fontSize(10).font('Helvetica-Bold').text('CAMPAIGN IDEAS', 50, oy);
    oy += 20;
    for (const idea of ideas.slice(0, 3)) {
      doc.fill(WHITE).fontSize(11).font('Helvetica')
         .text('• ' + (typeof idea === 'string' ? idea : JSON.stringify(idea)), 50, oy, { width: doc.page.width - 100 });
      oy += 22;
    }

    oy += 10;
    doc.fill(ACCENT).fontSize(10).font('Helvetica-Bold').text('PARTNERSHIP TYPES', 50, oy);
    oy += 20;
    for (const opp of opps.slice(0, 3)) {
      const label = typeof opp === 'string' ? opp : (opp.description || opp.type || JSON.stringify(opp));
      const range = typeof opp === 'object' ? (' — ' + (opp.estimated_value_range || '')) : '';
      doc.fill(WHITE).fontSize(11).font('Helvetica')
         .text('• ' + label + range, 50, oy, { width: doc.page.width - 100 });
      oy += 22;
    }

    // ── Slide 6: CTA ─────────────────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(DARK);
    slideHeader(doc, 'LET\'S PARTNER', ACCENT, DARK, WHITE);

    addBodyText(doc, pitch.partnership_structure || 'We propose an initial partnership campaign.', WHITE, 130);
    addBodyText(doc, pitch.roi_messaging || '', MUTED, 210);

    // CTA box
    doc.rect(50, 280, doc.page.width - 100, 50).fill(ACCENT);
    doc.fill(DARK).fontSize(14).font('Helvetica-Bold')
       .text(pitch.cta || 'Would you be open to a call this week?', 50, 296,
             { width: doc.page.width - 100, align: 'center' });

    doc.fill(MUTED).fontSize(9).font('Helvetica')
       .text('NILDash — AI-Powered NIL Intelligence', 50, doc.page.height - 60,
             { align: 'center', width: doc.page.width - 100 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

function slideHeader(doc, title, accent, dark, white) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(dark);
  doc.rect(0, 0, doc.page.width, 80).fill('#111827');
  doc.fill(accent).fontSize(10).font('Helvetica-Bold')
     .text(title, 50, 30, { width: doc.page.width - 100 });
  doc.rect(50, 55, 60, 2).fill(accent);
}

function addBodyText(doc, text, color, y) {
  if (!text) return;
  doc.fill(color).fontSize(12).font('Helvetica')
     .text(text, 50, y, { width: doc.page.width - 100, lineGap: 4 });
}

// ── Slide data (used even when PDF unavailable) ───────────────────────────────

function buildSlideData(athleteData, enrichment, matchScore, pitch) {
  return {
    slide1: { type: 'cover', athlete: athleteData.name, brand: enrichment.brand_name, score: matchScore?.compatibility_score },
    slide2: { type: 'athlete', sport: athleteData.sport, school: athleteData.school, instagram: athleteData.instagram, tiktok: athleteData.tiktok, engagement: athleteData.engagement, stats: athleteData.stats },
    slide3: { type: 'audience', content: pitch.audience_alignment, value_prop: pitch.value_proposition },
    slide4: { type: 'alignment', athlete_fit: pitch.athlete_fit, reasoning: matchScore?.reasoning, talking_points: pitch.deck_talking_points },
    slide5: { type: 'opportunities', campaign_ideas: safeParseArray(matchScore?.campaign_ideas), partnership_types: safeParseArray(matchScore?.partnership_opportunities) },
    slide6: { type: 'cta', partnership_structure: pitch.partnership_structure, roi: pitch.roi_messaging, cta: pitch.cta },
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
