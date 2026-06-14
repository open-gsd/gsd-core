'use strict';

/**
 * no-tautological-assert
 *
 * Flag assert*() calls whose argument(s) can never fail — i.e. the assertion
 * is tautologically true at the AST level and therefore provides no test value.
 *
 * Two categories:
 *
 * (a) Truthiness asserts — assert(x) / assert.ok(x) — where x is an
 *     always-truthy literal:
 *       - boolean literal `true`
 *       - non-zero numeric Literal (1, 42, …)
 *       - non-empty string Literal ("always", …)
 *       - RegExp, Array, or Object expression (always truthy objects)
 *       - UnaryExpression !!<literal>  (double-bang a literal)
 *       - LogicalExpression `cond || true`  (right side is true)
 *
 * (b) Equality asserts — assert.strictEqual / assert.equal /
 *     assert.deepEqual / assert.deepStrictEqual — where the first two
 *     arguments are identical literals (same type AND same value).
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow assertions that can never fail due to always-truthy or identical literal arguments',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      tautologicalTruthiness:
        'Tautological assertion: the argument is always truthy so this assert will never fail. Assert on an actual test value instead.',
      tautologicalEquality:
        'Tautological assertion: both arguments are the same literal value so this equality assert will always pass. Assert on an actual test value instead.',
    },
  },
  create(context) {
    // Method names for truthiness asserts
    const TRUTHINESS_METHODS = new Set(['ok']); // bare assert() is handled separately

    // Method names for equality asserts
    const EQUALITY_METHODS = new Set([
      'strictEqual',
      'equal',
      'deepEqual',
      'deepStrictEqual',
    ]);

    /**
     * Returns true when the node is an always-truthy literal (per the spec).
     */
    function isAlwaysTruthyLiteral(node) {
      if (!node) return false;

      // boolean `true`
      if (node.type === 'Literal' && node.value === true) return true;

      // non-zero numeric literal
      if (node.type === 'Literal' && typeof node.value === 'number' && node.value !== 0) return true;

      // non-empty string literal
      if (node.type === 'Literal' && typeof node.value === 'string' && node.value !== '') return true;

      // RegExp literal  /foo/
      if (node.type === 'Literal' && node.regex != null) return true;

      // Array expression  [] or [...]
      if (node.type === 'ArrayExpression') return true;

      // Object expression  {} or {...}
      if (node.type === 'ObjectExpression') return true;

      // UnaryExpression !!<literal>
      if (
        node.type === 'UnaryExpression' &&
        node.operator === '!' &&
        node.argument.type === 'UnaryExpression' &&
        node.argument.operator === '!'
      ) {
        return isAlwaysTruthyLiteral(node.argument.argument);
      }

      // LogicalExpression `cond || true`
      if (
        node.type === 'LogicalExpression' &&
        node.operator === '||' &&
        node.right.type === 'Literal' &&
        node.right.value === true
      ) {
        return true;
      }

      return false;
    }

    /**
     * Returns true when both nodes are Literals of the SAME type and SAME value.
     */
    function areIdenticalLiterals(a, b) {
      if (!a || !b) return false;
      if (a.type !== 'Literal' || b.type !== 'Literal') return false;
      // Compare by type tag and value
      if (typeof a.value !== typeof b.value) return false;
      return a.value === b.value;
    }

    /**
     * Determine whether this call expression is `assert(...)` (bare identifier)
     * or `assert.ok(...)` / `assert.strictEqual(...)` etc.
     *
     * Returns:
     *   { kind: 'bare' }         — assert(...)
     *   { kind: 'method', name } — assert.<name>(...)
     *   null                     — not an assert call
     */
    function classifyAssertCall(node) {
      const callee = node.callee;

      // assert(...)  — bare identifier
      if (callee.type === 'Identifier' && callee.name === 'assert') {
        return { kind: 'bare' };
      }

      // assert.<method>(...)  — member expression on the assert identifier
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'assert' &&
        callee.property.type === 'Identifier'
      ) {
        return { kind: 'method', name: callee.property.name };
      }

      return null;
    }

    return {
      CallExpression(node) {
        const classification = classifyAssertCall(node);
        if (!classification) return;

        const args = node.arguments;

        if (classification.kind === 'bare') {
          // assert(<arg>) — check arg[0] for always-truthy literal
          if (args.length >= 1 && isAlwaysTruthyLiteral(args[0])) {
            context.report({ node, messageId: 'tautologicalTruthiness' });
          }
          return;
        }

        const methodName = classification.name;

        if (TRUTHINESS_METHODS.has(methodName)) {
          // assert.ok(<arg>) — check arg[0] for always-truthy literal
          if (args.length >= 1 && isAlwaysTruthyLiteral(args[0])) {
            context.report({ node, messageId: 'tautologicalTruthiness' });
          }
          return;
        }

        if (EQUALITY_METHODS.has(methodName)) {
          // assert.strictEqual(a, b) etc. — check if both are identical literals
          if (args.length >= 2 && areIdenticalLiterals(args[0], args[1])) {
            context.report({ node, messageId: 'tautologicalEquality' });
          }
          return;
        }
      },
    };
  },
};

module.exports = rule;
