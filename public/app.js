// Theme toggle, share-link copy, and the demo story player. No dependencies.
(function () {
  var d = document.documentElement, t = document.getElementById('theme');
  function label() { if (t) t.textContent = d.dataset.theme === 'dark' ? '☀︎ Light' : '☾ Dark'; }
  label();
  // #3: collapsible header menu on narrow screens.
  var nt = document.getElementById('navtoggle'), hd = nt && nt.closest('header');
  if (nt && hd) nt.addEventListener('click', function () {
    var open = hd.classList.toggle('open'); nt.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  if (t) t.addEventListener('click', function () {
    d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('raise-theme', d.dataset.theme); label();
  });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () {
        var o = b.textContent; b.textContent = 'Link copied'; setTimeout(function () { b.textContent = o; }, 1500);
      }, function () { prompt('Copy this link', v); });
    });
  });
  var story = document.getElementById('story'), play = document.getElementById('play');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // The story counter is scripted: 1 (Atlas raises it), 2 when Nova joins, then the finale ramps to
  // 1,000,000 over ~7 s and shows "Granted ✨". Bubble timing is unchanged (one every 900 ms).
  var GOAL = 1000000, RAMP_MS = 7000;
  if (story && play) play.addEventListener('click', function () {
    var steps = story.querySelectorAll('.bub, .mini');
    var lives = story.querySelectorAll('[data-live]'), nexts = story.querySelectorAll('[data-next]');
    var granted = story.querySelector('[data-granted]'), run = (story._run = (story._run || 0) + 1);
    function show(v) { lives.forEach(function (l) { l.textContent = Math.round(v).toLocaleString('en-US'); }); }
    steps.forEach(function (s) { s.classList.add('hide'); });
    if (granted) granted.hidden = true;
    show(1); nexts.forEach(function (n) { n.textContent = '2'; });
    var i = 0;
    (function next() {
      if (run !== story._run) return;
      if (i < steps.length) {
        var s = steps[i]; s.classList.remove('hide'); i++;
        if (s.querySelector('[data-next]')) show(2);
        setTimeout(next, 900);
      } else finale();
    })();
    function finale() {
      if (reduce.matches) { show(GOAL); if (granted) granted.hidden = false; return; }
      var start = performance.now();
      (function tick(now) {
        if (run !== story._run) return;
        var k = Math.min(1, (now - start) / RAMP_MS);
        show(2 + (GOAL - 2) * (k < 1 ? Math.pow(k, 3) : 1));
        if (k < 1) requestAnimationFrame(tick); else if (granted) granted.hidden = false;
      })(start);
    }
  });
  // Demo bar "▶ Play the story" links to /#play: scroll to the story and play it.
  function playFromHash() { if (story && play && location.hash === '#play') { story.scrollIntoView({ block: 'start' }); play.click(); } }
  playFromHash(); addEventListener('hashchange', playFromHash);
})();
