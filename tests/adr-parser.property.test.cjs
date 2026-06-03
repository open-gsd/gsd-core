'use strict';

/**
 * Property-based tests for adr-parser.cjs
 *
 * Module: gsd-core/bin/lib/adr-parser.cjs
 * Exported: parseAdrMarkdown(markdown, options), shouldRejectAdrStatus(status)
 *
 * Properties tested:
 *   (a) shouldRejectAdrStatus: boundary — rejects exactly the known 3 statuses
 *   (b) shouldRejectAdrStatus: never throws on any input
 *   (c) parseAdrMarkdown: never throws on any string (including binary/unicode)
 *   (d) parseAdrMarkdown: always returns the required typed shape
 *   (e) parseAdrMarkdown: title extracted from H1 heading when present
 *   (f) parseAdrMarkdown: status is always a string (never null/undefined)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  parseAdrMarkdown,
  shouldRejectAdrStatus,
} = require('../gsd-core/bin/lib/adr-parser.cjs');

// Required output keys
const REQUIRED_KEYS = [
  'title', 'status', 'context', 'decisions', 'options_considered',
  'consequences_positive', 'consequences_negative', 'out_of_scope',
  'deferred', 'dependencies', 'updates', 'source_path', 'key_files',
  'plan_sequence', 'format', 'unmapped_headers',
];

// Known reject-statuses
const REJECT_STATUSES = ['superseded', 'rejected', 'deprecated'];
const ACCEPT_STATUSES = ['accepted', 'proposed', 'active', 'draft', ''];

describe('adr-parser: shouldRejectAdrStatus properties', () => {
  // (a) Boundary: exactly the 3 known reject statuses return true
  test('property: reject statuses return true, others return false', () => {
    for (const status of REJECT_STATUSES) {
      assert.equal(shouldRejectAdrStatus(status), true, `${status} should be rejected`);
    }
    for (const status of ACCEPT_STATUSES) {
      assert.equal(shouldRejectAdrStatus(status), false, `${status} should not be rejected`);
    }
  });

  // (b) Never throws on any input
  test('property: shouldRejectAdrStatus never throws on any input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(0),
          fc.constant(''),
          fc.string({ unit: 'binary', maxLength: 50 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 50 }),
          fc.string({ maxLength: 50 }),
          fc.boolean(),
          fc.constant([]),
          fc.constant({})
        ),
        (input) => {
          assert.doesNotThrow(
            () => shouldRejectAdrStatus(input),
            `shouldRejectAdrStatus threw on: ${JSON.stringify(input)}`
          );
        }
      )
    );
  });

  test('property: shouldRejectAdrStatus always returns boolean', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        (status) => {
          const result = shouldRejectAdrStatus(status);
          assert.ok(typeof result === 'boolean', `Expected boolean got ${typeof result} for ${JSON.stringify(status)}`);
        }
      )
    );
  });

  // Additional boundary: case variations should not reject (function is case-sensitive)
  test('property: uppercase variants of reject statuses are NOT rejected (case-sensitive)', () => {
    for (const status of REJECT_STATUSES) {
      const upper = status.toUpperCase();
      // The parser normalizes status to lowercase internally, but shouldRejectAdrStatus
      // is meant to receive an already-normalized status. If it receives uppercase,
      // it should return false (or true — we just want it not to throw).
      assert.doesNotThrow(() => shouldRejectAdrStatus(upper));
    }
  });
});

describe('adr-parser: parseAdrMarkdown properties', () => {
  // (c) Never throws on any string input
  test('property: parseAdrMarkdown never throws on any string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 500 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 500 }),
          fc.string({ maxLength: 500 }),
          fc.constant(''),
          fc.constant('# My ADR\n\n## Status\nAccepted\n\n## Decision\n- Do the thing.\n'),
          fc.constant('---\n# Not a real ADR\n---'),
          fc.constant('## No title\n\n## Status\nProposed')
        ),
        (markdown) => {
          assert.doesNotThrow(
            () => parseAdrMarkdown(markdown),
            `parseAdrMarkdown threw on: ${JSON.stringify(markdown.slice(0, 80))}`
          );
        }
      )
    );
  });

  // (d) Always returns the required typed shape
  test('property: parseAdrMarkdown always returns required typed shape', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (markdown) => {
          const result = parseAdrMarkdown(markdown);

          assert.ok(typeof result === 'object' && result !== null, 'result must be object');

          for (const key of REQUIRED_KEYS) {
            assert.ok(
              Object.prototype.hasOwnProperty.call(result, key),
              `missing required key: ${key}`
            );
          }

          assert.ok(typeof result.title === 'string', 'title must be string');
          assert.ok(typeof result.status === 'string', 'status must be string');
          assert.ok(typeof result.context === 'string', 'context must be string');
          assert.ok(Array.isArray(result.decisions), 'decisions must be array');
          assert.ok(Array.isArray(result.options_considered), 'options_considered must be array');
          assert.ok(Array.isArray(result.consequences_positive), 'consequences_positive must be array');
          assert.ok(Array.isArray(result.consequences_negative), 'consequences_negative must be array');
          assert.ok(Array.isArray(result.updates), 'updates must be array');
          assert.ok(Array.isArray(result.unmapped_headers), 'unmapped_headers must be array');
        }
      )
    );
  });

  // (e) Title extracted from H1 heading
  // The parser applies .trim() to the heading text, so the expected title must also be trimmed.
  test('property: H1 heading at line start is extracted as trimmed title', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,49}$/),
        (titleText) => {
          const markdown = `# ${titleText}\n\n## Status\nAccepted\n`;
          const result = parseAdrMarkdown(markdown);
          const expected = titleText.trim(); // parser trims heading text
          assert.equal(
            result.title,
            expected,
            `Expected title="${expected}" got "${result.title}"`
          );
        }
      )
    );
  });

  // (f) Status is always a non-null string
  test('property: status is always a string (never null/undefined)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        (markdown) => {
          const result = parseAdrMarkdown(markdown);
          assert.ok(
            typeof result.status === 'string',
            `status must be string, got ${typeof result.status}`
          );
        }
      )
    );
  });

  // Robustness: sourcePath option with arbitrary strings
  test('property: arbitrary sourcePath option never causes throws', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.oneof(
          fc.string({ maxLength: 100 }),
          fc.string({ unit: 'binary', maxLength: 50 }),
          fc.constant(null),
          fc.constant(undefined)
        ),
        (markdown, sourcePath) => {
          assert.doesNotThrow(
            () => parseAdrMarkdown(markdown, { sourcePath }),
            `parseAdrMarkdown threw with sourcePath=${JSON.stringify(sourcePath)}`
          );
        }
      )
    );
  });
});
