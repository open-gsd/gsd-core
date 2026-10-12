'use strict';

/**
 * jsonc-edit.test.cjs — comment-preserving JSONC edits (#5334, epic #5331 Phase 2 #5338).
 * The module is exercised through its exports; every result is also parsed back and compared with the
 * same edit applied to the parsed object, so a splice that corrupts the document cannot pass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setJsoncValue, removeJsoncValue, hasJsoncFeatures, isEditableJsonc } = require('../gsd-core/bin/lib/jsonc-edit.cjs');

// Reference parser: strip comments/trailing commas the simple way (inputs here contain no comment-like strings
// except where a test says so).
function parse(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/[^\n"]*$/gm, '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

const DOC = `{
  // user note
  "theme": "dark", // trailing note
  /* block */
  "permission": {
    "read": {
      "~/mine/*": "allow", // keep
    },
  },
  "mcp": {
    "user": { "type": "local", "command": ["x"] },
  },
}
`;

test('set into an existing nested object keeps comments and the trailing-comma style', () => {
  const out = setJsoncValue(DOC, ['permission', 'read', '~/gsd/*'], 'allow');
  assert.ok(out.includes('// user note') && out.includes('// trailing note') && out.includes('/* block */') && out.includes('// keep'));
  assert.deepEqual(parse(out).permission.read, { '~/mine/*': 'allow', '~/gsd/*': 'allow' });
  assert.match(out, /"~\/gsd\/\*": "allow",\n/);
});

test('set creates missing parents and appends to the root', () => {
  const out = setJsoncValue(DOC, ['agent', 'build', 'model'], 'p/m');
  assert.deepEqual(parse(out).agent, { build: { model: 'p/m' } });
  assert.ok(out.includes('// user note'));
  assert.equal(parse(out).theme, 'dark');
});

test('set replaces an existing value in place', () => {
  const out = setJsoncValue(DOC, ['theme'], 'light');
  assert.equal(parse(out).theme, 'light');
  assert.ok(out.includes('// trailing note'));
});

test('set on a compact document without a trailing comma', () => {
  const out = setJsoncValue('{ "a": 1 }', ['b'], { c: true });
  assert.deepEqual(parse(out), { a: 1, b: { c: true } });
  const nested = setJsoncValue('{"a":{"x":1}}', ['a', 'y'], 2);
  assert.deepEqual(parse(nested), { a: { x: 1, y: 2 } });
});

test('set on an empty object and on a comment-only object', () => {
  assert.deepEqual(parse(setJsoncValue('{}', ['a'], 1)), { a: 1 });
  const out = setJsoncValue('{\n  // nothing yet\n}\n', ['a'], 1);
  assert.deepEqual(parse(out), { a: 1 });
  assert.ok(out.includes('// nothing yet'));
});

test('set keeps a same-line trailing comment next to its property', () => {
  const out = setJsoncValue('{\n  "a": 1 // note\n}\n', ['b'], 2);
  assert.match(out, /"a": 1, \/\/ note|"a": 1,\s*\/\/ note/);
  assert.deepEqual(parse(out), { a: 1, b: 2 });
});

test('set replaces a non-object that sits where an object is needed', () => {
  assert.deepEqual(parse(setJsoncValue('{"permission": "allow"}', ['permission', 'read', 'k'], 'allow')), { permission: { read: { k: 'allow' } } });
});

test('remove deletes only the target and keeps neighbours and comments', () => {
  const out = removeJsoncValue(DOC, ['permission', 'read', '~/mine/*']);
  assert.equal(parse(out).permission, undefined, 'emptied parents are pruned');
  assert.ok(out.includes('// user note') && out.includes('/* block */'));
  assert.deepEqual(parse(out).mcp, { user: { type: 'local', command: ['x'] } });
});

test('remove of the last property without a trailing comma drops the preceding comma', () => {
  const out = removeJsoncValue('{\n  "a": 1,\n  "b": 2\n}\n', ['b']);
  assert.deepEqual(parse(out), { a: 1 });
  assert.equal(out, '{\n  "a": 1\n}\n');
});

test('remove of a middle and a first property', () => {
  assert.deepEqual(parse(removeJsoncValue('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', ['b'])), { a: 1, c: 3 });
  assert.deepEqual(parse(removeJsoncValue('{\n  "a": 1,\n  "b": 2\n}\n', ['a'])), { b: 2 });
});

test('remove never prunes the root and ignores a missing path', () => {
  assert.equal(removeJsoncValue('{"a":1}', ['a']), '{}');
  const same = '{"a":1}';
  assert.equal(removeJsoncValue(same, ['zzz', 'y']), same);
});

test('remove prunes an emptied ancestor but keeps a non-empty one', () => {
  const doc = '{\n  "mcp": {\n    "gsd": { "type": "local" },\n    "mine": { "type": "local" }\n  }\n}\n';
  assert.deepEqual(parse(removeJsoncValue(doc, ['mcp', 'gsd'])), { mcp: { mine: { type: 'local' } } });
  assert.deepEqual(parse(removeJsoncValue('{\n  "mcp": {\n    "gsd": 1\n  },\n  "x": 2\n}\n', ['mcp', 'gsd'])), { x: 2 });
});

test('strings containing comment markers and braces are not mistaken for syntax', () => {
  const doc = '{\n  "url": "http://a//b", // real comment\n  "re": "/* not a comment */",\n  "x": 1\n}\n';
  const out = setJsoncValue(doc, ['y'], 2);
  assert.equal(JSON.parse(out.replace('// real comment', '')).re, '/* not a comment */');
  assert.deepEqual(JSON.parse(removeJsoncValue(doc, ['x']).replace('// real comment', '')).url, 'http://a//b');
});

test('unparseable or non-object documents report null', () => {
  assert.equal(setJsoncValue('{ "a": ', ['b'], 1), null);
  assert.equal(setJsoncValue('[1,2]', ['b'], 1), null);
  assert.equal(removeJsoncValue('nope', ['b']), null);
  assert.equal(isEditableJsonc('{"a":1}'), true);
  assert.equal(isEditableJsonc('{"a":'), false);
});

test('hasJsoncFeatures detects comments and trailing commas but not look-alikes inside strings', () => {
  assert.equal(hasJsoncFeatures('{"a":1}'), false);
  assert.equal(hasJsoncFeatures('{"a":"//x", "b": "/*y*/"}'), false);
  assert.equal(hasJsoncFeatures('{"a":1 // c\n}'), true);
  assert.equal(hasJsoncFeatures('{"a":1, }'), true);
  assert.equal(hasJsoncFeatures('{"a":[1,2,]}'), true);
});

test('CRLF documents stay parseable after edits', () => {
  const doc = '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
  assert.deepEqual(parse(removeJsoncValue(doc, ['b'])), { a: 1 });
  assert.deepEqual(parse(setJsoncValue(doc, ['c'], 3)), { a: 1, b: 2, c: 3 });
});

test('randomised edits keep the document equal to the same edit on the parsed object', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const keys = ['a', 'b', 'c'];
  const gen = (d) => {
    if (d === 0 || rnd(3) === 0) return rnd(2) ? rnd(100) : 's' + rnd(9);
    const o = {};
    for (const k of keys) if (rnd(2)) o[k] = gen(d - 1);
    return o;
  };
  const render = (o, ind) => {
    const e = Object.entries(o);
    if (e.length === 0) return '{}';
    const pad = '  '.repeat(ind + 1);
    const trailing = rnd(2) ? ',' : '';
    return `{\n${e.map(([k, v], i) => `${pad}// c${rnd(9)}\n${pad}${JSON.stringify(k)}: ${typeof v === 'object' ? render(v, ind + 1) : JSON.stringify(v)}${i < e.length - 1 || trailing ? ',' : ''}`).join('\n')}\n${'  '.repeat(ind)}}`;
  };
  const setRef = (o, p, v) => { let c = o; p.slice(0, -1).forEach((k) => { if (typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; }); c[p[p.length - 1]] = v; };
  const rmRef = (o, p) => {
    const chain = [o]; let c = o;
    for (const k of p.slice(0, -1)) { if (typeof c[k] !== 'object' || c[k] === null) return; c = c[k]; chain.push(c); }
    if (!Object.hasOwn(c, p[p.length - 1])) return;
    delete c[p[p.length - 1]];
    for (let i = chain.length - 1; i > 0; i--) { if (Object.keys(chain[i]).length === 0) delete chain[i - 1][p[i - 1]]; else break; }
  };
  for (let n = 0; n < 300; n++) {
    const obj = gen(3);
    if (typeof obj !== 'object') continue;
    const text = render(obj, 0) + '\n';
    const path = Array.from({ length: 1 + rnd(3) }, () => keys[rnd(3)]);
    const ref = JSON.parse(JSON.stringify(obj));
    if (rnd(2)) {
      setRef(ref, path, 'v');
      assert.deepEqual(parse(setJsoncValue(text, path, 'v')), ref, `set ${path} in\n${text}`);
    } else {
      rmRef(ref, path);
      assert.deepEqual(parse(removeJsoncValue(text, path)), ref, `remove ${path} in\n${text}`);
    }
  }
});
