// Structural invariant over the test corpus itself: a helper declared at module
// scope must not be re-declared inside a program-level fold block, because the
// inner declaration shadows the outer one for everything in that fold and the
// two copies then drift independently (#4409, same class as #4205/#4337).
//
// Every assertion walks an AST. None reads a .cjs and calls .includes(): that is
// `local/no-source-grep`'s trigger shape, and it is also the wrong instrument —
// "how many declarations exist" is a construct count, and a regex would match the
// name inside a comment or a string literal too.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const TESTS_DIR = __dirname;
const SUBJECT = 'runtime-launcher-parity.test.cjs';

// The fold-shadowed helpers that remain elsewhere in tests/, measured with this
// same walker — not guessed. They are leftovers of the #1969 fold consolidation
// and are NOT this issue's scope: most of them DIVERGE from their module-scope
// twin (16 of 26 comparing whitespace-normalized bodies; 15 if comments are
// stripped too — one pair differs only in its comments), and a diverged shadow
// cannot be deleted mechanically the way this issue's could, because its fold's
// tests were written against its own copy.
//
// An exact sorted list, deliberately not a count: `27 !== 26` names no offender
// and costs a CI round-trip to diagnose.
const KNOWN_FOLD_SHADOWS = [
  'capability-registry.test.cjs::makeTempCapDir',
  'codex-config-agents.test.cjs::readHooksSessionStartCommands',
  'codex-config-agents.test.cjs::runCodexInstall',
  'config-loader.test.cjs::writeConfig',
  'config.test.cjs::readConfig',
  'config.test.cjs::readConfig',
  'graphify-command-cutover.test.cjs::assertTypedError',
  'graphify-command-cutover.test.cjs::makeGraphifyMock',
  'graphify-command-cutover.test.cjs::runJsonErrors',
  'health-validation.test.cjs::writeMinimalRoadmap',
  'installer-migrations.test.cjs::userHook',
  'model-profiles.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'model-resolver.test.cjs::writeConfig',
  'read-guard.test.cjs::runHook',
  'reapply-patches.test.cjs::parseFrontmatterField',
  'runtime-homes-descriptor-drive.test.cjs::withEnv',
  'skill-frontmatter-contract.test.cjs::read',
  'state-prune.test.cjs::writeStateMd',
  'update-custom-backup.test.cjs::sha256',
  'update-custom-backup.test.cjs::sha256',
  'update-custom-backup.test.cjs::writeManifest',
];

const FUNCTION_INITIALIZERS = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

/** Recursive: tests/ has subdirectories (dispatch/, qa/, helpers/, …) that a
 *  flat readdir would silently exclude from the corpus guard. */
function allTestFiles(dir = TESTS_DIR, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...allTestFiles(abs, relPath));
    else if (entry.name.endsWith('.cjs')) out.push(relPath);
  }
  return out.sort();
}

function parseTestFile(relPath) {
  const src = fs.readFileSync(path.join(TESTS_DIR, relPath), 'utf8');
  return espree.parse(src, { ecmaVersion: 2024, sourceType: 'script', loc: true });
}

/**
 * Names a statement declares as a callable: a `function foo()` declaration AND a
 * `const foo = () => {}` / `= function () {}` binding. Arrow-form helpers shadow
 * exactly the same way; detecting only FunctionDeclaration would leave the guard
 * blind to half the shapes a future fold could use.
 */
function declaredCallables(node) {
  const found = new Map();
  if (node.type === 'FunctionDeclaration' && node.id) {
    found.set(node.id.name, node.loc.start.line);
  }
  if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      if (d.id.type === 'Identifier' && d.init && FUNCTION_INITIALIZERS.has(d.init.type)) {
        found.set(d.id.name, d.loc.start.line);
      }
    }
  }
  return found;
}

/**
 * Callables declared anywhere inside a PROGRAM-LEVEL bare block whose name
 * collides with a module-scope callable in the same file. The bare `{` is the
 * fold marker (`// Folded from … consolidation epic #1969`); the declarations sit
 * deeper, inside the arrow passed to `__foldDescribe`, hence a descendant walk.
 */
function foldShadowedIn(relPath) {
  const ast = parseTestFile(relPath);
  const moduleScope = new Map();
  for (const node of ast.body) {
    for (const [name, line] of declaredCallables(node)) {
      if (!moduleScope.has(name)) moduleScope.set(name, line);
    }
  }
  const shadows = [];
  if (moduleScope.size === 0) return shadows;
  for (const node of ast.body) {
    if (node.type !== 'BlockStatement') continue;
    walk(node, (d) => {
      for (const [name, line] of declaredCallables(d)) {
        if (!moduleScope.has(name)) continue;
        shadows.push({
          key: `${relPath}::${name}`,
          name,
          moduleLine: moduleScope.get(name),
          foldLine: line,
        });
      }
    });
  }
  return shadows;
}

/** Scans the whole corpus. Parse failures are RAISED, never skipped: a silent
 *  `continue` would let the guard go quietly blind on the file that broke. */
function scanCorpus() {
  const shadows = [];
  const files = allTestFiles();
  for (const relPath of files) {
    shadows.push(...foldShadowedIn(relPath));
  }
  return { shadows, scanned: files.length };
}

describe('fold-shadowed test helpers (#4409)', () => {
  // ROW 1 — the reported defect, asserted at the identity level.
  test(`${SUBJECT} declares each helper exactly once`, () => {
    const shadows = foldShadowedIn(SUBJECT).map(
      (s) => `${s.name} (module@${s.moduleLine}, shadowed in fold@${s.foldLine})`,
    );
    assert.deepEqual(
      shadows,
      [],
      `${SUBJECT} re-declares a module-scope helper inside its fold. The inner copy wins for ` +
      'everything in that fold, so the two drift independently — which is how extractShellBlocks ' +
      'came to split on "\\n" while its module-scope twin split on /\\r?\\n/ (#4409).\n  ' +
      shadows.join('\n  '),
    );
  });

  // ROW 2 — the rest of the corpus, pinned as an exact sorted list. A stale
  // baseline entry fails here too (the lists stop matching), so there is no
  // separate staleness row to pass vacuously.
  test('the fold-shadowed set across tests/ matches the recorded baseline exactly', () => {
    const { shadows, scanned } = scanCorpus();
    assert.ok(scanned > 900, `expected the full corpus, scanned only ${scanned} files`);
    assert.deepEqual(
      shadows.map((s) => s.key).sort(),
      [...KNOWN_FOLD_SHADOWS].sort(),
      'The set of fold-shadowed helpers changed. If you REMOVED one, delete its line from ' +
      'KNOWN_FOLD_SHADOWS — the baseline is meant to shrink. If you ADDED one, do not add it ' +
      'here: declare the helper once at module scope instead (#4409).',
    );
  });

  // ROW 3 — the behavioural half: the defect a Windows user actually hits.
  test(`every extractShellBlocks in ${SUBJECT} splits lines CRLF-safely`, () => {
    const ast = parseTestFile(SUBJECT);
    const declarations = [];
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'extractShellBlocks') {
        declarations.push(n);
      }
    });
    assert.equal(declarations.length, 1, 'exactly one extractShellBlocks may exist in this file');

    // Check EVERY declaration, not just the first: on the pre-fix tree the
    // module-scope copy came first and was already correct, so inspecting only
    // declarations[0] would have missed the folded copy that carried the bug.
    for (const declaration of declarations) {
      const param = declaration.params[0];
      assert.equal(param?.type, 'Identifier', 'extractShellBlocks takes a content parameter');

      // Pin the split to the one applied TO THAT PARAMETER, rather than taking
      // whichever `.split()` appears first in the body.
      let splitArg = null;
      walk(declaration, (n) => {
        if (
          splitArg === null &&
          n.type === 'CallExpression' &&
          n.callee.type === 'MemberExpression' &&
          n.callee.property.name === 'split' &&
          n.callee.object.type === 'Identifier' &&
          n.callee.object.name === param.name
        ) {
          splitArg = n.arguments[0];
        }
      });
      assert.ok(splitArg, `extractShellBlocks must split its "${param.name}" parameter into lines`);
      assert.ok(
        splitArg.regex,
        `extractShellBlocks splits on ${JSON.stringify(splitArg.value)} — a bare "\\n" leaves a ` +
        'trailing \\r on every line of a CRLF checkout (core.autocrlf=true on Windows). Use /\\r?\\n/.',
      );
      assert.match(
        splitArg.regex.pattern,
        /\\r\?\\n/,
        'the line split must tolerate a carriage return (#4409)',
      );
    }
  });
});
