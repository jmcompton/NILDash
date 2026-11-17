'use strict';
// ── THE ATHLETE'S UPDATE LINK (/me/<token>) ─────────────────────────────────
//
// An agent's pipeline, gift log and deliverables are only as current as the
// agent's typing, and the people who know first are the athletes: they get
// the box in the mail, the DM from the brand, and they post the story. So each
// athlete gets one private link, no login, that the agent texts them once and
// they keep. On it:
//
//   What's due      their open deliverables; "I posted it", with a link to
//                   the post as proof. Marks it done, as the athlete.
//   I got a gift    brand, product, value, where it was posted. Lands in the
//                   agent's Gifts & Reports (services/giftedDeals).
//   A brand reached out   who, how to reach them, what they want. Lands in the
//                   agent's Pipeline as a new deal, marked "from the athlete".
//
// Every update is in the athlete's activity log, so the agent can see what
// changed and who changed it. The agent decides everything that follows: the
// athlete never signs or agrees to anything here.
//
// THE LINK is an unguessable token on the athlete row. The agent can replace
// it (the old one stops working at once). The page is noindex and changes
// nothing on GET.

const crypto = require('crypto');
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
const TOKEN = /^[a-f0-9]{40}$/;
const DONE = ['completed', 'done', 'complete'];

async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE athletes ADD COLUMN IF NOT EXISTS update_token TEXT`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS athletes_update_token_idx ON athletes (update_token) WHERE update_token IS NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE athlete_calendar_events ADD COLUMN IF NOT EXISTS proof_url TEXT`).catch(() => {});
  // athlete_activity_log is the store's (server/store.js); log() is best effort.
}

const urlFor = (token) => `${APP_URL()}/me/${token}`;

// The agent's link for one athlete, made on first ask. -> { url } | null
async function linkFor(pool, agentId, athleteId, { rotate = false } = {}) {
  await ensureColumns(pool);
  const a = (await pool.query(`SELECT id, update_token FROM athletes WHERE id = $1 AND agent_id = $2`, [String(athleteId || ''), agentId])).rows[0];
  if (!a) return null;
  let token = a.update_token;
  if (!token || rotate) {
    token = crypto.randomBytes(20).toString('hex');
    await pool.query(`UPDATE athletes SET update_token = $1 WHERE id = $2`, [token, a.id]);
  }
  return { url: urlFor(token) };
}

async function byToken(pool, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  await ensureColumns(pool);
  const a = (await pool.query(`SELECT a.id, a.agent_id, a.data, u.name AS agent_name FROM athletes a LEFT JOIN users u ON u.id = a.agent_id WHERE a.update_token = $1`, [token])).rows[0];
  if (!a) return null;
  return { id: a.id, agentId: a.agent_id, name: (a.data && a.data.name) || 'there', agentName: a.agent_name || 'your agent' };
}

// Open deliverables from 30 days back to 45 ahead, oldest first.
async function due(pool, ath) {
  return (await pool.query(
    `SELECT id, title, brand, event_date, status FROM athlete_calendar_events
      WHERE athlete_id = $1 AND agent_id = $2 AND LOWER(COALESCE(status, 'pending')) <> ALL($3::text[]) AND COALESCE(status, '') <> 'draft'
        AND event_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE + 45
      ORDER BY event_date, id LIMIT 30`, [ath.id, ath.agentId, DONE])).rows;
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function safeUrl(u) {
  let s = clean(u, 500);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const x = new URL(s); return /^https?:$/.test(x.protocol) && x.hostname.includes('.') ? x.toString() : false; } catch (_) { return false; }
}
async function log(pool, ath, type, description, meta) {
  await pool.query(`INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type, description, metadata) VALUES ($1,$2,$3,$4,$5)`,
    [ath.id, ath.agentId, type, description, JSON.stringify(Object.assign({ via: 'update-link' }, meta || {}))]).catch((e) => console.warn('[athlete-link] log:', e.message));
}

// "I posted it". -> { ok } | { ok:false, error }
async function markPosted(pool, ath, eventId, proofUrl) {
  const url = safeUrl(proofUrl);
  if (url === false) return { ok: false, error: 'That link does not look right.' };
  const r = await pool.query(
    `UPDATE athlete_calendar_events SET status = 'completed', completed_at = NOW(), completed_by_role = 'athlete', completed_by_id = $3,
            proof_url = COALESCE($4, proof_url)
      WHERE id::text = $1 AND athlete_id = $3 AND agent_id = $2 RETURNING title, brand`, [String(eventId), ath.agentId, ath.id, url]);
  if (!r.rows.length) return { ok: false, error: 'That item is not on your list.' };
  await log(pool, ath, 'deliverable_completed', `Posted: ${r.rows[0].title}`, { event_id: String(eventId), brand: r.rows[0].brand, proof_url: url });
  return { ok: true };
}

async function addGift(pool, ath, b) {
  const GD = require('./giftedDeals');
  const url = safeUrl(b.postUrl);
  if (url === false) return { ok: false, error: 'That link does not look right.' };
  const r = await GD.add(pool, ath.agentId, { athleteId: ath.id, brand: b.brand, product: b.product, retailValue: b.retailValue, receivedOn: b.receivedOn || undefined,
    platform: b.platform || undefined, posted: b.posted, postUrl: url || undefined, notes: 'Logged by the athlete' });
  if (!r.ok) return r;
  await log(pool, ath, 'gift_logged', `Gift from ${r.gift.brand}${r.gift.product ? ': ' + r.gift.product : ''}`, { gift_id: r.gift.id });
  return r;
}

async function addDeal(pool, ath, b) {
  const brand = clean(b.brand, 120);
  if (brand.length < 2) return { ok: false, error: 'Enter the brand.' };
  const email = clean(b.contactEmail, 200).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'That email does not look right.' };
  const what = clean(b.what, 600);
  const offer = b.offer ? Number(String(b.offer).replace(/[$,\s]/g, '')) : null;
  if (b.offer && !(offer >= 0)) return { ok: false, error: 'Enter the offer in dollars, or leave it blank.' };
  const r = await pool.query(
    `INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, value, stage, description, contact_name, contact_email, source, notes)
     VALUES ($1,$2,$3,$4,'Prospecting',$5,$6,$7,'athlete',$8) RETURNING id`,
    [ath.id, ath.agentId, brand, offer, what || null, clean(b.contactName, 120) || null, email || null,
      'From ' + ath.name + ' through their update link' + (b.channel ? ' (reached out by ' + clean(b.channel, 40) + ')' : '')]);
  await log(pool, ath, 'deal_reported', `${brand} reached out${offer ? ' ($' + offer.toLocaleString('en-US') + ')' : ''}`, { deal_id: r.rows[0].id });
  return { ok: true, dealId: r.rows[0].id };
}

// ── THE PAGE ─────────────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])); }
function shell(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f6f4;color:#111827;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}.w{max-width:560px;margin:0 auto;padding:20px 16px 40px}
.c{background:#fff;border-radius:12px;padding:18px 16px;margin-top:14px}h1{font-size:20px;margin:0}h2{font-size:16px;margin:0 0 10px}.s{color:#6b7280;font-size:13px}
input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;margin-top:8px}button{margin-top:10px;background:#111827;color:#fff;border:0;border-radius:8px;padding:11px 16px;font:inherit;font-weight:600}
.it{border-top:1px solid #f3f4f6;padding:12px 0}.ok{background:#ecfdf5;color:#065f46;border-radius:8px;padding:10px 12px;margin-top:14px}.err{background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px 12px;margin-top:14px}</style></head>
<body><div class="w">${inner}</div></body></html>`;
}
function renderPage(ath, items, token, flash) {
  const first = String(ath.name).split(' ')[0];
  const dueHtml = items.length ? items.map((e) => {
    const d = new Date(e.event_date);
    const when = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const late = d.getTime() < Date.now() - 86400000;
    return `<div class="it"><div><b>${esc(e.title)}</b>${e.brand ? ' for ' + esc(e.brand) : ''}</div><div class="s"${late ? ' style="color:#b91c1c"' : ''}>${late ? 'Was due ' : 'Due '}${esc(when)}</div>
      <form method="post" action="/me/${esc(token)}/posted/${esc(e.id)}"><input name="proofUrl" placeholder="Link to your post (optional)"><button type="submit">I posted it</button></form></div>`;
  }).join('') : '<div class="s">Nothing due right now.</div>';
  return shell(`Your NIL updates`, `<h1>Hey ${esc(first)}</h1><div class="s">Your updates go straight to ${esc(ath.agentName)}. Save this link; it is just for you.</div>
${flash ? `<div class="${flash.ok ? 'ok' : 'err'}">${esc(flash.text)}</div>` : ''}
<div class="c"><h2>What's due</h2>${dueHtml}</div>
<div class="c"><h2>A brand sent me something</h2><div class="s">Free product to post counts. Log it so it is on your yearly report.</div>
<form method="post" action="/me/${esc(token)}/gift"><input name="brand" placeholder="Brand" required><input name="product" placeholder="What they sent"><input name="retailValue" inputmode="decimal" placeholder="About what it is worth ($)">
<select name="platform"><option value="">Where you posted it</option><option>instagram story</option><option>instagram post</option><option>tiktok</option><option>x</option><option>youtube</option><option>facebook</option><option>other</option><option>not posted yet</option></select>
<input name="postUrl" placeholder="Link to the post (optional)"><button type="submit">Log the gift</button></form></div>
<div class="c"><h2>A brand reached out</h2><div class="s">Tell ${esc(ath.agentName)} before you answer. Nothing here agrees to anything.</div>
<form method="post" action="/me/${esc(token)}/deal"><input name="brand" placeholder="Brand or business" required><input name="contactName" placeholder="Who reached out"><input name="contactEmail" type="email" placeholder="Their email, if you have it">
<select name="channel"><option value="">How they reached you</option><option>Instagram DM</option><option>TikTok DM</option><option>email</option><option>text</option><option>in person</option></select>
<input name="offer" inputmode="decimal" placeholder="What they offered ($), if they said"><textarea name="what" rows="3" placeholder="What they want you to do"></textarea><button type="submit">Send to ${esc(ath.agentName)}</button></form></div>`);
}

module.exports = { ensureColumns, linkFor, byToken, due, markPosted, addGift, addDeal, renderPage, shell, esc, urlFor };
