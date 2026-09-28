'use strict';

/**
 * Tests for `src/frontmatter-fence.cts` — the one owner of frontmatter fence detection.
 *
 * Found while implementing #5105: "where does the frontmatter block start and stop" was
 * answered in four places that disagreed — `frontmatterRegion`/`frontmatterBlock`
 * (`frontmatter.cts`), `leadingFrontmatterLineCount` (`shell-command-projection.cts`, a
 * private copy because of a circular import), `findFrontmatterSpan`
 * (`planning-document.cts`, which re-derived the closing fence's end and was one character
 * long on an adjacent empty block) and `stripFrontmatter` (`frontmatter.cts`, a regex that
 * could not see an adjacent empty block at all and so stripped through the first `---` in
 * the body). `locateFrontmatterFence` is now the single answer, and every consumer is
 * pinned to agree with it on generated documents.
 *
 * The rules: a leading UTF-8 BOM is tolerated; the opening fence is exactly `---` followed
 * by `\n` or `\r\n` at byte 0; the closing fence is the first later WHOLE line that is
 * `---` plus optional trailing spaces/tabs, ended by `\n`, `\r\n` or the end of the text
 * (`----`, `--- x` and `--` are not closers); a closer on the very next line is a closed,
 * empty block.
 *
 * TDD RED: `src/frontmatter-fence.cts` does not exist yet, so the require below throws
 * MODULE_NOT_FOUND until the implementing commit adds it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { locateFrontmatterFence } = require('../gsd-core/bin/lib/frontmatter-fence.cjs');
const {
  frontmatterRegion,
  frontmatterBlock,
  extractFrontmatter,
  stripFrontmatter,
  spliceFrontmatter,
  isFrontmatterWriteRefusal,
  FRONTMATTER_UNPARSEABLE,
} = require('../gsd-core/bin/lib/frontmatter.cjs');
const { normalizeContent } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { parsePlanningDoc, readFrontmatterField, readFrontmatterFieldFromSource } = require('../gsd-core/bin/lib/planning-document.cjs');

const MD = 'roadmap.md';
const closed = (bom, eol, openEnd, closingStart, closingFenceEnd, bodyEnd) =>
  ({ bom, eol, openEnd, closed: true, closingStart, closingFenceEnd, bodyEnd });
const open = (bom, eol, openEnd, bodyEnd) =>
  ({ bom, eol, openEnd, closed: false, closingStart: -1, closingFenceEnd: -1, bodyEnd });

describe('locateFrontmatterFence', () => {
  for (const [label, text] of [
    ['empty text', ''],
    ['no fence', 'x\n---\na: 1\n---\n'],
    ['an opening fence with no line ending', '---'],
    ['an opening fence not at byte 0', ' ---\na: 1\n---\n'],
    ['an opening fence with trailing whitespace', '--- \na: 1\n---\n'],
    ['four dashes as the opener', '----\na: 1\n---\n'],
    ['two dashes as the opener', '--\na: 1\n---\n'],
  ]) {
    test(`${label} is not frontmatter`, () => {
      assert.strictEqual(locateFrontmatterFence(text), null);
    });
  }

  for (const [label, text, expected] of [
    ['an LF block', '---\na: 1\n---\nbody', closed('', '\n', 4, 9, 12, 8)],
    ['a CRLF block', '---\r\na: 1\r\n---\r\nbody', closed('', '\r\n', 5, 11, 14, 9)],
    ['a BOM block', '﻿---\na: 1\n---', closed('﻿', '\n', 5, 10, 13, 9)],
    ['a CRLF opener closed by an LF line', '---\r\na: 1\n---\n', closed('', '\r\n', 5, 10, 13, 9)],
    ['an adjacent empty LF block', '---\n---\nBody', closed('', '\n', 4, 4, 7, 4)],
    ['an adjacent empty CRLF block', '---\r\n---\r\nBody', closed('', '\r\n', 5, 5, 8, 5)],
    ['an adjacent empty block at the end of the text', '---\n---', closed('', '\n', 4, 4, 7, 4)],
    ['a block holding one blank line', '---\n\n---', closed('', '\n', 4, 5, 8, 4)],
    ['a closer at the end of the text', '---\na: 1\n---', closed('', '\n', 4, 9, 12, 8)],
    ['a closer with trailing spaces and a tab', '---\na: 1\n--- \t\nbody', closed('', '\n', 4, 9, 14, 8)],
    // Boundary on the closer's dash count: 2 (limit-1) and 4 (limit+1) are not closers.
    ['a `--` line before the real closer', '---\na: 1\n--\nb: 2\n---', closed('', '\n', 4, 17, 20, 16)],
    ['a `----` line before the real closer', '---\n----\nfoo: 1\n---\nbody', closed('', '\n', 4, 16, 19, 15)],
    ['a `--- x` line before the real closer', '---\na: 1\n--- x\n---\n', closed('', '\n', 4, 15, 18, 14)],
  ]) {
    test(`${label}`, () => {
      assert.deepStrictEqual(locateFrontmatterFence(text), expected);
    });
  }

  for (const [label, text, expected] of [
    ['an opened, never-closed LF block', '---\na: 1\n', open('', '\n', 4, 9)],
    ['a block whose only dash lines are look-alikes', '---\n----\n--- x\n', open('', '\n', 4, 15)],
    ['a `---` line ended by a lone CR at the end of the text', '---\na: 1\n---\r', open('', '\n', 4, 13)],
    ['a BOM opener with nothing after it', '﻿---\n', open('﻿', '\n', 5, 5)],
  ]) {
    test(`${label} is unterminated`, () => {
      assert.deepStrictEqual(locateFrontmatterFence(text), expected);
    });
  }

  test('a non-string is refused, not coerced', () => {
    assert.throws(() => locateFrontmatterFence(undefined), TypeError);
    assert.throws(() => locateFrontmatterFence(42), TypeError);
  });
});

// The same two documents through every consumer, spelled out: an adjacent empty block, and a
// block whose second line is a `----` look-alike (a YAML body `----\nfoo: 1`, which js-yaml
// cannot parse — so a writer refuses it, and every reader sees the same block).
describe('every fence consumer agrees on pinned documents', () => {
  test('an adjacent empty block `---\\n---\\nBody`', () => {
    const doc = '---\n---\nBody';
    assert.deepStrictEqual(frontmatterBlock(doc), { bom: '', block: '---\n---', rest: '\nBody' });
    assert.strictEqual(frontmatterRegion(doc).region, '');
    assert.deepStrictEqual(extractFrontmatter(doc), {});
    assert.strictEqual(stripFrontmatter(doc), 'Body');
    assert.strictEqual(normalizeContent(MD, doc).content, '---\n---\nBody\n');
    const parsed = parsePlanningDoc(doc, 'STATE.md');
    assert.ok(parsed.ok);
    assert.deepStrictEqual(parsed.value.nodes.find((n) => n.kind === 'frontmatter').span, { start: 0, end: 7 });
  });

  test('an adjacent empty block followed by a heading and a thematic break: only the body is normalized', () => {
    assert.strictEqual(normalizeContent(MD, '---\n---\n# a\ntext\n---\n').content, '---\n---\n# a\n\ntext\n---\n');
  });

  test('an adjacent empty CRLF block ends its span on the closing fence\'s CR, like every CRLF block', () => {
    const parsed = parsePlanningDoc('---\r\n---\r\nBody', 'STATE.md');
    assert.ok(parsed.ok);
    assert.deepStrictEqual(parsed.value.nodes.find((n) => n.kind === 'frontmatter').span, { start: 0, end: 9 });
  });

  // The span of a CRLF block ends on its closing fence line's CR, and a `---` line ended by a
  // lone CR does not close a block — so the span text is read without that CR.
  for (const [label, nl] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`a planning-document frontmatter read sees the block's keys (${label})`, () => {
      const doc = `---${nl}a: 1${nl}---${nl}body`;
      assert.deepStrictEqual(readFrontmatterFieldFromSource(doc, 'a'), { ok: true, value: '1' });
      const parsed = parsePlanningDoc(doc, 'STATE.md');
      assert.ok(parsed.ok);
      assert.deepStrictEqual(readFrontmatterField(parsed.value, 'a'), { ok: true, value: '1' });
    });
  }

  test('`---\\n----\\nfoo: 1\\n---\\nbody` is one block closed by the exact `---` line', () => {
    const doc = '---\n----\nfoo: 1\n---\nbody';
    assert.deepStrictEqual(frontmatterBlock(doc), { bom: '', block: '---\n----\nfoo: 1\n---', rest: '\nbody' });
    assert.strictEqual(frontmatterRegion(doc).region, '----\nfoo: 1');
    const fm = extractFrontmatter(doc);
    assert.deepStrictEqual(Object.keys(fm), []);
    assert.strictEqual(fm[FRONTMATTER_UNPARSEABLE], true);
    assert.strictEqual(stripFrontmatter(doc), 'body');
    assert.strictEqual(normalizeContent(MD, `${doc}\n`).content, `${doc}\n`);
    const parsed = parsePlanningDoc(doc, 'STATE.md');
    assert.ok(parsed.ok);
    assert.deepStrictEqual(parsed.value.nodes.find((n) => n.kind === 'frontmatter').span, { start: 0, end: 19 });
    assert.throws(
      () => spliceFrontmatter(doc, { foo: '2' }),
      (err) => isFrontmatterWriteRefusal(err) && err.code === 'FRONTMATTER_UNPARSEABLE',
    );
  });

  test('`--- x` does not close a block, so the reader and the normalizer both read through it', () => {
    const doc = '---\na: 1\n--- x\n# h\n---\n# Body\ntext\n';
    assert.deepStrictEqual(frontmatterBlock(doc), { bom: '', block: '---\na: 1\n--- x\n# h\n---', rest: '\n# Body\ntext\n' });
    assert.strictEqual(normalizeContent(MD, doc).content, '---\na: 1\n--- x\n# h\n---\n# Body\n\ntext\n');
    assert.strictEqual(stripFrontmatter(doc), '# Body\ntext\n');
  });
});

// stripFrontmatter is a WRITER's primitive: `state update` strips the old block and writes a new
// one, so a block preceded by whitespace must still go, or the write stacks a second block above
// it. Readers do not skip leading whitespace; this one writer-side step heals the document.
describe('stripFrontmatter heals whitespace before the opening fence', () => {
  for (const [label, doc, expected] of [
    ['a leading blank line', '\n---\na: 1\n---\n\nBody', 'Body'],
    ['leading spaces', '   ---\na: 1\n---\nBody', 'Body'],
    ['a leading CRLF', '\r\n---\r\na: 1\r\n---\r\nBody', 'Body'],
    ['leading whitespace before a BOM block', '\n﻿---\na: 1\n---\nBody', 'Body'],
    ['leading whitespace and two stacked blocks', '\n---\na: 1\n---\n---\nb: 2\n---\nBody', 'Body'],
    ['leading whitespace and no block', '\n# Body\n---\n', '\n# Body\n---\n'],
    ['leading whitespace and an unterminated block', '\n---\na: 1\n', '\n---\na: 1\n'],
    ['leading whitespace before a non-fence `----`', '\n----\na: 1\n---\nBody', '\n----\na: 1\n---\nBody'],
  ]) {
    test(label, () => {
      assert.strictEqual(stripFrontmatter(doc), expected);
    });
  }

  test('`{ once: true }` also heals, and stops after the first block', () => {
    assert.strictEqual(stripFrontmatter('\n---\na: 1\n---\n---\nb: 2\n---\nBody', { once: true }), '---\nb: 2\n---\nBody');
  });
});

// Every consumer against the one owner, for generated documents. The body alphabet mixes
// real closers, closer look-alikes, markdown lines the normalizer rewrites, and blank lines,
// under LF/CRLF and with or without a BOM, so both "closed" and "unterminated" are reached.
describe('property: every fence consumer agrees with locateFrontmatterFence', () => {
  const word = fc.stringMatching(/^[a-z]{1,6}$/);
  const line = fc.oneof(
    word.map((w) => `${w}: 1`),
    word.map((w) => `# ${w}`),
    word.map((w) => `- ${w}`),
    word.map((w) => `  ${w}`),
    word,
    fc.constantFrom('', '```', '---', '--- ', '---\t', '----', '--- x', '--', '# ---'),
  );
  const docArb = fc.tuple(fc.array(line, { maxLength: 14 }), fc.boolean(), fc.boolean(), fc.boolean())
    .map(([lines, bom, crlf, finalEol]) => {
      const nl = crlf ? '\r\n' : '\n';
      return `${bom ? '﻿' : ''}---${nl}${lines.join(nl)}${finalEol ? nl : ''}`;
    });

  // Normalizing `x\n` + text and dropping the `x\n` is normalizing `text` with no
  // frontmatter skip: `x` is inert to every normalizer rule, and the line after it keeps the
  // same predecessor-sensitive context.
  // Every whitespace character the generator can put after a closing fence.
  const WHITESPACE = [' ', '\t', '\r', '\n'];

  const normalizeUnskipped = (text) => normalizeContent(MD, `x\n${text}`).content.slice(2);

  test('frontmatterRegion/frontmatterBlock, the planning-document span, stripFrontmatter and the normalizer skip', () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const fence = locateFrontmatterFence(doc);
        assert.ok(fence, 'every generated document opens a fence');
        const region = frontmatterRegion(doc);
        const block = frontmatterBlock(doc);
        const planning = parsePlanningDoc(doc, 'STATE.md');
        const stripped = stripFrontmatter(doc, { once: true });
        const normalized = normalizeContent(MD, doc).content;
        const lf = (s) => s.replace(/\r\n/g, '\n');

        assert.strictEqual(region.terminated, fence.closed);
        if (!fence.closed) {
          assert.strictEqual(region.region, doc.slice(fence.openEnd));
          assert.strictEqual(block, null);
          assert.deepStrictEqual(planning, { ok: false, reason: 'no frontmatter terminator' });
          assert.strictEqual(stripped, doc);
          // The BOM stays on the opening fence line, exactly as the normalizer sees it.
          assert.strictEqual(normalized, normalizeUnskipped(doc));
          return;
        }
        assert.strictEqual(region.region, doc.slice(fence.openEnd, fence.bodyEnd));
        assert.deepStrictEqual(block, {
          bom: fence.bom,
          block: doc.slice(fence.bom.length, fence.closingFenceEnd),
          rest: doc.slice(fence.closingFenceEnd),
        });
        assert.ok(planning.ok);
        const crAfter = doc[fence.closingFenceEnd] === '\r' ? 1 : 0;
        assert.deepStrictEqual(
          planning.value.nodes.find((n) => n.kind === 'frontmatter').span,
          { start: fence.bom.length, end: fence.closingFenceEnd + crAfter },
        );
        // What is stripped is exactly the block plus the whitespace after its closing fence: the
        // result is a suffix of the text after the fence, the dropped prefix is drawn only from the
        // generator's whitespace alphabet, and the result does not open with one of those.
        const rest = doc.slice(fence.closingFenceEnd);
        assert.ok(rest.endsWith(stripped), 'the result is a suffix of the text after the closing fence');
        for (const ch of rest.slice(0, rest.length - stripped.length)) assert.ok(WHITESPACE.includes(ch), `dropped a non-whitespace ${JSON.stringify(ch)}`);
        assert.ok(!WHITESPACE.includes(stripped[0]), 'the result does not open with whitespace');
        // The block's lines are published as written (LF); the closing fence line and
        // everything after it are normalized exactly as an unskipped document would be.
        const beforeCloser = lf(doc.slice(fence.bom.length, fence.closingStart));
        assert.strictEqual(normalized, fence.bom + beforeCloser + normalizeUnskipped(doc.slice(fence.closingStart)));
      }),
      { seed: 5105, numRuns: 600, endOnFailure: true },
    );
  });
});
