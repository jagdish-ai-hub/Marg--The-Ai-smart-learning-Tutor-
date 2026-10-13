/**
 * Renders the shared app shell — the top nav that ties app.html, session.html,
 * and insights.html together as one product — into a `<div id="shell">`
 * placeholder on each page. Kept as one JS-rendered partial rather than
 * copy-pasted markup, so the nav only needs to be edited in one place despite
 * this being a no-build, multi-page site.
 *
 * Also owns the account corner: a "Sign in with Google" button for guests,
 * or the signed-in email once they have one. Passing the page's `marg`
 * client is what lets it know which. The nav paints immediately either way
 * — it never waits on a network round trip — and only upgrades itself in
 * the background if it turns out a Google sign-in just completed.
 *
 * @example
 * // In each page's HTML: <div id="shell"></div>
 * // In each page's JS entry:
 * import { renderShell } from './shell.js';
 * renderShell('home', marg); // highlights the Home nav item
 */

import { icons } from './icons.js';
import { escapeHtml, toast } from './format.js';
import * as googleAuth from './auth.js';

/**
 * @param {'home'|'insights'} active - Which nav item to mark current.
 * @param {import('./marg-client.js').MargClient} [marg] - The page's client,
 *   so the account corner can reflect guest vs. signed-in state. Omit it to
 *   render just the nav with no account corner.
 * @returns {void}
 */
export function renderShell(active, marg) {
  const mount = document.getElementById('shell');
  if (!mount) return;

  const paint = () => {
    const accountHtml = !marg
      ? ''
      : marg.isGuest
        ? googleAuth.isConfigured
          ? `<button class="btn btn-ghost btn-sm" id="shell-signin-btn">${icons.user({ size: 15 })}<span>Sign in with Google</span></button>`
          : ''
        : `<span class="shell-account" title="Signed in">${icons.user({ size: 15 })}<span>${escapeHtml(marg.email ?? 'Signed in')}</span></span>`;

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
        <div class="shell-account-slot">${accountHtml}</div>
      </div>
    `;

    document.getElementById('shell-signin-btn')?.addEventListener('click', async () => {
      try {
        await googleAuth.signInWithGoogle();
      } catch {
        toast('Could not start Google sign-in. Please try again.', { variant: 'danger' });
      }
    });
  };

  paint();

  // A page can load straight into an already-completed Google redirect —
  // Better Auth's session cookie is already set, but Marg has not exchanged
  // it for a token yet. Check in the background and repaint once that
  // finishes, rather than blocking the nav's first paint on a network call.
  if (marg && marg.isGuest && googleAuth.isConfigured) {
    (async () => {
      try {
        const googleSession = await googleAuth.getGoogleSession();
        if (!googleSession) return;
        const neonAuthToken = await googleAuth.getGoogleToken();
        if (!neonAuthToken) return;
        await marg.signInWithGoogle(neonAuthToken);
        paint();
      } catch {
        // Not signed in with Google, or the exchange failed — stay a guest.
        // There's always next time.
      }
    })();
  }
}
