// ── THE MEDIA KIT BUILDER'S PREVIEW, AND ITS NEW FIELDS: ONE COPY ──────────
//
// Both builders (the agent's in index.html, the athlete's in
// athlete-dashboard.html) load this. The preview is not a second renderer:
// it frames the real public page (/media-kit/_preview?preview=1) and hands it
// what the server's preview endpoint returns -- services/mediaKitPayload, the
// same function GET /api/media-kit/:slug uses. So what the builder shows is
// what a brand gets, and a change to the kit lands in one place.
//
// Also here, once for both builders:
//   - the state of each audience number (verified / self-reported / empty),
//     read from the same response, so the label and the page cannot disagree
//   - the "What you get" and "About the athlete" form cards
//
//   KitBuilder.mount({ endpoint, fetchOpts, body, photos, ready })
//   KitBuilder.update()          debounced; call on every form change
//   KitBuilder.storyBody()       the new fields, for the save body
//   KitBuilder.fill(mk)          populate the new fields from a saved kit
(function () {
  'use strict';
  var KIT_WIDTH = 1000;          // the page is laid out at desktop width, then scaled
  var opts = null, frame = null, frameReady = false, pending = null, timer = null, seq = 0, lastHeight = 1200;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  var INPUT = 'width:100%;font-size:12px';
  var STORY_HTML =
    '<div class="card" id="kb-get-card">' +
      '<div class="card-title" style="margin-bottom:4px">What you get</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">What a brand gets from a partnership. Optional: anything left blank is left off the kit, and with nothing filled in there is no section.</div>' +
      '<label class="form-label">Deliverables <span style="font-weight:400;color:var(--muted)">(one per line)</span></label>' +
      '<textarea id="kb-deliverables" class="form-textarea" rows="3" placeholder="2 Instagram posts&#10;1 TikTok video&#10;1 in-store appearance" style="' + INPUT + ';resize:vertical;line-height:1.5"></textarea>' +
      '<div style="display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:8px;margin-top:10px">' +
        '<div><label class="form-label">Price</label><select id="kb-price-mode" class="form-input" style="' + INPUT + '">' +
          '<option value="">No price</option><option value="exact">A number</option><option value="range">A range</option><option value="from">Packages from</option></select></div>' +
        '<div id="kb-price-low-wrap" style="display:none"><label class="form-label" id="kb-price-low-label">Amount ($)</label><input id="kb-price-low" class="form-input" inputmode="numeric" placeholder="1500" style="' + INPUT + '"></div>' +
        '<div id="kb-price-high-wrap" style="display:none"><label class="form-label">To ($)</label><input id="kb-price-high" class="form-input" inputmode="numeric" placeholder="2500" style="' + INPUT + '"></div>' +
      '</div>' +
      '<label class="form-label" style="margin-top:10px">The ask <span style="font-weight:400;color:var(--muted)">(one line)</span></label>' +
      '<input id="kb-ask" class="form-input" maxlength="160" placeholder="Looking for a local partner for the spring season." style="' + INPUT + '">' +
    '</div>' +
    '<div class="card" id="kb-person-card">' +
      '<div class="card-title" style="margin-bottom:4px">About the athlete</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5">Optional. Each one shows only when it is filled in.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">' +
        '<div><label class="form-label">Hometown</label><input id="kb-hometown" class="form-input" maxlength="80" placeholder="Anaheim, CA" style="' + INPUT + '"></div>' +
        '<div><label class="form-label">Class year</label><input id="kb-class-year" class="form-input" maxlength="40" placeholder="Sophomore" style="' + INPUT + '"></div>' +
        '<div><label class="form-label">Major</label><input id="kb-major" class="form-input" maxlength="80" placeholder="Kinesiology" style="' + INPUT + '"></div>' +
      '</div>' +
      '<label class="form-label" style="margin-top:10px">In their own words <span style="font-weight:400;color:var(--muted)">(one short line)</span></label>' +
      '<input id="kb-bio-line" class="form-input" maxlength="200" placeholder="I play for the kids in my neighborhood who are watching." style="' + INPUT + '">' +
      '<label class="form-label" style="margin-top:10px">Previously worked with <span style="font-weight:400;color:var(--muted)">(up to three)</span></label>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">' +
        '<input id="kb-ww-0" class="form-input" maxlength="80" placeholder="Brand or business" style="' + INPUT + '">' +
        '<input id="kb-ww-1" class="form-input" maxlength="80" style="' + INPUT + '">' +
        '<input id="kb-ww-2" class="form-input" maxlength="80" style="' + INPUT + '">' +
      '</div>' +
    '</div>';
  var STORY_IDS = ['kb-deliverables', 'kb-price-mode', 'kb-price-low', 'kb-price-high', 'kb-ask', 'kb-hometown', 'kb-class-year', 'kb-major', 'kb-bio-line', 'kb-ww-0', 'kb-ww-1', 'kb-ww-2'];
  var PLATFORMS = [
    { key: 'instagram', label: 'Instagram', input: 'mk-ig-followers', connectable: true },
    { key: 'tiktok', label: 'TikTok', input: 'mk-tt-followers' },
    { key: 'twitter', label: 'X', input: 'mk-tw-followers' },
  ];

  function syncPriceUI() {
    var mode = ($('kb-price-mode') || {}).value || '';
    if ($('kb-price-low-wrap')) $('kb-price-low-wrap').style.display = mode ? '' : 'none';
    if ($('kb-price-high-wrap')) $('kb-price-high-wrap').style.display = mode === 'range' ? '' : 'none';
    if ($('kb-price-low-label')) $('kb-price-low-label').textContent = mode === 'range' ? 'From ($)' : mode === 'from' ? 'Starting at ($)' : 'Amount ($)';
  }

  function mountFields() {
    // The two new cards, above the rate card (which stays the agent's own
    // reference and never reaches the kit).
    var rate = $('mk-rate-rows'), rateCard = rate && rate.closest('.card');
    if (rateCard && !$('kb-get-card')) {
      var holder = document.createElement('div');
      holder.innerHTML = STORY_HTML;
      while (holder.firstChild) rateCard.parentNode.insertBefore(holder.firstChild, rateCard);
      var t = rateCard.querySelector('.card-title');
      if (t && !$('kb-rate-private')) t.insertAdjacentHTML('beforeend', ' <span id="kb-rate-private" style="font-size:10px;font-weight:600;color:var(--muted);text-transform:none;letter-spacing:0">Private: never shown on the kit</span>');
      STORY_IDS.forEach(function (id) {
        var el = $(id); if (!el) return;
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { if (id === 'kb-price-mode') syncPriceUI(); KitBuilder.update(); });
      });
    }
    // Under each platform's numbers: which state that number is in.
    PLATFORMS.forEach(function (p) {
      var inp = $(p.input); if (!inp || $('kb-state-' + p.key)) return;
      var grid = inp.closest('div').parentNode;
      var d = document.createElement('div');
      d.id = 'kb-state-' + p.key; d.className = 'kb-state';
      d.style.cssText = 'margin-top:7px;font-size:11px;line-height:1.45;color:var(--muted)';
      grid.parentNode.insertBefore(d, grid.nextSibling);
    });
  }

  function mountFrame() {
    var host = $('mk-preview'), wrap = $('mk-preview-wrap');
    if (!host || !wrap || $('kb-frame')) return;
    wrap.style.background = 'transparent'; wrap.style.minHeight = '0';
    host.innerHTML = '<div id="kb-frame-box" style="position:relative;overflow:hidden;height:300px">' +
      '<iframe id="kb-frame" title="Media kit preview" src="/media-kit/_preview?preview=1" scrolling="no" ' +
      'style="border:0;width:' + KIT_WIDTH + 'px;height:1200px;transform-origin:0 0;position:absolute;left:0;top:0;background:transparent"></iframe></div>';
    frame = $('kb-frame');
    if (window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
    window.addEventListener('resize', fit);
    fit();
  }

  function fit() {
    if (!frame) return;
    var box = $('kb-frame-box'), w = box.parentNode.clientWidth || KIT_WIDTH;
    var scale = Math.min(1, w / KIT_WIDTH);
    frame.style.transform = 'scale(' + scale + ')';
    frame.style.height = lastHeight + 'px';
    box.style.height = Math.ceil(lastHeight * scale) + 'px';
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
    var m = e.data || {};
    if (m.type === 'mk-preview-ready') { frameReady = true; if (pending) post(pending); }
    if (m.type === 'mk-preview-height' && m.height) { lastHeight = Math.max(300, m.height); fit(); }
  });

  function post(kit) {
    pending = kit;
    if (frame && frameReady) frame.contentWindow.postMessage({ type: 'mk-preview', kit: kit }, location.origin);
  }

  // The state each audience number is in, next to the number, from the same
  // response the preview renders.
  function renderStates(kit) {
    var byKey = {};
    (kit.audience || []).forEach(function (a) { byKey[a.platform] = a; });
    PLATFORMS.forEach(function (p) {
      var el = $('kb-state-' + p.key); if (!el) return;
      var a = byKey[p.key];
      var typed = Number(String(($(p.input) || {}).value || '').replace(/[,\s]/g, '')) || 0;
      var html;
      if (a && a.state === 'verified') {
        var when = a.fetchedAt ? new Date(a.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        html = '<b style="color:#22C55E">Verified</b> &middot; pulled from the connected account' + (when ? ' on ' + esc(when) : '') +
          '. Brands see ' + esc(fmt(a.followers)) + ', marked "Verified by NILDash".' +
          (typed && typed !== Number(a.followers) ? ' The number typed here is not used.' : '');
      } else if (a) {
        html = '<b style="color:#F59E0B">Self-reported</b> &middot; brands see ' + esc(fmt(a.followers)) + ', labeled "Self-reported".' +
          (p.connectable ? ' Connecting Instagram makes it verified.' : ' ' + p.label + ' can\'t be connected yet, so it stays self-reported.');
      } else {
        html = '<b>Empty</b> &middot; ' + p.label + ' does not appear on the kit.';
      }
      el.innerHTML = html;
    });
  }

  function run() {
    if (!opts || (opts.ready && !opts.ready())) return;
    var my = ++seq;
    var body = Object.assign({}, opts.body(), KitBuilder.storyBody());
    delete body.headshot_data; delete body.action_shot_data;
    var f = Object.assign({ method: 'POST' }, opts.fetchOpts ? opts.fetchOpts() : {});
    f.headers = Object.assign({ 'Content-Type': 'application/json' }, f.headers || {});
    f.body = JSON.stringify(body);
    fetch(opts.endpoint() + '?photos=0', f)
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || 'preview failed'); return j; }); })
      .then(function (kit) {
        if (my !== seq) return;                    // a newer keystroke is on its way
        // The photos stay in the builder (it already holds them) instead of
        // crossing the wire on every keystroke; the page treats them as the
        // public payload does.
        var ph = opts.photos ? opts.photos() : {};
        kit.headshot_url = ph.headshot || null;
        kit.action_shot_data = ph.action || null;
        renderStates(kit);
        post(kit);
      })
      .catch(function (e) { if (window.console) console.warn('[kit preview]', e.message); });
  }

  var KitBuilder = {
    mount: function (o) { opts = o; mountFields(); mountFrame(); syncPriceUI(); },
    update: function () { clearTimeout(timer); timer = setTimeout(run, 250); },
    storyBody: function () {
      var v = function (id) { return (($(id) || {}).value || '').trim(); };
      if (!$('kb-deliverables')) return {};
      return {
        deliverables: v('kb-deliverables').split(/\n/).map(function (x) { return x.trim(); }).filter(Boolean),
        price_mode: v('kb-price-mode') || null, price_low: v('kb-price-low'), price_high: v('kb-price-high'),
        ask_line: v('kb-ask'), hometown: v('kb-hometown'), class_year: v('kb-class-year'), major: v('kb-major'),
        bio_line: v('kb-bio-line'),
        worked_with: [v('kb-ww-0'), v('kb-ww-1'), v('kb-ww-2')].filter(Boolean),
      };
    },
    fill: function (mk) {
      mk = mk || {};
      var set = function (id, val) { var el = $(id); if (el) el.value = val == null ? '' : val; };
      set('kb-deliverables', Array.isArray(mk.deliverables) ? mk.deliverables.join('\n') : '');
      set('kb-price-mode', mk.price_mode || '');
      set('kb-price-low', mk.price_low || ''); set('kb-price-high', mk.price_high || '');
      set('kb-ask', mk.ask_line); set('kb-hometown', mk.hometown); set('kb-class-year', mk.class_year);
      set('kb-major', mk.major); set('kb-bio-line', mk.bio_line);
      var ww = Array.isArray(mk.worked_with) ? mk.worked_with : [];
      for (var i = 0; i < 3; i++) set('kb-ww-' + i, ww[i] || '');
      syncPriceUI();
    },
  };
  window.KitBuilder = KitBuilder;
})();
