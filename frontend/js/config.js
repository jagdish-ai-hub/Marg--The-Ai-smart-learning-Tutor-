/**
 * The one place that knows where the backend lives. Every other file imports
 * `API_BASE` from here rather than hardcoding a URL — changing where the
 * frontend points (a different port locally, a deployed backend URL) is a
 * one-line edit to this file only.
 *
 * @example
 * import { API_BASE } from './config.js';
 * const marg = new MargClient(API_BASE);
 */

// Defaults to the backend's own dev port. Override by setting
// `window.MARG_API_BASE` before this module loads (e.g. a small inline
// <script> in the HTML <head>) if the backend runs somewhere else.
export const API_BASE = window.MARG_API_BASE ?? 'http://localhost:4000';

// Neon Auth's base URL — this is where "Sign in with Google" actually runs.
// It is public (the same way API_BASE is), not a secret: it is baked into
// every request the Neon Auth client SDK makes from the browser. Set
// `window.MARG_NEON_AUTH_URL` for your own project's Auth base URL
// (Neon Console -> your branch -> Settings -> Auth). With no URL set, the
// Google button simply never appears — see auth.js's `isConfigured`.
export const NEON_AUTH_URL = window.MARG_NEON_AUTH_URL ?? '';
