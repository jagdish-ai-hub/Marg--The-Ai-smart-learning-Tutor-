/**
 * A small set of inline SVG icons, as template functions returning markup
 * strings. No icon font, no CDN — each icon is a plain 24x24 stroke-style SVG
 * that inherits `currentColor`, so it always matches surrounding text color.
 *
 * @example
 * el.innerHTML = icons.back();
 * el.innerHTML = icons.hint({ size: 18 });
 */

/**
 * Wraps SVG path content in a consistent, currentColor-inheriting <svg> shell.
 * @param {string} inner - The <path>/<circle>/etc. markup.
 * @param {{ size?: number }} [options]
 * @returns {string}
 */
function svg(inner, { size = 20 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export const icons = {
  back: (opts) => svg('<path d="M15 18l-6-6 6-6"/>', opts),

  send: (opts) => svg('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>', opts),

  hint: (opts) => svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-2.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z"/>', opts),

  camera: (opts) => svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/>', opts),

  check: (opts) => svg('<path d="M20 6 9 17l-5-5"/>', opts),

  circleQuestion: (opts) => svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/>', opts),

  chart: (opts) => svg('<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/>', opts),

  home: (opts) => svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>', opts),

  plus: (opts) => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', opts),

  close: (opts) => svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', opts),

  trash: (opts) => svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', opts),

  pencil: (opts) => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', opts),

  lightbulb: (opts) => svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-2.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z"/>', opts),

  streak: (opts) => svg('<path d="M12 2s5 5.5 5 10a5 5 0 0 1-10 0c0-1.7 1-3 1-3s.5 2 2 2c1 0 1-1 1-2 0-2-2-4-2-4 3-1 3-3 3-3Z"/>', opts),

  refresh: (opts) => svg('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>', opts),
};
