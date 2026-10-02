/**
 * Small formatting and UI helpers shared across every page: escaping user
 * text before it goes into innerHTML, relative timestamps, and a toast
 * notification system that renders into a single #toast-root element.
 */

/**
 * Escapes text for safe insertion into innerHTML. Every piece of user- or
 * AI-generated text (problem text, chat messages, subject labels) MUST go
 * through this before being templated into markup — nothing here trusts
 * API responses to be free of `<`, `&`, etc.
 *
 * @param {string} value
 * @returns {string}
 *
 * @example
 * el.innerHTML = `<p>${escapeHtml(message.content)}</p>`;
 */
export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

/**
 * Formats an ISO timestamp as a short relative string: "just now", "5m ago",
 * "3h ago", "2d ago", then falls back to a plain date beyond a week.
 *
 * @param {string} isoString
 * @returns {string}
 */
export function timeAgo(isoString) {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '';

  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 30) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Ensures the toast container exists and returns it, creating it once per page.
 * @returns {HTMLElement}
 */
function toastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Shows a toast notification that slides up from the bottom and auto-dismisses.
 *
 * @param {string} message
 * @param {{ variant?: 'default'|'danger', duration?: number }} [options]
 * @returns {void}
 *
 * @example
 * toast('You have asked a lot of questions — give it a minute.', { variant: 'danger' });
 */
export function toast(message, { variant = 'default', duration = 4000 } = {}) {
  const root = toastRoot();
  const el = document.createElement('div');
  el.className = `toast${variant === 'danger' ? ' toast-danger' : ''}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;

  const dismissBtn = document.createElement('button');
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.textContent = '×';
  el.appendChild(dismissBtn);

  const remove = () => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 220);
  };
  dismissBtn.addEventListener('click', remove);

  root.appendChild(el);
  setTimeout(remove, duration);
}

/**
 * Debounces a function so it only runs after `wait` ms of silence.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
export function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
