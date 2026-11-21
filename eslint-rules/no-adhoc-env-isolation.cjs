'use strict';

const path = require('path');

/**
 * no-adhoc-env-isolation (#6035, Phase 3 of epic #4635)
 *
 * Stops a new hand-written copy of the child-env isolation helper,
 * `tests/helpers/isolated-env.cjs` (#6033), from being added under `tests/`:
 * an inline PATH split or filter (`inlinePathFilter`), and a hand-built HOME /
 * USERPROFILE env (`adhocHomeConstruction`). Files that still carry a copy are
 * named by the `allowlist` option; a listed file with none left reports
 * `staleAllowlistEntry`. The per-file site counts live in
 * `no-adhoc-env-isolation.allowlist.json` and are held by
 * `tests/no-adhoc-env-isolation.rule.test.cjs`.
 *
 * The forms each arm recognises, the allowlist and count, and examples of what
 * is out of scope: docs/contributing/no-adhoc-env-isolation.md.
 */

const HOME_KEYS = new Set(['HOME', 'USERPROFILE']);
const PATH_KEYS = new Set(['PATH', 'Path']);

/** The static name of a property key or member property, or null. */
function staticName(node, computed) {
  if (!node) return null;
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/** `process.env`, non-computed or `process['env']`. */
function isProcessEnv(node) {
  return (
    !!node &&
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'process' &&
    staticName(node.property, node.computed) === 'env'
  );
}

/** `path.delimiter`, `path.win32.delimiter`, `require('path').delimiter`, or a bare `delimiter`. */
function isPathDelimiter(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'delimiter';
  return node.type === 'MemberExpression' && staticName(node.property, node.computed) === 'delimiter';
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hand-written PATH filtering and HOME/USERPROFILE env construction in tests; use tests/helpers/isolated-env.cjs',
      category: 'Test isolation',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      inlinePathFilter:
        'Hand-written PATH split/filter (#4635). Build the PATH with `isolatedPath({ without: [...] })` ' +
        'from tests/helpers/isolated-env.cjs: it drops every directory holding a named tool, drops ' +
        'relative and empty entries, and keeps `node` resolvable. Five inline copies of this filter ' +
        'drifted apart in one file (#4348), and one of them isolated nothing (#4411).',
      adhocHomeConstruction:
        'Hand-written `{{key}}` in a test env (#4635). Build the env with `isolatedEnv({ home })` from ' +
        'tests/helpers/isolated-env.cjs: it sets HOME and USERPROFILE together, blanks the ' +
        'config-location variables, and strips ambient GSD_* and the runner\'s RUN_TESTS_* / ' +
        'NODE_TEST_CONTEXT. A hand-built env is hermetic on its author\'s machine only (#4312, #4613). ' +
        'In-process, use sandboxHome() from tests/helpers.cjs.',
      staleAllowlistEntry:
        '{{file}} no longer contains an ad-hoc env-isolation copy. Delete its line from ' +
        'eslint-rules/no-adhoc-env-isolation.allowlist.json — the allowlist only ratchets down.',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];

    const rel = path.relative(context.cwd, context.filename).split(path.sep).join('/');
    const allowlisted = allowlist.includes(rel);
    const sourceCode = context.sourceCode;

    let violations = 0;
    function violation(node, messageId, data) {
      violations += 1;
      if (!allowlisted) context.report({ node, messageId, data });
    }

    /** True when `node` is a read of `process.env.PATH` (or `Path`). */
    function isEnvPathRead(node) {
      return (
        node.type === 'MemberExpression' &&
        isProcessEnv(node.object) &&
        PATH_KEYS.has(staticName(node.property, node.computed))
      );
    }

    /**
     * True when `node` evaluates to the process env's PATH: directly, through
     * `||` / `??` / `?:`, `String(...)`, an optional chain, or ONE `const`
     * alias hop (`const p = process.env.PATH; p.split(...)`).
     */
    function readsEnvPath(node, aliasHops = 0) {
      if (!node) return false;
      switch (node.type) {
        case 'ChainExpression':
          return readsEnvPath(node.expression, aliasHops);
        case 'LogicalExpression':
          return readsEnvPath(node.left, aliasHops) || readsEnvPath(node.right, aliasHops);
        case 'ConditionalExpression':
          return readsEnvPath(node.consequent, aliasHops) || readsEnvPath(node.alternate, aliasHops);
        case 'CallExpression':
          return (
            node.callee.type === 'Identifier' &&
            node.callee.name === 'String' &&
            node.arguments.length === 1 &&
            readsEnvPath(node.arguments[0], aliasHops)
          );
        case 'MemberExpression':
          return isEnvPathRead(node);
        case 'Identifier': {
          if (aliasHops > 0) return false;
          const scope = sourceCode.getScope(node);
          const ref = scope.references.find((r) => r.identifier === node);
          const variable = ref && ref.resolved;
          if (!variable || variable.defs.length !== 1) return false;
          const def = variable.defs[0];
          if (def.type !== 'Variable' || !def.parent || def.parent.kind !== 'const') return false;
          return readsEnvPath(def.node.init, aliasHops + 1);
        }
        default:
          return false;
      }
    }

    /** True when `call` (a `.split(...)`) is immediately consumed as `call.filter(...)`. */
    function isFilteredSplit(call) {
      const member = call.parent;
      if (!member || member.type !== 'MemberExpression' || member.object !== call) return false;
      if (staticName(member.property, member.computed) !== 'filter') return false;
      const outer = member.parent;
      return !!outer && outer.type === 'CallExpression' && outer.callee === member;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || staticName(callee.property, callee.computed) !== 'split') {
          return;
        }
        if (readsEnvPath(callee.object) || (isPathDelimiter(node.arguments[0]) && isFilteredSplit(node))) {
          violation(node, 'inlinePathFilter');
        }
      },

      ObjectExpression(node) {
        for (const prop of node.properties) {
          if (prop.type !== 'Property') continue;
          const key = staticName(prop.key, prop.computed);
          if (HOME_KEYS.has(key)) {
            violation(prop, 'adhocHomeConstruction', { key });
            return;
          }
        }
      },

      AssignmentExpression(node) {
        const left = node.left;
        if (left.type !== 'MemberExpression' || isProcessEnv(left.object)) return;
        const key = staticName(left.property, left.computed);
        if (HOME_KEYS.has(key)) violation(node, 'adhocHomeConstruction', { key });
      },

      'Program:exit'(node) {
        if (allowlisted && violations === 0) {
          context.report({ node, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
