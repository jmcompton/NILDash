// server/services/deckGeneration.js
// DeckGenerationService — Part 5 of the NIL Outreach Automation Engine.
//
// Generates a one-page "why this athlete fits this brand" PDF brief.
// Replaces the 6-slide format with a single focused page.
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
const { oneShot, MODEL_FAST } = require('../ai');

let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (e) {
  console.warn('[deckGeneration] pdfkit not available:', e.message);
}

const OUTPUT_DIR = process.env.DECK_OUTPUT_DIR || '/tmp/nildash-decks';

// Normalize a brand name that may arrive as a slash-joined list (e.g.
// "Parent Co / Subsidiary / DealerName") to a single consistent label.
function cleanBrand(name) {
  if (!name) return 'the brand';
  const parts = String(name).split('/').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(name).trim();
}

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

  // ── Generate one-pager content via AI ────────────────────────────────────
  let onePager;
  try {
    onePager = await generateOnePagerContent(athleteData, enrichment, matchScore, pitch);
  } catch (e) {
    console.error('[deckGeneration] generateOnePagerContent failed:', e.message);
    onePager = buildFallbackOnePager(athleteData, enrichment, matchScore, pitch);
  }

  const id       = 'deck_' + crypto.randomBytes(8).toString('hex');
  const version  = await getNextVersion(agentId, athleteId, enrichment.brand_name);
  const filename = `${id}_v${version}.pdf`;
  const filePath = path.join(OUTPUT_DIR, filename);

  if (PDFDocument) {
    await renderOnePagerPDF(filePath, athleteData, enrichment, matchScore, onePager);
  } else {
    console.warn('[deckGeneration] pdfkit unavailable — saving content only');
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
      JSON.stringify(onePager),
      version,
    ]
  );

  logEvent(null, agentId, 'deck_generated', { id, brand: enrichment.brand_name, athleteId });
  return r.rows[0];
}

// ── One-Pager AI Content Generator ───────────────────────────────────────────

async function generateOnePagerContent(athleteData, enrichment, matchScore, pitch) {
  const brand = cleanBrand(enrichment.brand_name);
  const ig    = formatFollowers(athleteData.instagram);
  const tt    = formatFollowers(athleteData.tiktok);

  const prompt = `You are a NIL agency strategist writing a one-page partnership brief.

ATHLETE: ${athleteData.name}
Sport: ${athleteData.sport || 'N/A'} | Position: ${athleteData.position || 'N/A'} | Year: ${athleteData.year || 'N/A'}
School: ${athleteData.school || 'N/A'}
Stats: ${athleteData.stats || 'N/A'}
Notes: ${athleteData.notes || 'N/A'}
Instagram: ${ig} | TikTok: ${tt} | Engagement: ${athleteData.engagement || 'N/A'}%

BRAND: ${brand}
Industry: ${enrichment.industry || 'N/A'}
Description: ${enrichment.description || 'N/A'}
Match score: ${matchScore?.compatibility_score || 'N/A'}/100

Write content for a ONE-PAGE brief answering: why is this athlete the right partner for ${brand}?

RULES — follow every one:
- No AI buzzwords: no "unique", "synergy", "leverage", "perfect fit", "natural fit", "authentic journey", "exciting", "game-changer", "seamlessly", "resonate", "innovative", "dynamic"
- Be specific to this athlete's actual stats and this brand's actual products
- Reasons must be facts, not opinions
- Campaign must describe what literally gets made (what's filmed, where, what platform)
- Never use he/she/his/her or any gendered word for the athlete. Use the athlete's last name or they/them. Position titles like forward or guard are fine. Refer to the sport plainly.
- Use ONLY the data above. Never invent or imply sponsors, brand deals, endorsements, awards, rankings, compliance or FTC clearance, or any stat not provided. If data is thin, build the brief only from followers, engagement, sport, position, school, and location.

Return ONLY this JSON, no markdown:
{
  "brandDisplayName": "The clean, specific brand name to address on the brief (e.g. 'Mercedes-Benz of Tuscaloosa'), never the parent company or a combined name. Max 35 characters.",
  "tagline": "One plain sentence. Why this athlete and this brand make sense together right now. One complete sentence, max 16 words.",
  "reasons": [
    "Fact-based reason — references actual numbers or known brand attributes. Max 24 words. One complete sentence.",
    "Fact-based reason. Max 24 words. One complete sentence.",
    "Fact-based reason. Max 24 words. One complete sentence."
  ],
  "campaign": {
    "title": "Campaign name — specific to ${brand}. Max 8 words.",
    "description": "What gets made: what's filmed, where, which platform, what the deliverable is. Two short complete sentences, max 42 words total. No vague language."
  },
  "audienceNote": "One complete sentence, max 26 words: who specifically follows this athlete and why that audience is worth reaching for ${brand}."
}`;

  // Deck copy is structured JSON rendered into fields, not agent-read prose, so
  // it runs on the cheap Haiku tier (same extraction pattern as Deal Scan).
  const raw = await oneShot(prompt,
    'Return only valid JSON. No markdown. No preamble. Be specific to this athlete and brand.', 1500, MODEL_FAST);
  const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in AI response');
  return JSON.parse(match[0]);
}

function buildFallbackOnePager(athleteData, enrichment, matchScore, pitch) {
  return {
    brandDisplayName: cleanBrand(enrichment.brand_name),
    tagline: `${athleteData.name} brings ${formatFollowers(athleteData.instagram)} Instagram followers to ${enrichment.brand_name}.`,
    reasons: [
      `${formatFollowers(athleteData.instagram)} Instagram followers and ${athleteData.engagement || '—'}% engagement rate.`,
      `${athleteData.sport || 'Athlete'} at ${athleteData.school || 'a top program'} with measurable on-field performance.`,
      pitch?.audience_alignment || `Audience demographics align with ${enrichment.brand_name}'s target market.`,
    ],
    campaign: {
      title: `${enrichment.brand_name} × ${athleteData.name}`,
      description: pitch?.campaign_ideas?.[0] || `Content series featuring ${athleteData.name} using ${enrichment.brand_name} products across Instagram and TikTok.`,
    },
    audienceNote: pitch?.audience_alignment || `${athleteData.name}'s audience is concentrated in ${athleteData.school || 'college sports'} communities.`,
  };
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

// ── PDF Rendering — One-Page Partnership Brief ────────────────────────────────

/**
 * renderOnePagerPDF
 * Produces a single LETTER-sized page answering: why this athlete for this brand?
 * Layout (all Y values are absolute — no doc.y drift):
 *   Y   0–  5  accent bar
 *   Y   5– 90  header: label, athlete name, brand name
 *   Y  90–155  5 stat pills: Sport | School | Instagram | TikTok | Engagement
 *   Y 155–165  section divider
 *   Y 165–185  "WHY THIS WORKS" label
 *   Y 185–335  3 reason cards (46px each + 8px gap)
 *   Y 335–350  section divider
 *   Y 350–370  "CAMPAIGN CONCEPT" label
 *   Y 370–480  campaign box: title + description
 *   Y 480–495  section divider
 *   Y 495–515  "THE AUDIENCE" label
 *   Y 515–580  audience note text
 *   Y 590–650  CTA box (accent)
 *   Y 650–792  score badges + footer
 */
async function renderOnePagerPDF(filePath, athleteData, enrichment, matchScore, onePager) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const ACCENT = '#BA0C2F';
    const DARK   = '#06080F';
    const SURF   = '#141828';
    const WHITE  = '#F4F6FF';
    const MUTED  = '#8B91A8';
    const LIGHT  = '#C8CCE0';
    const W = 612; const H = 792; const PAD = 44; const CW = W - PAD * 2;

    function tr(text, max) {
      if (!text) return '';
      const s = String(text);
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function sectionLabel(label, y) {
      doc.fill(ACCENT).fontSize(7.5).font('Helvetica-Bold')
         .text(label, PAD, y, { width: CW, characterSpacing: 2 });
      doc.rect(PAD, y + 13, 32, 1.5).fill(ACCENT);
    }

    // ── BACKGROUND ────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(DARK);

    // ── TOP ACCENT BAR ────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 5).fill(ACCENT);

    // ── HEADER BLOCK  Y 5–90 ──────────────────────────────────────────────────
    doc.fill(ACCENT).fontSize(7.5).font('Helvetica-Bold')
       .text('NIL PARTNERSHIP BRIEF', PAD, 16, { width: CW, characterSpacing: 2 });
    doc.rect(PAD, 28, 32, 1.5).fill(ACCENT);

    // Athlete name
    doc.fill(WHITE).fontSize(26).font('Helvetica-Bold')
       .text(tr(athleteData.name || 'Athlete', 40), PAD, 36, { width: CW });

    // "for Brand" on same line as name
    const nameWidth = doc.widthOfString(tr(athleteData.name || 'Athlete', 40), { fontSize: 26 });
    doc.fill(MUTED).fontSize(14).font('Helvetica')
       .text(`for ${tr(onePager.brandDisplayName || cleanBrand(enrichment.brand_name), 34)}`, PAD, 68, { width: CW });

    // ── HORIZONTAL RULE  Y 90 ────────────────────────────────────────────────
    doc.rect(PAD, 92, CW, 0.75).fill('#2A3050');

    // ── STAT PILLS  Y 98–155 ─────────────────────────────────────────────────
    const shortSchool = (athleteData.school || '—')
      .replace(/^University of /i, '')
      .replace(/ University$/i, '');
    const stats = [
      { label: 'SPORT',       value: tr((athleteData.sport || '—').toUpperCase(), 10) },
      { label: 'SCHOOL',      value: tr(shortSchool, 14) },
      { label: 'INSTAGRAM',   value: formatFollowers(athleteData.instagram) },
      { label: 'TIKTOK',      value: formatFollowers(athleteData.tiktok) },
      { label: 'ENGAGEMENT',  value: `${athleteData.engagement || '—'}%` },
    ];
    const pillW = (CW - 8 * 4) / 5;
    stats.forEach((s, i) => {
      const px = PAD + i * (pillW + 8);
      doc.rect(px, 100, pillW, 52).fill(SURF);
      doc.rect(px, 100, pillW, 2.5).fill(ACCENT);
      doc.fill(ACCENT).fontSize(11).font('Helvetica-Bold')
         .text(s.value, px + 4, 112, { width: pillW - 8, align: 'center', lineBreak: false });
      doc.fill(MUTED).fontSize(6.5).font('Helvetica')
         .text(s.label, px + 4, 136, { width: pillW - 8, align: 'center', characterSpacing: 1 });
    });

    // ── WHY THIS WORKS  Y 162–335 ────────────────────────────────────────────
    doc.rect(PAD, 158, CW, 0.75).fill('#2A3050');
    sectionLabel('WHY THIS WORKS', 164);

    const reasons = (onePager.reasons || []).slice(0, 3);
    const cardH = 46;
    reasons.forEach((reason, i) => {
      const rText = typeof reason === 'string' ? reason : JSON.stringify(reason);
      const ry = 184 + i * (cardH + 6);
      doc.rect(PAD, ry, CW, cardH).fill(SURF);
      doc.rect(PAD, ry, 3, cardH).fill(ACCENT);
      doc.fill(WHITE).fontSize(10.5).font('Helvetica')
         .text(tr(rText, 190), PAD + 12, ry + 9, { width: CW - 18, lineGap: 2 });
    });

    // ── CAMPAIGN CONCEPT  Y 342–480 ──────────────────────────────────────────
    doc.rect(PAD, 340, CW, 0.75).fill('#2A3050');
    sectionLabel('CAMPAIGN CONCEPT', 346);

    const campTitle = tr(onePager.campaign?.title || 'Partnership Campaign', 60);
    const campDesc  = tr(onePager.campaign?.description || '', 340);

    doc.rect(PAD, 366, CW, 108).fill(SURF);
    doc.rect(PAD, 366, CW, 2.5).fill(ACCENT);
    doc.fill(WHITE).fontSize(12).font('Helvetica-Bold')
       .text(campTitle, PAD + 14, 378, { width: CW - 28 });
    doc.fill(LIGHT).fontSize(10.5).font('Helvetica')
       .text(campDesc, PAD + 14, 398, { width: CW - 28, lineGap: 3 });

    // ── AUDIENCE  Y 484–575 ───────────────────────────────────────────────────
    doc.rect(PAD, 482, CW, 0.75).fill('#2A3050');
    sectionLabel('THE AUDIENCE', 488);

    const audNote = tr(onePager.audienceNote || '', 240);
    doc.rect(PAD, 508, CW, 58).fill(SURF);
    doc.rect(PAD, 508, 3, 58).fill(ACCENT);
    doc.fill(LIGHT).fontSize(10.5).font('Helvetica')
       .text(audNote, PAD + 14, 520, { width: CW - 24, lineGap: 3 });

    // ── CTA BOX  Y 578–640 ────────────────────────────────────────────────────
    doc.rect(PAD, 578, CW, 58).fill(ACCENT);
    const ctaText = tr(onePager.tagline || `${athleteData.name} is the right fit for ${enrichment.brand_name}.`, 130);
    doc.fill(DARK).fontSize(12).font('Helvetica-Bold')
       .text(ctaText, PAD + 18, 598, { width: CW - 36, align: 'center', lineGap: 3 });

    // ── SCORE BADGES  Y 650–690 ───────────────────────────────────────────────
    let bx = PAD;
    if (athleteData.engagement) {
      doc.rect(bx, 652, 118, 28).fill(SURF);
      doc.rect(bx, 652, 118, 2).fill(ACCENT);
      doc.fill(WHITE).fontSize(10.5).font('Helvetica-Bold')
         .text(`${athleteData.engagement}% ENGAGEMENT`, bx, 660, { width: 118, align: 'center' });
    }

    // ── BOTTOM ACCENT BAR + FOOTER ────────────────────────────────────────────
    doc.rect(0, H - 28, W, 28).fill('#0A0C14');
    doc.fill(MUTED).fontSize(7.5).font('Helvetica')
       .text('NILDash — AI-Powered NIL Intelligence', PAD, H - 19, { width: CW, align: 'center', characterSpacing: 0.5 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
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
