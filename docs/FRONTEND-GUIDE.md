# Frontend Guide

Everything you need to wire a UI to this API. Framework-agnostic — plain
`fetch` and `EventSource`, no dependencies.

**Start here:** set `AI_PROVIDER=mock` in the backend's `.env` and run
`npm run dev`. Every endpoint works with realistic canned data, offline, with no
API key. Build the entire app against that, then flip to a real provider.

---

## 1. The auth handshake

There is no signup. Three lines of logic:

```js
async function getToken() {
  let token = localStorage.getItem('marg_token');
  if (token) return token;

  const res = await fetch(`${API}/api/v1/auth/guest`, { method: 'POST' });
  const { data } = await res.json();
  localStorage.setItem('marg_token', data.token);
  return data.token;
}
```

Send it on everything else as `Authorization: Bearer <token>`.

**Handle 401 by re-registering.** The backend currently stores data in memory,
so a server restart invalidates every existing account while the tokens in
browsers stay valid. Without this, a restart looks like a permanently broken app:

```js
if (res.status === 401) {
  localStorage.removeItem('marg_token');
  await getToken();
  // retry the request once
}
```

The `MargClient` below does this automatically.

---

## 2. The copy-paste client

Drop this in as `marg-client.js`. It covers every endpoint, handles token
refresh on 401, and unwraps the response envelope.

```js
/**
 * A complete client for the Marg API.
 *
 * Every method returns the `data` field of the response envelope, or throws a
 * MargError carrying the stable `code` you can branch on.
 *
 * const marg = new MargClient('http://localhost:4000');
 * await marg.ready();
 * const { session, steps } = await marg.createSession('mathematics', 'solve 2x^2 - 5x - 3 = 0');
 */
class MargError extends Error {
  constructor(code, message, details, requestId) {
    super(message);
    this.code = code;         // e.g. 'SESSION_NOT_FOUND' — branch on this
    this.details = details;
    this.requestId = requestId; // quote this in bug reports
  }
}

class MargClient {
  constructor(baseUrl = 'http://localhost:4000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = localStorage.getItem('marg_token');
  }

  /** Call once on app start. Creates a guest account if there isn't one. */
  async ready() {
    if (!this.token) await this.registerGuest();
    return this.token;
  }

  async registerGuest() {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/guest`, { method: 'POST' });
    const body = await res.json();
    this.token = body.data.token;
    localStorage.setItem('marg_token', this.token);
    return body.data;
  }

  /** Internal: makes a request, retrying once with a fresh token on 401. */
  async #request(path, { method = 'GET', body, retry = true } = {}) {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const payload = await res.json();

    // The stored account is gone (e.g. the server restarted). Get a new one
    // and try again, so the user never sees a spurious error.
    if (res.status === 401 && retry) {
      await this.registerGuest();
      return this.#request(path, { method, body, retry: false });
    }

    if (!payload.ok) {
      throw new MargError(
        payload.error.code, payload.error.message,
        payload.error.details, payload.requestId,
      );
    }
    return payload.data;
  }

  // --- Reference data ---
  getSubjects()  { return this.#request('/subjects'); }
  getProviders() { return this.#request('/meta/providers'); }

  // --- Sessions ---
  createSession(subjectId, problem, answerPolicy) {
    return this.#request('/sessions', {
      method: 'POST', body: { subjectId, problem, ...(answerPolicy && { answerPolicy }) },
    });
  }
  listSessions(limit = 20, offset = 0) {
    return this.#request(`/sessions?limit=${limit}&offset=${offset}`);
  }
  getSession(id)         { return this.#request(`/sessions/${id}`); }
  renameSession(id, title) { return this.#request(`/sessions/${id}`, { method: 'PATCH', body: { title } }); }
  deleteSession(id)      { return this.#request(`/sessions/${id}`, { method: 'DELETE' }); }

  // --- Tutoring ---
  /** @param {'guide'|'explain'|'discuss'|'check'} [mode] Force a mode from a button. */
  ask(id, message, mode) {
    return this.#request(`/sessions/${id}/ask`, { method: 'POST', body: { message, ...(mode && { mode }) } });
  }
  hint(id, stepIndex)   { return this.#request(`/sessions/${id}/hint`, { method: 'POST', body: { stepIndex } }); }
  reveal(id)            { return this.#request(`/sessions/${id}/reveal`, { method: 'POST' }); }
  check(id, attempt, stepId) {
    return this.#request(`/sessions/${id}/check`, { method: 'POST', body: { attempt, ...(stepId && { stepId }) } });
  }
  explain(id, stepId, question) {
    return this.#request(`/sessions/${id}/explain`, { method: 'POST', body: { stepId, question } });
  }

  // --- Extras ---
  practice(id, count = 3)  { return this.#request(`/sessions/${id}/practice`, { method: 'POST', body: { count } }); }
  submitPractice(setId, answers) {
    return this.#request(`/practice/${setId}/submit`, { method: 'POST', body: { answers } });
  }
  explainConcept(subjectId, concept, depth = 'standard') {
    return this.#request('/concepts/explain', { method: 'POST', body: { subjectId, concept, depth } });
  }
  weaknesses(days = 30) { return this.#request(`/insights/weaknesses?days=${days}`); }
  activity(days = 30)   { return this.#request(`/insights/activity?days=${days}`); }

  /** Upload a photo of a page. Returns every problem found on it. */
  async transcribe(file) {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(`${this.baseUrl}/api/v1/vision/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` }, // no Content-Type: the browser sets the boundary
      body: form,
    });
    const payload = await res.json();
    if (!payload.ok) throw new MargError(payload.error.code, payload.error.message, payload.error.details, payload.requestId);
    return payload.data;
  }

  /**
   * Streams a reply token by token.
   *
   * @returns {() => void} Call it to cancel the stream.
   *
   * const cancel = marg.askStream(id, 'why does the sign flip?', {
   *   onStart: ({ mode }) => setMode(mode),
   *   onDelta: (text)     => setReply(prev => prev + text),
   *   onDone:  (info)     => setStreaming(false),
   *   onError: (err)      => showError(err),
   * });
   */
  askStream(sessionId, message, { onStart, onDelta, onDone, onError, mode } = {}) {
    const params = new URLSearchParams({ message, token: this.token, ...(mode && { mode }) });
    const source = new EventSource(`${this.baseUrl}/api/v1/sessions/${sessionId}/ask/stream?${params}`);

    source.addEventListener('start', (e) => onStart?.(JSON.parse(e.data)));
    source.addEventListener('delta', (e) => onDelta?.(JSON.parse(e.data).text));

    source.addEventListener('done', (e) => {
      onDone?.(JSON.parse(e.data));
      source.close(); // Without this, EventSource reconnects and re-asks. Always close.
    });

    source.addEventListener('error', (e) => {
      // A payload means the server sent a real error event. No payload means
      // the connection itself dropped.
      const err = e.data ? JSON.parse(e.data) : { code: 'CONNECTION_LOST', message: 'Lost connection.' };
      onError?.(err);
      source.close();
    });

    return () => source.close();
  }
}
```

---

## 3. The flow, end to end

Matching the screens on the landing page.

### Step 1 — pick a subject

```js
const marg = new MargClient();
await marg.ready();

const { subjects } = await marg.getSubjects();
// Render the tiles. `accent` is a token ('amber','blue','green','rose') —
// map it to your palette. Use `examples` as placeholder text.
```

### Step 2 — start the session

```js
const result = await marg.createSession('mathematics', 'solve 2x^2 - 5x - 3 = 0');

// ALWAYS check this first.
if (result.refused) {
  addBubble({ role: 'assistant', content: result.message.content });
  return; // result.session is null
}

const { session, steps } = result;
// session.title -> "Quadratic equations"  (the card header)
// steps         -> the 01 / 02 / 03 rows
```

Rendering the card:

```js
steps.map(step => `
  <div class="step ${step.status}">
    <span class="num">${String(step.index).padStart(2, '0')}</span>
    <span class="text">${step.instruction}</span>
  </div>
`);
```

### Step 3 — the student asks something

```js
marg.askStream(session.id, "wait, why does the sign flip here?", {
  onStart: ({ mode, refused }) => { setMode(mode); setStreaming(true); },
  onDelta: (text) => appendToCurrentBubble(text),
  onDone:  ({ revealAvailable }) => {
    setStreaming(false);
    if (revealAvailable) showRevealButton();
  },
});
```

### Step 4 — check their work

```js
const { marking, steps } = await marg.check(session.id, 'x = 1/2 or x = -3');

// marking.firstBrokenStepIndex === 3  -> this is the step to circle
// marking.errorType === 'sign_error'
// marking.nudge -> "Take 2x + 1 = 0 on its own. If you subtract 1 …"

setSteps(steps); // repaint the progress bar from the returned steps
if (marking.firstBrokenStepIndex) {
  circleStep(marking.firstBrokenStepIndex);
}
```

---

## 4. Rendering notes

### The progress bar

Drive it entirely off `step.status`:

| Status | Meaning | Suggested treatment |
|---|---|---|
| `pending` | Not reached | Muted |
| `active` | Working on it now | Highlighted |
| `correct` | Got it right | Green |
| `incorrect` | This is where it broke | The circled one |
| `revealed` | Answer was shown | Neutral |

Never compute status yourself from `currentStepIndex` — `check` returns updated
steps and they are the truth.

### The "circle the step" affordance

`marking.firstBrokenStepIndex` is **1-based**, matching the `01`/`02`/`03`
labels. Only ever one step is circled: everything after a broken step is usually
downstream of that same mistake, and marking four steps wrong for one error is
demoralising and unhelpful.

### Refused messages

```js
if (response.refused) {
  // Render as a NORMAL assistant bubble. Not a red banner, not an error toast.
  // This is Marg talking, not the app failing.
  addBubble({ role: 'assistant', content: response.message.content });
}
```

You may want a subtle visual difference (a slightly different tint), but it must
read as part of the conversation.

### The reveal button

```js
const result = await marg.reveal(session.id);

if (result.revealed) {
  showWorkedSolution(result.message.content);
  hideRevealButton();
} else if (result.revealAvailable) {
  showHint(result.message.content);
  setRevealButtonLabel('Show me anyway');  // the second press reveals
} else {
  // requirement === 'policy_never' — hide the button entirely rather than
  // offering something that can never happen.
  hideRevealButton();
}
```

### The camera button

```js
const { supportsVision } = await marg.getProviders();
if (!supportsVision) hideCameraButton();
```

Then, on upload:

```js
const { problems, studentWorking } = await marg.transcribe(file);

// Show ALL problems and let the student pick — one photo can hold six questions.
// Let them edit the text before committing: catching a misread '5' vs 'S' now
// is much better than three steps in.
const chosen = await showPicker(problems);
const { session } = await marg.createSession('mathematics', chosen.text);

// If handwriting was found, offer to mark it straight away.
if (studentWorking) await marg.check(session.id, studentWorking);
```

---

## 5. Handling errors

```js
try {
  await marg.ask(sessionId, message);
} catch (err) {
  switch (err.code) {
    case 'RATE_LIMITED':
      toast('Slow down a moment — try again shortly.');
      break;
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_BAD_RESPONSE':
      showRetryButton('Marg could not finish that. Try again?');
      break;
    case 'VALIDATION_FAILED':
      // err.details.fields -> [{ path: 'problem', message: '…' }]
      err.details.fields.forEach(f => highlightInput(f.path, f.message));
      break;
    case 'SESSION_NOT_FOUND':
      navigateToSessionList();
      break;
    case 'UNAUTHENTICATED':
      break; // the client already retried; a second failure means the API is down
    default:
      toast(`Something went wrong. Reference: ${err.requestId}`);
  }
}
```

`requestId` is the one thing worth surfacing to users in an error state — it
turns "it broke" into a searchable log line.

---

## 6. Streaming

### Cancelling

Always cancel when the user navigates away. It closes the connection, which
aborts the upstream AI call and stops the token spend.

```js
useEffect(() => {
  const cancel = marg.askStream(sessionId, message, { onDelta: append });
  return cancel;      // React cleanup
}, [sessionId, message]);
```

### Why the token is in the query string

`EventSource` cannot set request headers — a real limitation of the browser API,
not a shortcut. If that bothers you (query strings can land in access logs), use
`fetch` with a `ReadableStream` instead and send a normal header:

```js
const res = await fetch(`${API}/api/v1/sessions/${id}/ask/stream?message=${encodeURIComponent(msg)}`, {
  headers: { Authorization: `Bearer ${token}` },
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();  // keep the last partial line for the next chunk

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const payload = JSON.parse(line.slice(6));
      if (payload.text) append(payload.text);
    }
  }
}
```

### Common mistakes

- **Forgetting `source.close()` on `done`.** `EventSource` auto-reconnects, so
  it will re-send the whole question. You will see the reply twice and pay twice.
- **Assuming `delta` boundaries mean anything.** They are network chunks, not
  words or sentences. Concatenate and render; never parse per chunk.
- **Rendering markdown per delta.** Buffer the text and format on `done`, or
  you will watch half-open code fences flicker.

---

## 7. Modes — what to build

| Mode | Student is doing | Trigger it with |
|---|---|---|
| `guide` | Working through the steps | Default; "Walk me through it" |
| `explain` | Asking why something works | "See a worked example ↓" |
| `discuss` | Asking a concept question | A free-text box with no step attached |
| `check` | Submitting their working | "Check my work" |

You can pass `mode` explicitly from a button, or leave it out and let Marg read
the intent from the message. Both work; an explicit mode always wins.

Full behaviour is described in [TUTORING-MODEL.md](TUTORING-MODEL.md).

---

## 8. Local development checklist

- [ ] Backend running: `npm run dev` in this repo
- [ ] `AI_PROVIDER=mock` in `.env` so you need no key
- [ ] Your dev server's origin listed in `CORS_ORIGINS` (Vite's `http://localhost:5173`
      and CRA's `http://localhost:3000` are there by default)
- [ ] `GET http://localhost:4000/health` returns `{"ok":true}`

With `mock`, these inputs give the documented outputs, so you can build the
whole UI against predictable data:

| Input | Result |
|---|---|
| `solve 2x^2 - 5x - 3 = 0` | The three-step quadratic plan |
| `check` with `x = 1/2 or x = -3` | A `sign_error` on step 3 |
| Ask `why does the sign flip here?` | Mode `explain`, streamed |
| `write me a song for my girlfriend` | Refused, `off_topic` |
| `here is my assignment spec, write the program` | Refused, `integrity` |
