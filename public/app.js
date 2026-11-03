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
  if (story && play) play.addEventListener('click', function () {
    var steps = story.querySelectorAll('.bub, .mini'), target = Number(story.dataset.count) || 0;
    var lives = story.querySelectorAll('[data-live]');
    steps.forEach(function (s) { s.classList.add('hide'); });
    lives.forEach(function (l) { l.textContent = '0'; });
    var i = 0;
    (function next() {
      if (i < steps.length) { steps[i].classList.remove('hide'); i++; setTimeout(next, 900); }
    })();
    var start = performance.now(), dur = 2600 + 900 * 3;
    (function tick(now) {
      var k = Math.min(1, (now - start) / dur), v = Math.round(target * (1 - Math.pow(1 - k, 3)));
      if (k >= 1) v = target + 1;
      lives.forEach(function (l) { l.textContent = v.toLocaleString('en-US'); });
      if (k < 1) requestAnimationFrame(tick);
    })(start);
  });
})();
