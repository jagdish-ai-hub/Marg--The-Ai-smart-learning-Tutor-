/**
 * Wires session.html — the actual product: the step card, the streamed chat,
 * checking work, hints, the two-press reveal gate, per-step "explain this",
 * and inline practice sets.
 */

import { MargClient } from './marg-client.js';
import { API_BASE } from './config.js';
import { icons } from './icons.js';
import { escapeHtml, toast } from './format.js';
import { renderShell } from './shell.js';
import { registerServiceWorker } from './pwa.js';

registerServiceWorker();

const marg = new MargClient(API_BASE);
renderShell();

// A hash, not a query string — see the comment in subjects-ui.js: some static
// hosts 301-redirect "?query=strings" away, but a hash never reaches the server.
const sessionId = decodeURIComponent(location.hash.slice(1));
if (!sessionId) window.location.href = 'app.html';

/** @type {'ask'|'check'} */
let currentMode = 'ask';
let cancelStream = null;
let answerPolicyNever = false;
let answerAlreadyRevealed = false;
let currentTitle = '';

/** @type {Map<string, HTMLElement>} stepId -> step row element */
const stepRowEls = new Map();
/** @type {Map<string, HTMLElement>} stepId -> progress bar segment element */
const progressSegEls = new Map();

const el = {
  titleDisplay: document.getElementById('session-title-display'),
  backBtn: document.getElementById('back-btn'),
  renameBtn: document.getElementById('rename-btn'),
  deleteBtn: document.getElementById('delete-btn'),
  subjectLabel: document.getElementById('subject-label'),
  restatedProblem: document.getElementById('restated-problem'),
  stepList: document.getElementById('step-list'),
  progressBar: document.getElementById('progress-bar'),
  practiceBtn: document.getElementById('practice-btn'),
  transcript: document.getElementById('transcript'),
  modeToggle: document.getElementById('mode-toggle'),
  composerInput: document.getElementById('composer-input'),
  hintBtn: document.getElementById('hint-btn'),
  revealBtn: document.getElementById('reveal-btn'),
  sendBtn: document.getElementById('send-btn'),
};

document.getElementById('back-icon').innerHTML = icons.back({ size: 20 });
document.getElementById('rename-icon').innerHTML = icons.pencil({ size: 16 });
document.getElementById('delete-icon').innerHTML = icons.trash({ size: 16 });
document.getElementById('hint-icon').innerHTML = icons.lightbulb({ size: 14 });
document.getElementById('send-icon').innerHTML = icons.send({ size: 18 });

el.backBtn.addEventListener('click', () => { window.location.href = 'app.html'; });

// ---------------------------------------------------------------------------
// Steps + progress bar
// ---------------------------------------------------------------------------

/**
 * Builds the step list and progress bar once, keeping element references so
 * later status changes mutate `data-status` on the SAME nodes — that's what
 * makes the color/ring transitions in app.css actually animate, rather than
 * snapping instantly on a full re-render.
 */
function renderStepsInitial(steps) {
  el.stepList.innerHTML = '';
  el.progressBar.innerHTML = '';
  stepRowEls.clear();
  progressSegEls.clear();

  steps.forEach((step) => {
    const row = document.createElement('li');
    row.className = 'step-row';
    row.dataset.status = step.status;
    row.innerHTML = `
      <span class="step-num">${String(step.index).padStart(2, '0')}</span>
      <span class="step-text">${escapeHtml(step.instruction)}</span>
      <button class="btn-icon step-row__explain" data-explain="${step.id}" title="Ask why this step works">${icons.circleQuestion({ size: 14 })}</button>
    `;
    el.stepList.appendChild(row);
    stepRowEls.set(step.id, row);

    const seg = document.createElement('span');
    seg.dataset.status = step.status;
    el.progressBar.appendChild(seg);
    progressSegEls.set(step.id, seg);
  });
}

/** Repaints step + progress statuses from a fresh `steps` array — never computed locally. */
function updateSteps(steps) {
  steps.forEach((step) => {
    const row = stepRowEls.get(step.id);
    if (row) row.dataset.status = step.status;
    const seg = progressSegEls.get(step.id);
    if (seg) seg.dataset.status = step.status;
  });
  el.practiceBtn.hidden = false;
}

el.stepList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-explain]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const { message } = await marg.explain(sessionId, btn.dataset.explain);
    addBubble({ role: 'assistant', content: message.content });
  } catch (err) {
    toast(err.message ?? 'Could not explain that step.', { variant: 'danger' });
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function scrollToBottom() {
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

/**
 * Appends a bubble to the transcript.
 * @param {{ role: 'user'|'assistant', content: string, refused?: boolean, streaming?: boolean }} options
 * @returns {HTMLElement} The bubble element (its `.bubble-text` span can be updated for streaming).
 */
function addBubble({ role, content, refused = false, streaming = false }) {
  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${role}${refused ? ' refused' : ''}`;
  bubble.innerHTML = `<span class="bubble-text"></span>${streaming ? '<span class="caret"></span>' : ''}`;
  bubble.querySelector('.bubble-text').textContent = content;
  el.transcript.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function stopStreamingBubble(bubble) {
  bubble.querySelector('.caret')?.remove();
}

// ---------------------------------------------------------------------------
// Reveal gate
// ---------------------------------------------------------------------------

function updateRevealButton(session) {
  answerPolicyNever = session.answerPolicy === 'never';
  answerAlreadyRevealed = Boolean(session.answerRevealed);

  if (answerPolicyNever || answerAlreadyRevealed) {
    el.revealBtn.hidden = true;
    return;
  }
  el.revealBtn.hidden = false;
  el.revealBtn.textContent = (session.revealCount ?? 0) >= 1 ? 'Show me anyway' : 'Show me the answer';
}

el.revealBtn.addEventListener('click', async () => {
  el.revealBtn.disabled = true;
  try {
    const result = await marg.reveal(sessionId);
    addBubble({ role: 'assistant', content: result.message.content });

    if (result.revealed) {
      answerAlreadyRevealed = true;
      el.revealBtn.hidden = true;
      if (result.steps) updateSteps(result.steps);
    } else if (result.revealAvailable) {
      el.revealBtn.textContent = 'Show me anyway';
    } else {
      el.revealBtn.hidden = true;
    }
  } catch (err) {
    toast(err.message ?? 'Could not fetch the answer right now.', { variant: 'danger' });
  } finally {
    el.revealBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Hint
// ---------------------------------------------------------------------------

el.hintBtn.addEventListener('click', async () => {
  el.hintBtn.disabled = true;
  try {
    const { message } = await marg.hint(sessionId);
    addBubble({ role: 'assistant', content: message.content });
  } catch (err) {
    toast(err.message ?? 'Could not fetch a hint right now.', { variant: 'danger' });
  } finally {
    el.hintBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Mode toggle + send (ask streams, check does not)
// ---------------------------------------------------------------------------

el.modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  currentMode = btn.dataset.mode;
  [...el.modeToggle.children].forEach((b) => b.classList.toggle('is-active', b === btn));
  el.composerInput.placeholder = currentMode === 'check'
    ? 'Paste your working — Marg will mark it step by step…'
    : 'Type your question, or paste your working…';
});

function setComposerBusy(busy) {
  el.sendBtn.disabled = busy;
  el.composerInput.disabled = busy;
}

async function handleSend() {
  const text = el.composerInput.value.trim();
  if (!text) return;

  cancelStream?.();
  el.composerInput.value = '';
  setComposerBusy(true);
  addBubble({ role: 'user', content: text });

  if (currentMode === 'check') {
    const thinking = addBubble({ role: 'assistant', content: '', streaming: true });
    try {
      const { message, steps, session } = await marg.check(sessionId, text);
      stopStreamingBubble(thinking);
      thinking.querySelector('.bubble-text').textContent = message.content;
      updateSteps(steps);
      updateRevealButton(session);
    } catch (err) {
      stopStreamingBubble(thinking);
      thinking.querySelector('.bubble-text').textContent = 'Something went wrong marking that — try again?';
      reportError(err);
    } finally {
      setComposerBusy(false);
    }
    return;
  }

  const bubble = addBubble({ role: 'assistant', content: '', streaming: true });
  const textSpan = bubble.querySelector('.bubble-text');

  cancelStream = marg.askStream(sessionId, text, {
    onStart: ({ refused }) => { if (refused) bubble.classList.add('refused'); },
    onDelta: (chunk) => { textSpan.textContent += chunk; scrollToBottom(); },
    onDone: ({ revealAvailable }) => {
      stopStreamingBubble(bubble);
      if (revealAvailable && !answerPolicyNever && !answerAlreadyRevealed) {
        el.revealBtn.hidden = false;
        el.revealBtn.textContent = 'Show me anyway';
      }
      setComposerBusy(false);
      cancelStream = null;
    },
    onError: (err) => {
      stopStreamingBubble(bubble);
      textSpan.textContent = textSpan.textContent || 'Something went wrong. Try asking again.';
      reportError(err);
      setComposerBusy(false);
      cancelStream = null;
    },
  });
}

el.sendBtn.addEventListener('click', handleSend);
el.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

window.addEventListener('beforeunload', () => cancelStream?.());

function reportError(err) {
  if (err.code === 'RATE_LIMITED') {
    toast(err.message, { variant: 'danger' });
  } else if (err.code === 'SESSION_NOT_FOUND') {
    toast('This session no longer exists.', { variant: 'danger' });
    setTimeout(() => { window.location.href = 'app.html'; }, 1200);
  } else {
    toast(`Marg couldn't finish that. Reference: ${err.requestId ?? 'n/a'}`, { variant: 'danger' });
  }
}

// ---------------------------------------------------------------------------
// Practice ("5 more like this") — inline card in the transcript
// ---------------------------------------------------------------------------

el.practiceBtn.addEventListener('click', async () => {
  el.practiceBtn.disabled = true;
  el.practiceBtn.textContent = 'Generating…';
  try {
    const { practiceSet } = await marg.practice(sessionId, 3);
    renderPracticeCard(practiceSet);
  } catch (err) {
    toast(err.message ?? 'Could not generate practice problems.', { variant: 'danger' });
  } finally {
    el.practiceBtn.disabled = false;
    el.practiceBtn.textContent = '5 more like this';
  }
});

function renderPracticeCard(set) {
  const card = document.createElement('div');
  card.className = 'card practice-card';
  card.innerHTML = `
    <h4>Practice: ${escapeHtml(set.skill)}</h4>
    ${set.problems.map((p) => `
      <div class="practice-item">
        <label>${p.index}. ${escapeHtml(p.prompt)} <span class="badge badge-neutral">${p.difficulty}</span></label>
        <textarea data-answer="${p.index}" rows="1" placeholder="Your answer…"></textarea>
      </div>
    `).join('')}
    <button class="btn btn-accent btn-block" data-submit>Submit answers</button>
  `;
  el.transcript.appendChild(card);
  scrollToBottom();

  card.querySelector('[data-submit]').addEventListener('click', async (e) => {
    const btn = e.target;
    const answers = [...card.querySelectorAll('[data-answer]')].map((ta) => ({
      index: Number(ta.dataset.answer),
      answer: ta.value.trim(),
    }));
    btn.disabled = true;
    btn.textContent = 'Marking…';
    try {
      const { practiceSet: results } = await marg.submitPractice(set.id, answers);
      renderPracticeResults(card, results);
    } catch (err) {
      toast(err.message ?? 'Could not mark those answers.', { variant: 'danger' });
      btn.disabled = false;
      btn.textContent = 'Submit answers';
    }
  });
}

function renderPracticeResults(card, results) {
  const { results: r, problems } = results;
  card.innerHTML = `
    <h4>Practice: ${escapeHtml(results.skill)} — ${r.correctCount}/${r.total} correct</h4>
    ${problems.map((p, i) => `
      <div class="practice-result">
        <span class="badge ${r.perProblem[i]?.verdict === 'correct' ? 'badge-correct' : 'badge-incorrect'}">
          ${r.perProblem[i]?.verdict === 'correct' ? icons.check({ size: 11 }) : ''} ${p.index}
        </span>
        <span class="text-dim">${escapeHtml(p.answer)}</span>
      </div>
    `).join('')}
    <p class="text-dim" style="margin-top: var(--sp-3);">${escapeHtml(r.nudge)}</p>
  `;
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Title rename + delete
// ---------------------------------------------------------------------------

el.renameBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.className = 'input';
  input.value = currentTitle;
  el.titleDisplay.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const title = input.value.trim();
    if (title && title !== currentTitle) {
      try {
        await marg.renameSession(sessionId, title);
        currentTitle = title;
      } catch {
        toast('Could not rename this session.', { variant: 'danger' });
      }
    }
    input.replaceWith(el.titleDisplay);
    el.titleDisplay.textContent = currentTitle;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
  });
});

let deleteConfirming = false;
el.deleteBtn.addEventListener('click', async () => {
  if (!deleteConfirming) {
    deleteConfirming = true;
    el.deleteBtn.title = 'Click again to delete';
    el.deleteBtn.style.color = 'var(--danger)';
    setTimeout(() => {
      deleteConfirming = false;
      el.deleteBtn.title = 'Delete';
      el.deleteBtn.style.color = '';
    }, 3000);
    return;
  }
  try {
    await marg.deleteSession(sessionId);
    window.location.href = 'app.html';
  } catch {
    toast('Could not delete this session.', { variant: 'danger' });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  await marg.ready();

  try {
    const [{ session, steps, messages }, { subjects }] = await Promise.all([
      marg.getSession(sessionId),
      marg.getSubjects(),
    ]);

    const subject = subjects.find((s) => s.id === session.subjectId);
    currentTitle = session.title || 'Untitled session';

    el.titleDisplay.textContent = currentTitle;
    el.subjectLabel.textContent = subject?.label ?? session.subjectId;
    el.restatedProblem.textContent = session.restatedProblem || session.problem;

    renderStepsInitial(steps);
    updateSteps(steps);
    updateRevealButton(session);

    messages.forEach((message) => {
      addBubble({
        role: message.role,
        content: message.content,
        refused: Boolean(message.meta?.refused),
      });
    });
  } catch (err) {
    if (err.code === 'SESSION_NOT_FOUND') {
      toast('That session could not be found.', { variant: 'danger' });
      setTimeout(() => { window.location.href = 'app.html'; }, 1200);
    } else {
      toast('Could not load this session.', { variant: 'danger' });
    }
  }
})();
