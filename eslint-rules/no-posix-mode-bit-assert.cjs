'use strict';

/**
 * no-posix-mode-bit-assert
 *
 * Flag assertion calls where a file-mode expression (e.g. fs.statSync(p).mode,
 * or fs.statSync(p).mode & 0o777) is compared to an octal numeric literal.
 * These assertions PASS on macOS/Linux but FAIL on Windows because Windows
 * reports the DOS-attribute-derived mode (0o666 writable / 0o444 readonly),
 * never the requested POSIX octal.
 *
 * Triggers on:
 *   assert.equal|strictEqual|deepEqual|deepStrictEqual(actual, expected)
 *   expect(actual).toBe|toEqual|toStrictEqual(expected)
 *
 * A "file-mode expression" is one that:
 *   M0. Contains a `.mode` MemberExpression (non-computed):
 *         x.mode, fs.statSync(p).mode, x.mode & 0oNNN
 *   M1. Contains a computed `['mode']` MemberExpression:
 *         x['mode'], stat['mode'] & 0o777
 *   M2. Is a variable whose binding (resolved via scope) is initialized to a
 *         mode expression: `const m = stat.mode` / `const m = stat['mode']`
 *         Conservative: only flags when binding resolves in-file and is not
 *         reassigned before the assertion.
 *   M3. Is a variable destructured as `mode` from an object:
 *         `const { mode } = fs.statSync(p)` — the `mode` binding is a mode expr.
 *         Conservative: same resolution rules as M2.
 *   M4. Is a CallExpression to `Number`/`parseInt` whose first argument contains
 *         a mode expression (recursive): `Number(stat.mode & 0o777)`,
 *         `parseInt(stat.mode, 8)`.
 *
 * The violation is flagged when:
 *   1. One operand is (or contains/resolves-to) a mode expression, AND
 *   2. An octal numeric literal appears either as the other operand, OR
 *      as the right-hand side of the bitwise expression containing the mode.
 *
 * Suppressed when:
 *   - The assertion node is inside a Windows-excluded block (platform guard,
 *     early-return guard, hoisted isWindows) as detected by platform-guard.cjs.
 *
 * DEFECT category: DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT
 *
 * ── Known boundaries ───────────────────────────────────────────────────────────
 *
 * (a) The rule detects `.mode` / `['mode']` by property name. It assumes any
 *     `.mode` or `['mode']` alongside an octal literal in an equality assertion
 *     is a filesystem mode check. A non-fs `.mode` or `['mode']` compared to an
 *     octal literal IS flagged — the defect shape (POSIX-mode assertion that
 *     fails on Windows) is the primary concern, and false positives for non-fs
 *     `.mode` vs an octal literal are vanishingly rare in test code.
 *
 * (b) Variable-capture (M2) and destructure (M3) detection is scope-based.
 *     When a binding RESOLVES in-file to a mode expression and is not reassigned,
 *     the variable is treated as a mode expression. An unresolvable or reassigned
 *     identifier is NOT flagged (conservative — avoids false positives on
 *     non-fs identifiers or imported constants).
 *
 * (c) The `node:test` `test(name, { skip: isWindows ? … : false }, fn)` OPTION
 *     object is NOT recognized as a platform guard. To make a mode-bit assertion
 *     POSIX-only use an `if (process.platform !== 'win32')` guard (or an early-
 *     return guard) inside the callback — the rule recognizes those shapes.
 *
 * (d) Octal detection covers `0o`/`0O` prefix literals. Legacy `0NNN` octal
 *     literals (banned by strict mode and most linters) are not a concern in
 *     modern test files and are not handled.
 */

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow asserting POSIX file mode bits compared to octal literals (fails on Windows)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      posixModeBit:
        'Asserting a POSIX file mode (DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT): Windows reports ' +
        '0o666/0o444, not the requested octal. Gate this precondition on ' +
        "`if (process.platform !== 'win32')` and keep the platform-independent " +
        'behavioral assertion running on every OS.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** assert.equal / assert.strictEqual / assert.deepEqual / assert.deepStrictEqual */
    const ASSERT_EQUALITY_METHODS = new Set([
      'equal',
      'strictEqual',
      'deepEqual',
      'deepStrictEqual',
    ]);

    /** expect(actual).<matcher>(expected) */
    const EXPECT_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

    /**
     * Returns true when the given AST node IS an octal numeric literal.
     * Matches `0o`/`0O` prefix form (ES6+). Raw source is checked because
     * `node.value` for `0o644` is `420` (decimal) — the same integer can be
     * written as `0x1A4` or `420` without being a mode-bit assertion.
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function isOctalLiteral(node) {
      if (!node || node.type !== 'Literal') return false;
      if (typeof node.value !== 'number') return false;
      // Check raw source representation via sourceCode
      const raw = sourceCode.getText(node);
      return raw.startsWith('0o') || raw.startsWith('0O');
    }

    /**
     * Returns true when `node` is a syntactic mode expression — one that
     * directly contains a `.mode` or `['mode']` MemberExpression anywhere
     * within it (including inside BinaryExpression and Number/parseInt wrappers).
     *
     * Recognized shapes (M0, M1, M4):
     *   M0: x.mode                        — non-computed MemberExpression
     *   M0: fs.statSync(p).mode           — chained non-computed
     *   M0: x.mode & 0o777                — .mode inside a BinaryExpression
     *   M1: x['mode']                     — computed MemberExpression, string 'mode'
     *   M1: x['mode'] & 0o777             — computed .mode inside BinaryExpression
     *   M4: Number(x.mode & 0o777)        — Number() wrapping a mode expression
     *   M4: parseInt(x.mode, 8)           — parseInt() wrapping a mode expression
     *
     * Does NOT resolve variable references (that is done by isModeExpression).
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function containsSyntacticModeExpression(node) {
      if (!node) return false;

      // M0: Non-computed MemberExpression with property name 'mode'
      if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'mode'
      ) {
        return true;
      }

      // M1: Computed MemberExpression with string property 'mode'
      if (
        node.type === 'MemberExpression' &&
        node.computed &&
        node.property.type === 'Literal' &&
        node.property.value === 'mode'
      ) {
        return true;
      }

      // BinaryExpression: recurse left and right (covers x.mode & 0o777)
      if (node.type === 'BinaryExpression') {
        return (
          containsSyntacticModeExpression(node.left) ||
          containsSyntacticModeExpression(node.right)
        );
      }

      // M4: Number(...) or parseInt(...) — recurse into the first argument
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        (node.callee.name === 'Number' || node.callee.name === 'parseInt') &&
        node.arguments.length >= 1
      ) {
        return containsSyntacticModeExpression(node.arguments[0]);
      }

      return false;
    }

    /**
     * Resolve a bare Identifier through the ESLint scope to determine whether
     * its binding is initialized to a mode expression (M2/M3).
     *
     * Returns true when ALL of the following hold:
     *   - A VariableDeclarator binding for the name is found in-file scope.
     *   - The declarator's init is a mode expression:
     *       M2: `const m = stat.mode` / `const m = stat['mode']` — init is a
     *           MemberExpression (or expression) containing a mode MemberExpression.
     *       M3: `const { mode } = fs.statSync(p)` — the declarator id is an
     *           ObjectPattern that includes a property keyed 'mode' matching
     *           this identifier's name.
     *   - The variable is NOT reassigned after initialization.
     *
     * Returns false (conservative) when:
     *   - No in-file binding is found (could be an import, global, or parameter).
     *   - The binding does not resolve to a mode expression.
     *   - The variable is reassigned.
     *
     * @param {import('eslint').Rule.Node} identNode — the Identifier AST node
     * @returns {boolean}
     */
    function resolveIdentifierToModeExpression(identNode) {
      if (!identNode || identNode.type !== 'Identifier') return false;
      if (typeof sourceCode.getScope !== 'function') return false;

      let scope;
      try {
        scope = sourceCode.getScope(identNode);
      } catch (_) {
        return false;
      }
      if (!scope) return false;

      const name = identNode.name;

      // Walk scope chain innermost-first to find the nearest binding.
      let s = scope;
      while (s) {
        const variable = s.variables.find(v => v.name === name);
        if (variable) {
          // Found an in-file binding.
          const defs = variable.defs;
          if (!defs || defs.length === 0) return false; // no declarator (e.g. parameter)

          const decl = defs[0].node; // VariableDeclarator
          if (!decl) return false;

          // Check for reassignment: any write reference that is NOT the init.
          const isReassigned = variable.references.some(ref => ref.isWrite() && !ref.init);
          if (isReassigned) return false;

          // M3: ObjectPattern destructure — `const { mode } = ...`
          // The binding matches if the declarator id is an ObjectPattern AND
          // the destructured key for this identifier's name is 'mode'.
          if (decl.id && decl.id.type === 'ObjectPattern') {
            const modeProperty = decl.id.properties.find(
              prop =>
                prop.type === 'Property' &&
                prop.key &&
                ((prop.key.type === 'Identifier' && prop.key.name === 'mode') ||
                  (prop.key.type === 'Literal' && prop.key.value === 'mode')) &&
                prop.value &&
                prop.value.type === 'Identifier' &&
                prop.value.name === name
            );
            if (modeProperty) return true;
            return false; // ObjectPattern without matching 'mode' key
          }

          // M2: Simple declarator — `const m = stat.mode` or `const m = stat['mode']`
          if (!decl.init) return false;
          return containsSyntacticModeExpression(decl.init);
        }
        s = s.upper;
      }

      // No in-file binding found — conservative: do not flag.
      return false;
    }

    /**
     * Returns true when `node` is or contains a file-mode expression.
     * Extends containsSyntacticModeExpression with M2/M3 scope-based resolution
     * for bare Identifiers.
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function isModeExpression(node) {
      if (!node) return false;

      // Syntactic check first (M0, M1, M4)
      if (containsSyntacticModeExpression(node)) return true;

      // M2/M3: bare Identifier — resolve via scope
      if (node.type === 'Identifier') {
        return resolveIdentifierToModeExpression(node);
      }

      // BinaryExpression: recurse (picks up `m & 0o777` where m is a mode alias)
      if (node.type === 'BinaryExpression') {
        return isModeExpression(node.left) || isModeExpression(node.right);
      }

      // M4: Number/parseInt — recurse into first argument
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        (node.callee.name === 'Number' || node.callee.name === 'parseInt') &&
        node.arguments.length >= 1
      ) {
        return isModeExpression(node.arguments[0]);
      }

      return false;
    }

    /**
     * Returns true when `node` contains an octal literal anywhere within it.
     * This covers:
     *   - 0o644                  — direct octal literal
     *   - x.mode & 0o777         — octal inside a BinaryExpression (the mask)
     *   - Number(x.mode & 0o777) — octal inside a wrapper
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function containsOctalLiteral(node) {
      if (!node) return false;
      if (isOctalLiteral(node)) return true;
      if (node.type === 'BinaryExpression') {
        return containsOctalLiteral(node.left) || containsOctalLiteral(node.right);
      }
      // Also recurse into Number/parseInt wrappers for the octal check
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        (node.callee.name === 'Number' || node.callee.name === 'parseInt') &&
        node.arguments.length >= 1
      ) {
        return containsOctalLiteral(node.arguments[0]);
      }
      return false;
    }

    /**
     * Returns true when the pair of operands represents a POSIX-mode-bit assertion:
     *   - One operand is (or resolves to) a mode expression, AND
     *   - An octal literal appears somewhere in either operand (as a mask or as
     *     the comparison value).
     *
     * Both operand orderings are checked by the caller.
     *
     * @param {import('eslint').Rule.Node} a - first operand
     * @param {import('eslint').Rule.Node} b - second operand
     * @returns {boolean}
     */
    function isModeBitViolation(a, b) {
      const aModeExpr = isModeExpression(a);
      const bModeExpr = isModeExpression(b);

      if (!aModeExpr && !bModeExpr) return false;

      // At least one operand contains a .mode expression.
      // Check if any octal literal appears in either operand.
      const aHasOctal = containsOctalLiteral(a);
      const bHasOctal = containsOctalLiteral(b);

      return aHasOctal || bHasOctal;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // ── assert.<method>(actual, expected) ──────────────────────────────
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'assert' &&
          callee.property.type === 'Identifier' &&
          ASSERT_EQUALITY_METHODS.has(callee.property.name)
        ) {
          const args = node.arguments;
          if (args.length < 2) return;
          const actual = args[0];
          const expected = args[1];

          if (isModeBitViolation(actual, expected) && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'posixModeBit' });
          }
          return;
        }

        // ── expect(actual).<matcher>(expected) ─────────────────────────────
        // Shape: CallExpression{ callee: MemberExpression{
        //   object: CallExpression{callee: Identifier{expect}},
        //   property: Identifier{<matcher>}
        // }}
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          EXPECT_MATCHERS.has(callee.property.name) &&
          callee.object.type === 'CallExpression' &&
          callee.object.callee.type === 'Identifier' &&
          callee.object.callee.name === 'expect' &&
          callee.object.arguments.length === 1
        ) {
          const actual = callee.object.arguments[0]; // the arg to expect(...)
          const matcherArgs = node.arguments;
          if (matcherArgs.length < 1) return;
          const expected = matcherArgs[0];

          if (isModeBitViolation(actual, expected) && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'posixModeBit' });
          }
          return;
        }
      },
    };
  },
};

module.exports = rule;
