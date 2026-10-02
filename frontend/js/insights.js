/**
 * Wires insights.html — the mistake log made visible. Renders
 * GET /insights/weaknesses and GET /insights/activity, with a real empty
 * state for new users who haven't made enough mistakes yet to show a pattern.
 */

import { MargClient } from './marg-client.js';
import { API_BASE } from './config.js';
import { icons } from './icons.js';
import { escapeHtml } from './format.js';
import { renderShell } from './shell.js';
import { accentClass } from './subjects-ui.js';

const marg = new MargClient(API_BASE);
renderShell('insights');

const el = {
  windowSelect: document.getElementById('window-select'),
  statRow: document.getElementById('stat-row'),
  subjectBars: document.getElementById('subject-bars'),
  weaknessList: document.getElementById('weakness-list'),
};

function renderStats(activity) {
  el.statRow.innerHTML = `
    <div class="stat-tile">
      <div class="stat-tile__value">${activity.sessionsInWindow}</div>
      <div class="stat-tile__label">Sessions started</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile__value">${activity.completedInWindow}</div>
      <div class="stat-tile__label">Sessions completed</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile__value">${activity.stepsCompleted}</div>
      <div class="stat-tile__label">Steps gotten right</div>
    </div>
  `;
}

function renderSubjectBars(activity, subjectsById) {
  if (activity.bySubject.length === 0) {
    el.subjectBars.innerHTML = '<p class="text-dim">Nothing yet — start a session to see a breakdown here.</p>';
    return;
  }

  const max = Math.max(...activity.bySubject.map((s) => s.count));
  el.subjectBars.innerHTML = activity.bySubject.map((row) => {
    const subject = subjectsById.get(row.subjectId);
    const pct = Math.round((row.count / max) * 100);
    return `
      <div class="subject-bar-row">
        <span class="subject-bar-row__label">
          <span class="subject-dot ${subject ? accentClass(subject.accent) : 'dot-amber'}"></span>
          ${escapeHtml(subject?.label ?? row.subjectId)}
        </span>
        <span class="subject-bar-row__track">
          <span class="subject-bar-row__fill" style="width:${pct}%; background: var(--${subject ? accentClass(subject.accent) : 'dot-amber'});"></span>
        </span>
        <span class="subject-bar-row__count">${row.count}</span>
      </div>
    `;
  }).join('');
}

function renderWeaknesses(data) {
  if (data.patterns.length === 0) {
    el.weaknessList.innerHTML = `
      <div class="empty-state card">
        <div class="empty-icon">${icons.streak({ size: 40 })}</div>
        <h3>No patterns yet</h3>
        <p>Nothing to report — keep working through problems and Marg will start noticing what trips you up.</p>
      </div>
    `;
    return;
  }

  el.weaknessList.innerHTML = data.patterns.map((pattern) => `
    <div class="card weakness-card">
      <div class="weakness-card__count">${pattern.count}</div>
      <div class="weakness-card__body">
        <h4>${escapeHtml(pattern.label)}</h4>
        <p>${escapeHtml(pattern.summary)}</p>
        ${pattern.examples.length ? `<p class="weakness-card__examples">"${escapeHtml(pattern.examples[0])}"</p>` : ''}
      </div>
    </div>
  `).join('');
}

async function load(days) {
  el.statRow.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(3);
  el.weaknessList.innerHTML = '<div class="skeleton skeleton-card"></div>'.repeat(2);

  const [{ subjects }, activity, weaknesses] = await Promise.all([
    marg.getSubjects(),
    marg.activity(days),
    marg.weaknesses(days),
  ]);

  const subjectsById = new Map(subjects.map((s) => [s.id, s]));
  renderStats(activity);
  renderSubjectBars(activity, subjectsById);
  renderWeaknesses(weaknesses);
}

el.windowSelect.addEventListener('change', () => load(Number(el.windowSelect.value)));

(async function init() {
  await marg.ready();
  try {
    await load(Number(el.windowSelect.value));
  } catch {
    el.weaknessList.innerHTML = '<p class="text-dim">Could not load your insights right now.</p>';
  }
})();
