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
  // /demo stage: one message per step (src/stage.ts). Manual by default: Next, Space, Back; slow auto-play on Play.
  var stage = document.getElementById('stage');
  if (stage && window.RaiseStage) {
    var msgs = [].slice.call(stage.querySelectorAll('[data-step]')).sort(function (a, b) { return a.getAttribute('data-step') - b.getAttribute('data-step'); });
    var surfaces = [].slice.call(stage.querySelectorAll('[data-surface]'));
    var surfOf = function (el) { return el.closest('[data-surface]'); };
    var feedOf = function (sf) { return sf.querySelector('[data-feed]'); };
    var nearBottom = function (f) { return f.scrollHeight - f.scrollTop - f.clientHeight < 32; };
    var playBtn = stage.querySelector('[data-act=play]'), counter = stage.querySelector('[data-count-steps]');
    var eng = window.RaiseStage.create({
      steps: msgs.map(function (m) { return { text: m.textContent || '' }; }),
      reducedMotion: reduce.matches,
      onChange: render,
    });
    function render(s, e) {
      var stick = surfaces.map(function (sf) { var f = feedOf(sf); return !f || nearBottom(f); });
      msgs.forEach(function (m, i) {
        var on = i < s.shown; m.classList.toggle('hide', !on);
        m.classList.toggle('enter', on && s.animate && e === 'next' && i === s.active);
      });
      var act = s.active >= 0 ? surfOf(msgs[s.active]) : null;
      stage.classList.toggle('started', !!act);
      surfaces.forEach(function (sf, k) {
        sf.classList.toggle('dim', !!act && sf !== act);
        var last = null; msgs.forEach(function (m, i) { if (i < s.shown && surfOf(m) === sf) last = m; });
        sf.querySelector('.shint').textContent = last ? last.getAttribute('data-hint') : 'Step hint (test)';
        var f = feedOf(sf), nb = sf.querySelector('.newbtn');
        if (!f) return;
        if (e === 'restart' || e === 'goto') { f.scrollTop = 0; nb.hidden = true; return; }
        if (e === 'next' && sf === act) {
          if (stick[k]) { f.scrollTo({ top: f.scrollHeight, behavior: s.scroll }); nb.hidden = true; }
          else nb.hidden = false;
        }
      });
      if (playBtn) playBtn.textContent = s.playing ? '❚❚ Pause' : '▶ Play';
      if (counter) counter.textContent = 'Step ' + s.shown + ' of ' + s.total;
      stage.querySelectorAll('[data-speed]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-speed')) === s.speed)); });
    }
    surfaces.forEach(function (sf) {
      var f = feedOf(sf), nb = sf.querySelector('.newbtn');
      if (!f || !nb) return;
      f.addEventListener('scroll', function () { if (nearBottom(f)) nb.hidden = true; }, { passive: true });
      nb.addEventListener('click', function () { f.scrollTo({ top: f.scrollHeight, behavior: eng.state().scroll }); nb.hidden = true; });
    });
    stage.querySelector('.stagebar').addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      var a = b.getAttribute('data-act'), sp = b.getAttribute('data-speed');
      if (a === 'next') eng.next(); else if (a === 'back') eng.back(); else if (a === 'play') eng.toggle(); else if (a === 'restart') eng.restart();
      else if (sp) eng.setSpeed(Number(sp));
    });
    // Space = next step, only while the stage is on screen and focus is not on a control or a field.
    document.addEventListener('keydown', function (ev) {
      if (ev.code !== 'Space' && ev.key !== ' ') return;
      if (ev.target.closest && ev.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
      var r = stage.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      ev.preventDefault(); eng.next();
    });
    render(eng.state(), 'restart');
  }
  // Demo bar "▶ Play the story" links to /#play: scroll to the story and play it.
  function playFromHash() { if (story && play && location.hash === '#play') { story.scrollIntoView({ block: 'start' }); play.click(); } }
  playFromHash(); addEventListener('hashchange', playFromHash);
})();
