/**
 * Wires index.html: the "see a worked example" toggle (pure UI, no API), and
 * the subjects grid, which is the landing page's only live data — fetched
 * from GET /subjects so adding a ninth subject on the backend needs no
 * frontend change.
 */

import { MargClient } from './marg-client.js';
import { API_BASE } from './config.js';
import { renderSubjectPills } from './subjects-ui.js';

const marg = new MargClient(API_BASE);

const exampleToggle = document.getElementById('example-toggle');
const exampleCard = document.getElementById('example-card');

exampleToggle.addEventListener('click', () => {
  const isOpen = !exampleCard.hidden;
  exampleCard.hidden = isOpen;
  exampleToggle.setAttribute('aria-expanded', String(!isOpen));
  exampleToggle.textContent = isOpen ? 'See a worked example ↓' : 'Hide the example ↑';
});

async function loadSubjects() {
  const grid = document.getElementById('subjects-grid');
  try {
    const { subjects } = await marg.getSubjects();
    renderSubjectPills(grid, subjects);
  } catch {
    // The landing page should never look broken over a subjects fetch —
    // silently leave the skeleton grid rather than showing an error state
    // before the visitor has even started using the app.
  }
}

loadSubjects();
