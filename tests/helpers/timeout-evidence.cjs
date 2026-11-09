'use strict';

/**
 * Validator for timeout evidence records (#4689).
 *
 * TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence" requires every
 * numeric constant exported by tests/helpers/timeouts.cjs to carry a TIMEOUT_EVIDENCE entry.
 * `validateTimeoutEvidence` is pure: it takes the exports object and the evidence map and returns
 * every violation, sorted by constant then rule, so one run reports all defects at once.
 *
 * Evidence kinds:
 *   measured      observedMaxMs + worstPlatform + samples + source; value >= minMargin * observed.
 *                 A censored entry (no record above the slow-spawn threshold) sets
 *                 censoredBelowMs, uses the threshold as observedMaxMs, and may omit the platform.
 *   mirror        of: { module, export }; the value must equal that export exactly.
 *   fixture-data  the value is fixture payload, not a spawn bound; needs a reason.
 *   test-backstop an outer guard around a test, not a spawn bound; needs a reason.
 */

const path = require('node:path');

/** Smallest accepted ratio of a measured constant to its worst observed duration. */
const MIN_TIMEOUT_MARGIN = 2;

const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const EXEMPT_KINDS = new Set(['fixture-data', 'test-backstop']);

function defaultResolveMirror(of) {
  // Module paths in evidence are repo-relative; this file lives at tests/helpers/.
  return require(path.join(__dirname, '..', '..', of.module))[of.export];
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function samplesValid(samples) {
  if (!isPlainObject(samples)) return false;
  const counts = Object.values(samples);
  if (counts.length === 0) return false;
  if (!counts.every((n) => Number.isInteger(n) && n >= 0)) return false;
  return counts.some((n) => n > 0);
}

function checkMeasured(name, value, entry, minMargin) {
  const out = [];
  const add = (rule, detail) => out.push({ constant: name, rule, detail });

  const observed = entry.observedMaxMs;
  const observedOk = isPositiveFinite(observed);
  if (!observedOk) add('invalid-observed', `observedMaxMs must be a positive finite number, got ${String(observed)}`);

  const censored = entry.censoredBelowMs !== undefined;
  if (censored) {
    if (!isPositiveFinite(entry.censoredBelowMs) || (observedOk && observed !== entry.censoredBelowMs)) {
      add('invalid-censor', `censored entry must state its threshold as observedMaxMs (censoredBelowMs ${String(entry.censoredBelowMs)}, observedMaxMs ${String(observed)})`);
    }
    if (entry.worstPlatform !== null && entry.worstPlatform !== undefined && !PLATFORMS.has(entry.worstPlatform)) {
      add('invalid-platform', `worstPlatform must be win32, darwin, linux or null, got ${String(entry.worstPlatform)}`);
    }
  } else if (!PLATFORMS.has(entry.worstPlatform)) {
    add('invalid-platform', `worstPlatform must be win32, darwin or linux, got ${String(entry.worstPlatform)}`);
  }

  if (!samplesValid(entry.samples)) add('invalid-samples', `samples must map platforms to non-negative integers with at least one > 0, got ${JSON.stringify(entry.samples)}`);
  if (!isNonEmptyString(entry.source)) add('missing-source', 'measured evidence must name its source');

  if (observedOk && value < minMargin * observed) {
    add('margin-below-minimum', `value ${value} is ${(Math.floor((value / observed) * 100) / 100).toFixed(2)}x observed ${observed}; minimum is ${minMargin}x`);
  }
  return out;
}

function checkMirror(name, value, entry, resolveMirror) {
  const of = entry.of;
  if (!isPlainObject(of) || !isNonEmptyString(of.module) || !isNonEmptyString(of.export)) {
    return [{ constant: name, rule: 'mirror-unresolvable', detail: 'mirror evidence needs of: { module, export }' }];
  }
  let source;
  try {
    source = resolveMirror(of);
  } catch (err) {
    return [{ constant: name, rule: 'mirror-unresolvable', detail: `${of.module}#${of.export}: ${err.message}` }];
  }
  if (typeof source !== 'number') {
    return [{ constant: name, rule: 'mirror-unresolvable', detail: `${of.module}#${of.export} is not a number (${String(source)})` }];
  }
  if (source !== value) {
    return [{ constant: name, rule: 'mirror-mismatch', detail: `value ${value} differs from ${of.module}#${of.export} = ${source}` }];
  }
  return [];
}

function checkEntry(name, value, entry, opts) {
  if (!isPlainObject(entry)) {
    return [{ constant: name, rule: 'unknown-kind', detail: `evidence entry must be an object, got ${JSON.stringify(entry)}` }];
  }
  if (entry.kind === 'measured') return checkMeasured(name, value, entry, opts.minMargin);
  if (entry.kind === 'mirror') return checkMirror(name, value, entry, opts.resolveMirror);
  if (EXEMPT_KINDS.has(entry.kind)) {
    return isNonEmptyString(entry.reason) ? [] : [{ constant: name, rule: 'missing-reason', detail: `${entry.kind} evidence must give a reason` }];
  }
  return [{ constant: name, rule: 'unknown-kind', detail: `unknown evidence kind ${JSON.stringify(entry.kind)}` }];
}

/**
 * @param {Record<string, unknown>} constants exports object; only finite-number values are constants
 * @param {Record<string, unknown>} evidence map from constant name to evidence entry
 * @param {{ minMargin?: number, resolveMirror?: (of: {module: string, export: string}) => unknown }} [opts]
 * @returns {{constant: string, rule: string, detail: string}[]}
 */
function validateTimeoutEvidence(constants, evidence, { minMargin = MIN_TIMEOUT_MARGIN, resolveMirror = defaultResolveMirror } = {}) {
  const violations = [];
  const names = Object.keys(constants).filter((k) => typeof constants[k] === 'number' && Number.isFinite(constants[k]));
  const nameSet = new Set(names);
  const ev = isPlainObject(evidence) ? evidence : {};

  for (const name of names) {
    if (!Object.hasOwn(ev, name)) {
      violations.push({ constant: name, rule: 'missing-evidence', detail: `${name} has no TIMEOUT_EVIDENCE entry` });
      continue;
    }
    violations.push(...checkEntry(name, constants[name], ev[name], { minMargin, resolveMirror }));
  }
  for (const name of Object.keys(ev)) {
    if (!nameSet.has(name)) violations.push({ constant: name, rule: 'orphan-evidence', detail: `${name} is not an exported numeric constant` });
  }

  return violations.sort((a, b) => (a.constant === b.constant ? a.rule.localeCompare(b.rule) : a.constant.localeCompare(b.constant)));
}

module.exports = { validateTimeoutEvidence, MIN_TIMEOUT_MARGIN };
