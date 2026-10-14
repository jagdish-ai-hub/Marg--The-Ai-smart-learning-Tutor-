# Docker

Kept as markdown on purpose, not as a live `Dockerfile` — the content below is
ready to use, but isn't wired up yet so it can't interfere with a Render
deploy that doesn't use it. When you're ready to switch formats:

1. Save the first block as `Dockerfile` at the repo root.
2. Save the second block as `.dockerignore` at the repo root.
3. Delete this file, or just leave it — a stray `.md` file changes nothing.

Only the **backend** (`src/`) needs this. The frontend is static files with no
build step — see [FRONTEND-GUIDE.md](FRONTEND-GUIDE.md) — so it deploys as a
plain static site (Render's "Static Site" service, Cloudflare Pages, Netlify,
anywhere that serves files) with no Docker involved either way.

---

## `Dockerfile`

A two-stage build: the first stage installs dependencies (including dev
tools `npm ci` needs), the second copies only what runs in production into a
smaller, non-root image.

```dockerfile
# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs as a non-root user — the image shouldn't be able to do more than the
# app itself needs to.
RUN addgroup -S marg && adduser -S marg -G marg

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER marg

# Render (and most hosts) inject PORT; src/config/env.js reads it with a
# fallback to 4000 for local runs.
EXPOSE 4000

# Matches GET /health in src/routes/index.js — a container that can't answer
# this isn't serving traffic, whatever the process list says.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
```

## `.dockerignore`

Keeps the build context small and stops local secrets or scratch files from
ever reaching the image.

```
node_modules
npm-debug.log
.env
.env.*
!.env.example
.git
.gitignore
docs
frontend
tests
scripts
*.md
```

---

## Building and running locally

```bash
docker build -t marg-backend .
docker run --rm -p 4000:4000 --env-file .env marg-backend
```

`AI_PROVIDER=mock` in `.env` runs it with no API key and no network calls at
all — the fastest way to confirm the image itself is healthy before pointing
it at a real provider or a real `DATABASE_URL`.

## Where this fits next to Render

Render can deploy a Node app two ways: point it at the repo and let it run
`npm install && npm start` directly (no Dockerfile needed — this is the
simpler path, and what `npm start`/`package.json`'s `engines: { node: ">=20" }`
already describe), or point it at this `Dockerfile` for a "Docker" service
type if you want the exact same image runnable anywhere else too (a VPS,
Fly.io, any container host). Both read the same environment variables — see
`.env.example` — so switching between them later is a Render dashboard
setting, not a code change.
