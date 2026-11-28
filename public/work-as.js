// ── CLIENT ACCOUNTS (server/services/workAs) ────────────────────────────────
//
// For the admin account only. A "Client accounts" button in the sidebar lists
// every agent with what matters before opening one (mailbox connected,
// athletes, pitches waiting), and Open puts him inside that agent's account.
// While he is in one, a bar across the top says whose account it is and which
// mailbox the emails send from, with one click back to his own.
//
// Everyone else: the one request below answers 403 and nothing is drawn.
(function () {
  'use strict';
  var S = { data: null, asked: false };

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; }); });
  }

  function bar(cur) {
    if (document.getElementById('waBar')) return;
    var b = el('div', 'position:fixed;top:0;left:0;right:0;z-index:9000;background:#C8F135;color:#0A0A08;font:600 13px Inter,system-ui,sans-serif;'
      + 'padding:8px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap');
    b.id = 'waBar';
    b.appendChild(el('span', '', 'You are working in ' + cur.name + "'s account. "
      + (cur.mailbox ? 'Emails you approve send from ' + cur.mailbox + '.' : 'No mailbox is connected yet, so nothing can send.')));
    var btn = 'padding:5px 12px;border-radius:999px;border:1px solid #0A0A08;background:transparent;color:#0A0A08;font:600 12px Inter,system-ui,sans-serif;cursor:pointer';
    var sw = el('button', btn, 'Switch client'); sw.type = 'button'; sw.onclick = openList;
    var back = el('button', btn + ';background:#0A0A08;color:#C8F135', 'Back to my account'); back.type = 'button';
    back.onclick = function () {
      back.disabled = true; back.textContent = 'Going back...';
      post('/api/admin/work-as/stop').then(function () { window.location.href = '/app'; }).catch(function () { back.disabled = false; back.textContent = 'Back to my account'; });
    };
    b.appendChild(sw); b.appendChild(back);
    document.body.appendChild(b);
    // The bar sits over the page: push the page down by its height.
    var h = b.offsetHeight || 36;
    document.body.style.paddingTop = h + 'px';
    var sb = document.querySelector('.sidebar'); if (sb) sb.style.top = h + 'px';
    var tb = document.querySelector('.topbar'); if (tb) tb.style.top = h + 'px';
  }

  function sidebarButton() {
    if (document.getElementById('waOpen')) return;
    var anchor = document.getElementById('theme-toggle-btn');
    if (!anchor || !anchor.parentNode) return;
    var b = el('button', 'width:100%;padding:10px 16px;margin-bottom:8px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);'
      + 'color:var(--text);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit', 'Client accounts');
    b.id = 'waOpen'; b.type = 'button'; b.onclick = openList;
    anchor.parentNode.insertBefore(b, anchor);
    // His own pipeline and follow-ups (server/pages/crm.html).
    var c = el('a', 'display:block;box-sizing:border-box;width:100%;padding:10px 16px;margin-bottom:8px;background:transparent;border:1px solid var(--border);border-radius:var(--r-sm);'
      + 'color:var(--text);font-size:12px;font-weight:600;text-align:center;text-decoration:none;font-family:inherit', 'My CRM');
    c.id = 'waCrm'; c.href = '/admin/crm';
    anchor.parentNode.insertBefore(c, anchor);
    // Follow-ups wait for him before they go anywhere (services/founderReview).
    var f = el('a', c.style.cssText, 'Follow-ups to approve');
    f.id = 'waFu'; f.href = '/admin/follow-ups';
    anchor.parentNode.insertBefore(f, anchor);
    fetch('/api/admin/follow-ups', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.count) { f.textContent = 'Follow-ups to approve (' + d.count + ')'; f.style.borderColor = '#C8F135'; f.style.color = '#C8F135'; }
    }).catch(function () {});
  }

  function closeList() { var m = document.getElementById('waModal'); if (m) m.remove(); }

  function openList() {
    closeList();
    var wrap = el('div', 'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,0.7);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto');
    wrap.id = 'waModal';
    wrap.onclick = function (e) { if (e.target === wrap) closeList(); };
    var box = el('div', 'background:#131316;border:1px solid #2A2A30;border-radius:14px;width:100%;max-width:760px;padding:24px;color:#F4F4F2;font-family:Inter,system-ui,sans-serif');
    var top = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px');
    top.appendChild(el('div', 'font-size:17px;font-weight:700', 'Client accounts'));
    var x = el('button', 'background:none;border:none;color:#A1A1A6;font-size:22px;cursor:pointer', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.onclick = closeList;
    top.appendChild(x); box.appendChild(top);
    box.appendChild(el('div', 'font-size:13px;color:#A1A1A6;margin-bottom:16px;line-height:1.5',
      'Open an account to load athletes and approve pitches for that agent. Emails send from their mailbox, under their name. Agents marked Done for you are listed first, and you are emailed when a business replies to one of them.'));
    var err = el('div', 'display:none;color:#ef4444;font-size:13px;margin-bottom:10px'); box.appendChild(err);
    var list = el('div', 'display:flex;flex-direction:column;gap:8px'); box.appendChild(list);
    list.appendChild(el('div', 'color:#A1A1A6;font-size:13px', 'Loading...'));
    wrap.appendChild(box); document.body.appendChild(wrap);

    fetch('/api/admin/clients', { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (d) {
      list.textContent = '';
      var rows = (d && d.clients) || [];
      if (!rows.length) { list.appendChild(el('div', 'color:#A1A1A6;font-size:13px', 'No agent accounts yet.')); return; }
      rows.forEach(function (c) {
        var row = el('div', 'display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 14px;border:1px solid #2A2A30;border-radius:10px;background:#17171A;flex-wrap:wrap');
        var left = el('div', 'min-width:0;flex:1 1 280px');
        left.appendChild(el('div', 'font-size:14px;font-weight:600', c.name));
        left.appendChild(el('div', 'font-size:12px;color:#A1A1A6;margin-top:2px;overflow-wrap:anywhere', c.email));
        var facts = el('div', 'font-size:12px;margin-top:6px;color:#A1A1A6');
        var mb = el('span', 'color:' + (c.mailbox ? '#C8F135' : '#FCA5A5'),
          c.mailbox ? 'Sends from ' + c.mailbox : c.mailboxBroken ? 'Mailbox disconnected (' + c.mailboxBroken + '): they need to reconnect' : 'No mailbox connected');
        facts.appendChild(mb);
        facts.appendChild(document.createTextNode(' · ' + c.athletes + (c.athletes === 1 ? ' athlete' : ' athletes') + ' · ' + c.waiting + ' waiting to approve · ' + c.sent + ' sent · '
          + c.replies + (c.replies === 1 ? ' reply' : ' replies')));
        left.appendChild(facts);
        // WHERE THEIR MAIL LANDS (services/sendingHealth): filled in below.
        var sh = el('div', 'font-size:12px;margin-top:6px;line-height:1.5;display:none'); sh.setAttribute('data-sh', c.id);
        left.appendChild(sh);
        if (c.managed) left.firstChild.appendChild(el('span', 'margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(200,241,53,0.14);color:#C8F135;font-size:11px;font-weight:600;vertical-align:middle', 'Done for you'));
        row.appendChild(left);
        // DONE FOR YOU: you run this agent's outreach. Their replies are emailed
        // to you as they come in, and they sort to the top of this list.
        var mg = el('button', 'padding:8px 12px;border-radius:999px;border:1px solid #2A2A30;background:transparent;color:#A1A1A6;font:600 12px Inter,system-ui,sans-serif;cursor:pointer',
          c.managed ? 'Stop done for you' : 'Make done for you');
        mg.type = 'button';
        mg.title = c.managed ? 'Stop emailing me this agent\'s replies' : 'Email me when a business replies to this agent, and keep them at the top';
        mg.onclick = function () {
          mg.disabled = true; err.style.display = 'none';
          post('/api/admin/clients/managed', { agentId: c.id, on: !c.managed }).then(function (x3) {
            if (!x3.ok || !x3.d.ok) { mg.disabled = false; err.textContent = x3.d.error || 'Could not save that.'; err.style.display = 'block'; return; }
            openList();
          }).catch(function () { mg.disabled = false; err.textContent = 'Could not reach NILDash. Try again.'; err.style.display = 'block'; });
        };
        row.appendChild(mg);
        var isCur = d.workingAs && d.workingAs.id === c.id;
        var go = el('button', 'padding:9px 18px;border-radius:999px;border:0;background:' + (isCur ? '#26262B' : '#C8F135') + ';color:' + (isCur ? '#A1A1A6' : '#0A0A08')
          + ';font:700 13px Inter,system-ui,sans-serif;cursor:' + (isCur ? 'default' : 'pointer'), isCur ? 'Open now' : 'Open');
        go.type = 'button'; go.disabled = !!isCur;
        go.onclick = function () {
          go.disabled = true; go.textContent = 'Opening...'; err.style.display = 'none';
          post('/api/admin/work-as', { agentId: c.id }).then(function (x2) {
            if (!x2.ok || !x2.d.ok) { go.disabled = false; go.textContent = 'Open'; err.textContent = x2.d.error || 'Could not open that account.'; err.style.display = 'block'; return; }
            window.location.href = '/app';
          }).catch(function () { go.disabled = false; go.textContent = 'Open'; err.textContent = 'Could not reach NILDash. Try again.'; err.style.display = 'block'; });
        };
        row.appendChild(go);
        list.appendChild(row);
      });
    }).catch(function () { list.textContent = ''; list.appendChild(el('div', 'color:#ef4444;font-size:13px', 'Could not load the client accounts.')); });
    loadHealth(list);
  }

  // Per agent: is their domain set up to reach the inbox, and where did the
  // last test email land. "Test inbox" sends one email from their mailbox to
  // our own mailboxes, never to a business.
  var SH_COLOR = { good: '#C8F135', warn: '#FCD34D', fix: '#FCA5A5', unknown: '#A1A1A6' };
  var SH_WORD = { inbox: 'Inbox', spam: 'SPAM', other: 'Other folder', missing: 'Never arrived', failed: 'Could not send', look: 'Check your Gmail', pending: 'Looking...', unknown: 'Could not check' };
  function drawHealth(box, h, agentId, list) {
    box.textContent = ''; box.style.display = 'block';
    var head = el('div', 'color:' + (SH_COLOR[h.level] || '#A1A1A6'), 'Sending: ' + h.summary);
    box.appendChild(head);
    (h.fixes || []).forEach(function (f) { box.appendChild(el('div', 'color:#A1A1A6;margin-top:2px', f.what + ': ' + f.do)); });
    (h.tests || []).forEach(function (t) {
      var bad = t.result === 'spam' || t.result === 'missing' || t.result === 'failed';
      box.appendChild(el('div', 'margin-top:2px;color:' + (t.result === 'inbox' ? '#C8F135' : bad ? '#FCA5A5' : '#A1A1A6'), 'Test to ' + t.to + ': ' + (SH_WORD[t.result] || t.result) + '. ' + (t.detail || '')));
    });
    var b = el('button', 'margin-top:6px;padding:4px 10px;border-radius:999px;border:1px solid #2A2A30;background:transparent;color:#F4F4F2;font:600 11px Inter,system-ui,sans-serif;cursor:pointer', 'Test inbox');
    b.type = 'button';
    b.title = 'Sends one test email from this agent\'s mailbox to our own mailboxes and reports where it landed';
    b.onclick = function () {
      b.disabled = true; b.textContent = 'Sending the test...';
      post('/api/admin/sending-health/' + encodeURIComponent(agentId) + '/test').then(function (x) {
        if (!x.ok) { b.disabled = false; b.textContent = 'Test inbox'; box.appendChild(el('div', 'color:#FCA5A5;margin-top:2px', x.d.error || 'Could not send the test.')); return; }
        b.textContent = 'Sent. Checking where it landed...';
        var tries = 0;
        var t = setInterval(function () { tries++; loadHealth(list); if (tries >= 6) clearInterval(t); }, 20000);
      }).catch(function () { b.disabled = false; b.textContent = 'Test inbox'; });
    };
    box.appendChild(b);
  }
  function loadHealth(list) {
    fetch('/api/admin/sending-health', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.agents) return;
      Object.keys(d.agents).forEach(function (id) {
        var box = list.querySelector('[data-sh="' + String(id).replace(/"/g, '') + '"]');
        if (box) drawHealth(box, d.agents[id], id, list);
      });
    }).catch(function () {});
  }

  function check() {
    var app = document.getElementById('appScreen');
    if (!app || getComputedStyle(app).display === 'none' || S.asked) return;
    S.asked = true;
    fetch('/api/admin/clients', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;                      // not the admin: nothing is drawn
      S.data = d;
      sidebarButton();
      if (d.workingAs) bar(d.workingAs);
    }).catch(function () { S.asked = false; });
  }

  function start() {
    var tries = 0;
    var t = setInterval(function () { tries++; check(); if (S.data || tries > 240) clearInterval(t); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.workAs = { open: openList };
})();
