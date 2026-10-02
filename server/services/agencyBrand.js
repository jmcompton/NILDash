'use strict';
// ── THE AGENCY'S BRAND ──────────────────────────────────────────────────────
//
// What a customer's client-facing documents carry: the media kit, the pitch
// deck page, the one-page deck PDF, the rate sheet, the contract PDF and the
// share-link report. They are about the agency and the athlete. NILDash
// appears once, as "Powered by NILDash" in the footer, and nowhere else: not
// the header, not the title, not the favicon, not a label. NILDash represents
// nobody; the agency represents the athlete.
//
// ONE PLACE, ON THE ACCOUNT, beside the signature and the scheduling link
// (users.signature_text / scheduling_url, services/signature). The account can
// be an agent's or a university's: same columns, different owner, so a
// university's documents carry its own brand with nothing built twice.
//
// THE FALLBACK IS THE ACCOUNT, NEVER NILDASH. An agent who has set nothing
// gets their own name and email: an unbranded kit reads as a plain kit from
// that agent, not as a NILDash kit.
//
// Pure: no SQL. The caller supplies the account row.

const POWERED_BY = 'Powered by NILDash';

const MAX_NAME = 80;
const MAX_LINE = 120;
// A logo is stored as a data URL, like the media kit photos (migration 011),
// downscaled in the browser first. PNG, JPEG or WebP only: an SVG can carry
// script, and this image is shown on public pages.
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_CHARS = 400 * 1024;

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanColor(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  return '';
}
function cleanEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) ? s.slice(0, 160) : '';
}
function cleanUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (_) { return ''; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
  return u.toString();
}
function cleanLogo(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!LOGO_RE.test(s)) return null;               // present but not allowed
  if (s.length > MAX_LOGO_CHARS) return null;
  return s;
}

// Validate what Settings posts. Returns { ok, fields } or { ok:false, error }.
// Empty means "not set" and is always allowed.
function validate(body) {
  const b = body || {};
  const logo = cleanLogo(b.logo);
  if (logo === null) return { ok: false, error: 'The logo must be a PNG, JPEG or WebP image under 400 KB.' };
  const out = {
    agency_name: cleanText(b.name, MAX_NAME),
    agency_logo: logo,
    agency_primary_color: cleanColor(b.primaryColor),
    agency_secondary_color: cleanColor(b.secondaryColor),
    agency_contact_email: cleanEmail(b.contactEmail),
    agency_contact_phone: cleanText(b.contactPhone, 40),
    agency_website: cleanUrl(b.website),
    agency_contact_line: cleanText(b.contactLine, MAX_LINE),
  };
  if (b.contactEmail && !out.agency_contact_email) return { ok: false, error: 'That contact email is not an email address.' };
  if (b.website && !out.agency_website) return { ok: false, error: 'That website is not a web address we can link to.' };
  if ((b.primaryColor && !out.agency_primary_color) || (b.secondaryColor && !out.agency_secondary_color)) {
    return { ok: false, error: 'Colors must be hex, like #1E3A8A.' };
  }
  return { ok: true, fields: out };
}

// The brand a document shows, from the account row. Never NILDash.
//
// THE CONTACT ADDRESS a business sees on a deck, a kit or a contract: the one
// the agent typed into My Brand, else the mailbox their outreach actually
// sends from (opts.sendingAddress, from brandForUser), and the signup email
// only when neither exists. It was agency_contact_email || users.email, so a
// deck could tell a brand to write to an address the agent's outreach never
// came from.
// ── AN ACCENT THAT CANNOT MAKE THE KIT UNREADABLE ───────────────────────────
// The accent colours text on the kit's white card (the reach figure, rate
// prices, the footer link). A pale or neon agency colour is darkened, hue
// kept, until it reaches CONTRAST_MIN (4.5:1, WCAG AA for text) against white.
// Text ON the accent is chosen black or white by the page as before. Never
// changes a background or body text colour.
const CONTRAST_MIN = 4.5;
function _rgb(hex) {
  let c = String(hex || '').replace('#', '').trim();
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  if (!/^[0-9a-f]{6}$/i.test(c)) return null;
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
}
function _lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastOnWhite(hex) { const c = _rgb(hex); return c ? 1.05 / (_lum(c) + 0.05) : null; }
function clampAccent(hex) {
  let c = _rgb(hex);
  if (!c) return '';
  for (let i = 0; i < 40 && 1.05 / (_lum(c) + 0.05) < CONTRAST_MIN; i++) c = c.map((v) => Math.round(v * 0.92));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function brandFor(user, opts = {}) {
  const u = user || {};
  const set = !!(u.agency_name || u.agency_logo);
  const person = cleanText(u.name, MAX_NAME);
  return {
    hasBrand: set,
    name: cleanText(u.agency_name, MAX_NAME) || person || '',
    logo: u.agency_logo || '',
    primaryColor: u.agency_primary_color || '',
    secondaryColor: u.agency_secondary_color || '',
    contactName: person || '',
    contactEmail: u.agency_contact_email || cleanEmail(opts.sendingAddress) || cleanEmail(u.email) || '',
    contactPhone: u.agency_contact_phone || '',
    website: u.agency_website || '',
    contactLine: u.agency_contact_line || '',
    poweredBy: POWERED_BY,
    // The accent the media kit uses, darkened if needed to stay readable.
    accent: clampAccent(u.agency_primary_color),
    // On for every account; users.hide_powered_by is the one switch, unset.
    showPoweredBy: u.hide_powered_by !== true,
  };
}

// brandFor with the sending mailbox loaded. Every caller that renders the brand
// into something a business or a family reads uses this, not brandFor alone.
async function brandForUser(user) {
  let sendingAddress = null;
  if (user && user.id) {
    try { sendingAddress = (await require('./emailStore').sendingMailbox(user.id)).address; }
    catch (e) { console.warn('[agencyBrand] sending mailbox lookup failed, contact falls back:', e.message); }
  }
  return brandFor(user, { sendingAddress });
}

// The columns, for the ALTERs in store.js and the SELECTs that read them.
const COLUMNS = ['agency_name', 'agency_logo', 'agency_primary_color', 'agency_secondary_color',
  'agency_contact_email', 'agency_contact_phone', 'agency_website', 'agency_contact_line'];

module.exports = { clampAccent, contrastOnWhite, CONTRAST_MIN, brandForUser, brandFor, validate, COLUMNS, POWERED_BY, MAX_LOGO_CHARS };
