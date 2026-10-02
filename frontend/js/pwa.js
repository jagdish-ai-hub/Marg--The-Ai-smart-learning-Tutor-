/**
 * Registers the service worker that makes this installable as a web app.
 * Called once from each page's own entry script. Safe to call even in
 * browsers without service worker support — it just does nothing there.
 *
 * @example
 * import { registerServiceWorker } from './pwa.js';
 * registerServiceWorker();
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Installability is a nice-to-have, not a requirement — a failed
      // registration (e.g. running over plain HTTP) should never block
      // the rest of the app from working.
    });
  });
}
