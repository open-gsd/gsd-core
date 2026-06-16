'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../scripts/issue-version-gate.cjs');

// ---------------------------------------------------------------------------
// Helpers — realistic issue body templates
// ---------------------------------------------------------------------------

/**
 * Build a template-shaped bug body with the given version value (or none).
 */
function bugBody(versionValue) {
  const versionSection =
    versionValue === undefined
      ? '' // no section at all
      : `### GSD Version\n\n${versionValue}\n\n`;
  return (
    versionSection +
    '### What happened?\n\nSomething broke.\n\n' +
    '### Steps to reproduce\n\n1. Run gsd\n2. Observe error\n\n' +
    '### Expected behavior\n\nIt should work.'
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('issue-version-gate constants', () => {
  test('BUG_LABEL is "bug"', () => {
    assert.equal(BUG_LABEL, 'bug');
  });

  test('NEEDS_VERSION_LABEL is "needs-version"', () => {
    assert.equal(NEEDS_VERSION_LABEL, 'needs-version');
  });

  test('VERSION_GATE_MARKER is an HTML comment string', () => {
    assert.ok(typeof VERSION_GATE_MARKER === 'string');
    assert.ok(VERSION_GATE_MARKER.startsWith('<!--'));
    assert.ok(VERSION_GATE_MARKER.endsWith('-->'));
  });

  test('EXEMPT_LABELS includes version-exempt', () => {
    assert.ok(Array.isArray(EXEMPT_LABELS));
    assert.ok(EXEMPT_LABELS.includes('version-exempt'));
  });
});

// ---------------------------------------------------------------------------
// normalizeLabels
// ---------------------------------------------------------------------------

describe('normalizeLabels', () => {
  test('returns [] for non-array', () => {
    assert.deepEqual(normalizeLabels(null), []);
    assert.deepEqual(normalizeLabels(undefined), []);
    assert.deepEqual(normalizeLabels('bug'), []);
  });

  test('handles string labels', () => {
    assert.deepEqual(normalizeLabels(['Bug', 'Enhancement']), ['bug', 'enhancement']);
  });

  test('handles object labels with .name', () => {
    assert.deepEqual(normalizeLabels([{ name: 'Bug' }, { name: 'triage' }]), ['bug', 'triage']);
  });

  test('handles mixed string and object labels', () => {
    assert.deepEqual(normalizeLabels(['bug', { name: 'version-exempt' }]), ['bug', 'version-exempt']);
  });

  test('filters falsy entries', () => {
    assert.deepEqual(normalizeLabels([null, undefined, 'bug', '']), ['bug']);
  });
});

// ---------------------------------------------------------------------------
// hasExemptLabel
// ---------------------------------------------------------------------------

describe('hasExemptLabel', () => {
  test('true when labels include "version-exempt" as string', () => {
    assert.equal(hasExemptLabel(['bug', 'version-exempt']), true);
  });

  test('true when labels include "version-exempt" as object', () => {
    assert.equal(hasExemptLabel([{ name: 'bug' }, { name: 'version-exempt' }]), true);
  });

  test('true case-insensitive', () => {
    assert.equal(hasExemptLabel(['Version-Exempt']), true);
  });

  test('false when exempt label absent', () => {
    assert.equal(hasExemptLabel(['bug', 'needs-triage']), false);
  });

  test('false for empty labels', () => {
    assert.equal(hasExemptLabel([]), false);
  });
});

// ---------------------------------------------------------------------------
// hasVersionHeading
// ---------------------------------------------------------------------------

describe('hasVersionHeading', () => {
  test('true for "### GSD Version" heading', () => {
    assert.equal(hasVersionHeading(bugBody('1.18.0')), true);
  });

  test('false for "### Version" (without GSD prefix — bare Version no longer matches)', () => {
    assert.equal(hasVersionHeading('### Version\n\n1.0.0'), false);
  });

  test('true for h1 "# GSD Version"', () => {
    assert.equal(hasVersionHeading('# GSD Version\n\n1.0.0'), true);
  });

  test('false for body with no version heading', () => {
    assert.equal(
      hasVersionHeading('### What happened?\n\nSomething broke.\n\n### Steps to reproduce\n\n1. Run gsd'),
      false,
    );
  });

  test('false for null/undefined body', () => {
    assert.equal(hasVersionHeading(null), false);
    assert.equal(hasVersionHeading(undefined), false);
  });

  test('false for empty body', () => {
    assert.equal(hasVersionHeading(''), false);
  });
});

// ---------------------------------------------------------------------------
// extractVersion
// ---------------------------------------------------------------------------

describe('extractVersion', () => {
  test('returns the version value when section present with "1.18.0"', () => {
    const body = bugBody('1.18.0');
    assert.equal(extractVersion(body), '1.18.0');
  });

  test('returns null when section is absent', () => {
    // bugBody with no arg produces no ### GSD Version section
    const body = bugBody(undefined);
    assert.equal(extractVersion(body), null);
  });

  test('returns "" when section present but value is blank line', () => {
    const body = '### GSD Version\n\n\n### What happened?\n\nSomething broke.';
    assert.equal(extractVersion(body), '');
  });

  test('returns "_No response_" raw string for GitHub placeholder (isValidVersion will reject it)', () => {
    const body = '### GSD Version\n\n_No response_\n\n### What happened?';
    assert.equal(extractVersion(body), '_No response_');
  });

  test('trims surrounding blank lines from extracted value', () => {
    const body = '### GSD Version\n\n\n  1.18.0  \n\n### What happened?';
    assert.equal(extractVersion(body), '1.18.0');
  });

  test('stops at the next section heading', () => {
    const body = '### GSD Version\n\n1.4.1\n\n### What happened?\n\n1.18.0';
    assert.equal(extractVersion(body), '1.4.1');
  });

  test('returns null for null body', () => {
    assert.equal(extractVersion(null), null);
  });

  test('returns null for empty body', () => {
    assert.equal(extractVersion(''), null);
  });

  test('handles CRLF line endings', () => {
    const body = '### GSD Version\r\n\r\n1.18.0\r\n\r\n### What happened?';
    assert.equal(extractVersion(body), '1.18.0');
  });
});

// ---------------------------------------------------------------------------
// isValidVersion
// ---------------------------------------------------------------------------

describe('isValidVersion', () => {
  test('true for "1.18.0"', () => {
    assert.equal(isValidVersion('1.18.0'), true);
  });

  test('true for "v1.4.1"', () => {
    assert.equal(isValidVersion('v1.4.1'), true);
  });

  test('true for "1.18.0-dev"', () => {
    assert.equal(isValidVersion('1.18.0-dev'), true);
  });

  test('true for "1.4" (two-part semver)', () => {
    assert.equal(isValidVersion('1.4'), true);
  });

  test('true for a 7-char git SHA "a19a709"', () => {
    assert.equal(isValidVersion('a19a709'), true);
  });

  test('true for an 8-char git SHA "a19a709e"', () => {
    assert.equal(isValidVersion('a19a709e'), true);
  });

  test('true for a 40-char full git SHA', () => {
    assert.equal(isValidVersion('a19a709e' + '0'.repeat(32)), true);
  });

  test('true for version with build metadata "1.18.0+build.1"', () => {
    assert.equal(isValidVersion('1.18.0+build.1'), true);
  });

  test('false for null', () => {
    assert.equal(isValidVersion(null), false);
  });

  test('false for empty string', () => {
    assert.equal(isValidVersion(''), false);
  });

  test('false for whitespace-only', () => {
    assert.equal(isValidVersion('   '), false);
  });

  test('false for "_No response_"', () => {
    assert.equal(isValidVersion('_No response_'), false);
  });

  test('false for "_no response_" (lowercase)', () => {
    assert.equal(isValidVersion('_no response_'), false);
  });

  test('false for "idk"', () => {
    assert.equal(isValidVersion('idk'), false);
  });

  test('false for "latest"', () => {
    assert.equal(isValidVersion('latest'), false);
  });

  test('false for "main"', () => {
    assert.equal(isValidVersion('main'), false);
  });

  test('false for "unknown"', () => {
    assert.equal(isValidVersion('unknown'), false);
  });

  test('false for "v2" (no dot — not semver-shaped)', () => {
    assert.equal(isValidVersion('v2'), false);
  });
});

// ---------------------------------------------------------------------------
// isBugReport
// ---------------------------------------------------------------------------

describe('isBugReport', () => {
  test('true when labels include "bug" as string', () => {
    assert.equal(isBugReport({ labels: ['bug'], body: '' }), true);
  });

  test('true when labels include "bug" as object', () => {
    assert.equal(isBugReport({ labels: [{ name: 'bug' }], body: '' }), true);
  });

  test('true when labels include "Bug" (case-insensitive)', () => {
    assert.equal(isBugReport({ labels: ['Bug'], body: '' }), true);
  });

  test('true when no bug label but body has "### GSD Version" heading', () => {
    // API-filed bug: copied template body but omitted labels
    const body = bugBody('1.18.0');
    assert.equal(isBugReport({ labels: [], body }), true);
  });

  test('false when no bug label and body has bare "### Version" heading (no GSD prefix — not matched)', () => {
    assert.equal(isBugReport({ labels: [], body: '### Version\n\n1.0.0\n\n### Steps' }), false);
  });

  test('false for feature request: no bug label, no version heading', () => {
    const body =
      '### Feature Description\n\nI would like X.\n\n' +
      '### Motivation\n\nBecause of Y.';
    assert.equal(isBugReport({ labels: ['enhancement'], body }), false);
  });

  test('false when called with no arguments', () => {
    assert.equal(isBugReport(), false);
  });

  test('false for non-bug labels and no version heading', () => {
    assert.equal(isBugReport({ labels: ['enhancement', 'needs-triage'], body: '' }), false);
  });
});

// ---------------------------------------------------------------------------
// evaluateVersionGate
// ---------------------------------------------------------------------------

describe('evaluateVersionGate', () => {
  test('bug label + valid version → skip / valid-version', () => {
    const result = evaluateVersionGate({ labels: ['bug'], body: bugBody('1.18.0') });
    assert.deepEqual(result, { action: 'skip', reason: 'valid-version' });
  });

  test('bug label + no version section → close / missing-version', () => {
    // bug label present but body has no ### GSD Version section
    const result = evaluateVersionGate({
      labels: ['bug'],
      body: '### What happened?\n\nSomething broke.',
    });
    assert.deepEqual(result, { action: 'close', reason: 'missing-version' });
  });

  test('bug label + ### GSD Version section present but blank → close / invalid-version', () => {
    const result = evaluateVersionGate({
      labels: ['bug'],
      body: '### GSD Version\n\n\n### What happened?\n\nSomething broke.',
    });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });

  test('bug label + version value "idk" → close / invalid-version', () => {
    const result = evaluateVersionGate({ labels: ['bug'], body: bugBody('idk') });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });

  test('bug label + "_No response_" → close / invalid-version', () => {
    const result = evaluateVersionGate({ labels: ['bug'], body: bugBody('_No response_') });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });

  test('bug label + version-exempt label → skip / exempt-label', () => {
    const result = evaluateVersionGate({
      labels: ['bug', 'version-exempt'],
      body: bugBody(undefined),
    });
    assert.deepEqual(result, { action: 'skip', reason: 'exempt-label' });
  });

  test('feature request (no bug label, no version heading) → skip / not-a-bug', () => {
    const result = evaluateVersionGate({
      labels: ['enhancement'],
      body: '### Feature Description\n\nI want X.\n\n### Motivation\n\nY.',
    });
    assert.deepEqual(result, { action: 'skip', reason: 'not-a-bug' });
  });

  test('no labels, no body → skip / not-a-bug', () => {
    const result = evaluateVersionGate({ labels: [], body: '' });
    assert.deepEqual(result, { action: 'skip', reason: 'not-a-bug' });
  });

  test('no arguments → skip / not-a-bug', () => {
    const result = evaluateVersionGate();
    assert.deepEqual(result, { action: 'skip', reason: 'not-a-bug' });
  });

  test('API-filed bug: version heading in body, no bug label, valid version → skip / valid-version', () => {
    // Bug filed via REST with template body but no labels
    const result = evaluateVersionGate({ labels: [], body: bugBody('1.4.1') });
    assert.deepEqual(result, { action: 'skip', reason: 'valid-version' });
  });

  test('no bug label and no version heading (body omits GSD Version section entirely) → skip / not-a-bug', () => {
    // bugBody(undefined) produces NO ### GSD Version section, so isBugReport
    // returns false via both label and heading paths → not a bug report at all.
    const result = evaluateVersionGate({ labels: [], body: bugBody(undefined) });
    assert.deepEqual(result, { action: 'skip', reason: 'not-a-bug' });
  });

  test('no bug label but body has GSD Version heading with invalid value "idk" → isBugReport true via heading fallback → close / invalid-version', () => {
    // API-filed bug: body includes ### GSD Version heading (isBugReport = true)
    // but the value is a junk string that fails isValidVersion.
    const result = evaluateVersionGate({ labels: [], body: bugBody('idk') });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });

  test('API-filed bug: version heading present but empty, no bug label → close / invalid-version', () => {
    // Body has the ### GSD Version heading but the value is empty (heading present → invalid, not missing)
    const body = '### GSD Version\n\n\n### What happened?\n\nSomething broke.';
    const result = evaluateVersionGate({ labels: [], body });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });

  test('git SHA as version is accepted → skip / valid-version', () => {
    const result = evaluateVersionGate({ labels: ['bug'], body: bugBody('a19a709') });
    assert.deepEqual(result, { action: 'skip', reason: 'valid-version' });
  });

  test('CRLF body with GSD Version 1.18.0 → skip / valid-version', () => {
    const body =
      '### GSD Version\r\n\r\n1.18.0\r\n\r\n### What happened?\r\n\r\nBoom.';
    const result = evaluateVersionGate({ labels: ['bug'], body });
    assert.deepEqual(result, { action: 'skip', reason: 'valid-version' });
  });

  test('GSD Version is the last section with value on final line (no trailing newline) → skip / valid-version', () => {
    const body = '### What happened?\n\nBoom.\n\n### GSD Version\n\n1.18.0';
    const result = evaluateVersionGate({ labels: ['bug'], body });
    assert.deepEqual(result, { action: 'skip', reason: 'valid-version' });
  });
});

// ---------------------------------------------------------------------------
// Additional isBugReport tests
// ---------------------------------------------------------------------------

describe('isBugReport — bare Version heading (no GSD prefix)', () => {
  test('bare "### Version" heading, no bug label → false (not treated as bug)', () => {
    assert.equal(isBugReport({ labels: [], body: '### Version\n\n1.0.0\n\n### Steps' }), false);
  });
});

// ---------------------------------------------------------------------------
// Additional isBugReport tests — labels-authoritative behavior
// ---------------------------------------------------------------------------

describe('isBugReport — labels are authoritative', () => {
  test('labels ["enhancement"] + body with "### GSD Version" heading → false (labels win)', () => {
    const body = '### GSD Version\n\n_No response_\n\n### What happened?\n\nSomething broke.';
    assert.equal(isBugReport({ labels: ['enhancement'], body }), false);
  });

  test('labels ["enhancement","needs-review"] + body with "### GSD Version" heading → false', () => {
    const body = '### GSD Version\n\n_No response_\n\n### What happened?\n\nSomething broke.';
    assert.equal(isBugReport({ labels: ['enhancement', 'needs-review'], body }), false);
  });

  test('labels [] (unlabeled) + body with "### GSD Version" heading → true (heading fallback)', () => {
    const body = '### GSD Version\n\n1.18.0\n\n### What happened?\n\nSomething broke.';
    assert.equal(isBugReport({ labels: [], body }), true);
  });

  test('labels ["bug"] + body with "### GSD Version" heading → true (bug label fast-path)', () => {
    const body = '### GSD Version\n\n1.18.0\n\n### What happened?\n\nSomething broke.';
    assert.equal(isBugReport({ labels: ['bug'], body }), true);
  });
});

// ---------------------------------------------------------------------------
// Additional isValidVersion tests
// ---------------------------------------------------------------------------

describe('isValidVersion — git SHA acceptance', () => {
  test('8-char hex git SHA "deadbeef" → true', () => {
    assert.equal(isValidVersion('deadbeef'), true);
  });

  test('7-char short SHA "a19a709" → true', () => {
    assert.equal(isValidVersion('a19a709'), true);
  });
});

// ---------------------------------------------------------------------------
// renderCloseComment
// ---------------------------------------------------------------------------

describe('renderCloseComment', () => {
  test('contains the VERSION_GATE_MARKER', () => {
    const comment = renderCloseComment();
    assert.ok(comment.includes(VERSION_GATE_MARKER), `expected marker in comment: ${comment}`);
  });

  test('contains the words "GSD Version"', () => {
    const comment = renderCloseComment();
    assert.ok(comment.includes('GSD Version'), `expected "GSD Version" in comment: ${comment}`);
  });

  test('contains reopen instructions', () => {
    const comment = renderCloseComment();
    assert.ok(comment.includes('reopen'), `expected reopen instructions: ${comment}`);
  });

  test('contains the version-exempt escape hatch', () => {
    const comment = renderCloseComment();
    assert.ok(comment.includes('version-exempt'), `expected version-exempt label mention: ${comment}`);
  });

  test('returns a non-empty string', () => {
    const comment = renderCloseComment();
    assert.ok(typeof comment === 'string' && comment.length > 0);
  });
});

// ---------------------------------------------------------------------------
// evaluateVersionGate — labels-authoritative new coverage
// ---------------------------------------------------------------------------

describe('evaluateVersionGate — labels authoritative', () => {
  test('labels ["enhancement"] + body with "### GSD Version" heading → skip / not-a-bug', () => {
    const body = '### GSD Version\n\nidk\n\n### What happened?\n\nSomething broke.';
    const result = evaluateVersionGate({ labels: ['enhancement'], body });
    assert.deepEqual(result, { action: 'skip', reason: 'not-a-bug' });
  });
});

// ---------------------------------------------------------------------------
// extractVersion — double-heading documents first-heading-wins behavior
// ---------------------------------------------------------------------------

describe('extractVersion — double heading', () => {
  test('two "### GSD Version" headings: first section "_No response_", second "1.18.0" → returns "_No response_" (first wins)', () => {
    const body =
      '### GSD Version\n\n_No response_\n\n### GSD Version\n\n1.18.0\n\n### What happened?\n\nBoom.';
    assert.equal(extractVersion(body), '_No response_');
  });
});

describe('evaluateVersionGate — double heading', () => {
  test('labels ["bug"] + double-heading body (first "_No response_") → close / invalid-version (first heading wins)', () => {
    const body =
      '### GSD Version\n\n_No response_\n\n### GSD Version\n\n1.18.0\n\n### What happened?\n\nBoom.';
    const result = evaluateVersionGate({ labels: ['bug'], body });
    assert.deepEqual(result, { action: 'close', reason: 'invalid-version' });
  });
});
