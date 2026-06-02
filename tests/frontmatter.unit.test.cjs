'use strict';

/**
 * Unit tests for frontmatter.cjs
 *
 * Module: get-shit-done/bin/lib/frontmatter.cjs
 *
 * Covers:
 *   - extractFrontmatter: all scalar types, quoted, arrays, nested, edge cases
 *   - reconstructFrontmatter: exact output for every branch
 *   - spliceFrontmatter: with/without existing frontmatter
 *   - parseMustHavesBlock: all branches
 *   - FRONTMATTER_SCHEMAS: exact keys
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  parseMustHavesBlock,
  FRONTMATTER_SCHEMAS,
} = require('../get-shit-done/bin/lib/frontmatter.cjs');

// ─── extractFrontmatter ───────────────────────────────────────────────────────

describe('extractFrontmatter: no frontmatter', () => {
  test('plain text returns {}', () => {
    assert.deepEqual(extractFrontmatter('just plain text'), {});
  });

  test('empty string returns {}', () => {
    assert.deepEqual(extractFrontmatter(''), {});
  });

  test('--- not at start returns {}', () => {
    assert.deepEqual(extractFrontmatter('content\n---\nkey: val\n---\n'), {});
  });

  test('--- block without closing delimiter returns {}', () => {
    assert.deepEqual(extractFrontmatter('---\ntitle: Hello\nauthor: World\n'), {});
  });

  test('only --- returns {}', () => {
    assert.deepEqual(extractFrontmatter('---\n---'), {});
  });

  test('empty frontmatter block returns {}', () => {
    assert.deepEqual(extractFrontmatter('---\n\n---\nBody'), {});
  });

  test('heading only returns {}', () => {
    assert.deepEqual(extractFrontmatter('# Just a heading\ncontent'), {});
  });
});

describe('extractFrontmatter: simple scalar values', () => {
  test('single string key-value', () => {
    const result = extractFrontmatter('---\ntitle: Hello\n---\nBody');
    assert.deepEqual(result, { title: 'Hello' });
  });

  test('multiple string key-values', () => {
    const result = extractFrontmatter('---\ntitle: Hello\nauthor: World\n---\n');
    assert.deepEqual(result, { title: 'Hello', author: 'World' });
  });

  test('numeric string value preserved as string', () => {
    const result = extractFrontmatter('---\ncount: 42\n---');
    assert.deepEqual(result, { count: '42' });
    assert.equal(result.count, '42');
  });

  test('boolean string value preserved as string', () => {
    const result = extractFrontmatter('---\nflag: true\n---');
    assert.deepEqual(result, { flag: 'true' });
    assert.equal(result.flag, 'true');
  });

  test('null string value preserved as string', () => {
    const result = extractFrontmatter('---\nnone: null\n---');
    assert.deepEqual(result, { none: 'null' });
    assert.equal(result.none, 'null');
  });

  test('false string value preserved as string', () => {
    const result = extractFrontmatter('---\ndone: false\n---');
    assert.deepEqual(result, { done: 'false' });
  });

  test('value with internal spaces preserved', () => {
    const result = extractFrontmatter('---\nphase: phase one\n---');
    assert.deepEqual(result, { phase: 'phase one' });
  });

  test('trailing whitespace in value is trimmed', () => {
    const result = extractFrontmatter('---\ntitle: Hello   \n---');
    assert.deepEqual(result, { title: 'Hello' });
  });

  test('key with underscore', () => {
    const result = extractFrontmatter('---\nmy_key: val\n---');
    assert.deepEqual(result, { my_key: 'val' });
  });

  test('key with hyphen', () => {
    const result = extractFrontmatter('---\nmy-key: val\n---');
    assert.deepEqual(result, { 'my-key': 'val' });
  });

  test('key with digits', () => {
    const result = extractFrontmatter('---\nkey123: val\n---');
    assert.deepEqual(result, { key123: 'val' });
  });

  test('empty line in frontmatter is skipped', () => {
    const result = extractFrontmatter('---\nkey1: val1\n\nkey2: val2\n---');
    assert.deepEqual(result, { key1: 'val1', key2: 'val2' });
  });

  test('body content after closing delimiter is ignored', () => {
    const result = extractFrontmatter('---\ntitle: Hello\n---\n# Heading\nContent here');
    assert.deepEqual(result, { title: 'Hello' });
    assert.equal(Object.keys(result).length, 1);
  });
});

describe('extractFrontmatter: quoted values', () => {
  test('double-quoted value strips quotes', () => {
    const result = extractFrontmatter('---\ntitle: "Hello World"\n---');
    assert.deepEqual(result, { title: 'Hello World' });
  });

  test('single-quoted value strips quotes', () => {
    const result = extractFrontmatter("---\ntitle: 'Hello World'\n---");
    assert.deepEqual(result, { title: 'Hello World' });
  });

  test('double-quoted value containing colon', () => {
    const result = extractFrontmatter('---\nurl: "http://example.com"\n---');
    assert.deepEqual(result, { url: 'http://example.com' });
  });

  test('unquoted value with no special chars', () => {
    const result = extractFrontmatter('---\nname: simple\n---');
    assert.deepEqual(result, { name: 'simple' });
    assert.equal(result.name, 'simple');
  });
});

describe('extractFrontmatter: CRLF line endings', () => {
  test('CRLF frontmatter parses correctly', () => {
    const result = extractFrontmatter('---\r\ntitle: Hello\r\nauthor: World\r\n---\r\nBody');
    assert.deepEqual(result, { title: 'Hello', author: 'World' });
  });

  test('CRLF with array values', () => {
    const result = extractFrontmatter('---\r\ntags: [a, b, c]\r\n---\r\n');
    assert.deepEqual(result, { tags: ['a', 'b', 'c'] });
  });
});

describe('extractFrontmatter: inline arrays', () => {
  test('empty inline array []', () => {
    const result = extractFrontmatter('---\ntags: []\n---');
    assert.deepEqual(result, { tags: [] });
    assert.ok(Array.isArray(result.tags));
    assert.equal(result.tags.length, 0);
  });

  test('single item inline array', () => {
    const result = extractFrontmatter('---\ntags: [only]\n---');
    assert.deepEqual(result, { tags: ['only'] });
    assert.equal(result.tags.length, 1);
  });

  test('two item inline array', () => {
    const result = extractFrontmatter('---\ntags: [a, b]\n---');
    assert.deepEqual(result, { tags: ['a', 'b'] });
  });

  test('three item inline array', () => {
    const result = extractFrontmatter('---\ntags: [a, b, c]\n---');
    assert.deepEqual(result, { tags: ['a', 'b', 'c'] });
  });

  test('inline array with spaces around items', () => {
    const result = extractFrontmatter('---\ntags: [ a , b , c ]\n---');
    assert.deepEqual(result, { tags: ['a', 'b', 'c'] });
  });

  test('inline array with double-quoted item containing comma', () => {
    const result = extractFrontmatter('---\ntags: ["a, b", c]\n---');
    assert.deepEqual(result, { tags: ['a, b', 'c'] });
  });

  test('inline array with single-quoted item containing comma', () => {
    const result = extractFrontmatter("---\ntags: ['a, b', c]\n---");
    assert.deepEqual(result, { tags: ['a, b', 'c'] });
  });

  test('inline array with quoted item plus more items', () => {
    const result = extractFrontmatter('---\ntags: ["a, b", c, d]\n---');
    assert.deepEqual(result, { tags: ['a, b', 'c', 'd'] });
  });

  test('consecutive commas (empty items filtered)', () => {
    const result = extractFrontmatter('---\ntags: [a,,b]\n---');
    assert.deepEqual(result, { tags: ['a', 'b'] });
  });

  test('whitespace-only items filtered', () => {
    const result = extractFrontmatter('---\ntags: [ , ]\n---');
    assert.deepEqual(result, { tags: [] });
  });

  test('opening bracket only becomes empty array/object', () => {
    const result = extractFrontmatter('---\ntags: [\n---');
    assert.deepEqual(result, { tags: [] });
    assert.ok(Array.isArray(result.tags));
  });
});

describe('extractFrontmatter: dashed list arrays', () => {
  test('two-item dashed list', () => {
    const result = extractFrontmatter('---\ntags:\n  - a\n  - b\n---');
    assert.deepEqual(result, { tags: ['a', 'b'] });
    assert.ok(Array.isArray(result.tags));
  });

  test('single-item dashed list', () => {
    const result = extractFrontmatter('---\ntags:\n  - solo\n---');
    assert.deepEqual(result, { tags: ['solo'] });
  });

  test('dashed list with double-quoted item', () => {
    const result = extractFrontmatter('---\ntags:\n  - "quoted value"\n---');
    assert.deepEqual(result, { tags: ['quoted value'] });
  });

  test('dashed list with single-quoted item', () => {
    const result = extractFrontmatter("---\ntags:\n  - 'single quoted'\n---");
    assert.deepEqual(result, { tags: ['single quoted'] });
  });

  test('opening bracket followed by dashed list', () => {
    const result = extractFrontmatter('---\ntags: [\n  - a\n  - b\n---');
    assert.deepEqual(result, { tags: ['a', 'b'] });
  });
});

describe('extractFrontmatter: empty / missing values', () => {
  test('empty value becomes empty object {}', () => {
    const result = extractFrontmatter('---\ntitle:\n---');
    assert.deepEqual(result, { title: {} });
    assert.equal(typeof result.title, 'object');
    assert.ok(!Array.isArray(result.title));
  });

  test('empty value followed by next key', () => {
    const result = extractFrontmatter('---\ntitle:\nother: val\n---');
    assert.equal(typeof result.title, 'object');
    assert.equal(result.other, 'val');
  });
});

describe('extractFrontmatter: nested objects', () => {
  test('one level of nesting', () => {
    const result = extractFrontmatter('---\nmeta:\n  key: val\n  count: 10\n---');
    assert.deepEqual(result, { meta: { key: 'val', count: '10' } });
  });

  test('nested then back to top level', () => {
    const result = extractFrontmatter('---\nmeta:\n  sub: val\ntop: parent\n---');
    assert.deepEqual(result, { meta: { sub: 'val' }, top: 'parent' });
  });

  test('multiple nested objects', () => {
    const result = extractFrontmatter('---\na:\n  k1: v1\nb:\n  k2: v2\n---');
    assert.deepEqual(result, { a: { k1: 'v1' }, b: { k2: 'v2' } });
  });

  test('two levels of nesting', () => {
    const result = extractFrontmatter('---\ntop:\n  mid:\n    deep: value\n---');
    assert.deepEqual(result, { top: { mid: { deep: 'value' } } });
  });

  test('nested numeric-string value', () => {
    const result = extractFrontmatter('---\nmeta:\n  count: 42\n---');
    assert.deepEqual(result, { meta: { count: '42' } });
  });
});

describe('extractFrontmatter: return type invariants', () => {
  test('always returns plain object', () => {
    const result = extractFrontmatter('random content');
    assert.equal(typeof result, 'object');
    assert.ok(result !== null);
    assert.ok(!Array.isArray(result));
  });

  test('return value is not null', () => {
    const result = extractFrontmatter('');
    assert.ok(result !== null);
  });

  test('top-level dash item (no parent key) is ignored', () => {
    const result = extractFrontmatter('---\n- item\n---');
    assert.deepEqual(result, {});
  });

  test('key starting with digit still matches key pattern', () => {
    const result = extractFrontmatter('---\n123key: val\n---');
    assert.equal(result['123key'], 'val');
  });
});

// ─── reconstructFrontmatter ───────────────────────────────────────────────────

describe('reconstructFrontmatter: empty input', () => {
  test('empty object returns empty string', () => {
    assert.equal(reconstructFrontmatter({}), '');
  });
});

describe('reconstructFrontmatter: scalar values', () => {
  test('simple string value', () => {
    assert.equal(reconstructFrontmatter({ title: 'Hello' }), 'title: Hello');
  });

  test('numeric string value', () => {
    assert.equal(reconstructFrontmatter({ count: '42' }), 'count: 42');
  });

  test('boolean string value', () => {
    assert.equal(reconstructFrontmatter({ flag: 'true' }), 'flag: true');
  });

  test('null value is skipped', () => {
    assert.equal(reconstructFrontmatter({ title: null }), '');
  });

  test('undefined value is skipped', () => {
    assert.equal(reconstructFrontmatter({ title: undefined }), '');
  });

  test('value containing colon is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ url: 'http://example.com' }), 'url: "http://example.com"');
  });

  test('value containing hash is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ name: 'test#1' }), 'name: "test#1"');
  });

  test('value starting with [ is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ val: '[thing]' }), 'val: "[thing]"');
  });

  test('value starting with { is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ val: '{thing}' }), 'val: "{thing}"');
  });

  test('plain value without special chars is unquoted', () => {
    assert.equal(reconstructFrontmatter({ name: 'simple' }), 'name: simple');
  });

  test('multiple keys produce newline-joined output', () => {
    assert.equal(
      reconstructFrontmatter({ title: 'Hello', author: 'World' }),
      'title: Hello\nauthor: World'
    );
  });
});

describe('reconstructFrontmatter: arrays', () => {
  test('empty array produces key: []', () => {
    assert.equal(reconstructFrontmatter({ tags: [] }), 'tags: []');
  });

  test('two-item short array uses inline format', () => {
    assert.equal(reconstructFrontmatter({ tags: ['a', 'b'] }), 'tags: [a, b]');
  });

  test('three-item short array uses inline format', () => {
    assert.equal(reconstructFrontmatter({ tags: ['a', 'b', 'c'] }), 'tags: [a, b, c]');
  });

  test('three items whose join is exactly < 60 chars uses inline format', () => {
    const tags = ['aaa', 'bbb', 'ccc'];
    // 'aaa, bbb, ccc' = 13 chars
    assert.equal(reconstructFrontmatter({ tags }), 'tags: [aaa, bbb, ccc]');
  });

  test('three items whose join >= 60 chars uses block format', () => {
    const tags = ['aaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc'];
    // join is 61+ chars
    assert.equal(
      reconstructFrontmatter({ tags }),
      'tags:\n  - aaaaaaaaaaaaaaaaaaa\n  - bbbbbbbbbbbbbbbbbbb\n  - cccccccccccccccccccc'
    );
  });

  test('four-item array uses block format', () => {
    assert.equal(
      reconstructFrontmatter({ tags: ['a', 'b', 'c', 'd'] }),
      'tags:\n  - a\n  - b\n  - c\n  - d'
    );
  });

  test('array item with colon is double-quoted in block format', () => {
    // Need >3 items to force block format where quoting applies
    const result = reconstructFrontmatter({ tags: ['a:b', 'c', 'd', 'e'] });
    assert.ok(result.includes('  - "a:b"'), `Expected quoted item, got: ${result}`);
  });

  test('array item with hash is double-quoted in block format', () => {
    // Need >3 items to force block format where quoting applies
    const result = reconstructFrontmatter({ tags: ['a#b', 'c', 'd', 'e'] });
    assert.ok(result.includes('  - "a#b"'), `Expected quoted hash item, got: ${result}`);
  });

  test('two-item array uses inline regardless of special chars', () => {
    // Note: inline format for <=3 items uses join without quoting
    assert.equal(reconstructFrontmatter({ tags: ['a:b', 'c'] }), 'tags: [a:b, c]');
  });

  test('array item without colon or hash is unquoted in block format', () => {
    const result = reconstructFrontmatter({ tags: ['plain', 'also', 'here', 'fourth'] });
    assert.equal(result, 'tags:\n  - plain\n  - also\n  - here\n  - fourth');
  });
});

describe('reconstructFrontmatter: nested objects', () => {
  test('simple nested object', () => {
    assert.equal(
      reconstructFrontmatter({ meta: { key: 'val', num: '42' } }),
      'meta:\n  key: val\n  num: 42'
    );
  });

  test('nested null subvalue is skipped', () => {
    assert.equal(reconstructFrontmatter({ meta: { key: null } }), 'meta:');
  });

  test('nested undefined subvalue is skipped', () => {
    assert.equal(reconstructFrontmatter({ meta: { key: undefined } }), 'meta:');
  });

  test('nested subvalue with colon is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ meta: { url: 'http://x' } }), 'meta:\n  url: "http://x"');
  });

  test('nested subvalue with hash is double-quoted', () => {
    assert.equal(reconstructFrontmatter({ meta: { name: 'x#y' } }), 'meta:\n  name: "x#y"');
  });

  test('nested empty sub-array', () => {
    assert.equal(reconstructFrontmatter({ meta: { items: [] } }), 'meta:\n  items: []');
  });

  test('nested two-item short sub-array uses inline format', () => {
    assert.equal(reconstructFrontmatter({ meta: { items: ['a', 'b'] } }), 'meta:\n  items: [a, b]');
  });

  test('nested four-item sub-array uses block format', () => {
    assert.equal(
      reconstructFrontmatter({ meta: { items: ['a', 'b', 'c', 'd'] } }),
      'meta:\n  items:\n    - a\n    - b\n    - c\n    - d'
    );
  });

  test('nested three-item short sub-array uses inline', () => {
    assert.equal(
      reconstructFrontmatter({ meta: { items: ['a', 'b', 'c'] } }),
      'meta:\n  items: [a, b, c]'
    );
  });

  test('nested three-item long sub-array uses block', () => {
    const items = ['aaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc'];
    assert.equal(
      reconstructFrontmatter({ meta: { items } }),
      'meta:\n  items:\n    - aaaaaaaaaaaaaaaaaaa\n    - bbbbbbbbbbbbbbbbbbb\n    - cccccccccccccccccccc'
    );
  });

  test('nested nested object (3 levels)', () => {
    assert.equal(
      reconstructFrontmatter({ top: { mid: { deep: 'value' } } }),
      'top:\n  mid:\n    deep: value'
    );
  });

  test('deeply nested null subvalue skipped', () => {
    assert.equal(
      reconstructFrontmatter({ top: { mid: { key: null } } }),
      'top:\n  mid:'
    );
  });

  test('deeply nested empty array', () => {
    assert.equal(
      reconstructFrontmatter({ top: { mid: { items: [] } } }),
      'top:\n  mid:\n    items: []'
    );
  });

  test('deeply nested array with items', () => {
    assert.equal(
      reconstructFrontmatter({ top: { mid: { items: ['a', 'b'] } } }),
      'top:\n  mid:\n    items:\n      - a\n      - b'
    );
  });
});

// ─── spliceFrontmatter ────────────────────────────────────────────────────────

describe('spliceFrontmatter: no existing frontmatter', () => {
  test('prepends frontmatter to plain body', () => {
    assert.equal(
      spliceFrontmatter('body text', { title: 'Test' }),
      '---\ntitle: Test\n---\n\nbody text'
    );
  });

  test('prepends frontmatter to empty string', () => {
    assert.equal(
      spliceFrontmatter('', { title: 'Test' }),
      '---\ntitle: Test\n---\n\n'
    );
  });

  test('prepends frontmatter with empty object', () => {
    assert.equal(
      spliceFrontmatter('body text', {}),
      '---\n\n---\n\nbody text'
    );
  });

  test('prepends multi-key frontmatter', () => {
    const result = spliceFrontmatter('# Body', { title: 'T', author: 'A' });
    assert.equal(result, '---\ntitle: T\nauthor: A\n---\n\n# Body');
  });
});

describe('spliceFrontmatter: existing frontmatter', () => {
  test('replaces existing frontmatter, preserves body', () => {
    const input = '---\ntitle: Old\n---\n\nBody here';
    assert.equal(
      spliceFrontmatter(input, { title: 'New' }),
      '---\ntitle: New\n---\n\nBody here'
    );
  });

  test('replaces existing multi-key frontmatter', () => {
    const input = '---\ntitle: Old\ncount: 5\n---\n\nBody text here';
    assert.equal(
      spliceFrontmatter(input, { title: 'New', count: '5' }),
      '---\ntitle: New\ncount: 5\n---\n\nBody text here'
    );
  });

  test('CRLF existing frontmatter: body CRLF preserved', () => {
    const input = '---\r\ntitle: Old\r\n---\r\nBody';
    const result = spliceFrontmatter(input, { title: 'New' });
    assert.equal(result, '---\ntitle: New\n---\r\nBody');
  });

  test('new frontmatter uses LF even if original was CRLF', () => {
    const input = '---\r\ntitle: Old\r\n---\r\nBody';
    const result = spliceFrontmatter(input, { title: 'New' });
    assert.ok(result.startsWith('---\ntitle: New\n---'));
  });

  test('return type is always string', () => {
    const result = spliceFrontmatter('hello', { k: 'v' });
    assert.equal(typeof result, 'string');
  });
});

// ─── parseMustHavesBlock ──────────────────────────────────────────────────────

describe('parseMustHavesBlock: no frontmatter / no block', () => {
  test('no frontmatter returns []', () => {
    assert.deepEqual(parseMustHavesBlock('just content', 'artifacts'), []);
  });

  test('empty string returns []', () => {
    assert.deepEqual(parseMustHavesBlock('', 'artifacts'), []);
  });

  test('frontmatter without must_haves returns []', () => {
    const doc = '---\ntitle: Hello\n---\nbody';
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), []);
  });

  test('must_haves present but requested block absent returns []', () => {
    const doc = '---\nmust_haves:\n  other:\n    - val\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), []);
  });

  test('block at same indent as must_haves is rejected', () => {
    const doc = '---\nmust_haves:\nartifacts:\n  - val\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), []);
  });
});

describe('parseMustHavesBlock: string items', () => {
  test('two plain string items', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - simple string\n    - another string\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['simple string', 'another string']);
  });

  test('single string item', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - only one\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['only one']);
  });

  test('double-quoted string items strip quotes', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - "contains: colon"\n    - "another: one"\n---';
    const result = parseMustHavesBlock(doc, 'truths');
    assert.deepEqual(result, ['contains: colon', 'another: one']);
  });

  test('single-quoted string items strip quotes', () => {
    const doc = "---\nmust_haves:\n  truths:\n    - 'single quoted'\n---";
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['single quoted']);
  });

  test('item without colon treated as plain string', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - plain text here\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['plain text here']);
  });

  test('item with colon but no space (Class::Method) is plain string', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - Class::Method is used\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['Class::Method is used']);
  });

  test('item with db:seed (no space after colon) is plain string', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - db:seed task should run\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'truths'), ['db:seed task should run']);
  });
});

describe('parseMustHavesBlock: key-value object items', () => {
  test('simple kv item on dash line', () => {
    const doc = '---\nmust_haves:\n  artifacts:\n    - path: file.ts\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), [{ path: 'file.ts' }]);
  });

  test('two kv items', () => {
    const doc = '---\nmust_haves:\n  artifacts:\n    - path: file.ts\n    - path: other.ts\n---';
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), [{ path: 'file.ts' }, { path: 'other.ts' }]);
  });

  test('kv item with continuation keys', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      provides: something',
      '---',
    ].join('\n');
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), [{ path: 'file.ts', provides: 'something' }]);
  });

  test('kv item with multiple continuation keys', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      provides: exports X',
      '      confidence: 90',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { path: 'file.ts', provides: 'exports X', confidence: 90 });
  });

  test('numeric value in continuation key is parsed as integer', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      line: 42',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.equal(result[0].line, 42);
    assert.equal(typeof result[0].line, 'number');
  });

  test('non-numeric continuation value stays string', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      provides: some text',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.equal(typeof result[0].provides, 'string');
    assert.equal(result[0].provides, 'some text');
  });

  test('two full kv items with continuations', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      provides: something',
      '    - path: other.ts',
      '      provides: other',
      '---',
    ].join('\n');
    assert.deepEqual(parseMustHavesBlock(doc, 'artifacts'), [
      { path: 'file.ts', provides: 'something' },
      { path: 'other.ts', provides: 'other' },
    ]);
  });
});

describe('parseMustHavesBlock: nested arrays in items', () => {
  test('item with array continuation', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      tags:',
      '        - tag1',
      '        - tag2',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].tags, ['tag1', 'tag2']);
  });

  test('item with three array elements in continuation', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      tags:',
      '        - tag1',
      '        - tag2',
      '        - tag3',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.deepEqual(result[0].tags, ['tag1', 'tag2', 'tag3']);
  });

  test('two items where first has array continuation', () => {
    const doc = [
      '---',
      'must_haves:',
      '  artifacts:',
      '    - path: file.ts',
      '      tags:',
      '        - tag1',
      '    - path: other.ts',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'artifacts');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0].tags, ['tag1']);
    assert.equal(result[1].path, 'other.ts');
  });
});

describe('parseMustHavesBlock: return type', () => {
  test('always returns an array', () => {
    const result = parseMustHavesBlock('no content', 'anything');
    assert.ok(Array.isArray(result));
  });

  test('empty content returns array', () => {
    const result = parseMustHavesBlock('', 'anything');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});

// ─── FRONTMATTER_SCHEMAS ──────────────────────────────────────────────────────

describe('FRONTMATTER_SCHEMAS', () => {
  test('plan schema has required field', () => {
    assert.ok('required' in FRONTMATTER_SCHEMAS.plan);
  });

  test('plan schema has exactly 8 required fields', () => {
    assert.equal(FRONTMATTER_SCHEMAS.plan.required.length, 8);
  });

  test('plan schema required fields are exact', () => {
    assert.deepEqual(FRONTMATTER_SCHEMAS.plan.required, [
      'phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves',
    ]);
  });

  test('summary schema has exactly 6 required fields', () => {
    assert.equal(FRONTMATTER_SCHEMAS.summary.required.length, 6);
  });

  test('summary schema required fields are exact', () => {
    assert.deepEqual(FRONTMATTER_SCHEMAS.summary.required, [
      'phase', 'plan', 'subsystem', 'tags', 'duration', 'completed',
    ]);
  });

  test('verification schema has exactly 4 required fields', () => {
    assert.equal(FRONTMATTER_SCHEMAS.verification.required.length, 4);
  });

  test('verification schema required fields are exact', () => {
    assert.deepEqual(FRONTMATTER_SCHEMAS.verification.required, [
      'phase', 'verified', 'status', 'score',
    ]);
  });

  test('three schemas exist: plan, summary, verification', () => {
    assert.deepEqual(Object.keys(FRONTMATTER_SCHEMAS).sort(), ['plan', 'summary', 'verification']);
  });

  test('plan includes phase field', () => {
    assert.ok(FRONTMATTER_SCHEMAS.plan.required.includes('phase'));
  });

  test('plan includes must_haves field', () => {
    assert.ok(FRONTMATTER_SCHEMAS.plan.required.includes('must_haves'));
  });

  test('summary includes completed field', () => {
    assert.ok(FRONTMATTER_SCHEMAS.summary.required.includes('completed'));
  });

  test('verification includes score field', () => {
    assert.ok(FRONTMATTER_SCHEMAS.verification.required.includes('score'));
  });

  test('plan does not include score field', () => {
    assert.ok(!FRONTMATTER_SCHEMAS.plan.required.includes('score'));
  });

  test('verification does not include completed field', () => {
    assert.ok(!FRONTMATTER_SCHEMAS.verification.required.includes('completed'));
  });
});

// ─── Tight branch / boundary tests ───────────────────────────────────────────

describe('reconstructFrontmatter: array length boundary (<=3 vs >3)', () => {
  test('exactly 3 items: uses inline format', () => {
    const result = reconstructFrontmatter({ x: ['a', 'b', 'c'] });
    assert.equal(result, 'x: [a, b, c]');
    assert.ok(!result.includes('\n  - '));
  });

  test('exactly 4 items: uses block format', () => {
    const result = reconstructFrontmatter({ x: ['a', 'b', 'c', 'd'] });
    assert.ok(result.includes('  - a'));
    assert.ok(result.includes('  - b'));
    assert.ok(result.includes('  - c'));
    assert.ok(result.includes('  - d'));
  });

  test('exactly 1 item: uses inline format', () => {
    const result = reconstructFrontmatter({ x: ['only'] });
    assert.equal(result, 'x: [only]');
  });
});

describe('reconstructFrontmatter: array join length boundary (< 60)', () => {
  test('3 items joining to exactly 59 chars uses inline', () => {
    // 59 chars: 'aaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbb, ccccccccccccccccccc' = 60 chars, need 59
    const a = 'aaaaaaaaaaaaaaaaaa'; // 18
    const b = 'bbbbbbbbbbbbbbbbbb'; // 18
    const c = 'ccccccccccccccccccc'; // 19 => join = 18+18+19 + 4 (', ', ', ') = 18+2+18+2+19 = 59
    const joined = [a, b, c].join(', ');
    assert.equal(joined.length, 59);
    const result = reconstructFrontmatter({ x: [a, b, c] });
    assert.equal(result, `x: [${joined}]`);
  });

  test('3 items joining to exactly 60 chars uses block', () => {
    // 'x' repeated: 19, 19, 18 = 56 + 4 = 60
    const x = 'aaaaaaaaaaaaaaaaaaa'; // 19
    const y = 'bbbbbbbbbbbbbbbbbbb'; // 19
    const z = 'cccccccccccccccccc'; // 18 => 19+2+19+2+18 = 60
    const joined2 = [x, y, z].join(', ');
    assert.equal(joined2.length, 60);
    const result2 = reconstructFrontmatter({ x: [x, y, z] });
    // 60 is NOT < 60, so should use block format
    assert.ok(result2.startsWith('x:\n  - '), `Expected block format, got: ${result2}`);
  });
});

describe('reconstructFrontmatter: subarray length boundary', () => {
  test('nested 3 items short uses inline', () => {
    const result = reconstructFrontmatter({ meta: { x: ['a', 'b', 'c'] } });
    assert.equal(result, 'meta:\n  x: [a, b, c]');
  });

  test('nested 4 items uses block', () => {
    const result = reconstructFrontmatter({ meta: { x: ['a', 'b', 'c', 'd'] } });
    assert.equal(result, 'meta:\n  x:\n    - a\n    - b\n    - c\n    - d');
  });
});

describe('spliceFrontmatter: exact delimiter handling', () => {
  test('output always starts with ---', () => {
    const result = spliceFrontmatter('', { k: 'v' });
    assert.ok(result.startsWith('---\n'));
  });

  test('existing frontmatter: output uses LF delimiters', () => {
    const input = '---\ntitle: Old\n---\nbody';
    const result = spliceFrontmatter(input, { title: 'New' });
    assert.ok(result.startsWith('---\ntitle: New\n---'));
  });

  test('no existing frontmatter: body follows after double newline', () => {
    const result = spliceFrontmatter('body', { title: 'T' });
    assert.equal(result, '---\ntitle: T\n---\n\nbody');
  });

  test('existing frontmatter: body immediately follows closing ---', () => {
    const input = '---\ntitle: T\n---\nbody line';
    const result = spliceFrontmatter(input, { k: 'v' });
    assert.equal(result, '---\nk: v\n---\nbody line');
  });
});

describe('extractFrontmatter: complex real-world documents', () => {
  test('plan document', () => {
    const doc = [
      '---',
      'phase: 1',
      'plan: my-plan',
      'type: feature',
      'wave: 1',
      'depends_on: []',
      'files_modified: []',
      'autonomous: true',
      'must_haves:',
      '  artifacts:',
      '    - path: src/foo.ts',
      '      provides: foo',
      '---',
      '# Plan body',
    ].join('\n');
    const result = extractFrontmatter(doc);
    assert.equal(result.phase, '1');
    assert.equal(result.plan, 'my-plan');
    assert.equal(result.type, 'feature');
    assert.equal(result.wave, '1');
    assert.ok(Array.isArray(result.depends_on));
    assert.equal(result.depends_on.length, 0);
    assert.ok(Array.isArray(result.files_modified));
    assert.equal(result.autonomous, 'true');
  });

  test('summary document', () => {
    const doc = [
      '---',
      'phase: 2',
      'plan: my-plan',
      'subsystem: auth',
      'tags: [security, backend]',
      'duration: 120',
      'completed: true',
      '---',
    ].join('\n');
    const result = extractFrontmatter(doc);
    assert.equal(result.phase, '2');
    assert.equal(result.subsystem, 'auth');
    assert.deepEqual(result.tags, ['security', 'backend']);
    assert.equal(result['duration'], '120');
    assert.equal(result.completed, 'true');
  });

  test('verification document', () => {
    const doc = [
      '---',
      'phase: 3',
      'verified: true',
      'status: pass',
      'score: 95',
      '---',
    ].join('\n');
    const result = extractFrontmatter(doc);
    assert.equal(result.verified, 'true');
    assert.equal(result.status, 'pass');
    assert.equal(result.score, '95');
  });
});

describe('reconstructFrontmatter: round-trip', () => {
  test('simple key-value round-trip', () => {
    const original = { title: 'Hello', author: 'World' };
    const reconstructed = reconstructFrontmatter(original);
    const doc = `---\n${reconstructed}\n---\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(parsed.title, 'Hello');
    assert.equal(parsed.author, 'World');
  });

  test('value with colon round-trips through quoting', () => {
    const original = { url: 'http://example.com' };
    const reconstructed = reconstructFrontmatter(original);
    assert.equal(reconstructed, 'url: "http://example.com"');
    const doc = `---\n${reconstructed}\n---\n`;
    const parsed = extractFrontmatter(doc);
    assert.equal(parsed.url, 'http://example.com');
  });

  test('array round-trip (inline)', () => {
    const original = { tags: ['a', 'b', 'c'] };
    const reconstructed = reconstructFrontmatter(original);
    const doc = `---\n${reconstructed}\n---\n`;
    const parsed = extractFrontmatter(doc);
    assert.deepEqual(parsed.tags, ['a', 'b', 'c']);
  });

  test('empty array round-trip', () => {
    const original = { tags: [] };
    const reconstructed = reconstructFrontmatter(original);
    assert.equal(reconstructed, 'tags: []');
    const doc = `---\n${reconstructed}\n---\n`;
    const parsed = extractFrontmatter(doc);
    assert.ok(Array.isArray(parsed.tags));
    assert.equal(parsed.tags.length, 0);
  });
});

describe('extractFrontmatter: boundary — dash at start of file', () => {
  test('--- at byte 0 is treated as frontmatter', () => {
    const result = extractFrontmatter('---\nkey: val\n---\n');
    assert.deepEqual(result, { key: 'val' });
  });

  test('content before --- means no frontmatter', () => {
    const result = extractFrontmatter(' ---\nkey: val\n---\n');
    assert.deepEqual(result, {});
  });

  test('newline before --- means no frontmatter', () => {
    const result = extractFrontmatter('\n---\nkey: val\n---\n');
    assert.deepEqual(result, {});
  });
});

describe('parseMustHavesBlock: item accumulation', () => {
  test('last item pushed after loop ends', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - only item\n---';
    const result = parseMustHavesBlock(doc, 'truths');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'only item');
  });

  test('items are pushed in order', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - first\n    - second\n    - third\n---';
    const result = parseMustHavesBlock(doc, 'truths');
    assert.equal(result[0], 'first');
    assert.equal(result[1], 'second');
    assert.equal(result[2], 'third');
  });

  test('three items total count', () => {
    const doc = '---\nmust_haves:\n  truths:\n    - a\n    - b\n    - c\n---';
    assert.equal(parseMustHavesBlock(doc, 'truths').length, 3);
  });
});

describe('parseMustHavesBlock: indent stopping logic', () => {
  test('items after block ends at same/lower indent are not included', () => {
    const doc = [
      '---',
      'must_haves:',
      '  truths:',
      '    - item one',
      'other_key: val',
      '---',
    ].join('\n');
    const result = parseMustHavesBlock(doc, 'truths');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'item one');
  });
});

describe('reconstructFrontmatter: deeply nested subsubval null/undefined', () => {
  test('3rd level null subsubval skipped', () => {
    const result = reconstructFrontmatter({ top: { mid: { key: null } } });
    assert.equal(result, 'top:\n  mid:');
  });
});

describe('reconstructFrontmatter: nested subval plain string', () => {
  test('nested subval without special chars unquoted', () => {
    const result = reconstructFrontmatter({ meta: { name: 'plain' } });
    assert.equal(result, 'meta:\n  name: plain');
  });

  test('nested subval with colon quoted', () => {
    const result = reconstructFrontmatter({ meta: { ref: 'type: value' } });
    assert.equal(result, 'meta:\n  ref: "type: value"');
  });

  test('nested subval with hash quoted', () => {
    const result = reconstructFrontmatter({ meta: { tag: 'issue#42' } });
    assert.equal(result, 'meta:\n  tag: "issue#42"');
  });
});
