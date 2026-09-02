'use strict';
// ── THE AGENT'S SIGNATURE ────────────────────────────────────────────────────
//
// Set once in Settings, appended to every pitch. It is the only part of an
// outbound message that is the same every time, which is exactly why it should
// not be re-derived by a model on each send: a signature that varies is a
// signature nobody trusts, and a scheduling link the model retypes is a
// scheduling link that will eventually be retyped wrong.
//
// So the model NEVER writes it. The writer produces the message; this appends
// the block afterwards, byte for byte as the agent typed it.
//
// TWO FIELDS, NOT ONE. The scheduling URL is kept apart from the free text so
// that:
//   - it can be a real hyperlink in the HTML body rather than a bare string
//   - the body can say "use my scheduling link below" and be TRUE, because we
//     know whether one exists before we ask for that sentence
//   - it can be validated on its own. A signature is free text; a URL is not.
//
// Pure: no SQL, no network. The caller supplies the agent's row.

// Only http(s), and only something that parses. A javascript: or data: URL in a
// signature would be an injected script in every email the agent ever sends.
function validSchedulingUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  let u = null;
  try { u = new URL(withScheme); } catch (_) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!u.hostname || u.hostname.indexOf('.') === -1) return '';
  return u.toString();
}

// A signature is free text the agent typed. It is escaped at render time, never
// here -- storing pre-escaped text means it renders wrong everywhere else, and
// re-escaping on every save doubles the entities.
const MAX_SIGNATURE_CHARS = 600;
function cleanSignatureText(v) {
  return String(v == null ? '' : v)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .trim()
    .slice(0, MAX_SIGNATURE_CHARS);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// What the agent has configured, normalised. `has` is what the pitch prompt
// reads to decide whether it may say "my scheduling link below".
function signatureOf(user) {
  const u = user || {};
  const text = cleanSignatureText(u.signature_text || u.signatureText || '');
  const url = validSchedulingUrl(u.scheduling_url || u.schedulingUrl || '');
  return { text, url, has: !!(text || url), hasLink: !!url };
}

// ── PLAIN TEXT ───────────────────────────────────────────────────────────────
// The link goes on its own line. A URL wrapped mid-sentence is a URL some mail
// clients will break across lines and nobody will click.
function renderText(sig) {
  const s = sig && sig.has ? sig : null;
  if (!s) return '';
  const parts = [];
  if (s.text) parts.push(s.text);
  if (s.url) parts.push(s.url);
  return parts.join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────────────────
// The whole point of storing the URL separately: here it becomes an anchor the
// reader can click, rather than a string they have to select and paste.
function renderHtml(sig, opts = {}) {
  const s = sig && sig.has ? sig : null;
  if (!s) return '';
  const label = String(opts.linkLabel || 'Schedule a call').trim() || 'Schedule a call';
  const out = [];
  if (s.text) out.push(esc(s.text).replace(/\n/g, '<br>'));
  if (s.url) {
    out.push('<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">'
      + esc(label) + '</a>');
  }
  return out.join('<br>');
}

// ── APPENDING IT ─────────────────────────────────────────────────────────────
// IDEMPOTENT ON PURPOSE. A draft can be regenerated, edited and re-saved, and
// each of those is a chance to append a second copy. Appending twice is the
// obvious failure and it reaches a real business, so the check is on the text
// itself rather than on a flag somebody has to remember to clear.
function appendText(body, sig) {
  const b = String(body == null ? '' : body).replace(/\s+$/, '');
  const block = renderText(sig);
  if (!block) return b;
  if (b && b.indexOf(block) !== -1) return b;      // already signed
  return b + '\n\n' + block;
}

function appendHtml(html, sig, opts = {}) {
  const h = String(html == null ? '' : html).replace(/\s+$/, '');
  const block = renderHtml(sig, opts);
  if (!block) return h;
  if (h && h.indexOf(block) !== -1) return h;
  return h + '<br><br>' + block;
}

module.exports = {
  MAX_SIGNATURE_CHARS,
  validSchedulingUrl, cleanSignatureText, signatureOf,
  renderText, renderHtml, appendText, appendHtml,
};
