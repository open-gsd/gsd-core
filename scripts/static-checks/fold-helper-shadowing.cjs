'use strict';

/**
 * fold-helper-shadowing: a helper declared at module scope of a test file must
 * not be re-declared inside a program-level fold block, because the inner
 * declaration shadows the outer one for everything in that fold and the two
 * copies then drift independently (#4409, same class as #4205/#4337).
 *
 * It was tests/fold-helper-shadowing.test.cjs (23 s of Linux test time); it
 * reads repo content, so it runs in scripts/run-static-checks.cjs (ADR-6315
 * item 19, #6434). Three findings, as the test's three rows:
 *   1. SUBJECT declares each helper exactly once (the reported defect);
 *   2. the shadowed set across tests/ equals KNOWN_FOLD_SHADOWS exactly (a
 *      stale entry fails too, so there is no separate staleness row);
 *   3. every extractShellBlocks in SUBJECT splits lines on /\r?\n/ (a bare
 *      "\n" leaves a trailing \r on every line of a CRLF checkout).
 *
 * Every walk is over an AST. None reads a .cjs and searches its text: "how many
 * declarations exist" is a construct count, and a text search would match the
 * name inside a comment or a string literal too.
 */

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const SUBJECT = 'runtime-launcher-parity.test.cjs';
// The old test required `scanned > 900`, so the corpus must hold at least 901 files.
const MIN_FILES = 901;

// The fold-shadowed helpers that remain elsewhere in tests/, measured with this
// same walker, not guessed. They are leftovers of the #1969 fold consolidation:
// most DIVERGE from their module-scope twin (16 of 26 comparing
// whitespace-normalized bodies), and a diverged shadow cannot be deleted
// mechanically, because its fold's tests were written against its own copy. An
// exact sorted list, deliberately not a count: `27 !== 26` names no offender.
const KNOWN_FOLD_SHADOWS = Object.freeze([
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
]);

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

/** Recursive: tests/ has subdirectories a flat readdir would silently exclude. */
function allTestFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...allTestFiles(abs, relPath));
    else if (entry.name.endsWith('.cjs')) out.push(relPath);
  }
  return out.sort();
}

function parseTestFile(testsDir, relPath) {
  const src = fs.readFileSync(path.join(testsDir, relPath), 'utf8');
  return espree.parse(src, { ecmaVersion: 2024, sourceType: 'script', loc: true });
}

/**
 * Names a statement declares as a callable: a `function foo()` declaration AND a
 * `const foo = () => {}` / `= function () {}` binding. Arrow-form helpers shadow
 * exactly the same way.
 */
function declaredCallables(node) {
  const found = new Map();
  if (node.type === 'FunctionDeclaration' && node.id) found.set(node.id.name, node.loc.start.line);
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
 * fold marker; the declarations sit deeper, hence a descendant walk.
 */
function foldShadowedIn(testsDir, relPath) {
  const ast = parseTestFile(testsDir, relPath);
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
        shadows.push({ key: `${relPath}::${name}`, name, moduleLine: moduleScope.get(name), foldLine: line });
      }
    });
  }
  return shadows;
}

/** Whole-corpus scan. A parse failure is RAISED, never skipped (the caller reports it). */
function scanCorpus(testsDir) {
  const files = allTestFiles(testsDir);
  const shadows = [];
  for (const relPath of files) shadows.push(...foldShadowedIn(testsDir, relPath));
  return { shadows, scanned: files.length };
}

/** Problems with how `extractShellBlocks` splits lines in `relPath`; [] when it is CRLF-safe. */
function extractShellBlocksProblems(testsDir, relPath) {
  const ast = parseTestFile(testsDir, relPath);
  const declarations = [];
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'extractShellBlocks') declarations.push(n);
  });
  if (declarations.length !== 1) {
    return [`exactly one extractShellBlocks may exist in ${relPath}, found ${declarations.length}`];
  }
  const problems = [];
  for (const declaration of declarations) {
    const param = declaration.params[0];
    if (!param || param.type !== 'Identifier') {
      problems.push('extractShellBlocks takes a content parameter');
      continue;
    }
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
    if (!splitArg) {
      problems.push(`extractShellBlocks must split its "${param.name}" parameter into lines`);
    } else if (!splitArg.regex || !/\\r\?\\n/.test(splitArg.regex.pattern)) {
      problems.push(
        `extractShellBlocks splits on ${splitArg.regex ? `/${splitArg.regex.pattern}/` : JSON.stringify(splitArg.value)}: ` +
        'a bare "\\n" leaves a trailing \\r on every line of a CRLF checkout (core.autocrlf=true). Use /\\r?\\n/.',
      );
    }
  }
  return problems;
}

/**
 * @param {{root: string, subject?: string, known?: readonly string[], minFiles?: number}} ctx
 * @returns {{file: string, line: number|string, message: string}[]}
 */
function run({ root, subject = SUBJECT, known = KNOWN_FOLD_SHADOWS, minFiles = MIN_FILES }) {
  const testsDir = path.join(root, 'tests');
  const findings = [];

  let subjectShadows = [];
  let subjectProblems = [];
  const subjectPresent = fs.existsSync(path.join(testsDir, subject));
  if (!subjectPresent) {
    findings.push({ file: `tests/${subject}`, line: 0, message: 'the subject file of the fold-shadow check is missing' });
  } else {
    try {
      subjectShadows = foldShadowedIn(testsDir, subject);
      subjectProblems = extractShellBlocksProblems(testsDir, subject);
    } catch (err) {
      findings.push({ file: `tests/${subject}`, line: 1, message: `parse error: ${err.message}` });
    }
  }
  for (const s of subjectShadows) {
    findings.push({
      file: `tests/${subject}`,
      line: s.foldLine,
      message: `${s.name} (module@${s.moduleLine}) is re-declared inside a fold; the inner copy wins for everything in that fold and the two drift independently (#4409). Declare it once at module scope.`,
    });
  }
  for (const problem of subjectProblems) findings.push({ file: `tests/${subject}`, line: 0, message: problem });

  let corpus;
  try {
    corpus = scanCorpus(testsDir);
  } catch (err) {
    findings.push({ file: 'tests', line: 0, message: `the corpus scan failed: ${err.message}` });
    return findings;
  }
  if (corpus.scanned < minFiles) {
    findings.push({ file: 'tests', line: 0, message: `expected the full corpus (at least ${minFiles} files), scanned ${corpus.scanned}` });
  }
  const actual = corpus.shadows.map((s) => s.key).sort();
  const expected = [...known].sort();
  const remaining = [...expected];
  for (const key of actual) {
    const at = remaining.indexOf(key);
    if (at === -1) {
      findings.push({ file: `tests/${key.split('::')[0]}`, line: 0, message: `${key} is a new fold-shadowed helper. Do not add it to KNOWN_FOLD_SHADOWS: declare the helper once at module scope instead (#4409).` });
    } else {
      remaining.splice(at, 1);
    }
  }
  for (const key of remaining) {
    findings.push({ file: 'scripts/static-checks/fold-helper-shadowing.cjs', line: 0, message: `${key} is in KNOWN_FOLD_SHADOWS but no longer shadowed: delete its line, the baseline is meant to shrink.` });
  }
  return findings;
}

module.exports = {
  name: 'fold-helper-shadowing',
  run,
  foldShadowedIn,
  extractShellBlocksProblems,
  scanCorpus,
  KNOWN_FOLD_SHADOWS,
  SUBJECT,
  MIN_FILES,
};
