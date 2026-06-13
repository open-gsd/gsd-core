#!/usr/bin/env node
'use strict';

const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');

/**
 * Version gate for bug-report issues.
 *
 * GitHub Issue Forms enforce `required: true` only in the web form; issues
 * filed via the REST API, `gh issue create`, or automated/AI reporters can
 * omit the GSD Version field entirely. This module provides the pure logic
 * for detecting bug reports missing a usable version so a workflow can
 * auto-close them. See .github/workflows/version-gate.yml.
 */

const BUG_LABEL = 'bug';
const NEEDS_VERSION_LABEL = 'needs-version';
const VERSION_GATE_MARKER = '<!-- gsd-version-gate -->';

// Labels that opt an issue out of the version gate.
const EXEMPT_LABELS = ['version-exempt'];

// Heading GitHub renders for the bug template's `label: GSD Version` field.
// Issue Forms render input labels as `### <label>`; matches the exact heading
// `### GSD Version` (any heading level) — bare `### Version` is NOT matched.
const VERSION_HEADING_RE = /^#{1,6}\s*GSD\s+Version\s*$/i;

// GitHub's placeholder for an empty optional form field.
const NO_RESPONSE_RE = /^_no response_$/i;

// A value "looks like a version" if it contains a semver-ish token
// (1.18, v1.4.1, 1.18.0-dev) or a git commit SHA (7-40 hex chars).
const SEMVER_TOKEN_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?\b/;
const SHA_TOKEN_RE = /\b[0-9a-f]{7,40}\b/i;

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean)
    .map((l) => String(l).toLowerCase());
}

function hasExemptLabel(labels) {
  const names = normalizeLabels(labels);
  return names.some((l) => EXEMPT_LABELS.includes(l));
}

function isBugReport({ labels, body } = {}) {
  const names = normalizeLabels(labels);
  if (names.includes(BUG_LABEL)) return true;
  // Labels are authoritative: if any label was applied and it isn't `bug`,
  // this is not a bug report (e.g. an `enhancement`-labeled issue that happens
  // to contain a version heading must not be gated). Only fall back to the
  // bug-template's `### GSD Version` heading for fully unlabeled submissions
  // (bare REST API / `gh issue create`).
  if (names.length > 0) return false;
  return hasVersionHeading(body);
}

function hasVersionHeading(body) {
  if (!body) return false;
  return String(body)
    .split(/\r?\n/)
    .some((line) => VERSION_HEADING_RE.test(line));
}

/**
 * Extract the value beneath the "GSD Version" heading. Returns null when the
 * section is absent, '' when the section is present but empty.
 */
function extractVersion(body) {
  if (!body) return null;
  const lines = String(body).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const collected = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break; // next section heading
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

function isValidVersion(value) {
  if (value == null) return false;
  const v = String(value).trim();
  if (!v) return false;
  if (NO_RESPONSE_RE.test(v)) return false;
  return SEMVER_TOKEN_RE.test(v) || SHA_TOKEN_RE.test(v);
}

/**
 * Decide what to do with an issue. Returns { action: 'skip'|'close', reason }.
 */
function evaluateVersionGate({ labels, body } = {}) {
  if (hasExemptLabel(labels)) return { action: 'skip', reason: 'exempt-label' };
  if (!isBugReport({ labels, body })) return { action: 'skip', reason: 'not-a-bug' };
  const version = extractVersion(body);
  if (isValidVersion(version)) return { action: 'skip', reason: 'valid-version' };
  const reason = version == null ? 'missing-version' : 'invalid-version';
  return { action: 'close', reason };
}

function renderCloseComment() {
  return [
    VERSION_GATE_MARKER,
    'Closing automatically — this bug report does not include a valid **GSD Version**.',
    '',
    'A version is required to reproduce and triage bugs. Grab it with one of:',
    '',
    '```',
    `npm list -g ${PACKAGE_NAME}`,
    `npx ${PACKAGE_NAME} --version`,
    '```',
    '',
    'Then **edit this issue to add the version (e.g. `1.18.0`) and reopen it**, or comment with the version and a maintainer will reopen it. If a version genuinely does not apply, a maintainer can add the `version-exempt` label.',
  ].join('\n');
}

module.exports = {
  BUG_LABEL,
  NEEDS_VERSION_LABEL,
  VERSION_GATE_MARKER,
  EXEMPT_LABELS,
  normalizeLabels,
  hasExemptLabel,
  isBugReport,
  hasVersionHeading,
  extractVersion,
  isValidVersion,
  evaluateVersionGate,
  renderCloseComment,
};
