'use strict';

/**
 * require-read-only-git-env
 *
 * Flag: a direct `execFileSync('git', ...)` / `spawnSync('git', ...)` whose
 * options object literal does not carry an `env` built from `readOnlyGitEnv()`.
 *
 * Why (#5048): git refreshes the index on many read commands and takes an
 * optional `.git/index.lock` to write it back. A read-only spawn that does so
 * can make a concurrent `git commit` fail. `readOnlyGitEnv()`
 * (src/read-only-git-env.cts) is the single owner of the `GIT_OPTIONAL_LOCKS=0`
 * block; a spawn that skips it silently reintroduces the contention, and a test
 * that greps for the literal cannot see a seam that stopped consulting the
 * owner. This rule makes the omission a lint error at the spawn itself.
 *
 * Scope: `src/**\/*.cts` and `hooks/**\/*.js`. Tests are out of scope.
 *
 * ── Known boundaries ─────────────────────────────────────────────────────────
 *
 * (a) Name-based matching, like require-subprocess-timeout: a bare
 *     `execFileSync` / `spawnSync` call or a dotted call on any object
 *     (`childProcess.spawnSync`), with a string-literal first argument `git` or
 *     `git.exe`. A command held in a variable (`spawnSync(cmd, ...)`) is not
 *     traced.
 * (b) The options argument sits at fixed index 2. Only an OBJECT LITERAL is
 *     inspected; an Identifier or pre-built options value is not flagged
 *     (precision over recall).
 * (c) The `env` property must contain a call to `readOnlyGitEnv`, anywhere in
 *     its value expression, so `env: readOnlyGitEnv()` and
 *     `env: { ...readOnlyGitEnv(), X: '1', ...opts.env }` both pass. When the
 *     value is a plain variable (`env` or `env: spawnEnv`), the variable's
 *     declaration initializer is checked instead; one hop, no further tracing.
 * (d) A git command that never opens the index (`rev-list`,
 *     `branch --show-current`, `worktree list`) needs no opt-out; it is exempt
 *     with `// allow-index-refresh: <reason>` on the call's start or end line.
 */

const SPAWN_METHODS = new Set(['execFileSync', 'spawnSync']);
const OPTIONS_ARG_INDEX = 2;

function matchSpawnMethod(node) {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee.type === 'Identifier' && SPAWN_METHODS.has(callee.name)) return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    SPAWN_METHODS.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

function isGitCommand(arg) {
  return Boolean(arg) && arg.type === 'Literal' && (arg.value === 'git' || arg.value === 'git.exe');
}

function propertyKeyName(prop) {
  if (prop.type !== 'Property') return null;
  if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function valueCallsReadOnlyGitEnv(value, sourceCode) {
  const tokens = sourceCode.getTokens(value);
  return tokens.some((token, i) => token.type === 'Identifier'
    && token.value === 'readOnlyGitEnv'
    && tokens[i + 1] !== undefined
    && tokens[i + 1].type === 'Punctuator'
    && tokens[i + 1].value === '(');
}

// `env` given as a plain variable (`const env = { ...readOnlyGitEnv(), ... }`
// then `{ env }`): follow the identifier to its declaration and look there.
function declarationInit(identifier, node, sourceCode) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      const def = variable.defs[0];
      return def && def.node.type === 'VariableDeclarator' ? def.node.init : null;
    }
    scope = scope.upper;
  }
  return null;
}

function envComesFromReadOnlyGitEnv(envValue, node, sourceCode) {
  if (valueCallsReadOnlyGitEnv(envValue, sourceCode)) return true;
  if (envValue.type !== 'Identifier') return false;
  const init = declarationInit(envValue, node, sourceCode);
  return Boolean(init) && valueCallsReadOnlyGitEnv(init, sourceCode);
}

function hasSuppressionComment(node, sourceCode) {
  const startLine = node.loc.start.line;
  const endLine = node.loc.end.line;
  return sourceCode.getAllComments().some((c) => {
    if (!/allow-index-refresh:\s*\S/.test(c.value)) return false;
    return c.loc.start.line === startLine || c.loc.start.line === endLine;
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a direct git spawn to take its env from readOnlyGitEnv() (#5048)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      requireReadOnlyGitEnv:
        'Direct git spawn without `env: readOnlyGitEnv()`: git refreshes the index and takes an optional ' +
        '.git/index.lock, which can make a concurrent commit fail (#5048). Pass `env: readOnlyGitEnv()` ' +
        '(src/read-only-git-env.cts), or, for a command that never opens the index, ' +
        'suppress with: // allow-index-refresh: <reason>',
    },
  },

  create(context) {
    const filename = (context.getFilename ? context.getFilename() : context.filename).replace(/\\/g, '/');
    const inScope = /(?:^|\/)src\/.*\.cts$/.test(filename) || /(?:^|\/)hooks\/.*\.js$/.test(filename);
    if (!inScope) return {};

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        if (!matchSpawnMethod(node)) return;
        if (!isGitCommand(node.arguments[0])) return;

        const options = node.arguments[OPTIONS_ARG_INDEX];
        // Precision over recall: a pre-built options value is not traced.
        if (options !== undefined && options.type !== 'ObjectExpression') return;

        if (options) {
          const envProp = options.properties.find((prop) => propertyKeyName(prop) === 'env');
          if (envProp && envComesFromReadOnlyGitEnv(envProp.value, node, sourceCode)) return;
        }

        if (hasSuppressionComment(node, sourceCode)) return;

        context.report({ node, messageId: 'requireReadOnlyGitEnv' });
      },
    };
  },
};

module.exports = rule;
