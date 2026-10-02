/**
 * Wires app.html — the home screen: subject picker, the composer (text, or a
 * photo that gets transcribed first), the session list, and the standalone
 * concept-explainer modal.
 */

import { MargClient } from './marg-client.js';
import { API_BASE } from './config.js';
import { icons } from './icons.js';
import { escapeHtml, timeAgo, toast } from './format.js';
import { renderShell } from './shell.js';
import { renderSubjectTiles, accentClass } from './subjects-ui.js';
import { registerServiceWorker } from './pwa.js';

registerServiceWorker();

const marg = new MargClient(API_BASE);
renderShell('home');

/** @type {Map<string, object>} subjectId -> subject, filled once subjects load */
const subjectsById = new Map();
// A hash, not a query string — see the comment in subjects-ui.js: some static
// hosts 301-redirect "?query=strings" away, but a hash never reaches the server.
let selectedSubjectId = decodeURIComponent(location.hash.slice(1)) || null;

const el = {
  subjectsGrid: document.getElementById('subjects-grid'),
  problemInput: document.getElementById('problem-input'),
  composerError: document.getElementById('composer-error'),
  startBtn: document.getElementById('start-session-btn'),
  refusalBanner: document.getElementById('refusal-banner'),
  sessionsList: document.getElementById('sessions-list'),
  photoBtn: document.getElementById('photo-btn'),
  photoInput: document.getElementById('photo-input'),
  photoPreview: document.getElementById('photo-preview'),
  photoModal: document.getElementById('photo-modal'),
  photoProblemsList: document.getElementById('photo-problems-list'),
  conceptBtn: document.getElementById('concept-btn'),
  conceptModal: document.getElementById('concept-modal'),
  conceptForm: document.getElementById('concept-form'),
  conceptResult: document.getElementById('concept-result'),
  conceptSubject: document.getElementById('concept-subject'),
  conceptText: document.getElementById('concept-text'),
  conceptDepth: document.getElementById('concept-depth'),
  conceptSubmit: document.getElementById('concept-submit'),
  conceptAgain: document.getElementById('concept-again'),
  conceptAnswer: document.getElementById('concept-answer'),
};

document.getElementById('concept-icon').innerHTML = icons.circleQuestion({ size: 16 });
document.getElementById('camera-icon').innerHTML = icons.camera({ size: 18 });
document.getElementById('close-icon-1').innerHTML = icons.close({ size: 18 });
document.getElementById('close-icon-2').innerHTML = icons.close({ size: 18 });

/** Shows a message near the composer's own error slot rather than a toast. */
function setComposerError(message) {
  el.composerError.textContent = message ?? '';
  el.composerError.hidden = !message;
}

// ---------------------------------------------------------------------------
// Subjects + provider capabilities
// ---------------------------------------------------------------------------

async function loadSubjects() {
  const { subjects } = await marg.getSubjects();
  subjects.forEach((subject) => subjectsById.set(subject.id, subject));

  renderSubjectTiles(el.subjectsGrid, subjects, (id) => {
    selectedSubjectId = id;
    setComposerError(null);
  }, selectedSubjectId);

  el.conceptSubject.innerHTML = subjects
    .map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`)
    .join('');
}

async function checkVisionSupport() {
  try {
    const { supportsVision } = await marg.getProviders();
    el.photoBtn.hidden = !supportsVision;
  } catch {
    el.photoBtn.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Composer: create a session
// ---------------------------------------------------------------------------

async function handleStartSession() {
  const problem = el.problemInput.value.trim();
  setComposerError(null);
  el.refusalBanner.hidden = true;

  if (!selectedSubjectId) return setComposerError('Pick a subject first.');
  if (problem.length < 3) return setComposerError('Tell Marg a bit more about what you\'re stuck on.');

  el.startBtn.disabled = true;
  el.startBtn.textContent = 'Working out where to start…';

  try {
    const result = await marg.createSession(selectedSubjectId, problem);

    if (result.refused) {
      el.refusalBanner.hidden = false;
      el.refusalBanner.textContent = result.message.content;
      return;
    }

    window.location.href = `session.html#${encodeURIComponent(result.session.id)}`;
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED') {
      setComposerError(err.details?.fields?.[0]?.message ?? err.message);
    } else if (err.code === 'RATE_LIMITED') {
      toast(err.message, { variant: 'danger' });
    } else {
      toast(`Marg couldn't start that session. Reference: ${err.requestId ?? 'n/a'}`, { variant: 'danger' });
    }
  } finally {
    el.startBtn.disabled = false;
    el.startBtn.textContent = 'Start a session';
  }
}

el.startBtn.addEventListener('click', handleStartSession);

// ---------------------------------------------------------------------------
// Photo upload -> transcribe -> pick a problem
// ---------------------------------------------------------------------------

el.photoBtn.addEventListener('click', () => el.photoInput.click());

el.photoInput.addEventListener('change', async () => {
  const file = el.photoInput.files[0];
  if (!file) return;

  el.photoPreview.hidden = false;
  el.photoPreview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Uploaded page" />`;
  el.startBtn.disabled = true;
  el.startBtn.textContent = 'Reading the page…';

  try {
    const { subjectId, problems, studentWorking } = await marg.transcribe(file);

    if (subjectId && subjectsById.has(subjectId)) {
      selectedSubjectId = subjectId;
      renderSubjectTiles(el.subjectsGrid, [...subjectsById.values()], (id) => { selectedSubjectId = id; }, selectedSubjectId);
    }

    if (problems.length === 0) {
      toast('Marg couldn\'t make out a problem in that photo — try typing it instead.', { variant: 'danger' });
      return;
    }

    if (problems.length === 1) {
      el.problemInput.value = studentWorking ? `${problems[0].text}\n\nMy working: ${studentWorking}` : problems[0].text;
      return;
    }

    openProblemPicker(problems, studentWorking);
  } catch (err) {
    toast(err.message ?? 'Could not read that photo.', { variant: 'danger' });
  } finally {
    el.startBtn.disabled = false;
    el.startBtn.textContent = 'Start a session';
    el.photoInput.value = '';
  }
});

function openProblemPicker(problems, studentWorking) {
  el.photoProblemsList.innerHTML = problems.map((p, i) => `
    <button type="button" class="card btn-block" style="text-align:left;" data-index="${i}">
      ${p.label ? `<span class="badge badge-neutral">${escapeHtml(p.label)}</span> ` : ''}
      <span>${escapeHtml(p.text)}</span>
    </button>
  `).join('');

  el.photoProblemsList.querySelectorAll('button[data-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const problem = problems[Number(btn.dataset.index)];
      el.problemInput.value = studentWorking ? `${problem.text}\n\nMy working: ${studentWorking}` : problem.text;
      closeModal(el.photoModal);
    });
  });

  openModal(el.photoModal);
}

// ---------------------------------------------------------------------------
// Concept explainer modal
// ---------------------------------------------------------------------------

function resetConceptModal() {
  el.conceptForm.hidden = false;
  el.conceptResult.hidden = true;
  el.conceptText.value = '';
}

el.conceptBtn.addEventListener('click', () => { resetConceptModal(); openModal(el.conceptModal); });
el.conceptAgain.addEventListener('click', resetConceptModal);

el.conceptSubmit.addEventListener('click', async () => {
  const concept = el.conceptText.value.trim();
  if (!concept) return el.conceptText.focus();

  el.conceptSubmit.disabled = true;
  el.conceptSubmit.textContent = 'Thinking…';

  try {
    const { explanation } = await marg.explainConcept(el.conceptSubject.value, concept, el.conceptDepth.value);
    el.conceptAnswer.textContent = explanation;
    el.conceptForm.hidden = true;
    el.conceptResult.hidden = false;
  } catch (err) {
    toast(err.message ?? 'Could not explain that right now.', { variant: 'danger' });
  } finally {
    el.conceptSubmit.disabled = false;
    el.conceptSubmit.textContent = 'Explain it';
  }
});

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

function renderSessionCard(session) {
  const subject = subjectsById.get(session.subjectId);
  const dotClass = subject ? accentClass(subject.accent) : 'dot-amber';
  const statusBadge = session.status === 'completed'
    ? `<span class="badge badge-correct">${icons.check({ size: 12 })} done</span>`
    : `<span class="badge badge-active">active</span>`;

  const card = document.createElement('div');
  card.className = 'session-card';
  card.innerHTML = `
    <span class="subject-dot ${dotClass}"></span>
    <div class="session-card__body">
      <div class="session-card__title" data-title>${escapeHtml(session.title || 'Untitled session')}</div>
      <div class="session-card__meta">
        <span>${escapeHtml(subject?.label ?? session.subjectId)}</span>
        <span>·</span>
        <span>${timeAgo(session.updatedAt)}</span>
        ${statusBadge}
      </div>
    </div>
    <div class="session-card__actions">
      <button class="btn-icon" data-action="rename" title="Rename">${icons.pencil({ size: 15 })}</button>
      <button class="btn-icon" data-action="delete" title="Delete">${icons.trash({ size: 15 })}</button>
    </div>
  `;

  card.addEventListener('click', () => {
    window.location.href = `session.html#${encodeURIComponent(session.id)}`;
  });

  const titleEl = card.querySelector('[data-title]');
  card.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.className = 'session-title-edit';
    input.value = session.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const title = input.value.trim();
      if (title && title !== session.title) {
        try {
          await marg.renameSession(session.id, title);
          session.title = title;
        } catch {
          toast('Could not rename that session.', { variant: 'danger' });
        }
      }
      input.replaceWith(titleEl);
      titleEl.textContent = session.title || 'Untitled session';
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = session.title || ''; input.blur(); }
    });
  });

  const deleteBtn = card.querySelector('[data-action="delete"]');
  let confirmTimer;
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!deleteBtn.classList.contains('confirming')) {
      deleteBtn.classList.add('confirming');
      deleteBtn.title = 'Click again to delete';
      confirmTimer = setTimeout(() => {
        deleteBtn.classList.remove('confirming');
        deleteBtn.title = 'Delete';
      }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    try {
      await marg.deleteSession(session.id);
      card.remove();
      toast('Session deleted.');
      if (!el.sessionsList.children.length) renderEmptySessions();
    } catch {
      toast('Could not delete that session.', { variant: 'danger' });
    }
  });

  return card;
}

function renderEmptySessions() {
  el.sessionsList.innerHTML = `
    <div class="empty-state card">
      <div class="empty-icon">${icons.circleQuestion({ size: 40 })}</div>
      <h3>No sessions yet</h3>
      <p>Pick a subject above and bring Marg something you're stuck on.</p>
    </div>
  `;
}

async function loadSessions() {
  try {
    const { sessions } = await marg.listSessions();
    el.sessionsList.innerHTML = '';
    if (sessions.length === 0) return renderEmptySessions();
    sessions.forEach((session) => el.sessionsList.appendChild(renderSessionCard(session)));
  } catch {
    el.sessionsList.innerHTML = '<p class="text-dim">Could not load your sessions.</p>';
  }
}

// ---------------------------------------------------------------------------
// Modal plumbing (shared by concept + photo modals)
// ---------------------------------------------------------------------------

function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }

[el.conceptModal, el.photoModal].forEach((modal) => {
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });
});
document.getElementById('concept-close').addEventListener('click', () => closeModal(el.conceptModal));
document.getElementById('photo-modal-close').addEventListener('click', () => closeModal(el.photoModal));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  [el.conceptModal, el.photoModal].forEach((modal) => { if (!modal.hidden) closeModal(modal); });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  await marg.ready();
  await Promise.all([loadSubjects(), checkVisionSupport(), loadSessions()]);
})();
