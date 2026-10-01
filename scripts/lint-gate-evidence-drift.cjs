#!/usr/bin/env node
'use strict';

/**
 * #5170 (epic #5056, ADR-5057 §4 third and fourth bullets) — gate-evidence drift guard.
 *
 * A gate reads evidence through the typed seam (`src/gate-evidence.cts`: found / none / unreadable)
 * and its exit status follows its verdict through the one exit seam (`src/gate-exit.cts`). This guard
 * fails CI on the next gate that goes back to swallowing a read failure or choosing its own exit
 * code. It parses the sources with `@typescript-eslint/parser` (a real AST, no regex over source) and
 * reports six shapes:
 *
 *   empty-catch              a `catch` with no statement: the read failure is dropped on the floor
 *   pass-shaped-catch        a `catch` whose every statement returns/assigns a literal (`true`,
 *                            `false`, `null`, `''`, `[]`, `{}`, `undefined`, a number) or does nothing
 *                            but `continue`/`break`: "could not look" collapsed into an answer
 *   read-if-exists           any reference to the deleted tolerant reader `readIfExists`
 *   verb-owns-exit           a gate or a gate verb entry that assigns `process.exitCode`, calls
 *                            `process.exit`, returns a numeric exit, or calls `declareOutcome`
 *                            itself instead of going through `declareGateExit` (src/gate-exit.cts)
 *   unreadable-arm-passes    a verdict builder call returning outcome `pass`/`skip`/`advisory`
 *                            inside the `unreadable` arm of `verdictFromEvidence`, or inside an
 *                            `if`/`case` that tests `kind === 'unreadable'`
 *   verb-catch-no-exit       a gate verb entry whose `catch` prints a payload (`output(...)`) and
 *                            neither declares a gate exit, nor fails through `error(...)`, nor
 *                            rethrows: a swallowed exception that exits 0
 *
 * Hosts: every `src/gate-*.cts`, `src/check-auto-mode.cts`, `src/gap-checker.cts` and
 * `src/decision-coverage-support.cts` ("gate hosts": every rule applies to the whole file), and every
 * other `src/*.cts` that imports `./gate-exit.cjs` ("verb hosts": the rules apply inside the gate verb
 * entry functions — those that call `declareGateExit`, or are named in `VERB_ENTRY_NAMES`).
 * `readIfExists` is searched in every `src/*.cts`.
 *
 * The allowlist is EMPTY on purpose (`ALLOWLIST`): there is no site this guard tolerates. Adding
 * one needs a named, justified entry here and an ADR reference.
 *
 * Fail-closed: scanning zero gate hosts, or a host the parser cannot read, is a violation — an
 * inert scan must not report a clean tree. `census(root)` re-measures the tree and is asserted zero
 * by tests/lint-gate-evidence-drift.test.cjs; the positive controls are the fixtures under
 * tests/fixtures/gate-evidence-drift/ (each must be flagged, the clean one must not).
 */

const fs = require('node:fs');
const path = require('node:path');
const { runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GATE_EXIT_MODULE = './gate-exit.cjs';

/** No site is tolerated. A new entry is `{ file, rule, line, reason }` with the reason citing an ADR. */
const ALLOWLIST = Object.freeze([]);

/** Gate verb entries that do not call `declareGateExit` today but must still not own an exit. */
const VERB_ENTRY_NAMES = Object.freeze([
  'cmdPhaseUatPassed', 'cmdVerifyArtifacts', 'cmdVerifySchemaDrift', 'runVerifySchemaDrift', 'emitGateResult',
]);

const RULES = Object.freeze({
  EMPTY_CATCH: 'empty-catch',
  PASS_SHAPED_CATCH: 'pass-shaped-catch',
  READ_IF_EXISTS: 'read-if-exists',
  VERB_OWNS_EXIT: 'verb-owns-exit',
  UNREADABLE_ARM_PASSES: 'unreadable-arm-passes',
  VERB_CATCH_NO_EXIT: 'verb-catch-no-exit',
});

const PASSING_OUTCOMES = Object.freeze(['pass', 'skip', 'advisory']);
const GATE_EXTRA_FILES = Object.freeze(['src/check-auto-mode.cts', 'src/gap-checker.cts', 'src/decision-coverage-support.cts']);
const EXIT_SEAM_FILE = 'src/gate-exit.cts';

function loadParser(root) {
  return require(require.resolve('@typescript-eslint/parser', { paths: [root] }));
}

function isNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

/** Depth-first walk; `visit(node, ancestors)` where `ancestors` is the chain above `node`. */
function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, next);
    } else if (isNode(value)) {
      walk(value, visit, next);
    }
  }
}

function descendants(node, predicate) {
  const found = [];
  walk(node, (n) => { if (predicate(n)) found.push(n); });
  return found;
}

function calleeName(call) {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

function isCallTo(node, names) {
  return node.type === 'CallExpression' && names.includes(calleeName(node));
}

function isProcessMember(node, property) {
  return node.type === 'MemberExpression' && !node.computed
    && node.object.type === 'Identifier' && node.object.name === 'process'
    && node.property.type === 'Identifier' && node.property.name === property;
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/** The name a function is known by: its own id, the variable it is assigned to, or its property key. */
function functionName(fn, parent) {
  if (fn.id && fn.id.type === 'Identifier') return fn.id.name;
  if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent && (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    && !parent.computed && parent.key.type === 'Identifier') return parent.key.name;
  return null;
}

const entryMemo = new WeakMap();

function isEntryFunction(fn, parent) {
  if (entryMemo.has(fn)) return entryMemo.get(fn);
  const name = functionName(fn, parent);
  const entry = (name !== null && VERB_ENTRY_NAMES.includes(name))
    || descendants(fn, (n) => isCallTo(n, ['declareGateExit'])).length > 0;
  entryMemo.set(fn, entry);
  return entry;
}

/** Is `ancestors` (the chain above a node) inside a gate verb entry function? */
function insideEntry(ancestors) {
  for (let i = 0; i < ancestors.length; i += 1) {
    const node = ancestors[i];
    if (isFunctionNode(node) && isEntryFunction(node, i > 0 ? ancestors[i - 1] : null)) return true;
  }
  return false;
}

/** The nearest enclosing function is a gate verb entry (a return belongs to that function alone). */
function nearestFunctionIsEntry(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (isFunctionNode(ancestors[i])) return isEntryFunction(ancestors[i], i > 0 ? ancestors[i - 1] : null);
  }
  return false;
}

function isPassShapedExpression(node) {
  if (node.type === 'Literal') return true;
  if (node.type === 'Identifier') return node.name === 'undefined';
  if (node.type === 'ArrayExpression') return node.elements.length === 0;
  if (node.type === 'ObjectExpression') return node.properties.length === 0;
  if (node.type === 'TemplateLiteral') return node.expressions.length === 0;
  if (node.type === 'UnaryExpression') return isPassShapedExpression(node.argument);
  return false;
}

function isPassShapedStatement(statement) {
  switch (statement.type) {
    case 'EmptyStatement':
    case 'ContinueStatement':
    case 'BreakStatement':
      return true;
    case 'ReturnStatement':
      return statement.argument === null || isPassShapedExpression(statement.argument);
    case 'ExpressionStatement':
      return statement.expression.type === 'AssignmentExpression' && isPassShapedExpression(statement.expression.right);
    default:
      return false;
  }
}

function stringLiteral(node) {
  return node !== undefined && node !== null && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** `gateVerdict('pass' | 'skip' | 'advisory', ...)` calls inside `subtree`. */
function passingVerdictCalls(subtree) {
  return descendants(subtree, (n) => isCallTo(n, ['gateVerdict']) && PASSING_OUTCOMES.includes(stringLiteral(n.arguments[0])));
}

/** Does `test` compare something to the string `'unreadable'` (`x.kind === 'unreadable'`)? */
function testsUnreadable(test) {
  return descendants(test, (n) => n.type === 'BinaryExpression'
    && (n.operator === '===' || n.operator === '==')
    && (stringLiteral(n.left) === 'unreadable' || stringLiteral(n.right) === 'unreadable')).length > 0;
}

function lineOf(node) {
  return node.loc.start.line;
}

/**
 * Scan one source text. `hostKinds` is a subset of `['gate', 'verb', 'any']`:
 *   gate  every rule applies to the whole file
 *   verb  the exit/catch rules apply inside gate verb entry functions only
 *   any   only `read-if-exists`
 * Returns `[{ rule, line }]`.
 */
function scanText(text, { file, hostKinds, parser }) {
  const ast = parser.parse(text, { range: true, loc: true, sourceType: 'module', filePath: file });
  const gate = hostKinds.includes('gate');
  const verb = hostKinds.includes('verb');
  const isExitSeam = file === EXIT_SEAM_FILE;
  const violations = [];
  const report = (rule, node) => violations.push({ rule, line: lineOf(node) });

  walk(ast, (node, ancestors) => {
    if (node.type === 'Identifier' && node.name === 'readIfExists') report(RULES.READ_IF_EXISTS, node);
    if (!gate && !verb) return;
    const inScope = gate || insideEntry(ancestors);

    if (node.type === 'CatchClause' && inScope) {
      const statements = node.body.body;
      if (statements.length === 0) report(RULES.EMPTY_CATCH, node);
      else if (statements.every(isPassShapedStatement)) report(RULES.PASS_SHAPED_CATCH, node);
      if (verb && !gate) {
        const prints = descendants(node.body, (n) => isCallTo(n, ['output'])).length > 0;
        const settles = descendants(node.body, (n) => isCallTo(n, ['declareGateExit', 'error']) || n.type === 'ThrowStatement').length > 0;
        if (prints && !settles) report(RULES.VERB_CATCH_NO_EXIT, node);
      }
    }

    if (inScope && !isExitSeam) {
      if (node.type === 'AssignmentExpression' && isProcessMember(node.left, 'exitCode')) report(RULES.VERB_OWNS_EXIT, node);
      if (node.type === 'CallExpression' && isProcessMember(node.callee, 'exit')) report(RULES.VERB_OWNS_EXIT, node);
      if (isCallTo(node, ['declareOutcome'])) report(RULES.VERB_OWNS_EXIT, node);
      if (node.type === 'ReturnStatement' && node.argument !== null && node.argument.type === 'Literal'
        && typeof node.argument.value === 'number' && (gate ? true : nearestFunctionIsEntry(ancestors))) {
        report(RULES.VERB_OWNS_EXIT, node);
      }
    }

    if (gate) {
      if (isCallTo(node, ['verdictFromEvidence']) && node.arguments.length >= 2 && node.arguments[1].type === 'ObjectExpression') {
        for (const property of node.arguments[1].properties) {
          const key = property.type === 'Property' && !property.computed && property.key.type === 'Identifier' ? property.key.name : null;
          if (key === 'unreadable') for (const call of passingVerdictCalls(property.value)) report(RULES.UNREADABLE_ARM_PASSES, call);
        }
      }
      if ((node.type === 'IfStatement' || node.type === 'ConditionalExpression') && testsUnreadable(node.test)) {
        for (const call of passingVerdictCalls(node.consequent)) report(RULES.UNREADABLE_ARM_PASSES, call);
      }
      if (node.type === 'SwitchCase' && node.test !== null && stringLiteral(node.test) === 'unreadable') {
        for (const statement of node.consequent) for (const call of passingVerdictCalls(statement)) report(RULES.UNREADABLE_ARM_PASSES, call);
      }
    }
  });
  return violations;
}

function sourceFiles(root) {
  const dir = path.join(root, 'src');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cts'))
    .map((entry) => `src/${entry.name}`)
    .sort();
}

function isGateHost(file) {
  return /^src\/gate-[^/]+\.cts$/.test(file) || GATE_EXTRA_FILES.includes(file);
}

function importsExitSeam(ast) {
  return ast.body.some((node) => (node.type === 'ImportDeclaration' && node.source.value === GATE_EXIT_MODULE)
    || (node.type === 'TSImportEqualsDeclaration'
      && node.moduleReference.type === 'TSExternalModuleReference'
      && node.moduleReference.expression.value === GATE_EXIT_MODULE));
}

/**
 * Scan the tree under `root` (`parser` defaults to the one resolvable from `root`; a test scanning a
 * scratch tree passes the repository's). Returns `{ gateHosts, verbHosts, violations, problems }`.
 */
function scanRepo(root, parser = loadParser(root)) {
  const gateHosts = [];
  const verbHosts = [];
  const violations = [];
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    let hostKinds;
    if (isGateHost(file)) {
      hostKinds = ['gate'];
      gateHosts.push(file);
    } else if (importsExitSeam(parser.parse(text, { range: true, loc: true, sourceType: 'module', filePath: file }))) {
      hostKinds = ['verb'];
      verbHosts.push(file);
    } else {
      hostKinds = ['any'];
    }
    for (const v of scanText(text, { file, hostKinds, parser })) violations.push({ file, ...v });
  }
  const allowed = new Set(ALLOWLIST.map((e) => `${e.file}::${e.rule}::${e.line}`));
  const kept = violations.filter((v) => !allowed.has(`${v.file}::${v.rule}::${v.line}`));
  const problems = [];
  if (gateHosts.length === 0) problems.push('scanned zero gate hosts: an inert scan must not report a clean tree');
  if (verbHosts.length === 0) problems.push('found zero gate verb hosts (no src/*.cts imports ./gate-exit.cjs): an inert scan must not report a clean tree');
  return { gateHosts, verbHosts, violations: kept, problems };
}

/**
 * The census the phase publishes: every class of site this guard forbids, counted over the real
 * tree. All counts must be zero.
 */
function census(root = REPO_ROOT, parser = loadParser(root)) {
  const { gateHosts, verbHosts, violations, problems } = scanRepo(root, parser);
  const count = (rule) => violations.filter((v) => v.rule === rule).length;
  return {
    gateHosts: gateHosts.length,
    verbHosts: verbHosts.length,
    emptyCatches: count(RULES.EMPTY_CATCH),
    passShapedCatches: count(RULES.PASS_SHAPED_CATCH),
    readIfExists: count(RULES.READ_IF_EXISTS),
    verbOwnsExit: count(RULES.VERB_OWNS_EXIT),
    unreadableArmPasses: count(RULES.UNREADABLE_ARM_PASSES),
    verbCatchNoExit: count(RULES.VERB_CATCH_NO_EXIT),
    total: violations.length,
    problems,
  };
}

function main() {
  const { gateHosts, verbHosts, violations, problems } = scanRepo(REPO_ROOT);
  if (violations.length === 0 && problems.length === 0) {
    process.stdout.write(`ok gate-evidence-drift: ${gateHosts.length} gate hosts, ${verbHosts.length} verb hosts\n`);
    return 0;
  }
  process.stderr.write('ERROR gate-evidence-drift: a gate swallows a read failure or chooses its own exit code (ADR-5057 §4, #5170)\n');
  for (const v of violations) process.stderr.write(`  - ${v.file}:${v.line} [${v.rule}]\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write('Read through src/gate-evidence.cts (found / none / unreadable) and exit through declareGateExit (src/gate-exit.cts).\n');
  return 1;
}

if (require.main === module) runMain(main);

module.exports = {
  scanText, scanRepo, census, loadParser, RULES, ALLOWLIST, VERB_ENTRY_NAMES, GATE_EXTRA_FILES,
};
