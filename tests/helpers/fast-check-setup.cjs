'use strict';

/**
 * fast-check-setup.cjs
 *
 * Shared configuration for all property-based tests. Require this at the
 * top of every *.property.test.cjs file before any fc.assert() call.
 *
 * Settings:
 *   numRuns: 200  — enough to catch boundary bugs without slow CI
 *   seed: 42      — deterministic across CI runs; set GSD_FC_SEED=<n> to
 *                   override locally for exploration
 */

const fc = require('fast-check');

const seed = process.env.GSD_FC_SEED ? Number(process.env.GSD_FC_SEED) : 42;

fc.configureGlobal({
  numRuns: 200,
  seed,
});

module.exports = fc;
