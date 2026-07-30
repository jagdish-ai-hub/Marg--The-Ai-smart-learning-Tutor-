/**
 * @file Subjects, health checks, and provider information.
 *
 * The endpoints a frontend calls to find out what the backend can do, plus the
 * ones a hosting platform calls to find out whether it is alive.
 */

import { SUBJECTS } from '../data/subjects.js';
import { describeProviders } from '../ai/registry.js';
import { getEnvProblems } from '../config/env.js';
import { env } from '../config/env.js';

/**
 * `GET /api/v1/subjects` — the eight subjects Marg tutors.
 *
 * Fetch this on app start and render the tiles from it, rather than hardcoding
 * the list. Then adding a subject is a backend deploy with no frontend release.
 *
 * Auth: none required.
 * Returns: `{ subjects: [{ id, label, accent, blurb, examples }] }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {void}
 */
export function listSubjects(req, res) {
  res.ok({ subjects: SUBJECTS });
}

/**
 * `GET /health` — liveness check.
 *
 * Answers "is the process running?" and nothing more. It touches no external
 * service on purpose: a hosting platform uses this to decide whether to restart
 * the container, and a slow AI provider must never trigger that.
 *
 * Auth: none required.
 * Returns: `{ status, uptimeSeconds, version }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {void}
 */
export function health(req, res) {
  res.ok({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    environment: env.NODE_ENV,
  });
}

/**
 * `GET /health/ready` — readiness check.
 *
 * Answers "is it actually able to serve requests?" — configuration is valid and
 * an AI provider is configured. Returns 503 when not, so a load balancer stops
 * sending traffic to an instance that would only fail.
 *
 * Auth: none required.
 * Returns: `{ status, checks }` — 200 when ready, 503 when not.
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {void}
 */
export function ready(req, res) {
  const problems = getEnvProblems();
  const providers = describeProviders();

  const checks = {
    config: problems.length === 0 ? 'ok' : 'failed',
    store: env.STORE_DRIVER,
    aiProvider: providers.active,
    // Worth surfacing: it means data is lost on restart, which is a real
    // operational fact rather than an error.
    persistence: env.STORE_DRIVER === 'memory' ? 'ephemeral' : 'durable',
  };

  const isReady = problems.length === 0;
  res.status(isReady ? 200 : 503).json({
    ok: isReady,
    data: { status: isReady ? 'ready' : 'not_ready', checks, problems },
    requestId: req.id,
  });
}

/**
 * `GET /api/v1/meta/providers` — which AI providers are configured.
 *
 * Mostly useful for one decision on the frontend: whether to show the "snap a
 * photo" button. If `supportsVision` is false, hide it rather than letting a
 * student take a photo and then fail.
 *
 * Auth: none required.
 * Returns: `{ active, fallback, supportsVision, providers }`
 *
 * @param {import('express').Request} req - The request.
 * @param {import('express').Response} res - The response.
 * @returns {void}
 */
export function providers(req, res) {
  res.ok(describeProviders());
}
