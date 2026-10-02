# Marg

**Marg** is an AI tutor that shows its work.

A student brings a real problem — typed, pasted, or photographed. Marg breaks it
into numbered steps, asks them to try each one, then *marks* the attempt: it
circles the exact step that went sideways and explains why, instead of returning
a bare right-or-wrong.

This repository has two parts:

- **`src/`** — the backend: a Node/Express JSON+SSE API. See [docs/API.md](docs/API.md).
- **`frontend/`** — a plain HTML/CSS/JS frontend (no build step, no framework)
  implementing the full product: landing page, subject picker, the tutoring
  session screen, and the mistake/weakness insights dashboard.

The two are decoupled on purpose — the frontend talks to the backend purely
over HTTP/SSE, so either can be deployed independently. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why.

---

## Running it in under a minute

You need [Node.js 20 or newer](https://nodejs.org).

**1. Start the backend:**

```bash
git clone <this repo>
cd Marg--The-Ai-smart-learning-Tutor-

npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:4000/health> — you should see `{"ok":true,...}`.

**2. Serve the frontend** (in a second terminal, from the repo root):

```bash
npx serve frontend -l 8080
```

Open <http://localhost:8080> in your browser. No build step — it's plain files;
`npx serve` (or `python3 -m http.server -d frontend 8080`, or any static
server) is only needed because ES module imports require `http://`, not `file://`.

If your static server runs on a different port, add it to `CORS_ORIGINS` in
`.env` (`localhost:5173` and `localhost:3000` are already allowed by default —
typical Vite/CRA dev ports).

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

**It installs.** The frontend is a real web app — a manifest, a proper icon set
(standard and maskable), and a service worker caching the app shell. "Add to
Home Screen" on mobile or "Install" from the browser's address bar puts Marg
on your device like any native app, opening straight to the subject picker.

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

frontend/
  index.html, app.html, session.html, insights.html   the four screens
  css/             design tokens, base components, per-screen styles
  js/              marg-client.js (the API client), one module per screen
  manifest.json    makes the app installable
  sw.js            service worker — caches the app shell
  icons/           app icons (standard + maskable, 192/512)
```

Every exported function carries a JSDoc comment explaining what it does and why.
If something looks like an odd choice, the comment above it usually says why it
is that way.
