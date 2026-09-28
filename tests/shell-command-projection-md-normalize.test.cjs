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
 * seam. #4725 (maintainer brief on the issue) removed the paragraph→list
 * half of the old "separate a list from a preceding paragraph" rule: the
 * pass re-normalizes whole documents, so the inserted blank reflowed
 * untouched prose — a paragraph→list transition is now preserved
 * byte-identical. Heading→list and list→prose separations are OTHER rules'
 * transitions and still happen (pinned below).
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

  test('#4725: the paragraph→list transition is preserved byte-identical (no separating blank)', () => {
    // Supersedes the pre-#4725 pin that the separation "STILL happens": the
    // inserted blank reflowed untouched prose on every full-file .md write.
    const doc = 'A lead-in paragraph.\n- first item\n';
    const { content } = normalizeContent(MD, doc);
    assert.strictEqual(
      content,
      doc,
      'a list following a paragraph stays byte-identical — no separating blank'
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

describe('#4725: write normalization must not reflow untouched prose', () => {
  // The issue's document shape: an ordinary (bold) paragraph immediately
  // followed by a tight bullet list, inside a phase section that
  // `roadmap update-plan-progress` never targets. Every full-file .md write
  // re-normalized the transition and injected a blank, converting the tight
  // list to a loose one and editing prose the command never touched.
  const issueFixture = () => [
    '### Phase 654: Stream Consumer',
    '',
    '**Scope narrowed 2026-09-14, round `663-DISPOSITION` Q7 (3/3)** (`.planning/decisions/663-disposition.md`):',
    '- The "for retry" javadoc correction moved to Phase 663',
    '- Per Q6 (3/3), crash and failed-XACK residue stay this phase\'s population',
    '',
    '**Plans:** 2 plans',
    '',
    'Plans:',
    '',
    '- [ ] 654-01-PLAN.md — (wave 1) the evidence HMAC key binds in production',
    '- [ ] 654-02-PLAN.md — (wave 2) consumer hardening',
  ].join('\n') + '\n';

  const blankCount = (s) => s.split('\n').filter((l) => l.trim() === '').length;

  test('#4725: a paragraph directly above a bullet list is preserved byte-identical (no injected blank)', () => {
    const doc = issueFixture();
    const { content } = normalizeContent(MD, doc);
    assert.ok(
      content.includes('663-disposition.md`):\n- The "for retry"'),
      'no blank may be injected between the paragraph and its tight list'
    );
    assert.strictEqual(
      blankCount(content),
      blankCount(doc),
      'blank-line count must round-trip unchanged'
    );
  });

  test('#4725: a paragraph directly above an ordered list is preserved byte-identical', () => {
    const doc = [
      'Lead-in prose line.',
      '1. first numbered item',
      '2. second numbered item',
    ].join('\n') + '\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(
      content.includes('Lead-in prose line.\n1. first numbered item'),
      'no blank may be injected between the paragraph and its tight ordered list'
    );
    assert.strictEqual(blankCount(content), blankCount(doc), 'blank-line count must round-trip unchanged');
  });

  test('#4725 negative space: --- above a list stays byte-identical', () => {
    const doc = '---\n- item\n';
    const { content } = normalizeContent(MD, doc);
    assert.strictEqual(content, doc, 'a --- above a list never triggered the rule and must still not gain a blank');
  });

  test('#4725 negative space: list→prose separation is a different transition and still happens', () => {
    // The after-a-bullet rule is NOT part of #4725; the list→prose separation
    // it provides must keep working.
    const doc = '- a\n- b\nAfter prose.\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(content.includes('- b\n\nAfter prose.'), 'list→prose keeps its separating blank');
  });

  test('#4725: normalization is idempotent on the paragraph-above-list fixture', () => {
    const doc = issueFixture();
    const once = normalizeContent(MD, doc).content;
    const twice = normalizeContent(MD, once).content;
    assert.strictEqual(once, twice, 'second pass must be a no-op');
    assert.strictEqual(once, doc, 'and the first pass must not have grown the document');
  });

  test('#4725: CRLF paragraph-above-list does not grow a blank', () => {
    const doc = 'Lead-in paragraph.\r\n- first item\r\n- second item\r\n';
    const { content } = normalizeContent(MD, doc);
    assert.ok(!content.includes('\r'), 'CRLF is normalized to LF');
    assert.ok(
      content.includes('Lead-in paragraph.\n- first item'),
      'the CRLF variant of the transition is byte-stable too (LF-form)'
    );
  });

  test('#4725 property: prose/list documents are byte-stable through the write seam', () => {
    // Alphabet: prose lines, tight bullet/ordered items, blank lines. Within
    // this domain NO other normalization rule may act, so byte-stability pins
    // exactly the #4725 seam. Deliberate exclusions, each the domain of a
    // different rule or a separately-recorded defect:
    //   - headings/fences: heading & fence blank-line rules own those
    //     transitions (rows 6-8 of the test matrix pin them singly);
    //   - list→prose adjacency: the after-a-bullet rule's domain, out of
    //     #4725's scope — the generator inserts the blank it will re-insert;
    //   - fence lines: the blank-line rules do not consult fence state
    //     (pre-existing fence-blind reflow, separate filing).
    const proseLine = fc.stringMatching(/^[A-Z][a-z]+(?: [a-z]+){0,7}[.:]?$/);
    const bulletItem = fc.tuple(
      fc.constantFrom('- ', '* ', '+ '),
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,40}$/)
    ).map(([marker, text]) => marker + text);
    const orderedItem = fc.tuple(
      fc.integer({ min: 1, max: 99 }),
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,40}$/)
    ).map(([n, text]) => `${n}. ${text}`);
    const rawLine = fc.oneof(proseLine, bulletItem, orderedItem, fc.constant(''));
    // Repair the generated line list so no rule OTHER than #4725's can fire:
    // no list→prose adjacency (blank inserted — rule 6's domain), no doubled
    // blanks (blank-run collapse), no trailing blanks (trailing-newline trim).
    const constrain = (lines) => {
      const out = [];
      let prevClass = 'blank';
      for (const line of lines) {
        const cls = line === '' ? 'blank' : /^(?:[-*+] |\d+\. )/.test(line) ? 'item' : 'prose';
        if (cls === 'prose' && prevClass === 'item') out.push('');
        if (cls === 'blank' && prevClass === 'blank') continue;
        out.push(line);
        prevClass = cls;
      }
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      return out;
    };
    const docGen = fc.array(rawLine, { minLength: 1, maxLength: 40 })
      .map((lines) => constrain(lines).join('\n') + '\n');
    fc.assert(
      fc.property(docGen, (doc) => {
        const out = normalizeContent(MD, doc).content;
        assert.strictEqual(out, doc, `byte-stability violated for:\n${JSON.stringify(doc)}`);
      }),
      { seed: 4725, numRuns: 300, endOnFailure: true }
    );
  });
});

// Found while implementing #5105: the markdown rules ran over the YAML frontmatter block
// too, so every .md write re-shaped frontmatter lines no writer touched — a blank line
// around each column-0 `# comment` (read as a heading) and after a column-0 `- item`, and
// the blank-run collapse shortened a block scalar. Inside a multi-line double-quoted scalar
// an inserted blank line changes the VALUE: `frontmatter set status` silently rewrote an
// unrelated `title`. The closed frontmatter block — located exactly as the frontmatter
// reader locates it (`frontmatterBlock`) — is published byte-identical; only the body is
// normalized.
describe('#5105: write normalization leaves the frontmatter block untouched', () => {
  const { frontmatterBlock, extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

  for (const [label, doc] of [
    ['a column-0 comment between keys', '---\na: 1\n# note\nb: 2\n---\nbody\n'],
    ['a column-0 block list followed by a key', '---\ntags:\n- a\n- b\nstatus: t\n---\nbody\n'],
    ['a column-0 `#` line inside a multi-line quoted scalar', '---\ntitle: "foo\n# bar\nbaz"\nstatus: t\n---\nbody\n'],
    ['a block scalar holding a run of blank lines', '---\nd: |\n  x\n\n\n\n  y\nstatus: t\n---\nbody\n'],
    ['a column-0 fence line inside a multi-line quoted scalar', '---\nt: "a\n```\nb"\n---\n# H\n\ntext\n'],
  ]) {
    test(`${label} is published byte-identical and reads back the same`, () => {
      const { content } = normalizeContent(MD, doc);
      assert.strictEqual(content, doc);
      assert.deepStrictEqual(extractFrontmatter(content), extractFrontmatter(doc));
    });
  }

  test('the body after the block is still normalized', () => {
    const { content } = normalizeContent(MD, '---\n# c\na: 1\n---\n# Heading\ntext\n\n\n\nmore\n');
    assert.strictEqual(content, '---\n# c\na: 1\n---\n# Heading\n\ntext\n\nmore\n');
  });

  for (const [label, shape, published] of [
    ['CRLF', (d) => d.replace(/\n/g, '\r\n'), (d) => d],
    ['BOM', (d) => `\uFEFF${d}`, (d) => `\uFEFF${d}`],
  ]) {
    test(`a ${label} document keeps its frontmatter lines (LF-published)`, () => {
      const doc = '---\na: 1\n# note\nb: 2\n---\nbody\n';
      assert.strictEqual(normalizeContent(MD, shape(doc)).content, published(doc));
    });
  }

  test('an unterminated block is not frontmatter to the reader, so it is normalized as body', () => {
    const doc = '---\na: 1\n# note\nb: 2\n';
    assert.strictEqual(frontmatterBlock(doc), null);
    assert.strictEqual(normalizeContent(MD, doc).content, '---\na: 1\n\n# note\n\nb: 2\n');
  });

  // The prior version of this property forced a real `---` closer between `fm` and `body`
  // (`${fm.join('\n')}\n---\n${body...}`), so `frontmatterBlock` was GUARANTEED non-null and
  // the check ran in one direction only: "the block this template always produces is
  // preserved". It never generated a document whose only closing-shaped line is a look-alike
  // ('----', '--- x') rather than an exact `---`, and it never exercised CRLF at all \u2014 so a
  // mutant version of `leadingFrontmatterLineCount` requiring an EXACT `\n---\n` (rejecting
  // `----`/`--- x` as closers, where the real `frontmatterRegion`/`frontmatterBlock` match any
  // line merely STARTING with `---`) would under-count the skip and still pass: the extra,
  // wrongly-unskipped lines just run through ordinary markdown rules, which is exactly the
  // divergence the `startsWith` check below is built to catch.
  test('property: every closed frontmatter block frontmatterBlock finds is published byte-identical', () => {
    const word = fc.stringMatching(/^[a-z]{1,6}$/);
    const dashLookalikes = fc.constantFrom('----', '--- x', '---');
    const fmLine = fc.oneof(
      word.map((w) => `${w}: 1`),
      word.map((w) => `# ${w}`),
      word.map((w) => `- ${w}`),
      word.map((w) => `  ${w}`),
      fc.constantFrom('', '```', '## x', '* y', '1. z'),
      dashLookalikes,
    );
    const bodyLine = fc.oneof(
      word,
      word.map((w) => `# ${w}`),
      word.map((w) => `- ${w}`),
      fc.constant(''),
      dashLookalikes,
    );
    fc.assert(
      fc.property(
        fc.array(fmLine, { maxLength: 12 }),
        fc.array(bodyLine, { maxLength: 8 }),
        fc.boolean(),
        // Whether a real `---` closer is force-appended between `fm` and `body` (the old,
        // one-directional shape) or `fm`/`body` are simply concatenated and left to close
        // (or not) on whatever dash-shaped line they happen to contain \u2014 the only way a
        // genuinely UNTERMINATED document (frontmatterBlock === null) is reachable here.
        fc.boolean(),
        fc.boolean(), // CRLF shape \u2014 `frontmatterRegion` handles CRLF natively, `_normalizeMd` LF-publishes.
        (fm, body, bom, forceCloser, crlf) => {
          const nl = crlf ? '\r\n' : '\n';
          const lines = forceCloser ? [...fm, '---', ...body] : [...fm, ...body];
          const doc = `${bom ? '\uFEFF' : ''}---${nl}${lines.join(nl)}${nl}`;
          const located = frontmatterBlock(doc);
          const { content } = normalizeContent(MD, doc);
          if (located) {
            // Non-null direction (unchanged from before, now reachable via a look-alike
            // closer and/or CRLF too): the block `frontmatterBlock` finds \u2014 LF-published,
            // as `_normalizeMd` always LF-publishes \u2014 is untouched.
            assert.ok(
              content.startsWith(located.bom + located.block.replace(/\r\n/g, '\n')),
              `frontmatter block changed:\n${JSON.stringify(doc)}\n=> ${JSON.stringify(content)}`,
            );
          } else {
            // Null direction: no line anywhere in the document starts with `---`, so the
            // opening fence is unterminated and the reader treats the WHOLE document as
            // plain body (#5105's pinned "an unterminated block..." case above pins the
            // exact expected transformation for one such document by hand \u2014 there is no
            // exported seam to independently recompute "normalize with no skip" for an
            // arbitrary generated document here, since `_normalizeMd` is not exported).
            // What this branch still guarantees is that a genuinely unterminated document
            // no longer FAILS the fixture assertion the old one-directional version made
            // (`assert.ok(located, 'fixture must hold a closed block...')`) \u2014 it is an
            // expected, asserted-reachable outcome now, not an excluded one.
            assert.ok(!lines.some((line) => line.startsWith('---')), 'a dash-prefixed line must always close the block');
          }
        },
      ),
      { seed: 5105, numRuns: 500, endOnFailure: true },
    );
  });
});
