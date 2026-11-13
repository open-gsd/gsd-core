'use strict';

const path = require('path');

/**
 * no-adhoc-env-isolation
 *
 * Epic #4635 gave child-env isolation for tests one owner,
 * `tests/helpers/isolated-env.cjs` (#6033): `isolatedEnv({ home })` builds the
 * env a test hands to a child, and `isolatedPath({ without })` builds a PATH
 * the named tools cannot resolve from. This rule (#6035, Phase 3) stops a new
 * hand-written copy of either from being added under `tests/**` while the
 * remaining ones are migrated (Phases 4-7) and the allowlist is deleted
 * (Phase 8).
 *
 * ## Arm 1 — an inline PATH split or filter (`inlinePathFilter`)
 *
 * Flags two shapes:
 *
 *   - `X.split(...)` of any argument, where `X` reads `process.env.PATH` (or
 *     `process.env.Path`, the key Windows enumerates) directly, through
 *     `||` / `??` / `?:`, through `String(...)`, or through a single `const`
 *     alias hop. This is #4411's `makeIsolatedPath`, which split the full
 *     system PATH, prepended a directory and re-joined it — isolating nothing
 *     — without ever calling `.filter`.
 *   - `X.split(<delimiter>).filter(...)`, whatever `X` is, where
 *     `<delimiter>` is `path.delimiter` (any `*.delimiter` member) or a bare
 *     `delimiter` identifier. This is the filter copy #4348 counted: its
 *     receiver was a parameter defaulting to `process.env.PATH`
 *     (`(basePath ?? '').split(path.delimiter).filter(...)`), so a rule keyed
 *     on reading `process.env.PATH` alone would miss it.
 *
 * A split of a PATH some other object carries (`result.path`, the `env` the
 * code under test returned) is not flagged unless it is filtered.
 *
 * ## Arm 2 — direct HOME / USERPROFILE construction (`adhocHomeConstruction`)
 *
 * Flags an object literal with a `HOME` or `USERPROFILE` key (identifier,
 * string or computed string key), reported once per object, and an assignment
 * to `X.HOME` / `X.USERPROFILE` (or `X['HOME']`) where `X` is not
 * `process.env`. Both build an env by hand: `{ ...process.env, HOME: tmp }`,
 * `runGsdTools(args, cwd, { HOME: tmp })`, `childEnv.HOME = tmp`.
 *
 * ## Exempt file and allowlist
 *
 * `tests/helpers/isolated-env.cjs` is the implementation and is excluded in
 * `eslint.config.mjs`. `allowlist` (repo-relative POSIX paths) holds the files
 * that still carry a copy: an allowlisted file's violations are counted but
 * not reported, and a listed file with zero violations reports
 * `staleAllowlistEntry` so its entry is deleted. The allowlist only ratchets
 * down; there is no inline marker escape.
 *
 * ## Known gaps (the ratchet is deliberately narrow)
 *
 *   - In-process mutation, `process.env.HOME = x`, is not flagged: the
 *     isolation helper covers the env handed to a CHILD, and in-process
 *     isolation is `sandboxHome()` / `scrubConfigLocationEnv()` in
 *     `tests/helpers.cjs` (CONTRIBUTING.md).
 *   - An object spread of the process env, `{ ...process.env }`, with no
 *     HOME/USERPROFILE key and no PATH filter is not flagged.
 *   - A PATH filter written as a loop, or over a split held in a variable,
 *     whose receiver does not read `process.env.PATH` directly (a parameter, a
 *     property of another object) is not flagged: only a split consumed
 *     directly by `.filter(...)` is.
 *   - Any split of `process.env.PATH` is flagged, a diagnostic that only counts
 *     its entries included: the rule cannot tell a count from a copy.
 *   - Key names match exactly: `Home` or `userprofile` keys are not flagged.
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

    const filename = context.filename || context.getFilename();
    const cwd = context.cwd || (context.getCwd ? context.getCwd() : process.cwd());
    const rel = path.relative(cwd, filename).split(path.sep).join('/');
    const allowlisted = allowlist.includes(rel);
    const sourceCode = context.sourceCode || context.getSourceCode();

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
