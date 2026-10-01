#!/usr/bin/env node
'use strict';

/**
 * #5170 (epic #5056, ADR-5057 §4 third and fourth bullets) — gate-evidence drift guard.
 *
 * A gate reads evidence through the typed seam (`src/gate-evidence.cts`: found / none / unreadable)
 * and its exit status follows its verdict through the one exit seam (`src/gate-exit.cts`). This guard
 * fails CI on the next gate that goes back to swallowing a read failure or choosing its own exit
 * code. It parses the sources with `@typescript-eslint/parser` (a real AST, no regex over source) and
 * reports nine shapes:
 *
 *   empty-catch              a `catch` with no statement: the read failure is dropped on the floor
 *   pass-shaped-catch        a `catch` whose every statement returns/assigns a literal (`true`,
 *                            `false`, `null`, `''`, `[]`, `{}`, `undefined`, a number) or does nothing
 *                            but `continue`/`break`: "could not look" collapsed into an answer
 *   read-if-exists           any reference to the deleted tolerant reader `readIfExists`
 *   exists-collapse          `fs.existsSync(...)`, or `fs.statSync`/`lstatSync` inside a `try` whose
 *                            `catch` answers a literal `false`/`null`: a probe that cannot tell
 *                            "absent" from "could not examine" (EACCES on a parent) and collapses
 *                            both to `false`
 *   verb-owns-exit           a gate or a gate verb entry that assigns `process.exitCode`, calls
 *                            `process.exit`, returns a numeric exit, or calls `declareOutcome`
 *                            itself instead of going through `declareGateExit` (src/gate-exit.cts)
 *   unreadable-arm-passes    a verdict builder call returning outcome `pass`/`skip`/`advisory`
 *                            inside the `unreadable` arm of `verdictFromEvidence`, or inside an
 *                            `if`/`case` that tests `kind === 'unreadable'`
 *   verb-catch-no-exit       a gate verb entry whose `catch` prints a payload (`output(...)`) and
 *                            neither declares a gate exit, nor fails through `error(...)`, nor
 *                            rethrows: a swallowed exception that exits 0
 *   verb-no-gate-exit        a gate verb entry that never reaches `declareGateExit`: the verb owns
 *                            its exit (or leaves it to `output()`'s default) instead of declaring it
 *                            from the verdict it built
 *   verdict-owns-exit        any function in `src/` that calls `output()` with a verdict-shaped
 *                            payload (`passed`, `valid`, `all_passed`, `block`, `blocking`,
 *                            `drift_detected`) and assigns `process.exitCode`, without reaching
 *                            `declareGateExit`
 *
 * Gate verb entries are DISCOVERED, never listed by name: every handler the three routers dispatch
 * to (`verify <sub>` -> the `verify.<fn>` calls in `routeVerifyCommand`; `phase uat-passed` -> the
 * `phase.<fn>` call in its handler; `check <verb>` -> the call in each `case` of `routeCheckCommand`),
 * resolved to its definition by name across `src/`. An entry that cannot be found, or a router that
 * yields none, is a problem (an inert scan must not report a clean tree).
 *
 * Hosts: every `src/gate-*.cts`, `src/check-auto-mode.cts`, `src/gap-checker.cts` and
 * `src/decision-coverage-support.cts` ("gate hosts": every rule applies to the whole file), and every
 * other `src/*.cts` that defines a discovered entry or imports `./gate-exit.cjs` ("verb hosts": the
 * rules apply inside the entry functions and the same-file functions they reach). `readIfExists` is
 * searched in every `src/*.cts`; `verdict-owns-exit` in every function in `src/`.
 *
 * The allowlist (`ALLOWLIST`) holds ONE named, justified site: `missingOnDisk` in
 * `finalizeFiles` (src/gate-evaluation-scope.cts). Adding another needs a named, justified entry here
 * and an ADR reference; an entry that matches nothing is itself a problem (a stale allowlist).
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

/**
 * The one site this guard tolerates. A new entry is `{ file, rule, symbol, reason }` (`symbol` is the
 * enclosing function, so a line move does not stale it) with a reason citing an ADR.
 */
const ALLOWLIST = Object.freeze([
  Object.freeze({
    file: 'src/gate-evaluation-scope.cts',
    rule: 'exists-collapse',
    symbol: 'finalizeFiles',
    reason: 'ADR-5057 §4: `missingOnDisk` is the evaluation scope\'s documented, named-by-path answer for a path git reports as changed '
      + 'that is no longer in the work tree (a deletion in the window). The path is never dropped: it is listed by name in `missingOnDisk`, '
      + 'whether it is absent or could not be examined, so the scope never reports a file as reviewed that was not.',
  }),
]);

/** The routers whose dispatch targets are the gate verb entries (discovered, not listed). */
const ROUTERS = Object.freeze([
  Object.freeze({ id: 'verify', file: 'src/verify-command-router.cts', kind: 'member-calls', fn: 'routeVerifyCommand', object: 'verify' }),
  Object.freeze({ id: 'phase', file: 'src/phase-command-router.cts', kind: 'member-calls-in-key', key: 'uat-passed', object: 'phase' }),
  Object.freeze({ id: 'check', file: 'src/check-command-router.cts', kind: 'switch-case-calls', fn: 'routeCheckCommand', exclude: ['error'] }),
]);

const RULES = Object.freeze({
  EMPTY_CATCH: 'empty-catch',
  PASS_SHAPED_CATCH: 'pass-shaped-catch',
  READ_IF_EXISTS: 'read-if-exists',
  EXISTS_COLLAPSE: 'exists-collapse',
  VERB_OWNS_EXIT: 'verb-owns-exit',
  UNREADABLE_ARM_PASSES: 'unreadable-arm-passes',
  VERB_CATCH_NO_EXIT: 'verb-catch-no-exit',
  VERB_NO_GATE_EXIT: 'verb-no-gate-exit',
  VERDICT_OWNS_EXIT: 'verdict-owns-exit',
});

const PASSING_OUTCOMES = Object.freeze(['pass', 'skip', 'advisory']);
const VERDICT_KEYS = Object.freeze(['passed', 'valid', 'all_passed', 'block', 'blocking', 'drift_detected']);
const GATE_EXTRA_FILES = Object.freeze(['src/check-auto-mode.cts', 'src/gap-checker.cts', 'src/decision-coverage-support.cts']);
const EXIT_SEAM_FILES = Object.freeze(['src/gate-exit.cts', 'src/cli-exit.cts']);

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

/** The nearest enclosing function that has a name (the symbol a violation sits in), or null. */
function enclosingSymbol(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (isFunctionNode(ancestors[i])) {
      const name = functionName(ancestors[i], i > 0 ? ancestors[i - 1] : null);
      if (name !== null) return name;
    }
  }
  return null;
}

const callsExitSeamMemo = new WeakMap();

function callsDeclareGateExit(fn) {
  if (callsExitSeamMemo.has(fn)) return callsExitSeamMemo.get(fn);
  const calls = descendants(fn, (n) => isCallTo(n, ['declareGateExit'])).length > 0;
  callsExitSeamMemo.set(fn, calls);
  return calls;
}

/** Is `fn` (with its parent) inside the verb scope: named in `scopeNames`, or itself declaring a gate exit? */
function isScopeFunction(fn, parent, scopeNames) {
  const name = functionName(fn, parent);
  return (name !== null && scopeNames.has(name)) || callsDeclareGateExit(fn);
}

/** Is `ancestors` (the chain above a node) inside a verb-scope function? */
function insideScope(ancestors, scopeNames) {
  for (let i = 0; i < ancestors.length; i += 1) {
    if (isFunctionNode(ancestors[i]) && isScopeFunction(ancestors[i], i > 0 ? ancestors[i - 1] : null, scopeNames)) return true;
  }
  return false;
}

/** The nearest enclosing function is in the verb scope (a return belongs to that function alone). */
function nearestFunctionInScope(ancestors, scopeNames) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (isFunctionNode(ancestors[i])) return isScopeFunction(ancestors[i], i > 0 ? ancestors[i - 1] : null, scopeNames);
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

/** `fs.existsSync(...)` / `x.existsSync(...)` / a bare `existsSync(...)`. */
function isExistsSyncCall(node) {
  return node.type === 'CallExpression' && calleeName(node) === 'existsSync';
}

/** Does a `catch` handler answer a literal `false`/`null`/`undefined` (or nothing at all)? */
function handlerCollapsesToFalse(handler) {
  const statements = handler.body.body;
  if (statements.length === 0) return true;
  if (statements.every(isPassShapedStatement)) return true;
  return statements.some((s) => s.type === 'ReturnStatement' && s.argument !== null
    && ((s.argument.type === 'Literal' && (s.argument.value === false || s.argument.value === null))
      || (s.argument.type === 'Identifier' && s.argument.name === 'undefined')));
}

/** `statSync`/`lstatSync` inside the `try` BLOCK of a try whose catch collapses to a literal answer. */
function isStatInCollapsingTry(node, ancestors) {
  if (node.type !== 'CallExpression' || !['statSync', 'lstatSync'].includes(calleeName(node))) return false;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    if (isFunctionNode(ancestor)) return false;
    if (ancestor.type === 'TryStatement' && ancestor.handler !== null) {
      const child = ancestors[i + 1] ?? node;
      if (child === ancestor.block) return handlerCollapsesToFalse(ancestor.handler);
    }
  }
  return false;
}

/** Is `node` a call to `output()` whose payload carries a verdict-shaped key? `fn` resolves a payload identifier. */
function isVerdictOutputCall(node, fn) {
  if (!isCallTo(node, ['output']) || node.arguments.length === 0) return false;
  const hasVerdictKey = (object) => object.properties.some((p) => p.type === 'Property' && !p.computed
    && ((p.key.type === 'Identifier' && VERDICT_KEYS.includes(p.key.name)) || (p.key.type === 'Literal' && VERDICT_KEYS.includes(p.key.value))));
  const first = node.arguments[0];
  if (first.type === 'ObjectExpression') return hasVerdictKey(first);
  if (first.type === 'Identifier') {
    return descendants(fn, (n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === first.name
      && n.init !== null && n.init.type === 'ObjectExpression' && hasVerdictKey(n.init)).length > 0;
  }
  return false;
}

/**
 * Scan one source text. `hostKinds` is a subset of `['gate', 'verb', 'any']`:
 *   gate  every rule applies to the whole file
 *   verb  the exit/catch/exists rules apply inside the verb scope only: the functions named in
 *         `scopeNames` (the discovered entries and the same-file functions they reach) and any
 *         function that itself calls `declareGateExit`
 *   any   only `read-if-exists`
 * Returns `[{ rule, line, symbol }]`.
 */
function scanText(text, { file, hostKinds, parser, scopeNames = new Set() }) {
  const scope = scopeNames instanceof Set ? scopeNames : new Set(scopeNames);
  const ast = parser.parse(text, { range: true, loc: true, sourceType: 'module', filePath: file });
  const gate = hostKinds.includes('gate');
  const verb = hostKinds.includes('verb');
  const isExitSeam = EXIT_SEAM_FILES.includes(file);
  const violations = [];
  const report = (rule, node, ancestors) => violations.push({ rule, line: lineOf(node), symbol: enclosingSymbol(ancestors) });

  walk(ast, (node, ancestors) => {
    if (node.type === 'Identifier' && node.name === 'readIfExists') report(RULES.READ_IF_EXISTS, node, ancestors);
    if (!gate && !verb) return;
    const inScope = gate || insideScope(ancestors, scope);

    if (node.type === 'CatchClause' && inScope) {
      const statements = node.body.body;
      if (statements.length === 0) report(RULES.EMPTY_CATCH, node, ancestors);
      else if (statements.every(isPassShapedStatement)) report(RULES.PASS_SHAPED_CATCH, node, ancestors);
      if (verb && !gate) {
        const prints = descendants(node.body, (n) => isCallTo(n, ['output'])).length > 0;
        const settles = descendants(node.body, (n) => isCallTo(n, ['declareGateExit', 'error']) || n.type === 'ThrowStatement').length > 0;
        if (prints && !settles) report(RULES.VERB_CATCH_NO_EXIT, node, ancestors);
      }
    }

    if (inScope && (isExistsSyncCall(node) || isStatInCollapsingTry(node, ancestors))) report(RULES.EXISTS_COLLAPSE, node, ancestors);

    if (inScope && !isExitSeam) {
      if (node.type === 'AssignmentExpression' && isProcessMember(node.left, 'exitCode')) report(RULES.VERB_OWNS_EXIT, node, ancestors);
      if (node.type === 'CallExpression' && isProcessMember(node.callee, 'exit')) report(RULES.VERB_OWNS_EXIT, node, ancestors);
      if (isCallTo(node, ['declareOutcome'])) report(RULES.VERB_OWNS_EXIT, node, ancestors);
      if (node.type === 'ReturnStatement' && node.argument !== null && node.argument.type === 'Literal'
        && typeof node.argument.value === 'number' && (gate ? true : nearestFunctionInScope(ancestors, scope))) {
        report(RULES.VERB_OWNS_EXIT, node, ancestors);
      }
    }

    if (gate) {
      if (isCallTo(node, ['verdictFromEvidence']) && node.arguments.length >= 2 && node.arguments[1].type === 'ObjectExpression') {
        for (const property of node.arguments[1].properties) {
          const key = property.type === 'Property' && !property.computed && property.key.type === 'Identifier' ? property.key.name : null;
          if (key === 'unreadable') for (const call of passingVerdictCalls(property.value)) report(RULES.UNREADABLE_ARM_PASSES, call, ancestors);
        }
      }
      if ((node.type === 'IfStatement' || node.type === 'ConditionalExpression') && testsUnreadable(node.test)) {
        for (const call of passingVerdictCalls(node.consequent)) report(RULES.UNREADABLE_ARM_PASSES, call, ancestors);
      }
      if (node.type === 'SwitchCase' && node.test !== null && stringLiteral(node.test) === 'unreadable') {
        for (const statement of node.consequent) for (const call of passingVerdictCalls(statement)) report(RULES.UNREADABLE_ARM_PASSES, call, ancestors);
      }
    }
  });
  return violations;
}

function listSourceFiles(root) {
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

// ─── Entry discovery and the call-closure ────────────────────────────────────────────────────────

/** Every named function in a parsed file: `[{ name, node, file }]`. */
function namedFunctions(parsedFile) {
  const out = [];
  walk(parsedFile.ast, (node, ancestors) => {
    if (!isFunctionNode(node)) return;
    const name = functionName(node, ancestors.length > 0 ? ancestors[ancestors.length - 1] : null);
    if (name !== null) out.push({ name, node, file: parsedFile.file });
  });
  return out;
}

/** The names `fn` calls (an Identifier callee or a member call's property), nested functions included. */
function calleeNames(fn) {
  const names = new Set();
  walk(fn, (n) => {
    if (n.type !== 'CallExpression') return;
    const name = calleeName(n);
    if (name !== null) names.add(name);
  });
  return names;
}

/** Entry names a router dispatches to, by the router's own kind; `null` when the router's shape is not found. */
function routerTargets(router, parsedFile) {
  const targets = new Set();
  const collectMemberCalls = (subtree) => {
    walk(subtree, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
        && n.callee.object.type === 'Identifier' && n.callee.object.name === router.object
        && n.callee.property.type === 'Identifier') targets.add(n.callee.property.name);
    });
  };
  if (router.kind === 'member-calls') {
    const fns = namedFunctions(parsedFile).filter((f) => f.name === router.fn);
    if (fns.length === 0) return null;
    for (const f of fns) collectMemberCalls(f.node);
  } else if (router.kind === 'member-calls-in-key') {
    const props = descendants(parsedFile.ast, (n) => n.type === 'Property' && !n.computed
      && ((n.key.type === 'Literal' && n.key.value === router.key) || (n.key.type === 'Identifier' && n.key.name === router.key)));
    if (props.length === 0) return null;
    for (const p of props) collectMemberCalls(p.value);
  } else if (router.kind === 'switch-case-calls') {
    const fns = namedFunctions(parsedFile).filter((f) => f.name === router.fn);
    if (fns.length === 0) return null;
    for (const f of fns) {
      for (const sc of descendants(f.node, (n) => n.type === 'SwitchCase' && n.test !== null)) {
        for (const statement of sc.consequent) {
          for (const call of descendants(statement, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier')) {
            if (!(router.exclude ?? []).includes(call.callee.name)) targets.add(call.callee.name);
          }
        }
      }
    }
  }
  return targets;
}

/**
 * Scan a set of sources `[{ file, text }]` as one tree: gate hosts, verb hosts and the cross-file
 * rules (entry discovery, the exit closure). `options.routers` is the router table (default `ROUTERS`;
 * a scratch tree that models no router passes `[]`). Returns
 * `{ gateHosts, verbHosts, entries, violations, allowlisted, problems }`.
 */
function scanSources(sources, parser, options = {}) {
  const routers = options.routers ?? ROUTERS;
  const allowlist = options.allowlist ?? ALLOWLIST;
  const parsed = sources.map(({ file, text }) => ({
    file,
    text,
    ast: parser.parse(text, { range: true, loc: true, sourceType: 'module', filePath: file }),
  }));
  const byFile = new Map(parsed.map((p) => [p.file, p]));
  const definitions = new Map();
  for (const p of parsed) {
    for (const fn of namedFunctions(p)) {
      if (!definitions.has(fn.name)) definitions.set(fn.name, []);
      definitions.get(fn.name).push(fn);
    }
  }

  const problems = [];
  const violations = [];

  // Entry discovery: the routers' dispatch targets, resolved by name across the tree.
  const entries = [];
  for (const router of routers) {
    const parsedFile = byFile.get(router.file);
    if (parsedFile === undefined) {
      problems.push(`router ${router.file} was not scanned: its gate verb entries cannot be discovered`);
      continue;
    }
    const targets = routerTargets(router, parsedFile);
    if (targets === null || targets.size === 0) {
      problems.push(`router ${router.file} yielded no gate verb entries (${router.id}): the discovery is inert, which must not report a clean tree`);
      continue;
    }
    for (const name of [...targets].sort()) {
      const defs = definitions.get(name) ?? [];
      if (defs.length === 0) problems.push(`gate verb entry ${name} (${router.id}) has no definition in src/`);
      for (const def of defs) {
        // One entry per definition: a handler two routers dispatch to (the drift gates) is one verb.
        if (!entries.some((e) => e.node === def.node)) entries.push({ router: router.id, name, file: def.file, node: def.node });
      }
    }
  }

  // The exit closure: does a function (by name, across src/) reach `declareGateExit`?
  const reachesExit = (startNode) => {
    const seen = new Set();
    const queue = [startNode];
    while (queue.length > 0) {
      const node = queue.pop();
      if (callsDeclareGateExit(node)) return true;
      for (const name of calleeNames(node)) {
        if (seen.has(name)) continue;
        seen.add(name);
        for (const def of definitions.get(name) ?? []) queue.push(def.node);
      }
    }
    return false;
  };

  for (const entry of entries) {
    if (!reachesExit(entry.node)) {
      violations.push({ file: entry.file, rule: RULES.VERB_NO_GATE_EXIT, line: lineOf(entry.node), symbol: entry.name });
    }
  }

  // verdict-owns-exit: any function that outputs a verdict-shaped payload AND sets the exit itself.
  for (const p of parsed) {
    if (EXIT_SEAM_FILES.includes(p.file)) continue;
    for (const fn of namedFunctions(p)) {
      const outputsVerdict = descendants(fn.node, (n) => isVerdictOutputCall(n, fn.node)).length > 0;
      const setsExit = descendants(fn.node, (n) => n.type === 'AssignmentExpression' && isProcessMember(n.left, 'exitCode')).length > 0;
      if (outputsVerdict && setsExit && !reachesExit(fn.node)) {
        violations.push({ file: p.file, rule: RULES.VERDICT_OWNS_EXIT, line: lineOf(fn.node), symbol: fn.name });
      }
    }
  }

  // Host classification and per-file scanning.
  const gateHosts = [];
  const verbHosts = [];
  for (const p of parsed) {
    const entryNames = entries.filter((e) => e.file === p.file).map((e) => e.name);
    let hostKinds;
    let scopeNames = new Set();
    if (isGateHost(p.file)) {
      hostKinds = ['gate'];
      gateHosts.push(p.file);
    } else if (entryNames.length > 0 || importsExitSeam(p.ast)) {
      hostKinds = ['verb'];
      verbHosts.push(p.file);
      // The verb's own code path: the entries, and the same-file functions they reach (by name) that
      // themselves reach a verdict emission (`output` / `declareGateExit`) — where its reads happen. A
      // leaf helper that never emits (a pure parser, a process reaper) is not the verb's evidence read.
      const local = new Map();
      for (const fn of namedFunctions(p)) {
        if (!local.has(fn.name)) local.set(fn.name, []);
        local.get(fn.name).push(fn);
      }
      const reachableLocal = (start) => {
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length > 0) {
          const name = queue.pop();
          for (const def of local.get(name) ?? []) {
            for (const callee of calleeNames(def.node)) {
              if (local.has(callee) && !seen.has(callee)) {
                seen.add(callee);
                queue.push(callee);
              }
            }
          }
        }
        return seen;
      };
      const emitters = new Set([...local.keys()].filter((name) => local.get(name)
        .some((def) => descendants(def.node, (n) => isCallTo(n, ['output', 'declareGateExit'])).length > 0)));
      const reached = new Set();
      for (const name of entryNames) for (const r of reachableLocal(name)) reached.add(r);
      scopeNames = new Set(entryNames);
      for (const name of reached) {
        if ([...reachableLocal(name)].some((r) => emitters.has(r))) scopeNames.add(name);
      }
    } else {
      hostKinds = ['any'];
    }
    for (const v of scanText(p.text, { file: p.file, hostKinds, parser, scopeNames })) violations.push({ file: p.file, ...v });
  }

  // The allowlist: a violation matching an entry on (file, rule, symbol) is tolerated; an entry that
  // matches nothing is stale and is itself a problem.
  const kept = [];
  const allowlisted = [];
  const used = new Set();
  for (const v of violations) {
    const index = allowlist.findIndex((e) => e.file === v.file && e.rule === v.rule && e.symbol === v.symbol);
    if (index === -1) {
      kept.push(v);
    } else {
      used.add(index);
      allowlisted.push(v);
    }
  }
  allowlist.forEach((e, index) => {
    if (!used.has(index) && routers.length > 0) problems.push(`allowlist entry ${e.file} [${e.rule}] ${e.symbol} matches no violation: remove the stale entry`);
  });

  if (gateHosts.length === 0) problems.push('scanned zero gate hosts: an inert scan must not report a clean tree');
  if (verbHosts.length === 0) problems.push('found zero gate verb hosts (no src/*.cts defines a gate verb entry or imports ./gate-exit.cjs): an inert scan must not report a clean tree');
  return { gateHosts, verbHosts, entries: entries.map(({ router, name, file }) => ({ router, name, file })), violations: kept, allowlisted, problems };
}

/**
 * Scan the tree under `root` (`parser` defaults to the one resolvable from `root`; a test scanning a
 * scratch tree passes the repository's). Returns the `scanSources` result.
 */
function scanRepo(root, parser = loadParser(root), options = {}) {
  const sources = listSourceFiles(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
  return scanSources(sources, parser, options);
}

/**
 * The census the phase publishes: every class of site this guard forbids, counted over the real
 * tree. All counts must be zero (`allowlisted` is the one tolerated, named site).
 */
function census(root = REPO_ROOT, parser = loadParser(root), options = {}) {
  const { gateHosts, verbHosts, entries, violations, allowlisted, problems } = scanRepo(root, parser, options);
  const count = (rule) => violations.filter((v) => v.rule === rule).length;
  return {
    gateHosts: gateHosts.length,
    verbHosts: verbHosts.length,
    entries: entries.length,
    emptyCatches: count(RULES.EMPTY_CATCH),
    passShapedCatches: count(RULES.PASS_SHAPED_CATCH),
    readIfExists: count(RULES.READ_IF_EXISTS),
    existsCollapse: count(RULES.EXISTS_COLLAPSE),
    verbOwnsExit: count(RULES.VERB_OWNS_EXIT),
    unreadableArmPasses: count(RULES.UNREADABLE_ARM_PASSES),
    verbCatchNoExit: count(RULES.VERB_CATCH_NO_EXIT),
    verbNoGateExit: count(RULES.VERB_NO_GATE_EXIT),
    verdictOwnsExit: count(RULES.VERDICT_OWNS_EXIT),
    allowlisted: allowlisted.length,
    total: violations.length,
    problems,
  };
}

function main() {
  const { gateHosts, verbHosts, entries, violations, problems } = scanRepo(REPO_ROOT);
  if (violations.length === 0 && problems.length === 0) {
    process.stdout.write(`ok gate-evidence-drift: ${gateHosts.length} gate hosts, ${verbHosts.length} verb hosts, ${entries.length} gate verb entries\n`);
    return 0;
  }
  process.stderr.write('ERROR gate-evidence-drift: a gate swallows a read failure or chooses its own exit code (ADR-5057 §4, #5170)\n');
  for (const v of violations) process.stderr.write(`  - ${v.file}:${v.line} [${v.rule}]${v.symbol ? ` in ${v.symbol}` : ''}\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write('Read through src/gate-evidence.cts (found / none / unreadable) and exit through declareGateExit (src/gate-exit.cts).\n');
  return 1;
}

if (require.main === module) runMain(main);

module.exports = {
  scanText, scanSources, scanRepo, census, loadParser, RULES, ALLOWLIST, ROUTERS, GATE_EXTRA_FILES, VERDICT_KEYS,
};
