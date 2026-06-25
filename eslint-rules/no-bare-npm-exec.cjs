'use strict';

/**
 * no-bare-npm-exec
 *
 * Flag bare 'npm' invocations via execFileSync/spawnSync/spawn without
 * `shell: true`. On Windows, `npm` is `npm.cmd` — a CMD batch file — and
 * cannot be launched without a shell.
 *
 * ## What this enforces (G5)
 *
 * - `execFileSync('npm', ...)` / `spawnSync('npm', ...)` / `spawn('npm', ...)`
 *   whose options object (last arg, if ObjectExpression) does NOT set
 *   `shell: true`, `shell: isWindows`, or `shell: process.platform === 'win32'`.
 *
 * ## What this does NOT flag
 *
 * - `execSync('npm install', ...)` — execSync always runs through a shell
 *   (cmd.exe on Windows automatically resolves npm.cmd), so it is safe without
 *   `shell: true`. Only direct binary exec functions (execFileSync, spawnSync,
 *   spawn) bypass the shell and require explicit `{ shell: true }`.
 *
 * Message: Windows needs `npm.cmd` — pass `{ shell: true }`.
 *
 * DEFECT category: DEFECT.WINDOWS-TEST-PORTABILITY
 */

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow bare "npm" execFileSync/spawnSync/spawn/execSync without shell:true (fails on Windows)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      bareNpmExec:
        'Bare "npm" invocation without { shell: true } is not portable ' +
        '(DEFECT.WINDOWS-TEST-PORTABILITY): On Windows, npm is a CMD batch file ' +
        '(npm.cmd) and requires a shell to execute. Pass { shell: true } as the ' +
        'options argument.',
    },
  },

  create(context) {
    /** Functions that take (command, args, options) — direct binary exec, no shell */
    const EXEC_FILE_FNS = new Set(['execFileSync', 'spawnSync', 'spawn']);

    /**
     * Returns the string value of a Literal node, or null.
     * @param {import('eslint').Rule.Node} node
     * @returns {string|null}
     */
    function stringValue(node) {
      if (node && node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
      }
      return null;
    }

    /**
     * Returns the function name for a CallExpression callee (Identifier or
     * MemberExpression), or null if not recognized.
     * @param {import('eslint').Rule.Node} callee
     * @returns {string|null}
     */
    function getFnName(callee) {
      if (callee.type === 'Identifier') return callee.name;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        return callee.property.name;
      }
      return null;
    }

    /**
     * Returns true if an ObjectExpression has `shell: true`, `shell: isWindows`,
     * or `shell: process.platform === 'win32'`.
     * @param {import('eslint').Rule.Node} optionsNode
     * @returns {boolean}
     */
    function hasShellTrue(optionsNode) {
      if (!optionsNode || optionsNode.type !== 'ObjectExpression') return false;
      for (const prop of optionsNode.properties) {
        if (prop.type !== 'Property') continue;
        const keyName =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : stringValue(prop.key);
        if (keyName !== 'shell') continue;
        const val = prop.value;
        // shell: true
        if (val.type === 'Literal' && val.value === true) return true;
        // shell: isWindows / shell: IS_WINDOWS / shell: isWin / shell: onWindows
        if (val.type === 'Identifier') {
          const name = val.name;
          if (
            name === 'isWindows' ||
            name === 'IS_WINDOWS' ||
            name === 'isWin' ||
            name === 'onWindows'
          ) {
            return true;
          }
        }
        // shell: process.platform === 'win32'
        if (
          val.type === 'BinaryExpression' &&
          (val.operator === '===' || val.operator === '==') &&
          val.left.type === 'MemberExpression' &&
          val.left.object.type === 'Identifier' &&
          val.left.object.name === 'process' &&
          val.left.property.type === 'Identifier' &&
          val.left.property.name === 'platform' &&
          val.right.type === 'Literal' &&
          val.right.value === 'win32'
        ) {
          return true;
        }
      }
      return false;
    }

    return {
      CallExpression(node) {
        const fnName = getFnName(node.callee);
        if (!fnName) return;

        const args = node.arguments;
        if (!args || args.length === 0) return;

        // Pattern A: execFileSync/spawnSync/spawn('npm', ...)
        if (EXEC_FILE_FNS.has(fnName)) {
          const firstArg = stringValue(args[0]);
          if (firstArg !== 'npm') return;

          // Find last ObjectExpression argument as the options
          const lastArg = args[args.length - 1];
          if (hasShellTrue(lastArg)) return;

          // No shell:true — report
          context.report({ node, messageId: 'bareNpmExec' });
        }
      },
    };
  },
};

module.exports = rule;
