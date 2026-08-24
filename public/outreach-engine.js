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
  // Resolved once per athlete by athleteDisplayName, so the Instagram DM never has
  // to reverse-engineer a name out of the subject line.
  athleteName:    null,
  // Which draft is on screen. connectGmail needs it to save the edits before it
  // navigates away, and sendOutreach already had it only as a closure argument.
  currentOutreachId: null,
  // Which contact the poll loop has already applied. The run returns the same one
  // on every poll; applying it more than once would reset a recipient the agent
  // chose. Cleared whenever a new run starts or the modal closes.
  appliedContactKey: null,
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
  if (OutreachEngineState.athleteId !== athleteId) OutreachEngineState.athleteName = null;
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

  // ── NO PRE-WARMED DRAFT: RENDER ANYWAY, DO NOT WAIT ────────────────────────
  //
  // This used to sit on a spinner until the seven-step workflow finished --
  // enrichment, contact discovery, brand match, pitch, deck -- which is up to two
  // minutes of an agent looking at "AI is working on this…". An agent can find a
  // local owner on Google in thirty seconds, so a slower wait for a worse answer
  // is worth less than nothing.
  //
  // The card already knows everything the modal's frame needs: the business, the
  // category, the region, the fit reasoning, the phone, and the contact ladder if
  // it has been expanded. So the modal is built from the card NOW, with the email
  // body streaming in behind it. Same pattern ensureDeepContact already uses for
  // contacts: put the frame on screen, fill the slow parts in as they land.
  renderFromCard(dealResult, athleteId);
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
    // The draft cannot be written. The modal stays: the recipient, the phone and
    // the Instagram DM are all still usable, and they came from the card.
    setDraftStatus('failed', e.message);
  }
}

// The modal, built entirely from the Deal Scan card, with no server round trip.
// Everything here is already in the browser.
function renderFromCard(d, athleteId) {
  const brand = d.brand || d.brand_name || 'this business';
  renderRunResult({
    run: { brand_name: brand, athlete_id: athleteId, status: 'running' },
    enrichment: {
      brand_name: brand,
      industry: d.category || null,
      location: d.region || d.market || null,
      brand_size: null,
      website: d.website || null,
    },
    contact: pickCardContact(d),
    matchScore: null,
    deck: null,
    // No body yet. The textarea renders empty with a status line above it rather
    // than a spinner over the whole modal, so everything else is usable meanwhile.
    outreach: { id: null, subject: `NIL Partnership — ${brand}`, body_html: '' },
  });
  setDraftStatus('writing');
  // NOT ensureDeepContact. The /run workflow about to be posted does its own contact
  // discovery -- and since a bare business phone stopped counting as "already
  // supplied", it really does run the fan-out now. Firing the client lookup as well
  // would pay twice for the same six searches, which is the double-spend the
  // pre-warm path exists to avoid.
  //
  // So the panel says it is still looking, which is true: the workflow is. It
  // settles in applyCompletedRun when the run comes back with a contact.
  const known = pickCardContact(d);
  if (!known || !known.name) refreshReachPanel(d, 'looking');
}

// The one line that says what the email is doing. Sits directly above the body so
// an empty textarea is never mistaken for a finished draft.
function setDraftStatus(state, message) {
  const el = document.getElementById('outreach-draft-status');
  const ta = document.getElementById('outreach-body-input');
  const send = document.getElementById('outreach-send-btn');
  if (!el) return;
  if (state === 'writing') {
    el.style.display = '';
    el.innerHTML = '<span style="display:inline-block;width:9px;height:9px;margin-right:7px;vertical-align:middle;'
      + 'border:2px solid var(--border,#333);border-top-color:var(--accent,#84CC16);border-radius:50%;'
      + 'animation:outreachspin 0.8s linear infinite"></span>Writing the email. Everything else below is ready now.'
      + '<span id="outreach-draft-steps"></span>'
      + '<style>@keyframes outreachspin{to{transform:rotate(360deg)}}</style>';
    if (ta) ta.placeholder = 'The draft is being written…';
    // Nothing to send until there is a body.
    if (send) { send.disabled = true; send.style.opacity = '0.5'; send.style.cursor = 'not-allowed'; }
    return;
  }
  if (state === 'failed') {
    el.style.display = '';
    el.innerHTML = '<span style="color:#f87171">The draft could not be written'
      + (message ? ': ' + escHtml(message) : '') + '. '
      + 'The contact and the DM below still work, or write the email yourself.</span>';
    if (ta) ta.placeholder = 'Write the email here.';
    if (send) { send.disabled = false; send.style.opacity = ''; send.style.cursor = 'pointer'; }
    return;
  }
  el.style.display = 'none';
  el.innerHTML = '';
  if (send) { send.disabled = false; send.style.opacity = ''; send.style.cursor = 'pointer'; }
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
  // IN LADDER ORDER. The server keeps whatever order it receives (discoverContacts
  // assigns priority by array index) and the workflow then drafts to contacts[0].
  // Sending the raw fan-out order meant the pitch was addressed to whoever a search
  // returned first, which is not the person the card told the agent to call.
  const ranked = _rankLikeLadder(contacts, d.contactLadder);
  if (!ranked.length && !d.businessPhone) return null;
  return { contacts: ranked, businessPhone: d.businessPhone || null, genericInbox: d.genericInbox || null };
}

// Reorder the flat contact list to match the ladder's tiers. Names the ladder held
// back (front-desk staff) or could not reach at all keep their place at the end
// rather than being dropped: the server may still make use of them, and silently
// discarding research is how the ladder got ignored in the first place.
function _rankLikeLadder(contacts, ladder) {
  if (!ladder || !Array.isArray(ladder.tiers)) return contacts;
  const order = [];
  ladder.tiers.forEach(function (t) {
    (t.rows || []).forEach(function (r) { if (r.name && order.indexOf(r.name) === -1) order.push(r.name); });
  });
  if (!order.length) return contacts;
  return contacts.slice().map(function (c, i) { return { c: c, i: i }; }).sort(function (a, b) {
    const ai = a.c.name ? order.indexOf(a.c.name) : -1;
    const bi = b.c.name ? order.indexOf(b.c.name) : -1;
    const ar = ai === -1 ? order.length + a.i : ai;
    const br = bi === -1 ? order.length + b.i : bi;
    return ar - br;
  }).map(function (x) { return x.c; });
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

  // THE MISSING PIECE. Pre-warming skips the contact ladder, so a pre-warmed modal
  // opened saying "No named contact found" even for businesses where a decision
  // maker is findable. Run the ladder NOW, for this one business, behind the draft
  // that is already on screen.
  //
  // Only here, never on the /run path below: that workflow does its own contact
  // discovery, and firing both would pay twice for the same searches.
  ensureDeepContact(dealResult);
}

// The one contact the "How to reach them" panel leads with, and the name the
// greeting is personalised to. LADDER FIRST: d.contacts is the raw fan-out list in
// source order, so taking list[0] led with whoever a search happened to return
// first -- often a manager with no address at all, while the owner sat second.
function pickCardContact(d) {
  const list = (d && Array.isArray(d.contacts)) ? d.contacts : [];
  const L = d && d.contactLadder;
  if (L && Array.isArray(L.tiers)) {
    // Best named row that has some way through, tier order, most senior first.
    for (const t of L.tiers) {
      for (const r of (t.rows || [])) {
        if (!r.name) continue;
        // Match back to the raw contact so the phone the card knows is not lost:
        // a ladder row deliberately drops a number that is only the main line.
        const raw = list.find((c) => c && c.name === r.name) || {};
        return {
          name: r.name, title: r.title || raw.title || null, email: r.email || raw.email || null,
          phone: r.phone || raw.phone || d.businessPhone || null,
          confidence_score: r.confidence === 'Confident' ? 0.9 : (r.confidence === 'Likely' ? 0.7 : 0.3),
        };
      }
    }
  }
  const c = list[0];
  // No named person is not the same as nothing. The panel's own copy says "the main
  // line above is the way in" -- but returning null here meant no phone rendered, so
  // it pointed at a number that was not on screen.
  if (!c) return (d && d.businessPhone)
    ? { name: null, title: null, email: null, phone: d.businessPhone, confidence_score: 0.3 }
    : null;
  return {
    name: c.name || null, title: c.title || null, email: c.email || null,
    phone: c.phone || d.businessPhone || null, confidence_score: c.email ? 0.9 : 0.6,
  };
}

// How to address someone, client side. Mirror of salutationName in
// server/services/greetingGuard.js and askName in contactLadder.js. Taking the
// first whitespace token turned "Dr. Dawn Mercer" into "Hi Dr.," -- a greeting
// addressed to a title and nobody.
var _HONORIFIC_ONLY_FE = /^(dr|mr|mrs|ms|miss|prof|professor|doctor|coach)\.?$/i;
function salutationNameFE(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length > 1 && _HONORIFIC_ONLY_FE.test(parts[0])) {
    const h = parts[0].replace(/\.?$/, '.');
    return h.charAt(0).toUpperCase() + h.slice(1) + ' ' + parts[parts.length - 1];
  }
  return parts[0];
}

// Replace a bare "Hi," on the first line with "Hi <first name},". Deliberately
// narrow: it touches the greeting line only, never the body, and does nothing if
// the draft already greets someone.
function personalizeGreeting(fullName) {
  const ta = document.getElementById('outreach-body-input');
  if (!ta) return;
  const first = salutationNameFE(fullName);
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
  // A new run's contact has not been applied yet, whatever the last one's was.
  OutreachEngineState.appliedContactKey = null;

  OutreachEngineState.pollInterval = setInterval(async () => {
    try {
      const data = await outreachAPI.get('/runs/' + runId);
      const status = data.run?.status;

      if (status === 'complete') {
        clearInterval(OutreachEngineState.pollInterval);
        OutreachEngineState.pollInterval = null;
        OutreachEngineState.currentRunData = data;
        // FILL IN PLACE, do not repaint. The modal has been on screen and usable
        // since the click; a full re-render here would throw away anything the
        // agent typed into the body or the recipient while waiting.
        applyCompletedRun(data);
      } else if (status === 'failed') {
        clearInterval(OutreachEngineState.pollInterval);
        OutreachEngineState.pollInterval = null;
        // Not setModalState('error'): that replaces the whole body with an error
        // panel, taking away the contact and the DM, which are still good.
        setDraftStatus('failed', data.run?.error_message || 'Workflow failed');
      } else {
        // STILL RUNNING, WHICH DOES NOT MEAN EMPTY-HANDED. contact_discovery is step
        // 2 of 7 and this response already carries what it found. Take it now rather
        // than at step 7: on a cold card it is the only thing standing between an
        // empty To field and a usable modal.
        applyRunContact(data);
        const steps = data.run?.steps_completed;
        const completedSteps = Array.isArray(steps) ? steps : (typeof steps === 'string' ? JSON.parse(steps || '[]') : []);
        updateLoadingProgress(completedSteps);
      }
    } catch (e) {
      console.error('[outreachEngine] Poll error:', e.message);
    }
  }, 3000);
}

// The athlete's name, for the Instagram DM.
//
// This used to be REVERSE-ENGINEERED out of the email subject by splitting on
// " x ", which works only while the subject happens to read "Amari Allen x Iron
// Tribe". The moment a subject has no " x " in it -- as the placeholder
// renderFromCard writes does not -- the split returns the WHOLE subject, and the
// DM introduced the athlete as "NIL Partnership — Millennium Chiropractic and
// Rehab". A name should be read, not parsed back out of a sentence that contains
// it, so this asks the app for it and only falls back to the subject when the
// subject genuinely has the two-part shape.
function athleteDisplayName(subject) {
  const state = OutreachEngineState;
  if (state.athleteName) return state.athleteName;
  // The SPA owns the roster; the engine is loaded into it.
  try {
    const id = state.athleteId;
    const list = (typeof window !== 'undefined' && window.athletes) || (typeof athletes !== 'undefined' ? athletes : null);
    if (id && Array.isArray(list)) {
      const a = list.find((x) => x && String(x.id) === String(id));
      if (a && a.name) { state.athleteName = a.name; return a.name; }
    }
  } catch (_) { /* not running inside the SPA */ }
  const s = String(subject || '');
  // Only when the subject really is "<athlete> x <brand>". Never the whole string.
  if (/\s+[x×]\s+/.test(s)) {
    const left = s.split(/\s+[x×]\s+/)[0].trim();
    if (left && left.length <= 60) return left;
  }
  return 'my athlete';
}

// THE CONTACT ARRIVES AT STEP 2 OF 7, NOT AT THE END.
//
// executeWorkflow writes automation_runs.contact_id the moment contact_discovery
// finishes, and getRunStatus returns that contact on every poll from then on. The
// poll loop only read data.contact inside `if (status === 'complete')`, so a
// contact that was already sitting in the browser went unused through brand_match,
// pitch_generation, deck_generation, email_draft and crm_update -- five steps the
// To field does not depend on. On a cold card, where the card itself found nobody,
// that gap is the entire difference between a modal that is on SCREEN (under a
// second) and a modal that is USABLE (ninety-odd).
//
// Applied once per contact, in place, and never over anything the agent has done.
// Returns true when it changed something.
function applyRunContact(data) {
  const c = data && data.contact;
  if (!c) return false;
  // The agent may have closed this modal and opened another business's while the
  // run was still in flight. Same guard the deep contact lookup already uses.
  const forBrand = (data.run && data.run.brand_name) || null;
  if (!stillShowing(forBrand)) return false;
  // ONCE. The same contact comes back on every poll, and re-rendering the picker
  // every three seconds would drag the selection back to the top of the list under
  // an agent who had deliberately chosen a different address. Picking from the
  // list clears `touched` on purpose, so the typed-by-hand guard does not cover it.
  const key = String(c.id || c.email || c.name || '');
  if (!key || OutreachEngineState.appliedContactKey === key) return false;
  OutreachEngineState.appliedContactKey = key;

  // Onto the CARD, not only into the boxes. The reach panel renders from
  // pickCardContact(d), so a contact that reached the To field and nowhere else
  // left the panel reading "No named contact found" directly beside her own
  // address -- which is what it did, even after the run completed.
  const d = OutreachEngineState.currentDealResult;
  if (d) {
    if (!Array.isArray(d.contacts)) d.contacts = [];
    const same = (x) => x && (
      (c.email && x.email && String(x.email).toLowerCase() === String(c.email).toLowerCase())
      || (c.name && x.name && String(x.name) === String(c.name)));
    if (!d.contacts.some(same)) {
      const s = Number(c.confidence_score);
      d.contacts.push({
        name: c.name || null, title: c.title || null, email: c.email || null,
        phone: c.phone || null, sourceUrl: c.source_url || null,
        confidence: (!isNaN(s) && s >= 0.85) ? 'high' : 'medium',
      });
    }
  }

  const recipients = outreachRecipients(d, c);
  if (recipients.length) { renderRecipientOptions(recipients); wireRecipientControls(recipients); }
  refreshReachPanel(d, null, forBrand);
  return true;
}

// The workflow finished behind a modal that has been usable the whole time. Put
// the parts it produced into the boxes that are already on screen, and leave
// everything the agent has touched alone.
function applyCompletedRun(data) {
  const outreach = data && data.outreach;
  const subj = document.getElementById('outreach-subject-input');
  const ta = document.getElementById('outreach-body-input');
  if (!ta) { renderRunResult(data); return; }   // modal was replaced: fall back to a repaint

  OutreachEngineState.currentOutreachId = (outreach && outreach.id) || OutreachEngineState.currentOutreachId;
  // Only fill what the agent has not written over. An empty box is ours to fill;
  // anything in it is theirs.
  if (outreach && outreach.body_html && !ta.value.trim()) {
    ta.value = htmlToEditableText(outreach.body_html);
    // The greeting personalisation the pre-warmed path does, for the same reason.
    const c = data.contact;
    if (c && c.name && resolvePersonalEmail(c)) personalizeGreeting(c.name);
  }
  // Only overwrite the placeholder renderFromCard put there. Anything else is the
  // agent's, whether they typed it or the pre-warm wrote it.
  const brandNow = (data.run && data.run.brand_name) || '';
  const placeholder = `NIL Partnership — ${brandNow}`;
  if (subj && outreach && outreach.subject && (!subj.value.trim() || subj.value === placeholder)) {
    subj.value = outreach.subject;
  }

  // The workflow may have found a contact the card did not have. One implementation,
  // shared with the poll loop: usually this is a no-op because the same contact was
  // applied five steps ago, and when it is a no-op it must stay one -- re-rendering
  // the picker here would reset a recipient the agent picked while waiting.
  applyRunContact(data);

  // The send button targets an outreach id, which only exists now.
  const send = document.getElementById('outreach-send-btn');
  if (send && OutreachEngineState.currentOutreachId) {
    send.setAttribute('onclick', `window.outreachEngine.sendOutreach('${OutreachEngineState.currentOutreachId}')`);
  }
  setDraftStatus(null);
  window._naOutreachSnapshot = String(ta.value || '') + ' ' + String(subj ? subj.value : '');
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
  OutreachEngineState.appliedContactKey = null;
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
  if (!el) {
    // The modal is rendered from the card and already usable, so there is no
    // spinner panel to fill. Report progress on its own node inside the status
    // line, which leaves the spinner and the message untouched.
    const count = document.getElementById('outreach-draft-steps');
    if (count && Array.isArray(completedSteps)) {
      count.textContent = completedSteps.length ? ` (${completedSteps.length} of 7 steps done)` : '';
    }
    return;
  }
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
  // THE RECIPIENTS. Off the card's contact ladder, merged with whatever the server
  // resolved, ranked by confidence. This used to be a single address gated on
  // `confidence >= 60` against contact.confidence_score -- a 0-1 number that a
  // ladder row does not carry, so a ladder row scored 0 and never prefilled
  // anything. Now the ladder's own labels decide, and everything emailable is
  // offered rather than silently discarded.
  const recipients   = outreachRecipients(OutreachEngineState.currentDealResult, contact);
  const prefillTo    = recipients.length ? recipients[0].email : '';
  // Rule 6: when there is a phone and no personal email, calling is the primary
  // move. Still keyed on a PERSONAL email: a general inbox is now pre-filled, but
  // it is not a reason to stop leading with the phone.
  const phoneFirst   = !!(contactPhone && !personalEmail);

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
        <!-- Re-rendered in place when the decision-maker lookup returns, which is why
             it is an addressable node rather than inline markup. -->
        <div id="outreach-reach-body">${reachPanelInner(contact, null)}</div>
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
        <!-- Set by setDraftStatus. Directly above the textarea so an empty box is
             never mistaken for a finished draft. -->
        <div id="outreach-draft-status" style="display:none;font-size:11px;color:var(--muted,#888);margin:4px 0 2px;line-height:1.5"></div>
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
          <!-- The picker only appears when there is a genuine choice. Every option
               carries its confidence label, because picking a recipient is picking
               how sure you are that it reaches a decision maker. -->
          <select id="outreach-to-pick" style="width:100%;margin-top:4px;padding:8px 10px;
                  background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:6px;
                  color:var(--text,#fff);font-size:12px;outline:none;${recipients.length > 1 ? '' : 'display:none'}">
            ${recipients.length > 1 ? recipients.map((r) => `<option value="${escHtml(r.email)}">${escHtml(r.optionLabel)}</option>`).join('') : ''}
          </select>
          <input id="outreach-to-email" value="${escHtml(prefillTo)}"
                 placeholder="${prefillTo ? '' : 'Add a verified recipient before sending'}"
                 style="width:100%;margin-top:4px;padding:8px 10px;background:var(--surface,#111);
                        border:1px solid var(--border,#333);border-radius:6px;
                        color:var(--text,#fff);font-size:12px;outline:none;box-sizing:border-box">
          <div id="outreach-to-note" style="font-size:10px;color:var(--muted,#888);margin-top:4px;line-height:1.4">${escHtml(recipientNote(recipients[0] || null))}</div>
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
      const athleteName = athleteDisplayName(currentSubject);
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
        // brand and region are sent so the server can check the handle belongs to
        // THIS business. Without them it took the first instagram.com link on the
        // page, which is how a web designer's account became the DM target.
        fetch('/api/agent/brand-instagram', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website: site, brand: brand, region: (enrichment && enrichment.location) || '' }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.handle) {
              openLink.href = 'https://www.instagram.com/' + d.handle;
              // Say when it is the brand's account rather than this location's, so
              // an agent is not surprised that corporate answers.
              openLink.textContent = (d.scope === 'brand' ? 'Open brand @' : 'Open @') + d.handle;
            }
          }).catch(function () {});
      }
    })();

  // Snapshot the draft as loaded. The assistant compares against this before it
  // navigates, so "unsaved edits" means the agent actually typed something rather
  // than merely having the panel open.
  try {
    const _b = document.getElementById('outreach-body-input');
    const _s = document.getElementById('outreach-subject-input');
    window._naOutreachSnapshot = String(_b ? _b.value : '') + ' ' + String(_s ? _s.value : '');
  } catch (e) { window._naOutreachSnapshot = undefined; }

  // Recipient picker: select the pre-filled one and wire the two-way link between
  // the dropdown and the free-text box, which stays the single source of truth for
  // send so sendOutreach is unchanged.
  const _sel = document.getElementById('outreach-to-pick');
  if (_sel && recipients.length > 1) _sel.value = prefillTo;
  wireRecipientControls(recipients);

  // Load email accounts into the dropdown
  loadEmailAccountsIntoDropdown();
  // Set up the "Attach media kit" button for this athlete + brand.
  loadMediaKitAttach(OutreachEngineState.athleteId || (run && run.athlete_id) || null, brand);
}

// ── "How To Reach Them", as one function ────────────────────────────────────
// Rendered twice: once when the modal opens, again when the decision-maker lookup
// returns. One function so the two cannot drift into showing different things.
//
// state: null = settled, 'looking' = the lookup is running, 'none' = it ran and
// found nobody. The three are visibly different on purpose: an agent who sees
// "No named contact found" while a search is still running will conclude it is
// broken and close the modal, which is the behaviour this whole change exists to
// stop.
function reachPanelInner(contact, state) {
  const rawEmail = (contact && contact.email) || null;
  const emailGeneric = _isGenericInboxFE(rawEmail);
  const hasName = !!(contact && contact.name && String(contact.name).trim());
  const personalEmail = resolvePersonalEmail(contact);
  const contactPhone = (contact && contact.phone) || null;

  const name = hasName
    ? String(contact.name).trim()
    : (state === 'looking'
        ? 'Finding decision maker…'
        : (rawEmail && emailGeneric ? 'General inbox' : 'No named contact found'));
  const title = (contact && contact.title)
    || (hasName ? 'Contact'
      : (state === 'looking' ? 'Searching this business for an owner or manager' : 'No verified decision maker'));

  const spinner = (state === 'looking')
    ? '<span style="display:inline-block;width:10px;height:10px;margin-right:7px;vertical-align:middle;'
      + 'border:2px solid var(--border,#333);border-top-color:var(--accent,#84CC16);border-radius:50%;'
      + 'animation:outreachspin 0.8s linear infinite"></span>'
      + '<style>@keyframes outreachspin{to{transform:rotate(360deg)}}</style>'
    : '';

  let h = '';
  h += `<div style="font-size:13px;font-weight:600;color:${hasName ? 'var(--text,#fff)' : 'var(--muted,#888)'}">${spinner}${escHtml(name)}</div>`;
  h += `<div style="font-size:11px;color:var(--muted,#888)">${escHtml(title)}</div>`;
  if (personalEmail) h += `<div style="font-size:11px;color:var(--accent,#84CC16);margin-top:2px">${escHtml(personalEmail)}</div>`;
  if (contactPhone) h += `<div style="font-size:11px;color:var(--text,#fff);margin-top:2px">📞 <a href="tel:${escHtml(String(contactPhone).replace(/[^0-9+]/g, ''))}" style="color:var(--accent,#84CC16);text-decoration:none">${escHtml(contactPhone)}</a></div>`;
  if (!personalEmail && emailGeneric && rawEmail) h += `<div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${escHtml(rawEmail)} <span style="color:var(--muted,#555)">(general inbox, not a person)</span></div>`;
  // Said plainly, and only once the search is actually over. The main line stays
  // exactly where it is: a phone you can call is still a way through.
  if (state === 'none' && !hasName) {
    h += '<div style="font-size:10px;color:var(--muted,#888);margin-top:6px;line-height:1.5">'
      + 'We searched this business and could not find a named decision maker. '
      + (contactPhone ? 'The main line above is the way in.' : 'No published contact was found at all.')
      + '</div>';
  }
  return h;
}

// ── The decision-maker lookup, fired when the MODAL opens ───────────────────
// The pre-warmed draft made the modal instant, and instantly said "No named contact
// found", because pre-warming deliberately skips the contact ladder: running it for
// all ten cards at scan time costs roughly an order of magnitude more than the
// drafts do.
//
// So it runs HERE instead, for the one business the agent actually opened. The modal
// is already on screen with its draft; this fills the contact in behind it.
//
// ONLY ON THE PRE-WARMED PATH. When there is no pre-warmed draft the modal falls
// through to POST /run, and that workflow does its own contact discovery. Firing
// this as well would re-open the double-spend that was just closed.
async function ensureDeepContact(d, force) {
  if (!d) return;
  const brand = d.brand || d.brand_name;
  if (!brand) return;

  // ALREADY RAN. Expanding a card runs the same ladder, so an agent who looked at
  // the card before clicking has already paid for this. _deepLoaded is the explicit
  // marker; the other two cover cards expanded before that flag existed and the
  // Add-a-Business path, which also builds a ladder.
  const alreadyDeep = !force && !!(d._deepLoaded || d.contactLadder
    || (Array.isArray(d.contacts) && d.contacts.some((c) => c && c.name)));
  if (alreadyDeep) {
    console.log('[outreachEngine] contact ladder already resolved for', brand, '- reusing');
    refreshReachPanel(d, null);
    // Apply it as well as show it. The modal body is normally rendered from the same
    // ladder a moment earlier, so this is usually a no-op -- but when it is not, the
    // agent was looking at a contact panel naming someone the To field did not have.
    applyFoundContact(pickCardContact(d), brand);
    return;
  }
  if (d._deepLoading) return;
  d._deepLoading = true;

  refreshReachPanel(d, 'looking');
  const forBrand = brand;
  try {
    const r = await fetch(API_BASE_OE() + '/api/agent/brand-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ deep: true, brands: [{
        brand: brand, website: d.website || null, region: d.region || '',
        market: d.market || null, isFranchise: d.isFranchise === true,
        approach: d.contactApproach || null, category: d.category || null,
      }] }),
    });
    const data = await r.json().catch(function () { return {}; });
    const row = data && Array.isArray(data.results) && data.results[0];
    d._deepLoading = false;
    if (!r.ok || !row || row.error) {
      // A failed search is not the same as an empty one, and must not be reported as
      // "we looked and there is nobody".
      console.warn('[outreachEngine] contact lookup failed:', (data && data.error) || (row && row.error) || r.status);
      refreshReachPanel(d, 'failed', forBrand);
      return;
    }
    if (Array.isArray(row.contacts)) d.contacts = row.contacts;
    if (row.genericInbox) d.genericInbox = row.genericInbox;
    if (row.businessPhone) d.businessPhone = row.businessPhone;
    if (row.mapsUrl) d.mapsUrl = row.mapsUrl;
    if (row.approach) d.contactApproach = row.approach;
    // Same reason as the Deal Scan card: a rejected URL that stays on the card is
    // posted back as `website` next time, where it outranks the Places one.
    if (row.websiteDropped) d.website = null;
    else if (row.website) d.website = row.website;
    d.contactLadder = row.contactLadder || null;
    d._contactsLoaded = true;
    d._deepLoaded = true;
    // If the card is on screen behind the modal, its own contact slot is now stale.
    if (typeof window._dsRefreshContactSlot === 'function') {
      try { window._dsRefreshContactSlot(d); } catch (_) { /* card may be gone */ }
    }
    const found = pickCardContact(d);
    refreshReachPanel(d, found && found.name ? null : 'none', forBrand);
    applyFoundContact(found, forBrand);
  } catch (e) {
    d._deepLoading = false;
    console.warn('[outreachEngine] contact lookup threw:', e && e.message);
    refreshReachPanel(d, 'failed', forBrand);
  }
}

// Guarded on the brand: the agent may have closed this modal and opened another one
// while the search was running, and a late reply must not paint one business's
// contact onto another's screen.
function stillShowing(forBrand) {
  if (!forBrand) return true;
  const cur = OutreachEngineState.currentDealResult;
  const curBrand = cur && (cur.brand || cur.brand_name);
  const modal = document.getElementById('outreach-engine-modal');
  if (!modal || modal.style.display === 'none') return false;
  return String(curBrand || '') === String(forBrand);
}

function refreshReachPanel(d, state, forBrand) {
  if (!stillShowing(forBrand)) return;
  const el = document.getElementById('outreach-reach-body');
  if (!el) return;
  if (state === 'failed') {
    el.innerHTML = reachPanelInner(pickCardContact(d), null)
      + '<div style="font-size:10px;color:#fbbf24;margin-top:6px;line-height:1.5">'
      + 'The contact search did not complete, so this may not be everyone. '
      + '<a href="#" onclick="window.outreachEngine.retryContact();return false" style="color:#fbbf24;text-decoration:underline">Try again</a>'
      + '</div>';
    return;
  }
  el.innerHTML = reachPanelInner(pickCardContact(d), state);
}

// A found person changes two more things besides the panel: the greeting, and the
// recipient box if it is still empty. Nothing else in the draft is touched.
// NOT gated on finding a NAMED person. A business whose only route is its published
// general inbox has no named contact, so this used to return immediately and the
// recipient the lookup had just found was thrown away.
function applyFoundContact(found, forBrand) {
  if (!stillShowing(forBrand)) return;
  if (found && found.name) personalizeGreeting(found.name);
  // Repaint the whole picker, not just the box. The lookup that just landed is the
  // one that produced the ladder, so it usually brings MORE than one address; the
  // old version set a single value and only when the box was empty, which meant a
  // modal opened before the lookup returned never offered the alternatives at all.
  // renderRecipientOptions keeps the "typed by hand wins" guard.
  const recipients = outreachRecipients(OutreachEngineState.currentDealResult, null);
  if (recipients.length) {
    renderRecipientOptions(recipients);
    wireRecipientControls(recipients);
  }
}

// "Try again" after a failed lookup. It cleared _deepLoaded only, but the
// alreadyDeep guard above also short-circuits on d.contactLadder and on any named
// contact -- and a failed deep call still leaves a ladder behind (the server builds
// the main-line floor even when the fan-out throws). So the retry link found the
// card "already deep", returned immediately, and never re-ran anything.
function retryContact() {
  const d = OutreachEngineState.currentDealResult;
  if (!d) return;
  d._deepLoading = false;
  ensureDeepContact(d, true);
}

// API_BASE is defined by index.html; fall back to same-origin when this file is
// loaded on its own (the test harness does exactly that).
function API_BASE_OE() {
  return (typeof API_BASE === 'string') ? API_BASE : '';
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
    // Re-baseline: what was just saved is no longer unsaved.
    try { window._naOutreachSnapshot = String(bodyText || '') + ' ' + String(subject || ''); } catch (e) {}
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

// ── Who can actually be emailed ──────────────────────────────────────────────
//
// THE HANDOFF THAT WAS BROKEN. "Find the decision maker" writes a ranked contact
// ladder onto the card (d.contactLadder): tiered, deduped, staff held back, and a
// confidence label on every row. It had exactly ONE consumer -- the renderer that
// draws it on the card. Every path into this modal read d.contacts instead, which
// is the raw fan-out list: source order rather than authority order, and with the
// general and named mailboxes missing entirely because getBrandContacts returns
// those as separate fields. So a business whose owner's published address was on
// screen behind the modal opened with an empty To field, because the first entry
// in the raw list happened to be a manager reachable only through the main line.
//
// This reads the ladder, which is the thing that did the ranking.

var _CONF_RANK = { Confident: 0, Likely: 1, Fallback: 2 };

// Mirror of confidenceLabel in server/services/contactLadder.js, used only for
// cards that carry no ladder (cached from before it existed, or the cheap Places
// pass). A card WITH a ladder uses the label the server already assigned.
function _confidenceLabelFE(c) {
  if (!c || !c.name || !String(c.name).trim()) return 'Fallback';
  return (c.confidence === 'high' && c.sourceUrl) ? 'Confident' : 'Likely';
}

function _recipient(email, name, title, confidence, tier, note) {
  var e = String(email || '').trim();
  if (!e || e.indexOf('@') === -1) return null;
  var generic = _isGenericInboxFE(e);
  var who = (name && String(name).trim()) ? String(name).trim() : null;
  var role = (title && String(title).trim()) ? String(title).trim() : null;
  return {
    email: e,
    name: who,
    title: role,
    confidence: confidence || 'Fallback',
    tier: tier || 3,
    isGeneric: generic,
    note: note || null,
    // What the agent reads in the dropdown. The confidence label is part of the
    // option, not a tooltip: choosing a recipient is choosing how sure you are.
    // It leads, because a collapsed <select> truncates from the right and a label
    // at the end is a label you cannot see without opening the list.
    optionLabel: (confidence || 'Fallback') + ' · '
                 + (who ? who + (role ? ' · ' + role : '') + ' — ' + e
                        : (role || (generic ? 'General inbox' : 'Mailbox')) + ' — ' + e),
  };
}

// Every emailable row on the card's ladder, best first.
function ladderRecipients(d) {
  var out = [];
  var L = d && d.contactLadder;
  if (L && Array.isArray(L.tiers)) {
    L.tiers.forEach(function (t) {
      (t.rows || []).forEach(function (r) {
        // A name is not a recipient. A row whose only route is the shared main
        // line, a LinkedIn profile or a DM cannot be emailed, so it is not offered
        // here -- it is still on the card, where it can be acted on.
        var rec = _recipient(r.email, r.name, r.title, r.confidence, t.tier,
          r.emailDomainNote || r.sourceNote || null);
        if (rec) out.push(rec);
      });
    });
  } else {
    // No ladder: fall back to the flat list plus the mailboxes that live beside it.
    (Array.isArray(d && d.contacts) ? d.contacts : []).forEach(function (c) {
      var rec = _recipient(c.email, c.name, c.title, _confidenceLabelFE(c), c.name ? 1 : 3, null);
      if (rec) out.push(rec);
    });
    if (d && d.genericInbox) {
      var g = _recipient(d.genericInbox, null, 'General inbox', 'Fallback', 3,
        'Published general inbox, not a named person');
      if (g) out.push(g);
    }
  }
  return out;
}

// The contact the SERVER resolved on the /run path. It may know someone the card
// does not, so it is merged in rather than replacing the ladder. Its confidence is
// a 0-1 score, which is translated into the ladder's vocabulary here: the two
// halves of the product used two different scales and nothing converted between
// them, which is its own reason the To field came back empty.
function serverContactRecipient(contact) {
  if (!contact || !contact.email) return null;
  var s = Number(contact.confidence_score);
  var label = isNaN(s) ? 'Fallback' : (s >= 0.85 ? 'Confident' : (s >= 0.5 ? 'Likely' : 'Fallback'));
  if (_isGenericInboxFE(contact.email)) label = 'Fallback';
  return _recipient(contact.email, contact.name, contact.title, label, contact.name ? 1 : 3, null);
}

// The ordered recipient list the modal offers. Highest confidence first, tier as
// the tiebreak, deduplicated by address.
function outreachRecipients(d, serverContact) {
  var all = ladderRecipients(d);
  var fromServer = serverContactRecipient(serverContact);
  if (fromServer) all.push(fromServer);
  var seen = {}, uniq = [];
  all.forEach(function (r, i) {
    var k = r.email.toLowerCase();
    if (seen[k] !== undefined) {
      // Keep the better-attributed copy of the same address.
      var prev = uniq[seen[k]];
      if (_CONF_RANK[r.confidence] < _CONF_RANK[prev.confidence] || (!prev.name && r.name)) uniq[seen[k]] = r;
      return;
    }
    r._i = i;
    seen[k] = uniq.length;
    uniq.push(r);
  });
  uniq.sort(function (a, b) {
    var c = (_CONF_RANK[a.confidence] === undefined ? 2 : _CONF_RANK[a.confidence])
          - (_CONF_RANK[b.confidence] === undefined ? 2 : _CONF_RANK[b.confidence]);
    if (c) return c;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a._i - b._i;
  });
  return uniq;
}

// The line under the To field. A general inbox IS pre-filled -- an agent with no
// other way in should not have to retype an address the card already found -- but
// it is never allowed to read as a person.
function recipientNote(r) {
  if (!r) return 'Add the recipient once you confirm who to reach — the name and phone above are your starting point.';
  if (r.isGeneric || (!r.name && r.confidence === 'Fallback')) {
    return 'General inbox — not a named person. No named decision maker was found for this business, so this goes to whoever reads the shop mailbox.';
  }
  if (!r.name) return (r.title || 'Mailbox') + ' — ' + r.confidence + '. Not attributed to a named person.';
  return r.name + (r.title ? ' · ' + r.title : '') + ' — ' + r.confidence
    + (r.note ? '. ' + r.note : '');
}

// Paint the To column: the picker (only when there is a real choice), the address,
// and the line that says what kind of address it is.
function renderRecipientOptions(recipients) {
  var sel = document.getElementById('outreach-to-pick');
  var to = document.getElementById('outreach-to-email');
  var note = document.getElementById('outreach-to-note');
  if (!to) return;
  // An address the agent typed themselves always wins over a resolved one.
  var touched = to.dataset && to.dataset.touched === '1';
  if (sel) {
    if (recipients.length > 1) {
      sel.innerHTML = recipients.map(function (r) {
        return '<option value="' + escHtml(r.email) + '">' + escHtml(r.optionLabel) + '</option>';
      }).join('');
      sel.style.display = '';
    } else {
      sel.innerHTML = '';
      sel.style.display = 'none';
    }
  }
  if (!touched && recipients.length) {
    to.value = recipients[0].email;
    if (sel) sel.value = recipients[0].email;
  }
  if (note) {
    if (!touched) note.textContent = recipientNote(recipients[0]);
    else {
      var m = _matchRecipient(recipients, to.value);
      // A typed address the ladder does not know is not "no recipient". Saying so
      // plainly beats reverting to the empty-state prompt underneath an address the
      // agent can see they just entered.
      note.textContent = m ? recipientNote(m) : 'Typed by hand — not from the contact ladder.';
    }
  }
}

function _matchRecipient(recipients, email) {
  var e = String(email || '').trim().toLowerCase();
  for (var i = 0; i < recipients.length; i++) if (recipients[i].email.toLowerCase() === e) return recipients[i];
  return null;
}

// Wired once per render of the modal body.
function wireRecipientControls(recipients) {
  var sel = document.getElementById('outreach-to-pick');
  var to = document.getElementById('outreach-to-email');
  var note = document.getElementById('outreach-to-note');
  if (!to) return;
  if (sel) {
    sel.onchange = function () {
      to.value = sel.value;
      // Choosing from the list is not typing: a later lookup may still improve it.
      if (to.dataset) to.dataset.touched = '';
      if (note) note.textContent = recipientNote(_matchRecipient(recipients, sel.value));
    };
  }
  to.oninput = function () {
    if (to.dataset) to.dataset.touched = '1';
    var m = _matchRecipient(recipients, to.value);
    if (sel) { if (m) sel.value = m.email; else sel.selectedIndex = -1; }
    if (note) note.textContent = m ? recipientNote(m) : 'Typed by hand — not from the contact ladder.';
  };
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
  retryContact,
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
