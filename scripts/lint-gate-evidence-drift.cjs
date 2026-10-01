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
 *   pass-shaped-catch        a `catch` that neither rethrows nor produces unreadable evidence/verdict
 *                            (a call to `evidenceFromError` / `evidenceUnreadable` / `gateUnreadable` /
 *                            `error`, anything named `*unreadable*`, or `kind: 'unreadable'`): `return
 *                            ''`, `return EMPTY_CONST`, `void err; return null`, an assignment then a
 *                            return — "could not look" collapsed into an answer, whatever the spelling
 *   read-if-exists           any reference to the deleted tolerant reader `readIfExists`
 *   exists-collapse          `fs.existsSync(...)` (written `fs['existsSync']`, destructured
 *                            `const { existsSync } = fs`, aliased `import { existsSync as e }` or
 *                            `const e = fs.existsSync` too), or `statSync`/`lstatSync` (same
 *                            spellings) inside a `try` whose `catch` does not rethrow or produce
 *                            unreadable evidence: a probe that cannot tell "absent" from "could not
 *                            examine" (EACCES on a parent) and collapses both to `false`
 *   verb-owns-exit           a gate or a gate verb entry that assigns `process.exitCode`, calls
 *                            `process.exit`, returns a numeric exit, or calls `declareOutcome`
 *                            itself instead of going through `declareGateExit` (src/gate-exit.cts)
 *   unreadable-arm-passes    the `unreadable` arm of a gate — `verdictFromEvidence`'s `unreadable`
 *                            arm, the body of `kind === 'unreadable'`, the ELSE of `kind !==
 *                            'unreadable'` (and the statements after an early-returning one), a
 *                            `kind !== 'found'` branch, a `case 'unreadable'` (through its
 *                            fall-through), the `default` of a switch that already handled `found`
 *                            and `none`, the final `else` of a chain that did — builds a verdict whose
 *                            outcome is not the literal `'unreadable'` (a `pass`/`skip`/`advisory`, or
 *                            a variable the guard cannot prove), directly or through a same-file helper
 *   verb-catch-no-exit       a gate verb entry whose `catch` prints a payload (`output(...)`) and
 *                            neither declares a gate exit, nor fails through `error(...)`, nor
 *                            rethrows: a swallowed exception that exits 0
 *   verb-no-gate-exit        a gate verb entry on which SOME return path (or the fall-through end)
 *                            does not go through `declareGateExit`/`error`/a throw — the original
 *                            #4686 shape is `output({ error }); return;` beside a branch that emits
 *                            through the seam. Helper closures are resolved per file and symbol (the
 *                            same file, then its imports), never by bare name across `src/`
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
const FS_MODULES = Object.freeze(['fs', 'node:fs']);

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

const VERDICT_KEYS = Object.freeze(['passed', 'valid', 'all_passed', 'block', 'blocking', 'drift_detected']);
const GATE_EXTRA_FILES = Object.freeze(['src/check-auto-mode.cts', 'src/gap-checker.cts', 'src/decision-coverage-support.cts']);
const EXIT_SEAM_FILES = Object.freeze(['src/gate-exit.cts', 'src/cli-exit.cts']);
/** Calls that take a read failure and turn it into typed evidence, a typed failure, or a failing exit. */
const HANDLING_CALLS = Object.freeze(['evidenceFromError', 'evidenceUnreadable', 'gateUnreadable', 'gateUsageFailure', 'classifyFailure', 'declareGateExit', 'error']);
const UNREADABLE_NAME_RE = /unreadable/i;

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

function stringLiteral(node) {
  return node !== undefined && node !== null && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** The property a member expression names: `a.b`, `a['b']` and a substitution-free template `a[`b`]`. */
function memberName(node) {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const literal = stringLiteral(node.property);
  if (literal !== null) return literal;
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) return node.property.quasis[0].value.cooked;
  return null;
}

/** The expression a call actually invokes: `(0, f)(x)`, `f.call(t, x)`, `f.apply(t, xs)` and `f!(x)` resolve to `f`. */
function unwrapCallee(callee) {
  let current = callee;
  for (;;) {
    if (current.type === 'SequenceExpression') {
      current = current.expressions[current.expressions.length - 1];
    } else if (current.type === 'TSNonNullExpression' || current.type === 'TSAsExpression') {
      current = current.expression;
    } else if (current.type === 'MemberExpression' && ['call', 'apply'].includes(memberName(current)) && isNode(current.object)
      && (current.object.type === 'MemberExpression' || current.object.type === 'Identifier')) {
      current = current.object;
    } else {
      return current;
    }
  }
}

function calleeName(call) {
  const callee = unwrapCallee(call.callee);
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') return memberName(callee);
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

function lineOf(node) {
  return node.loc.start.line;
}

// ─── catch handling ──────────────────────────────────────────────────────────────────────────────

/**
 * Does a `catch` handler rethrow, or turn the failure into unreadable evidence / an unreadable verdict /
 * a failing exit? Anything else — `return ''`, `return EMPTY`, `void err`, an assignment then a return,
 * a call that merely records the error somewhere — answers "could not look" with a value.
 */
function catchHandles(handler) {
  return descendants(handler.body, (n) => n.type === 'ThrowStatement'
    || (n.type === 'CallExpression' && (HANDLING_CALLS.includes(calleeName(n)) || UNREADABLE_NAME_RE.test(calleeName(n) ?? '')))
    || (n.type === 'Identifier' && UNREADABLE_NAME_RE.test(n.name))
    || (n.type === 'Literal' && n.value === 'unreadable')).length > 0;
}

// ─── fs aliasing (exists-collapse) ───────────────────────────────────────────────────────────────

/**
 * The local names bound to `fs.existsSync` and `fs.statSync`/`fs.lstatSync` in a file: a named import
 * (`import { existsSync as e } from 'node:fs'`), a destructuring of the module or of a namespace bound
 * to it (`const { existsSync } = fs`), or an alias assignment (`const e = fs.existsSync`).
 */
function collectFsAliases(ast) {
  const namespaces = new Set();
  const exists = new Set();
  const stat = new Set();
  const bind = (member, local) => {
    if (member === 'existsSync') exists.add(local);
    else if (member === 'statSync' || member === 'lstatSync') stat.add(local);
  };
  const isFsRequire = (n) => n !== null && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require'
    && n.arguments.length === 1 && FS_MODULES.includes(stringLiteral(n.arguments[0]));
  const isFsNamespace = (n) => n !== null && ((n.type === 'Identifier' && namespaces.has(n.name)) || isFsRequire(n));
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration' && FS_MODULES.includes(n.source.value)) {
      for (const specifier of n.specifiers) {
        if (specifier.type === 'ImportSpecifier') bind(specifier.imported.name ?? specifier.imported.value, specifier.local.name);
        else namespaces.add(specifier.local.name);
      }
    }
    if (n.type === 'TSImportEqualsDeclaration' && n.moduleReference.type === 'TSExternalModuleReference'
      && FS_MODULES.includes(n.moduleReference.expression.value)) namespaces.add(n.id.name);
  });
  // Aliases of aliases settle in a few passes (`const f2 = fs; const { existsSync: e } = f2;`).
  for (let pass = 0; pass < 3; pass += 1) {
    walk(ast, (n) => {
      if (n.type !== 'VariableDeclarator' || n.init === null) return;
      if (isFsNamespace(n.init)) {
        if (n.id.type === 'Identifier') namespaces.add(n.id.name);
        else if (n.id.type === 'ObjectPattern') {
          for (const p of n.id.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = p.key.type === 'Identifier' ? p.key.name : stringLiteral(p.key);
            const local = p.value.type === 'Identifier' ? p.value.name : (p.value.type === 'AssignmentPattern' && p.value.left.type === 'Identifier' ? p.value.left.name : null);
            if (key !== null && local !== null) bind(key, local);
          }
        }
      } else if (n.init.type === 'MemberExpression' && isFsNamespace(n.init.object) && n.id.type === 'Identifier') {
        const member = memberName(n.init);
        if (member !== null) bind(member, n.id.name);
      }
    });
  }
  return { exists, stat };
}

function isExistsSyncCall(node, aliases) {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrapCallee(node.callee);
  return calleeName(node) === 'existsSync' || (callee.type === 'Identifier' && aliases.exists.has(callee.name));
}

function isStatCall(node, aliases) {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrapCallee(node.callee);
  return ['statSync', 'lstatSync'].includes(calleeName(node)) || (callee.type === 'Identifier' && aliases.stat.has(callee.name));
}

/** `statSync`/`lstatSync` inside the `try` BLOCK of a try whose catch neither rethrows nor produces unreadable evidence. */
function isStatInCollapsingTry(node, ancestors, aliases) {
  if (!isStatCall(node, aliases)) return false;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    if (isFunctionNode(ancestor)) return false;
    if (ancestor.type === 'TryStatement' && ancestor.handler !== null) {
      const child = ancestors[i + 1] ?? node;
      if (child === ancestor.block) return !catchHandles(ancestor.handler);
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

// ─── unreadable arms ─────────────────────────────────────────────────────────────────────────────

/** Does `test` compare something with `operators` to the string `value` (`x.kind === 'unreadable'`)? */
function comparesTo(test, operators, value) {
  return descendants(test, (n) => n.type === 'BinaryExpression' && operators.includes(n.operator)
    && (stringLiteral(n.left) === value || stringLiteral(n.right) === value)).length > 0;
}

const EQUALS = Object.freeze(['===', '==']);
const NOT_EQUALS = Object.freeze(['!==', '!=']);

/** Does `test` negate an equality with `value` (`!(x.kind === 'found')`)? */
function negatesEquality(test, value) {
  return descendants(test, (n) => n.type === 'UnaryExpression' && n.operator === '!' && comparesTo(n.argument, EQUALS, value)).length > 0;
}

/** Does the statement end every path with a return/throw/break/continue? */
function terminates(statement) {
  if (statement === null || statement === undefined) return false;
  if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(statement.type)) return true;
  if (statement.type === 'BlockStatement') return statement.body.length > 0 && terminates(statement.body[statement.body.length - 1]);
  if (statement.type === 'IfStatement') return statement.alternate !== null && terminates(statement.consequent) && terminates(statement.alternate);
  return false;
}

/** The subtree each `if` / `?:` / `&&` / `||` branch is when the discriminant is `unreadable`. */
function conditionalArms(node, ancestors) {
  const arms = [];
  const isIf = node.type === 'IfStatement';
  const isTernary = node.type === 'ConditionalExpression';
  if (isIf || isTernary) {
    const test = node.test;
    if (comparesTo(test, EQUALS, 'unreadable')) arms.push(node.consequent);
    if (comparesTo(test, NOT_EQUALS, 'found') || negatesEquality(test, 'found')) arms.push(node.consequent);
    if (comparesTo(test, NOT_EQUALS, 'unreadable') && node.alternate !== null) arms.push(node.alternate);
    if (isIf) {
      // The final `else` of a chain that already handled `found` and `none` is the `unreadable` arm.
      const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
      const isChainHead = !(parent !== null && parent.type === 'IfStatement' && parent.alternate === node);
      if (isChainHead) {
        const tests = [];
        let link = node;
        while (link.type === 'IfStatement') {
          tests.push(link.test);
          if (link.alternate === null) break;
          if (link.alternate.type !== 'IfStatement') {
            const handled = (value) => tests.some((t) => comparesTo(t, EQUALS, value));
            if (handled('found') && handled('none')) arms.push(link.alternate);
            break;
          }
          link = link.alternate;
        }
      }
    }
  } else if (node.type === 'LogicalExpression') {
    if (node.operator === '&&' && comparesTo(node.left, EQUALS, 'unreadable')) arms.push(node.right);
    if (node.operator === '||' && comparesTo(node.left, NOT_EQUALS, 'unreadable')) arms.push(node.right);
  }
  return arms;
}

/** The statements after an early-returning `if (x.kind !== 'unreadable') { ...return }` in one statement list. */
function earlyReturnArms(statements) {
  const arms = [];
  statements.forEach((statement, index) => {
    if (statement.type === 'IfStatement' && statement.alternate === null && terminates(statement.consequent)
      && (comparesTo(statement.test, NOT_EQUALS, 'unreadable'))) {
      arms.push({ type: 'BlockStatement', body: statements.slice(index + 1) });
    }
  });
  return arms;
}

/** The `case 'unreadable'` arms of a switch (through fall-through), and the `default` of one that handled `found` and `none`. */
function switchArms(node) {
  const arms = [];
  const cases = node.cases;
  const throughFallThrough = (from) => {
    const body = [];
    for (let j = from; j < cases.length; j += 1) {
      body.push(...cases[j].consequent);
      const last = cases[j].consequent[cases[j].consequent.length - 1];
      if (cases[j].consequent.length > 0 && terminates(last)) break;
    }
    return { type: 'BlockStatement', body };
  };
  const labels = cases.map((c) => (c.test === null ? null : stringLiteral(c.test)));
  cases.forEach((c, index) => {
    if (labels[index] === 'unreadable') arms.push(throughFallThrough(index));
    if (c.test === null && labels.includes('found') && labels.includes('none')) arms.push(throughFallThrough(index));
  });
  return arms;
}

/**
 * Every `gateVerdict(...)` call in `subtree` whose outcome is not the literal `'unreadable'` — a
 * `pass`/`skip`/`advisory`, or a variable/alias the guard cannot prove — directly or through a
 * same-file helper the subtree calls (`defs`: the file's named functions).
 */
function armVerdictCalls(subtree, defs, seen = new Set()) {
  const bad = [];
  walk(subtree, (n) => {
    if (n.type !== 'CallExpression') return;
    if (isCallTo(n, ['gateVerdict'])) {
      if (stringLiteral(n.arguments[0]) !== 'unreadable') bad.push(n);
      return;
    }
    const name = calleeName(n);
    if (name === null) return;
    for (const def of defs.get(name) ?? []) {
      if (seen.has(def)) continue;
      seen.add(def);
      if (armVerdictCalls(def, defs, seen).length > 0) bad.push(n);
    }
  });
  return bad;
}

/** The named functions of one parsed AST, by name: `Map<name, node[]>` (closures included). */
function localDefinitions(ast) {
  const defs = new Map();
  walk(ast, (node, ancestors) => {
    if (!isFunctionNode(node)) return;
    const name = functionName(node, ancestors.length > 0 ? ancestors[ancestors.length - 1] : null);
    if (name === null) return;
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push(node);
  });
  return defs;
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
  const aliases = collectFsAliases(ast);
  const defs = gate ? localDefinitions(ast) : new Map();

  const reportArm = (arm, ancestors) => {
    for (const call of armVerdictCalls(arm, defs)) report(RULES.UNREADABLE_ARM_PASSES, call, ancestors);
  };

  walk(ast, (node, ancestors) => {
    if (node.type === 'Identifier' && node.name === 'readIfExists') report(RULES.READ_IF_EXISTS, node, ancestors);
    if (!gate && !verb) return;
    const inScope = gate || insideScope(ancestors, scope);

    if (node.type === 'CatchClause' && inScope) {
      const statements = node.body.body;
      if (statements.length === 0) report(RULES.EMPTY_CATCH, node, ancestors);
      else if (!catchHandles(node)) report(RULES.PASS_SHAPED_CATCH, node, ancestors);
      if (verb && !gate) {
        const prints = descendants(node.body, (n) => isCallTo(n, ['output'])).length > 0;
        const settles = descendants(node.body, (n) => isCallTo(n, ['declareGateExit', 'error']) || n.type === 'ThrowStatement').length > 0;
        if (prints && !settles) report(RULES.VERB_CATCH_NO_EXIT, node, ancestors);
      }
    }

    if (inScope && (isExistsSyncCall(node, aliases) || isStatInCollapsingTry(node, ancestors, aliases))) report(RULES.EXISTS_COLLAPSE, node, ancestors);

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
          if (key !== 'unreadable') continue;
          if (property.value.type === 'Identifier') {
            for (const def of defs.get(property.value.name) ?? []) reportArm(def, ancestors);
          } else {
            reportArm(property.value, ancestors);
          }
        }
      }
      for (const arm of conditionalArms(node, ancestors)) reportArm(arm, ancestors);
      if (node.type === 'SwitchStatement') for (const arm of switchArms(node)) reportArm(arm, ancestors);
      if (node.type === 'BlockStatement' || node.type === 'Program') for (const arm of earlyReturnArms(node.body)) reportArm(arm, ancestors);
      if (node.type === 'SwitchCase') for (const arm of earlyReturnArms(node.consequent)) reportArm(arm, ancestors);
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

// ─── Per-file call resolution and the all-paths exit analysis ────────────────────────────────────

/** `./x.cjs` -> `src/x.cts`; null for anything that is not a relative source module. */
function moduleToFile(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('./')) return null;
  return `src/${specifier.slice(2).replace(/\.[cm]?[jt]s$/, '')}.cts`;
}

/** What a file imports: `names` (local -> { module, name }) and `namespaces` (local -> module). */
function importInfo(ast) {
  const names = new Map();
  const namespaces = new Map();
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration' && typeof n.source.value === 'string') {
      for (const specifier of n.specifiers) {
        if (specifier.type === 'ImportSpecifier') names.set(specifier.local.name, { module: n.source.value, name: specifier.imported.name ?? specifier.imported.value });
        else namespaces.set(specifier.local.name, n.source.value);
      }
    }
    if (n.type === 'TSImportEqualsDeclaration' && n.moduleReference.type === 'TSExternalModuleReference') {
      namespaces.set(n.id.name, n.moduleReference.expression.value);
    }
  });
  walk(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.init === null) return;
    if (n.init.type === 'Identifier' && namespaces.has(n.init.name) && n.id.type === 'ObjectPattern') {
      for (const p of n.id.properties) {
        if (p.type !== 'Property' || p.computed) continue;
        const key = p.key.type === 'Identifier' ? p.key.name : stringLiteral(p.key);
        const local = p.value.type === 'Identifier' ? p.value.name : null;
        if (key !== null && local !== null) names.set(local, { module: namespaces.get(n.init.name), name: key });
      }
    } else if (n.init.type === 'MemberExpression' && n.init.object.type === 'Identifier' && namespaces.has(n.init.object.name) && n.id.type === 'Identifier') {
      const member = memberName(n.init);
      if (member !== null) names.set(n.id.name, { module: namespaces.get(n.init.object.name), name: member });
    }
  });
  return { names, namespaces };
}

/**
 * The program: `Map<file, { file, defs, imports }>`. A call is resolved against its OWN file first (its
 * named functions and closures), then through that file's imports to the file they name — never by a
 * bare name across the whole tree, so an unrelated `emit` elsewhere cannot make a verb look settled.
 */
function buildProgram(parsed) {
  const program = new Map();
  for (const p of parsed) program.set(p.file, { file: p.file, defs: localDefinitions(p.ast), imports: importInfo(p.ast) });
  return program;
}

/** `[{ node, info }]` the call may invoke, or null when the callee is not a function the tree defines. */
function resolveCall(call, info, program) {
  const callee = unwrapCallee(call.callee);
  const inFile = (target, name) => (target?.defs.get(name) ?? []).map((node) => ({ node, info: target }));
  if (callee.type === 'Identifier') {
    const local = inFile(info, callee.name);
    if (local.length > 0) return local;
    const imported = info.imports.names.get(callee.name);
    if (imported !== undefined) {
      const found = inFile(program.get(moduleToFile(imported.module)), imported.name);
      if (found.length > 0) return found;
    }
    return null;
  }
  if (callee.type === 'MemberExpression') {
    const name = memberName(callee);
    if (name === null) return null;
    if (callee.object.type === 'Identifier' && info.imports.namespaces.has(callee.object.name)) {
      const found = inFile(program.get(moduleToFile(info.imports.namespaces.get(callee.object.name))), name);
      return found.length > 0 ? found : null;
    }
    const local = inFile(info, name);
    return local.length > 0 ? local : null;
  }
  return null;
}

function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) children.push(child);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/**
 * The exit analysis. A call SETTLES when it is `declareGateExit`, `error` (which fails the command
 * itself), or resolves — in its own file, then through its imports — to functions that settle on EVERY
 * path. A function settles when every `return` and its fall-through end is preceded by a settling call
 * on that path (a `throw` ends a path without needing one: the exception reaches the runner).
 */
function createExitAnalysis(program) {
  const memo = new Map();
  const inProgress = new Set();

  const callSettles = (call, info) => {
    const name = calleeName(call);
    if (name === 'declareGateExit') return true;
    // `error(...)` is the io module's failing exit unless the file defines an `error` of its own.
    if (name === 'error' && unwrapCallee(call.callee).type === 'Identifier' && !info.defs.has('error')) return true;
    const targets = resolveCall(call, info, program);
    return targets !== null && targets.every((t) => alwaysSettles(t.node, t.info));
  };

  const exprSettles = (node, info) => {
    if (!isNode(node)) return false;
    switch (node.type) {
      case 'CallExpression':
        if (callSettles(node, info)) return true;
        return exprSettles(node.callee, info) || node.arguments.some((a) => exprSettles(a, info));
      case 'ConditionalExpression':
        return exprSettles(node.test, info) || (exprSettles(node.consequent, info) && exprSettles(node.alternate, info));
      case 'LogicalExpression':
        return exprSettles(node.left, info);
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration':
        return false;
      default:
        return childNodes(node).some((child) => exprSettles(child, info));
    }
  };

  // flow(statement, settled) -> { settled, ends }: `ends` = no normal completion (return/throw).
  // `bad` collects the line of every return reached while unsettled.
  const flowList = (statements, settled, info, bad) => {
    let state = settled;
    for (const statement of statements) {
      const result = flowStatement(statement, state, info, bad);
      if (result.ends) return { settled: state, ends: true };
      state = result.settled;
      if (['BreakStatement', 'ContinueStatement'].includes(statement.type)) break;
    }
    return { settled: state, ends: false };
  };

  const merge = (results, fallback) => {
    const live = results.filter((r) => !r.ends);
    if (live.length === 0) return { settled: fallback, ends: results.length > 0 };
    return { settled: live.every((r) => r.settled), ends: false };
  };

  const flowStatement = (statement, settled, info, bad) => {
    switch (statement.type) {
      case 'ExpressionStatement':
        return { settled: settled || exprSettles(statement.expression, info), ends: false };
      case 'VariableDeclaration':
        return { settled: settled || statement.declarations.some((d) => exprSettles(d.init, info)), ends: false };
      case 'ReturnStatement': {
        const now = settled || (statement.argument !== null && exprSettles(statement.argument, info));
        if (!now) bad.push(lineOf(statement));
        return { settled: now, ends: true };
      }
      case 'ThrowStatement':
        return { settled, ends: true };
      case 'BlockStatement':
        return flowList(statement.body, settled, info, bad);
      case 'LabeledStatement':
        return flowStatement(statement.body, settled, info, bad);
      case 'IfStatement': {
        const afterTest = settled || exprSettles(statement.test, info);
        const consequent = flowStatement(statement.consequent, afterTest, info, bad);
        const alternate = statement.alternate === null ? { settled: afterTest, ends: false } : flowStatement(statement.alternate, afterTest, info, bad);
        return merge([consequent, alternate], afterTest);
      }
      case 'TryStatement': {
        const tried = flowList(statement.block.body, settled, info, bad);
        // An exception can leave the try block anywhere, so the handler starts from what was settled before it.
        const results = [tried];
        if (statement.handler !== null) results.push(flowList(statement.handler.body.body, settled, info, bad));
        let merged = merge(results, settled);
        if (statement.finalizer !== null) {
          const final = flowList(statement.finalizer.body, settled, info, bad);
          merged = { settled: merged.settled || final.settled, ends: merged.ends || final.ends };
        }
        return merged;
      }
      case 'SwitchStatement': {
        const afterDiscriminant = settled || exprSettles(statement.discriminant, info);
        const results = [];
        let pending = [];
        for (const switchCase of statement.cases) {
          pending = pending.concat(switchCase.consequent);
          if (switchCase.consequent.length === 0) continue;
          results.push(flowList(pending, afterDiscriminant, info, bad));
          pending = [];
        }
        if (!statement.cases.some((c) => c.test === null)) results.push({ settled: afterDiscriminant, ends: false });
        return merge(results, afterDiscriminant);
      }
      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
        // The body may run zero times: nothing it settles carries past the loop, but its returns are checked.
        flowStatement(statement.body, settled, info, bad);
        return { settled, ends: false };
      default:
        return { settled, ends: false };
    }
  };

  /** The lines of every unsettled path (a return, or the end of the function) of `fn`. */
  const unsettledPaths = (fn, info) => {
    if (fn.body.type !== 'BlockStatement') return exprSettles(fn.body, info) ? [] : [lineOf(fn)];
    const bad = [];
    const end = flowList(fn.body.body, false, info, bad);
    if (!end.ends && !end.settled) bad.push(fn.body.body.length > 0 ? lineOf(fn.body.body[fn.body.body.length - 1]) : lineOf(fn));
    return bad;
  };

  function alwaysSettles(fn, info) {
    if (memo.has(fn)) return memo.get(fn);
    if (inProgress.has(fn)) return false;
    inProgress.add(fn);
    const settles = unsettledPaths(fn, info).length === 0;
    inProgress.delete(fn);
    memo.set(fn, settles);
    return settles;
  }

  /** Does `fn` reach `declareGateExit` along ANY path (resolved per file and symbol)? */
  const reachesExit = (fn, info) => {
    const seen = new Set();
    const queue = [{ node: fn, info }];
    while (queue.length > 0) {
      const { node, info: at } = queue.pop();
      if (seen.has(node)) continue;
      seen.add(node);
      if (callsDeclareGateExit(node)) return true;
      for (const call of descendants(node, (n) => n.type === 'CallExpression')) {
        for (const target of resolveCall(call, at, program) ?? []) queue.push(target);
      }
    }
    return false;
  };

  return { unsettledPaths, reachesExit };
}

/**
 * Scan a set of sources `[{ file, text }]` as one tree: gate hosts, verb hosts and the cross-file
 * rules (entry discovery, the exit analysis). `options.routers` is the router table (default `ROUTERS`;
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
  const program = buildProgram(parsed);
  const analysis = createExitAnalysis(program);
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

  // verb-no-gate-exit: EVERY return path of an entry (and its fall-through end) must settle the exit.
  for (const entry of entries) {
    const bad = analysis.unsettledPaths(entry.node, program.get(entry.file));
    if (bad.length > 0) {
      violations.push({ file: entry.file, rule: RULES.VERB_NO_GATE_EXIT, line: bad[0], symbol: entry.name });
    }
  }

  // verdict-owns-exit: any function that outputs a verdict-shaped payload AND sets the exit itself.
  for (const p of parsed) {
    if (EXIT_SEAM_FILES.includes(p.file)) continue;
    for (const fn of namedFunctions(p)) {
      const outputsVerdict = descendants(fn.node, (n) => isVerdictOutputCall(n, fn.node)).length > 0;
      const setsExit = descendants(fn.node, (n) => n.type === 'AssignmentExpression' && isProcessMember(n.left, 'exitCode')).length > 0;
      if (outputsVerdict && setsExit && !analysis.reachesExit(fn.node, program.get(p.file))) {
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
