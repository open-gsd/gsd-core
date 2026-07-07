/**
 * Tests for src/phase-id.cts (compiled to gsd-core/bin/lib/phase-id.cjs).
 *
 * Verifies behavioural contracts of the extracted pure phase-id helpers:
 *   - escapeRegex
 *   - normalizePhaseName
 *   - comparePhaseNum
 *   - extractPhaseToken
 *   - phaseTokenMatches
 *   - phaseMarkdownRegexSource
 *   - phaseMarkdownRegexSourceExact
 *   - getMilestoneFromPhaseId
 *   - getPhaseDirFromPhaseId
 *   - core.cjs re-export shims resolve to the exact same functions (single instance)
 *
 * ADR-857 rollout phase 2a / issue #865.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');

// ─── escapeRegex ─────────────────────────────────────────────────────────────

describe('escapeRegex', () => {
  test('escapes all regex special characters', () => {
    assert.strictEqual(phaseId.escapeRegex('.'), '\\.');
    assert.strictEqual(phaseId.escapeRegex('*'), '\\*');
    assert.strictEqual(phaseId.escapeRegex('+'), '\\+');
    assert.strictEqual(phaseId.escapeRegex('?'), '\\?');
    assert.strictEqual(phaseId.escapeRegex('^'), '\\^');
    assert.strictEqual(phaseId.escapeRegex('$'), '\\$');
    assert.strictEqual(phaseId.escapeRegex('{'), '\\{');
    assert.strictEqual(phaseId.escapeRegex('}'), '\\}');
    assert.strictEqual(phaseId.escapeRegex('('), '\\(');
    assert.strictEqual(phaseId.escapeRegex(')'), '\\)');
    assert.strictEqual(phaseId.escapeRegex('|'), '\\|');
    assert.strictEqual(phaseId.escapeRegex('['), '\\[');
    assert.strictEqual(phaseId.escapeRegex(']'), '\\]');
    assert.strictEqual(phaseId.escapeRegex('\\'), '\\\\');
  });

  test('leaves alphanumeric and hyphen characters unescaped', () => {
    assert.strictEqual(phaseId.escapeRegex('abc'), 'abc');
    assert.strictEqual(phaseId.escapeRegex('01-02'), '01-02');
    assert.strictEqual(phaseId.escapeRegex('v1.0'), 'v1\\.0');
  });

  test('coerces non-string values via String()', () => {
    assert.strictEqual(phaseId.escapeRegex(42), '42');
    assert.strictEqual(phaseId.escapeRegex(null), 'null');
    assert.strictEqual(phaseId.escapeRegex(undefined), 'undefined');
  });

  test('adversarial: path-traversal-like inputs are treated as literals', () => {
    const result = phaseId.escapeRegex('../../../etc/passwd');
    // The dots get escaped; slashes and alphanumeric pass through unchanged
    assert.strictEqual(result, '\\.\\./\\.\\./\\.\\./etc/passwd');
    // The result forms a valid regex (no throws)
    assert.doesNotThrow(() => new RegExp(result));
  });

  test('unicode passthrough', () => {
    assert.strictEqual(phaseId.escapeRegex('Phase Name'), 'Phase Name');
    assert.strictEqual(phaseId.escapeRegex('中文'), '中文');
  });
});

// ─── normalizePhaseName ───────────────────────────────────────────────────────

describe('normalizePhaseName', () => {
  test('zero-pads single-digit phase', () => {
    assert.strictEqual(phaseId.normalizePhaseName('1'), '01');
    assert.strictEqual(phaseId.normalizePhaseName('3'), '03');
  });

  test('leaves two-digit phase unchanged', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12'), '12');
  });

  test('strips project_code prefix before normalizing', () => {
    assert.strictEqual(phaseId.normalizePhaseName('CK-01'), '01');
    assert.strictEqual(phaseId.normalizePhaseName('PROJ-3'), '03');
    assert.strictEqual(phaseId.normalizePhaseName('AB-12'), '12');
    assert.strictEqual(phaseId.normalizePhaseName('MANIFOLD-7'), '07');
    assert.strictEqual(phaseId.normalizePhaseName('APP1-7'), '07');
    assert.strictEqual(phaseId.normalizePhaseName('APP_1-7'), '07');
  });

  test('does not strip leading-underscore pseudo-prefix (#1455)', () => {
    // Valid project_code values must start with [A-Z]; leading underscores
    // (_FOO-7, _-7) are not valid codes and must not be stripped.
    assert.strictEqual(phaseId.normalizePhaseName('_FOO-7'), '_FOO-7');
    assert.strictEqual(phaseId.normalizePhaseName('_-7'), '_-7');
  });

  test('handles letter suffix (preserves original case per #1962)', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12A'), '12A');
    assert.strictEqual(phaseId.normalizePhaseName('3b'), '03b');
  });

  test('handles decimal phase IDs', () => {
    assert.strictEqual(phaseId.normalizePhaseName('12.1'), '12.1');
    assert.strictEqual(phaseId.normalizePhaseName('3.10'), '03.10');
  });

  test('handles milestone-prefixed IDs (M-NN form)', () => {
    assert.strictEqual(phaseId.normalizePhaseName('1-1'), '01-01');
    assert.strictEqual(phaseId.normalizePhaseName('2-3'), '02-03');
    assert.strictEqual(phaseId.normalizePhaseName('1-2-3'), '01-02-03');
  });

  test('custom phase IDs: project_code prefix is stripped, then numeric part is normalized', () => {
    // The project-code prefix is stripped, leaving a numeric token that normalizes to '42' (no leading zero needed for 2+ digits).
    assert.strictEqual(phaseId.normalizePhaseName('PROJ-42'), '42');
    assert.strictEqual(phaseId.normalizePhaseName('AUTH-101'), '101');
    assert.strictEqual(phaseId.normalizePhaseName('MANIFOLD-117'), '117');
  });

  test('custom phase IDs with non-numeric remainder pass through as-is', () => {
    // No project_code pattern, no numeric match → return str as-is
    assert.strictEqual(phaseId.normalizePhaseName('my-phase'), 'my-phase');
  });

  test('coerces non-string values', () => {
    assert.strictEqual(phaseId.normalizePhaseName(5), '05');
  });
});

// ─── comparePhaseNum ──────────────────────────────────────────────────────────

describe('comparePhaseNum', () => {
  test('sorts numeric phases in ascending order', () => {
    const phases = ['03', '01', '10', '02'];
    const sorted = [...phases].sort(phaseId.comparePhaseNum);
    assert.deepStrictEqual(sorted, ['01', '02', '03', '10']);
  });

  test('compares single-digit vs two-digit correctly', () => {
    assert.ok(phaseId.comparePhaseNum('1', '02') < 0);
    assert.ok(phaseId.comparePhaseNum('02', '1') > 0);
    assert.strictEqual(phaseId.comparePhaseNum('1', '01'), 0);
  });

  test('handles decimal phases', () => {
    assert.ok(phaseId.comparePhaseNum('1', '1.1') < 0);
    assert.ok(phaseId.comparePhaseNum('1.1', '1.2') < 0);
    assert.ok(phaseId.comparePhaseNum('1.10', '1.9') > 0);
    assert.strictEqual(phaseId.comparePhaseNum('1.1', '01.1'), 0);
  });

  test('handles letter suffix ordering (no letter < A < B)', () => {
    assert.ok(phaseId.comparePhaseNum('01', '01A') < 0);
    assert.ok(phaseId.comparePhaseNum('01A', '01B') < 0);
    assert.ok(phaseId.comparePhaseNum('01B', '01') > 0);
  });

  test('handles milestone-prefixed IDs', () => {
    assert.ok(phaseId.comparePhaseNum('1-1', '1-2') < 0);
    assert.ok(phaseId.comparePhaseNum('2-1', '1-10') > 0);
    assert.ok(phaseId.comparePhaseNum('1-2-3', '1-2-4') < 0);
    assert.strictEqual(phaseId.comparePhaseNum('01-01', '1-1'), 0);
  });

  test('strips project_code prefix before comparing', () => {
    assert.strictEqual(phaseId.comparePhaseNum('CK-01', '01'), 0);
    assert.ok(phaseId.comparePhaseNum('CK-01', 'CK-02') < 0);
    assert.strictEqual(phaseId.comparePhaseNum('MANIFOLD-117', '117'), 0);
    assert.strictEqual(phaseId.comparePhaseNum('APP1-117', '117'), 0);
    assert.strictEqual(phaseId.comparePhaseNum('APP_1-117', '117'), 0);
  });

  test('handles non-parseable phase IDs via localeCompare fallback', () => {
    // Should not throw on non-numeric IDs
    const result = phaseId.comparePhaseNum('alpha', 'beta');
    assert.strictEqual(typeof result, 'number');
  });
});

// ─── extractPhaseToken ────────────────────────────────────────────────────────

describe('extractPhaseToken', () => {
  test('extracts simple numeric token from directory name', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-some-phase-name'), '01');
    assert.strictEqual(phaseId.extractPhaseToken('12A-feature'), '12A');
  });

  test('extracts milestone-prefixed numeric token', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-02-some-name'), '01-02');
    assert.strictEqual(phaseId.extractPhaseToken('02-03-04-deep'), '02-03-04');
  });

  test('extracts token with project_code prefix', () => {
    assert.strictEqual(phaseId.extractPhaseToken('CK-01-some-phase'), 'CK-01');
    assert.strictEqual(phaseId.extractPhaseToken('PROJ-12-feature'), 'PROJ-12');
    assert.strictEqual(phaseId.extractPhaseToken('MANIFOLD-117-feature'), 'MANIFOLD-117');
    assert.strictEqual(phaseId.extractPhaseToken('APP1-117-feature'), 'APP1-117');
    assert.strictEqual(phaseId.extractPhaseToken('APP_1-117-feature'), 'APP_1-117');
  });

  test('extracts glued letter-prefix phase tokens (#1324)', () => {
    assert.strictEqual(phaseId.extractPhaseToken('P0.3-tenant-primitives'), 'P0.3');
    assert.strictEqual(phaseId.extractPhaseToken('P0.0-foundation'), 'P0.0');
    assert.strictEqual(phaseId.extractPhaseToken('P0.16-gate'), 'P0.16');
    assert.strictEqual(phaseId.extractPhaseToken('M1-2-brain'), 'M1-2');
  });

  test('returns the full dirName when no numeric token found', () => {
    assert.strictEqual(phaseId.extractPhaseToken('no-numeric'), 'no-numeric');
    assert.strictEqual(phaseId.extractPhaseToken('alpha'), 'alpha');
    assert.strictEqual(phaseId.extractPhaseToken('phase-name-01'), 'phase-name-01');
  });

  test('stops at first non-numeric-starting segment', () => {
    assert.strictEqual(phaseId.extractPhaseToken('01-02-name-03'), '01-02');
  });

  test('rejects a single-digit slug word after a phase number (#2043)', () => {
    // A phase dir like "46-6-rs-pipeline-orchestrator" (roadmap phase name
    // "6 Rs Pipeline Orchestrator" → slug "6-rs-...") must yield token "46",
    // not "46-6" — the "6" is the slug's first word, not a sub-phase segment.
    assert.strictEqual(phaseId.extractPhaseToken('46-6-rs-pipeline-orchestrator'), '46');
    assert.strictEqual(phaseId.extractPhaseToken('68-6-rs'), '68');
    // Legit cases are unaffected: a real zero-padded milestone-sub-phase pair
    // stays intact, and a single-digit sub-phase after a letter-prefixed
    // milestone id (e.g. "M1-2") is still valid.
    assert.strictEqual(phaseId.extractPhaseToken('01-02-some-name'), '01-02');
    assert.strictEqual(phaseId.extractPhaseToken('M1-2-brain'), 'M1-2');
    // Milestone-prefixed convention: "M1-" strips as a project-code prefix, so
    // the same rule fixes the slug-collision there too — a phase 46 named
    // "6 Rs …" under milestone M1 yields "M1-46", not "M1-46-6". Phase 6 under
    // M1 ("M1-6-rs") correctly stays "M1-6" (the 6 is the phase number).
    assert.strictEqual(phaseId.extractPhaseToken('M1-46-6-rs-pipeline-orchestrator'), 'M1-46');
    assert.strictEqual(phaseId.extractPhaseToken('M1-6-rs-pipeline'), 'M1-6');
    // Single-digit + letter-suffix phase id ("1A") is a real token, not a slug word.
    assert.strictEqual(phaseId.extractPhaseToken('1A-brain'), '1A');
  });
});

// ─── phaseTokenMatches ────────────────────────────────────────────────────────

describe('phaseTokenMatches', () => {
  test('matches exact token (case-insensitive)', () => {
    assert.ok(phaseId.phaseTokenMatches('01-some-phase', '01'));
    assert.ok(phaseId.phaseTokenMatches('12A-feature', '12A'));
    assert.ok(phaseId.phaseTokenMatches('12A-feature', '12a'));
  });

  test('matches with project_code prefix stripped', () => {
    assert.ok(phaseId.phaseTokenMatches('CK-01-phase', '01'));
    assert.ok(phaseId.phaseTokenMatches('PROJ-12-feature', '12'));
    assert.ok(phaseId.phaseTokenMatches('MANIFOLD-117-feature', '117'));
    assert.ok(phaseId.phaseTokenMatches('APP1-117-feature', '117'));
    assert.ok(phaseId.phaseTokenMatches('APP_1-117-feature', '117'));
  });

  test('matches glued letter-prefix phase dirs (#1324)', () => {
    assert.ok(phaseId.phaseTokenMatches('P0.3-tenant-primitives', 'P0.3'));
    assert.ok(phaseId.phaseTokenMatches('M1-2-brain', 'M1-2'));
    assert.ok(!phaseId.phaseTokenMatches('P0.3-tenant-primitives', 'P0.4'));
  });

  test('does not match when token differs', () => {
    assert.ok(!phaseId.phaseTokenMatches('01-some-phase', '02'));
    assert.ok(!phaseId.phaseTokenMatches('12A-feature', '12B'));
  });

  test('matches milestone-prefixed token', () => {
    assert.ok(phaseId.phaseTokenMatches('01-02-feature', '01-02'));
    assert.ok(!phaseId.phaseTokenMatches('01-02-feature', '01-03'));
  });
});

// ─── phaseMarkdownRegexSource ─────────────────────────────────────────────────

describe('phaseMarkdownRegexSource', () => {
  test('produces a regex source that matches zero-padded variants', () => {
    const src = phaseId.phaseMarkdownRegexSource('1');
    const re = new RegExp(src);
    assert.ok(re.test('1'));
    assert.ok(re.test('01'));
    assert.ok(re.test('001'));
  });

  test('produces source matching a two-digit phase', () => {
    const src = phaseId.phaseMarkdownRegexSource('12');
    const re = new RegExp(src);
    assert.ok(re.test('12'));
    assert.ok(re.test('012'));
    assert.ok(!re.test('13'));
  });

  test('handles letter suffix', () => {
    const src = phaseId.phaseMarkdownRegexSource('12A');
    const re = new RegExp(src, 'i');
    assert.ok(re.test('12A'));
    assert.ok(re.test('012A'));
  });

  test('handles decimal phases', () => {
    const src = phaseId.phaseMarkdownRegexSource('3.1');
    const re = new RegExp(src);
    assert.ok(re.test('3.1'));
    assert.ok(re.test('03.1'));
    assert.ok(!re.test('3.2'));
  });

  test('handles milestone-prefixed phase IDs', () => {
    const src = phaseId.phaseMarkdownRegexSource('1-2');
    const re = new RegExp(src);
    assert.ok(re.test('1-2'));
    assert.ok(re.test('01-02'));
    assert.ok(re.test('01-2'));
    assert.ok(!re.test('1-3'));
  });

  test('strips project_code prefix before building regex', () => {
    const withPrefix = phaseId.phaseMarkdownRegexSource('CK-01');
    const withoutPrefix = phaseId.phaseMarkdownRegexSource('01');
    assert.strictEqual(withPrefix, withoutPrefix);
    assert.strictEqual(phaseId.phaseMarkdownRegexSource('MANIFOLD-117'), phaseId.phaseMarkdownRegexSource('117'));
  });

  test('falls back to escaped literal for unparseable input', () => {
    const src = phaseId.phaseMarkdownRegexSource('v1.0');
    assert.strictEqual(typeof src, 'string');
    assert.ok(src.length > 0);
  });

  test('adversarial: phase num containing regex metacharacters is escaped', () => {
    // e.g. some exotic value that shouldn't break regexp construction
    const src = phaseId.phaseMarkdownRegexSource('3.1');
    // The literal dot in "3.1" should be escaped so it only matches a real dot
    const re = new RegExp(src);
    assert.ok(!re.test('3X1'), 'unescaped dot would match any char — must be escaped');
  });
});

// ─── phaseMarkdownRegexSourceExact ────────────────────────────────────────────

describe('phaseMarkdownRegexSourceExact', () => {
  test('returns escaped form for project-code-prefixed IDs', () => {
    const result = phaseId.phaseMarkdownRegexSourceExact('PROJ-42');
    // hyphen is not a regex special char so it passes through unescaped
    assert.strictEqual(result, 'PROJ-42');
    // The result is a valid regex source
    assert.doesNotThrow(() => new RegExp(result));
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('MANIFOLD-117'), 'MANIFOLD-117');
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('APP1-117'), 'APP1-117');
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('APP_1-117'), 'APP_1-117');
  });

  test('returns null for non-prefixed IDs', () => {
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('01'), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('12A'), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact('1-2'), null);
  });

  test('null coercion: returns null for null/undefined', () => {
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact(null), null);
    assert.strictEqual(phaseId.phaseMarkdownRegexSourceExact(undefined), null);
  });

  test('resulting regex matches the exact prefixed ID', () => {
    const src = phaseId.phaseMarkdownRegexSourceExact('AUTH-101');
    assert.ok(src !== null);
    const re = new RegExp(src);
    assert.ok(re.test('AUTH-101'));
    assert.ok(!re.test('AUTH-102'));
  });
});

// ─── getMilestoneFromPhaseId ──────────────────────────────────────────────────

describe('getMilestoneFromPhaseId', () => {
  test('returns vN.0 for a milestone-prefixed phase id', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('1-01'), 'v1.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('02-03'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('10-5'), 'v10.0');
  });

  test('returns null for non-milestone-prefixed IDs', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('01'), null);
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('12A'), null);
  });

  test('returns null for special sentinel milestones 0 and 999', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('0-1'), null);
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('999-1'), null);
  });

  test('strips project_code prefix before parsing', () => {
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('CK-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('MANIFOLD-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('APP1-2-01'), 'v2.0');
    assert.strictEqual(phaseId.getMilestoneFromPhaseId('APP_1-2-01'), 'v2.0');
  });

  test('coerces non-string values', () => {
    // numeric doesn't match the milestone pattern — returns null
    assert.strictEqual(phaseId.getMilestoneFromPhaseId(42), null);
  });
});

// ─── getPhaseDirFromPhaseId ───────────────────────────────────────────────────

describe('getPhaseDirFromPhaseId', () => {
  test('returns null for non-milestone-format IDs', () => {
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('01', null, null), null);
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('12A', null, null), null);
  });

  test('constructs dir name from milestone-prefixed phase id (no name, no code)', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', null, null);
    assert.strictEqual(result, '01-02');
  });

  test('includes phaseName slug', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', 'My Feature', null);
    assert.strictEqual(result, '01-02-my-feature');
  });

  test('prepends projectCode when provided', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-2', 'Auth', 'CK');
    assert.strictEqual(result, 'CK-01-02-auth');
  });

  test('strips project_code from phaseId before parsing', () => {
    const result = phaseId.getPhaseDirFromPhaseId('CK-1-2', null, null);
    assert.strictEqual(result, '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('MANIFOLD-1-2', null, null), '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('APP1-1-2', null, null), '01-02');
    assert.strictEqual(phaseId.getPhaseDirFromPhaseId('APP_1-1-2', null, null), '01-02');
  });

  test('handles deep decomposition IDs (M-N-N)', () => {
    // m[2] is "02-03" for input "1-2-3" — split and pad each sub-part
    const result = phaseId.getPhaseDirFromPhaseId('1-2-3', null, null);
    assert.strictEqual(result, '01-02-03');
  });

  test('slug strips leading/trailing hyphens from phaseName', () => {
    const result = phaseId.getPhaseDirFromPhaseId('1-1', '  --some--name--  ', null);
    // normalize: replace non-alnum runs with hyphen, strip edges
    assert.ok(result !== null);
    assert.ok(!result.startsWith('-'));
    assert.ok(!result.endsWith('-'));
  });
});
