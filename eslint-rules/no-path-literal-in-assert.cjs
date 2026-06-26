'use strict';

/**
 * no-path-literal-in-assert
 *
 * Flag assertion calls where a path-returning function (path.join, path.resolve,
 * getGlobalConfigDir, …) is compared to a hardcoded POSIX-slash string literal.
 * These assertions FAIL on Windows because path.join emits backslashes.
 *
 * Triggers on:
 *   assert.equal|strictEqual|deepEqual|deepStrictEqual(actual, expected)
 *   expect(actual).toBe|toEqual|toStrictEqual(expected)
 *
 * Out of scope — intentionally NOT reported:
 *   assert.notEqual|notStrictEqual(actual, expected)
 *   expect(actual).not.toBe|not.toEqual|not.toStrictEqual(expected)
 *   A path-vs-POSIX-literal INEQUALITY passes on Windows regardless of separator
 *   differences, so it does not exhibit the portability-defect shape this rule
 *   targets.
 *
 * Suppressed when:
 *   - The path operand is wrapped by a POSIX normalizer (replace/replaceAll/toPosixPath/…)
 *   - The assertion is inside a Windows-excluded block (platform guard, early-return,
 *     hoisted isWindows) as detected by platform-guard.cjs
 *
 * DEFECT category: DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT
 *
 * ── Known boundaries ───────────────────────────────────────────────────────────
 *
 * (a) Name-based matching only.  The rule recognises `path`, `os`, and the
 *     project resolver names listed in PATH_RETURNING_FNS by spelling alone.  If
 *     a test file declares a LOCAL variable named `path` that shadows the real
 *     `path` module, that shadow is out of scope — the rule will still treat a
 *     `path.join(...)` call as path-returning.
 *
 * (b) Shallow operand inspection.  Only the direct first/second argument of the
 *     assert call is inspected, plus one level of `String(<x>)` cast and one
 *     level of non-normalizer method-chain peeling (`.replace()`, `.replaceAll()`,
 *     `.split().join()`).  Deeper wrapping — e.g. `.toLowerCase()` applied after
 *     a path call, or `fs.realpathSync(path.join(...))` — is NOT detected as a
 *     path-returning expression and will not trigger the rule.
 *
 * (c) Harmless no-op remedy.  For explicit dir-pass-through assertions (where the
 *     path really does contain forward-slashes even on Windows), wrapping with
 *     `String(<x>).replace(/\\\\/g, '/')` is the correct suppression; on POSIX
 *     systems where `\\` never appears, the replace is a no-op and has zero cost.
 */

const {
  isPathReturningCall,
  isPosixSlashStringLiteral,
  isPosixNormalizerCall,
  unwrapString,
  unwrapNonNormalizerMethodChain,
} = require('./lib/portability-vocab.cjs');

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow path-returning calls compared to hardcoded POSIX-slash literals in assertions (fails on Windows)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      pathLiteral:
        "Path-returning call compared to a hardcoded '/'-literal (DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT): " +
        "fails on Windows where path.join emits '\\\\'. " +
        "Normalize the actual: String(<expr>).replace(/\\\\\\\\/g, '/') or .replaceAll(path.sep, '/').",
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
     * Returns true when `pathNode` represents a path call and `literalNode` is
     * a POSIX slash literal, AND the path call is NOT already normalized.
     *
     * `rawPathNode` is the operand as-is (before unwrapping) — we check it for
     * normalizer wrapping before stripping String().
     *
     * Lookup order:
     *   1. If rawPathNode IS a valid POSIX normalizer → no violation.
     *   2. Unwrap String() cast → check if inner call is a path call.
     *   3. If rawPathNode is a non-normalizer method chain (e.g. .replace(/foo/g,'/'))
     *      peel one layer to find if the receiver is a path-returning call.
     */
    function isViolation(rawPathNode, rawLiteralNode) {
      // Is the path-side already wrapped by a POSIX normalizer?
      if (isPosixNormalizerCall(rawPathNode)) return false;

      // Unwrap String() cast to see the inner call
      const pathNode = unwrapString(rawPathNode);

      if (isPathReturningCall(pathNode)) {
        if (!isPosixSlashStringLiteral(rawLiteralNode)) return false;
        return true;
      }

      // C1: if rawPathNode is a non-normalizer method chain (.replace, .replaceAll,
      // .split().join()) wrapping a path call, that is still a violation — the method
      // chain does not perform a valid POSIX normalization.
      const peeled = unwrapNonNormalizerMethodChain(rawPathNode);
      if (peeled != null) {
        const innerPath = unwrapString(peeled);
        if (isPathReturningCall(innerPath) && isPosixSlashStringLiteral(rawLiteralNode)) {
          return true;
        }
      }

      return false;
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
          // Ignore 3rd arg (message)

          const violated =
            isViolation(actual, expected) ||
            isViolation(expected, actual);

          if (violated && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'pathLiteral' });
          }
          return;
        }

        // ── expect(actual).<matcher>(expected) ─────────────────────────────
        // Shape: CallExpression{ callee: MemberExpression{ object: CallExpression{callee: Identifier{expect}}, property: Identifier{<matcher>} } }
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

          const violated =
            isViolation(actual, expected) ||
            isViolation(expected, actual);

          if (violated && !isWindowsExcludedNode(node, sourceCode)) {
            context.report({ node, messageId: 'pathLiteral' });
          }
          return;
        }
      },
    };
  },
};

module.exports = rule;
