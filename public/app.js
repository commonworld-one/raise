// Theme toggle, header menu and share-link copy. No dependencies. (/demo has its own script: public/demo.js.)
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
  // Catalog category selector (filter B): search filter, focus + scroll to the selected option on open,
  // arrow keys move between options, Esc closes. Without JS the <details> still opens and every option
  // is a plain link, so the filter keeps working.
  document.querySelectorAll('details.asel').forEach(function (asel) {
    var q = asel.querySelector('.asel-q'), n = asel.querySelector('.asel-n');
    var links = function () { return Array.prototype.slice.call(asel.querySelectorAll('.asel-i')); };
    var visible = function () { return links().filter(function (a) { return !a.hidden; }); };
    function filter(v) {
      var s = v.trim().toLowerCase();
      links().forEach(function (a) {
        a.hidden = !!s && a.textContent.toLowerCase().indexOf(s) === -1;
      });
      if (n) {
        var total = +(n.getAttribute('data-total') || 0);
        var noun = n.getAttribute('data-noun') || '';
        var allShown = links()[0] && !links()[0].hidden ? 1 : 0; // the "All ..." row is not itself an area/type
        n.textContent = s ? visible().length - allShown + ' of ' + total + ' ' + noun : total + ' ' + noun;
      }
    }
    asel.addEventListener('toggle', function () {
      if (!asel.open) return;
      document.querySelectorAll('details.asel[open]').forEach(function (o) { if (o !== asel) o.open = false; });
      if (q) { q.value = ''; filter(''); q.focus(); }
      var on = asel.querySelector('.asel-i.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    });
    if (q) q.addEventListener('input', function () { filter(q.value); });
    asel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (asel.open) { asel.open = false; var s = asel.querySelector('summary'); if (s) s.focus(); }
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var vis = visible();
      if (!vis.length) return;
      e.preventDefault();
      var i = vis.indexOf(document.activeElement);
      (e.key === 'ArrowDown' ? vis[i + 1] || vis[0] : vis[i - 1] || vis[vis.length - 1]).focus();
    });
    document.addEventListener('click', function (e) {
      if (asel.open && !asel.contains(e.target)) asel.open = false;
    });
  });
})();
