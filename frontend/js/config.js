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
