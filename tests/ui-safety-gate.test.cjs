'use strict';

/**
 * Characterization tests for the UI safety gate module.
 * Locks checkUiPresence behaviour and UI_TOKENS export shape.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkUiPresence,
  UI_TOKENS,
} = require('../gsd-core/bin/lib/ui-safety-gate.cjs');

describe('UI_TOKENS', () => {
  test('is an array containing expected token strings', () => {
    assert.ok(Array.isArray(UI_TOKENS));
    assert.ok(UI_TOKENS.includes('UI'));
    assert.ok(UI_TOKENS.includes('frontend'));
    assert.ok(UI_TOKENS.includes('component'));
    assert.ok(UI_TOKENS.length > 0);
  });
});

describe('checkUiPresence', () => {
  test('returns { hasUI: false, tokens: [] } for non-string input', () => {
    assert.deepStrictEqual(checkUiPresence(42), { hasUI: false, tokens: [] });
    assert.deepStrictEqual(checkUiPresence(null), { hasUI: false, tokens: [] });
  });

  test('returns false for empty string', () => {
    assert.deepStrictEqual(checkUiPresence(''), { hasUI: false, tokens: [] });
  });

  test('detects standalone UI token (case-insensitive)', () => {
    const result = checkUiPresence('This task involves UI work');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('ui'));
  });

  test('detects frontend token', () => {
    const result = checkUiPresence('Build a frontend component');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('frontend'));
  });

  test('does NOT match interior of alphanumeric word (bug #3706)', () => {
    // "Requirements" contains "ui" interior — must NOT match
    const result = checkUiPresence('Requirements analysis');
    assert.ok(!result.hasUI, 'Requirements should not trigger UI gate');

    // "microfrontend" is all-alphanumeric — must NOT match
    const result2 = checkUiPresence('microfrontend architecture');
    assert.ok(!result2.hasUI, 'microfrontend should not trigger UI gate');
  });

  test('matches token separated by hyphen (word boundary)', () => {
    // "micro-frontend" — "frontend" is at a word boundary after "-"
    const result = checkUiPresence('micro-frontend design');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('frontend'));
  });

  test('normalises CRLF line endings', () => {
    const result = checkUiPresence('Phase 1\r\nBuild a form\r\nDone');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('form'));
  });

  test('deduplicates repeated tokens', () => {
    const result = checkUiPresence('UI component and another UI widget');
    // "ui" should only appear once in tokens
    const uiCount = result.tokens.filter((t) => t === 'ui').length;
    assert.strictEqual(uiCount, 1);
  });

  test('detects multiple distinct tokens', () => {
    const result = checkUiPresence('Build a dashboard with a form');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('dashboard'));
    assert.ok(result.tokens.includes('form'));
  });
});
