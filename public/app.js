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
})();
