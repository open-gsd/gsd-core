// allow-test-rule: source-text-is-the-product (#3854)
// Asserts the markdown write-normalizer's blank-line policy through the
// exported seam (normalizeContent / platformWriteSync) — no source grepping.

/**
 * Tight-list preservation in markdown write normalization — shell-command-projection-md-normalize.test.cjs
 *
 * #3854: `phase.complete` (any .md write, really) injected one blank line
 * before every bullet that follows a multi-line item's indented continuation
 * line — converting tight markdown lists to loose ones (61 injected blanks on
 * the reporter's real ROADMAP; tight and loose lists render differently, so
 * it was a rendering change plus huge diff noise, not just whitespace).
 *
 * Root cause: `_normalizeMd`'s "separate a list from a preceding paragraph"
 * rule inserted a blank before a bullet whose previous line "wasn't a bullet"
 * — but an indented CONTINUATION line of the previous item also "isn't a
 * bullet". The mirror-image after-a-bullet rule already guards against
 * indented next lines; the before-a-bullet rule must too.
 *
 * These tests pin both directions: tight lists stay tight through the write
 * seam, and the legitimate paragraph↔list separations the rule exists for
 * still happen.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { normalizeContent, platformWriteSync } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { cleanup } = require('./helpers.cjs');

const MD = 'roadmap.md';

describe('#3854: write normalization preserves tight multi-line lists', () => {
  test('a bullet following a multi-line item\'s continuation gets NO injected blank', () => {
    const tight = [
      '# Roadmap v1.0',
      '',
      '- **RC-1 — first rule** whose text wraps onto',
      '  a continuation line',
      '- **RC-2 — second rule** also wrapping onto',
      '  its continuation line',
      '- **RC-3 — third rule** single line',
      '',
    ].join('\n');
    const { content } = normalizeContent(MD, tight);
    assert.ok(
      !content.includes('a continuation line\n\n- **RC-2'),
      'no blank may be injected between a wrapped item\'s last continuation and the next item (tight list stays tight)'
    );
    assert.ok(
      !content.includes('its continuation line\n\n- **RC-3'),
      'same for every following item'
    );
    assert.strictEqual(
      content.split('\n').filter((l) => l.trim() === '').length,
      tight.split('\n').filter((l) => l.trim() === '').length,
      'blank-line count must round-trip unchanged'
    );
  });

  test('numbered tight multi-line lists are preserved too', () => {
    const tight = [
      '1. First rule with a wrapped',
      '   continuation line',
      '2. Second rule',
    ].join('\n') + '\n';
    const { content } = normalizeContent(MD, tight);
    assert.ok(
      !content.includes('continuation line\n\n2.'),
      'no blank between a wrapped numbered item\'s continuation and the next item'
    );
  });

  test('the paragraph→list separation the rule exists for STILL happens', () => {
    const doc = 'A lead-in paragraph.\n- first item\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(
      content.includes('A lead-in paragraph.\n\n- first item'),
      'a list following a paragraph still gets its separating blank'
    );
  });

  test('heading/list separations are unchanged (regression pin on the rule\'s purpose)', () => {
    const doc = '## Section\n- item\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(content.includes('## Section\n\n- item'), 'heading→list keeps its blank');
  });

  test('normalization is idempotent on a tight list (no one-shot growth, no compounding)', () => {
    const tight = '- a\n  wrapped continuation\n- b\n';
    const once = normalizeContent(MD, tight).content;
    const twice = normalizeContent(MD, once).content;
    assert.strictEqual(once, twice, 'second pass must be a no-op');
    assert.strictEqual(once, tight, 'and the first pass must not have grown the document');
  });

  test('the write seam (platformWriteSync) lands the same bytes — end-to-end guard', () => {
    const osTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3854-'));
    try {
      const target = path.join(osTmp, 'ROADMAP.md');
      const tight = '# Roadmap v1.0\n\n- item one wraps\n  continuation one\n- item two wraps\n  continuation two\n';
      platformWriteSync(target, tight);
      const onDisk = fs.readFileSync(target, 'utf-8');
      assert.strictEqual(onDisk, tight, 'platformWriteSync must not convert the tight list to a loose one');
    } finally {
      cleanup(osTmp);
    }
  });
});

describe('#4499: markdown normalization preserves leading YAML frontmatter', () => {
  test('block sequences remain adjacent when an unrelated scalar changes', () => {
    const input = [
      '---',
      'phase: 01',
      'tags:',
      '- api',
      '- sdk',
      'owners:',
      '- platform',
      '- runtime',
      '---',
      '# Plan',
      '',
      'Body.',
      '',
    ].join('\n');

    const updated = input.replace('phase: 01', 'phase: 02');
    assert.strictEqual(normalizeContent(MD, updated).content, updated);
  });

  test('a block sequence immediately before the closing delimiter gains no blank', () => {
    const input = '---\ntags:\n- api\n- sdk\n---\n\nBody.\n';
    const { content } = normalizeContent(MD, input);
    assert.ok(!content.includes('- api\n\n- sdk'));
    assert.ok(!content.includes('- sdk\n\n---'));
    assert.strictEqual(content, input);
  });

  test('flow arrays in frontmatter remain byte-identical', () => {
    const input = '---\ntags: [api, sdk]\nphase: 01\n---\n\nBody.\n';
    assert.strictEqual(normalizeContent(MD, input).content, input);
  });

  test('body lists still receive paragraph separation after frontmatter', () => {
    const input = '---\ntags:\n- api\n- sdk\n---\n\nLead paragraph.\n- body item\n';
    const { content } = normalizeContent(MD, input);
    assert.ok(content.includes('tags:\n- api\n- sdk\n---'));
    assert.ok(content.includes('Lead paragraph.\n\n- body item'));
  });

  test('documents without frontmatter retain the existing list normalization', () => {
    const input = 'Lead paragraph.\n- item\n';
    assert.strictEqual(normalizeContent(MD, input).content, 'Lead paragraph.\n\n- item\n');
  });

  test('the issue-shaped nested block sequences remain byte-identical', () => {
    const input = [
      '---',
      'phase: 01',
      'must_haves:',
      '  truths:',
      '    - API behavior stays stable',
      '    - SDK behavior stays stable',
      '  artifacts:',
      '    - path: src/api.ts',
      '      provides:',
      '        - public API',
      '        - type declarations',
      '---',
      '# Plan',
      '',
    ].join('\n');
    assert.strictEqual(normalizeContent(MD, input).content, input);
  });

  test('single-item, empty, and deeply nested sequences preserve their boundaries', () => {
    const inputs = [
      '---\ntags:\n  - only\n---\n\nBody.\n',
      '---\ntags: []\n---\n\nBody.\n',
      '---\na:\n  b:\n    c:\n      - deep\n---\n\nBody.\n',
    ];
    for (const input of inputs) assert.strictEqual(normalizeContent(MD, input).content, input);
  });

  test('an unterminated opening delimiter does not disable body normalization', () => {
    const input = '---\nphase: 01\n# Heading\n- item\n';
    const { content } = normalizeContent(MD, input);
    assert.ok(content.includes('phase: 01\n\n# Heading\n\n- item'));
  });

  test('a leading thematic break and later divider are not mistaken for frontmatter', () => {
    const input = '---\n# Heading\n- item\n---\nTail.\n';
    const { content } = normalizeContent(MD, input);
    assert.ok(content.includes('# Heading\n\n- item'));
  });

  test('property: normalization preserves every generated frontmatter mapping byte-for-byte', () => {
    const scalar = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/);
    fc.assert(fc.property(fc.array(scalar, { maxLength: 12 }), (items) => {
      const list = items.length ? ['items:', ...items.map((item) => `  - ${item}`)] : ['items: []'];
      const frontmatter = ['---', 'phase: 01', ...list, '---'].join('\n');
      const input = `${frontmatter}\n# Plan\n\nBody.\n`;
      const output = normalizeContent(MD, input).content;
      assert.strictEqual(output.slice(0, frontmatter.length), frontmatter);
    }), { numRuns: 250 });
  });
});
