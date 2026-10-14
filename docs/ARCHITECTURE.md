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
       └──────────────► store/index.js ──► memory.js (guests) + pgSessionStore.js (signed in)
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

## Session history: memory for guests, Postgres for signed-in students

This is done, not a future plan — `src/store/pgSessionStore.js` and the
router in `src/store/index.js`. It's here because it's the same "swap the
backend without touching a service" promise the section above describes, just
exercised for real, and because the result is a *hybrid*, not a wholesale
swap — worth explaining why.

A guest has no account, so there is nothing to keep durable for them: memory
is free, instant, and the ephemeral-ness is the deal they're getting (see
`docs/PROGRESS.md`, "Accounts & the free tier"). A signed-in student made an
account specifically so their history sticks, so *their* sessions, steps,
messages, practice sets, and mistakes live in Postgres — the same Neon
database as their account — instead.

**The routing trick: ids already carry their backend, not just their kind.**
`utils/ids.js`'s whole premise is that a prefix tells you what something is
at a glance (`ses_`, `msg_`, …). Postgres-owned records extend that one step:
they get a *second* prefix layer — `pses_`, `pmsg_`, `pstp_`, `pset_`, `pmst_`
— so `store/index.js` can route `store.messages.append({ sessionId, … })`
correctly with one string check (`sessionId.startsWith('p')`), no database
lookup, no extra parameter threaded through every call site. The two calls
that start from scratch (`sessions.create`, `practiceSets.create`,
`mistakes.record` — anything keyed by `userId` instead of an existing id)
route on `userId` instead: a guest's id is always `usr_…`
(`utils/ids.js`'s `newUserId()`); a signed-in student's is whatever Neon
Auth's `sub` claim gave it (a bare UUID, never `usr_`-prefixed) — see
`pgUsers.js`.

**No service or controller changes were needed at all.** Every one of them
already called `store.sessions.*`/`store.messages.*`/etc. generically — that
was the whole point of the indirection described above — so the router in
`store/index.js` is the entire diff.

### Adding a new store-backed entity

Follow the same shape: give it a kind prefix in `utils/ids.js`, implement it
in both `memory.js` and `pgSessionStore.js` with identical method signatures
and return shapes (field names and all — nothing downstream should be able
to tell which one answered), then add the two-line dispatch to
`store/index.js`. The existing repositories are the specification; match them
method for method.

### Two things to watch

- **`sessions.findById(id, userId)` takes the user id** and returns `null`
  when it does not match, in both backends. Ownership is checked in one
  place precisely so it cannot be forgotten in one route and leak another
  student's work.
- **`meta`, `problems`, and `results` are JSON/JSONB.** `pgSessionStore.js`
  serialises on write and the driver parses JSONB back to a plain object on
  read, so callers see the same shape either way.

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

54 tests, entirely offline, using `AI_PROVIDER=mock`. Each file boots a real
server on a random free port and talks to it over HTTP, so routing, middleware,
validation, and serialisation are all exercised — that is where most real bugs
live. Every test uses a guest account, so none of them ever touch Postgres —
that's `quota.test.js`'s own comment on why it has to set its guest limit
*before* importing the shared test helpers.

| File | Covers |
|---|---|
| `smoke.test.js` | Happy path, auth, ownership, every error code |
| `tutor.test.js` | Marking, the reveal gate, modes, SSE, practice |
| `guard.test.js` | The scope/integrity decision table, including false-refusal cases |
| `quota.test.js` | The guest message cap and its 429 |

Because the mock classifies with keyword heuristics rather than a real model,
`guard.test.js` tests the **policy** — the decision table, the refusal shape,
the 200-not-4xx contract — rather than classification quality. That is the right
split: the policy is ours to get right and ours to regress.

---

## Deploying

Any Node host works — Railway, Render, Fly, a container (a ready-to-use
Dockerfile is at [docs/DOCKER.md](DOCKER.md), kept as markdown until it's
actually wired up). Not Cloudflare Workers as-is: this is a long-running
Express process with an in-memory half of the store, and Workers isolates
are stateless and can be evicted anytime — see `docs/PROGRESS.md`'s
"Deploying" section for exactly what a Workers port would need to change.

Requirements:

- Node 20+ (uses built-in `fetch` and `AbortSignal.any`)
- `JWT_SECRET` set to a real random value; the app refuses to start in
  production with the example value
- `CORS_ORIGINS` set to your real frontend origin, not `*`
- One AI provider key
- `NODE_ENV=production`, which switches logs to JSON and strips stack traces
  from error responses
- Optionally, `DATABASE_URL` and `NEON_AUTH_BASE_URL` to turn on Google
  sign-in and persistent session history for signed-in students — see
  `.env.example`. Without them the app runs guest-only, exactly as before
  either feature existed.

Health checks: `/health` for liveness, `/health/ready` for readiness. The
readiness check returns 503 when configuration is broken, so a load balancer
stops routing to an instance that would only fail.

`SIGTERM` triggers a graceful shutdown with a 10-second grace period for
in-flight requests — the difference between a clean deploy and a handful of
students seeing an error mid-question.

**Remember that the in-memory store means every restart wipes all data.** Do the
Turso migration before anyone relies on the app.
