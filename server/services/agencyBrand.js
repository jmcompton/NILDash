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

module.exports = { brandForUser, brandFor, validate, COLUMNS, POWERED_BY, MAX_LOGO_CHARS };
