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

  var stats = { keys: 0, items: 0, skipped: 0 };
  function log(msg) { try { console.log('[AdFreeTV] ' + msg); } catch (e) {} }

  /** Recursively remove ad keys and ad items. Returns true if anything changed. */
  function prune(node, depth) {
    if (!node || typeof node !== 'object' || depth > 40) return false;
    var changed = false;
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
  JSON.parse = function () {
    var out = origParse.apply(this, arguments);
    if (out && typeof out === 'object') {
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
      var p = origFetch.apply(this, arguments);
      if (!YT_API.test(url)) return p;
      return p.then(function (res) {
        var ct = (res.headers && res.headers.get('content-type')) || '';
        if (ct.indexOf('json') < 0) return res;
        return res.clone().text().then(function (text) {
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
          if (typeof val === 'string' && val.length && (val[0] === '{' || val[0] === '[' || val[0] === ')')) {
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
    var adNow = !!document.querySelector(AD_SELECTOR);
    var video = document.querySelector('video');
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

  log('installed with ' + Object.keys(AD_KEYS).length + ' ad keys: ' + Object.keys(AD_KEYS).join(','));
})();
