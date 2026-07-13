// public/email.js — Email integration frontend module
// Loaded by index.html. Provides:
//  - Settings → Integrations → Email Accounts UI
//  - Email Inbox view
//  - Email Composer (compose / reply / forward)
//  - Athlete timeline email widget
// Zero interference with existing CRM, auth, or deal logic.

'use strict';

// Inbox reading/syncing needs the RESTRICTED gmail.readonly scope, which NILDash
// no longer requests. Keep the "My Gmail" inbox (message list + Sync) hidden
// behind this flag until a future restricted-scope verification. Sending still
// works via gmail.send, and connecting Gmail still powers send + calendar.
const INBOX_SYNC_ENABLED = false;

// ── State ────────────────────────────────────────────────────────────────────
const EmailState = {
  accounts:        [],
  threads:         [],
  activeThread:    null,
  activeMessages:  [],
  drafts:          [],
  composerOpen:    false,
  composeMode:     'new',    // 'new' | 'reply' | 'forward'
  composeData:     {},
};

// ── API helpers ──────────────────────────────────────────────────────────────
const emailAPI = {
  async get(path) {
    const r = await fetch('/api/email' + path);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch('/api/email' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  },
  async del(path) {
    const r = await fetch('/api/email' + path, { method: 'DELETE' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  },
};

// ── Toast helper (reuses existing showToast from index.html) ─────────────────
function emailToast(msg, isError) {
  if (typeof showToast === 'function') showToast(msg);
  else console.log('[email]', msg);
}

// ── Accounts ─────────────────────────────────────────────────────────────────

async function loadEmailAccounts() {
  try {
    EmailState.accounts = await emailAPI.get('/accounts');
    renderEmailAccountsUI();
  } catch (e) {
    console.error('[email] loadEmailAccounts:', e.message);
  }
}

function renderEmailAccountsUI() {
  const container = document.getElementById('email-accounts-list');
  if (!container) return;

  const accounts = EmailState.accounts;
  if (!accounts.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:12px;margin:0">No email accounts connected yet.</p>';
    return;
  }

  container.innerHTML = accounts.map(acc => {
    const statusColor = acc.status === 'active' ? '#4ade80' : '#f87171';
    const lastSync = acc.last_sync ? new Date(acc.last_sync).toLocaleString() : 'Never';
    const providerLabel = { gmail: 'Gmail', outlook: 'Outlook / M365', imap: 'IMAP / SMTP' }[acc.provider] || acc.provider;
    const providerIcon  = { gmail: '📧', outlook: '📨', imap: '📬' }[acc.provider] || '📧';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border);margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:22px">${providerIcon}</span>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">${acc.email_address}</div>
            <div style="font-size:11px;color:var(--muted)">${providerLabel} &nbsp;·&nbsp; Last sync: ${lastSync}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:8px;height:8px;background:${statusColor};border-radius:50%;display:inline-block" title="${acc.status}"></span>
          ${INBOX_SYNC_ENABLED ? `<button onclick="emailModule.triggerEmailSync('${acc.id}')" style="font-size:11px;padding:4px 10px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);cursor:pointer" title="Sync now">↻ Sync</button>` : ''}
          <button onclick="emailModule.disconnectEmailAccount('${acc.id}')" style="font-size:11px;padding:4px 10px;background:transparent;border:1px solid rgba(241,53,53,0.4);border-radius:var(--r-sm);color:#f87171;cursor:pointer">Disconnect</button>
        </div>
      </div>`;
  }).join('');
}

async function triggerEmailSync(accountId) {
  if (!INBOX_SYNC_ENABLED) { emailToast('Inbox sync is coming soon'); return; }
  try {
    emailToast('Syncing email…');
    await emailAPI.post(`/accounts/${accountId}/sync`, {});
    emailToast('Sync started — inbox will update shortly');
    setTimeout(loadEmailInbox, 8000); // reload inbox after 8s
  } catch (e) {
    emailToast('Sync failed: ' + e.message);
  }
}

async function disconnectEmailAccount(accountId) {
  if (!confirm('Disconnect this email account? All synced emails will be removed from NILDash.')) return;
  try {
    await emailAPI.del(`/accounts/${accountId}`);
    emailToast('Email account disconnected');
    await loadEmailAccounts();
    await loadEmailInbox();
  } catch (e) {
    emailToast('Failed to disconnect: ' + e.message);
  }
}

function connectGmail() {
  window.location.href = '/api/email/oauth/gmail';
}

function connectOutlook() {
  window.location.href = '/api/email/oauth/outlook';
}

function showImapConnectModal() {
  const modal = document.getElementById('email-imap-modal');
  if (modal) { modal.style.display = 'flex'; }
}

function closeImapModal() {
  const modal = document.getElementById('email-imap-modal');
  if (modal) { modal.style.display = 'none'; }
}

async function connectImap() {
  const emailAddress = document.getElementById('imap-email')?.value?.trim();
  const password     = document.getElementById('imap-password')?.value?.trim();
  const imapHost     = document.getElementById('imap-host')?.value?.trim();
  const imapPort     = parseInt(document.getElementById('imap-port')?.value) || 993;
  const smtpHost     = document.getElementById('imap-smtp-host')?.value?.trim();
  const smtpPort     = parseInt(document.getElementById('imap-smtp-port')?.value) || 587;

  if (!emailAddress || !password) { emailToast('Email and password required'); return; }

  const btn = document.getElementById('imap-connect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing connection…'; }

  try {
    await emailAPI.post('/connect/imap', { emailAddress, password, imapHost, imapPort, smtpHost, smtpPort });
    emailToast('Email account connected!');
    closeImapModal();
    await loadEmailAccounts();
    await loadEmailInbox();
  } catch (e) {
    emailToast('Connection failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

// Auto-fill IMAP presets when email changes in IMAP modal
async function onImapEmailChange() {
  const emailEl = document.getElementById('imap-email');
  if (!emailEl) return;
  const domain = emailEl.value.split('@')[1]?.toLowerCase();
  if (!domain) return;
  try {
    const presets = await emailAPI.get('/imap/presets');
    const p = presets[domain];
    if (p) {
      const h = id => document.getElementById(id);
      if (h('imap-host'))      h('imap-host').value      = p.imap.host;
      if (h('imap-port'))      h('imap-port').value      = p.imap.port;
      if (h('imap-smtp-host')) h('imap-smtp-host').value = p.smtp.host;
      if (h('imap-smtp-port')) h('imap-smtp-port').value = p.smtp.port;
    }
  } catch (e) { /* silent */ }
}

// ── Inbox ────────────────────────────────────────────────────────────────────

async function loadEmailInbox() {
  const el = document.getElementById('email-thread-list');
  if (!INBOX_SYNC_ENABLED) {
    // Inbox sync is disabled (restricted-scope). Show a short placeholder
    // instead of the message list; do not call /threads.
    if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:28px 20px;text-align:center;line-height:1.6">' +
      '<div style="font-size:22px;margin-bottom:8px">📤</div>' +
      '<div style="font-weight:600;color:var(--text)">Send from your Gmail, right here</div>' +
      '<div style="margin-top:6px">Your connected Gmail is ready for outreach. Every email you send from NILDash goes from your own account. Inbox viewing inside NILDash is on the roadmap. For now, replies land in your normal Gmail inbox.</div>' +
      '</div>';
    return;
  }
  try {
    EmailState.threads = await emailAPI.get('/threads?limit=50&offset=0');
    renderThreadList();
  } catch (e) {
    if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px">Could not load inbox.</div>';
  }
}

function renderThreadList(filter) {
  const el = document.getElementById('email-thread-list');
  if (!el) return;

  let threads = EmailState.threads;
  if (filter) {
    const q = filter.toLowerCase();
    threads = threads.filter(t =>
      (t.subject || '').toLowerCase().includes(q) ||
      (t.participant_emails || []).some(e => e.toLowerCase().includes(q))
    );
  }

  if (!threads.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">No emails yet.<br><br>' +
      (EmailState.accounts.length ? 'Sync is running — check back shortly.' : 'Connect an email account to get started.') +
      '</div>';
    return;
  }

  el.innerHTML = threads.map(t => {
    const date = t.last_message_at ? formatEmailDate(new Date(t.last_message_at)) : '';
    const participants = (t.participant_emails || []).slice(0, 2).join(', ');
    const unread = t.has_unread || parseInt(t.unread_count) > 0;
    const isActive = EmailState.activeThread?.id === t.id;
    return `
      <div onclick="emailModule.openThread('${t.id}')" style="padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;background:${isActive ? 'var(--surface2)' : 'transparent'};transition:background 0.1s"
           onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='${isActive ? 'var(--surface2)' : 'transparent'}'">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="font-size:12px;font-weight:${unread ? '700' : '500'};color:${unread ? 'var(--text)' : 'var(--muted)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%">${escHtml(participants || '(no sender)')}</span>
          <span style="font-size:10px;color:var(--muted);flex-shrink:0;margin-left:8px">${date}</span>
        </div>
        <div style="font-size:11px;color:${unread ? 'var(--text)' : 'var(--muted)'};font-weight:${unread ? '600' : '400'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${unread ? '<span style="width:6px;height:6px;background:var(--accent);border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle"></span>' : ''}${escHtml(t.subject || '(no subject)')}
        </div>
      </div>`;
  }).join('');
}

async function openThread(threadId) {
  const thread = EmailState.threads.find(t => t.id === threadId);
  if (!thread) return;
  EmailState.activeThread = thread;

  // Mark read in UI immediately
  thread.has_unread = false;
  renderThreadList();

  // Load messages
  const pane = document.getElementById('email-message-pane');
  if (pane) { pane.style.display = 'block'; pane.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:12px">Loading…</div>'; }

  try {
    const msgs = await emailAPI.get(`/threads/${threadId}/messages`);
    EmailState.activeMessages = msgs;
    await emailAPI.post(`/threads/${threadId}/read`, {});
    renderMessagePane(thread, msgs);
    document.getElementById('email-listview').style.display = 'none';
    if (pane) pane.style.display = 'block';
    window.scrollTo(0, 0);
  } catch (e) {
    document.getElementById('email-listview').style.display = 'none';
    if (pane) { pane.style.display = 'block'; pane.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid var(--border)"><button onclick="emailModule.closeThread()" style="font-size:11px;padding:5px 12px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);cursor:pointer">← Back</button></div><div style="padding:24px;color:#f87171;font-size:12px">Failed to load messages.</div>'; }
    window.scrollTo(0, 0);
  }
}

function renderMessagePane(thread, messages) {
  const pane = document.getElementById('email-message-pane');
  if (!pane) return;

  const lastMsg = messages[messages.length - 1];

  pane.innerHTML = `
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <button onclick="emailModule.closeThread()" style="font-size:11px;padding:5px 12px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);cursor:pointer;flex-shrink:0">← Back</button>
        <div style="min-width:0">
          <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(thread.subject || '(no subject)')}</div>
          <div style="font-size:11px;color:var(--muted)">${messages.length} message${messages.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${lastMsg ? `<button onclick="emailModule.openComposer('reply')" style="font-size:11px;padding:5px 12px;background:var(--accent);border:none;border-radius:var(--r-sm);color:#000;font-weight:700;cursor:pointer">Reply</button>` : ''}
        <button onclick="emailModule.openComposer('new')" style="font-size:11px;padding:5px 12px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);cursor:pointer">Compose</button>
      </div>
    </div>
    <div style="padding:16px 20px;display:flex;flex-direction:column;gap:16px">
      ${messages.map(msg => renderMessageCard(msg)).join('')}
    </div>`;
}

function renderMessageCard(msg) {
  const date = msg.sent_at ? new Date(msg.sent_at).toLocaleString() : '';
  const isSent = msg.direction === 'sent';
  const from = msg.from_name || msg.from_address || '(unknown)';
  const body = msg.body_html
    ? `<iframe srcdoc="${escHtml(msg.body_html)}" style="width:100%;border:none;min-height:100px;background:#fff;border-radius:6px;margin-top:8px" onload="this.style.height=(this.contentWindow.document.body.scrollHeight+20)+'px'"></iframe>`
    : `<div style="font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap;margin-top:8px">${escHtml(msg.body_text || '(empty)')}</div>`;

  return `
    <div style="background:var(--surface2);border-radius:var(--r);border:1px solid var(--border);overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:${isSent ? 'rgba(132,204,22,0.06)' : 'transparent'};border-bottom:1px solid var(--border)">
        <div style="font-size:12px">
          <span style="font-weight:600;color:var(--text)">${escHtml(from)}</span>
          <span style="color:var(--muted);margin-left:8px">${isSent ? '→ ' : ''}${escHtml((msg.to_addresses || []).join(', '))}</span>
        </div>
        <span style="font-size:10px;color:var(--muted);flex-shrink:0">${date}</span>
      </div>
      <div style="padding:12px 14px">${body}</div>
    </div>`;
}

// ── Composer ─────────────────────────────────────────────────────────────────

function openComposer(mode, prefill) {
  EmailState.composeMode = mode || 'new';
  EmailState.composeData = prefill || {};

  const modal = document.getElementById('email-compose-modal');
  if (!modal) return;

  // Populate account dropdown
  const accountSel = document.getElementById('compose-from-account');
  if (accountSel) {
    accountSel.innerHTML = EmailState.accounts.map(a =>
      `<option value="${a.id}">${a.email_address} (${a.provider})</option>`
    ).join('') || '<option>No accounts connected</option>';
  }

  // Prefill fields for reply/forward
  const lastMsg = EmailState.activeMessages[EmailState.activeMessages.length - 1];
  if (mode === 'reply' && lastMsg) {
    const toEl = document.getElementById('compose-to');
    const subEl = document.getElementById('compose-subject');
    if (toEl) toEl.value = lastMsg.from_address || '';
    if (subEl) subEl.value = lastMsg.subject?.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject || ''}`;
    const bodyEl = document.getElementById('compose-body');
    if (bodyEl) bodyEl.value = '';
  } else if (mode === 'forward' && lastMsg) {
    const subEl = document.getElementById('compose-subject');
    if (subEl) subEl.value = `Fwd: ${lastMsg.subject || ''}`;
    const bodyEl = document.getElementById('compose-body');
    if (bodyEl) bodyEl.value = `\n\n--- Forwarded message ---\nFrom: ${lastMsg.from_address}\nDate: ${lastMsg.sent_at}\nSubject: ${lastMsg.subject}\n\n${lastMsg.body_text || ''}`;
  } else {
    // New compose: prefill from the provided intent (to/cc/subject/body). Empty
    // defaults keep a fresh "+ Compose" clean between opens, and let the dashboard
    // "Draft follow-up" land here with a started follow-up draft.
    const toEl = document.getElementById('compose-to');
    const ccEl = document.getElementById('compose-cc');
    const subEl = document.getElementById('compose-subject');
    const bodyEl = document.getElementById('compose-body');
    if (toEl) toEl.value = prefill?.to || '';
    if (ccEl) ccEl.value = prefill?.cc || '';
    if (subEl) subEl.value = prefill?.subject || '';
    if (bodyEl) bodyEl.value = prefill?.body || '';
  }

  modal.style.display = 'flex';
}

function closeComposer() {
  const modal = document.getElementById('email-compose-modal');
  if (modal) modal.style.display = 'none';
}

async function sendComposedEmail() {
  const accountId = document.getElementById('compose-from-account')?.value;
  const to        = (document.getElementById('compose-to')?.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const cc        = (document.getElementById('compose-cc')?.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const subject   = document.getElementById('compose-subject')?.value?.trim();
  const body      = document.getElementById('compose-body')?.value?.trim();

  if (!accountId || !to.length || !subject) {
    emailToast('Account, recipient, and subject are required');
    return;
  }

  const btn = document.getElementById('compose-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const threadId = EmailState.composeMode === 'reply' && EmailState.activeThread
      ? EmailState.activeThread.id : null;

    await emailAPI.post('/send', {
      accountId,
      to,
      cc: cc.length ? cc : undefined,
      subject,
      bodyHtml: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">${body.replace(/\n/g, '<br>')}</div>`,
      threadId,
    });

    emailToast('Email sent!');
    closeComposer();
    await loadEmailInbox();
  } catch (e) {
    emailToast('Failed to send: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

async function saveDraftEmail() {
  const accountId = document.getElementById('compose-from-account')?.value;
  const to        = (document.getElementById('compose-to')?.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const subject   = document.getElementById('compose-subject')?.value?.trim();
  const body      = document.getElementById('compose-body')?.value?.trim();

  if (!accountId) { emailToast('Select an account first'); return; }

  try {
    await emailAPI.post('/drafts', { accountId, toAddresses: to, subject, bodyHtml: body });
    emailToast('Draft saved');
  } catch (e) {
    emailToast('Failed to save draft: ' + e.message);
  }
}

// ── Athlete email timeline ────────────────────────────────────────────────────

async function loadAthleteEmailTimeline(athleteId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading email history…</div>';

  try {
    const { emails, threads } = await emailAPI.get(`/athlete/${athleteId}`);
    if (!emails.length && !threads.length) {
      container.innerHTML = '<div style="color:var(--muted);font-size:12px">No emails found for this athlete.</div>';
      return;
    }

    container.innerHTML = emails.slice(0, 10).map(msg => {
      const date = msg.sent_at ? formatEmailDate(new Date(msg.sent_at)) : '';
      const dirIcon = msg.direction === 'sent' ? '↗' : '↙';
      const dirColor = msg.direction === 'sent' ? 'var(--accent)' : '#60a5fa';
      return `
        <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="color:${dirColor};font-size:14px;flex-shrink:0;margin-top:1px">${dirIcon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(msg.subject || '(no subject)')}</div>
            <div style="font-size:10px;color:var(--muted)">${escHtml(msg.from_address || '')} &nbsp;·&nbsp; ${date}</div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px">Could not load email history.</div>';
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function searchEmails(query) {
  if (!query?.trim()) { renderThreadList(); return; }
  try {
    const results = await emailAPI.get(`/search?q=${encodeURIComponent(query)}`);
    renderThreadList(query);
  } catch (e) {
    emailToast('Search failed');
  }
}

// ── Startup / OAuth redirect handling ────────────────────────────────────────

function handleEmailOAuthRedirect() {
  const hash = window.location.hash;
  if (hash.includes('emailConnected=')) {
    const provider = hash.match(/emailConnected=([^&]+)/)?.[1];
    if (provider) {
      emailToast(`${provider} connected! Syncing your inbox…`);
      // Clean hash
      history.replaceState(null, '', window.location.pathname);
      // Switch to settings integrations tab
      if (typeof showView === 'function') showView('settings', null);
    }
  }
  if (hash.includes('emailError=')) {
    const err = decodeURIComponent(hash.match(/emailError=([^&]+)/)?.[1] || 'Unknown error');
    emailToast('Email connection failed: ' + err);
    history.replaceState(null, '', window.location.pathname);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatEmailDate(date) {
  const now = new Date();
  const diff = now - date;
  if (diff < 24 * 60 * 60 * 1000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 7 * 24 * 60 * 60 * 1000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function initEmailModule() {
  handleEmailOAuthRedirect();
  await loadEmailAccounts();
  await loadEmailInbox();
}

function closeThread() {
  const pane = document.getElementById('email-message-pane');
  const listview = document.getElementById('email-listview');
  if (pane) pane.style.display = 'none';
  if (listview) listview.style.display = '';
  EmailState.activeThread = null;
  renderThreadList();
  window.scrollTo(0, 0);
}

// Export to window so index.html can call these directly
window.emailModule = {
  init:               initEmailModule,
  loadAccounts:       loadEmailAccounts,
  loadInbox:          loadEmailInbox,
  connectGmail,
  connectOutlook,
  showImapConnectModal,
  closeImapModal,
  connectImap,
  onImapEmailChange,
  disconnectEmailAccount,
  triggerEmailSync,
  openThread,
  closeThread,
  openComposer,
  closeComposer,
  sendComposedEmail,
  saveDraftEmail,
  searchEmails,
  loadAthleteEmailTimeline,
  renderThreadList,
};
