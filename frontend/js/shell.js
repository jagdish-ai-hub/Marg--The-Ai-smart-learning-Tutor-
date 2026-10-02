/**
 * Renders the shared app shell — the top nav that ties app.html, session.html,
 * and insights.html together as one product — into a `<div id="shell">`
 * placeholder on each page. Kept as one JS-rendered partial rather than
 * copy-pasted markup, so the nav only needs to be edited in one place despite
 * this being a no-build, multi-page site.
 *
 * @example
 * // In each page's HTML: <div id="shell"></div>
 * // In each page's JS entry:
 * import { renderShell } from './shell.js';
 * renderShell('home'); // highlights the Home nav item
 */

import { icons } from './icons.js';

/**
 * @param {'home'|'insights'} active - Which nav item to mark current.
 * @returns {void}
 */
export function renderShell(active) {
  const mount = document.getElementById('shell');
  if (!mount) return;

  mount.innerHTML = `
    <div class="shell-inner">
      <a class="shell-brand" href="app.html">
        <span class="script">Marg</span>
      </a>
      <nav class="shell-nav">
        <a href="app.html" class="shell-nav__link${active === 'home' ? ' is-active' : ''}">
          ${icons.home({ size: 18 })}<span>Home</span>
        </a>
        <a href="insights.html" class="shell-nav__link${active === 'insights' ? ' is-active' : ''}">
          ${icons.chart({ size: 18 })}<span>Insights</span>
        </a>
      </nav>
    </div>
  `;
}
