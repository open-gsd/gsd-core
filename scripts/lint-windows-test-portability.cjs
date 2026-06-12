'use strict';

/**
 * lint-windows-test-portability.cjs — flag tests that combine chmod exec-bit
 * with bare sh/bash -c without a platform guard.
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
 * ## What this enforces
 *
 * For every file in tests/**\/*.test.cjs (recursive, excluding node_modules):
 *   - makesExecutable: contains chmodSync?( with an exec-bit octal literal
 *   - shellDashC: contains a sh/bash -c invocation (array form or string literal)
 *   - guarded: contains a process.platform / os.platform() / win32 / isWindows guard
 *   - optOut: contains the literal `windows-portability-ok`
 *   VIOLATION = makesExecutable && shellDashC && !guarded && !optOut
 *
 * ## Remediation
 *
 * Gate the bare-command execution with `if (process.platform !== 'win32')`,
 * or invoke via an explicit interpreter (`sh <path>`), or annotate
 * `// windows-portability-ok: <reason>`.
 *
 * ## Export contract (for unit tests)
 *
 * When required as a module (`require.main !== module`) this file exports
 * `scanContent(source)` → { makesExecutable, shellDashC, guarded, optOut, violation }.
 */

const fs = require('fs');
const path = require('path');

// ─── Detection regexes ──────────────────────────────────────────────────────

/**
 * Match chmod/chmodSync( calls with an octal mode literal whose exec bits are
 * set, e.g. `fs.chmodSync(p, 0o755)` or `chmod(file, 0o111)`.
 */
const CHMOD_RE = /chmod(?:Sync)?\s*\([^,;]+,\s*0o([0-7]{3})\b/g;

/**
 * Array form: execFileSync/spawnSync/exec* with 'sh' or 'bash' (optionally
 * prefixed) as the first arg and '-c' as an element of the args array.
 * e.g. execFileSync('bash', ['-c', ...]) or spawnSync('/bin/sh', ['-c', ...])
 */
const SHELL_ARRAY_RE =
  /(?:execFile(?:Sync)?|spawnSync|spawn|exec)\s*\(\s*['"`](?:\/(?:usr\/)?bin\/)?(?:bash|sh)['"`]\s*,\s*\[[^\]]*['"]-c['"]/;

/**
 * String-literal form: any string containing `bash -c` or `sh -c`.
 */
const SHELL_STRING_RE = /['"`][^'"`\n]*(?:bash|sh)\s+-c[^'"`\n]*['"`]/;

/** Platform guard presence. */
const GUARD_RE = /process\.platform|os\.platform\s*\(|\bwin32\b|\bisWindows\b/;

/** Opt-out annotation. */
const OPT_OUT_RE = /windows-portability-ok/;

// ─── Pure scanning function (exported for unit tests) ────────────────────────

/**
 * Scan a single file's source text and return detection flags.
 *
 * @param {string} source - The file contents as a string.
 * @returns {{ makesExecutable: boolean, shellDashC: boolean, guarded: boolean, optOut: boolean, violation: boolean }}
 */
function scanContent(source) {
  // Reset stateful regex before use.
  CHMOD_RE.lastIndex = 0;

  let makesExecutable = false;
  let match;
  while ((match = CHMOD_RE.exec(source)) !== null) {
    const oct = match[1];
    if ((parseInt(oct, 8) & 0o111) !== 0) {
      makesExecutable = true;
      break;
    }
  }

  const shellDashC = SHELL_ARRAY_RE.test(source) || SHELL_STRING_RE.test(source);
  const guarded = GUARD_RE.test(source);
  const optOut = OPT_OUT_RE.test(source);
  const violation = makesExecutable && shellDashC && !guarded && !optOut;

  return { makesExecutable, shellDashC, guarded, optOut, violation };
}

// ─── Filesystem walker ───────────────────────────────────────────────────────

/**
 * Recursively collect all *.test.cjs files under `dir`, excluding node_modules.
 *
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function collectTestFiles(dir, acc) {
  acc = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
      acc.push(full);
    }
  }
  return acc;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const ROOT = path.join(__dirname, '..');
  const TESTS_DIR = path.join(ROOT, 'tests');

  const files = collectTestFiles(TESTS_DIR);
  const violations = [];

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { violation } = scanContent(source);
    if (violation) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      violations.push(rel);
    }
  }

  if (violations.length > 0) {
    for (const rel of violations) {
      process.stderr.write(
        `${rel}: chmod-executable + sh/bash -c with no platform guard\n`,
      );
    }
    process.stderr.write(
      '\nWindows Git Bash does not honor Node\'s chmod exec bit for ' +
        'PATH-executing extension-less scripts ' +
        '(CONTEXT.md → DEFECT.WINDOWS-TEST-PORTABILITY). ' +
        'Gate the bare-command execution with ' +
        '`if (process.platform !== \'win32\')`, or invoke via an explicit ' +
        'interpreter (`sh <path>`), or annotate ' +
        '`// windows-portability-ok: <reason>`.\n',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `ok lint-windows-test-portability: ${files.length} file(s) scanned, no violations`,
    );
  }
}

// ─── Module boundary ─────────────────────────────────────────────────────────

if (require.main === module) {
  main();
} else {
  module.exports = { scanContent };
}
