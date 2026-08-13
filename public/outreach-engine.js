// public/outreach-engine.js
// NIL Outreach Automation Engine — Deal Scan UI Integration
//
// Adds "Generate Outreach" button to each Deal Scan result card.
// Shows a full outreach preview modal with:
//   - enriched company info
//   - discovered contact
//   - match score
//   - generated email (editable)
//   - send button (uses connected mailbox)
//   - deck download
//
// Loaded by index.html after email.js.
// Uses window.outreachEngine namespace — zero collision with existing code.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const OutreachEngineState = {
  activeRunId:    null,
  pollInterval:   null,
  currentRunData: null,
  currentDealResult: null,
  athleteId:      null,
  // Which draft is on screen. connectGmail needs it to save the edits before it
  // navigates away, and sendOutreach already had it only as a closure argument.
  currentOutreachId: null,
};

// ── API ───────────────────────────────────────────────────────────────────────
const outreachAPI = {
  async post(path, body) {
    const r = await fetch('/api/outreach' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || r.statusText);
    }
    return r.json();
  },
  async get(path) {
    const r = await fetch('/api/outreach' + path);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || r.statusText);
    }
    return r.json();
  },
  async patch(path, body) {
    const r = await fetch('/api/outreach' + path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || r.statusText);
    }
    return r.json();
  },
};

// ── Entry point: called from Deal Scan card ────────────────────────────────────

/**
 * generateOutreach(athleteId, dealResult)
 * Called when user clicks "Generate Outreach" on a Deal Scan card.
 */
async function generateOutreach(athleteId, dealResultJson) {
  let dealResult;
  try {
    dealResult = typeof dealResultJson === 'string' ? JSON.parse(dealResultJson) : dealResultJson;
  } catch (e) {
    showOutreachToast('Invalid deal data', true);
    return;
  }

  OutreachEngineState.currentDealResult = dealResult;
  OutreachEngineState.athleteId = athleteId;
  OutreachEngineState.currentOutreachId = null;
  showOutreachModal();
  setModalState('loading', dealResult.brand);
  // Asked NOW, not when they reach the send button. If there is no mailbox the
  // agent should find out while the draft is being written, not after.
  checkMailboxForNotice();

  // ── The pre-warmed draft ───────────────────────────────────────────────────
  // Drafting now happens in the background when the SCAN finishes, so by the time
  // a card is opened the message usually already exists. Ask for it first; a hit
  // renders immediately with no model call and no wait.
  //
  // A miss is ordinary, not an error: the pre-warm may still be running, or its
  // draft may have failed the specificity check and been dropped rather than
  // stored. Either way this falls straight through to the old /run path, so the
  // box is never empty.
  try {
    const pre = await fetchPrewarmedDraft(athleteId, dealResult);
    if (pre) {
      renderPrewarmedDraft(pre, dealResult, athleteId);
      return;
    }
  } catch (e) {
    console.warn('[outreachEngine] prewarm lookup failed, generating on click:', e && e.message);
  }

  try {
    const { runId } = await outreachAPI.post('/run', {
      athleteId, dealScanResult: dealResult,
      // The contact ladder this card already resolved. Without it the workflow
      // re-runs the same 6-source fan-out the card expand already paid for.
      knownContacts: cardContacts(dealResult),
    });
    OutreachEngineState.activeRunId = runId;
    startPolling(runId);
  } catch (e) {
    setModalState('error', e.message);
  }
}

// What the card knows about how to reach this business, in the shape the server's
// resolver produces. Returns null when the card found nothing, so an empty card
// never suppresses the real lookup.
function cardContacts(d) {
  if (!d) return null;
  const contacts = (Array.isArray(d.contacts) ? d.contacts : []).map(function (c) {
    return {
      name: c.name || null, title: c.title || null, email: c.email || null,
      phone: c.phone || null, linkedinUrl: c.linkedinUrl || null, sourceUrl: c.sourceUrl || null,
    };
  });
  if (!contacts.length && !d.businessPhone) return null;
  return { contacts, businessPhone: d.businessPhone || null, genericInbox: d.genericInbox || null };
}

async function fetchPrewarmedDraft(athleteId, d) {
  const brandKey = d.brandKey || d.brand_key || '';
  const brand = d.brand || d.brand_name || '';
  if (!athleteId || (!brandKey && !brand)) return null;
  const qs = 'athleteId=' + encodeURIComponent(athleteId)
    + (brandKey ? '&brandKey=' + encodeURIComponent(brandKey) : '')
    + (brand ? '&brand=' + encodeURIComponent(brand) : '');
  const r = await fetch('/api/outreach/draft?' + qs, { credentials: 'include' });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const j = await r.json().catch(function () { return null; });
  return (j && j.body_html) ? j : null;
}

// Render a pre-warmed draft into the same modal the workflow renders into, reusing
// renderRunResult so there is ONE layout rather than two that drift apart. The
// pieces the workflow would have produced (enrichment, match score, deck) are
// absent by design: pre-warming deliberately skips them.
function renderPrewarmedDraft(pre, dealResult, athleteId) {
  OutreachEngineState.currentOutreachId = pre.id;
  OutreachEngineState.activeRunId = null;
  const contact = pickCardContact(dealResult);
  renderRunResult({
    run: { brand_name: pre.brand_name || dealResult.brand, athlete_id: athleteId, status: 'complete' },
    // Built from the CARD, not invented. category and region are what the scan
    // actually established; brand_size is genuinely unknown here and stays null so
    // it renders as a dash rather than a guess. Pre-warming skips the enrichment
    // step, so there is no researched record to show and none is implied.
    enrichment: {
      brand_name: pre.brand_name || dealResult.brand,
      industry: dealResult.category || null,
      location: dealResult.region || dealResult.market || null,
      brand_size: null,
      website: dealResult.website || null,
    },
    contact,
    matchScore: null,
    deck: null,
    outreach: { id: pre.id, subject: pre.subject, body_html: pre.body_html },
  });
  // GREETING PERSONALISATION. The draft was written contact-agnostic, because at
  // scan time the card has a phone and rarely a name. If a name HAS been found
  // since (the agent expanded the card and ran the ladder), swap the bare "Hi,"
  // for it here. Only the greeting, and only when the name is a real published
  // personal contact, so nothing else in the email is rewritten client-side.
  const named = contact && contact.name && resolvePersonalEmail(contact) ? contact.name : null;
  if (named) personalizeGreeting(named);
}

function pickCardContact(d) {
  const list = (d && Array.isArray(d.contacts)) ? d.contacts : [];
  const c = list[0];
  if (!c) return null;
  return {
    name: c.name || null, title: c.title || null, email: c.email || null,
    phone: c.phone || null, confidence_score: c.email ? 0.9 : 0.6,
  };
}

// Replace a bare "Hi," on the first line with "Hi <first name},". Deliberately
// narrow: it touches the greeting line only, never the body, and does nothing if
// the draft already greets someone.
function personalizeGreeting(fullName) {
  const ta = document.getElementById('outreach-body-input');
  if (!ta) return;
  const first = String(fullName).trim().split(/\s+/)[0];
  if (!first) return;
  const lines = String(ta.value || '').split('\n');
  if (!lines.length) return;
  if (!/^\s*hi\s*,?\s*$/i.test(lines[0])) return;
  lines[0] = 'Hi ' + first + ',';
  ta.value = lines.join('\n');
}

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling(runId) {
  if (OutreachEngineState.pollInterval) clearInterval(OutreachEngineState.pollInterval);

  OutreachEngineState.pollInterval = setInterval(async () => {
    try {
      const data = await outreachAPI.get('/runs/' + runId);
      const status = data.run?.status;

      if (status === 'complete') {
        clearInterval(OutreachEngineState.pollInterval);
        OutreachEngineState.pollInterval = null;
        OutreachEngineState.currentRunData = data;
        renderRunResult(data);
      } else if (status === 'failed') {
        clearInterval(OutreachEngineState.pollInterval);
        setModalState('error', data.run?.error_message || 'Workflow failed');
      } else {
        // Still running — update progress message
        const steps = data.run?.steps_completed;
        const completedSteps = Array.isArray(steps) ? steps : (typeof steps === 'string' ? JSON.parse(steps || '[]') : []);
        updateLoadingProgress(completedSteps);
      }
    } catch (e) {
      console.error('[outreachEngine] Poll error:', e.message);
    }
  }, 3000);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function showOutreachModal() {
  let modal = document.getElementById('outreach-engine-modal');
  if (!modal) {
    modal = buildModal();
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
}

function closeOutreachModal() {
  const modal = document.getElementById('outreach-engine-modal');
  if (modal) modal.style.display = 'none';
  if (OutreachEngineState.pollInterval) {
    clearInterval(OutreachEngineState.pollInterval);
    OutreachEngineState.pollInterval = null;
  }
  OutreachEngineState.activeRunId = null;
  OutreachEngineState.currentOutreachId = null;
  const notice = document.getElementById('outreach-mailbox-notice');
  if (notice) { notice.style.display = 'none'; notice.innerHTML = ''; }
  OutreachEngineState.currentRunData = null;
}

function buildModal() {
  const modal = document.createElement('div');
  modal.id = 'outreach-engine-modal';
  modal.style.cssText = `
    display:none;position:fixed;top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.75);z-index:9999;
    align-items:center;justify-content:center;padding:20px;
  `;
  modal.innerHTML = `
    <div style="background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);border-radius:12px;
                width:100%;max-width:780px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;
                  border-bottom:1px solid var(--border,#333);flex-shrink:0">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text,#fff)" id="outreach-modal-title">
            Generating Outreach…
          </div>
          <div style="font-size:11px;color:var(--muted,#888);margin-top:2px" id="outreach-modal-subtitle"></div>
        </div>
        <button onclick="window.outreachEngine.close()"
                style="background:none;border:none;color:var(--muted,#888);font-size:22px;cursor:pointer;line-height:1">×</button>
      </div>
      <!-- Above the body on purpose: setModalState and renderRunResult both replace
           the body wholesale, and this has to stay visible through generation so the
           agent learns they cannot send BEFORE they have a draft to send. -->
      <div id="outreach-mailbox-notice" style="display:none;flex-shrink:0"></div>
      <div id="outreach-modal-body" style="flex:1;overflow-y:auto;padding:20px"></div>
    </div>
  `;
  return modal;
}

function setModalState(state, message) {
  const title    = document.getElementById('outreach-modal-title');
  const subtitle = document.getElementById('outreach-modal-subtitle');
  const body     = document.getElementById('outreach-modal-body');
  if (!body) return;

  if (state === 'loading') {
    if (title) title.textContent = `Building Outreach for ${message}`;
    if (subtitle) subtitle.textContent = 'Running AI enrichment, contact discovery, and pitch generation…';
    body.innerHTML = `
      <div style="padding:40px;text-align:center">
        <div style="width:40px;height:40px;border:3px solid var(--border,#333);
                    border-top-color:var(--accent,#84CC16);border-radius:50%;
                    animation:spin 0.8s linear infinite;margin:0 auto 20px"></div>
        <div style="color:var(--text,#fff);font-size:14px;font-weight:600;margin-bottom:8px">
          AI is working on this…
        </div>
        <div id="outreach-progress-steps" style="color:var(--muted,#888);font-size:12px;line-height:2">
          Starting enrichment pipeline…
        </div>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
  } else if (state === 'error') {
    if (title) title.textContent = 'Outreach Generation Failed';
    body.innerHTML = `
      <div style="padding:40px;text-align:center">
        <div style="font-size:32px;margin-bottom:12px">⚠️</div>
        <div style="color:#f87171;font-size:14px;margin-bottom:16px">${escHtml(message)}</div>
        <button onclick="window.outreachEngine.close()"
                style="padding:8px 20px;background:var(--surface2,#222);border:1px solid var(--border,#333);
                       border-radius:8px;color:var(--text,#fff);cursor:pointer;font-size:13px">
          Close
        </button>
      </div>
    `;
  }
}

function updateLoadingProgress(completedSteps) {
  const el = document.getElementById('outreach-progress-steps');
  if (!el) return;
  const stepLabels = {
    enrichment:        '✅ Company enrichment complete',
    contact_discovery: '✅ Decision makers identified',
    brand_match:       '✅ Athlete-brand match analyzed',
    pitch_generation:  '✅ Custom pitch generated',
    deck_generation:   '✅ Pitch deck created',
    email_draft:       '✅ Email drafted',
    crm_update:        '✅ CRM updated',
  };
  const allSteps = ['enrichment','contact_discovery','brand_match','pitch_generation','deck_generation','email_draft','crm_update'];
  el.innerHTML = allSteps.map(s => {
    if (completedSteps.includes(s)) return `<div>${stepLabels[s]}</div>`;
    if (completedSteps.length > 0 && s === allSteps[completedSteps.length]) {
      return `<div style="color:var(--accent,#84CC16)">⟳ Running ${s.replace(/_/g,' ')}…</div>`;
    }
    return `<div style="color:var(--muted,#555)">○ ${s.replace(/_/g,' ')}</div>`;
  }).join('');
}

// ── Result rendering ──────────────────────────────────────────────────────────

function renderRunResult(data) {
  const title    = document.getElementById('outreach-modal-title');
  const subtitle = document.getElementById('outreach-modal-subtitle');
  const body     = document.getElementById('outreach-modal-body');
  if (!body) return;

  const { run, enrichment, contact, matchScore, deck, outreach } = data;
  const brand = run.brand_name;

  if (title) title.textContent = `Outreach Ready — ${brand}`;
  if (subtitle) subtitle.textContent = `Review and send your personalized pitch`;

  // Parse score
  const score = matchScore?.compatibility_score || 0;
  const scoreColor = score >= 75 ? '#84CC16' : score >= 55 ? '#f59e0b' : '#f87171';

  // Parse outreach body for editing
  const currentSubject = outreach?.subject || `NIL Partnership — ${brand}`;
  const currentBody    = htmlToEditableText(outreach?.body_html || '');
  const outreachId     = outreach?.id;
  OutreachEngineState.currentOutreachId = outreachId || null;

  // Contact info — one shared truth with Deal Scan. A named person is only
  // greeted/emailed by name when they carry a published PERSONAL email; a
  // generic inbox is never attached to a person and never auto-prefilled.
  const rawEmail     = contact?.email || null;
  const emailGeneric = _isGenericInboxFE(rawEmail);
  const hasName      = !!(contact?.name && contact.name.trim());
  const contactName  = hasName ? contact.name.trim() : (rawEmail && emailGeneric ? 'General inbox' : 'No named contact found');
  const contactTitle = contact?.title || (hasName ? 'Contact' : 'No verified decision maker');
  const contactPhone = contact?.phone || null;
  // A "personal" email = a real named person's published address, not a generic
  // inbox. resolvePersonalEmail is the one shared rule (also used by the
  // dashboard "Draft follow-up" composer) so both resolve the recipient the same.
  const personalEmail = resolvePersonalEmail(contact);
  const confidence   = contact ? Math.round((contact.confidence_score || 0) * 100) : 0;
  // Rule 5: only prefill To with a trustworthy personal email (confidence >= 60).
  // A generic inbox or a low-confidence contact never auto-populates the recipient.
  const prefillTo    = (personalEmail && confidence >= 60) ? personalEmail : '';
  // Rule 6: when there is a phone and no personal email, calling is the primary move.
  const phoneFirst   = !!(contactPhone && !prefillTo);

  // Deck
  const hasDeck   = !!(deck?.id);
  const deckLabel = hasDeck ? `Download Deck (v${deck.version})` : 'Deck unavailable';

  // Campaign ideas
  let campaignIdeas = [];
  try { campaignIdeas = JSON.parse(matchScore?.campaign_ideas || '[]'); } catch {}

  body.innerHTML = `
    <!-- Why This Fits — Pitch Angles (hero) -->
    ${campaignIdeas.length ? `
    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Why This Fits — Pitch Angles</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${campaignIdeas.slice(0,3).map(idea => `
          <span style="font-size:11px;padding:4px 10px;background:rgba(132,204,22,0.1);
                       border:1px solid rgba(132,204,22,0.3);border-radius:20px;color:var(--accent,#84CC16)">
            ${escHtml(typeof idea === 'string' ? idea : (idea.description || JSON.stringify(idea)))}
          </span>`).join('')}
      </div>
    </div>` : ''}

    <!-- Contact banner -->
    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div style="flex:3;background:var(--surface2,#222);border:1px solid var(--border,#333);
                  border-radius:8px;padding:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          How To Reach Them
        </div>
        <div style="font-size:13px;font-weight:600;color:var(--text,#fff)">${escHtml(contactName)}</div>
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml(contactTitle)}</div>
        ${personalEmail ? `<div style="font-size:11px;color:var(--accent,#84CC16);margin-top:2px">${escHtml(personalEmail)}</div>` : ''}
        ${contactPhone ? `<div style="font-size:11px;color:var(--text,#fff);margin-top:2px">📞 <a href="tel:${escHtml(contactPhone.replace(/[^0-9+]/g,''))}" style="color:var(--accent,#84CC16);text-decoration:none">${escHtml(contactPhone)}</a></div>` : ''}
        ${(!personalEmail && emailGeneric && rawEmail) ? `<div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${escHtml(rawEmail)} <span style="color:var(--muted,#555)">(general inbox, not a person)</span></div>` : ''}
      </div>
      ${enrichment ? `
      <div style="flex:2;background:var(--surface2,#222);border:1px solid var(--border,#333);
                  border-radius:8px;padding:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          Company
        </div>
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml((enrichment && enrichment.industry) || '—')}</div>
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml((enrichment && enrichment.location) || '—')}</div>
        <div style="font-size:11px;color:var(--muted,#888);text-transform:capitalize">${escHtml((enrichment && enrichment.brand_size) || '—')}</div>
      </div>` : ''}
    </div>

    <!-- Email editor -->
    <div style="background:var(--surface2,#222);border:1px solid var(--border,#333);border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">
        Email Draft — Edit Before Sending
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:10px;color:var(--muted,#888);text-transform:uppercase">Subject</label>
        <input id="outreach-subject-input" value="${escHtml(currentSubject)}"
               style="width:100%;margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                      border:1px solid var(--border,#333);border-radius:6px;
                      color:var(--text,#fff);font-size:12px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:10px;color:var(--muted,#888);text-transform:uppercase">Email Body</label>
        <textarea id="outreach-body-input" rows="10"
                  style="width:100%;margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                         border:1px solid var(--border,#333);border-radius:6px;
                         color:var(--text,#fff);font-size:12px;outline:none;
                         resize:vertical;line-height:1.6;box-sizing:border-box;font-family:Arial,sans-serif"
        >${escHtml(currentBody)}</textarea>
      </div>
      <div id="outreach-mk-row" style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button id="outreach-mk-btn" type="button" disabled
                style="padding:7px 14px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--muted,#888);font-size:12px;cursor:not-allowed;opacity:0.6">
          Attach media kit
        </button>
        <span id="outreach-mk-hint" style="font-size:10px;color:var(--muted,#888)">Checking for a saved media kit…</span>
      </div>
    </div>

    <!-- Instagram DM -->
    <div style="background:var(--surface2,#222);border:1px solid var(--border,#333);border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Instagram DM</div>
      <div style="font-size:10px;color:var(--muted,#888);margin-bottom:10px;line-height:1.4">Local shops answer DMs faster than email. Copy this, then open their Instagram and paste it.</div>
      <textarea id="outreach-ig-dm" rows="4" style="width:100%;padding:8px 10px;background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:12px;outline:none;resize:vertical;line-height:1.5;box-sizing:border-box;font-family:Arial,sans-serif"></textarea>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button type="button" id="outreach-ig-copy" style="padding:8px 16px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:12px;cursor:pointer">Copy DM</button>
        <a id="outreach-ig-open" href="#" target="_blank" style="padding:8px 16px;background:var(--accent,#84CC16);border-radius:6px;color:#000;font-size:12px;font-weight:700;text-decoration:none;display:inline-block">Open Instagram</a>
        <span id="outreach-ig-status" style="font-size:10px;color:var(--muted,#888)"></span>
      </div>
    </div>

    <!-- Send controls -->
    <div style="background:var(--surface2,#222);border:1px solid var(--border,#333);border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">
        Send Settings
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <div style="flex:1;min-width:180px">
          <label style="font-size:10px;color:var(--muted,#888);text-transform:uppercase">From Account</label>
          <!-- Filled by loadEmailAccountsIntoDropdown with ONE of three things: the
               account picker, a Connect Gmail button, or an error with a retry. It
               used to always be a select, which is how "No email accounts connected"
               ended up as an unselectable option that the send button then told you
               to select. -->
          <div id="outreach-from-slot">
            <select id="outreach-from-account" style="width:100%;margin-top:4px;padding:8px 10px;
                    background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:6px;
                    color:var(--text,#fff);font-size:12px;outline:none">
              <option value="">Loading accounts…</option>
            </select>
          </div>
        </div>
        <div style="flex:1;min-width:180px">
          <label style="font-size:10px;color:var(--muted,#888);text-transform:uppercase">To (Contact Email)</label>
          <input id="outreach-to-email" value="${escHtml(prefillTo)}"
                 placeholder="${prefillTo ? '' : 'Add a verified recipient before sending'}"
                 style="width:100%;margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                        border:1px solid var(--border,#333);border-radius:6px;
                        color:var(--text,#fff);font-size:12px;outline:none;box-sizing:border-box">
          ${!prefillTo ? `<div style="font-size:10px;color:var(--muted,#888);margin-top:4px;line-height:1.4">Add the recipient once you confirm who to reach — the name and phone above are your starting point.</div>` : ''}
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      ${phoneFirst ? `
      <a href="tel:${escHtml(contactPhone.replace(/[^0-9+]/g,''))}"
         style="padding:10px 24px;background:var(--accent,#84CC16);border:none;border-radius:8px;
                color:#000;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;
                text-decoration:none;display:inline-block">
        📞 Call ${hasName ? escHtml(contactName.split(' ')[0]) : 'the business'} at ${escHtml(contactPhone)}
      </a>` : ''}
      <button id="outreach-send-btn" onclick="window.outreachEngine.sendOutreach('${outreachId}')"
              style="padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;
                     ${phoneFirst
                       ? 'background:transparent;border:1px solid var(--border,#333);color:var(--text,#fff)'
                       : 'background:var(--accent,#84CC16);border:none;color:#000'}">
        ${phoneFirst ? 'Send Email Draft' : 'Send Email →'}
      </button>
      <button onclick="window.outreachEngine.saveDraft('${outreachId}')"
              style="padding:10px 18px;background:transparent;border:1px solid var(--border,#333);
                     border-radius:8px;color:var(--muted,#888);font-size:12px;cursor:pointer">
        Save Edits
      </button>
      ${hasDeck ? `
      <a href="/api/outreach/decks/${deck.id}/download" target="_blank"
         style="padding:10px 18px;background:transparent;border:1px solid var(--border,#333);
                border-radius:8px;color:var(--muted,#888);font-size:12px;cursor:pointer;
                text-decoration:none;display:inline-block">
        📎 ${deckLabel}
      </a>` : ''}
      <button onclick="window.outreachEngine.close()"
              style="padding:10px 18px;background:transparent;border:1px solid var(--border,#333);
                     border-radius:8px;color:var(--muted,#888);font-size:12px;cursor:pointer;margin-left:auto">
        Close
      </button>
    </div>
    <div id="outreach-send-status" style="margin-top:12px;font-size:12px;color:var(--muted,#888)"></div>
  `;

    // Instagram DM: build a paste-ready DM and wire the open/copy buttons.
    (function setupInstagramDM() {
      const ta = document.getElementById('outreach-ig-dm');
      const openLink = document.getElementById('outreach-ig-open');
      const copyBtn = document.getElementById('outreach-ig-copy');
      const statusEl = document.getElementById('outreach-ig-status');
      if (!ta || !openLink) return;
      const athleteName = ((currentSubject || '').split(/\s+[x×]\s+/)[0] || '').trim() || 'my athlete';
      const idea = (campaignIdeas && campaignIdeas[0]) ? (typeof campaignIdeas[0] === 'string' ? campaignIdeas[0] : (campaignIdeas[0].description || '')) : '';
      ta.value = `Hi! I work on the NIL side with ${athleteName}, a college athlete here in your area. I had an idea for a quick partnership with ${brand}${idea ? ' — ' + String(idea).charAt(0).toLowerCase() + String(idea).slice(1) : ''}. Would love to share a short overview if you're open to it!`;
      // Fallback link: Instagram/Google search for the business. Swapped for a
      // direct profile link once we resolve the handle.
      const loc = (enrichment && enrichment.location) ? ' ' + enrichment.location : '';
      openLink.href = 'https://www.google.com/search?q=' + encodeURIComponent('instagram ' + brand + loc);
      copyBtn.onclick = function () {
        ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        if (navigator.clipboard) { navigator.clipboard.writeText(ta.value).catch(function(){}); }
        if (statusEl) { statusEl.textContent = 'Copied'; setTimeout(function(){ statusEl.textContent = ''; }, 1500); }
        // Soft retire: opening AI Outreach and copying the DM is an intent to reach
        // out, so mark the brand contacted (undoable) through the Deal Scan ledger.
        if (window._dsOnBrandContacted) window._dsOnBrandContacted(OutreachEngineState.currentDealResult, 'ai_outreach_copy', true);
      };
      // Try to resolve the exact handle from the business website for a direct link.
      const site = enrichment && enrichment.website;
      if (site) {
        fetch('/api/agent/brand-instagram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ website: site }) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.handle) {
              openLink.href = 'https://www.instagram.com/' + d.handle;
              openLink.textContent = 'Open @' + d.handle;
            }
          }).catch(function () {});
      }
    })();

  // Load email accounts into the dropdown
  loadEmailAccountsIntoDropdown();
  // Set up the "Attach media kit" button for this athlete + brand.
  loadMediaKitAttach(OutreachEngineState.athleteId || (run && run.athlete_id) || null, brand);
}

// ── Attach media kit ────────────────────────────────────────────────────────────
// Attaches the athlete's pre-built media kit share link to the email body. Prefers
// the public share URL (a live, tracked link that fires kit-view tracking when the
// brand opens it) and a per-brand variant link when one exists. Disabled with a
// build shortcut when the athlete has no saved kit. Toggle on/off; never forced.
function _mkBrandSlug(brand) {
  return String(brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
function _mkDisable(btn, hint, tooltip, hintHtml) {
  if (!btn) return;
  btn.disabled = true; btn.style.cursor = 'not-allowed'; btn.style.opacity = '0.5';
  btn.title = tooltip || '';
  if (hint && hintHtml != null) hint.innerHTML = hintHtml;
}
async function loadMediaKitAttach(athleteId, brand) {
  const btn = document.getElementById('outreach-mk-btn');
  const hint = document.getElementById('outreach-mk-hint');
  if (!btn) return;
  if (!athleteId) { _mkDisable(btn, hint, 'No athlete linked to this outreach.', 'No athlete linked to this outreach.'); return; }
  let mk = null;
  try {
    const r = await fetch('/api/agent/athlete-media-kit/' + encodeURIComponent(athleteId));
    if (r.ok) { const d = await r.json(); mk = d && d.mediaKit; }
  } catch (e) { /* fall through to the disabled state */ }

  if (!mk || !mk.slug) {
    _mkDisable(btn, hint, 'Build a media kit for this athlete first',
      'No media kit yet. <a href="#" id="outreach-mk-build" style="color:var(--accent,#84CC16);text-decoration:underline">Build one</a>');
    const build = document.getElementById('outreach-mk-build');
    if (build) build.onclick = function (e) {
      e.preventDefault();
      if (window.outreachEngine) window.outreachEngine.close();
      if (typeof window.showView === 'function') window.showView('marketing');
    };
    return;
  }

  // Public share URL. ALWAYS carries ?for=<brandSlug> so the open is
  // attributable to this brand. A generated variant adds personalization on top,
  // but tracking no longer depends on one existing.
  const origin = window.location.origin;
  let variants = mk.variants;
  if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch (_) { variants = null; } }
  const brandSlug = _mkBrandSlug(brand);
  let url = origin + '/media-kit/' + mk.slug;
  let label = 'Attach media kit';
  if (brandSlug) {
    url = origin + '/media-kit/' + mk.slug + '?for=' + encodeURIComponent(brandSlug);
    if (variants && variants[brandSlug]) label = 'Attach media kit for ' + brand;
  }
  btn.disabled = false; btn.style.cursor = 'pointer'; btn.style.opacity = '1'; btn.title = '';
  btn.dataset.url = url; btn.dataset.label = label; btn.dataset.attached = '0';
  btn.textContent = label;
  if (hint) hint.textContent = 'Live tracked link, so you see when the brand opens it.';
  btn.onclick = function () { toggleMediaKitAttach(btn, hint); };
}
function toggleMediaKitAttach(btn, hint) {
  const ta = document.getElementById('outreach-body-input');
  if (!ta || !btn.dataset.url) return;
  const line = 'Media kit: ' + btn.dataset.url;
  const attached = btn.dataset.attached === '1';
  if (!attached) {
    ta.value = ta.value.replace(/\s+$/, '') + '\n\n' + line + '\n';
    btn.dataset.attached = '1';
    btn.textContent = 'Remove media kit';
    btn.style.background = 'rgba(132,204,22,0.12)';
    btn.style.borderColor = 'var(--accent,#84CC16)';
    btn.style.color = 'var(--accent,#84CC16)';
    if (hint) hint.textContent = 'Media kit link added to the email.';
  } else {
    ta.value = ta.value.split('\n').filter(function (l) { return l.trim() !== line; }).join('\n')
      .replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    btn.dataset.attached = '0';
    btn.textContent = btn.dataset.label || 'Attach media kit';
    btn.style.background = 'transparent';
    btn.style.borderColor = 'var(--border,#333)';
    btn.style.color = 'var(--muted,#888)';
    if (hint) hint.textContent = 'Live tracked link, so you see when the brand opens it.';
  }
}

const FROM_SELECT_CSS = `width:100%;margin-top:4px;padding:8px 10px;
  background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:6px;
  color:var(--text,#fff);font-size:12px;outline:none`;

// Three outcomes, three different things in the From slot. The old version had one
// failure mode for both of the bad cases and it was the same as the good case: a
// select you could not usefully select from.
//
//   accounts        the picker
//   zero accounts   a Connect Gmail button, right where the picker was
//   request failed  the error and a Retry, NOT a dropdown stuck on "Loading…"
async function loadEmailAccountsIntoDropdown() {
  const slot = document.getElementById('outreach-from-slot');
  if (!slot) return;
  let accounts;
  try {
    const r = await fetch('/api/email/accounts');
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      renderFromSlotError(slot, e.error || ('Error ' + r.status));
      updateMailboxNotice(null);
      return;
    }
    accounts = await r.json();
  } catch (e) {
    // A network failure is the SAME user-visible situation as a 500: they cannot
    // tell whether they have a mailbox. Both must say so rather than sit silent.
    renderFromSlotError(slot, (e && e.message) ? e.message : 'Could not reach the server');
    updateMailboxNotice(null);
    return;
  }

  if (!Array.isArray(accounts) || !accounts.length) {
    renderFromSlotConnect(slot);
    updateMailboxNotice(false);
    return;
  }
  slot.innerHTML = '<select id="outreach-from-account" style="' + FROM_SELECT_CSS + '">'
    + accounts.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.email_address)} (${escHtml(a.provider)})</option>`).join('')
    + '</select>';
  updateMailboxNotice(true);
}

function renderFromSlotConnect(slot) {
  slot.innerHTML = `
    <button type="button" id="outreach-connect-gmail" onclick="window.outreachEngine.connectGmail()"
            style="width:100%;margin-top:4px;padding:8px 10px;background:var(--accent,#84CC16);
                   border:1px solid var(--accent,#84CC16);border-radius:6px;color:#0b0f0a;
                   font-size:12px;font-weight:700;cursor:pointer;min-height:36px">
      Connect Gmail
    </button>
    <div style="font-size:10px;color:var(--muted,#888);margin-top:4px;line-height:1.5">
      Your draft is saved. You will come straight back here.
    </div>`;
}

function renderFromSlotError(slot, msg) {
  slot.innerHTML = `
    <div style="margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                border:1px solid #f87171;border-radius:6px">
      <div style="font-size:11px;color:#f87171;line-height:1.5">Could not load your accounts: ${escHtml(msg)}</div>
      <button type="button" onclick="window.outreachEngine.reloadAccounts()"
              style="margin-top:6px;padding:4px 10px;background:var(--surface2,#222);
                     border:1px solid var(--border,#333);border-radius:5px;color:var(--text,#fff);
                     font-size:11px;cursor:pointer;min-height:28px">Retry</button>
    </div>`;
}

// ── The notice, shown BEFORE the draft exists ────────────────────────────────
// Lives in the modal shell above the body, so it survives setModalState and
// renderRunResult replacing the body, and it is on screen during generation rather
// than only once there is a finished draft to be disappointed about.
//   connected === false  no mailbox: say so now
//   connected === true   nothing to say
//   connected === null   unknown (the accounts request failed): say THAT, not "no"
function updateMailboxNotice(connected) {
  const el = document.getElementById('outreach-mailbox-notice');
  if (!el) return;
  if (connected === true) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  if (connected === null) {
    el.innerHTML = `
      <div style="padding:10px 20px;background:rgba(251,191,36,0.10);border-bottom:1px solid rgba(251,191,36,0.35);
                  font-size:12px;color:#fbbf24;line-height:1.5">
        Could not check whether you have a mailbox connected, so this draft may not be sendable.
      </div>`;
    return;
  }
  el.innerHTML = `
    <div style="padding:10px 20px;background:rgba(248,113,113,0.10);border-bottom:1px solid rgba(248,113,113,0.35);
                display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:220px;font-size:12px;color:#f87171;line-height:1.5">
        No mailbox connected, so this draft cannot be sent yet. Connect Gmail now and you will not lose it.
      </div>
      <button type="button" onclick="window.outreachEngine.connectGmail()"
              style="padding:6px 14px;background:var(--accent,#84CC16);border:1px solid var(--accent,#84CC16);
                     border-radius:6px;color:#0b0f0a;font-size:12px;font-weight:700;cursor:pointer;min-height:32px">
        Connect Gmail
      </button>
    </div>`;
}

// Checked as soon as the modal opens, so the answer is on screen while the pipeline
// runs rather than after it. Cheap: one GET that the send panel needs anyway.
async function checkMailboxForNotice() {
  try {
    const r = await fetch('/api/email/accounts');
    if (!r.ok) { updateMailboxNotice(null); return; }
    const accounts = await r.json();
    updateMailboxNotice(Array.isArray(accounts) && accounts.length > 0);
  } catch (e) { updateMailboxNotice(null); }
}

// ── Connect, and come back to the same draft ─────────────────────────────────
const OUTREACH_RESUME_KEY = 'nildash.outreachResume';
const OUTREACH_RESUME_TTL_MS = 30 * 60 * 1000;

// Saves whatever is on screen FIRST, then leaves. The draft body lives in
// outreach_logs server-side, so the save is what makes "you will not lose it" true;
// the sessionStorage marker only says which run to reopen and carries the fields
// that are not persisted (the To box, and the deal result the send path needs to
// retire the brand afterwards).
async function connectGmail() {
  const outreachId = OutreachEngineState.currentOutreachId;
  const subject  = document.getElementById('outreach-subject-input')?.value?.trim();
  const bodyText = document.getElementById('outreach-body-input')?.value?.trim();
  const toEmail  = document.getElementById('outreach-to-email')?.value?.trim() || '';

  if (outreachId && (subject || bodyText)) {
    try {
      await outreachAPI.patch('/logs/' + outreachId, { subject, body_html: editableTextToHtml(bodyText || '') });
    } catch (e) {
      // Saving failed, so leaving would lose the edits. Stay put and say so.
      showOutreachToast('Could not save your draft, so we did not leave the page: ' + e.message, true);
      return;
    }
  }

  try {
    sessionStorage.setItem(OUTREACH_RESUME_KEY, JSON.stringify({
      runId: OutreachEngineState.activeRunId,
      athleteId: OutreachEngineState.athleteId,
      dealResult: OutreachEngineState.currentDealResult,
      toEmail,
      at: Date.now(),
    }));
  } catch (e) { /* private mode: the draft is still saved server-side */ }

  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  window.location.href = '/api/email/oauth/gmail?returnTo=' + encodeURIComponent(returnTo);
}

// On load after the round trip: reopen the modal on the same run. The draft comes
// back from the SERVER, not from the browser, so it is the saved copy rather than a
// hopeful reconstruction.
async function resumeOutreachAfterConnect() {
  let raw = null;
  try { raw = sessionStorage.getItem(OUTREACH_RESUME_KEY); } catch (e) { return; }
  if (!raw) return;
  try { sessionStorage.removeItem(OUTREACH_RESUME_KEY); } catch (e) { /* ignore */ }

  let saved;
  try { saved = JSON.parse(raw); } catch (e) { return; }
  if (!saved || !saved.runId) return;
  // Stale markers are dropped rather than yanking someone back into a modal they
  // left behind an hour ago.
  if (!saved.at || (Date.now() - saved.at) > OUTREACH_RESUME_TTL_MS) return;

  OutreachEngineState.athleteId = saved.athleteId || null;
  OutreachEngineState.currentDealResult = saved.dealResult || null;
  OutreachEngineState.activeRunId = saved.runId;

  showOutreachModal();
  setModalState('loading', (saved.dealResult && saved.dealResult.brand) || 'your draft');
  try {
    const data = await outreachAPI.get('/runs/' + saved.runId);
    OutreachEngineState.currentRunData = data;
    renderRunResult(data);
    if (saved.toEmail) {
      const to = document.getElementById('outreach-to-email');
      if (to && !to.value) to.value = saved.toEmail;
    }
    showOutreachToast('Gmail connected. Your draft is where you left it.');
  } catch (e) {
    setModalState('error', 'Could not reopen your draft: ' + e.message);
  }
}

// ── User actions ──────────────────────────────────────────────────────────────

async function sendOutreach(outreachId) {
  if (!outreachId) { showOutreachToast('No outreach draft found', true); return; }

  const toEmail    = document.getElementById('outreach-to-email')?.value?.trim();
  const sel        = document.getElementById('outreach-from-account');
  const accountId  = sel ? sel.value : '';
  const subject    = document.getElementById('outreach-subject-input')?.value?.trim();
  const bodyText   = document.getElementById('outreach-body-input')?.value?.trim();

  if (!toEmail)   { showOutreachToast('Enter the recipient email address', true); return; }
  // The old message said "Select a From account" while the slot showed "No email
  // accounts connected". There was nothing to select. Now the absence of the select
  // means the slot is showing a Connect button or an error, and the message says
  // which rather than asking for something impossible.
  if (!sel) {
    const connectBtn = document.getElementById('outreach-connect-gmail');
    showOutreachToast(connectBtn
      ? 'Connect Gmail first. Your draft is saved and you will come back to it.'
      : 'Your email accounts could not be loaded. Use Retry above the Send button.', true);
    return;
  }
  if (!accountId) { showOutreachToast('Select a From account', true); return; }

  const btn = document.getElementById('outreach-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    // Save any edits first
    if (subject || bodyText) {
      const bodyHtml = editableTextToHtml(bodyText || '');
      await outreachAPI.patch('/logs/' + outreachId, { subject, body_html: bodyHtml });
    }

    await outreachAPI.post('/logs/' + outreachId + '/send', { emailAccountId: accountId, toEmail });

    // Hard retire: an email actually sent through the platform is the strongest
    // contacted signal. No undo. Retire the brand through the Deal Scan ledger.
    if (window._dsOnBrandContacted) window._dsOnBrandContacted(OutreachEngineState.currentDealResult, 'email_sent', false);

    const status = document.getElementById('outreach-send-status');
    if (status) {
      status.style.color = '#84CC16';
      status.textContent = `✅ Email sent to ${toEmail} — CRM updated automatically`;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sent ✓'; btn.style.background = '#4ade80'; }
    showOutreachToast(`Email sent to ${toEmail}`);
  } catch (e) {
    const status = document.getElementById('outreach-send-status');
    if (status) { status.style.color = '#f87171'; status.textContent = '❌ Send failed: ' + e.message; }
    if (btn) { btn.disabled = false; btn.textContent = 'Send Email →'; }
    showOutreachToast('Send failed: ' + e.message, true);
  }
}

async function saveDraft(outreachId) {
  const subject  = document.getElementById('outreach-subject-input')?.value?.trim();
  const bodyText = document.getElementById('outreach-body-input')?.value?.trim();
  const status   = document.getElementById('outreach-send-status');

  if (!outreachId) {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Could not save: missing draft id'; }
    return;
  }
  if (!subject && !bodyText) return;

  try {
    const bodyHtml = editableTextToHtml(bodyText || '');
    await outreachAPI.patch('/logs/' + outreachId, { subject, body_html: bodyHtml });
    if (status) { status.style.color = '#84CC16'; status.textContent = 'Edits saved ✓'; }
    showOutreachToast('Draft saved');
  } catch (e) {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Save failed: ' + e.message; }
    showOutreachToast('Save failed: ' + e.message, true);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert server-rendered email HTML into clean editable plain text (keeps paragraph breaks)
function htmlToEditableText(html) {
  return (html || '')
    .replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Convert editable plain text back into Gmail-safe HTML with real paragraph spacing
function editableTextToHtml(text) {
  const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const htmlLines = lines
    .map(line => line.trim() === '' ? '<div><br></div>' : `<div>${esc(line)}</div>`)
    .join('');
  return `<div style="${FONT};font-size:15px;line-height:1.6;color:#222222;max-width:560px">${htmlLines}</div>`;
}

function showOutreachToast(msg, isError) {
  if (typeof showToast === 'function') { showToast(msg); return; }
  console.log('[outreachEngine]', isError ? 'ERROR:' : '', msg);
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Mirror of the shared generic-inbox rule in server/ai.js. A generic mailbox
// (info@, contact@, sales@, partnerships@, ...) is never a named person's
// address, so it must never be greeted by name or auto-prefilled as the recipient.
function _isGenericInboxFE(email) {
  return typeof email === 'string' && /^(info|contact|hello|hi|sales|support|admin|team|marketing|press|media|partnerships?|pr|office|general|inquiries|enquiries|service)@/i.test(email.trim());
}

// The one shared recipient rule. Returns a named person's published, non-generic
// email, or null. A generic inbox (info@, sales@, ...) or an unnamed contact
// never becomes an auto-prefilled recipient. Reused by the dashboard
// "Draft follow-up" composer so both surfaces resolve the recipient identically.
function resolvePersonalEmail(contact) {
  var rawEmail = contact && contact.email ? String(contact.email).trim() : '';
  if (!rawEmail || _isGenericInboxFE(rawEmail)) return null;
  var hasName = !!(contact && contact.name && String(contact.name).trim());
  return hasName ? rawEmail : null;
}

// ── Export ────────────────────────────────────────────────────────────────────

window.outreachEngine = {
  generate:     generateOutreach,
  close:        closeOutreachModal,
  sendOutreach,
  saveDraft,
  resolvePersonalEmail,
  connectGmail,
  reloadAccounts: loadEmailAccountsIntoDropdown,
  resumeAfterConnect: resumeOutreachAfterConnect,
};

// Runs on every load. Does nothing unless a connect was started from this modal
// within the last half hour, and clears the marker either way so a stale one cannot
// reopen the modal on some unrelated visit.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resumeOutreachAfterConnect);
  } else {
    resumeOutreachAfterConnect();
  }
}
