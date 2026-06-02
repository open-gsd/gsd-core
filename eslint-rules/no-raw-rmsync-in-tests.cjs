'use strict';

/**
 * no-raw-rmsync-in-tests
 *
 * In *.test.cjs files, flag any call that invokes fs.rmSync (directly or via
 * destructuring/aliasing). Covers:
 *
 *   (a) MemberExpression with identifier property "rmSync":
 *         fs.rmSync(d, opts)           nodeFs.rmSync(d, opts)
 *
 *   (b) MemberExpression with computed string-literal property "rmSync":
 *         fs['rmSync'](d, opts)
 *
 *   (c) Bare Identifier whose name is known to be bound to an fs rmSync via:
 *         const { rmSync } = require('fs'|'node:fs')
 *         const alias = fs.rmSync          (where fs is a require('fs') binding)
 *         const alias = require('fs').rmSync
 *
 * The only escape hatch is the native inline disable comment:
 *   // eslint-disable-next-line local/no-raw-rmsync-in-tests -- <reason>
 * (ESLint handles that automatically — this rule does not implement it.)
 *
 * NOTE: The file-level `// allow-test-rule:` annotation does NOT apply to this
 * rule. That annotation is for no-source-grep only.
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw fs.rmSync() calls in test files; use helpers.cleanup() instead',
      category: 'Best Practices',
    },
    schema: [],
    messages: {
      noRawRmSync:
        'Raw fs.rmSync() in a test. Use helpers.cleanup(dir) instead — it carries the Windows-EBUSY retry budget (maxRetries/retryDelay). To suppress a rare legit case, use `// eslint-disable-next-line local/no-raw-rmsync-in-tests -- <reason>`.',
    },
  },
  create(context) {
    const filename = context.getFilename();

    // Only applies in test files
    if (!filename.endsWith('.test.cjs')) return {};

    // --- Track fs-derived bindings ---
    // fsBindings: Set of local variable names bound to require('fs'|'node:fs')
    // rmSyncBindings: Set of local variable names bound to an fs.rmSync value
    const fsBindings = new Set();
    const rmSyncBindings = new Set();

    /**
     * Returns true if `node` is a require('fs') or require('node:fs') call.
     */
    function isFsRequire(node) {
      return (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'Literal' &&
        (node.arguments[0].value === 'fs' ||
          node.arguments[0].value === 'node:fs')
      );
    }

    /**
     * Returns true if `node` is a reference to a known fs binding (Identifier
     * whose name is in fsBindings).
     */
    function isFsBinding(node) {
      return node.type === 'Identifier' && fsBindings.has(node.name);
    }

    /**
     * Returns true if `node` is an expression that resolves to fs.rmSync:
     *   - fsBinding.rmSync  (MemberExpression, identifier property)
     *   - require('fs').rmSync
     */
    function isFsRmSyncExpression(node) {
      if (node.type !== 'MemberExpression') return false;
      const prop = node.property;
      const isRmSyncProp =
        (!node.computed &&
          prop.type === 'Identifier' &&
          prop.name === 'rmSync') ||
        (node.computed &&
          prop.type === 'Literal' &&
          prop.value === 'rmSync');
      if (!isRmSyncProp) return false;
      return isFsBinding(node.object) || isFsRequire(node.object);
    }

    return {
      // ── Track `const fs = require('fs')` ──────────────────────────────────
      VariableDeclaration(node) {
        for (const decl of node.declarations) {
          if (!decl.init) continue;

          // const fs = require('fs')
          if (
            decl.id.type === 'Identifier' &&
            isFsRequire(decl.init)
          ) {
            fsBindings.add(decl.id.name);
            continue;
          }

          // const { rmSync } = require('fs')
          // const { rmSync: del } = require('fs')
          if (
            decl.id.type === 'ObjectPattern' &&
            isFsRequire(decl.init)
          ) {
            for (const prop of decl.id.properties) {
              if (
                prop.type === 'Property' &&
                prop.key.type === 'Identifier' &&
                prop.key.name === 'rmSync' &&
                prop.value.type === 'Identifier'
              ) {
                rmSyncBindings.add(prop.value.name);
              }
            }
            continue;
          }

          // const { rmSync } = fs  (where fs is already a known binding)
          if (
            decl.id.type === 'ObjectPattern' &&
            isFsBinding(decl.init)
          ) {
            for (const prop of decl.id.properties) {
              if (
                prop.type === 'Property' &&
                prop.key.type === 'Identifier' &&
                prop.key.name === 'rmSync' &&
                prop.value.type === 'Identifier'
              ) {
                rmSyncBindings.add(prop.value.name);
              }
            }
            continue;
          }

          // const alias = fs.rmSync  (or require('fs').rmSync)
          if (
            decl.id.type === 'Identifier' &&
            isFsRmSyncExpression(decl.init)
          ) {
            rmSyncBindings.add(decl.id.name);
            continue;
          }
        }
      },

      // ── Flag rmSync calls ─────────────────────────────────────────────────
      CallExpression(node) {
        const callee = node.callee;

        // (a) obj.rmSync(...)  — identifier property
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'rmSync'
        ) {
          context.report({ node, messageId: 'noRawRmSync' });
          return;
        }

        // (b) obj['rmSync'](...)  — computed string-literal property
        if (
          callee.type === 'MemberExpression' &&
          callee.computed &&
          callee.property.type === 'Literal' &&
          callee.property.value === 'rmSync'
        ) {
          context.report({ node, messageId: 'noRawRmSync' });
          return;
        }

        // (c) bare identifier known to be fs.rmSync
        if (
          callee.type === 'Identifier' &&
          rmSyncBindings.has(callee.name)
        ) {
          context.report({ node, messageId: 'noRawRmSync' });
        }
      },
    };
  },
};

module.exports = rule;
