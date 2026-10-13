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

/**
 * True for a `MargError` raised by the free-tier message quota — guests
 * capped at a lifetime total, signed-in students capped per day. Pages
 * that send messages (app.js, session.js) use this to show a sign-in
 * prompt instead of a generic error toast.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isQuotaError(error) {
  return error instanceof MargError
    && (error.code === 'GUEST_LIMIT_REACHED' || error.code === 'DAILY_LIMIT_REACHED');
}

export class MargClient {
  /** @param {string} baseUrl */
  constructor(baseUrl = 'http://localhost:4000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = localStorage.getItem('marg_token');
    // Defaults true so a brand-new visitor (no token yet, nothing in
    // localStorage) reads as a guest rather than as mistakenly signed in.
    this.isGuest = localStorage.getItem('marg_is_guest') !== 'false';
    this.email = localStorage.getItem('marg_email') || null;
  }

  /**
   * Call once on app start. Creates a guest account if there isn't one yet.
   * @returns {Promise<string>} The bearer token.
   */
  async ready() {
    if (!this.token) await this.registerGuest();
    return this.token;
  }

  /**
   * Stores the result of any sign-in (guest or Google) in both memory and
   * localStorage, so the next page load — and the next tab — know who this
   * is without another round trip.
   * @private
   * @param {{token: string, user: {isGuest: boolean, email?: string}}} data
   */
  #setAuth({ token, user }) {
    this.token = token;
    this.isGuest = user.isGuest;
    this.email = user.email ?? null;
    localStorage.setItem('marg_token', token);
    localStorage.setItem('marg_is_guest', String(user.isGuest));
    if (user.email) localStorage.setItem('marg_email', user.email);
    else localStorage.removeItem('marg_email');
  }

  /** @returns {Promise<{user: object, token: string, expiresAt: string}>} */
  async registerGuest() {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/guest`, { method: 'POST' });
    const body = await res.json();
    this.#setAuth(body.data);
    return body.data;
  }

  /**
   * Exchanges a verified Google sign-in for a Marg account. Call this with
   * the token from `auth.js`'s `getGoogleToken()`, right after a Google
   * session appears.
   *
   * @param {string} neonAuthToken - The raw JWT from Neon Auth.
   * @returns {Promise<{user: object, token: string, expiresAt: string}>}
   */
  async signInWithGoogle(neonAuthToken) {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ neonAuthToken }),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new MargError(body.error.code, body.error.message, body.error.details, body.requestId);
    }
    this.#setAuth(body.data);
    return body.data;
  }

  /**
   * Drops the Marg account token, so the next request re-registers as a
   * fresh guest. Does not touch the separate Google session — pair with
   * `auth.js`'s `signOutOfGoogle()` for a full sign-out.
   * @returns {void}
   */
  signOut() {
    this.token = null;
    this.isGuest = true;
    this.email = null;
    localStorage.removeItem('marg_token');
    localStorage.removeItem('marg_is_guest');
    localStorage.removeItem('marg_email');
  }

  /**
   * Internal: makes a request, retrying once on 401.
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

    if (res.status === 401 && retry) {
      // A guest's account is gone (e.g. the server restarted) — get a new
      // one and retry, so they never see a spurious error. A signed-in
      // student's token should not just vanish like that; if it somehow
      // does (expired after 30 days), do not silently demote them to a
      // fresh guest — sign them out and let the caller's error handling
      // prompt them to sign in again.
      if (this.isGuest) {
        await this.registerGuest();
        return this.#request(path, { method, body, retry: false });
      }
      this.signOut();
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
