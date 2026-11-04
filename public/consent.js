// Cookie consent + Google Analytics 4, same behaviour as https://commonworld.one/ (its site.js consent block).
// Linked from every page layout and from /demo. No dependencies.
// gtag.js is loaded ONLY after "Accept". Nothing from googletagmanager.com before that: the server renders no
// gtag script, only the hidden banner. The measurement id comes from the banner (data-ga); no banner = no GA.
// The choice is remembered in localStorage ("cw-consent": granted | denied). "Reject" = never load, and any
// _ga cookies left from an earlier "Accept" are cleared.
(function () {
  var store;
  try { store = window.localStorage; } catch (x) { store = null; }
  function get(k) { try { return store && store.getItem(k); } catch (x) { return null; } }
  function set(k, v) { try { store && store.setItem(k, v); } catch (x) {} }

  var banner = document.querySelector('.cw-consent'), GA = banner && banner.getAttribute('data-ga'), loaded = false;
  function gtagStub() {
    if (window.gtag) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
      analytics_storage: 'denied', functionality_storage: 'denied', personalization_storage: 'denied', security_storage: 'granted' });
  }
  function loadGA() {
    if (loaded || !GA) return; loaded = true;
    gtagStub();
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    var s = document.createElement('script'); s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA);
    document.head.appendChild(s);
    window.gtag('js', new Date()); window.gtag('config', GA);
  }
  function clearGACookies() {
    document.cookie.split(';').forEach(function (c) {
      var n = c.split('=')[0].trim();
      if (/^_ga/.test(n)) {
        var parts = location.hostname.split('.');
        for (var i = 0; i < parts.length; i++) document.cookie = n + '=; Max-Age=0; path=/; domain=' + parts.slice(i).join('.');
        document.cookie = n + '=; Max-Age=0; path=/';
      }
    });
  }
  function choose(v) {
    var prev = get('cw-consent'); set('cw-consent', v);
    if (banner) banner.hidden = true;
    if (v === 'granted') loadGA();
    else {
      if (window.gtag) window.gtag('consent', 'update', { analytics_storage: 'denied' });
      clearGACookies();
      if (prev === 'granted' && loaded) location.reload();
    }
  }
  if (GA && banner) {
    var c = get('cw-consent');
    if (c === 'granted') loadGA(); else if (c !== 'denied') banner.hidden = false;
    banner.querySelectorAll('[data-consent]').forEach(function (b) { b.addEventListener('click', function () { choose(b.getAttribute('data-consent')); }); });
    document.querySelectorAll('[data-cookie-settings]').forEach(function (b) {
      b.addEventListener('click', function () { banner.hidden = false; var f = banner.querySelector('button'); f && f.focus(); });
    });
  }
})();
