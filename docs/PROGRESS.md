# Progress

What's actually built, as of this writing, and what isn't yet. The other docs
in this folder explain *how* things work ([ARCHITECTURE.md](ARCHITECTURE.md),
[API.md](API.md), [TUTORING-MODEL.md](TUTORING-MODEL.md),
[FRONTEND-GUIDE.md](FRONTEND-GUIDE.md)) — this one tracks *what's done*, so
it's the one to skim for a status check rather than re-reading the others.

Everything below is merged into `main`.

---

## Backend

- Express API with JWT auth, rate limiting, structured error envelope — see
  [API.md](API.md) for the full endpoint list.
- Four AI providers behind one interface: Gemini (native), OpenRouter, any
  OpenAI-compatible endpoint (Groq, DeepSeek, etc.), and a `mock` provider for
  offline frontend work. Switching is a `.env` change, not a code change.
- The tutoring state machine: step plans, four response modes
  (guide/explain/discuss/check), the two-step answer-reveal gate, marking that
  names the exact broken step — see [TUTORING-MODEL.md](TUTORING-MODEL.md).
- Topic + academic-integrity guardrails via a cheap triage call, fails open
  (never blocks a student over an AI hiccup).
- Weakness/insights tracking (recurring mistake patterns) and practice-set
  generation.
- Photo-to-problem transcription (vision models only).
- SSE streaming for chat replies.

## Frontend

- Plain HTML/CSS/JS, no framework, no build step — see
  [FRONTEND-GUIDE.md](FRONTEND-GUIDE.md).
- Four screens: landing, home (subject picker + composer), session (the actual
  tutoring UI), insights (mistake dashboard).
- Installable PWA: manifest, service worker, icon set.

## Accounts & the free tier

- **Guests**: no signup, capped at 10 lifetime messages (in-memory, resets if
  the server restarts — same as the rest of guest data).
- **Signed in with Google**: 30 messages/day, tracked in Postgres so it
  survives restarts. Sign-in runs through Neon's Managed Better Auth using
  their *shared* Google OAuth credentials — no Google Cloud Console app, no
  client secret to manage. Verified backend-side via JWKS (`src/services/googleAuth.js`),
  then folded into the same JWT guests already get — nothing downstream knows
  Google is involved.
- No paid tier yet. That's the explicit next step once the free tier needs a
  ceiling.

## Infrastructure

- Postgres: a Neon project (`marg-tutor`) holding signed-in accounts
  (`app_users` table) and Neon's own Managed Better Auth schema. Queried over
  HTTP (`@neondatabase/serverless`), not a raw socket, so it works from hosts
  that only allow outbound HTTP(S).
- Session/message data itself is still the in-memory store described in
  [ARCHITECTURE.md](ARCHITECTURE.md) — only accounts moved to Postgres so far.

## Provider reliability fixes (found by testing against real providers)

- `gemini-2.5-flash` was retired for new accounts; default moved to the
  confirmed-working `gemini-3.5-flash-lite`.
- Some OpenAI-compatible endpoints (DeepSeek, confirmed again on Groq's
  `gpt-oss-120b`) reject strict `json_schema` mode — added automatic
  detection + fallback to `json_object` mode.
- Reasoning models (DeepSeek's flash tier) spend part of their token budget on
  internal reasoning before the real answer — raised `maxTokens` across every
  structured call to give that headroom.

## Testing

- 54 backend tests passing (`npm test`), including the free-tier quota logic.
- Guest flow + quota enforcement verified live in a headless browser (session
  creation, the 10-message cap, the exact user-facing message).
- Model research: compared Groq's four chat-capable models
  (`gpt-oss-20b`/`120b`, `qwen3.8-27b`, `allam-2-7b`) against Marg's real
  prompts — `qwen3.8-27b` came out fastest and most correct.

## Not done yet

- Paid tier / billing.
- Production Google OAuth branding (shared credentials show Neon's name on
  the consent screen — fine for now, see `docs/FRONTEND-GUIDE.md`'s auth
  section and `frontend/js/auth.js`'s header comment for the production
  swap-in path).
- Sessions/messages themselves still reset on server restart (only accounts
  are persistent so far).
