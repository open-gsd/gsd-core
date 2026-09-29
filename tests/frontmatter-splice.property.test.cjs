'use strict';

/**
 * Property-based tests for frontmatter-splice.cjs — the frontmatter WRITER (#5105).
 *
 * Module: gsd-core/bin/lib/frontmatter-splice.cjs
 * Exported (pure): spliceFrontmatter, isFrontmatterWriteRefusal
 *
 * Moved verbatim from tests/frontmatter.property.test.cjs when the writer was split out of
 * frontmatter.cts by module ownership (#5105), so the frontmatter-splice mutation shard runs
 * them and the frontmatter (reader) shard no longer re-runs these splice-heavy properties for
 * every parser mutant. The reader (`extractFrontmatter`, `reconstructFrontmatter`) is the
 * oracle these properties read the writer's output back through.
 *
 * Properties tested:
 *   (c) round-trip: extractFrontmatter(spliceFrontmatter(content, obj)) preserves key-value
 *       pairs for simple flat string values
 *   (d) spliceFrontmatter never throws on any string/object combination, except its own
 *       documented write refusal
 *   plus per-key line preservation, key spelling, multi-line values and comments, and the
 *   parse budget (all found while implementing #5105).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const yaml = require('js-yaml');

const { spliceFrontmatter, isFrontmatterWriteRefusal } = require('../gsd-core/bin/lib/frontmatter-splice.cjs');
const { extractFrontmatter, reconstructFrontmatter, spliceSeam } = require('../gsd-core/bin/lib/frontmatter.cjs');

// ─── Arbitraries ─────────────────────────────────────────────────────────────

// Simple YAML key: alphanumeric + underscore, at least 1 char
const yamlKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/);

// Simple YAML scalar value: printable ASCII without : ' " # newlines
const yamlScalarValue = fc.stringMatching(/^[a-zA-Z0-9 ._/-]{1,40}$/);

describe('frontmatter: spliceSeam hands out immutable internals', () => {
  test('the seam bag and the shared YAML load options are frozen', () => {
    assert.equal(Object.isFrozen(spliceSeam), true);
    assert.equal(Object.isFrozen(spliceSeam.YAML_LOAD_OPTS), true);
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('frontmatter: spliceFrontmatter properties', () => {
  // (d) Never throws on any combination — except its own documented write refusal for a
  // block it may not splice (unparseable, or key lines it cannot match to parsed keys).
  test('property: spliceFrontmatter throws nothing but a write refusal on arbitrary content + object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.string({ maxLength: 200 }).map((s) => `---\n${s}\n---\nbody`),
        ),
        fc.dictionary(yamlKey, yamlScalarValue, { maxKeys: 8 }),
        (content, obj) => {
          let thrown = null;
          try { spliceFrontmatter(content, obj); } catch (err) { thrown = err; }
          assert.ok(
            thrown === null || thrown.name === 'FrontmatterWriteRefusedError',
            `spliceFrontmatter threw a non-refusal on content=${JSON.stringify(content.slice(0, 30))}: ${thrown && thrown.message}`
          );
        }
      )
    );
  });

  test('property: spliceFrontmatter always returns a string', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.dictionary(yamlKey, yamlScalarValue, { maxKeys: 5 }),
        (content, obj) => {
          const result = spliceFrontmatter(content, obj);
          assert.ok(typeof result === 'string', `Expected string got ${typeof result}`);
        }
      )
    );
  });

  // (c) Round-trip: splice then extract preserves flat string keys
  test('property: splice then extract round-trip preserves flat string values', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),  // existing document body
        // Only keys + simple values without colons/hashes that would confuse the minimal parser
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
          fc.stringMatching(/^[a-zA-Z0-9]{1,30}$/),
          { minKeys: 1, maxKeys: 5 }
        ),
        (body, obj) => {
          const spliced = spliceFrontmatter(body, obj);
          const extracted = extractFrontmatter(spliced);

          for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && value.length > 0) {
              assert.equal(
                extracted[key],
                value,
                `Round-trip failed for key=${key}: expected ${value} got ${extracted[key]}`
              );
            }
          }
        }
      )
    );
  });

  // A frontmatter write never silently drops a line it could not parse (found while
  // implementing #5105). Documents mix spaced `key: value` lines, no-space `key:value`
  // lines (which make the region unparseable YAML), full-line comments and blank lines;
  // splicing only `status` must leave every other line byte-identical and in place — or,
  // when a no-space line makes the block unparseable, refuse the write outright.
  test('property: splicing one key preserves every other line verbatim and in order, or refuses an unparseable block', () => {
    const otherKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,9}$/).filter((k) => k !== 'status');
    const scalar = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    const lineSpec = fc.oneof(
      fc.record({ kind: fc.constant('spaced'), value: scalar }),
      fc.record({ kind: fc.constant('nospace'), value: scalar }),
      fc.record({ kind: fc.constant('comment'), value: fc.stringMatching(/^[a-z ]{0,10}$/) }),
      fc.record({ kind: fc.constant('blank') }),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(otherKey, { maxLength: 6 }),
        fc.array(lineSpec, { maxLength: 10 }),
        scalar,
        fc.nat(),
        (keys, specs, statusValue, statusAt) => {
          let keyIdx = 0;
          let hasNoSpaceLine = false;
          const others = specs.map((spec) => {
            if (spec.kind === 'comment') return `# ${spec.value}`;
            if (spec.kind === 'blank') return '';
            if (keyIdx >= keys.length) return '';
            const key = keys[keyIdx++];
            if (spec.kind === 'nospace') hasNoSpaceLine = true;
            return spec.kind === 'spaced' ? `${key}: ${spec.value}` : `${key}:${spec.value}`;
          });
          const at = statusAt % (others.length + 1);
          const inner = [...others.slice(0, at), `status: ${statusValue}`, ...others.slice(at)];
          const expectedInner = [...others.slice(0, at), 'status: complete', ...others.slice(at)];
          const doc = `---\n${inner.join('\n')}\n---\nbody`;
          const write = () => spliceFrontmatter(doc, { ...extractFrontmatter(doc), status: 'complete' });

          if (hasNoSpaceLine) {
            assert.throws(write, { name: 'FrontmatterWriteRefusedError', code: 'FRONTMATTER_UNPARSEABLE' });
          } else {
            assert.equal(write(), `---\n${expectedInner.join('\n')}\n---\nbody`);
          }
        },
      ),
    );
  });

  // M1 (found while implementing #5105): segment-key detection must agree with the parser
  // for keys containing `:` and for quoted and Unicode keys. Whatever key is changed or
  // added, the output has no duplicate top-level key (js-yaml's non-json mode throws on
  // one), re-parses to exactly the intended object, and keeps the document's line ending.
  test('property: keys containing `:`, quoted and Unicode keys never duplicate and re-parse to the intended object', () => {
    const key = fc.oneof(
      fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
      fc.stringMatching(/^[a-z]{1,3}:[a-z0-9]{1,3}$/),
      fc.stringMatching(/^[a-z]{1,3}: [a-z]{1,3}$/),
      fc.constantFrom('http://x', 'naïve', 'mușt', 'x y', '#h', '- d', 'ключ', 'a"b', "a'b"),
    );
    const scalar = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    // A spelling the parser reads back as `k`: bare when bare is unambiguous, else quoted.
    const bareOk = (k) => /^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*$/u.test(k) || /^[a-z]{1,3}:[a-z0-9]{1,3}$/.test(k) || k === 'http://x';
    const spell = (k, style) => {
      if (style === 'bare' && bareOk(k)) return k;
      if (style === 'single' && !k.includes("'")) return `'${k}'`;
      return JSON.stringify(k);
    };
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(key, scalar, fc.constantFrom('bare', 'single', 'double')), { minLength: 1, maxLength: 6, selector: (t) => t[0] }),
        key,
        scalar,
        fc.boolean(),
        (entries, targetKey, newValue, crlf) => {
          const eol = crlf ? '\r\n' : '\n';
          const lines = entries.map(([k, v, style]) => `${spell(k, style)}: ${v}`);
          const doc = ['---', ...lines, '---', 'body'].join(eol);
          const intended = Object.fromEntries(entries.map(([k, v]) => [k, v]));
          assert.deepStrictEqual({ ...extractFrontmatter(doc) }, intended, 'fixture must parse to its own entries');
          intended[targetKey] = newValue;

          const out = spliceFrontmatter(doc, { ...extractFrontmatter(doc), [targetKey]: newValue });

          const block = out.slice(0, out.indexOf(`${eol}---${eol}body`));
          assert.doesNotThrow(() => yaml.load(block.slice(`---${eol}`.length), { schema: yaml.FAILSAFE_SCHEMA }), 'no duplicate top-level key');
          assert.deepStrictEqual({ ...extractFrontmatter(out) }, intended);
          if (crlf) assert.ok(!/(^|[^\r])\n/.test(out), 'no bare-LF line ending in a CRLF document');
          else assert.ok(!out.includes('\r'), 'no CR in an LF document');
        },
      ),
    );
  });

  // Found while implementing #5105: a value spanning several lines — a multi-line quoted
  // scalar or a flow collection whose continuation lines sit at column 0, or an indented
  // block scalar — belongs whole to its key. Changing or adding one key must re-parse to
  // exactly the intended object, keep every other key's lines byte-identical, and keep the
  // blank and full-line comment lines between keys in place. A full-line comment nested
  // inside the changed value stays beside the sub-key it leads when that sub-key survives;
  // when it cannot be re-attached (the value became a scalar, a comment between list items)
  // the splice refuses with FRONTMATTER_COMMENT_WOULD_BE_LOST rather than drop it.
  test('property: multi-line values, block scalars and comments survive a one-key splice', () => {
    const word = fc.stringMatching(/^[a-z]{1,6}$/);
    const words = fc.array(word, { minLength: 1, maxLength: 3 });
    const plain = (arb) => arb.map((lines) => ({ kind: 'plain', lines }));
    const valueLines = fc.oneof(
      plain(fc.tuple(word, words).map(([k, ws]) => [`KEY: "${k}`, ...ws.slice(0, -1), `${ws[ws.length - 1]}"`])),
      plain(fc.tuple(word, words).map(([k, ws]) => [`KEY: "${k}`, `# ${ws.join(' ')}"`])),
      plain(fc.tuple(word, words).map(([k, ws]) => [`KEY: '${k}`, ...ws.slice(0, -1), `${ws[ws.length - 1]}'`])),
      plain(fc.tuple(word, words).map(([k, ws]) => [`KEY: [${k},`, ...ws.slice(0, -1).map((w) => `${w},`), `${ws[ws.length - 1]}]`])),
      plain(fc.tuple(word, words).map(([k, ws]) => [`KEY: {a: ${k},`, ...ws.slice(0, -1).map((w) => `${w},`), `${ws[ws.length - 1]}}`])),
      plain(fc.tuple(fc.constantFrom('|', '>', '|-', '>-'), words).map(([ind, ws]) => [`KEY: ${ind}`, ...ws.map((w) => `  ${w}`)])),
      // A `#` line inside a block scalar is value text, never a comment to preserve.
      plain(fc.tuple(word, word).map(([c, w]) => ['KEY: |', `  # ${c}`, `  ${w}`])),
      plain(word.map((w) => [`KEY: ${w}`])),
      // A nested map whose first sub-key is led by a full-line comment.
      fc.tuple(word, word, word).map(([c, a, b]) => ({ kind: 'nested', comment: `# ${c}`, a, b, lines: ['KEY:', `  # ${c}`, `  a: ${a}`, `  b: ${b}`] })),
      // A block list with a full-line comment between its items.
      fc.tuple(word, word, word).map(([c, a, b]) => ({ kind: 'listComment', lines: ['KEY:', `  - ${a}`, `  # ${c}`, `  - ${b}`] })),
    );
    const gapLine = fc.oneof(fc.constant(''), word.map((w) => `# ${w}`));
    const gap = fc.array(gapLine, { maxLength: 2 });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/), { minLength: 1, maxLength: 5 }),
        fc.array(fc.tuple(valueLines, gap), { minLength: 5, maxLength: 5 }),
        fc.nat(),
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        fc.boolean(),
        (keys, specs, pick, newScalar, keepShape) => {
          const segments = keys.map((k, i) => ({
            key: k,
            spec: specs[i][0],
            lines: specs[i][0].lines.map((l) => l.replace('KEY', k)),
            gap: specs[i][1],
          }));
          const doc = ['---', ...segments.flatMap((s) => [...s.lines, ...s.gap]), '---', 'body'].join('\n');
          const parsed = extractFrontmatter(doc);
          assert.equal(Object.keys(parsed).length, keys.length, `fixture must parse: ${JSON.stringify(doc)}`);

          const target = pick % (keys.length + 1) === keys.length ? 'zz_new' : keys[pick % (keys.length + 1)];
          const targetSpec = segments.find((s) => s.key === target)?.spec;
          // A nested map keeping its sub-keys takes the new value on `a`; otherwise the new
          // value is a scalar replacing whatever was there.
          const keepsNested = targetSpec?.kind === 'nested' && keepShape;
          const newValue = keepsNested ? { a: newScalar, b: targetSpec.b } : newScalar;
          const intended = { ...Object.fromEntries(Object.entries(parsed)), [target]: newValue };

          if (targetSpec && (targetSpec.kind === 'listComment' || (targetSpec.kind === 'nested' && !keepsNested))) {
            assert.throws(() => spliceFrontmatter(doc, intended), (err) => err.code === 'FRONTMATTER_COMMENT_WOULD_BE_LOST');
            return;
          }

          const regenerated = keepsNested
            ? [`${target}:`, `  ${targetSpec.comment}`, ...reconstructFrontmatter(newValue).split('\n').map((l) => `  ${l}`)].join('\n')
            : reconstructFrontmatter({ [target]: newValue });
          const expectedInner = segments.flatMap((s) => (s.key === target ? [regenerated, ...s.gap] : [...s.lines, ...s.gap]));
          if (!keys.includes(target)) expectedInner.push(regenerated);

          const out = spliceFrontmatter(doc, intended);

          assert.equal(out, ['---', ...expectedInner, '---', 'body'].join('\n'));
          assert.deepStrictEqual(Object.fromEntries(Object.entries(extractFrontmatter(out))), intended);
        },
      ),
    );
  });
});

// ─── parse budget (found while implementing #5105) ──────────────────────────
// The splice decides whether a `#` or trailing blank line is value text by re-parsing the
// key's lines without it, so its work grows with (lines × such lines × line length). One call
// may parse at most SPLICE_PARSE_BUDGET_CHARS characters (each parse also counts one for its
// line break); past that it refuses with FRONTMATTER_TOO_COMPLEX instead of stalling. Outcomes
// only — never elapsed time.
//
// These cases pass `{ parseBudgetChars: BUDGET }` so the boundary is reached with a
// 100,000-character document, not a 20-million-character one: this file runs once per covering
// mutant in the frontmatter-splice Stryker shard, and the full-size cases cost seconds per run there.
// The shipped default (`SPLICE_PARSE_BUDGET_CHARS`) is pinned at full size in
// tests/frontmatter.test.cjs, which the mutation shard does not run.
describe('frontmatter: spliceFrontmatter parse budget', () => {
  const BUDGET = 100_000;
  const withBudget = { parseBudgetChars: BUDGET };
  const TOO_COMPLEX = { name: 'FrontmatterWriteRefusedError', code: 'FRONTMATTER_TOO_COMPLEX' };

  // `k: <A×n>` changed to `k: B` parses exactly twice: the old value (`k: ` + n, plus one) and
  // the regenerated one (its length, plus one) — no tail lines, no `#`.
  const regenerated = reconstructFrontmatter({ k: 'B' });
  const docParsing = (total) => `---\nk: ${'A'.repeat(total - (3 + 1) - (regenerated.length + 1))}\n---\nbody\n`;

  for (const [label, total, refused] of [
    ['limit - 1', BUDGET - 1, false],
    ['limit', BUDGET, false],
    ['limit + 1', BUDGET + 1, true],
  ]) {
    test(`a splice parsing exactly ${label} characters ${refused ? 'is refused' : 'is written'}`, () => {
      const write = () => spliceFrontmatter(docParsing(total), { k: 'B' }, withBudget);
      if (refused) assert.throws(write, TOO_COMPLEX);
      else assert.equal(write(), `---\n${regenerated}\n---\nbody\n`);
    });
  }

  test('the refusal names the allowance the call was given', () => {
    assert.throws(() => spliceFrontmatter(docParsing(BUDGET + 1), { k: 'B' }, withBudget),
      (err) => err.code === 'FRONTMATTER_TOO_COMPLEX' && err.message.includes(`more than ${BUDGET} characters`));
  });

  // Boundary on the option itself: -1 (limit - 1) is rejected, 0 (limit) and 1 (limit + 1) are
  // accepted — an allowance of 0 or 1 refuses any splice that has to parse a key's lines.
  test('parseBudgetChars below 0, fractional or not a number is a TypeError; 0 and 1 are allowances', () => {
    const doc = '---\na: 1\n---\nbody\n';
    // The option can only LOWER the shipped limit (SPLICE_PARSE_BUDGET_CHARS = 20,000,000): the
    // limit itself is accepted, limit + 1 and MAX_SAFE_INTEGER (which would disable the guard) are not.
    const SHIPPED_LIMIT = 20_000_000;
    for (const bad of [-1, 1.5, Number.NaN, '5', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, SHIPPED_LIMIT + 1]) {
      assert.throws(() => spliceFrontmatter(doc, { a: '2' }, { parseBudgetChars: bad }), TypeError, String(bad));
    }
    assert.equal(
      spliceFrontmatter('body\n', { a: '2' }, { parseBudgetChars: SHIPPED_LIMIT }),
      spliceFrontmatter('body\n', { a: '2' }),
    );
    assert.equal(
      spliceFrontmatter('body\n', { a: '2' }, { parseBudgetChars: SHIPPED_LIMIT - 1 }),
      spliceFrontmatter('body\n', { a: '2' }),
    );
    for (const allowance of [0, 1]) {
      assert.throws(() => spliceFrontmatter(doc, { a: '2' }, { parseBudgetChars: allowance }), TOO_COMPLEX, String(allowance));
    }
    // A document with no frontmatter parses nothing, so even a zero allowance writes it.
    assert.equal(spliceFrontmatter('body\n', { a: '2' }, { parseBudgetChars: 0 }), spliceFrontmatter('body\n', { a: '2' }));
  });

  const keepChomp = (blanks) => `---\na: |+\n  x\n${'\n'.repeat(blanks)}b: 1\n---\nbody\n`;
  const hashList = (lines) => `---\nl:\n${`  - "v${' #h'.repeat(20)}"\n`.repeat(lines)}---\nbody\n`;

  test('a `|+` key followed by 20000 blank lines: splicing another key is refused, not stalled', () => {
    const doc = keepChomp(20000);
    assert.throws(() => spliceFrontmatter(doc, { ...extractFrontmatter(doc), b: '2' }, withBudget), TOO_COMPLEX);
  });

  test('the same `|+` shape with 50 blank lines is written, the kept blank lines untouched', () => {
    const doc = keepChomp(50);
    assert.equal(spliceFrontmatter(doc, { ...extractFrontmatter(doc), b: '2' }, withBudget), doc.replace('b: 1', 'b: 2'));
  });

  test('a changed 800-item list holding 20 quoted ` #` per item is refused, not stalled', () => {
    const doc = hashList(800);
    assert.throws(() => spliceFrontmatter(doc, { ...extractFrontmatter(doc), l: ['a'] }, withBudget), TOO_COMPLEX);
  });

  test('the same list shape with 5 items is written', () => {
    const doc = hashList(5);
    assert.equal(spliceFrontmatter(doc, { ...extractFrontmatter(doc), l: ['a'] }, withBudget), `---\n${reconstructFrontmatter({ l: ['a'] })}\n---\nbody\n`);
  });

  // Planning-document-sized blocks full of comments, inline ` #`, quoted `#` and `|+` tails
  // never reach the budget: the refusal is reserved for pathological blocks.
  test('property: comment-heavy planning-sized blocks never reach the parse budget', () => {
    const word = fc.stringMatching(/^[a-z]{1,8}$/);
    const segment = fc.oneof(
      word.map((w) => [`KEY: ${w} # note ${w}`]),
      fc.array(word, { minLength: 1, maxLength: 12 }).map((ws) => ['KEY:', ...ws.flatMap((w) => [`  # about ${w}`, `  - "${w} #${w}" # ${w}`])]),
      fc.tuple(word, fc.nat({ max: 12 })).map(([w, n]) => ['KEY: |+', `  ${w} # kept`, ...Array(n).fill('')]),
      fc.array(word, { minLength: 1, maxLength: 12 }).map((ws) => ['KEY:', ...ws.map((w) => `  ${w}: "${w} # ${w}" # c`)]),
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/), { minLength: 1, maxLength: 12 }),
        fc.array(fc.tuple(segment, fc.array(fc.constantFrom('', '# gap'), { maxLength: 3 })), { minLength: 12, maxLength: 12 }),
        fc.nat(),
        (keys, specs, pick) => {
          const doc = ['---', ...keys.flatMap((k, i) => [...specs[i][0].map((l) => l.replace('KEY', k)), ...specs[i][1]]), '---', 'body'].join('\n');
          const target = keys[pick % keys.length];
          try {
            spliceFrontmatter(doc, { ...extractFrontmatter(doc), [target]: 'changed' });
          } catch (err) {
            if (!isFrontmatterWriteRefusal(err)) throw err;
            assert.notEqual(err.code, 'FRONTMATTER_TOO_COMPLEX', `a planning-sized block reached the parse budget: ${JSON.stringify(doc)}`);
          }
        },
      ),
    );
  });
});
