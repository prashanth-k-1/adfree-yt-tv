/*
 * AdFree TV - runs inside youtube.com/tv before YouTube's own code.
 *
 * Layer 2 (data): YouTube's player gets its ad schedule from JSON
 * (adPlacements, playerAds, adSlots, ...). We delete those keys from every
 * JSON response before YouTube reads it, so the player has no ads to play.
 * The key names come from window.__ADFREE_RULES (built-in + auto-updated
 * from uBlock Origin's public lists).
 *
 * Layer 3 (fallback): if an ad still starts, mute it and jump to its end.
 */
(function () {
  'use strict';
  if (window.__adfreeInstalled) return;
  window.__adfreeInstalled = true;

  var rules = window.__ADFREE_RULES || {};
  var AD_KEYS = {};
  (rules.adKeys || ['adPlacements', 'playerAds', 'adSlots']).forEach(function (k) { AD_KEYS[k] = true; });

  // Array items that are whole ad cards in feeds / search results.
  var AD_ITEM = /^ad[A-Z]|[a-z]Ads?(Renderer|Slot)|promoted\w*Renderer|[Pp]romo\w*Renderer$/;

  // --- Sidebar customization ---------------------------------------------------
  // Sidebar entries to remove, by YouTube's icon name (stable, language-independent).
  var HIDE_NAV = {};
  (rules.hideNavIcons || [
    'YOUTUBE_SHORTS_FILL_24', 'SUBSCRIPTIONS', 'YOUTUBE_MUSIC', 'CLAPPERBOARD',
    'LIVE', 'GAMING', 'NEWS', 'TROPHY'
  ]).forEach(function (k) { HIDE_NAV[k] = true; });

  var stats = { keys: 0, items: 0, skipped: 0, nav: 0 };
  function log(msg) { try { console.log('[AdFreeTV] ' + msg); } catch (e) {} }

  /** Remove unwanted sidebar entries; turn Library into our History page. */
  function editGuide(section) {
    var items = section && section.items;
    if (!Array.isArray(items)) return false;
    var before = items.length;
    for (var i = items.length - 1; i >= 0; i--) {
      var e = items[i] && items[i].guideEntryRenderer;
      if (!e) continue;
      var icon = e.icon && e.icon.iconType;
      var ep = e.navigationEndpoint || {};
      var epText = JSON.stringify(ep);
      // Guest mode only: drop the "Sign in" entry too.
      var isSignIn = /signIn|SignIn|sign_in|ACCOUNT_SETTINGS/.test(epText) || /SIGN_IN|ACCOUNT|AVATAR/.test(icon || '');
      if ((icon && HIDE_NAV[icon]) || ep.reelWatchEndpoint || isSignIn) {
        items.splice(i, 1);
        continue;
      }
      if (ep.browseEndpoint && ep.browseEndpoint.browseId === 'FElibrary') {
        e.formattedTitle = { simpleText: 'History' };
        e.accessibility = { accessibilityData: { label: 'History' } };
        e.icon = { iconType: 'WATCH_HISTORY' };
      }
    }
    stats.nav += before - items.length;
    return true;
  }

  // Quick text check: only walk JSON that can contain ads or the sidebar.
  // Keeps the cost near zero for the hundreds of small JSON blobs YouTube parses.
  var keyAlternatives = Object.keys(AD_KEYS).join('|');
  var INTERESTING = new RegExp('"(?:' + keyAlternatives
    + '|ad[A-Z]\\w*|\\w*[a-z]Ads?(?:Renderer|Slot)\\w*|promoted\\w*Renderer|\\w*[Pp]romo\\w*Renderer'
    + '|guideSectionRenderer)"');

  /** Recursively remove ad keys and ad items. Returns true if anything changed. */
  function prune(node, depth) {
    if (!node || typeof node !== 'object' || depth > 40) return false;
    var changed = false;
    if (node.guideSectionRenderer && editGuide(node.guideSectionRenderer)) changed = true;
    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        var item = node[i];
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          var keys = Object.keys(item);
          if (keys.length === 1 && AD_ITEM.test(keys[0])) {
            node.splice(i, 1);
            stats.items++;
            changed = true;
            continue;
          }
        }
        if (prune(item, depth + 1)) changed = true;
      }
      return changed;
    }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (AD_KEYS[k]) {
        delete node[k];
        stats.keys++;
        changed = true;
      } else if (node[k] && typeof node[k] === 'object') {
        if (prune(node[k], depth + 1)) changed = true;
      }
    }
    return changed;
  }

  function safePrune(obj) {
    try { return prune(obj, 0); } catch (e) { return false; }
  }

  var YT_API = /\/youtubei\/v1\/|\/get_video_info|\/watch\?|\/browse_ajax|\/player/;

  // --- JSON.parse: catches most of YouTube's data ---------------------------
  var origParse = JSON.parse;
  JSON.parse = function (text) {
    var out = origParse.apply(this, arguments);
    if (out && typeof out === 'object' && (typeof text !== 'string' || INTERESTING.test(text))) {
      if (safePrune(out)) log('pruned JSON.parse result (keys=' + stats.keys + ', items=' + stats.items + ')');
    }
    return out;
  };
  JSON.parse.toString = function () { return origParse.toString(); };

  // --- fetch: rewrite API responses ----------------------------------------
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        var fb = init && typeof init.body === 'string' ? init.body : '';
        if (fb && url.indexOf('/youtubei/v1/search') >= 0) noteSearch(origParse(fb).query);
        if (fb && url.indexOf('/youtubei/v1/browse') >= 0 && fb.indexOf('"FElibrary"') >= 0) setTimeout(openHistory, 0);
      } catch (e) {}
      var p = origFetch.apply(this, arguments);
      if (!YT_API.test(url)) return p;
      return p.then(function (res) {
        var ct = (res.headers && res.headers.get('content-type')) || '';
        if (ct.indexOf('json') < 0) return res;
        return res.clone().text().then(function (text) {
          if (!INTERESTING.test(text)) return res;
          var obj;
          try { obj = origParse(text.replace(/^\)\]\}'\n?/, '')); } catch (e) { return res; }
          if (!safePrune(obj)) return res;
          log('pruned fetch ' + url.split('?')[0]);
          return new Response(JSON.stringify(obj), {
            status: res.status, statusText: res.statusText, headers: res.headers
          });
        }, function () { return res; });
      });
    };
  }

  // --- XMLHttpRequest: YouTube's TV app uses this a lot ---------------------
  var XHR = XMLHttpRequest.prototype;
  var origOpen = XHR.open;
  XHR.open = function (method, url) {
    this.__adfreeUrl = String(url || '');
    return origOpen.apply(this, arguments);
  };
  function wrapGetter(prop) {
    var desc = Object.getOwnPropertyDescriptor(XHR, prop);
    if (!desc || !desc.get) return;
    Object.defineProperty(XHR, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        var val = desc.get.call(this);
        if (this.readyState !== 4 || !this.__adfreeUrl || !YT_API.test(this.__adfreeUrl)) return val;
        if (this.__adfreeCache && this.__adfreeCache.src === val) return this.__adfreeCache.out;
        var out = val;
        try {
          if (typeof val === 'string' && val.length && (val[0] === '{' || val[0] === '[' || val[0] === ')')
              && INTERESTING.test(val)) {
            var prefix = val.match(/^\)\]\}'\n?/);
            var obj = origParse(prefix ? val.slice(prefix[0].length) : val);
            if (safePrune(obj)) {
              out = (prefix ? prefix[0] : '') + JSON.stringify(obj);
              log('pruned XHR ' + this.__adfreeUrl.split('?')[0]);
            }
          } else if (val && typeof val === 'object' && !(val instanceof ArrayBuffer) && !(val instanceof Blob)) {
            safePrune(val);
          }
        } catch (e) { out = val; }
        this.__adfreeCache = { src: val, out: out };
        return out;
      }
    });
  }
  wrapGetter('responseText');
  wrapGetter('response');

  // --- Data embedded in the page --------------------------------------------
  ['ytInitialPlayerResponse', 'ytInitialData', 'ytplayer'].forEach(function (name) {
    var value = window[name];
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return value; },
        set: function (v) { safePrune(v); value = v; }
      });
    } catch (e) {}
  });

  // --- Fallback: skip any ad that still plays -------------------------------
  var AD_SELECTOR = [
    '.ad-showing', '.ad-interrupting',
    'ytlr-ad-badge-renderer', 'ytlr-ad-preview-renderer', 'ytlr-skip-ad-renderer',
    'ytlr-player-ad-overlay-renderer', 'ytlr-ad-info-dialog-renderer',
    '[class*="ytlr-ad-"]'
  ].join(',');
  var SKIP_SELECTOR = [
    '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad-button',
    'ytlr-skip-button-renderer', 'ytlr-skip-ad-renderer', '[class*="skip-button"]', '[class*="SkipButton"]'
  ].join(',');

  var wasAd = false;
  setInterval(function () {
    var video = document.querySelector('video');
    if (!video && !wasAd) return; // nothing playing: nothing to check
    var adNow = !!document.querySelector(AD_SELECTOR);
    if (adNow && video) {
      if (!wasAd) { stats.skipped++; log('ad detected on screen -> skipping (#' + stats.skipped + ')'); }
      video.muted = true;
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
        try { video.currentTime = video.duration; } catch (e) {}
      }
      video.playbackRate = 16;
      var btn = document.querySelector(SKIP_SELECTOR);
      if (btn) { try { btn.click(); } catch (e) {} }
    } else if (wasAd && video) {
      video.muted = false;
      video.playbackRate = 1;
    }
    wasAd = adNow;
  }, 300);

  // ===========================================================================
  // History (guest mode): YouTube keeps no history when signed out, so we keep
  // our own on this device only (localStorage) - watched videos and searches.
  // Opened from the sidebar entry that used to be "Library".
  // ===========================================================================
  var HKEY = 'adfree.history.v1';
  var MAX_WATCH = 200, MAX_SEARCH = 50;

  function loadHistory() {
    try {
      var h = origParse(localStorage.getItem(HKEY) || 'null');
      if (h && h.watch && h.search) return h;
    } catch (e) {}
    return { watch: [], search: [] };
  }
  function saveHistory(h) {
    try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) {}
  }
  function addWatch(id) {
    var h = loadHistory();
    var old = null;
    h.watch = h.watch.filter(function (w) { if (w.id === id) { old = w; return false; } return true; });
    h.watch.unshift({ id: id, title: old && old.title, author: old && old.author, at: Date.now() });
    h.watch.length = Math.min(h.watch.length, MAX_WATCH);
    saveHistory(h);
    if (!old || !old.title) fetchTitle(id);
  }
  function fetchTitle(id) {
    var origFetchFn = window.__adfreeOrigFetch || window.fetch;
    origFetchFn('https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) {
        if (!o) return;
        var h = loadHistory();
        h.watch.forEach(function (w) { if (w.id === id) { w.title = o.title; w.author = o.author_name; } });
        saveHistory(h);
      }).catch(function () {});
  }
  var searchTimer = null;
  function noteSearch(q) {
    q = (q || '').trim();
    if (q.length < 2) return;
    // YouTube searches while you type; keep only the final query.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var h = loadHistory();
      h.search = h.search.filter(function (s) { return s.q.toLowerCase() !== q.toLowerCase(); });
      h.search.unshift({ q: q, at: Date.now() });
      h.search.length = Math.min(h.search.length, MAX_SEARCH);
      saveHistory(h);
    }, 2500);
  }

  // Record searches from YouTube's own search requests.
  var origSend = XHR.send;
  XHR.send = function (body) {
    try {
      var u = this.__adfreeUrl || '';
      if (typeof body === 'string' && body) {
        if (u.indexOf('/youtubei/v1/search') >= 0) noteSearch(origParse(body).query);
        // The sidebar's History entry (formerly Library) asks YouTube for FElibrary.
        if (u.indexOf('/youtubei/v1/browse') >= 0 && body.indexOf('"FElibrary"') >= 0) {
          setTimeout(openHistory, 0);
        }
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // Record watched videos from the address (#/watch?v=...).
  var lastWatched = null;
  function onRoute() {
    var m = location.hash.match(/[#&?\/]watch\?(?:.*&)?v=([\w-]{11})/);
    if (m && m[1] !== lastWatched) { lastWatched = m[1]; addWatch(m[1]); }
    if (/FElibrary/.test(location.hash)) openHistory();
  }
  window.addEventListener('hashchange', onRoute);
  document.addEventListener('DOMContentLoaded', onRoute);

  // --- History page (our own overlay, driven by the remote's arrow keys) ---
  var overlay = null, focusables = [], focusIdx = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ago(t) {
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function openHistory() {
    if (overlay) return;
    var css = el('style');
    css.textContent =
      '#adfree-h{position:fixed;inset:0;z-index:2147483647;background:#0f0f0f;color:#f1f1f1;' +
      'font-family:Roboto,"YouTube Sans",Arial,sans-serif;overflow:hidden;padding:4vh 5vw;box-sizing:border-box}' +
      '#adfree-h h1{font-size:4.2vh;margin:0 0 3vh;font-weight:700}' +
      '#adfree-h h2{font-size:2.6vh;margin:3vh 0 1.6vh;color:#aaa;font-weight:500}' +
      '#adfree-h .row{display:flex;gap:1.6vw;overflow:hidden;padding:0.8vh 0.4vw}' +
      '#adfree-h .card{flex:0 0 22vw;border-radius:1.2vh;outline:none;transition:transform .12s}' +
      '#adfree-h .card img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:1.2vh;background:#222;display:block}' +
      '#adfree-h .t{font-size:2.1vh;margin-top:1vh;line-height:1.3;max-height:5.5vh;overflow:hidden}' +
      '#adfree-h .s{font-size:1.7vh;color:#aaa;margin-top:.4vh}' +
      '#adfree-h .chip{flex:0 0 auto;padding:1.4vh 2.2vw;border-radius:5vh;background:#272727;font-size:2.2vh;outline:none}' +
      '#adfree-h .btn{display:inline-block;margin-top:3vh;padding:1.2vh 2vw;border-radius:5vh;background:#272727;font-size:2vh}' +
      '#adfree-h .f{background:#f1f1f1!important;color:#0f0f0f}' +
      '#adfree-h .card.f{background:none!important;transform:scale(1.05)}' +
      '#adfree-h .card.f img{box-shadow:0 0 0 .5vh #f1f1f1}' +
      '#adfree-h .card.f .t{color:#fff}' +
      '#adfree-h .empty{color:#888;font-size:2.2vh}' +
      '#adfree-h .hint{position:absolute;bottom:3vh;left:5vw;color:#777;font-size:1.8vh}';
    overlay = el('div');
    overlay.id = 'adfree-h';
    overlay.appendChild(css);
    render();
    document.documentElement.appendChild(overlay);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('keypress', swallow, true);
  }

  function render() {
    var h = loadHistory();
    while (overlay.childNodes.length > 1) overlay.removeChild(overlay.lastChild);
    focusables = [];
    overlay.appendChild(el('h1', null, 'History'));

    overlay.appendChild(el('h2', null, 'Watched'));
    var row1 = el('div', 'row');
    if (!h.watch.length) row1.appendChild(el('div', 'empty', 'Videos you watch will appear here.'));
    h.watch.slice(0, 40).forEach(function (w) {
      var c = el('div', 'card');
      var img = el('img');
      img.src = 'https://i.ytimg.com/vi/' + w.id + '/mqdefault.jpg';
      c.appendChild(img);
      c.appendChild(el('div', 't', w.title || 'Video'));
      c.appendChild(el('div', 's', (w.author ? w.author + ' · ' : '') + ago(w.at)));
      c.__go = function () { closeHistory('#/watch?v=' + w.id); };
      c.__row = 0;
      row1.appendChild(c);
      focusables.push(c);
    });
    overlay.appendChild(row1);

    overlay.appendChild(el('h2', null, 'Searches'));
    var row2 = el('div', 'row');
    if (!h.search.length) row2.appendChild(el('div', 'empty', 'Your searches will appear here.'));
    h.search.slice(0, 30).forEach(function (s) {
      var c = el('div', 'chip', s.q);
      c.__go = function () { closeHistory('#/search?q=' + encodeURIComponent(s.q)); };
      c.__row = 1;
      row2.appendChild(c);
      focusables.push(c);
    });
    overlay.appendChild(row2);

    if (h.watch.length || h.search.length) {
      var clr = el('div', 'btn', 'Clear history');
      clr.__go = function () {
        saveHistory({ watch: [], search: [] });
        focusIdx = 0;
        render();
      };
      clr.__row = 2;
      overlay.appendChild(clr);
      focusables.push(clr);
    }
    overlay.appendChild(el('div', 'hint', 'OK: open   ·   Back: close'));
    focusIdx = Math.min(focusIdx, Math.max(0, focusables.length - 1));
    paintFocus();
  }

  function paintFocus() {
    focusables.forEach(function (f, i) { f.classList.toggle('f', i === focusIdx); });
    var f = focusables[focusIdx];
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function move(dRow, dCol) {
    if (!focusables.length) return;
    var cur = focusables[focusIdx];
    if (dCol) {
      var n = focusIdx + dCol;
      if (focusables[n] && focusables[n].__row === cur.__row) focusIdx = n;
    } else {
      var target = cur.__row + dRow;
      // jump to the first item of the next/previous non-empty row
      while (target >= 0 && target <= 2) {
        for (var i = 0; i < focusables.length; i++) {
          if (focusables[i].__row === target) { focusIdx = i; paintFocus(); return; }
        }
        target += dRow;
      }
    }
    paintFocus();
  }

  function onKey(e) {
    var k = e.keyCode || 0, key = e.key;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (key === 'ArrowLeft' || k === 37) move(0, -1);
    else if (key === 'ArrowRight' || k === 39) move(0, 1);
    else if (key === 'ArrowUp' || k === 38) move(-1, 0);
    else if (key === 'ArrowDown' || k === 40) move(1, 0);
    else if (key === 'Enter' || k === 13) { var f = focusables[focusIdx]; if (f && f.__go) f.__go(); }
    else if (key === 'Escape' || key === 'Backspace' || k === 27 || k === 8 || k === 461) closeHistory('#/');
  }
  function swallow(e) { e.preventDefault(); e.stopImmediatePropagation(); }

  function closeHistory(goTo) {
    if (!overlay) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', swallow, true);
    window.removeEventListener('keypress', swallow, true);
    overlay.remove();
    overlay = null;
    if (goTo) location.hash = goTo;
  }

  // ===========================================================================
  // Smoother start: YouTube's player flashes a big grey play button over the
  // thumbnail for a moment while a video loads ("unstarted" state). Hide it so
  // the screen stays black until the video actually starts.
  // ===========================================================================
  (function addStartCss() {
    var css = document.createElement('style');
    css.textContent =
      '.html5-video-player.unstarted-mode .ytp-large-play-button,' +
      '.html5-video-player.unstarted-mode .ytp-cued-thumbnail-overlay,' +
      '.html5-video-player.buffering-mode.unstarted-mode .ytp-spinner-container{visibility:hidden!important}' +
      '.html5-video-player.unstarted-mode{background:#000!important}';
    (document.head || document.documentElement).appendChild(css);
  })();

  // ===========================================================================
  // Voice search. The TV app (MainActivity) listens with the remote's mic and
  // calls window.__adfreeSearch(text). YouTube's own mic button (if shown) uses
  // the Web Speech API, which Android WebView lacks - so we provide it, backed
  // by the TV's speech recognizer through the AdFreeVoice bridge.
  // ===========================================================================
  window.__adfreeSearch = function (q) {
    q = String(q || '').trim();
    if (!q) return;
    if (overlay) closeHistory(null);
    noteSearch(q);
    location.hash = '#/search?q=' + encodeURIComponent(q);
    log('voice search: ' + q);
  };

  var activeRecognizer = null;
  window.__adfreeVoiceResult = function (text) {
    var r = activeRecognizer;
    activeRecognizer = null;
    if (r && typeof r.onresult === 'function') {
      var alt = { transcript: text, confidence: 0.9 };
      var res = [alt]; res.isFinal = true; res.item = function (i) { return res[i]; };
      var list = [res]; list.item = function (i) { return list[i]; };
      try { r.onresult({ results: list, resultIndex: 0 }); } catch (e) {}
      try { if (r.onend) r.onend(); } catch (e) {}
    } else {
      window.__adfreeSearch(text);
    }
  };
  window.__adfreeVoiceEnd = function () {
    var r = activeRecognizer;
    activeRecognizer = null;
    try { if (r && r.onend) r.onend(); } catch (e) {}
  };

  if (window.AdFreeVoice && !window.webkitSpeechRecognition) {
    var Shim = function () { this.lang = ''; this.continuous = false; this.interimResults = false; };
    Shim.prototype.start = function () {
      activeRecognizer = this;
      try { if (this.onstart) this.onstart(); } catch (e) {}
      window.AdFreeVoice.start();
    };
    Shim.prototype.stop = Shim.prototype.abort = function () {
      if (activeRecognizer === this) activeRecognizer = null;
      try { if (this.onend) this.onend(); } catch (e) {}
    };
    Shim.prototype.addEventListener = function (type, fn) { this['on' + type] = fn; };
    window.webkitSpeechRecognition = window.SpeechRecognition = Shim;
  }

  // ===========================================================================
  // Guest by default: skip YouTube's "Who's watching?" screen by choosing
  // "Watch as guest" - but only while no Google account has been added. Once you
  // sign in (for example through YouTube's "confirm you're not a bot" screen),
  // the app stops choosing guest and keeps your account.
  // ===========================================================================
  var SIGNED_IN_KEY = 'adfree.signedIn';
  function signedIn() {
    try {
      if (localStorage.getItem(SIGNED_IN_KEY) === '1') return true;
      var cfg = window.ytcfg && window.ytcfg.get && window.ytcfg.get('LOGGED_IN');
      if (cfg === true) { localStorage.setItem(SIGNED_IN_KEY, '1'); return true; }
    } catch (e) {}
    return false;
  }
  var guestTries = 0;
  var guestTimer = setInterval(function () {
    if (++guestTries > 120 || signedIn()) { clearInterval(guestTimer); return; } // ~60s max
    var items = document.querySelectorAll('[role="menuitem"]');
    var guest = null, account = false;
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].innerText || items[i].textContent || '').trim();
      if (/guest/i.test(t)) guest = items[i];
      else if (t && !/sign in|add account|another account|get started|settings|search/i.test(t)) account = true;
    }
    if (account) {
      // A Google account is on this TV: let it be used instead of guest.
      log('account found - not choosing guest');
      clearInterval(guestTimer);
      return;
    }
    if (guest) {
      var target = guest.closest('ytlr-button, ytlr-button-renderer, [tabindex]') || guest;
      target.click();
      log('chose "Watch as guest" automatically');
      clearInterval(guestTimer);
    }
  }, 500);

  log('installed with ' + Object.keys(AD_KEYS).length + ' ad keys: ' + Object.keys(AD_KEYS).join(','));
})();
