// Structural invariant over the test corpus itself: a helper declared at module
// scope must not be re-declared inside a program-level fold block, because the
// inner declaration shadows the outer one for everything in that fold and the
// two copies then drift independently (#4409, same class as #4205/#4337).
//
// Every assertion here walks an AST. None reads a .cjs and calls .includes():
// that is `local/no-source-grep`'s exact shape, and it is also the wrong
// instrument — "how many declarations exist" is a construct count, not a text
// count, and a regex would also match the word inside a comment or a string.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const TESTS_DIR = __dirname;
const SUBJECT = 'runtime-launcher-parity.test.cjs';

// The 26 fold-shadowed helpers that remain elsewhere in tests/, measured — not
// guessed — with this same walker. They are the #1969 fold consolidation's
// leftovers and are NOT this issue's scope: 15 of them DIVERGE from their
// module-scope twin, and a diverged shadow cannot be deleted mechanically
// (its fold's tests were written against its own copy), so each needs its own
// behavioural check.
//
// An exact sorted list, deliberately not a count: `27 !== 26` names no
// offender and costs a CI round-trip to diagnose.
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

function parseTestFile(name) {
  // allow-test-rule: source-text-is-the-product (#4409)
  // The subject under test IS the test corpus's declaration structure; this is
  // a parse, not a substring scan.
  const src = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
  return espree.parse(src, { ecmaVersion: 2024, sourceType: 'script', loc: true });
}

/** Module-scope function declarations, by name -> first line. */
function moduleScopeFunctions(ast) {
  const found = new Map();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id && !found.has(node.id.name)) {
      found.set(node.id.name, node.loc.start.line);
    }
  }
  return found;
}

/**
 * Function declarations anywhere inside a PROGRAM-LEVEL bare block whose name
 * collides with a module-scope declaration in the same file. The bare `{` is
 * the fold marker (`// Folded from … consolidation epic #1969`); the
 * declarations themselves sit deeper, inside the arrow passed to
 * `__foldDescribe`, which is why this walks descendants rather than children.
 */
function foldShadowedIn(name) {
  const ast = parseTestFile(name);
  const moduleScope = moduleScopeFunctions(ast);
  const shadows = [];
  if (moduleScope.size === 0) return shadows;
  for (const node of ast.body) {
    if (node.type !== 'BlockStatement') continue;
    walk(node, (d) => {
      if (d.type === 'FunctionDeclaration' && d.id && moduleScope.has(d.id.name)) {
        shadows.push({
          key: `${name}::${d.id.name}`,
          name: d.id.name,
          moduleLine: moduleScope.get(d.id.name),
          foldLine: d.loc.start.line,
        });
      }
    });
  }
  return shadows;
}

function allTestFiles() {
  return fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.cjs')).sort();
}

function allFoldShadows() {
  const out = [];
  for (const name of allTestFiles()) {
    let shadows;
    try { shadows = foldShadowedIn(name); } catch { continue; }
    out.push(...shadows);
  }
  return out;
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

  // ROW 2 — the rest of the corpus, pinned as an exact sorted list.
  test('no NEW fold-shadowed helper appears anywhere in tests/', () => {
    const actual = allFoldShadows().map((s) => s.key).sort();
    assert.deepEqual(
      actual,
      [...KNOWN_FOLD_SHADOWS].sort(),
      'The set of fold-shadowed helpers changed. If you REMOVED one, delete its line from ' +
      'KNOWN_FOLD_SHADOWS — the baseline is meant to shrink. If you ADDED one, do not add it here: ' +
      'declare the helper once at module scope instead (#4409).',
    );
  });

  // ROW 3 — the baseline cannot rot into strings that match nothing.
  test('every baseline entry names a real module-scope/fold declaration pair', () => {
    const live = new Set(allFoldShadows().map((s) => s.key));
    const stale = [...new Set(KNOWN_FOLD_SHADOWS)].filter((k) => !live.has(k));
    assert.deepEqual(
      stale,
      [],
      `These baseline entries no longer correspond to a real shadowed pair — remove them:\n  ${stale.join('\n  ')}`,
    );
  });

  // ROW 4 — the behavioural half: the defect a Windows user actually hits.
  test('the surviving extractShellBlocks is CRLF-safe', () => {
    const ast = parseTestFile(SUBJECT);
    const declarations = [];
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'extractShellBlocks') {
        declarations.push(n);
      }
    });
    assert.equal(declarations.length, 1, 'exactly one extractShellBlocks may exist in this file');

    // Assert the split is CRLF-aware at the AST level: the argument to .split()
    // must be a regex that tolerates \r, never the bare '\n' string literal.
    let splitArg = null;
    walk(declarations[0], (n) => {
      if (
        splitArg === null &&
        n.type === 'CallExpression' &&
        n.callee.type === 'MemberExpression' &&
        n.callee.property.name === 'split'
      ) {
        splitArg = n.arguments[0];
      }
    });
    assert.ok(splitArg, 'extractShellBlocks must split its input into lines');
    assert.equal(
      splitArg.type,
      'Literal',
      'expected a literal split argument',
    );
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
  });
});
