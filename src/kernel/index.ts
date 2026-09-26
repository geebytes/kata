/**
 * The kernel's public surface.
 *
 * `src/kernel/**` is pure: no filesystem, no child process, no network, no platform name. Everything above it —
 * producers, stores, the CLI, the assurance overlay — is replaceable, and the only thing every platform must implement
 * together is what this module exports.
 */
export * from './types.js';
export * from './subject.js';
export * from './evidence.js';
export * from './delta.js';
export * from './risk.js';
export * from './policy.js';
export * from './budget.js';
export * from './decide.js';
