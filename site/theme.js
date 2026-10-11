// Thème : Auto (suit le téléphone ou l'ordinateur), Sombre ou Clair.
// Chargé dans <head> sans attendre, pour éviter un flash de la mauvaise couleur.
// Le choix est mémorisé sur cet appareil seulement ; la page marche aussi sans stockage.
(function () {
  var KEY = 'flouter-theme';
  var root = document.documentElement;
  var get = function () { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } };
  var dark = matchMedia('(prefers-color-scheme: dark)');

  function apply(choice) {
    var t = choice === 'auto' ? (dark.matches ? 'dark' : 'light') : choice;
    root.dataset.theme = t;
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = t === 'dark' ? '#0a0e13' : '#f2f4f6';
    var btns = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', btns[i].dataset.themeChoice === choice);
  }

  apply(get());
  dark.addEventListener('change', function () { apply(get()); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-theme-choice]');
    if (!b) return;
    try { localStorage.setItem(KEY, b.dataset.themeChoice); } catch (err) { /* stockage bloqué */ }
    apply(b.dataset.themeChoice);
  });
  document.addEventListener('DOMContentLoaded', function () { apply(get()); });
})();
