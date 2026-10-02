/**
 * A complete client for the Marg API. Copied from docs/FRONTEND-GUIDE.md and
 * kept faithful to that contract — if this file and the guide ever disagree,
 * the guide is describing the intended behavior and this file has drifted.
 *
 * Every method returns the `data` field of the response envelope, or throws a
 * MargError carrying the stable `code` to branch on.
 *
 * @example
 * const marg = new MargClient('http://localhost:4000');
 * await marg.ready();
 * const { session, steps } = await marg.createSession('mathematics', 'solve 2x^2 - 5x - 3 = 0');
 */

/** Thrown by every MargClient method on a non-2xx response. */
export class MargError extends Error {
  /**
   * @param {string} code - Stable machine-readable code, e.g. 'SESSION_NOT_FOUND'.
   * @param {string} message - Human-readable message.
   * @param {object} [details] - Extra structured context (e.g. validation field errors).
   * @param {string} [requestId] - Quote this in bug reports.
   */
  constructor(code, message, details, requestId) {
    super(message);
    this.name = 'MargError';
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export class MargClient {
  /** @param {string} baseUrl */
  constructor(baseUrl = 'http://localhost:4000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = localStorage.getItem('marg_token');
  }

  /**
   * Call once on app start. Creates a guest account if there isn't one yet.
   * @returns {Promise<string>} The bearer token.
   */
  async ready() {
    if (!this.token) await this.registerGuest();
    return this.token;
  }

  /** @returns {Promise<{user: object, token: string, expiresAt: string}>} */
  async registerGuest() {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/guest`, { method: 'POST' });
    const body = await res.json();
    this.token = body.data.token;
    localStorage.setItem('marg_token', this.token);
    return body.data;
  }

  /**
   * Internal: makes a request, retrying once with a fresh guest token on 401.
   * @param {string} path
   * @param {{ method?: string, body?: object, retry?: boolean }} [options]
   * @returns {Promise<any>}
   */
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
  getSession(id)            { return this.#request(`/sessions/${id}`); }
  renameSession(id, title)  { return this.#request(`/sessions/${id}`, { method: 'PATCH', body: { title } }); }
  deleteSession(id)         { return this.#request(`/sessions/${id}`, { method: 'DELETE' }); }

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

  // --- Practice ---
  practice(id, count = 3) { return this.#request(`/sessions/${id}/practice`, { method: 'POST', body: { count } }); }
  submitPractice(setId, answers) {
    return this.#request(`/practice/${setId}/submit`, { method: 'POST', body: { answers } });
  }

  // --- Concepts ---
  explainConcept(subjectId, concept, depth = 'standard') {
    return this.#request('/concepts/explain', { method: 'POST', body: { subjectId, concept, depth } });
  }

  // --- Insights ---
  weaknesses(days = 30) { return this.#request(`/insights/weaknesses?days=${days}`); }
  activity(days = 30)   { return this.#request(`/insights/activity?days=${days}`); }

  /**
   * Upload a photo of a page. Returns every problem found on it.
   * @param {File} file
   * @returns {Promise<{subjectId: string|null, problems: object[], studentWorking: string|null}>}
   */
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
   * Streams a reply token by token via Server-Sent Events.
   *
   * @param {string} sessionId
   * @param {string} message
   * @param {{ onStart?: Function, onDelta?: Function, onDone?: Function, onError?: Function, mode?: string }} [handlers]
   * @returns {() => void} Call it to cancel the stream.
   *
   * @example
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
