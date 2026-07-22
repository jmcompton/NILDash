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
  showOutreachModal();
  setModalState('loading', dealResult.brand);

  try {
    const { runId } = await outreachAPI.post('/run', { athleteId, dealScanResult: dealResult });
    OutreachEngineState.activeRunId = runId;
    startPolling(runId);
  } catch (e) {
    setModalState('error', e.message);
  }
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
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml(enrichment.industry || '—')}</div>
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml(enrichment.location || '—')}</div>
        <div style="font-size:11px;color:var(--muted,#888);text-transform:capitalize">${escHtml(enrichment.brand_size || '—')}</div>
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
          <select id="outreach-from-account" style="width:100%;margin-top:4px;padding:8px 10px;
                  background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:6px;
                  color:var(--text,#fff);font-size:12px;outline:none">
            <option value="">Loading accounts…</option>
          </select>
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

  // Public share URL, preferring a per-brand variant when one exists.
  const origin = window.location.origin;
  let variants = mk.variants;
  if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch (_) { variants = null; } }
  const brandSlug = _mkBrandSlug(brand);
  let url = origin + '/media-kit/' + mk.slug;
  let label = 'Attach media kit';
  if (brandSlug && variants && variants[brandSlug]) {
    url = origin + '/media-kit/' + mk.slug + '?for=' + encodeURIComponent(brandSlug);
    label = 'Attach media kit for ' + brand;
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

async function loadEmailAccountsIntoDropdown() {
  try {
    const r = await fetch('/api/email/accounts');
    if (!r.ok) return;
    const accounts = await r.json();
    const sel = document.getElementById('outreach-from-account');
    if (!sel) return;
    if (!accounts.length) {
      sel.innerHTML = '<option value="">No email accounts connected</option>';
      return;
    }
    sel.innerHTML = accounts.map(a =>
      `<option value="${a.id}">${a.email_address} (${a.provider})</option>`
    ).join('');
  } catch (e) { /* silent */ }
}

// ── User actions ──────────────────────────────────────────────────────────────

async function sendOutreach(outreachId) {
  if (!outreachId) { showOutreachToast('No outreach draft found', true); return; }

  const toEmail    = document.getElementById('outreach-to-email')?.value?.trim();
  const accountId  = document.getElementById('outreach-from-account')?.value;
  const subject    = document.getElementById('outreach-subject-input')?.value?.trim();
  const bodyText   = document.getElementById('outreach-body-input')?.value?.trim();

  if (!toEmail)   { showOutreachToast('Enter the recipient email address', true); return; }
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
};
