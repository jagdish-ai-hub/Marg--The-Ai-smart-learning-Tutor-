/**
 * Renders subjects fetched live from GET /subjects. Shared by the landing
 * page (decorative pills) and the home screen (clickable selection tiles) so
 * both stay in sync with whatever the backend actually returns — the eight
 * subjects, their labels, and their accent colors are never hardcoded here.
 */

import { escapeHtml } from './format.js';

/** Maps the backend's accent token to a CSS class. Never hardcode a hex color. */
const ACCENT_CLASS = { amber: 'dot-amber', blue: 'dot-blue', green: 'dot-green', rose: 'dot-rose' };

/**
 * @param {string} accent - One of 'amber' | 'blue' | 'green' | 'rose'.
 * @returns {string} CSS class name.
 */
export function accentClass(accent) {
  return ACCENT_CLASS[accent] ?? 'dot-amber';
}

/**
 * Renders subjects as plain decorative pills (landing page — links to app.html).
 * @param {HTMLElement} container
 * @param {object[]} subjects
 */
export function renderSubjectPills(container, subjects) {
  // A hash, not a query string: some static hosts (this repo's own dev
  // server included) 301-redirect "file.html?x=y" to "/file", silently
  // dropping the query string. A hash fragment is never sent to the server
  // at all, so it survives any host's URL-cleanup behavior.
  container.innerHTML = subjects.map((subject) => `
    <a class="subject-pill" href="app.html#${encodeURIComponent(subject.id)}">
      <span class="subject-dot ${accentClass(subject.accent)}"></span>
      ${escapeHtml(subject.label)}
    </a>
  `).join('');
}

/**
 * Renders subjects as selectable tiles (home screen). Calls `onSelect` with
 * the subject id when a tile is clicked, and toggles `.is-selected`.
 *
 * @param {HTMLElement} container
 * @param {object[]} subjects
 * @param {(subjectId: string) => void} onSelect
 * @param {string} [selectedId]
 */
export function renderSubjectTiles(container, subjects, onSelect, selectedId) {
  container.innerHTML = subjects.map((subject) => `
    <button type="button" class="subject-tile${subject.id === selectedId ? ' is-selected' : ''}" data-subject-id="${escapeHtml(subject.id)}">
      <span class="subject-dot ${accentClass(subject.accent)}"></span>
      <span class="subject-tile__label">${escapeHtml(subject.label)}</span>
    </button>
  `).join('');

  container.querySelectorAll('.subject-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      container.querySelectorAll('.subject-tile').forEach((t) => t.classList.remove('is-selected'));
      tile.classList.add('is-selected');
      onSelect(tile.dataset.subjectId);
    });
  });
}
