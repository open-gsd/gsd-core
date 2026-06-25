'use strict';

/**
 * no-hardcoded-tmp
 *
 * Flag hardcoded `/tmp/` paths passed to `fs.*` calls or `path.join()`.
 * On Windows, `/tmp/` does not exist — use `os.tmpdir()` instead.
 *
 * ## What this enforces (G4)
 *
 * A string Literal whose value starts with `/tmp/` (or is exactly `/tmp`)
 * passed as an argument to:
 *   - An `fs.<method>(...)` call
 *   - A `path.join('/tmp/...', …)` call
 *
 * Message: use `os.tmpdir()`.
 *
 * DEFECT category: DEFECT.WINDOWS-TEST-PORTABILITY
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded /tmp/ paths in fs.* calls or path.join() (not portable to Windows)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      hardcodedTmp:
        'Hardcoded "/tmp/" path is not portable (DEFECT.WINDOWS-TEST-PORTABILITY): ' +
        'Windows does not have /tmp/. Use os.tmpdir() to get the platform-appropriate ' +
        'temp directory instead.',
    },
  },

  create(context) {
    /**
     * Returns true if `node` is a string Literal starting with /tmp/ or equal to /tmp.
     * @param {import('eslint').Rule.Node} node
     * @returns {boolean}
     */
    function isTmpLiteral(node) {
      if (!node || node.type !== 'Literal') return false;
      if (typeof node.value !== 'string') return false;
      return node.value === '/tmp' || node.value.startsWith('/tmp/');
    }

    /**
     * Returns true if this CallExpression is an `fs.<method>(...)` call.
     * @param {import('eslint').Rule.Node} node — CallExpression
     * @returns {boolean}
     */
    function isFsMethodCall(node) {
      if (!node || node.type !== 'CallExpression') return false;
      const callee = node.callee;
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'fs' &&
        callee.property.type === 'Identifier'
      );
    }

    /**
     * Returns true if this CallExpression is a `path.join(...)` call.
     * @param {import('eslint').Rule.Node} node — CallExpression
     * @returns {boolean}
     */
    function isPathJoinCall(node) {
      if (!node || node.type !== 'CallExpression') return false;
      const callee = node.callee;
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'path' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'join'
      );
    }

    return {
      CallExpression(node) {
        // Check fs.<method>(...) calls
        if (isFsMethodCall(node)) {
          for (const arg of node.arguments) {
            if (isTmpLiteral(arg)) {
              context.report({ node: arg, messageId: 'hardcodedTmp' });
            }
          }
          return;
        }

        // Check path.join('/tmp/...', ...) calls
        if (isPathJoinCall(node)) {
          const args = node.arguments;
          if (args && args.length > 0 && isTmpLiteral(args[0])) {
            context.report({ node: args[0], messageId: 'hardcodedTmp' });
          }
        }
      },
    };
  },
};

module.exports = rule;
