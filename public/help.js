(function() {
  // Create floating help button
  var btn = document.createElement('button');
  btn.id = 'help-btn';
  btn.innerHTML = '?';
  btn.style.cssText = 'position:fixed;bottom:24px;right:24px;width:36px;height:36px;border-radius:50%;background:#4ade80;color:#000;border:none;font-size:14px;font-weight:700;cursor:pointer;z-index:500;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:all 0.2s';
  document.body.appendChild(btn);

  // Create chat panel
  var panel = document.createElement('div');
  panel.id = 'help-panel';
  panel.style.cssText = 'position:fixed;bottom:72px;right:24px;width:320px;max-height:460px;background:#111110;border:1px solid rgba(255,255,255,0.12);border-radius:12px;z-index:500;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4)';
  panel.innerHTML =
    '<div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between">' +
      '<div>' +
        '<div style="font-size:13px;font-weight:700;color:#F0EDE6">NILDash Help</div>' +
        '<div style="font-size:10px;color:rgba(240,237,230,0.4)">Ask anything about the platform</div>' +
      '</div>' +
      '<button onclick="NILHelp.close()" style="background:transparent;border:none;color:rgba(240,237,230,0.4);font-size:18px;cursor:pointer;line-height:1">x</button>' +
    '</div>' +
    '<div id="help-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;max-height:340px">' +
      '<div style="background:rgba(200,241,53,0.08);border-radius:10px;padding:10px 12px;font-size:12px;color:#F0EDE6;line-height:1.6">' +
        'Hi! I can help you with any NILDash feature. Try asking:<br><br>' +
        '<span style="color:#C8F135;cursor:pointer" onclick="NILHelp.ask(\'How does the Rate Calculator work?\')">How does the Rate Calculator work?</span><br>' +
        '<span style="color:#C8F135;cursor:pointer" onclick="NILHelp.ask(\'How do I add a client?\')">How do I add a client?</span><br>' +
        '<span style="color:#C8F135;cursor:pointer" onclick="NILHelp.ask(\'What is the fit score in Deal Scan?\')">What is the fit score in Deal Scan?</span>' +
      '</div>' +
    '</div>' +
    '<div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:8px">' +
      '<input id="help-input" type="text" placeholder="Ask a question..." style="flex:1;padding:8px 12px;background:#1A1A18;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#F0EDE6;font-size:12px;font-family:monospace;outline:none">' +
      '<button onclick="NILHelp.send()" style="padding:8px 14px;background:#C8F135;color:#000;border:none;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer">Send</button>' +
    '</div>';
  document.body.appendChild(panel);

  // Enter key to send
  panel.querySelector('#help-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') NILHelp.send();
  });

  btn.addEventListener('click', function() {
    var isOpen = panel.style.display === 'flex';
    panel.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) panel.querySelector('#help-input').focus();
  });

  var SYSTEM_PROMPT = 'You are a helpful support assistant for NILDash, an AI-powered NIL deal management platform for sports agents. Answer questions concisely and accurately about NILDash features.\n\nNILDash features:\n- AI Command Center: Ask AI anything about your clients, deals, or NIL strategy\n- Deal Scan: AI finds ranked brand opportunities for a selected athlete. Shows fit score, campaign concept, rationale, timing. Click Write Outreach to pre-fill the outreach writer.\n- Rate Calculator: Calculates what to charge for NIL deals using NILViewVal v3 model. Factors in followers, engagement rate, sport, position, school tier, market size, and deliverable type. Supports IG Post, IG Reel, TikTok, Stories, Bundle, Retainer, YouTube, appearances, licensing, and more.\n- Negotiate: AI generates negotiation playbooks and counter-offer scripts for specific brands and deal values.\n- Team Match: Finds the best school/collective fit for a transfer portal athlete based on their profile.\n- Outreach: AI writes personalized brand outreach emails for specific athletes and brands.\n- Calendar: Monthly calendar view showing deal deadlines color-coded by stage. Click any day to add a custom event with optional reminder.\n- NIL Compliance: Checks deals against current state NIL laws using live web search.\n- Contract Generator: AI generates full NIL contracts with PDF download.\n- Commission Tracker: Track earnings and commissions across all clients and deals.\n- Pipeline: Kanban board showing all deals by stage (Prospecting, Outreach Sent, Negotiating, Closing, Closed).\n- My Roster: View and manage all athlete clients. Click Edit to update their profile.\n- Add Client: Add a new athlete with their social stats, school info, and position.\n\nKeep answers brief and practical. If they ask about a specific feature, explain how to use it step by step.';

  var history = [];

  window.NILHelp = {
    close: function() { panel.style.display = 'none'; },
    ask: function(q) {
      document.getElementById('help-input').value = q;
      NILHelp.send();
    },
    send: async function() {
      var input = document.getElementById('help-input');
      var q = input.value.trim();
      if (!q) return;
      input.value = '';
      var messages = document.getElementById('help-messages');

      // Add user message
      var userDiv = document.createElement('div');
      userDiv.style.cssText = 'align-self:flex-end;background:rgba(200,241,53,0.15);border-radius:10px;padding:8px 12px;font-size:12px;color:#F0EDE6;max-width:85%;line-height:1.5';
      userDiv.textContent = q;
      messages.appendChild(userDiv);

      // Add loading
      var loadDiv = document.createElement('div');
      loadDiv.style.cssText = 'background:rgba(255,255,255,0.06);border-radius:10px;padding:8px 12px;font-size:12px;color:rgba(240,237,230,0.5);max-width:85%';
      loadDiv.textContent = 'Thinking...';
      messages.appendChild(loadDiv);
      messages.scrollTop = messages.scrollHeight;

      history.push({role: 'user', content: q});

      try {
        var r = await fetch('/api/ai/help', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({messages: history, system: SYSTEM_PROMPT})
        });
        var data = await r.json();
        var reply = data.response || 'Sorry, I could not get a response. Try again.';
        history.push({role: 'assistant', content: reply});
        loadDiv.style.color = '#F0EDE6';
        loadDiv.textContent = reply;
      } catch(e) {
        loadDiv.textContent = 'Connection error. Try again.';
      }
      messages.scrollTop = messages.scrollHeight;
    }
  };
})();
