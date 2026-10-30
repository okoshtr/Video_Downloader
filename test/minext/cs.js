(() => {
  'use strict';
  if (window.__MIN_CS__) return;
  window.__MIN_CS__ = true;
  const d = document.createElement('div');
  d.id = 'min-marker';
  d.textContent = 'MIN-CS-OK';
  (document.body || document.documentElement).appendChild(d);
})();
