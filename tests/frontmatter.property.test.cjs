'use strict';

/**
 * Property-based tests for frontmatter.cjs
 *
 * Module: gsd-core/bin/lib/frontmatter.cjs
 * Exported (pure): extractFrontmatter, reconstructFrontmatter, spliceFrontmatter
 *
 * Properties tested:
 *   (a) extractFrontmatter never throws on ANY string input (including binary/unicode)
 *   (b) extractFrontmatter always returns a plain object (not null, not array)
 *   (c) round-trip: reconstructFrontmatter(extractFrontmatter(spliceFrontmatter(content, obj)))
 *       preserves key-value pairs for simple flat string values
 *   (d) spliceFrontmatter never throws on any string/object combination
 *   (e) extractFrontmatter returns {} for content without a leading ---...--- block
 *   (f) prohibitions bijection (#644): over a generated must_haves.prohibitions block,
 *       parseMustHavesBlock(spliceFrontmatter(doc, parseFrontmatter(doc)), 'prohibitions')
 *       deepEquals the original parse — the new parse ↔ splice path is identity-preserving.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const yaml = require('js-yaml');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  parseFrontmatter,
  parseMustHavesBlock,
} = require('../gsd-core/bin/lib/frontmatter.cjs');

// ─── Arbitraries ─────────────────────────────────────────────────────────────

// Simple YAML key: alphanumeric + underscore, at least 1 char
const yamlKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/);

// Simple YAML scalar value: printable ASCII without : ' " # newlines
const yamlScalarValue = fc.stringMatching(/^[a-zA-Z0-9 ._/-]{1,40}$/);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('frontmatter: extractFrontmatter properties', () => {
  // (a) Never throws on any string input
  test('property: extractFrontmatter never throws on arbitrary binary/unicode input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 300 }),
          fc.constant(''),
          fc.constant('---\n---'),
          fc.constant('---\nkey: value\n---\n# body'),
          fc.string({ maxLength: 300 })
        ),
        (input) => {
          assert.doesNotThrow(
            () => extractFrontmatter(input),
            `extractFrontmatter threw on input: ${JSON.stringify(input.slice(0, 50))}`
          );
        }
      )
    );
  });

  // (b) Always returns a plain object
  test('property: extractFrontmatter always returns a plain object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 200 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 200 }),
          fc.string({ maxLength: 200 })
        ),
        (input) => {
          const result = extractFrontmatter(input);
          assert.ok(
            typeof result === 'object' && result !== null && !Array.isArray(result),
            `extractFrontmatter must return plain object, got ${JSON.stringify(result)}`
          );
        }
      )
    );
  });

  // (e) Returns {} for content without leading --- block
  test('property: content without leading --- block returns empty object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 200 }).filter((s) => !s.startsWith('---')),
          fc.constant('# Just a heading'),
          fc.constant('plain text content'),
          fc.constant('')
        ),
        (input) => {
          const result = extractFrontmatter(input);
          assert.deepEqual(
            result,
            {},
            `Expected {} for non-frontmatter input, got ${JSON.stringify(result)}`
          );
        }
      )
    );
  });
});

describe('frontmatter: reconstructFrontmatter properties', () => {
  test('property: reconstructFrontmatter never throws on plain objects with string values', () => {
    fc.assert(
      fc.property(
        fc.dictionary(yamlKey, yamlScalarValue, { maxKeys: 10 }),
        (obj) => {
          assert.doesNotThrow(
            () => reconstructFrontmatter(obj),
            `reconstructFrontmatter threw on ${JSON.stringify(obj)}`
          );
        }
      )
    );
  });

  test('property: reconstructFrontmatter output is a string', () => {
    fc.assert(
      fc.property(
        fc.dictionary(yamlKey, yamlScalarValue, { maxKeys: 8 }),
        (obj) => {
          const result = reconstructFrontmatter(obj);
          assert.ok(typeof result === 'string', `Expected string got ${typeof result}`);
        }
      )
    );
  });

  test('property: reconstructFrontmatter on {} returns empty string', () => {
    assert.equal(reconstructFrontmatter({}), '');
  });
});

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
});

// ─── (f) prohibitions bijection (#644) ────────────────────────────────────────
// Locks the new parseMustHavesBlock(…, 'prohibitions') ↔ spliceFrontmatter path that
// the prohibition probe adds. The example-based version lives in
// tests/prohibition-probe.schema.test.cjs; this generalizes it over generated blocks.

// YAML-safe scalar: starts with a letter, no colon/quote/hash/newline (so it parses as a
// plain string and is never coerced to a number by the parser's /^\d+$/ check).
const safeScalar = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,50}$/);

// One prohibition item with structurally realistic key shape per ADR-550 D7a:
//   resolved  → carries a verification tier (test|judgment)
//   dismissed → carries a non-empty reason (+ a tier)
//   unresolved→ neither
const prohibitionItem = fc.oneof(
  fc.record({ statement: safeScalar, status: fc.constant('resolved'),
    verification: fc.constantFrom('test', 'judgment') }),
  fc.record({ statement: safeScalar, status: fc.constant('dismissed'),
    verification: fc.constantFrom('test', 'judgment'), reason: safeScalar }),
  fc.record({ statement: safeScalar, status: fc.constant('unresolved') })
);

// Emit a frontmatter doc with a must_haves.prohibitions sibling block (keys in a fixed
// order: statement, status, verification?, reason?). Quoted strings carry the values.
function buildDoc(items) {
  const lines = ['---', 'phase: 01-x', 'plan: 01', 'must_haves:',
    '  truths:', '    - "User sees a daily reminder"', '  prohibitions:'];
  for (const it of items) {
    lines.push(`    - statement: "${it.statement}"`);
    lines.push(`      status: ${it.status}`);
    if (it.verification !== undefined) lines.push(`      verification: ${it.verification}`);
    if (it.reason !== undefined) lines.push(`      reason: "${it.reason}"`);
  }
  lines.push('---', '', 'Body text unchanged.', '');
  return lines.join('\n');
}

describe('frontmatter: prohibitions parse ↔ splice bijection (#644)', () => {
  test('property: generated prohibitions parse back with their statement and status', () => {
    fc.assert(
      fc.property(fc.array(prohibitionItem, { minLength: 1, maxLength: 5 }), (items) => {
        const doc = buildDoc(items);
        const parsed = parseMustHavesBlock(doc, 'prohibitions');
        assert.equal(parsed.length, items.length, 'every prohibition item must parse out');
        for (let i = 0; i < items.length; i++) {
          assert.equal(parsed[i].statement, items[i].statement, `statement[${i}] mismatch`);
          assert.equal(parsed[i].status, items[i].status, `status[${i}] mismatch`);
        }
      })
    );
  });

  test('property: parse -> splice -> re-parse is identity-preserving for prohibitions', () => {
    fc.assert(
      fc.property(fc.array(prohibitionItem, { minLength: 1, maxLength: 5 }), (items) => {
        const doc = buildDoc(items);
        const before = parseMustHavesBlock(doc, 'prohibitions');
        const parsed = parseFrontmatter(doc);
        const spliced = spliceFrontmatter(doc, parsed.frontmatter ?? parsed);
        const after = parseMustHavesBlock(spliced, 'prohibitions');
        assert.deepEqual(after, before,
          'prohibitions must survive a splice/re-parse round-trip unchanged');
      })
    );
  });
});

// #1779 — reconstructFrontmatter must emit YAML that a STRICT parser accepts and
// that preserves string values. The bijective contract is
//   ∀ s: yaml.load(reconstructFrontmatter({ k: s })).k === s
// over the documented safe-input subset. Two classes are out of scope and
// excluded here, not silently passed:
//   - lone UTF-16 surrogates (lossy through UTF-8 encoding) — filtered via
//     fc.pre(s.isWellFormed());
//   - numeric/boolean/null-looking BARE strings (e.g. "42", "true", "-5") that a
//     YAML loader resolves to a non-string type — a separate pre-existing bug
//     class (valid YAML, wrong type), so we assert equality only when the value
//     loads back AS a string. An escaping defect (invalid YAML) still fails
//     loudly because yaml.load() throws.
describe('frontmatter: reconstructFrontmatter strict-YAML property (#1779)', () => {
  test('property: every string value serializes to valid YAML and string-round-trips', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        fc.pre(s.isWellFormed());
        // Throws → reconstructFrontmatter emitted invalid YAML → property fails
        // (fast-check shrinks + prints the replay seed automatically).
        const loaded = yaml.load(reconstructFrontmatter({ k: s }));
        if (typeof loaded.k === 'string') {
          assert.equal(loaded.k, s,
            `value did not round-trip through strict YAML: ${JSON.stringify(s)}`);
        }
      })
    );
  });
});

// (g)(h) #1882 added an optional `sourcePath` argument to extractFrontmatter, used only to
//     name and deduplicate a diagnostic. These two properties are what protect the ~50 call
//     sites: whatever the argument does, it must never reach the parsed result, and the
//     LF/CRLF equivalence the parser already promised must survive the new branch.
describe('frontmatter: extractFrontmatter sourcePath is parse-inert (#1882)', () => {
  test('property: the optional path argument never changes the parsed result', (t) => {
    const original = process.stderr.write;
    t.after(() => { process.stderr.write = original; });
    process.stderr.write = () => true;
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ maxLength: 300 }),
            fc.string({ unit: 'binary', maxLength: 300 }),
          ),
          fc.stringMatching(/^\/[a-z0-9/_-]{1,40}\.md$/),
          (content, somePath) => {
            assert.deepEqual(
              extractFrontmatter(content, somePath),
              extractFrontmatter(content),
              'sourcePath must be inert with respect to the parsed value',
            );
          }
        )
      );
  });

  test('property: a document and its CRLF twin parse identically', (t) => {
    const original = process.stderr.write;
    t.after(() => { process.stderr.write = original; });
    process.stderr.write = () => true;
      fc.assert(
        fc.property(fc.string({ maxLength: 300 }), (content) => {
          const lf = content.replace(/\r\n/g, '\n');
          const crlf = lf.replace(/\n/g, '\r\n');
          assert.deepEqual(
            extractFrontmatter(crlf),
            extractFrontmatter(lf),
            'CRLF and LF spellings of one document must parse the same',
          );
        })
      );
  });
});
