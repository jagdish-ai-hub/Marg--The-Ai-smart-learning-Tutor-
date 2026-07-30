# Marg API Reference

Base URL in development: `http://localhost:4000`
All endpoints below are prefixed with `/api/v1` unless stated otherwise.

---

## The response envelope

**Every** response has the same shape. Check `ok` first, always.

**Success**
```json
{
  "ok": true,
  "data": { },
  "requestId": "req_a1b2c3d4e5f6"
}
```

**Failure**
```json
{
  "ok": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "No session with that id.",
    "details": { }
  },
  "requestId": "req_a1b2c3d4e5f6"
}
```

Branch on `error.code`, never on `error.message`. Codes are stable; wording is not.

`requestId` is also returned as the `X-Request-Id` header. Include it in bug
reports — it finds the exact request in the server logs.

> ### One thing to internalise before you build anything
>
> **A guardrail refusal is `ok: true` with HTTP 200.** When a student asks
> something off topic, or asks Marg to write their essay, you get a normal
> assistant message with `meta.refused: true`. Render it as an ordinary chat
> bubble. It is not an error state, and treating it as one will make your UI
> flash a red banner at a perfectly normal moment in the conversation.

---

## Error codes

| Code | HTTP | What happened | What to do |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing, invalid, or expired token | Call `POST /auth/guest`, store the new token, retry once |
| `FORBIDDEN` | 403 | Not yours | Show a generic "not available" |
| `VALIDATION_FAILED` | 422 | A field is missing or wrong | Read `details.fields` and highlight the inputs |
| `NOT_FOUND` | 404 | No such route | A bug in your client — check the path |
| `SESSION_NOT_FOUND` | 404 | Unknown session, or someone else's | Return to the session list |
| `STEP_NOT_FOUND` | 404 | Unknown `stepId` | Refetch the session |
| `PRACTICE_SET_NOT_FOUND` | 404 | Unknown practice set | Refetch |
| `SUBJECT_NOT_FOUND` | 404 | Unknown subject id | Refetch `GET /subjects` |
| `RATE_LIMITED` | 429 | Too many requests | Back off; read the `RateLimit-Reset` header |
| `UPLOAD_REJECTED` | 400 | Image too large or wrong format | Tell the user the limit |
| `PROVIDER_UNAVAILABLE` | 502 | The AI service failed | Offer a retry button |
| `PROVIDER_TIMEOUT` | 504 | The AI service was too slow | Offer a retry button |
| `PROVIDER_BAD_RESPONSE` | 502 | The AI replied in an unusable shape | Offer a retry button |
| `VISION_UNSUPPORTED` | 501 | This provider cannot read images | Hide the camera button; check `GET /meta/providers` |
| `INTERNAL_ERROR` | 500 | A bug on our side | Show a generic error with the `requestId` |

> **Note on invalid subject ids.** Sending `subjectId: "astrology"` returns
> **422 `VALIDATION_FAILED`**, not `SUBJECT_NOT_FOUND` — the subject list is
> validated at the route boundary, so you get precise field errors.
> `SUBJECT_NOT_FOUND` is reserved for endpoints reached another way.

---

## Authentication

There is no signup. Call `POST /auth/guest` once, keep the token, send it as
`Authorization: Bearer <token>` on everything else.

### `POST /auth/guest`

Creates an anonymous account. **No auth required.**

```bash
curl -X POST http://localhost:4000/api/v1/auth/guest
```

```json
{
  "ok": true,
  "data": {
    "user": { "id": "usr_a1b2c3d4e5f6", "isGuest": true, "createdAt": "2026-01-15T10:30:00.000Z" },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2026-02-14T10:30:00.000Z"
  }
}
```

```js
const res = await fetch('http://localhost:4000/api/v1/auth/guest', { method: 'POST' });
const { data } = await res.json();
localStorage.setItem('marg_token', data.token);
```

### `POST /auth/refresh`

Exchanges a valid token for a fresh one. **Auth required.** Call it when the
stored token is within a few days of `expiresAt`.

Returns the same shape as `/auth/guest`.

### `GET /auth/me`

Returns the current user. **Auth required.** A cheap way to check on startup
whether a stored token is still good.

---

## Reference data

### `GET /subjects`

The eight subjects. **No auth required** — the landing page renders these
before anyone signs up.

```bash
curl http://localhost:4000/api/v1/subjects
```

```json
{
  "ok": true,
  "data": {
    "subjects": [
      {
        "id": "mathematics",
        "label": "Mathematics",
        "accent": "amber",
        "blurb": "Algebra, calculus, geometry, statistics — worked one step at a time.",
        "examples": ["Solve 2x² − 5x − 3 = 0", "Differentiate x·sin(x)"]
      }
    ]
  }
}
```

`accent` is a colour *token* (`amber`, `blue`, `green`, `rose`) — map it to your
own palette. The backend never sends hex codes.

Fetch this rather than hardcoding the list, and adding a ninth subject needs no
frontend release.

### `GET /meta/providers`

Which AI providers are configured. **No auth required.**

```json
{
  "ok": true,
  "data": {
    "active": "gemini",
    "fallback": "openrouter",
    "supportsVision": true,
    "providers": [{ "id": "gemini", "supportsVision": true, "supportsStreaming": true }]
  }
}
```

Use `supportsVision` to decide whether to show the camera button.

### `GET /health` and `GET /health/ready`

Not under `/api/v1`. `/health` is a liveness check (always fast, touches
nothing). `/health/ready` returns **503** when configuration is broken.

---

## Sessions

### `POST /sessions`

Starts a session and returns the numbered step plan. **Auth required.**
This is the slowest call in the API — it runs the guardrails, then asks the AI
to plan the steps. Expect a few seconds; show a loading state.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `subjectId` | string | yes | An id from `GET /subjects` |
| `problem` | string | yes | 3–4000 chars, in the student's own words |
| `answerPolicy` | string | no | `on_request` (default), `after_attempt`, or `never` |

```bash
curl -X POST http://localhost:4000/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"subjectId":"mathematics","problem":"solve 2x^2 - 5x - 3 = 0"}'
```

**201 Created**
```json
{
  "ok": true,
  "data": {
    "refused": false,
    "session": {
      "id": "ses_3dfc35323d1f",
      "subjectId": "mathematics",
      "title": "Quadratic equations",
      "topic": "Factoring quadratics",
      "problem": "solve 2x^2 - 5x - 3 = 0",
      "restatedProblem": "solve 2x² − 5x − 3 = 0",
      "status": "active",
      "mode": "guide",
      "answerPolicy": "on_request",
      "currentStepIndex": 1,
      "revealCount": 0,
      "answerRevealed": false,
      "createdAt": "2026-01-15T10:30:00.000Z",
      "updatedAt": "2026-01-15T10:30:00.000Z"
    },
    "steps": [
      { "id": "stp_b54947b5f391", "index": 1, "instruction": "Factor the quadratic into two brackets.", "skill": "factoring", "status": "active" },
      { "id": "stp_a1bdfb38bc7b", "index": 2, "instruction": "Set each factor equal to zero.", "skill": "zero-product-property", "status": "pending" },
      { "id": "stp_b12a98f73107", "index": 3, "instruction": "Solve each small equation for x.", "skill": "linear-equations", "status": "pending" }
    ]
  }
}
```

**200 OK — refused by the guardrails**
```json
{
  "ok": true,
  "data": {
    "refused": true,
    "refusalReason": "integrity",
    "session": null,
    "steps": [],
    "message": {
      "role": "assistant",
      "content": "I'm not going to produce that one for you — it's the bit you're being marked on.\n\nI'd rather get you there than hand it over...",
      "meta": { "refused": true }
    }
  }
}
```

`refusalReason` is `off_topic` or `integrity`. **Always check `refused` before
reading `session`** — it is `null` when refused.

> The session object never contains `finalAnswer`. That is deliberate: if the
> answer shipped with the plan, anyone could read it from the network tab.

**Step `status` values:** `pending` · `active` · `correct` · `incorrect` · `revealed`

### `GET /sessions`

Lists the user's sessions, newest first. **Auth required.**

Query: `limit` (1–100, default 20), `offset` (default 0)

```json
{ "ok": true, "data": { "sessions": [], "total": 12, "limit": 20, "offset": 0 } }
```

### `GET /sessions/:id`

One session with its steps **and full transcript**. **Auth required.**
This is the reopen-a-session call — everything needed to rebuild the screen.

```json
{
  "ok": true,
  "data": {
    "session": { },
    "steps": [ ],
    "messages": [
      { "id": "msg_…", "role": "user", "content": "solve 2x^2 - 5x - 3 = 0", "mode": "guide", "meta": {}, "createdAt": "…" },
      { "id": "msg_…", "role": "assistant", "content": "Let us take this one step at a time…", "mode": "guide", "meta": { "refused": false }, "createdAt": "…" }
    ]
  }
}
```

### `PATCH /sessions/:id`

Renames a session. **Auth required.** Body: `{ "title": "My quadratic" }`

### `DELETE /sessions/:id`

Deletes a session and its transcript. **Auth required.** Returns `{ "deleted": true }`.

---

## Tutoring

Every endpoint here accepts an optional `mode` — `guide`, `explain`, `discuss`,
or `check` — to force a behaviour from a UI button. Omit it and Marg infers the
mode from the message. See [TUTORING-MODEL.md](TUTORING-MODEL.md).

### `POST /sessions/:id/ask`

Send a message, get the whole reply. **Auth required.**

**Body:** `{ "message": "why does the sign flip here?", "mode": "explain" }` (mode optional)

```json
{
  "ok": true,
  "data": {
    "message": { "id": "msg_…", "role": "assistant", "content": "Because you divided by a negative…", "mode": "explain", "meta": { "refused": false }, "createdAt": "…" },
    "mode": "explain",
    "refused": false,
    "revealAvailable": false,
    "session": { }
  }
}
```

`revealAvailable: true` means the student asked for the answer and asking once
more would unlock it. Show a "show me the answer" button.

### `GET /sessions/:id/ask/stream`

The same thing, streamed over Server-Sent Events. **Auth required.**

A **GET** so the browser's native `EventSource` works directly. `EventSource`
cannot set headers, so the token may go in `?token=` here.

**Query:** `message` (required), `mode` (optional), `token` (optional)

```bash
curl -N "http://localhost:4000/api/v1/sessions/$SES/ask/stream?message=why%20does%20the%20sign%20flip&token=$TOKEN"
```

```
event: start
data: {"sessionId":"ses_…","mode":"explain","refused":false}

event: delta
data: {"text":"Because you divided by"}

event: delta
data: {"text":" a negative — that"}

event: done
data: {"messageId":"msg_…","mode":"explain","refused":false,"refusalReason":null,"revealAvailable":false,"usage":{"inputTokens":312,"outputTokens":48}}
```

| Event | When | Payload |
|---|---|---|
| `start` | Once, first. Mode is now known | `{ sessionId, mode, refused }` |
| `delta` | Many times | `{ text }` — append to what you have |
| `done` | Once, last | `{ messageId, mode, refused, refusalReason, revealAvailable, usage }` |
| `error` | Instead of `done`, on failure | `{ code, message }` |

Lines beginning `:` are heartbeat comments sent every 15s. `EventSource` ignores
them automatically.

Closing the connection aborts the upstream AI call.

Full client code is in [FRONTEND-GUIDE.md](FRONTEND-GUIDE.md#streaming).

### `POST /sessions/:id/hint`

The smallest useful nudge for the current step. **Auth required.**
**Does not count against the reveal gate** — a hint is not an answer.

**Body:** `{ "stepIndex": 3 }` (optional; defaults to the current step)

### `POST /sessions/:id/reveal`

Ask for the final answer. **Auth required.** No body.

**This is the friction gate.**

| Call | Response |
|---|---|
| 1st | `revealed: false`, a hint, `revealAvailable: true`, `requirement: "ask_again"` |
| 2nd | `revealed: true` and the full worked solution |

```json
{
  "ok": true,
  "data": {
    "message": { },
    "revealed": false,
    "revealAvailable": true,
    "requirement": "ask_again",
    "session": { },
    "steps": [ ]
  }
}
```

`requirement` is `ask_again`, `attempt_first`, or `policy_never`.

When `revealAvailable` is `false` **and** `revealed` is `false`, the gate can
never open (`answerPolicy: "never"`) — hide the button rather than offering
something that cannot happen.

### `POST /sessions/:id/check`

Mark the student's working. **Auth required.** This is the product's centrepiece.

**Body:** `{ "attempt": "x = 1/2 or x = -3", "stepId": "stp_…" }` (`stepId` optional)

```json
{
  "ok": true,
  "data": {
    "marking": {
      "overall": "incorrect",
      "firstBrokenStepIndex": 3,
      "steps": [
        { "index": 1, "verdict": "correct", "comment": "The factoring is right — (2x + 1)(x − 3)." },
        { "index": 2, "verdict": "correct", "comment": "You set both factors to zero correctly." },
        { "index": 3, "verdict": "incorrect", "comment": "Both signs came out backwards when you solved each bracket." }
      ],
      "errorType": "sign_error",
      "errorSummary": "Signs flipped when solving each factor for x.",
      "nudge": "Take 2x + 1 = 0 on its own. If you subtract 1 from both sides first, what is x?"
    },
    "message": { },
    "steps": [ ],
    "session": { }
  }
}
```

- `firstBrokenStepIndex` (1-based, or `null` when everything is right) is **the
  step to circle** in the UI.
- `verdict` per step: `correct` · `partially_correct` · `incorrect` · `not_attempted`
- `nudge` never contains the final answer.
- `steps` comes back updated so you can repaint the progress bar in one go.

### `POST /sessions/:id/explain`

Explain one step in more depth — the "wait, why does the sign flip here?"
moment. **Auth required.** Never unlocks the final answer.

**Body:** `{ "stepId": "stp_…", "question": "why does the sign flip here?" }` (both optional)

---

## Practice

### `POST /sessions/:id/practice`

Generate fresh problems on the same skill. **Auth required.**
Defaults to drilling the step the student got **wrong**.

**Body:** `{ "count": 3, "skill": "factoring" }` (both optional; count 1–10, default 3)

```json
{
  "ok": true,
  "data": {
    "practiceSet": {
      "id": "set_…",
      "skill": "factoring",
      "subjectId": "mathematics",
      "sessionId": "ses_…",
      "submittedAt": null,
      "problems": [
        { "index": 1, "prompt": "Solve x² − 5x + 6 = 0", "difficulty": "easier" },
        { "index": 2, "prompt": "Solve 3x² + 5x − 2 = 0", "difficulty": "same" },
        { "index": 3, "prompt": "Solve 6x² − 7x − 3 = 0", "difficulty": "harder" }
      ]
    }
  }
}
```

Note there is **no `answer` field**. Answers appear only after submission.

### `POST /practice/:setId/submit`

Mark a completed set. **Auth required.**

**Body:** `{ "answers": [{ "index": 1, "answer": "x = 2 or x = 3" }] }`

The response repeats `practiceSet` with `answer` now present on every problem,
plus:

```json
{
  "results": {
    "correctCount": 1,
    "total": 3,
    "perProblem": [{ "index": 1, "verdict": "correct", "comment": "…" }],
    "errorType": "arithmetic_slip",
    "errorSummary": "…",
    "nudge": "Re-check the arithmetic in the middle step, one operation at a time."
  }
}
```

---

## Concepts

### `POST /concepts/explain`

Explain a concept with no problem attached. **Auth required.**

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `subjectId` | string | yes | From `GET /subjects` |
| `concept` | string | yes | 2–300 chars |
| `depth` | string | no | `quick`, `standard` (default), or `deep` |

```json
{ "ok": true, "data": { "explanation": "An eigenvalue tells you…", "refused": false } }
```

---

## Insights — the mistake log

### `GET /insights/weaknesses`

Recurring mistake patterns. **Auth required.**
Query: `days` (1–365, default 30), `limit` (1–20, default 5)

```json
{
  "ok": true,
  "data": {
    "windowDays": 30,
    "totalMistakes": 7,
    "patterns": [
      {
        "errorType": "sign_error",
        "label": "Sign errors",
        "count": 4,
        "topSkill": "factoring",
        "subjects": ["mathematics"],
        "lastSeenAt": "2026-01-15T10:30:00.000Z",
        "examples": ["Signs flipped when solving each factor for x."],
        "summary": "Sign errors came up 4 times, mostly in factoring."
      }
    ]
  }
}
```

`summary` is written ready to render — do not rebuild it from the parts.

An empty `patterns` array is normal for a new user. Show an encouraging empty
state, not an error.

### `GET /insights/activity`

How much the student has been working. **Auth required.** Query: `days`.

```json
{
  "ok": true,
  "data": {
    "windowDays": 30,
    "totalSessions": 12,
    "sessionsInWindow": 9,
    "completedInWindow": 5,
    "stepsCompleted": 23,
    "bySubject": [{ "subjectId": "mathematics", "count": 6 }]
  }
}
```

---

## Vision

### `POST /vision/transcribe`

Read a photo of a page. **Auth required.** `multipart/form-data`, file field
named `image`. Max size is `MAX_UPLOAD_MB` (default 8 MB).

```bash
curl -X POST http://localhost:4000/api/v1/vision/transcribe \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@homework.jpg"
```

```json
{
  "ok": true,
  "data": {
    "subjectId": "mathematics",
    "problems": [
      { "label": "4a", "text": "Solve 2x² − 5x − 3 = 0" },
      { "label": "4b", "text": "Solve x² + 4x + 4 = 0" }
    ],
    "studentWorking": null
  }
}
```

Returns **every** problem on the page, not just one.

**This does not create a session.** Show the student what was read, let them fix
any transcription errors, then call `POST /sessions` with the corrected text.
Catching a misread `5` for an `S` up front beats discovering it three steps in.

`studentWorking` holds any handwriting found on the page, transcribed exactly —
mistakes included, since finding those is the whole point. Feed it straight to
`POST /sessions/:id/check`.

Accepted formats: JPEG, PNG, WebP, HEIC, HEIF.

---

## Rate limits

| Tier | Default | Applies to |
|---|---|---|
| AI endpoints | 20/min | Anything that calls the model |
| General | 120/min | Listing, reading, subjects, auth |

Counted per user (falling back to IP for unauthenticated calls) — so a whole
school behind one NAT gateway does not share a single quota.

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.
