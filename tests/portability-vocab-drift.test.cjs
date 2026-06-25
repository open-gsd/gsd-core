'use strict';

/**
 * portability-vocab-drift.test.cjs
 *
 * Drift-guard: ensure that every exported function from src/runtime-homes.cts
 * that returns a filesystem path is listed in PATH_RETURNING_FNS
 * (eslint-rules/lib/portability-vocab.cjs).
 *
 * Method:
 *   1. Parse src/runtime-homes.cts with @typescript-eslint/parser.
 *   2. Collect `export function <name>` declarations where the body contains
 *      a path-building expression (path.join, path.dirname, os.homedir,
 *      expandTilde, or returns something with "Dir" / "Path" / "Base" in its name).
 *   3. Assert each collected name is in PATH_RETURNING_FNS or is listed in
 *      IGNORED_NON_PATH_EXPORTS (with a reason comment per entry).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tsParser = require('@typescript-eslint/parser');

const { PATH_RETURNING_FNS } = require('../eslint-rules/lib/portability-vocab.cjs');

// Functions exported from runtime-homes.cts that do NOT return a filesystem
// path and therefore are intentionally excluded from PATH_RETURNING_FNS.
const IGNORED_NON_PATH_EXPORTS = new Set([
  // resolveConfigHomeFromDescriptor: internal/exported but delegates to path-returning helpers;
  // it IS included in PATH_RETURNING_FNS under its bare name (no object prefix needed).
  // detectAntigravityDirAmbiguity: returns an object (AntigravityAmbiguity), not a path string.
  'detectAntigravityDirAmbiguity',
]);

describe('portability-vocab drift guard', () => {
  test('PATH_RETURNING_FNS is a non-empty array', () => {
    assert.ok(Array.isArray(PATH_RETURNING_FNS));
    assert.ok(PATH_RETURNING_FNS.length > 0);
  });

  test('PATH_RETURNING_FNS includes the Node builtins', () => {
    const builtins = ['path.join', 'path.resolve', 'path.dirname', 'path.basename', 'path.normalize', 'path.relative', 'os.homedir', 'os.tmpdir'];
    for (const fn of builtins) {
      assert.ok(PATH_RETURNING_FNS.includes(fn), `Expected PATH_RETURNING_FNS to include builtin "${fn}"`);
    }
  });

  test('every path-returning export from runtime-homes.cts is in PATH_RETURNING_FNS or IGNORED', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'runtime-homes.cts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    // Parse with @typescript-eslint/parser (handles TypeScript syntax)
    const ast = tsParser.parse(src, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    // Collect exported function names whose body looks path-returning:
    //   - body contains a call to path.join / path.dirname / os.homedir / expandTilde
    //   - OR function name ends with Dir, Path, Base, Home, or starts with resolve/get
    const pathReturningExports = [];

    function bodyText(node) {
      // Slice the source for the function body
      if (node.range) return src.slice(node.range[0], node.range[1]);
      return '';
    }

    function looksPathReturning(funcNode, name) {
      const body = bodyText(funcNode.body ?? funcNode);
      const pathBuilders = [
        'path.join', 'path.resolve', 'path.dirname', 'path.basename',
        'path.normalize', 'path.relative', 'os.homedir', 'os.tmpdir',
        'expandTilde', 'expandTildeWithHome', 'resolveConfigHome',
      ];
      if (pathBuilders.some(p => body.includes(p))) return true;
      // Name heuristic: resolveXxx / getXxxDir / getXxxPath / getXxxBase
      if (/^(resolve|get)[A-Z]/.test(name) && /Dir|Path|Base|Home|Skills/.test(name)) return true;
      return false;
    }

    // Build a lookup from top-level declaration names to their function nodes,
    // to resolve `export { name }` specifier exports (C4).
    const topLevelFunctionNodes = new Map(); // name → funcNode
    for (const node of ast.body) {
      // function <name>(...) { ... }  (non-exported declaration)
      if (
        node.type === 'FunctionDeclaration' &&
        node.id
      ) {
        topLevelFunctionNodes.set(node.id.name, node);
      }
      // const <name> = () => ...  (non-exported const arrow/function)
      if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            topLevelFunctionNodes.set(decl.id.name, decl.init);
          }
        }
      }
      // export function / export const — also register in the map
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'FunctionDeclaration' &&
        node.declaration.id
      ) {
        topLevelFunctionNodes.set(node.declaration.id.name, node.declaration);
      }
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            topLevelFunctionNodes.set(decl.id.name, decl.init);
          }
        }
      }
    }

    for (const node of ast.body) {
      // export function <name>(...) { ... }
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'TSDeclareFunction' === false &&
        (node.declaration.type === 'FunctionDeclaration') &&
        node.declaration.id
      ) {
        const name = node.declaration.id.name;
        if (looksPathReturning(node.declaration, name)) {
          pathReturningExports.push(name);
        }
      }

      // export const <name> = (<ArrowFunctionExpression> | <FunctionExpression>)
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            const name = decl.id.name;
            if (looksPathReturning(decl.init, name)) {
              pathReturningExports.push(name);
            }
          }
        }
      }

      // export { name1, name2 } — specifier exports (C4)
      // Resolve each specifier to its in-file function/const declaration.
      if (
        node.type === 'ExportNamedDeclaration' &&
        !node.declaration &&
        node.source == null && // not a re-export from another module
        Array.isArray(node.specifiers)
      ) {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            specifier.local &&
            specifier.local.type === 'Identifier'
          ) {
            const name = specifier.local.name;
            const exportedName =
              specifier.exported && specifier.exported.type === 'Identifier'
                ? specifier.exported.name
                : name;
            const funcNode = topLevelFunctionNodes.get(name);
            if (funcNode && looksPathReturning(funcNode, exportedName)) {
              pathReturningExports.push(exportedName);
            }
          }
        }
      }
    }

    // Verify we found at least a few (guards against parser silently failing)
    assert.ok(
      pathReturningExports.length >= 3,
      `Expected at least 3 path-returning exports, got ${pathReturningExports.length}: [${pathReturningExports.join(', ')}]`
    );

    const vocabSet = new Set(PATH_RETURNING_FNS);
    const missing = [];
    for (const name of pathReturningExports) {
      if (!vocabSet.has(name) && !IGNORED_NON_PATH_EXPORTS.has(name)) {
        missing.push(name);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `These path-returning exports from runtime-homes.cts are missing from PATH_RETURNING_FNS:\n  ${missing.join('\n  ')}\n\nEither add them to PATH_RETURNING_FNS in eslint-rules/lib/portability-vocab.cjs or add them to IGNORED_NON_PATH_EXPORTS with a reason.`
    );
  });

  test('export const arrow-function returning path.join would be required in PATH_RETURNING_FNS', () => {
    // Simulate parsing a snippet with `export const myArrowResolver = (x) => path.join(home, x)`
    // and verify the drift-guard collector would pick it up (i.e. it's NOT silently bypassed).
    const snippetSrc = `
      export const myArrowResolver = (x) => path.join('/home', x);
    `;
    const ast = tsParser.parse(snippetSrc, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    const collected = [];
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        node.declaration &&
        node.declaration.type === 'VariableDeclaration'
      ) {
        for (const decl of node.declaration.declarations) {
          if (
            decl.type === 'VariableDeclarator' &&
            decl.id &&
            decl.id.type === 'Identifier' &&
            decl.init &&
            (decl.init.type === 'ArrowFunctionExpression' ||
              decl.init.type === 'FunctionExpression')
          ) {
            const name = decl.id.name;
            const bodyTxt = snippetSrc.slice(decl.init.range[0], decl.init.range[1]);
            if (['path.join', 'path.resolve', 'path.dirname'].some(p => bodyTxt.includes(p))) {
              collected.push(name);
            }
          }
        }
      }
    }

    assert.deepStrictEqual(collected, ['myArrowResolver'],
      'Arrow-function path export should be collected by the drift guard, requiring it in PATH_RETURNING_FNS');

    // Confirm PATH_RETURNING_FNS does NOT already contain this fictional name
    // (so the test demonstrates a missing entry would be caught, not silently pass).
    assert.ok(
      !PATH_RETURNING_FNS.includes('myArrowResolver'),
      'myArrowResolver should not be in PATH_RETURNING_FNS (it is a test fixture name)',
    );
  });

  test('C4: export { name } specifier form — path resolver would be required in PATH_RETURNING_FNS', () => {
    // Demonstrate that the drift guard now handles `export { mySpecifierResolver }` where
    // the function is declared separately (not inline in the export statement).
    const snippetSrc = `
      function mySpecifierResolver(x) {
        return path.join('/home', x);
      }
      export { mySpecifierResolver };
    `;
    const ast = tsParser.parse(snippetSrc, {
      jsx: false,
      loc: true,
      range: true,
      comment: true,
      tokens: false,
    });

    // Replicate the drift-guard's specifier-resolution logic (C4 addition).
    const topLevelFns = new Map();
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        topLevelFns.set(node.id.name, node);
      }
    }

    const collected = [];
    for (const node of ast.body) {
      if (
        node.type === 'ExportNamedDeclaration' &&
        !node.declaration &&
        node.source == null &&
        Array.isArray(node.specifiers)
      ) {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            specifier.local &&
            specifier.local.type === 'Identifier'
          ) {
            const localName = specifier.local.name;
            const funcNode = topLevelFns.get(localName);
            if (funcNode) {
              const bodyTxt = snippetSrc.slice(funcNode.range[0], funcNode.range[1]);
              if (['path.join', 'path.resolve', 'path.dirname'].some(p => bodyTxt.includes(p))) {
                collected.push(localName);
              }
            }
          }
        }
      }
    }

    assert.deepStrictEqual(collected, ['mySpecifierResolver'],
      'export { name } specifier form should be detected by drift guard, requiring entry in PATH_RETURNING_FNS');

    assert.ok(
      !PATH_RETURNING_FNS.includes('mySpecifierResolver'),
      'mySpecifierResolver should not be in PATH_RETURNING_FNS (it is a test fixture name)',
    );
  });
});
