'use strict';

/**
 * platform-guard.cjs — precision backbone for no-path-literal-in-assert.
 *
 * Exported API:
 *   classifyPlatformTest(node) → 'windows' | 'not-windows' | null
 *   isWindowsExcludedNode(node, sourceCode) → boolean
 *
 * Shapes handled by isWindowsExcludedNode:
 *
 *   (A) Consequent of `if (<not-windows test>) { ... }`:
 *         if (process.platform !== 'win32') { <node> }
 *
 *   (B) Alternate of `if (<windows test>) { ... } else { <node> }`:
 *         if (process.platform === 'win32') { ... } else { <node> }
 *
 *   (C) A preceding sibling IfStatement that is a Windows early-return guard,
 *       making the node unreachable on Windows:
 *         if (process.platform === 'win32') return;
 *         if (process.platform === 'win32') return t.skip(...);
 *         if (process.platform === 'win32') { ...; return; }
 *
 *   (D) Hoisted windows-boolean consumed by (A)/(B)/(C). Both the conventional
 *       names (isWindows, IS_WINDOWS, isWin, onWindows) AND arbitrary-named
 *       variables (e.g. `const winFlag = process.platform === 'win32'`) are
 *       resolved by looking up the variable's initializer in the enclosing scope
 *       and classifying that expression. Negation (`!winFlag`) is applied after
 *       the lookup, so `if (!winFlag)` is correctly recognized as a not-windows
 *       guard when winFlag was initialized to a windows test.
 *
 * If a shape is genuinely ambiguous, the function returns false so the rule
 * errs toward reporting — the fix is to teach this helper, never an opt-out.
 */

/**
 * Identifier names conventionally used for "is this Windows?" booleans.
 * @type {Set<string>}
 */
const WINDOWS_BOOL_NAMES = new Set(['isWindows', 'IS_WINDOWS', 'isWin', 'onWindows']);

/**
 * Classify a test expression as a Windows test, not-Windows test, or unrelated.
 *
 * Recognized forms:
 *   - `process.platform === 'win32'`   → 'windows'
 *   - `process.platform !== 'win32'`   → 'not-windows'
 *   - `os.platform() === 'win32'`      → 'windows'
 *   - `os.platform() !== 'win32'`      → 'not-windows'
 *   - `isWindows` / `IS_WINDOWS` / etc → 'windows'
 *   - `!isWindows` / etc               → 'not-windows'
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {'windows' | 'not-windows' | null}
 */
function classifyPlatformTest(node) {
  if (!node) return null;

  // Binary: X === 'win32' or X !== 'win32' or 'win32' === X etc.
  if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '!==')) {
    const { left, right, operator } = node;
    if (_isPlatformExpr(left) && _isWin32Literal(right)) {
      return operator === '===' ? 'windows' : 'not-windows';
    }
    if (_isPlatformExpr(right) && _isWin32Literal(left)) {
      return operator === '===' ? 'windows' : 'not-windows';
    }
  }

  // Bare identifier: isWindows, IS_WINDOWS, isWin, onWindows
  if (node.type === 'Identifier' && WINDOWS_BOOL_NAMES.has(node.name)) {
    return 'windows';
  }

  // Negated: !isWindows
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '!' &&
    node.argument.type === 'Identifier' &&
    WINDOWS_BOOL_NAMES.has(node.argument.name)
  ) {
    return 'not-windows';
  }

  return null;
}

/** True if node is `process.platform` or `os.platform()` */
function _isPlatformExpr(node) {
  // process.platform
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'process' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'platform'
  ) {
    return true;
  }
  // os.platform()
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'os' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'platform'
  ) {
    return true;
  }
  return false;
}

/** True if node is the string literal 'win32' */
function _isWin32Literal(node) {
  return node.type === 'Literal' && node.value === 'win32';
}

/**
 * Returns true when `targetNode` only executes on non-Windows because it is
 * control-dependent on one of the recognized Windows-guard shapes.
 *
 * @param {import('eslint').Rule.Node} targetNode
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isWindowsExcludedNode(targetNode, sourceCode) {
  // Walk ancestors bottom-up to find a guarding IfStatement.
  const ancestors = _getAncestors(targetNode, sourceCode);

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];

    if (ancestor.type !== 'IfStatement') continue;

    const testClassification = _classifyPlatformTestWithHoisting(
      ancestor.test,
      targetNode,
      sourceCode
    );

    if (!testClassification) continue;

    // Determine which branch targetNode is in
    const inConsequent = _containsNode(ancestor.consequent, targetNode);
    const inAlternate = ancestor.alternate != null && _containsNode(ancestor.alternate, targetNode);

    if (inConsequent && testClassification === 'not-windows') {
      // if (platform !== 'win32') { <target> }  → excluded
      return true;
    }
    if (inAlternate && testClassification === 'windows') {
      // if (platform === 'win32') { … } else { <target> }  → excluded
      return true;
    }
  }

  // Check for early-return guards in the same block as the target node
  if (_hasEarlyWindowsReturnBefore(targetNode, sourceCode)) return true;

  return false;
}

/**
 * Classify a test expression, resolving hoisted windows-boolean variables.
 *
 * C3 (binding-aware): for bare Identifier or !Identifier test forms, this
 * function resolves the variable's binding in the lexical scope:
 *
 *   1. If `sourceCode.getScope` is available (real ESLint rule context), use
 *      it to resolve the NEAREST binding of the identifier, walking scope.upper
 *      so inner shadows take priority.  If a binding is found in-file:
 *        a. Classify the initializer — not a platform test → return null.
 *        b. Check for reassignment (any write reference after init) → return null.
 *        c. Otherwise return the init classification (with negation applied).
 *      If NO in-file binding exists (global/import), fall through to the name
 *      heuristic below.
 *
 *   2. AST-walk fallback (unit-test contexts without live scope): for identifiers
 *      NOT in WINDOWS_BOOL_NAMES, use _resolveIdentifierInitBindingAware which
 *      respects inner shadows and reassignment.  For names IN WINDOWS_BOOL_NAMES
 *      with no in-file binding found, apply the name heuristic.
 *
 *   3. Direct platform expressions (`process.platform === 'win32'`, etc.) are
 *      classified directly (no change from before).
 *
 * @param {import('eslint').Rule.Node} testNode   — the IfStatement's .test
 * @param {import('eslint').Rule.Node} targetNode — the node we are checking
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {'windows' | 'not-windows' | null}
 */
function _classifyPlatformTestWithHoisting(testNode, targetNode, sourceCode) {
  // Step 1: try direct classification of platform expressions
  // (BinaryExpression process.platform === 'win32', etc.)
  // Do NOT use classifyPlatformTest here for the bare-identifier forms —
  // we want binding-aware resolution for those.
  const directBinary = _classifyPlatformExprOnly(testNode);
  if (directBinary) return directBinary;

  // Extract the identifier and negation flag from the test expression.
  let identNode = null;
  let negated = false;

  if (testNode.type === 'Identifier') {
    identNode = testNode;
    negated = false;
  } else if (
    testNode.type === 'UnaryExpression' &&
    testNode.operator === '!' &&
    testNode.argument.type === 'Identifier'
  ) {
    identNode = testNode.argument;
    negated = true;
  }

  if (!identNode) return null;

  const identName = identNode.name;

  // Step 2: binding-aware resolution via ESLint scope (when available).
  if (typeof sourceCode.getScope === 'function') {
    const scopeResult = _resolveIdentifierViaScope(identNode, identName, negated, sourceCode);
    // scopeResult is one of:
    //   'windows' | 'not-windows'  — binding found, init classifies as platform test
    //   null                        — binding found but doesn't classify (or reassigned)
    //   'no-binding'                — no in-file binding; fall through to name heuristic
    if (scopeResult !== 'no-binding') return scopeResult;
    // Fall through: no in-file binding → name heuristic below.
  } else {
    // AST-walk fallback (unit-test contexts without live scope).
    // Use binding-aware AST walk for ALL names.
    const astResult = _resolveIdentifierInitBindingAware(identName, identNode, targetNode, sourceCode);
    if (astResult !== 'no-binding') {
      if (!astResult) return null;
      return negated
        ? (astResult === 'windows' ? 'not-windows' : 'windows')
        : astResult;
    }
    // No binding found via AST walk → fall through to name heuristic.
  }

  // Step 3: name heuristic — only for globally-recognized Windows bool names
  // that have no in-file binding (imported/global constants like `isWindows`
  // imported from a test helper).
  if (WINDOWS_BOOL_NAMES.has(identName)) {
    return negated ? 'not-windows' : 'windows';
  }

  return null;
}

/**
 * Classify a BinaryExpression or os.platform() call as a platform test.
 * Does NOT handle bare Identifiers or !Identifier — those need binding-aware
 * resolution (handled above in _classifyPlatformTestWithHoisting).
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {'windows' | 'not-windows' | null}
 */
function _classifyPlatformExprOnly(node) {
  if (!node) return null;
  if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '!==')) {
    const { left, right, operator } = node;
    if (_isPlatformExpr(left) && _isWin32Literal(right)) {
      return operator === '===' ? 'windows' : 'not-windows';
    }
    if (_isPlatformExpr(right) && _isWin32Literal(left)) {
      return operator === '===' ? 'windows' : 'not-windows';
    }
  }
  return null;
}

/**
 * Resolve an identifier's binding via ESLint scope analysis.
 *
 * Walks `scope.upper` from the identifier's immediate scope to find the NEAREST
 * binding (so inner shadows take priority over outer declarations).
 *
 * @param {import('eslint').Rule.Node} identNode
 * @param {string} identName
 * @param {boolean} negated
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {'windows' | 'not-windows' | null | 'no-binding'}
 */
function _resolveIdentifierViaScope(identNode, identName, negated, sourceCode) {
  let scope;
  try {
    scope = sourceCode.getScope(identNode);
  } catch (_) {
    return 'no-binding';
  }
  if (!scope) return 'no-binding';

  // Walk scope chain from innermost to outermost; take the NEAREST binding.
  let s = scope;
  while (s) {
    const variable = s.variables.find(v => v.name === identName);
    if (variable) {
      // Found an in-file binding (the NEAREST one wins — inner shadow beats outer).
      const defs = variable.defs;
      if (!defs || defs.length === 0) {
        // Binding exists but no declarator (e.g. function parameter) — no init.
        return null;
      }
      const decl = defs[0].node; // VariableDeclarator
      if (!decl || !decl.init) {
        // No initializer (e.g. `let w;`) → not a platform test.
        return null;
      }
      // Classify the initializer.
      const cls = classifyPlatformTest(decl.init);
      if (!cls) return null; // init is not a platform test

      // Check for reassignment: any write reference that is NOT the initialization.
      const isReassigned = variable.references.some(
        ref => ref.isWrite() && !ref.init
      );
      if (isReassigned) return null;

      // Valid platform guard binding found.
      return negated
        ? (cls === 'windows' ? 'not-windows' : 'windows')
        : cls;
    }
    s = s.upper;
  }

  // No binding found in any scope — treat as a global/imported name.
  return 'no-binding';
}

/**
 * Binding-aware AST-walk resolver — used as a fallback when
 * sourceCode.getScope is not available.
 *
 * Walks ancestor blocks from innermost to outermost, looking for a
 * VariableDeclaration of `name` that precedes `targetNode`.
 *
 * Key differences from the old _resolveIdentifierInit:
 *   - Returns 'no-binding' when NO declaration of `name` is found in any
 *     ancestor block (so the caller can apply the name heuristic).
 *   - Returns null (not 'no-binding') when a declaration IS found but:
 *       • its init does not classify as a platform test, OR
 *       • the variable is reassigned (any ExpressionStatement `name = ...`
 *         appears before targetNode after the declaration), OR
 *       • an inner-scope declaration shadows the outer one (inner wins).
 *   - Stops at the FIRST block that declares `name` (innermost shadow wins).
 *
 * @param {string} name
 * @param {import('eslint').Rule.Node} identNode  — the Identifier AST node (for inner-shadow check)
 * @param {import('eslint').Rule.Node} targetNode — the assert CallExpression node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {'windows' | 'not-windows' | null | 'no-binding'}
 */
function _resolveIdentifierInitBindingAware(name, identNode, targetNode, sourceCode) {
  const ancestors = _getAncestors(targetNode, sourceCode);

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const block = ancestors[i];
    if (block.type !== 'BlockStatement' && block.type !== 'Program') continue;

    const stmts = block.body;
    if (!stmts) continue;

    // Find which direct-child statement contains the targetNode.
    let targetIdx = -1;
    for (let j = 0; j < stmts.length; j++) {
      if (_containsNode(stmts[j], targetNode) || stmts[j] === targetNode) {
        targetIdx = j;
        break;
      }
    }
    if (targetIdx === -1) continue;

    // Scan all preceding siblings in this block for a declaration of `name`.
    let foundDecl = null;
    let foundDeclIdx = -1;
    for (let j = 0; j < targetIdx; j++) {
      const stmt = stmts[j];
      if (stmt.type !== 'VariableDeclaration') continue;
      for (const decl of stmt.declarations) {
        if (
          decl.type === 'VariableDeclarator' &&
          decl.id &&
          decl.id.type === 'Identifier' &&
          decl.id.name === name
        ) {
          foundDecl = decl;
          foundDeclIdx = j;
          break;
        }
      }
      if (foundDecl) break;
    }

    if (foundDecl) {
      // A binding was found in this block. Innermost shadow wins — stop climbing.

      // No initializer → not a platform guard.
      if (!foundDecl.init) return null;

      // Init must classify as a platform test.
      const cls = classifyPlatformTest(foundDecl.init);
      if (!cls) return null;

      // Check for reassignment: any ExpressionStatement `name = ...` between
      // foundDeclIdx and targetIdx.
      if (_hasReassignmentBetween(name, stmts, foundDeclIdx + 1, targetIdx)) {
        return null;
      }

      return cls;
    }

    // No declaration found in this block — continue climbing to outer scope.
  }

  // No declaration found in any ancestor block.
  return 'no-binding';
}

/**
 * Returns true when any statement in stmts[fromIdx..toIdx) is an assignment
 * expression `<name> = ...` (simple reassignment, not an initializer).
 *
 * @param {string} name
 * @param {Array} stmts
 * @param {number} fromIdx  — inclusive
 * @param {number} toIdx    — exclusive
 * @returns {boolean}
 */
function _hasReassignmentBetween(name, stmts, fromIdx, toIdx) {
  for (let j = fromIdx; j < toIdx; j++) {
    const stmt = stmts[j];
    if (
      stmt.type === 'ExpressionStatement' &&
      stmt.expression.type === 'AssignmentExpression' &&
      stmt.expression.left.type === 'Identifier' &&
      stmt.expression.left.name === name
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Legacy alias kept for _isWindowsEarlyReturn's call to
 * _classifyPlatformTestWithHoisting, which uses stmt (the IfStatement) as
 * the "targetNode" to look up hoisting context. No callers outside that path.
 *
 * @param {string} name
 * @param {import('eslint').Rule.Node} targetNode
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {'windows' | 'not-windows' | null}
 */
function _resolveIdentifierInit(name, targetNode, sourceCode) {
  const result = _resolveIdentifierInitBindingAware(name, null, targetNode, sourceCode);
  if (result === 'no-binding') return null;
  return result;
}

/**
 * True when there is a preceding sibling statement (before targetNode in ANY
 * enclosing block — function body, nested block, or Program) that is an
 * IfStatement whose consequence is a Windows-only early return — making
 * targetNode unreachable on Windows.
 *
 * Recognized patterns:
 *   if (windowsTest) return;
 *   if (windowsTest) return <expr>;
 *   if (windowsTest) { …; return; }       — block with a return
 *
 * C2 fix: climbs ALL ancestor blocks, not just the innermost one.
 * An early-return guard in a function body before a nested if-block that
 * contains targetNode is equally valid (control cannot reach targetNode on Windows
 * because the outer return fired first).
 */
function _hasEarlyWindowsReturnBefore(targetNode, sourceCode) {
  const ancestors = _getAncestors(targetNode, sourceCode);

  // Walk ALL ancestor blocks bottom-up (innermost first).
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const block = ancestors[i];
    if (block.type !== 'BlockStatement' && block.type !== 'Program') continue;

    const stmts = block.body;
    if (!stmts) continue;

    // Find targetNode's position in this block's statements.
    // targetNode might be nested inside a statement; we need the direct-child index.
    let targetStmtIdx = -1;
    for (let j = 0; j < stmts.length; j++) {
      if (_containsNode(stmts[j], targetNode) || stmts[j] === targetNode) {
        targetStmtIdx = j;
        break;
      }
    }
    if (targetStmtIdx === -1) continue;

    // Scan preceding siblings in this block for a Windows early-return guard.
    for (let j = 0; j < targetStmtIdx; j++) {
      const stmt = stmts[j];
      if (_isWindowsEarlyReturn(stmt, sourceCode, block)) return true;
    }

    // No guard found in this block — continue climbing to outer blocks.
    // (Unlike the IfStatement-branch check, an early-return in an outer block
    // before the nested block that contains targetNode is equally protective.)
  }

  return false;
}

/**
 * True when `stmt` is `if (<windows test>) return;` / `if (<windows test>) return <expr>;`
 * / `if (<windows test>) { …; return; }` with no `else`.
 */
function _isWindowsEarlyReturn(stmt, sourceCode, _block) {
  if (stmt.type !== 'IfStatement') return false;
  if (stmt.alternate != null) return false; // has else → not a simple guard

  const testClass = _classifyPlatformTestWithHoisting(stmt.test, stmt, sourceCode);
  if (testClass !== 'windows') return false;

  // Consequent must contain a return statement
  const consequent = stmt.consequent;
  if (!consequent) return false;

  if (consequent.type === 'ReturnStatement') return true;

  if (consequent.type === 'BlockStatement') {
    // Only direct-child ReturnStatements are checked. Nested/conditional returns
    // (e.g. inside inner if-blocks) are intentionally NOT treated as guards —
    // this is the sound conservative choice: we only suppress the report when
    // we are certain execution cannot continue on Windows.
    return consequent.body.some(s => s.type === 'ReturnStatement');
  }

  return false;
}

/**
 * Get the ancestor chain for `node` using the sourceCode API.
 * Returns an array from outermost to innermost (not including node itself).
 */
function _getAncestors(node, sourceCode) {
  // ESLint 8+: sourceCode.getAncestors(node)
  if (sourceCode.getAncestors) {
    try {
      return sourceCode.getAncestors(node);
    } catch (_) {
      // Fallback: not always available outside a rule handler
    }
  }
  // Fallback: traverse the AST manually (used in unit tests)
  return _findAncestors(sourceCode.ast, node);
}

/**
 * Find the ancestor chain by walking the AST.
 * Returns array from root to immediate parent of target.
 * Skips `parent` and other cycle-inducing keys.
 */
function _findAncestors(root, target) {
  const chain = [];
  function walk(node, ancestors) {
    if (!node || typeof node !== 'object') return false;
    if (node === target) {
      chain.push(...ancestors);
      return true;
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && item.type) {
            if (walk(item, [...ancestors, node])) return true;
          }
        }
      } else if (child && typeof child === 'object' && child.type) {
        if (walk(child, [...ancestors, node])) return true;
      }
    }
    return false;
  }
  walk(root, []);
  return chain;
}

/**
 * Keys to skip when traversing an AST node to avoid circular parent refs.
 * ESLint attaches `parent` to every node, which creates cycles.
 */
const SKIP_KEYS = new Set(['parent', 'tokens', 'comments']);

/**
 * Returns true when `container` node contains `target` node (by identity).
 * Skips `parent` and other non-AST keys to avoid circular reference loops.
 */
function _containsNode(container, target) {
  if (!container || typeof container !== 'object') return false;
  if (container === target) return true;
  for (const key of Object.keys(container)) {
    if (SKIP_KEYS.has(key)) continue;
    const child = container[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) {
          if (_containsNode(item, target)) return true;
        }
      }
    } else if (child && typeof child === 'object' && child.type) {
      if (_containsNode(child, target)) return true;
    }
  }
  return false;
}

module.exports = {
  classifyPlatformTest,
  isWindowsExcludedNode,
};
