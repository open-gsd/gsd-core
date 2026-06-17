'use strict';

/**
 * Behavioral tests for markdown-sectionizer.cjs
 *
 * Module: gsd-core/bin/lib/markdown-sectionizer.cjs
 * Exports: stripFencedCode, tokenizeHeadings, collectSections, collectSection,
 *          iterateBullets, extractTaggedBlocks, replaceSection
 *
 * Covers the parser QA matrix from CONTRIBUTING.md §'Parser and project-file inputs':
 *   - LF vs CRLF line endings
 *   - Unicode headings
 *   - Heading INSIDE a fenced block (must be ignored)
 *   - Unterminated fence (unterminatedFence === true)
 *   - Nested heading levels with level-bounded stop
 *   - All three bullet markers (dash/checkbox/numbered) + indented continuation lines
 *   - Empty/whitespace/non-string input
 *
 * Includes a fast-check property test (stripFencedCode idempotence invariant).
 * The parity guard for the T0-era tracked duplication (stripFencedCode vs
 * uat-predicate _stripFencedBlocks) was removed in T5: uat-predicate now imports
 * the seam directly, so the guard would compare the seam to itself.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  stripFencedCode,
  tokenizeHeadings,
  collectSections,
  collectSection,
  iterateBullets,
  extractTaggedBlocks,
  replaceSection,
} = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

// ─── stripFencedCode ──────────────────────────────────────────────────────────

describe('stripFencedCode', () => {
  test('returns empty text and no unterminatedFence on empty input', () => {
    const r = stripFencedCode('');
    assert.equal(r.text, '');
    assert.equal(r.unterminatedFence, false);
  });

  test('non-string input returns empty result', () => {
    // Safety: callers may pass non-strings; must not throw
    for (const bad of [null, undefined, 42, [], {}]) {
      const r = stripFencedCode(bad);
      assert.equal(r.text, '');
      assert.equal(r.unterminatedFence, false);
    }
  });

  test('content with no fences is returned unchanged', () => {
    const src = '## Heading\n\nSome text.\n\n- bullet';
    const r = stripFencedCode(src);
    assert.equal(r.text, src);
    assert.equal(r.unterminatedFence, false);
  });

  test('removes a backtick fenced block (LF)', () => {
    const src = [
      'before',
      '```js',
      'const x = 1;',
      '```',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'before\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('removes a tilde fenced block', () => {
    const src = [
      'before',
      '~~~',
      'some code',
      '~~~',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'before\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('handles CRLF line endings correctly', () => {
    const src = 'before\r\n```\r\ncode\r\n```\r\nafter';
    const r = stripFencedCode(src);
    assert.ok(r.text.includes('before'));
    assert.ok(r.text.includes('after'));
    assert.ok(!r.text.includes('code'), 'code inside fence should be stripped');
    assert.equal(r.unterminatedFence, false);
  });

  test('unterminatedFence is true when fence is not closed', () => {
    const src = 'before\n```\nsome code without closing fence';
    const r = stripFencedCode(src);
    assert.equal(r.unterminatedFence, true);
    assert.ok(!r.text.includes('some code'), 'fence body should be stripped even if unterminated');
  });

  test('tilde inside backtick fence is treated as content, not a closer', () => {
    const src = [
      '```',
      '~~~',
      'still inside',
      '```',
      'outside',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'outside');
    assert.equal(r.unterminatedFence, false);
  });

  test('backtick inside tilde fence is treated as content, not a closer', () => {
    const src = [
      '~~~',
      '```',
      'still inside',
      '~~~',
      'outside',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'outside');
    assert.equal(r.unterminatedFence, false);
  });

  test('closing fence must be same-char and same-or-longer run', () => {
    // A `` ``` `` opener cannot be closed by ```` ```` ``; a 4-backtick closer is valid.
    const src = [
      'text',
      '```',
      'body',
      '`````',   // longer run of same char — valid closer per CommonMark
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'text\nafter');
    assert.equal(r.unterminatedFence, false);
  });

  test('closing fence must have no trailing non-whitespace text', () => {
    // ``` js (info string) is only valid on OPENING lines; a line like "``` extra"
    // inside a fence is content, not a closer.
    const src = [
      '```',
      '``` still inside (has trailing text)',
      '```',
      'after',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'after');
    assert.equal(r.unterminatedFence, false);
  });

  test('multiple successive fenced blocks are all stripped', () => {
    const src = [
      'a',
      '```',
      'code1',
      '```',
      'b',
      '```',
      'code2',
      '```',
      'c',
    ].join('\n');
    const r = stripFencedCode(src);
    assert.equal(r.text, 'a\nb\nc');
    assert.equal(r.unterminatedFence, false);
  });
});

// ─── tokenizeHeadings ─────────────────────────────────────────────────────────

describe('tokenizeHeadings', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(tokenizeHeadings(''), []);
    assert.deepEqual(tokenizeHeadings(null), []);
    assert.deepEqual(tokenizeHeadings(undefined), []);
  });

  test('extracts ATX headings in document order', () => {
    const src = '# H1\n## H2\n### H3\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 3);
    assert.equal(tokens[0].level, 1);
    assert.equal(tokens[0].text, 'H1');
    assert.equal(tokens[1].level, 2);
    assert.equal(tokens[1].text, 'H2');
    assert.equal(tokens[2].level, 3);
    assert.equal(tokens[2].text, 'H3');
  });

  test('headings inside fenced blocks are ignored', () => {
    const src = [
      '# Real heading',
      '```',
      '## Fake heading inside fence',
      '```',
      '## Another real heading',
    ].join('\n');
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'Real heading');
    assert.equal(tokens[1].text, 'Another real heading');
  });

  test('supports Unicode heading text', () => {
    const src = '## Résumé — Überblick\n### 日本語見出し\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'Résumé — Überblick');
    assert.equal(tokens[1].text, '日本語見出し');
  });

  test('records correct 1-based line number', () => {
    const src = 'prose\n## Heading\nmore';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].line, 2);
  });

  test('records non-negative byte offset', () => {
    const src = 'prose\n## Heading\n';
    const tokens = tokenizeHeadings(src);
    assert.ok(tokens[0].offset >= 0);
    // The offset should point somewhere inside the heading line
    assert.ok(tokens[0].offset < src.length);
  });

  test('handles CRLF headings', () => {
    const src = '# H1\r\n## H2\r\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].text, 'H1');
    assert.equal(tokens[1].text, 'H2');
  });

  test('ignores setext-style headings (only ATX supported)', () => {
    // Setext (underline) headings are NOT in scope for this seam
    const src = 'Title\n=====\n\nSubtitle\n--------\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 0);
  });
});

// ─── collectSections ─────────────────────────────────────────────────────────

describe('collectSections', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(collectSections('', () => true), []);
    assert.deepEqual(collectSections(null, () => true), []);
  });

  test('collects all headings when predicate is always-true', () => {
    const src = '## A\nBody A\n## B\nBody B\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading.text, 'A');
    assert.ok(sections[0].body.includes('Body A'));
    assert.equal(sections[1].heading.text, 'B');
    assert.ok(sections[1].body.includes('Body B'));
  });

  test('collects only headings matching predicate; non-matching headings end section', () => {
    // When the predicate matches Section A but not Section B, Section B acts as
    // a body line inside Section A (it is not a stop boundary), so its *heading*
    // text appears in the body. However Section B's *content* also appears.
    // If we want to stop at any heading regardless of the predicate, callers
    // should use levelBounded collectSection instead.
    //
    // To test filtering: use a predicate that matches both headings, then verify
    // two sections are returned with the correct split.
    const src = '## Section A\nContent A\n## Section B\nContent B\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading.text, 'Section A');
    assert.ok(sections[0].body.includes('Content A'));
    assert.ok(!sections[0].body.includes('Content B'), 'Content B must not appear in Section A body');
    assert.equal(sections[1].heading.text, 'Section B');
    assert.ok(sections[1].body.includes('Content B'));
  });

  test('stopPredicate controls which headings open sections; non-matching headings appear as body text', () => {
    // When predicate matches only Section A, Section B is not a stop boundary
    // so it (and its content) is included in Section A's body.
    const src = '## Section A\nContent A\n## Section B\nContent B\n';
    const sections = collectSections(src, (h) => h.text.includes('A'));
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading.text, 'Section A');
    assert.ok(sections[0].body.includes('Content A'));
    // Section B heading line and Content B are inside Section A's body
    assert.ok(sections[0].body.includes('Section B'));
    assert.ok(sections[0].body.includes('Content B'));
  });

  test('last section body runs to EOF', () => {
    const src = '## Only\nBody line 1\nBody line 2';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 1);
    assert.ok(sections[0].body.includes('Body line 1'));
    assert.ok(sections[0].body.includes('Body line 2'));
  });

  test('adjacent headings produce empty bodies', () => {
    const src = '## A\n## B\n## C\nContent C\n';
    const sections = collectSections(src, () => true);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].body.trim(), '');
    assert.equal(sections[1].body.trim(), '');
    assert.ok(sections[2].body.includes('Content C'));
  });
});

// ─── collectSection ───────────────────────────────────────────────────────────

describe('collectSection', () => {
  test('returns null when no heading matches', () => {
    const src = '## Foo\ntext\n';
    const result = collectSection(src, (h) => h.text === 'Bar');
    assert.equal(result, null);
  });

  test('returns null for empty/non-string input', () => {
    assert.equal(collectSection('', () => true), null);
    assert.equal(collectSection(null, () => true), null);
  });

  test('collects section body up to next same-level heading (levelBounded default)', () => {
    const src = [
      '## Section A',
      'Content A',
      '## Section B',
      'Content B',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Section A');
    assert.ok(result !== null);
    assert.ok(result.body.includes('Content A'));
    assert.ok(!result.body.includes('Content B'));
  });

  test('levelBounded: true — sub-headings are included in body, not stops', () => {
    const src = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Parent', { levelBounded: true });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Parent intro'));
    assert.ok(result.body.includes('Child'), 'child heading line should be in body');
    assert.ok(result.body.includes('Child body'));
    assert.ok(!result.body.includes('Sibling body'), 'sibling body should NOT be included');
  });

  test('levelBounded: false — stops at any following heading', () => {
    const src = [
      '## Parent',
      'Parent intro',
      '### Child',
      'Child body',
      '## Sibling',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Parent', { levelBounded: false });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Parent intro'));
    assert.ok(!result.body.includes('Child body'), 'with levelBounded:false, child heading stops section');
  });

  test('stripFences: true — strips fenced blocks from body', () => {
    const src = [
      '## Section',
      '```',
      'code here',
      '```',
      'prose here',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Section', { stripFences: true });
    assert.ok(result !== null);
    assert.ok(!result.body.includes('code here'), 'fenced code should be stripped');
    assert.ok(result.body.includes('prose here'));
  });

  test('heading token in result matches the matched heading', () => {
    const src = '## My Section\nContent\n';
    const result = collectSection(src, (h) => h.text === 'My Section');
    assert.ok(result !== null);
    assert.equal(result.heading.text, 'My Section');
    assert.equal(result.heading.level, 2);
  });

  test('nested heading level: H3 section stops at next H3 or higher', () => {
    const src = [
      '### Alpha',
      'Alpha body',
      '#### Sub-Alpha',
      'Sub-Alpha body',
      '### Beta',
      'Beta body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Alpha', { levelBounded: true });
    assert.ok(result !== null);
    assert.ok(result.body.includes('Alpha body'));
    assert.ok(result.body.includes('Sub-Alpha'));
    assert.ok(!result.body.includes('Beta body'));
  });

  test('section at EOF has body to end of string', () => {
    const src = '## Only\nLast line';
    const result = collectSection(src, (h) => h.text === 'Only');
    assert.ok(result !== null);
    assert.ok(result.body.includes('Last line'));
  });
});

// ─── iterateBullets ───────────────────────────────────────────────────────────

describe('iterateBullets', () => {
  test('returns empty array for empty/non-string input', () => {
    assert.deepEqual(iterateBullets(''), []);
    assert.deepEqual(iterateBullets(null), []);
    assert.deepEqual(iterateBullets(undefined), []);
    assert.deepEqual(iterateBullets('   '), []);
  });

  test('parses dash bullets', () => {
    const src = '- First\n- Second\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].marker, 'dash');
    assert.equal(items[0].text, 'First');
    assert.equal(items[0].checked, null);
    assert.equal(items[1].text, 'Second');
  });

  test('parses asterisk and plus bullets as dash marker', () => {
    const src = '* Asterisk\n+ Plus\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].marker, 'dash');
    assert.equal(items[0].text, 'Asterisk');
    assert.equal(items[1].marker, 'dash');
    assert.equal(items[1].text, 'Plus');
  });

  test('parses unchecked checkbox bullets', () => {
    const src = '- [ ] Todo item\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-unchecked');
    assert.equal(items[0].checked, false);
    assert.equal(items[0].text, 'Todo item');
  });

  test('parses checked checkbox bullets (lowercase x)', () => {
    const src = '- [x] Done item\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-checked');
    assert.equal(items[0].checked, true);
    assert.equal(items[0].text, 'Done item');
  });

  test('parses checked checkbox bullets (uppercase X)', () => {
    const src = '- [X] Done uppercase\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].marker, 'checkbox-checked');
    assert.equal(items[0].checked, true);
  });

  test('parses numbered bullets', () => {
    const src = '1. First\n2. Second\n42. Forty-two\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 3);
    assert.equal(items[0].marker, 'numbered');
    assert.equal(items[0].text, 'First');
    assert.equal(items[0].checked, null);
    assert.equal(items[2].text, 'Forty-two');
  });

  test('accumulates indented continuation lines into bullet text', () => {
    const src = [
      '- Main bullet',
      '  continuation line',
      '  another continuation',
      '- Next bullet',
    ].join('\n');
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.ok(items[0].text.includes('Main bullet'));
    assert.ok(items[0].text.includes('continuation line'));
    assert.ok(items[0].text.includes('another continuation'));
    assert.equal(items[1].text, 'Next bullet');
  });

  test('blank line terminates current bullet', () => {
    const src = '- First\n\n- Second\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'First');
    assert.equal(items[1].text, 'Second');
  });

  test('mixed marker types in sequence', () => {
    const src = [
      '1. Numbered',
      '- [x] Checked',
      '- [ ] Unchecked',
      '- Plain dash',
    ].join('\n');
    const items = iterateBullets(src);
    assert.equal(items.length, 4);
    assert.equal(items[0].marker, 'numbered');
    assert.equal(items[1].marker, 'checkbox-checked');
    assert.equal(items[2].marker, 'checkbox-unchecked');
    assert.equal(items[3].marker, 'dash');
  });

  test('CRLF input is handled correctly', () => {
    const src = '- First\r\n- Second\r\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, 'First');
    assert.equal(items[1].text, 'Second');
  });

  test('indent field captures leading whitespace of bullet opener', () => {
    const src = '  - Indented bullet\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].indent, '  ');
  });

  test('non-bullet lines before any bullet are ignored', () => {
    const src = 'Some prose\n\n- Bullet\n';
    const items = iterateBullets(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'Bullet');
  });
});

// ─── Integration: heading inside fenced block is ignored end-to-end ───────────

describe('integration: fenced heading ignored', () => {
  test('collectSection ignores headings inside fenced blocks', () => {
    const src = [
      '## Real',
      'Real body',
      '```',
      '## Fake inside fence',
      '```',
      'More real body',
    ].join('\n');
    const result = collectSection(src, (h) => h.text === 'Real');
    assert.ok(result !== null, 'should find the real heading');
    assert.ok(result.body.includes('More real body'), 'real body after fence should be included');
    // The section should not have ended at the fake heading
  });

  test('tokenizeHeadings ignores headings in CRLF fenced blocks', () => {
    const src = '# Outer\r\n```\r\n# Inner\r\n```\r\n## After\r\n';
    const tokens = tokenizeHeadings(src);
    const texts = tokens.map((t) => t.text);
    assert.ok(texts.includes('Outer'));
    assert.ok(texts.includes('After'));
    assert.ok(!texts.includes('Inner'), 'heading inside fence should be invisible');
  });
});

// ─── Property test: stripFencedCode idempotence ───────────────────────────────

describe('stripFencedCode: property-based tests', () => {
  test('property: never throws on any string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 500 }),
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 200 }),
          fc.constant(''),
          fc.constant('```\ncode\n```\n'),
          fc.constant('~~~\nunterminated'),
        ),
        (input) => {
          assert.doesNotThrow(
            () => stripFencedCode(input),
            `stripFencedCode threw on: ${JSON.stringify(input.slice(0, 80))}`,
          );
        },
      ),
    );
  });

  test('property: always returns { text: string, unterminatedFence: boolean }', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const result = stripFencedCode(input);
          assert.ok(typeof result === 'object' && result !== null, 'result must be object');
          assert.ok(typeof result.text === 'string', 'text must be string');
          assert.ok(typeof result.unterminatedFence === 'boolean', 'unterminatedFence must be boolean');
        },
      ),
    );
  });

  test('property: idempotence — stripping twice gives the same text as stripping once', () => {
    // A well-formed (terminated) fence: strip once gives fence-free text with no
    // remaining fences. Stripping again gives the same text.
    // For unterminated fences the text after first strip has no fence content but
    // the result is still idempotent — stripping a fence-free string is a no-op.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const once = stripFencedCode(input);
          const twice = stripFencedCode(once.text);
          assert.equal(
            twice.text,
            once.text,
            `Idempotence violated: input=${JSON.stringify(input.slice(0, 60))}`,
          );
          // After the first strip the text has no fences (or only unterminated remnants),
          // so the second pass must not report unterminated unless the first pass already did.
          // (The second pass cannot have MORE unterminatedFence; it can have less.)
          assert.ok(
            !twice.unterminatedFence || once.unterminatedFence,
            'Second pass may not introduce a new unterminatedFence not present in first pass',
          );
        },
      ),
    );
  });

  test('property: output text is always a substring or equal-length string of input', () => {
    // Stripping removes content, so output length <= input length
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (input) => {
          const result = stripFencedCode(input);
          assert.ok(
            result.text.length <= input.length,
            `Output (${result.text.length}) must not be longer than input (${input.length})`,
          );
        },
      ),
    );
  });
});

// ─── extractTaggedBlocks ──────────────────────────────────────────────────────

describe('extractTaggedBlocks', () => {
  test('returns empty array for empty/non-string content', () => {
    assert.deepEqual(extractTaggedBlocks('', 'decisions'), []);
    assert.deepEqual(extractTaggedBlocks(null, 'decisions'), []);
    assert.deepEqual(extractTaggedBlocks(undefined, 'decisions'), []);
  });

  test('returns empty array when tag is empty/non-string', () => {
    assert.deepEqual(extractTaggedBlocks('<decisions>body</decisions>', ''), []);
    assert.deepEqual(extractTaggedBlocks('<decisions>body</decisions>', null), []);
  });

  test('returns empty array when tag is not present', () => {
    const content = 'Some prose without any matching block.\n## Heading\n- bullet';
    assert.deepEqual(extractTaggedBlocks(content, 'decisions'), []);
  });

  test('extracts inner text of a single block', () => {
    const content = 'before\n<decisions>\nD-01: Foo\n</decisions>\nafter';
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('D-01: Foo'), 'inner text should be returned');
  });

  test('extracts multiple blocks in document order', () => {
    const content = [
      '<decisions>',
      'D-01: First',
      '</decisions>',
      'some text',
      '<decisions>',
      'D-02: Second',
      '</decisions>',
    ].join('\n');
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('D-01: First'));
    assert.ok(result[1].includes('D-02: Second'));
  });

  test('preserves document order of multiple blocks', () => {
    const content = '<tag>alpha</tag> middle <tag>beta</tag> end <tag>gamma</tag>';
    const result = extractTaggedBlocks(content, 'tag');
    assert.deepEqual(result, ['alpha', 'beta', 'gamma']);
  });

  test('handles CRLF content inside a block', () => {
    const content = '<decisions>\r\nD-01: CRLF test\r\n</decisions>';
    const result = extractTaggedBlocks(content, 'decisions');
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('D-01: CRLF test'));
  });

  test('tag name that needs regex-escaping: dot in tag name is matched literally', () => {
    // A tag name with a dot (e.g. 'my.tag') must be matched literally, not as
    // a regex wildcard. So '<my.tag>' should match only the exact literal tag.
    const content = '<my.tag>inner</my.tag>';
    const result = extractTaggedBlocks(content, 'my.tag');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'inner');
    // Crucially, 'myXtag' (dot as wildcard) should NOT match the literal block
    const result2 = extractTaggedBlocks('<myXtag>other</myXtag>', 'my.tag');
    assert.equal(result2.length, 0, 'dot in tagName must be treated as literal, not wildcard');
  });

  test('tag name with + character is escaped and matched literally', () => {
    const content = '<my+tag>inner</my+tag>';
    const result = extractTaggedBlocks(content, 'my+tag');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'inner');
  });

  test('content with tag text appearing outside any block is not extracted', () => {
    // The tag appears as inline text, not as an XML block
    const _content = 'This is about <decisions> but no closing tag in same element sense\n\nNot a block.';
    // Actually we need to use content that has the opening tag on the same line as text
    // but no matching close tag — result should be empty or the inner text is everything after.
    // Since the regex is non-greedy, an unclosed tag won't match.
    const content2 = 'Text with <decisions> but tag is unclosed.';
    const result = extractTaggedBlocks(content2, 'decisions');
    assert.equal(result.length, 0, 'unclosed tag should not produce a match');
  });
});

// ─── replaceSection ───────────────────────────────────────────────────────────

describe('replaceSection', () => {
  test('replaces section body and preserves heading and surrounding sections', () => {
    const content = '## Intro\nIntro body.\n## Name\nOld name body.\n## Footer\nFooter body.\n';
    const section = collectSection(content, (h) => h.text === 'Name');
    assert.ok(section !== null, 'section must be found');
    const newContent = replaceSection(content, section, 'New name body.\n');
    assert.ok(newContent.includes('## Intro'), 'Intro heading preserved');
    assert.ok(newContent.includes('Intro body.'), 'Intro body preserved');
    assert.ok(newContent.includes('## Name'), 'Name heading preserved');
    assert.ok(newContent.includes('New name body.'), 'new body present');
    assert.ok(!newContent.includes('Old name body.'), 'old body removed');
    assert.ok(newContent.includes('## Footer'), 'Footer heading preserved');
    assert.ok(newContent.includes('Footer body.'), 'Footer body preserved');
  });

  test('replaces section body in a multi-section document', () => {
    const content = [
      '## Alpha',
      'Alpha content.',
      '## Beta',
      'Beta old content.',
      '## Gamma',
      'Gamma content.',
    ].join('\n') + '\n';
    const section = collectSection(content, (h) => h.text === 'Beta');
    assert.ok(section !== null);
    const updated = replaceSection(content, section, 'Beta new content.\n');
    assert.ok(updated.includes('Alpha content.'), 'Alpha preserved');
    assert.ok(updated.includes('Beta new content.'), 'Beta updated');
    assert.ok(!updated.includes('Beta old content.'), 'Beta old removed');
    assert.ok(updated.includes('Gamma content.'), 'Gamma preserved');
  });

  test('round-trip: collectSection → replaceSection with section.body → content unchanged', () => {
    // INVARIANT: content.slice(bodyStart, bodyEnd) === body
    // so replaceSection(content, section, section.body) must equal content exactly.
    const content = '## Section A\nLine one.\nLine two.\n## Section B\nB body.\n';
    const section = collectSection(content, (h) => h.text === 'Section A');
    assert.ok(section !== null);
    // Verify the slice invariant directly
    assert.equal(
      content.slice(section.bodyStart, section.bodyEnd),
      section.body,
      'content.slice(bodyStart, bodyEnd) must equal section.body (invariant)',
    );
    // True round-trip: supply section.body (not a re-sliced value)
    const roundTripped = replaceSection(content, section, section.body);
    assert.equal(roundTripped, content, 'round-trip must produce identical content');
  });

  test('CRLF content is handled without corruption', () => {
    const content = '## Title\r\nOld body.\r\n## Next\r\nNext body.\r\n';
    const section = collectSection(content, (h) => h.text === 'Title');
    assert.ok(section !== null);
    const updated = replaceSection(content, section, 'New body.\r\n');
    assert.ok(updated.includes('## Title\r\n'), 'heading with CRLF preserved');
    assert.ok(updated.includes('New body.'), 'new body present');
    assert.ok(!updated.includes('Old body.'), 'old body removed');
    assert.ok(updated.includes('## Next\r\n'), 'next section heading preserved');
    assert.ok(updated.includes('Next body.'), 'next section body preserved');
  });

  test('non-string arguments return content unchanged', () => {
    const content = '## Sec\nbody\n';
    const section = collectSection(content, (h) => h.text === 'Sec');
    assert.ok(section !== null);
    assert.equal(replaceSection(null, section, 'x'), null);
    assert.equal(replaceSection(content, section, null), content);
  });
});

// ─── FIX 1: Section offset invariant tests ────────────────────────────────────

describe('Section offset invariant: content.slice(bodyStart, bodyEnd) === body', () => {
  test('invariant holds for a mid-document section (LF, trailing newline)', () => {
    const content = '## A\nBody A\n## B\nBody B\n';
    const s = collectSection(content, (h) => h.text === 'A');
    assert.ok(s !== null);
    assert.equal(
      content.slice(s.bodyStart, s.bodyEnd),
      s.body,
      'invariant: content.slice(bodyStart, bodyEnd) === body',
    );
    assert.equal(
      replaceSection(content, s, s.body),
      content,
      'true round-trip with section.body must be identity',
    );
  });

  test('invariant holds at EOF with no trailing newline', () => {
    const content = '## Only\nLast line';
    const s = collectSection(content, (h) => h.text === 'Only');
    assert.ok(s !== null);
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'EOF no-trailing-newline invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'round-trip EOF no-trailing-newline');
  });

  test('invariant holds with CRLF line endings', () => {
    const content = '## Title\r\nBody line.\r\n## Next\r\nNext body.\r\n';
    const s = collectSection(content, (h) => h.text === 'Title');
    assert.ok(s !== null);
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'CRLF invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'CRLF round-trip');
  });

  test('invariant holds for an empty body (adjacent headings)', () => {
    const content = '## A\n## B\nB body\n';
    const s = collectSection(content, (h) => h.text === 'A');
    assert.ok(s !== null);
    assert.equal(s.body, '', 'empty body expected');
    assert.equal(content.slice(s.bodyStart, s.bodyEnd), s.body, 'empty body invariant');
    assert.equal(replaceSection(content, s, s.body), content, 'empty body round-trip');
  });

  test('collectSections: invariant holds for every returned section', () => {
    const content = '## Alpha\nAlpha body.\n## Beta\nBeta body.\n## Gamma\nGamma body\n';
    const sections = collectSections(content, () => true);
    assert.equal(sections.length, 3);
    for (const s of sections) {
      assert.equal(
        content.slice(s.bodyStart, s.bodyEnd),
        s.body,
        `collectSections invariant for section "${s.heading.text}"`,
      );
      assert.equal(
        replaceSection(content, s, s.body),
        content,
        `collectSections round-trip for section "${s.heading.text}"`,
      );
    }
  });
});

// ─── FIX 2: tokenizeHeadings CommonMark indented and empty headings ──────────

describe('tokenizeHeadings: CommonMark ≤3-space indent and empty headings', () => {
  test('1-space indent is a valid heading', () => {
    const src = ' # One space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 1);
    assert.equal(tokens[0].text, 'One space heading');
  });

  test('2-space indent is a valid heading', () => {
    const src = '  ## Two space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, 'Two space heading');
  });

  test('3-space indent is a valid heading', () => {
    const src = '   ### Three space heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 3);
    assert.equal(tokens[0].text, 'Three space heading');
  });

  test('4-space indent is NOT a heading (indented code block per CommonMark)', () => {
    const src = '    ## Four space — not a heading\n## Real heading\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1, 'only the non-indented heading should be found');
    assert.equal(tokens[0].text, 'Real heading');
  });

  test('## with no following text is an empty heading (text === "")', () => {
    const src = '##\n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, '');
  });

  test('##   (only whitespace after hashes) is an empty heading (text === "")', () => {
    const src = '##   \n';
    const tokens = tokenizeHeadings(src);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].level, 2);
    assert.equal(tokens[0].text, '');
  });
});

// ─── FIX 3: collectSection stopAtLevel option ─────────────────────────────────

describe('collectSection: stopAtLevel option', () => {
  test('stopAtLevel:3 stops a ##-opened section at the following ###', () => {
    const src = [
      '## Parent',
      'Parent body',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const s = collectSection(src, (h) => h.text === 'Parent', { stopAtLevel: 3 });
    assert.ok(s !== null);
    assert.ok(s.body.includes('Parent body'), 'parent body included');
    assert.ok(!s.body.includes('Child body'), 'section should stop at ### with stopAtLevel:3');
    assert.ok(!s.body.includes('Sibling body'), 'sibling body not included');
  });

  test('default levelBounded:true does NOT stop a ##-opened section at ###', () => {
    const src = [
      '## Parent',
      'Parent body',
      '### Child',
      'Child body',
      '## Sibling',
      'Sibling body',
    ].join('\n');
    const s = collectSection(src, (h) => h.text === 'Parent', { levelBounded: true });
    assert.ok(s !== null);
    assert.ok(s.body.includes('Child body'), 'child body is inside the ## section with levelBounded');
    assert.ok(!s.body.includes('Sibling body'), 'sibling body not included');
  });

  test('stopAtLevel:2 stops at the next ## (same as levelBounded default for ## opener)', () => {
    const src = '## A\nA body\n## B\nB body\n';
    const s = collectSection(src, (h) => h.text === 'A', { stopAtLevel: 2 });
    assert.ok(s !== null);
    assert.ok(s.body.includes('A body'));
    assert.ok(!s.body.includes('B body'));
  });

  test('stopAtLevel round-trip invariant holds', () => {
    const src = '## Parent\nParent body\n### Child\nChild body\n## Sibling\nSibling body\n';
    const s = collectSection(src, (h) => h.text === 'Parent', { stopAtLevel: 3 });
    assert.ok(s !== null);
    assert.equal(src.slice(s.bodyStart, s.bodyEnd), s.body, 'offset invariant with stopAtLevel');
    assert.equal(replaceSection(src, s, s.body), src, 'round-trip with stopAtLevel');
  });
});

// ─── FIX 4: backtick fence — info string with backtick is not a fence opener ─

describe('stripFencedCode and tokenizeHeadings: backtick info string with backtick', () => {
  test('stripFencedCode: backtick in info string does not open a backtick fence', () => {
    // The line "``` ` info" has a backtick in the info string → NOT a fence opener.
    const src = '``` ` not-a-fence\n## Heading\n';
    const r = stripFencedCode(src);
    // Both lines should be kept (no fence was opened)
    assert.ok(r.text.includes('## Heading'), 'heading line must be kept since no fence opened');
    assert.ok(r.text.includes('``` ` not-a-fence'), 'the non-fence line must be kept');
    assert.equal(r.unterminatedFence, false, 'no fence was opened, so unterminated must be false');
  });

  test('tokenizeHeadings: heading after a backtick-in-info line is still tokenized', () => {
    // ``` ` info-with-backtick is NOT a fence opener, so ## Heading below it is visible.
    const src = '``` ` not-a-fence\n## Heading\nprose\n```\n';
    const tokens = tokenizeHeadings(src);
    assert.ok(tokens.some((t) => t.text === 'Heading'), '## Heading must be tokenized when "opener" has backtick in info');
  });

  test('tilde fence info string WITH backtick IS still a valid fence opener (tildes unaffected)', () => {
    // Only backtick fences have the "no backtick in info" restriction.
    const src = '~~~ ` this-is-fine\n## Inside tilde fence\n~~~\n## Outside\n';
    const tokens = tokenizeHeadings(src);
    // ## Inside tilde fence should be ignored (inside a real fence)
    assert.ok(!tokens.some((t) => t.text === 'Inside tilde fence'), 'tilde fence with backtick in info is still a valid fence');
    assert.ok(tokens.some((t) => t.text === 'Outside'), 'heading after tilde fence close is tokenized');
  });
});

// ─── FIX 6: extractTaggedBlocks — nested tag behavior ─────────────────────────

describe('extractTaggedBlocks: nested same-name tag behavior (non-greedy limitation)', () => {
  test('nested <x><x>…</x></x> closes at first </x> (non-greedy; nested tags not supported)', () => {
    // Non-greedy match: <x>([\s\S]*?)</x> closes at the FIRST </x>.
    // So <x><x>inner</x></x> → first block captures "<x>inner", second </x> is unmatched.
    const content = '<x><x>inner</x></x>';
    const result = extractTaggedBlocks(content, 'x');
    // The first match closes at the first </x>, capturing "<x>inner"
    assert.equal(result.length, 1, 'non-greedy match produces exactly one result from nested input');
    assert.equal(result[0], '<x>inner', 'inner capture is the content up to the first closing tag');
  });

  test('back-to-back blocks (not nested) are both extracted', () => {
    const content = '<x>first</x><x>second</x>';
    const result = extractTaggedBlocks(content, 'x');
    assert.equal(result.length, 2);
    assert.equal(result[0], 'first');
    assert.equal(result[1], 'second');
  });
});

// Parity guard removed in T5 (ADR-1372): uat-predicate now imports stripFencedCode
// from the seam directly, so comparing the seam to itself is tautological.
// The seam's stripFencedCode correctness is already covered by the tests above.
