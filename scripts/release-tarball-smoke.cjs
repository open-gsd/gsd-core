#!/usr/bin/env node
/**
 * scripts/release-tarball-smoke.cjs
 *
 * Release tarball smoke test for issue #3686.
 *
 * Guards against the class of bugs that can't be caught by working-tree tests:
 *   - #3684: maskIfSecret import/export mismatch shipped in v1.42.3 (runtime
 *     crash on installed package, invisible to unit tests)
 *
 * Strategy: pack the working tree, install into a temp prefix, invoke the
 * installed binary, assert the version matches package.json. Exercises the
 * INSTALLED package, not the working tree.
 *
 * Exports:
 *   SMOKE  — frozen enum of result codes
 *   runSmoke({ tarballPath, installPrefix, expectedVersion, fixtureDir,
 *              lifecycleCommands, dryRun })
 *     → { code: SMOKE.*, details: { version, tarball, ... } }
 *
 * CLI entry: node scripts/release-tarball-smoke.cjs --json
 *   Packs working tree, installs to a temp prefix, checks version.
 *   Exits 0 on SMOKE.OK, 1 otherwise.
 *   Always prints JSON to stdout when --json flag is present.
 *
 * Lifecycle command checks (Cycle 2):
 *   For each command name (other than 'init') in lifecycleCommands:
 *     - Assert commands/gsd/<cmd>.md exists in the installed package
 *     - Parse the .md for a workflow @-import or inline reference
 *     - Assert the referenced workflow .md exists in the installed package
 *   If 'init' is in lifecycleCommands, runs `get-shit-done-redux --local --claude`
 *   in fixtureDir to verify the installer is callable (INIT_FAILED on crash).
 *   Non-interactive: --local --claude flags skip all prompts.
 *
 * Workflow-body checks (Cycle 3 — informational):
 *   - Scans all installed get-shit-done/workflows/*.md for /gsd:<known-cmd>
 *     colon-namespace leaks (WORKFLOW_BODY_COLON_LEAK).
 *   This check populates result.details with counters but does NOT return a
 *   failure code by default; it is informational until enforcement is enabled.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CHILD_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Frozen result-code enum
// ---------------------------------------------------------------------------

const SMOKE = Object.freeze({
  OK: 'ok',
  VERSION_MISMATCH: 'version_mismatch',
  PACK_FAILED: 'pack_failed',
  INSTALL_FAILED: 'install_failed',
  BIN_NOT_CALLABLE: 'bin_not_callable',
  // Cycle 2 codes
  COMMAND_FILE_MISSING: 'command_file_missing',
  WORKFLOW_FILE_MISSING: 'workflow_file_missing',
  INIT_FAILED: 'init_failed',
  // Cycle 3 code
  WORKFLOW_BODY_COLON_LEAK: 'workflow_body_colon_leak',
});

// ---------------------------------------------------------------------------
// Exported helper: binInvocation
// ---------------------------------------------------------------------------

/**
 * Build the { command, args, shell } descriptor needed to spawn an installed
 * npm bin correctly on both Windows and POSIX.
 *
 * On Windows, npm installs a `.cmd` (or `.bat`) shim in .bin/.  Node ≥18.20.2
 * / ≥20.12.2 throws EINVAL when you try to spawnSync a .cmd/.bat without
 * shell:true (CVE-2024-27980 mitigation).  With shell:true, Node does NOT
 * auto-quote argv, so a bin path that contains spaces must be wrapped in
 * double-quotes to arrive at the shell as one token.
 *
 * On POSIX the bin is a regular shebang JS file; we invoke it directly via
 * process.execPath (the same Node binary) without a shell.
 *
 * @param {string}   binPath  - Absolute path to the resolved bin file.
 * @param {string[]} [args]   - Additional arguments (e.g. ['--help']).
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
function binInvocation(binPath, args = []) {
  const lower = binPath.toLowerCase();
  // Note: .ps1 shims are intentionally NOT handled here.  The bin-resolution
  // helpers (findGsdToolsBin / findInstallerBin) only ever surface a .cmd path
  // on Windows — npm does not write .ps1 shims into .bin/ by default — so a
  // .ps1 path never reaches this function in practice.
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // Quote the path if it contains a space so the Windows shell treats it as
    // a single token.  Simple double-quote wrap is sufficient because npm-
    // generated shim paths don't contain embedded double-quotes.
    const command = binPath.includes(' ') ? `"${binPath}"` : binPath;
    return { command, args: [...args], shell: true };
  }
  // POSIX: invoke via node, no shell needed.
  return { command: process.execPath, args: [binPath, ...args], shell: false };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Locate the lib/node_modules/@opengsd/get-shit-done-redux package root inside
 * an npm --prefix install directory.
 */
function pkgRoot(installPrefix) {
  // POSIX: <prefix>/lib/node_modules/@opengsd/get-shit-done-redux
  // Windows: <prefix>/node_modules/@opengsd/get-shit-done-redux
  const posix = path.join(installPrefix, 'lib', 'node_modules', '@opengsd', 'get-shit-done-redux');
  const win = path.join(installPrefix, 'node_modules', '@opengsd', 'get-shit-done-redux');
  return fs.existsSync(posix) ? posix : win;
}

/**
 * Return the ordered list of candidate paths to check when locating an npm
 * global bin named `name` under `installPrefix`.
 *
 * On Windows, `npm install -g --prefix X` writes shims (*.cmd, *.ps1, bare)
 * to the PREFIX ROOT (X\), NOT to X\node_modules\.bin\.  We therefore probe
 * the prefix root first, then fall back to node_modules\.bin in case a
 * non-standard layout puts them there.
 *
 * On POSIX the shim lands in <prefix>/bin/ as a symlink; only one candidate.
 */
function binCandidates(installPrefix, name) {
  if (process.platform === 'win32') {
    return [
      // npm global --prefix on Windows writes shims to the prefix ROOT
      path.join(installPrefix, `${name}.cmd`),
      path.join(installPrefix, name),
      // fallback: some layouts use node_modules/.bin
      path.join(installPrefix, 'node_modules', '.bin', `${name}.cmd`),
      path.join(installPrefix, 'node_modules', '.bin', name),
    ];
  }
  return [path.join(installPrefix, 'bin', name)];
}

/**
 * Locate the installed gsd-tools binary (symlink in <prefix>/bin/).
 */
function findGsdToolsBin(installPrefix) {
  for (const c of binCandidates(installPrefix, 'gsd-tools')) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Locate the get-shit-done-redux installer binary (the symlink in <prefix>/bin/).
 */
function findInstallerBin(installPrefix) {
  for (const c of binCandidates(installPrefix, 'get-shit-done-redux')) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Parse a command .md file and return the first workflow path it references.
 *
 * Structured parser — only inspects individual lines; never regexes on the
 * whole-file string. Two recognised forms (in priority order):
 *
 *   1. @-import line:  `@~/.claude/get-shit-done/workflows/<name>.md`
 *   2. Inline mention: any line containing `~/.claude/get-shit-done/workflows/<name>.md`
 *      (takes the LAST occurrence so conditional-dispatch files resolve to the
 *       default / unconditional branch, e.g. discuss-phase.md)
 *
 * Returns the bare workflow filename (e.g. `"discuss-phase.md"`) or null.
 */
function parseWorkflowRef(mdContent) {
  const WORKFLOW_PREFIX = 'get-shit-done/workflows/';
  let atImportResult = null;
  let lastInlineResult = null;

  const lines = mdContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();

    // Form 1: @-import
    if (trimmed.startsWith('@') && trimmed.includes(WORKFLOW_PREFIX)) {
      const idx = trimmed.indexOf(WORKFLOW_PREFIX);
      const rest = trimmed.slice(idx + WORKFLOW_PREFIX.length);
      // rest is like "discuss-phase.md" or "discuss-phase.md end-to-end."
      const name = rest.split(/[\s`"]/)[0];
      if (name.endsWith('.md')) {
        atImportResult = name;
        break; // @-imports are authoritative; stop on first
      }
    }

    // Form 2: inline mention (collect last)
    if (trimmed.includes(WORKFLOW_PREFIX)) {
      const idx = trimmed.indexOf(WORKFLOW_PREFIX);
      const rest = trimmed.slice(idx + WORKFLOW_PREFIX.length);
      const name = rest.split(/[\s`"]/)[0];
      if (name.endsWith('.md')) {
        lastInlineResult = name;
      }
    }
  }

  return atImportResult !== null ? atImportResult : lastInlineResult;
}

/**
 * Read the list of known GSD command names from the installed package.
 * Returns an array of strings like `['init', 'discuss-phase', ...]`.
 */
function readInstalledCmdNames(pkg) {
  const commandsDir = path.join(pkg, 'commands', 'gsd');
  if (!fs.existsSync(commandsDir)) return [];
  return fs.readdirSync(commandsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3)); // strip .md
}

/**
 * Scan a single workflow .md file for /gsd:<cmd> colon-namespace leaks.
 *
 * Uses the word-boundary-safe regex shape from scripts/fix-slash-commands.cjs:
 *   /gsd-(<cmd1>|<cmd2>|...)(?=[^a-zA-Z0-9_-]|$)/g  — forward
 * We check the colon form: /gsd:<cmd> leaking in installed workflow bodies.
 *
 * Returns the first leaking { line, lineNumber } or null.
 */
function scanWorkflowColonLeak(filePath, cmdNames) {
  if (!cmdNames || cmdNames.length === 0) return null;
  const sorted = [...cmdNames].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`/gsd:(${sorted.join('|')})(?=[^a-zA-Z0-9_-]|$)`, 'g');

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[i])) {
      return { line: i + 1, content: lines[i].trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure function: runSmoke
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string}   opts.tarballPath        - Absolute path to a pre-packed .tgz
 * @param {string}   opts.installPrefix      - Temp directory to use as npm --prefix
 * @param {string}   opts.expectedVersion    - semver string to assert (e.g. "1.50.0")
 * @param {string}   [opts.fixtureDir]       - Temp dir to run `init` into (must NOT be HOME)
 * @param {string[]} [opts.lifecycleCommands] - Commands to file-check (default: see below)
 * @param {boolean}  [opts.dryRun=false]     - If true, skip actual npm install; validate input only
 * @param {object}   [opts.npmEnv]           - Optional env dict for the internal npm install
 *   spawnSync call. Pass an isolated HOME env (e.g. from isolatedNpmEnv() in tests/helpers.cjs)
 *   to prevent npm from reading/writing the caller's $HOME — required on Docker hosts where HOME
 *   may be unwritable. Defaults to process.env. (#131)
 * @returns {{ code: string, details: object }}
 */
function runSmoke({
  tarballPath,
  installPrefix,
  expectedVersion,
  fixtureDir,
  lifecycleCommands = ['init', 'discuss-phase', 'plan-phase', 'execute-phase'],
  dryRun = false,
  npmEnv = undefined,
}) {
  const details = {
    tarball: tarballPath,
    prefix: installPrefix,
    expectedVersion,
  };

  if (dryRun) {
    return { code: SMOKE.OK, details: { ...details, version: expectedVersion, dryRun: true } };
  }

  // --- Install the tarball into the temp prefix ----------------------------
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Use the caller-supplied npmEnv if provided (allows HOME isolation on Docker
  // hosts where HOME may be unwritable — same pattern as runNpm() in helpers.cjs).
  // Falls back to process.env to preserve existing CLI / programmatic behaviour. (#131)
  const effectiveNpmEnv = npmEnv !== undefined ? npmEnv : process.env;
  const installResult = spawnSync(
    npmCmd,
    ['install', '-g', '--prefix', installPrefix, tarballPath],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: CHILD_TIMEOUT_MS, env: effectiveNpmEnv },
  );

  if (installResult.status !== 0) {
    return {
      code: SMOKE.INSTALL_FAILED,
      details: {
        ...details,
        stderr: installResult.stderr,
        stdout: installResult.stdout,
      },
    };
  }

  // --- Locate the installed gsd-tools binary --------------------------------
  const actualBin = findGsdToolsBin(installPrefix);

  if (!actualBin) {
    const searched = binCandidates(installPrefix, 'gsd-tools');
    return {
      code: SMOKE.BIN_NOT_CALLABLE,
      details: { ...details, searched },
    };
  }

  // --- Invoke `gsd-tools --help` to assert the shipped binary is callable ---
  // Use effectiveNpmEnv so the installed binary sees an isolated HOME on Docker
  // hosts where HOME may be unwritable (same isolation as the npm install). (#131)
  const versionInvocation = binInvocation(actualBin, ['--help']);
  const versionResult = spawnSync(
    versionInvocation.command,
    versionInvocation.args,
    { encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS, env: effectiveNpmEnv, shell: versionInvocation.shell },
  );

  if (versionResult.status !== 0) {
    return {
      code: SMOKE.BIN_NOT_CALLABLE,
      details: {
        ...details,
        bin: actualBin,
        stderr: versionResult.stderr,
        stdout: versionResult.stdout,
      },
    };
  }

  // Source of truth for shipped version is the installed package.json.
  const installedPkgPath = path.join(pkgRoot(installPrefix), 'package.json');
  const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
  const installedVersion = String(installedPkg.version || '').trim();

  details.version = installedVersion;
  details.bin = actualBin;
  details.installedPackageJson = installedPkgPath;

  if (installedVersion !== expectedVersion) {
    return {
      code: SMOKE.VERSION_MISMATCH,
      details: { ...details, installedVersion, expectedVersion },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cycle 2: lifecycle command file-resolution checks
  // ─────────────────────────────────────────────────────────────────────────

  const pkg = pkgRoot(installPrefix);
  const shouldRunInit = lifecycleCommands.includes('init');
  const commandsToCheck = lifecycleCommands.filter((c) => c !== 'init');

  // --- Run init if requested -----------------------------------------------
  if (shouldRunInit && fixtureDir) {
    const installerBin = findInstallerBin(installPrefix);
    if (!installerBin) {
      return {
        code: SMOKE.INIT_FAILED,
        details: {
          ...details,
          reason: 'get-shit-done-redux binary not found in installPrefix',
          installPrefix,
        },
      };
    }

    // Non-interactive: --local --claude installs to .claude/ in cwd (fixtureDir).
    // GSD_TEST_MODE must be cleared — install.js skips its main() block when
    // GSD_TEST_MODE is set, which would cause the installer to exit 0 silently
    // without actually creating any files.
    const initEnv = { ...process.env };
    delete initEnv.GSD_TEST_MODE;

    const initInvocation = binInvocation(installerBin, ['--local', '--claude']);
    const initResult = spawnSync(
      initInvocation.command,
      initInvocation.args,
      {
        encoding: 'utf-8',
        cwd: fixtureDir,
        // Ensure no TTY so the installer's non-interactive fallback fires
        stdio: ['pipe', 'pipe', 'pipe'],
        env: initEnv,
        timeout: CHILD_TIMEOUT_MS,
        shell: initInvocation.shell,
      },
    );

    if (initResult.status !== 0) {
      return {
        code: SMOKE.INIT_FAILED,
        details: {
          ...details,
          fixtureDir,
          stderr: initResult.stderr,
          stdout: initResult.stdout,
        },
      };
    }

    // Verify expected dirs were created
    const expectedDirs = [
      path.join(fixtureDir, '.claude', 'commands'),
      path.join(fixtureDir, '.claude', 'get-shit-done'),
    ];
    for (const dir of expectedDirs) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return {
          code: SMOKE.INIT_FAILED,
          details: {
            ...details,
            fixtureDir,
            reason: `expected dir not created: ${dir}`,
          },
        };
      }
    }
  }

  // --- Check command files and workflow references -------------------------
  const lifecycleResolved = [];

  for (const cmd of commandsToCheck) {
    const cmdFilePath = path.join(pkg, 'commands', 'gsd', `${cmd}.md`);

    if (!fs.existsSync(cmdFilePath) || !fs.statSync(cmdFilePath).isFile()) {
      return {
        code: SMOKE.COMMAND_FILE_MISSING,
        details: {
          ...details,
          command: cmd,
          path: cmdFilePath,
        },
      };
    }

    // Parse workflow reference
    const mdContent = fs.readFileSync(cmdFilePath, 'utf-8');
    const workflowName = parseWorkflowRef(mdContent);

    let workflowPath = null;
    if (workflowName) {
      // Workflow files live at get-shit-done/workflows/<name> in the package.
      // Some live in subdirectories; try flat first then scan once.
      const flat = path.join(pkg, 'get-shit-done', 'workflows', workflowName);
      workflowPath = fs.existsSync(flat) ? flat : null;

      if (!workflowPath) {
        return {
          code: SMOKE.WORKFLOW_FILE_MISSING,
          details: {
            ...details,
            command: cmd,
            path: flat,
          },
        };
      }
    }

    lifecycleResolved.push({
      command: cmd,
      commandPath: cmdFilePath,
      workflowPath,
    });
  }

  details.lifecycleResolved = lifecycleResolved;

  // ─────────────────────────────────────────────────────────────────────────
  // Cycle 3: workflow-body validation (informational)
  // ─────────────────────────────────────────────────────────────────────────

  // --- Workflow-body checks (informational — #3668 not yet fixed) ----------
  const workflowsDir = path.join(pkg, 'get-shit-done', 'workflows');
  const installedCmdNames = readInstalledCmdNames(pkg);

  let workflowsScanned = 0;
  let colonLeakCount = 0;
  // Store first finding for potential future enforcement mode.
  let firstColonLeak = null;

  if (fs.existsSync(workflowsDir)) {
    // Collect all .md files (flat only — subdirs contain sub-workflows that
    // follow the same contract, but the top-level .md files are the primary surface)
    const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(workflowsDir, entry.name);
      workflowsScanned++;

      const leak = scanWorkflowColonLeak(filePath, installedCmdNames);
      if (leak) {
        colonLeakCount++;
        if (!firstColonLeak) {
          firstColonLeak = { file: filePath, line: leak.line };
        }
      }

    }
  }

  details.workflowsScanned = workflowsScanned;
  details.colonLeakCount = colonLeakCount;
  if (firstColonLeak) details.firstColonLeak = firstColonLeak;

  // NOTE: colonLeakCount is informational here. Once the backlog is fixed,
  // a future enforcement mode can fail on non-zero counts.

  return { code: SMOKE.OK, details };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function cliMain() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const expectedVersion = process.env.SMOKE_FORCE_EXPECTED_VERSION || pkg.version;

  // Pack the working tree into a temp directory
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-smoke-pack-'));
  const installPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-smoke-prefix-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-smoke-fixture-'));

  let tarballPath;
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packOutput = execFileSync(
      npmCmd,
      ['pack', '--pack-destination', packDir],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf-8',
        shell: process.platform === 'win32',
        timeout: CHILD_TIMEOUT_MS,
      },
    ).trim();
    // npm pack outputs the filename on stdout (last line when verbose)
    const lines = packOutput.split(/\r?\n/).filter(Boolean);
    const tgzName = lines[lines.length - 1];
    tarballPath = path.join(packDir, tgzName);
    if (!fs.existsSync(tarballPath)) {
      // npm 7+ may print just the filename without .tgz extension on some platforms
      const found = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
      if (found) {
        tarballPath = path.join(packDir, found);
      } else {
        const result = {
          code: SMOKE.PACK_FAILED,
          details: { packDir, packOutput, reason: 'no .tgz in pack destination' },
        };
        if (isJson) process.stdout.write(JSON.stringify(result) + '\n');
        cleanup(packDir, installPrefix, fixtureDir);
        process.exit(1);
      }
    }
  } catch (err) {
    const result = {
      code: SMOKE.PACK_FAILED,
      details: { error: err.message, stderr: err.stderr },
    };
    if (isJson) process.stdout.write(JSON.stringify(result) + '\n');
    cleanup(packDir, installPrefix, fixtureDir);
    process.exit(1);
  }

  const result = runSmoke({ tarballPath, installPrefix, expectedVersion, fixtureDir });
  if (isJson) process.stdout.write(JSON.stringify(result) + '\n');
  cleanup(packDir, installPrefix, fixtureDir);
  process.exit(result.code === SMOKE.OK ? 0 : 1);
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { SMOKE, runSmoke, binInvocation };

if (require.main === module) {
  cliMain();
}
