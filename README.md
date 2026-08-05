# Marg — Backend

The API behind **Marg**, an AI tutor that shows its work.

A student brings a real problem — typed, pasted, or photographed. Marg breaks it
into numbered steps, asks them to try each one, then *marks* the attempt: it
circles the exact step that went sideways and explains why, instead of returning
a bare right-or-wrong.

This repository is **backend only**. No frontend, no UI, no browser build tooling.

---

## Running it in under a minute

You need [Node.js 20 or newer](https://nodejs.org).

```bash
git clone <this repo>
cd Marg--The-Ai-smart-learning-Tutor-

npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:4000/health> — you should see `{"ok":true,...}`.

**No API key? You do not need one to start.** `.env.example` ships with
`AI_PROVIDER=mock`, which returns realistic canned replies with no network calls.
Every endpoint works. A frontend engineer can build the entire app against it
before anyone has bought anything.

When you want real tutoring, get a free [Gemini key](https://aistudio.google.com/apikey)
and edit two lines of `.env`:

```
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key-here
```

Restart, and Marg is live.

---

## Where to go next

| You are… | Read this |
|---|---|
| a frontend engineer wiring up the UI | **[docs/FRONTEND-GUIDE.md](docs/FRONTEND-GUIDE.md)** — auth flow, streaming, and a copy-paste client |
| looking up an endpoint | **[docs/API.md](docs/API.md)** — every route with curl and fetch examples |
| wondering how Marg decides what to do | **[docs/TUTORING-MODEL.md](docs/TUTORING-MODEL.md)** — modes, the answer gate, the guardrails |
| changing the code | **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit, and the database migration path |

---

## What it does

**Four tutoring modes, one session.** The stepped card and the loose chat
bubbles are not two features — they are one conversation that shifts between
`guide` (work through it), `explain` (why does this work?), `discuss` (concept
questions), and `check` (mark my attempt). The frontend can force a mode from a
button, or let Marg read it from what the student typed.

**The answer has friction.** Ask for it once and you get a hint plus an honest
offer. Ask again and you get the full worked solution. That is a state machine,
not a prompt instruction — the answer is not even sent to the model until the
gate opens.

**It teaches, it does not ghostwrite.** Marg happily debugs your loop and
explains recursion — Programming is one of the eight subjects. What it will not
do is take an assignment spec and hand back the finished program, or write your
essay. The boundary is *learning vs. outsourcing*, never the topic, so analysing
Spanish song lyrics for a Languages class is perfectly fine.

**It remembers your mistakes.** Every marked error is tagged and logged, so
Marg can tell you that sign errors have come up four times this week, mostly in
factoring. That is the thing a human tutor does that a grading app does not.

Plus: practice generation ("5 more like this"), a standalone concept explainer,
and photo upload that reads **every** problem on a page rather than one.

---

## Provider support

Marg talks to any of these, chosen with one environment variable:

| `AI_PROVIDER` | What it is |
|---|---|
| `gemini` | Google Gemini, via the REST API |
| `openrouter` | OpenRouter — hundreds of models behind one key |
| `openai-compatible` | Groq, Together, Fireworks, Ollama, LM Studio, vLLM… |
| `mock` | Canned replies, no network. For frontend work and tests |

Set `AI_FALLBACK_PROVIDER` and Marg automatically retries with the second
provider when the first is rate-limited or down.

---

## Commands

```bash
npm run dev     # start with auto-reload
npm start       # start normally
npm test        # run the test suite (offline, no API key needed)
```

The tests run entirely against the mock provider — offline, deterministic, and
free. 52 tests covering the happy path, every error code, the reveal gate, SSE
streaming, and the guardrail decision table.

## Deploying to Render

This repository includes a `render.yaml` Blueprint for both services:

- `marg-api` — Node/Express API with `/health` as its health check
- `marg-web` — Astro static frontend built from the `web/` directory

In Render, choose **New > Blueprint**, connect this repository, and apply the
Blueprint. Render generates `JWT_SECRET` automatically. The default deployment
uses `AI_PROVIDER=mock`, so it starts without an API key; set `AI_PROVIDER` and
the matching provider key in the `marg-api` service to enable a real model.

The Blueprint assumes the default Render URLs `marg-api.onrender.com` and
`marg-web.onrender.com`. If you rename either service or add a custom domain,
update `PUBLIC_MARG_API` on `marg-web` and `CORS_ORIGINS` on `marg-api`, then
redeploy the frontend.

---

## A note on data

The current build stores everything **in memory**. Restart the server and all
sessions are gone. That is a deliberate choice for this stage, not an oversight
— every read and write already goes through a repository interface, so adding a
real database means writing one new file and changing one line of `.env`.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full checklist for moving
to Turso, which is the recommended next step.

---

## Project layout

```
src/
  server.js        start the process
  app.js           build the Express app
  config/          environment variables, validated once at boot
  routes/          every endpoint, in one readable list
  controllers/     parse the request, call a service, shape the response
  services/        the actual logic — tutoring, marking, guardrails, insights
  ai/              provider adapters and structured-output schemas
  prompts/         Marg's personality and its task prompts
  store/           data access, behind a swappable interface
  utils/           errors, SSE, ids, logging, serialisation
tests/             offline test suite
docs/              API reference, frontend guide, architecture
```

Every exported function carries a JSDoc comment explaining what it does and why.
If something looks like an odd choice, the comment above it usually says why it
is that way.
