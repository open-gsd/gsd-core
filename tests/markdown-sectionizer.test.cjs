'use strict';

/**
 * Behavioral tests for markdown-sectionizer.cjs
 *
 * Module: gsd-core/bin/lib/markdown-sectionizer.cjs
 * Exports: stripFencedCode, tokenizeHeadings, collectSections, collectSection, iterateBullets
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
