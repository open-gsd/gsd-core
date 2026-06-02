'use strict';

/**
 * Characterization tests for the reviewer selection module.
 * Locks the normalizeConfiguredDefaultReviewers and resolveReviewerSelection
 * export shapes and key policy decisions.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_REVIEWER_SLUGS,
  normalizeConfiguredDefaultReviewers,
  resolveReviewerSelection,
} = require('../get-shit-done/bin/lib/review-reviewer-selection.cjs');

describe('KNOWN_REVIEWER_SLUGS', () => {
  test('is an array of strings', () => {
    assert.ok(Array.isArray(KNOWN_REVIEWER_SLUGS));
    assert.ok(KNOWN_REVIEWER_SLUGS.every((s) => typeof s === 'string'));
  });

  test('includes expected slugs', () => {
    assert.ok(KNOWN_REVIEWER_SLUGS.includes('gemini'));
    assert.ok(KNOWN_REVIEWER_SLUGS.includes('claude'));
    assert.ok(KNOWN_REVIEWER_SLUGS.includes('codex'));
  });
});

describe('normalizeConfiguredDefaultReviewers', () => {
  test('returns absent=true for undefined', () => {
    const r = normalizeConfiguredDefaultReviewers(undefined);
    assert.ok(r.absent);
    assert.deepStrictEqual(r.values, []);
    assert.deepStrictEqual(r.errors, []);
  });

  test('returns absent=true for null', () => {
    const r = normalizeConfiguredDefaultReviewers(null);
    assert.ok(r.absent);
  });

  test('returns error for non-array', () => {
    const r = normalizeConfiguredDefaultReviewers('gemini');
    assert.ok(!r.absent);
    assert.ok(r.errors.length > 0);
  });

  test('returns error for empty array', () => {
    const r = normalizeConfiguredDefaultReviewers([]);
    assert.ok(!r.absent);
    assert.ok(r.errors.length > 0);
  });

  test('normalizes slugs to lowercase', () => {
    const r = normalizeConfiguredDefaultReviewers(['Gemini', 'CLAUDE']);
    assert.ok(!r.absent);
    assert.ok(r.values.includes('gemini'));
    assert.ok(r.values.includes('claude'));
  });

  test('deduplicates slugs case-insensitively', () => {
    const r = normalizeConfiguredDefaultReviewers(['gemini', 'GEMINI']);
    assert.ok(!r.absent);
    assert.strictEqual(r.values.filter((s) => s === 'gemini').length, 1);
  });

  test('records error for invalid slug format', () => {
    const r = normalizeConfiguredDefaultReviewers(['gem@ini']);
    assert.ok(r.errors.some((e) => e.includes('invalid reviewer slug')));
  });
});

describe('resolveReviewerSelection', () => {
  test('explicit_flags source — returns intersection of flags and detected', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini', 'claude'],
      explicitFlags: ['gemini'],
      allFlag: false,
    });
    assert.equal(r.source, 'explicit_flags');
    assert.deepStrictEqual(r.selected, ['gemini']);
  });

  test('all_flag source — returns all detected', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini', 'claude'],
      explicitFlags: [],
      allFlag: true,
    });
    assert.equal(r.source, 'all_flag');
    assert.ok(r.selected.includes('gemini'));
    assert.ok(r.selected.includes('claude'));
  });

  test('no_config_all_detected source — returns all detected when no config', () => {
    const r = resolveReviewerSelection({
      detected: ['gemini'],
      explicitFlags: [],
      allFlag: false,
    });
    assert.equal(r.source, 'no_config_all_detected');
    assert.deepStrictEqual(r.selected, ['gemini']);
  });

  test('selected is sorted alphabetically', () => {
    const r = resolveReviewerSelection({
      detected: ['claude', 'gemini'],
      explicitFlags: [],
      allFlag: true,
    });
    assert.deepStrictEqual(r.selected, [...r.selected].sort());
  });

  test('result has source, selected, warnings, infos, errors', () => {
    const r = resolveReviewerSelection({ detected: [] });
    assert.ok('source' in r);
    assert.ok(Array.isArray(r.selected));
    assert.ok(Array.isArray(r.warnings));
    assert.ok(Array.isArray(r.infos));
    assert.ok(Array.isArray(r.errors));
  });
});
