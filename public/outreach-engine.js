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
  const currentBody    = (outreach?.body_html || '').replace(/<[^>]+>/g, '').trim();
  const outreachId     = outreach?.id;

  // Contact info
  const contactName  = contact?.name  || 'Partnerships Team';
  const contactTitle = contact?.title || 'Brand Partnerships';
  const contactEmail = contact?.email || null;
  const confidence   = contact ? Math.round((contact.confidence_score || 0) * 100) : 0;

  // Deck
  const hasDeck   = !!(deck?.id);
  const deckLabel = hasDeck ? `Download Deck (v${deck.version})` : 'Deck unavailable';

  // Campaign ideas
  let campaignIdeas = [];
  try { campaignIdeas = JSON.parse(matchScore?.campaign_ideas || '[]'); } catch {}

  body.innerHTML = `
    <!-- Match score banner -->
    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:120px;background:var(--surface2,#222);border:1px solid var(--border,#333);
                  border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:${scoreColor}">${score}%</div>
        <div style="font-size:10px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-top:2px">Match Score</div>
      </div>
      <div style="flex:3;background:var(--surface2,#222);border:1px solid var(--border,#333);
                  border-radius:8px;padding:14px">
        <div style="font-size:11px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          Best Contact
        </div>
        <div style="font-size:13px;font-weight:600;color:var(--text,#fff)">${escHtml(contactName)}</div>
        <div style="font-size:11px;color:var(--muted,#888)">${escHtml(contactTitle)}</div>
        ${contactEmail ? `<div style="font-size:11px;color:var(--accent,#84CC16);margin-top:2px">${escHtml(contactEmail)}</div>` : ''}
        <div style="font-size:10px;color:var(--muted,#555);margin-top:4px">Confidence: ${confidence}%</div>
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

    <!-- Campaign ideas chips -->
    ${campaignIdeas.length ? `
    <div style="margin-bottom:16px">
      <div style="font-size:10px;font-weight:700;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Campaign Ideas</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${campaignIdeas.slice(0,3).map(idea => `
          <span style="font-size:11px;padding:4px 10px;background:rgba(132,204,22,0.1);
                       border:1px solid rgba(132,204,22,0.3);border-radius:20px;color:var(--accent,#84CC16)">
            ${escHtml(typeof idea === 'string' ? idea : (idea.description || JSON.stringify(idea)))}
          </span>`).join('')}
      </div>
    </div>` : ''}

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
          <input id="outreach-to-email" value="${escHtml(contactEmail || '')}"
                 placeholder="contact@brand.com"
                 style="width:100%;margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                        border:1px solid var(--border,#333);border-radius:6px;
                        color:var(--text,#fff);font-size:12px;outline:none;box-sizing:border-box">
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button id="outreach-send-btn" onclick="window.outreachEngine.sendOutreach('${outreachId}')"
              style="padding:10px 24px;background:var(--accent,#84CC16);border:none;border-radius:8px;
                     color:#000;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0">
        Send Email →
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

  // Load email accounts into the dropdown
  loadEmailAccountsIntoDropdown();
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
      const bodyHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#333"><p>${(bodyText || '').replace(/\n/g, '<br>')}</p></div>`;
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
    const bodyHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#333"><p>${(bodyText || '').replace(/\n/g, '<br>')}</p></div>`;
    await outreachAPI.patch('/logs/' + outreachId, { subject, body_html: bodyHtml });
    if (status) { status.style.color = '#84CC16'; status.textContent = 'Edits saved ✓'; }
    showOutreachToast('Draft saved');
  } catch (e) {
    if (status) { status.style.color = '#f87171'; status.textContent = 'Save failed: ' + e.message; }
    showOutreachToast('Save failed: ' + e.message, true);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showOutreachToast(msg, isError) {
  if (typeof showToast === 'function') { showToast(msg); return; }
  console.log('[outreachEngine]', isError ? 'ERROR:' : '', msg);
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Export ────────────────────────────────────────────────────────────────────

window.outreachEngine = {
  generate:     generateOutreach,
  close:        closeOutreachModal,
  sendOutreach,
  saveDraft,
};
