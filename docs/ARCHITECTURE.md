# Architecture

How the pieces fit together, and why they are arranged this way.

---

## The layers

```
  HTTP request
       │
       ▼
  middleware/     requestId → cors → auth → rate limit → validation
       │
       ▼
  routes/         one file listing every endpoint
       │
       ▼
  controllers/    parse the request, call a service, shape the response
       │
       ▼
  services/       the actual logic
       │
       ├──────────────► ai/registry.js ──► providers/ (gemini, openrouter, mock)
       │
       └──────────────► store/index.js ──► memory.js  (turso.js later)
```

The rule that keeps this honest: **each layer only talks to the one below it.**
A controller never touches the store directly; a service never touches
`req`/`res`. That is what lets the whole test suite run against a real HTTP
server without a single mock, and what will let the database swap happen without
touching a route.

### What each layer is for

**`middleware/`** — cross-cutting concerns that apply to many routes. Order
matters and is documented in `app.js`.

**`routes/index.js`** — every endpoint in one readable list. With ~20 routes,
one file beats eight you have to open in turn to answer "what does this API
expose?". Each line reads as a sentence: path, rate limit, auth, validation,
controller.

**`controllers/`** — deliberately thin. Read the request, call a service, shape
the response. No business logic. If a controller is getting interesting, the
logic belongs in a service.

**`services/`** — where the product lives. Testable in isolation, no HTTP
concepts.

**`ai/`** — one interface, several providers. Nothing above this layer knows
which model is in use.

**`store/`** — one interface, one implementation today.

---

## Request lifecycle, in prose

A student sends *"why does the sign flip here?"* to
`POST /api/v1/sessions/ses_abc/ask`.

1. **`requestId`** stamps `req.id` and attaches `res.ok()`.
2. **`cors`** checks the origin against `CORS_ORIGINS`.
3. **`aiLimiter`** counts the request against the user's per-minute AI budget.
4. **`requireAuth`** verifies the JWT and loads the user onto `req.user`.
5. **`validateBody`** checks `message` is a 1–4000 character string.
6. **`tutorController.ask`** loads the session — which also proves the student
   owns it — and calls `tutorService.ask`.
7. **`tutorService`** appends the message to the transcript, then:
   - **`triageService`** makes one cheap AI call: in scope? what mode?
   - **`guardService`** applies the two gates. If it refuses, we store the
     redirect as a normal assistant message and return, never reaching the
     expensive call.
   - **`intentService`** settles the mode.
   - The reveal gate is consulted only if the student asked for the answer.
   - **`registry.generateText`** makes the teaching call, retrying and falling
     back across providers as needed.
8. The reply is stored, the session's mode updated, and the controller serialises
   it through `toPublicMessage` — an allow-list, so `finalAnswer` cannot escape.
9. Any thrown error lands in **`errorHandler`**, the one place that formats
   failures.

---

## Why the store sits behind an interface

Nothing outside `src/store/` knows how data is stored. Services call
`store.sessions.findById(...)` and do not care whether that hits a `Map`,
SQLite, or Postgres.

Two details make the eventual swap uneventful:

**Every method is `async`,** even though the in-memory store never waits on
anything. A real database *is* asynchronous. Writing the interface this way now
means callers already `await` everything, so nothing changes when the awaiting
becomes real.

**Reads return deep copies.** A real database hands you a detached row. Without
`structuredClone`, the in-memory store would hand you a live reference and
behave subtly differently — hiding a class of bug that would only surface after
the migration, which is the worst possible time to find it.

---

## Moving to Turso

Turso is the recommended next step: SQLite-compatible, generous free tier, and
one client (`@libsql/client`) that works against a local file in development and
Turso cloud in production. Sessions, messages, and steps are a naturally
relational shape, and it needs no server process to run locally.

The migration is a contained job.

### Checklist

1. **Install the client**
   ```bash
   npm install @libsql/client
   ```

2. **Add the schema.** Six tables mirroring the repositories in `memory.js`:

   ```sql
   CREATE TABLE users (
     id TEXT PRIMARY KEY, is_guest INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
   );

   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     subject_id TEXT NOT NULL, title TEXT, topic TEXT,
     problem TEXT NOT NULL, restated_problem TEXT,
     final_answer TEXT,                      -- never serialised to the client
     status TEXT NOT NULL DEFAULT 'active', mode TEXT,
     answer_policy TEXT NOT NULL DEFAULT 'on_request',
     answer_revealed INTEGER NOT NULL DEFAULT 0,
     current_step_index INTEGER NOT NULL DEFAULT 1,
     reveal_count INTEGER NOT NULL DEFAULT 0,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE INDEX idx_sessions_user ON sessions(user_id, created_at DESC);

   CREATE TABLE steps (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL, instruction TEXT NOT NULL,
     skill TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
   );
   CREATE INDEX idx_steps_session ON steps(session_id, idx);

   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     role TEXT NOT NULL, content TEXT NOT NULL, mode TEXT,
     meta TEXT,                              -- JSON blob
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_messages_session ON messages(session_id, created_at);

   CREATE TABLE practice_sets (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     session_id TEXT, subject_id TEXT, skill TEXT,
     problems TEXT NOT NULL,                 -- JSON, answers included
     results TEXT, submitted_at TEXT, created_at TEXT NOT NULL
   );

   CREATE TABLE mistakes (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     session_id TEXT, subject_id TEXT, topic TEXT, skill TEXT,
     error_type TEXT NOT NULL, error_summary TEXT,
     step_index INTEGER, created_at TEXT NOT NULL
   );
   CREATE INDEX idx_mistakes_user ON mistakes(user_id, created_at DESC);
   ```

3. **Write `src/store/turso.js`** exporting `createTursoStore()` with the same
   six repositories and identical method signatures. `memory.js` is the
   specification — match it method for method.

4. **Add the driver** to the switch in `src/store/index.js`:
   ```js
   case 'turso':
     return createTursoStore();
   ```

5. **Add the env vars** to `config/env.js` and `.env.example`:
   ```
   STORE_DRIVER=turso
   TURSO_DATABASE_URL=libsql://your-db.turso.io   # or file:local.db in dev
   TURSO_AUTH_TOKEN=
   ```
   Add `'turso'` to `VALID_STORE_DRIVERS`.

6. **Run the test suite.** It talks to the API over HTTP and never imports the
   store directly, so it works unchanged as a migration check. Point
   `STORE_DRIVER` at a temporary database and run `npm test` — green means the
   new driver honours the same contract.

**No service, controller, or route changes.** That is the whole point of the
indirection.

### Two things to watch

- **`store.sessions.findById(id, userId)` takes the user id** and returns `null`
  when it does not match. Keep that in the SQL (`WHERE id = ? AND user_id = ?`).
  Ownership is enforced in one place precisely so it cannot be forgotten in one
  route and leak another student's work.
- **`meta`, `problems`, and `results` are JSON blobs.** Serialise on write,
  parse on read, so callers keep seeing plain objects.

---

## The AI provider layer

```
  services  ──►  registry.js  ──►  gemini.js
                     │             openaiCompatible.js  (openrouter, groq, ollama…)
                     │             mock.js
                     ▼
                 fallback chain, retries, structured-output validation
```

`registry.js` exposes three functions: `generateText` (prose), `generateStructured`
(JSON validated against a Zod schema), and `streamText` (SSE).

**Retries** use bounded exponential backoff — but only for failures worth
retrying. A 429 or a 503 is temporary; a rejected API key will fail identically
three times in a row, so it surfaces immediately rather than making a student
wait through two pointless attempts.

**Fallback** moves to `AI_FALLBACK_PROVIDER` when the primary is exhausted. For
streaming this only applies *before* the first chunk reaches the client —
once the student has seen the beginning of an answer, we cannot silently rewind
and start again with a different model.

**Two model tiers** keep costs sane: `AI_MODEL_FAST` handles triage (one call
per turn), while the main model does the teaching. Setting a cheap small model
for the fast tier noticeably reduces the bill.

### Adding a provider

Implement the `Provider` typedef in `registry.js` — `id`, `supportsVision`,
`supportsStreaming`, `chat()`, `stream()` — and add a case to `getProvider()`.
If the service speaks the OpenAI chat format, you do not need a new file at all:
set `AI_PROVIDER=openai-compatible` and point `OPENAI_COMPATIBLE_BASE_URL` at it.

---

## Two things that protect the product

**Responses are built from an allow-list.** `utils/serialize.js` names the
fields to include rather than deleting the ones to hide. A session record holds
`finalAnswer`; if it ever reached the browser, a student could read the answer
from the network tab and the product would quietly stop working, with no error
to warn anyone. With an allow-list, a new secret field is private by default.
With a deny-list it would leak until someone remembered — and nobody remembers.

**The answer gate is a state machine, not a prompt rule.** The final answer is
not included in the prompt until the gate opens. A model cannot leak what it was
never told, which is a much stronger guarantee than asking it to keep a secret.
See [TUTORING-MODEL.md](TUTORING-MODEL.md#the-answer-gate).

---

## Testing

```bash
npm test
```

52 tests, entirely offline, using `AI_PROVIDER=mock`. Each file boots a real
server on a random free port and talks to it over HTTP, so routing, middleware,
validation, and serialisation are all exercised — that is where most real bugs
live.

| File | Covers |
|---|---|
| `smoke.test.js` | Happy path, auth, ownership, every error code |
| `tutor.test.js` | Marking, the reveal gate, modes, SSE, practice |
| `guard.test.js` | The scope/integrity decision table, including false-refusal cases |

Because the mock classifies with keyword heuristics rather than a real model,
`guard.test.js` tests the **policy** — the decision table, the refusal shape,
the 200-not-4xx contract — rather than classification quality. That is the right
split: the policy is ours to get right and ours to regress.

---

## Deploying

Any Node host works — Railway, Render, Fly, a container. Requirements:

- Node 20+ (uses built-in `fetch` and `AbortSignal.any`)
- `JWT_SECRET` set to a real random value; the app refuses to start in
  production with the example value
- `CORS_ORIGINS` set to your real frontend origin, not `*`
- One AI provider key
- `NODE_ENV=production`, which switches logs to JSON and strips stack traces
  from error responses

Health checks: `/health` for liveness, `/health/ready` for readiness. The
readiness check returns 503 when configuration is broken, so a load balancer
stops routing to an instance that would only fail.

`SIGTERM` triggers a graceful shutdown with a 10-second grace period for
in-flight requests — the difference between a clean deploy and a handful of
students seeing an error mid-question.

**Remember that the in-memory store means every restart wipes all data.** Do the
Turso migration before anyone relies on the app.
