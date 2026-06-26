'use strict';

/**
 * no-unguarded-nonportable-exec
 *
 * Flag test files that BOTH make a fixture executable via chmod (exec-bit set)
 * AND invoke it with `sh -c` / `bash -c` — without a Windows platform guard.
 *
 * ## Why
 *
 * Windows Git Bash (msys2) does not honour Node's chmod exec bit for
 * PATH-executing extension-less scripts. A test that (a) makes a fixture
 * executable via chmodSync and (b) runs it with `sh -c`/`bash -c` will pass
 * on Mac/Linux but fail only in the CI `test (windows-latest, *)` /
 * `full test (windows-latest, *)` lanes, producing a hard-to-diagnose
 * false-negative gate. See CONTEXT.md → DEFECT.WINDOWS-TEST-PORTABILITY.
 *
 * ## What this enforces (Program-level co-occurrence)
 *
 * Within a single file, detects the combination:
 *   - makesExecutable: any `chmod`/`chmodSync(path, 0oNNN)` call where the
 *     octal 2nd arg has exec bits set (`0oNNN & 0o111 !== 0`)
 *   - shellDashC: any `execFileSync`/`spawnSync`/`spawn`/`exec`/`execSync`
 *     call whose command arg is `sh`/`bash`/`/bin/sh`/`/bin/bash` with a `-c`
 *     arg in array form — or a string literal arg containing `sh -c`/`bash -c`
 *
 * At Program:exit, reports each unguarded shellDashC node when the file also
 * contains a chmod-exec-bit call. Guarded means the node is inside an
 * `isWindowsExcludedNode` block (platform guard / early-return / hoisted isWindows).
 *
 * ## Remediation
 *
 * Gate the bare-command execution behind `if (process.platform !== 'win32')`,
 * or invoke via an explicit interpreter (`sh <path>` instead of `sh -c <path>`).
 *
 * DEFECT category: DEFECT.WINDOWS-TEST-PORTABILITY
 */

const { isWindowsExcludedNode } = require('./lib/platform-guard.cjs');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow unguarded chmod exec-bit + sh/bash -c combinations in tests (fails on Windows Git Bash)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      nonportableExec:
        'chmod exec-bit + sh/bash -c without a Windows guard ' +
        '(DEFECT.WINDOWS-TEST-PORTABILITY): Windows Git Bash (msys2) ignores ' +
        "the exec bit for PATH-executed extension-less scripts. Gate the " +
        "execution on `if (process.platform !== 'win32')` or invoke via an " +
        'explicit interpreter `sh <path>` instead of `sh -c`.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /**
     * Shell commands whose first argument is the shell name.
     * Matches execFileSync, spawnSync, spawn, exec, execSync.
     */
    const SHELL_EXEC_FN_NAMES = new Set([
      'execFileSync',
      'spawnSync',
      'spawn',
      'exec',
      'execSync',
    ]);

    /**
     * Bare shell names (possibly with /bin/ or /usr/bin/ prefix).
     * The path prefix is stripped when comparing.
     */
    const SHELL_NAMES = new Set(['sh', 'bash']);

    /**
     * Returns the string value of a node if it's a string literal, else null.
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
     * Returns true if `name` (possibly /bin/sh or /usr/bin/bash etc.) is sh/bash.
     * @param {string} name
     * @returns {boolean}
     */
    function isShellName(name) {
      // Strip /bin/ or /usr/bin/ prefix
      const bare = name.replace(/^(?:\/usr)?\/bin\//, '');
      return SHELL_NAMES.has(bare);
    }

    /**
     * Returns true when this CallExpression is a `sh`/`bash -c` invocation in
     * array form:
     *   execFileSync('bash', ['-c', ...])
     *   spawnSync('/bin/sh', ['-c', ...])
     *   etc.
     *
     * @param {import('eslint').Rule.Node} node — CallExpression
     * @returns {boolean}
     */
    function isShellDashCArrayForm(node) {
      if (node.type !== 'CallExpression') return false;

      // Callee must be one of our shell exec functions (possibly member expr)
      const callee = node.callee;
      let fnName = null;
      if (callee.type === 'Identifier') {
        fnName = callee.name;
      } else if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        fnName = callee.property.name;
      }
      if (!fnName || !SHELL_EXEC_FN_NAMES.has(fnName)) return false;

      const args = node.arguments;
      if (!args || args.length < 2) return false;

      // First arg: shell name
      const shellArg = stringValue(args[0]);
      if (!shellArg || !isShellName(shellArg)) return false;

      // Second arg: must be an ArrayExpression containing '-c'
      const secondArg = args[1];
      if (!secondArg || secondArg.type !== 'ArrayExpression') return false;

      // '-c' must be the FIRST element: sh/bash -c <cmd> → args = ['-c', <cmd>]
      // A script that happens to receive '-c' later (e.g. [fixturePath, '-c'])
      // is NOT a shell -c invocation.
      const firstEl = secondArg.elements[0];
      return stringValue(firstEl) === '-c';
    }

    /**
     * Returns true when this CallExpression is a string-literal form containing
     * `sh -c` or `bash -c`:
     *   exec('sh -c "run.sh"')
     *   execSync('bash -c script')
     *
     * @param {import('eslint').Rule.Node} node — CallExpression
     * @returns {boolean}
     */
    function isShellDashCStringForm(node) {
      if (node.type !== 'CallExpression') return false;

      const callee = node.callee;
      let fnName = null;
      if (callee.type === 'Identifier') {
        fnName = callee.name;
      } else if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        fnName = callee.property.name;
      }
      if (!fnName || !SHELL_EXEC_FN_NAMES.has(fnName)) return false;

      const args = node.arguments;
      if (!args || args.length < 1) return false;

      // First arg may be a string literal containing 'sh -c' or 'bash -c'
      const firstArg = stringValue(args[0]);
      if (!firstArg) return false;

      // Anchor to the start of the command string (allowing leading whitespace and
      // an optional absolute-path prefix like /bin/ or /usr/bin/).
      // This prevents matching 'sh -c' embedded mid-string in data, e.g.
      //   exec('printf "sh -c"')  or  exec('echo run sh -c later')
      return /^\s*(?:\/\S+\/)?(?:bash|sh)\s+-c\b/.test(firstArg);
    }

    /**
     * Returns true when the CallExpression is a chmod/chmodSync call whose
     * second arg is an octal literal with at least one exec bit set.
     *
     * @param {import('eslint').Rule.Node} node — CallExpression
     * @returns {boolean}
     */
    function isChmodExecBit(node) {
      if (node.type !== 'CallExpression') return false;

      const callee = node.callee;
      let fnName = null;
      if (callee.type === 'Identifier') {
        fnName = callee.name;
      } else if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        fnName = callee.property.name;
      }
      if (!fnName || (fnName !== 'chmod' && fnName !== 'chmodSync')) return false;

      const args = node.arguments;
      if (!args || args.length < 2) return false;

      const modeArg = args[1];
      if (!modeArg || modeArg.type !== 'Literal') return false;
      if (typeof modeArg.value !== 'number') return false;

      // Check it's an octal literal (raw source starts with 0o or 0O)
      const raw = sourceCode.getText(modeArg);
      if (!raw.startsWith('0o') && !raw.startsWith('0O')) return false;

      // Check exec bit is set
      return (modeArg.value & 0o111) !== 0;
    }

    // ── Per-file state ──────────────────────────────────────────────────────────

    /** Whether the file contains at least one chmod exec-bit call. */
    let fileHasChmodExecBit = false;

    /** Collection of sh/bash -c nodes found in this file. */
    const shellDashCNodes = [];

    return {
      CallExpression(node) {
        if (isChmodExecBit(node)) {
          fileHasChmodExecBit = true;
        }
        if (isShellDashCArrayForm(node) || isShellDashCStringForm(node)) {
          shellDashCNodes.push(node);
        }
      },

      'Program:exit'() {
        if (!fileHasChmodExecBit) return;

        for (const shellNode of shellDashCNodes) {
          if (!isWindowsExcludedNode(shellNode, sourceCode)) {
            context.report({ node: shellNode, messageId: 'nonportableExec' });
          }
        }
      },
    };
  },
};

module.exports = rule;
