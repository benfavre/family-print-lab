'use strict';
// Applies the saved color theme before first paint. "auto" follows the system light/dark setting.
(() => {
  let saved = 'auto';
  try { saved = localStorage.getItem('print-lab-theme') || 'auto'; } catch {}
  const light = matchMedia('(prefers-color-scheme: light)').matches;
  const theme = saved === 'auto' ? (light ? 'arctic' : 'holo') : saved;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = saved;
})();
