#!/usr/bin/env node
'use strict';

/**
 * Generates scripts/lib/platform-conformance-tier.generated.cjs — the list of
 * test files under tests/**\/*.test.cjs whose CONTENT signals they exercise
 * platform-specific behavior (Windows/macOS path quirks, raw child_process
 * usage, chmod mode bits, etc.) and therefore need REAL-OS coverage rather
 * than a Linux-only conformance lane (#4591).
 *
 * Only `unit`-suite test files (no suite suffix, per `scripts/run-tests.cjs`'s
 * `suiteOf()`) are considered for the conformance tier. `install`-,
 * `security`-, `slow`-, `integration`-, and `qa`-suffixed files are excluded
 * entirely — never merely deprioritized — for three independent reasons: (1)
 * `install`/`slow` are explicitly PR-excluded suites
 * (`scripts/affected-tests-lib.cjs`'s `PR_EXCLUDED_SUITES`; "PRs must never
 * select or run these"), and this generator's output feeds a `pull_request`-
 * triggered job; (2) `integration`/`security` already run via their own
 * separate, dedicated, unsharded, shard-1-only steps in the `test` job
 * (.github/workflows/test.yml) — folding any of them into
 * this job's generic `--files-from` + `--shard` invocation is unproven and,
 * per the incident below, unsafe. (3) `qa` (loop-walk-suite files) already
 * runs via its own separate, dedicated `qa-loop-walk` job
 * (.github/workflows/test.yml) — the same rationale as (2): a purpose-built
 * home already exists, so folding it into this job's generic invocation
 * duplicates coverage without benefit. Real incident that surfaced this: a live
 * CI run's `conformance test (windows-latest, shard 2/3)` job was killed with
 * 11 tests in flight — including `tests/release-tarball-smoke.install.test.cjs`
 * — because this generator had (wrongly) placed an `install`-suite file into
 * the Linux-conformance candidate pool with no suite filtering at all.
 *
 * `classifyContent(content)` is the pure, exported classifier: it favors
 * simple, auditable substring/regex matching over AST parsing, mirroring
 * eslint-rules/lib/portability-vocab.cjs's own design stance (over-inclusion
 * is the safe direction — a false positive costs one extra test running on a
 * real OS; a false negative silently drops real-OS coverage).
 *
 * KNOWN LIMIT, disclosed deliberately: this is a STATIC content classifier,
 * not a real per-file, per-OS behavioral diff. Epic #4589's issue #4591 asked
 * for the cutover to be validated by "running the existing full matrix one
 * more time as a parity baseline, diffing pass/fail per file between the
 * real-OS runs and the Linux run" before moving any file into the Linux-only
 * bulk. That literal per-file diff was NOT performed — no historical
 * per-file, per-OS pass/fail dataset exists to diff against (GitHub Actions
 * publishes coverage/QA artifacts from CI runs, not per-file JUnit results).
 * What stands in for it: (1) the most recent push-triggered run on `next`
 * (unconditionally full-matrix) is green on every OS for every file in this
 * classification, confirmed before this classifier was built; (2) the
 * legacy full-matrix job ran the WHOLE suite on real Windows/macOS as a
 * non-gating safety net for one release cycle (.github/workflows/test.yml)
 * before it was retired (#4603) — a classifier miss during that cycle would
 * have surfaced as a visible warning there, not a silent gap. This is the same
 * static-analysis-substitutes-for-real-OS-execution stance ADR-1703's whole
 * rule catalog already takes; it is a real, disclosed limit, not a silent
 * substitution.
 *
 * Usage:
 *   node scripts/gen-platform-conformance-tier.cjs                      # print summary to stdout
 *   node scripts/gen-platform-conformance-tier.cjs --write              # write the generated file
 *   node scripts/gen-platform-conformance-tier.cjs --check              # exit 1 if the committed file is stale
 *   node scripts/gen-platform-conformance-tier.cjs --tests-dir <path>   # override the tests/ root (tests only)
 *   node scripts/gen-platform-conformance-tier.cjs --out <path>         # override the generated-file path (tests only)
 *
 * `--tests-dir`/`--out` (or the TESTS_DIR/OUT_PATH env vars, flag takes
 * precedence) exist solely so tests/platform-conformance-tier.test.cjs can
 * point the CLI at a small temp fixture tree instead of this repo's real,
 * 900+-file tests/ tree. Production usage (package.json's lint:generated-sync
 * / regen:derived chains) passes no flags and gets the real repo paths.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { suiteOf } = require('./lib/suite-detection.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TESTS_DIR = path.join(ROOT, 'tests');
const DEFAULT_OUT_PATH = path.join(ROOT, 'scripts', 'lib', 'platform-conformance-tier.generated.cjs');

const GENERATED_HEADER =
  '// GENERATED FILE — do not hand-edit. Run `node scripts/gen-platform-conformance-tier.cjs --write` to regenerate.\n';

/**
 * Detection categories (#4591 design doc). Each entry's `test` receives the
 * raw file content string and returns true when that category's signal is
 * present. Order matches the design doc's enumeration; `signals` in
 * `classifyContent`'s return value preserves this order.
 */
const CATEGORIES = [
  {
    name: 'process-platform',
    test: (content) => /process\.platform/.test(content),
  },
  {
    name: 'os-platform',
    test: (content) => /os\.platform\(\)/.test(content),
  },
  {
    name: 'win32-darwin-literal',
    test: (content) => /\bwin32\b/.test(content) || /\bdarwin\b/.test(content),
  },
  {
    name: 'chmod-mode-bit',
    test: (content) => /chmodSync|chmod\(/.test(content) || /0o[0-7]{3,4}\b/.test(content),
  },
  {
    name: 'windows-shell-token',
    test: (content) => /cmd\.exe|powershell|pwsh|ComSpec/i.test(content),
  },
  {
    name: 'windows-env-var',
    test: (content) => /\bPATHEXT\b|\bUSERPROFILE\b|\bHOMEDRIVE\b|\bHOMEPATH\b/.test(content),
  },
  {
    name: 'process-seam-subprocess',
    test: (content) => /\brunNode\(|\brunGit\(|\brunHook\(|\brunGsdTools\(|\bgitOrThrow\(/.test(content),
  },
  {
    name: 'raw-child-process',
    // Requires BOTH the child_process import/reference token AND one of the
    // three call names in the same file — this is what keeps a same-named
    // local identifier (e.g. a variable called `spawnResult`) from false-
    // positiving: `spawnResult` never forms the substring `spawnSync(`.
    test: (content) => {
      if (/require\((['"])(?:node:)?child_process\1\)/.test(content)) return true;
      if (!content.includes('child_process')) return false;
      return /\bspawnSync\(|\bexecSync\(|\bexecFileSync\(/.test(content);
    },
  },
  {
    name: 'symlink-keyword',
    // A leading `\b` with no trailing one, case-insensitive: this is
    // deliberately NOT `/\bsymlink\b|\bSymlink\b/` (that literal pair would
    // never match the dominant real-world call shape `symlinkSync(` /
    // `readlinkSync(` — no word boundary exists between "symlink" and the
    // immediately-following "Sync", both \w characters). The leading `\b`
    // alone still excludes a mid-word embedding like "presymlink".
    test: (content) => /\bsymlink/i.test(content),
  },
  {
    name: 'hardcoded-path-vs-path-call',
    // Intentionally coarse (design doc: over-inclusion is the safe
    // direction): a path.* call ANYWHERE in the file plus a quoted
    // forward-slash-leading string literal ANYWHERE in the file, with no
    // attempt at proximity/scoping.
    test: (content) =>
      /path\.(join|resolve|dirname|basename|normalize|relative)\(/.test(content) &&
      /['"`]\/[\w.\-/]*['"`]/.test(content),
  },
];

// Two CATEGORIES entries precise enough for TEST-file classification (this
// module's own purpose) but far too broad for SOURCE-file reachability
// (scripts/ci-test-scope.cjs's #4592 use). Empirically verified: applying
// classifyContent to every file under src/ (235 files) flags 100 of them,
// driven almost entirely by these two categories; excluding them narrows it
// to 28 files, all verified to carry a genuine platform-conditional branch.
const NOISY_FOR_SOURCE_REACHABILITY = new Set(['hardcoded-path-vs-path-call', 'symlink-keyword']);

/**
 * Pure classifier: given a test file's raw string content, returns which
 * platform-conformance categories matched and whether the file needs real-OS
 * coverage (true iff at least one category matched).
 *
 * @param {string} content
 * @returns {{needsRealOs: boolean, signals: string[]}}
 */
function classifyContent(content) {
  const text = typeof content === 'string' ? content : '';
  const signals = [];
  for (const category of CATEGORIES) {
    if (category.test(text)) signals.push(category.name);
  }
  return { needsRealOs: signals.length > 0, signals };
}

/**
 * Recursively collect every `*.test.cjs` file beneath `dir`.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function walkTestFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Classify every test file under `testsDir`, returning `{ total, files }`
 * where `files` is the SORTED array of `tests/<...>.test.cjs`-relative paths
 * (POSIX-normalized, per RULESET.CONTENT-PATH-NORMALIZATION) whose content
 * needs real-OS coverage.
 *
 * @param {string} testsDir
 * @returns {{ total: number, files: string[] }}
 */
function classifyTree(testsDir) {
  const absoluteFiles = walkTestFiles(testsDir);
  // Only unit-suite files (no suite suffix) are eligible for the conformance
  // tier — see the header doc-comment for why suite-tagged files are excluded
  // entirely rather than merely deprioritized.
  const unitFiles = absoluteFiles.filter((absPath) => suiteOf(absPath) === null);
  const flagged = [];
  for (const absPath of unitFiles) {
    const content = fs.readFileSync(absPath, 'utf8');
    const { needsRealOs } = classifyContent(content);
    if (needsRealOs) {
      const rel = path.relative(testsDir, absPath).replace(/\\/g, '/');
      flagged.push('tests/' + rel);
    }
  }
  flagged.sort();
  return { total: absoluteFiles.length, files: flagged };
}

/**
 * Render the generated `.cjs` module body — one array entry per line for a
 * readable diff, matching scripts/lib/portability-vocab.cjs's array-literal
 * style.
 *
 * @param {string[]} files - already sorted.
 * @returns {string}
 */
function renderGeneratedFile(files) {
  const lines = files.map((f) => `  ${JSON.stringify(f)},`).join('\n');
  return (
    GENERATED_HEADER +
    "'use strict';\n\n" +
    'module.exports = {\n' +
    '  CONFORMANCE_TIER_FILES: [\n' +
    (lines.length > 0 ? lines + '\n' : '') +
    '  ],\n' +
    '};\n'
  );
}

/** Resolve the effective tests-dir / out-path from argv/env, flag beats env. */
function resolveOverrides(argv) {
  let testsDir = process.env.TESTS_DIR || DEFAULT_TESTS_DIR;
  let outPath = process.env.OUT_PATH || DEFAULT_OUT_PATH;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tests-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new ExitError(1, 'gen-platform-conformance-tier: --tests-dir requires a path value');
      }
      testsDir = path.resolve(value);
      i++;
    } else if (argv[i] === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new ExitError(1, 'gen-platform-conformance-tier: --out requires a path value');
      }
      outPath = path.resolve(value);
      i++;
    }
  }

  return { testsDir: path.resolve(testsDir), outPath: path.resolve(outPath) };
}

function main() {
  const argv = process.argv.slice(2);
  const { testsDir, outPath } = resolveOverrides(argv);
  const mode = argv.includes('--check') ? 'check' : argv.includes('--write') ? 'write' : 'print';

  const { total, files } = classifyTree(testsDir);

  if (mode === 'write') {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderGeneratedFile(files));
    process.stdout.write(`Wrote ${outPath} (${files.length} conformance-tier file(s))\n`);
    return;
  }

  if (mode === 'check') {
    // Never trust a stale require cache — the committed file may have been
    // rewritten (by --write, or by hand) since this process started.
    let committed;
    try {
      const resolved = require.resolve(outPath);
      delete require.cache[resolved];
      committed = require(resolved);
    } catch (err) {
      throw new ExitError(
        1,
        `gen-platform-conformance-tier: could not load ${outPath} — run ` +
          '`node scripts/gen-platform-conformance-tier.cjs --write` first ' +
          `(${err && err.message ? err.message : err})`,
      );
    }
    const committedFiles = Array.isArray(committed.CONFORMANCE_TIER_FILES)
      ? committed.CONFORMANCE_TIER_FILES
      : [];
    const committedSet = new Set(committedFiles);
    const liveSet = new Set(files);

    const added = files.filter((f) => !committedSet.has(f));
    const removed = committedFiles.filter((f) => !liveSet.has(f));

    if (added.length > 0 || removed.length > 0) {
      process.stderr.write(
        `${path.relative(ROOT, outPath).replace(/\\/g, '/')} is stale. Run:\n` +
          '  node scripts/gen-platform-conformance-tier.cjs --write\n\n',
      );
      for (const f of added) process.stderr.write('  + ' + f + '\n');
      for (const f of removed) process.stderr.write('  - ' + f + '\n');
      throw new ExitError(1);
    }

    process.stdout.write(
      `ok gen-platform-conformance-tier: ${files.length} conformance-tier files, list matches\n`,
    );
    return;
  }

  // No flag: print a classification summary, write nothing.
  process.stdout.write(
    `gen-platform-conformance-tier: ${total} file(s) scanned, ` +
      `${files.length} need real OS, ${total - files.length} excluded (Linux-only conformance tier eligible)\n`,
  );
}

/* c8 ignore next 3 -- CLI entry guard; this repo measures coverage with c8, which does not honor istanbul pragmas */
if (require.main === module) {
  runMain(main);
}

module.exports = { classifyContent, CATEGORIES, NOISY_FOR_SOURCE_REACHABILITY, walkTestFiles, classifyTree, renderGeneratedFile };
