'use strict';

/**
 * platform-guard.unit.test.cjs
 *
 * Unit tests for eslint-rules/lib/platform-guard.cjs.
 * Verifies classifyPlatformTest and isWindowsExcludedNode shapes
 * using espree to parse code snippets into ASTs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const espree = require('espree');
const { Linter } = require('eslint');

const { classifyPlatformTest, isWindowsExcludedNode } = require('../eslint-rules/lib/platform-guard.cjs');

const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  range: true,
  loc: true,
  tokens: true,
  comment: true,
};

function parse(code) {
  return espree.parse(code, PARSE_OPTIONS);
}

// ─── classifyPlatformTest ─────────────────────────────────────────────────────

describe('classifyPlatformTest', () => {
  test('process.platform === "win32" → windows', () => {
    const ast = parse(`process.platform === 'win32'`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('"win32" === process.platform (reversed) → windows', () => {
    const ast = parse(`'win32' === process.platform`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('process.platform !== "win32" → not-windows', () => {
    const ast = parse(`process.platform !== 'win32'`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'not-windows');
  });

  test('os.platform() === "win32" → windows', () => {
    const ast = parse(`os.platform() === 'win32'`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('os.platform() !== "win32" → not-windows', () => {
    const ast = parse(`os.platform() !== 'win32'`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'not-windows');
  });

  test('isWindows identifier → windows', () => {
    const ast = parse(`isWindows`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('IS_WINDOWS identifier → windows', () => {
    const ast = parse(`IS_WINDOWS`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('isWin identifier → windows', () => {
    const ast = parse(`isWin`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('onWindows identifier → windows', () => {
    const ast = parse(`onWindows`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'windows');
  });

  test('!isWindows → not-windows', () => {
    const ast = parse(`!isWindows`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), 'not-windows');
  });

  test('unrelated expression → null', () => {
    const ast = parse(`x === 'linux'`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), null);
  });

  test('bare identifier "result" → null', () => {
    const ast = parse(`result`);
    const node = ast.body[0].expression;
    assert.strictEqual(classifyPlatformTest(node), null);
  });
});

// ─── isWindowsExcludedNode via Linter ────────────────────────────────────────
// We use the Linter + a custom rule to get real sourceCode with ancestors.

/**
 * Build a mini rule that collects data about CallExpression nodes named
 * "assert.equal" and checks isWindowsExcludedNode on them.
 */
function buildCollectorRule() {
  return {
    create(context) {
      const sourceCode = context.sourceCode;
      const results = [];
      return {
        CallExpression(node) {
          if (
            node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'assert' &&
            node.callee.property.name === 'equal'
          ) {
            results.push(isWindowsExcludedNode(node, sourceCode));
          }
        },
        'Program:exit'() {
          context.report({ node: sourceCode.ast, messageId: 'result', data: { results: JSON.stringify(results) } });
        },
      };
    },
    meta: { type: 'suggestion', schema: [], messages: { result: '{{results}}' } },
  };
}

function runCollector(code) {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    code,
    [{ plugins: { t: { rules: { collector: buildCollectorRule() } } }, rules: { 't/collector': 'warn' }, languageOptions: { ecmaVersion: 2022, sourceType: 'script' } }],
    { filename: 'tests/x.test.cjs' }
  );
  // The rule emits exactly one message (Program:exit) with results as JSON
  const msg = messages.find(m => m.ruleId === 't/collector');
  if (!msg) return [];
  return JSON.parse(msg.message);
}

describe('isWindowsExcludedNode — if (!windows) { assert } shape', () => {
  test('assert inside if (process.platform !== "win32") block → excluded=true', () => {
    const code = `
      if (process.platform !== 'win32') {
        assert.equal(path.join(a, b), '/x/y');
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('assert inside else of if (process.platform === "win32") block → excluded=true', () => {
    const code = `
      if (process.platform === 'win32') {
        doWindows();
      } else {
        assert.equal(path.join(a, b), '/x/y');
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('assert NOT inside any guard → excluded=false', () => {
    const code = `assert.equal(path.join(a, b), '/x/y');`;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false]);
  });
});

describe('isWindowsExcludedNode — early-return guard shape', () => {
  test('if (process.platform === "win32") return; assert.equal(...) → excluded=true', () => {
    const code = `
      function test() {
        if (process.platform === 'win32') return;
        assert.equal(path.join(a, b), '/x/y');
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('if (process.platform === "win32") return t.skip(); assert.equal → excluded=true', () => {
    const code = `
      function test(t) {
        if (process.platform === 'win32') return t.skip('no windows');
        assert.equal(path.join(a, b), '/x/y');
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('guard appears AFTER the assert → excluded=false', () => {
    const code = `
      function test() {
        assert.equal(path.join(a, b), '/x/y');
        if (process.platform === 'win32') return;
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false]);
  });
});

describe('isWindowsExcludedNode — hoisted isWindows guard shape', () => {
  test('const isWindows = process.platform === "win32"; if (!isWindows) assert.equal → excluded=true', () => {
    const code = `
      const isWindows = process.platform === 'win32';
      if (!isWindows) assert.equal(path.join(a, b), '/x/y');
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('const isWindows = …; if (isWindows) {} else { assert.equal } → excluded=true', () => {
    const code = `
      const isWindows = process.platform === 'win32';
      if (isWindows) { doWindowsThing(); } else { assert.equal(path.join(a,b), '/x/y'); }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });
});

describe('isWindowsExcludedNode — arbitrary-named hoisted boolean (real hoisting)', () => {
  test('const winFlag = process.platform === "win32"; if (!winFlag) assert.equal → excluded=true', () => {
    const code = `
      function test() {
        const winFlag = process.platform === 'win32';
        if (!winFlag) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('const winFlag = process.platform === "win32"; if (winFlag) return; assert.equal → excluded=true', () => {
    const code = `
      function test() {
        const winFlag = process.platform === 'win32';
        if (winFlag) return;
        assert.equal(path.join(a, b), '/x/y');
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('unrelated variable used as guard is NOT excluded', () => {
    const code = `
      function test() {
        const debugMode = true;
        if (!debugMode) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false]);
  });

  test('winFlag declared AFTER the assert is NOT a guard → excluded=false', () => {
    const code = `
      function test() {
        assert.equal(path.join(a, b), '/x/y');
        const winFlag = process.platform === 'win32';
        if (!winFlag) { doSomething(); }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false]);
  });
});

// ─── C2: early-return guard must climb ancestor blocks ────────────────────────

describe('C2 — early-return guard climbs ancestor blocks', () => {
  test('C2: early-return in outer block before nested if-block → excluded=true', () => {
    // The guard is in the function body; assert.equal is inside a nested if-block.
    // Before the fix, _hasEarlyWindowsReturnBefore only checked the innermost block.
    const code = `
      function test() {
        if (process.platform === 'win32') return;
        if (cond) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true]);
  });

  test('C2: no early-return at all → excluded=false', () => {
    const code = `
      function test() {
        if (cond) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false]);
  });
});

// ─── C3: binding-aware identifier classification ──────────────────────────────

describe('C3 — binding-aware identifier classification', () => {
  test('C3 case 1: const isWindows = false; if (!isWindows) assert.equal → excluded=false (FLAGGED)', () => {
    // isWindows is in WINDOWS_BOOL_NAMES but its binding is `false`, not a platform test.
    const code = `
      function test() {
        const isWindows = false;
        if (!isWindows) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false], 'const isWindows = false should not be treated as a platform guard');
  });

  test('C3 case 2: let w = platform===win32; w = false; if (!w) assert.equal → excluded=false (FLAGGED)', () => {
    // w starts as a platform test but is reassigned — should NOT be trusted.
    const code = `
      function test() {
        let w = process.platform === 'win32';
        w = false;
        if (!w) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false], 'reassigned variable should not be treated as a platform guard');
  });

  test('C3 case 3: inner shadow const w = false wins over outer const w = platform test → excluded=false (FLAGGED)', () => {
    // The inner const w = false shadows the outer const w = platform test.
    const code = `
      function test() {
        const w = process.platform === 'win32';
        {
          const w = false;
          if (!w) {
            assert.equal(path.join(a, b), '/x/y');
          }
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [false], 'inner shadow (w=false) should win over outer platform test');
  });

  test('C3 case 4: const w = platform test; if (!w) assert.equal → excluded=true (genuine guard)', () => {
    // The canonical case — should still work.
    const code = `
      function test() {
        const w = process.platform === 'win32';
        if (!w) {
          assert.equal(path.join(a, b), '/x/y');
        }
      }
    `;
    const results = runCollector(code);
    assert.deepStrictEqual(results, [true], 'genuine platform guard should suppress the report');
  });
});
