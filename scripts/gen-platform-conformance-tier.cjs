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
 * That stance is a correct per-file tiebreak, but proved wrong in aggregate
 * (#4641): applied to two categories that matched the house test idiom
 * rather than a genuine platform signal, it produced a Windows "tier" of
 * 547 of 931 eligible unit-suite files (58.8%, measured 2026-09-11) — most
 * of the suite. Measured per-category UNIQUE (sole-signal, i.e. the file
 * would have been excluded without it) contribution as of that same
 * measurement: `process-seam-subprocess` 118 files, `hardcoded-path-vs-
 * path-call` 108 files, every other category 41 files COMBINED. Both were
 * removed outright from CATEGORIES; the same-tree, same-day recount put
 * the tier at 255 of 931 (27.4%) — exactly 292 entries removed from the
 * committed list, none added. The macOS tier was unaffected by this change
 * (a diff of macos-conformance-tier.generated.cjs across the same removal
 * showed zero changed lines). None of these counts is asserted as a
 * literal anywhere in the test suite: the ceilings this generator enforces
 * are ratios against a live denominator (the current eligible-file count),
 * and the committed lists are pinned by comparing against a fresh
 * classification of the live tree, not against a hardcoded number —
 * deliberately, since a hardcoded count in a test is a failure scheduled
 * for the next time the suite grows. See
 * docs/adr/4641-windows-selector-consolidation.md for the full rationale.
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
 *   node scripts/gen-platform-conformance-tier.cjs --target macos ...   # same three modes, macOS-specific list (#4593)
 *   node scripts/gen-platform-conformance-tier.cjs --tests-dir <path>   # override the tests/ root (tests only)
 *   node scripts/gen-platform-conformance-tier.cjs --out <path>         # override the generated-file path (tests only)
 *
 * `--target` selects which of the two independent generated outputs this
 * invocation targets: `windows` (default, the original #4591 behavior —
 * omitting the flag is unchanged) or `macos` (#4593's narrower, macOS-
 * specific list). Both write into the SAME committed-file conventions
 * (`scripts/lib/platform-conformance-tier.generated.cjs` /
 * `scripts/lib/macos-conformance-tier.generated.cjs`), so `package.json`'s
 * `lint:generated-sync`/`regen:derived` chains invoke this script twice, once
 * per target, rather than needing a second script file.
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
const DEFAULT_MACOS_OUT_PATH = path.join(ROOT, 'scripts', 'lib', 'macos-conformance-tier.generated.cjs');

const GENERATED_HEADER =
  '// GENERATED FILE — do not hand-edit. Run `node scripts/gen-platform-conformance-tier.cjs --write` to regenerate.\n';

const MACOS_GENERATED_HEADER =
  '// GENERATED FILE — do not hand-edit. Run `node scripts/gen-platform-conformance-tier.cjs --target macos --write` to regenerate.\n' +
  '// macOS-specific conformance tier (#4593), separate from and narrower than the general/\n' +
  '// Windows-oriented tier in platform-conformance-tier.generated.cjs — see\n' +
  '// docs/adr/4593-macos-conformance-tier-architecture.md for the full rationale.\n';

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
    name: 'shell-interpreter-spawn',
    // Added after an adversarial review (#4641) caught a REAL false negative
    // introduced by removing 'process-seam-subprocess' above: that removal
    // also dropped the only coverage for tests/execute-phase-worktree-guard.
    // test.cjs, which calls tests/helpers/process-seam.cjs's `runHook(...,
    // { interpreter: 'bash', ... })`. `runHook` spawns `options.interpreter`
    // via a real `spawnSync`, so `interpreter: 'bash'` is a genuine real-shell
    // invocation — bash availability, quoting, and git output parsing all
    // differ across OSes. This is deliberately narrower than (and does not
    // reintroduce) 'process-seam-subprocess': the rationale that going
    // through the injected-`platform`-parameter seam in
    // src/shell-command-projection.cts is NOT a platform signal (because the
    // caller supplies `platform` itself) holds for THAT seam only — it does
    // not hold for `runHook`'s `interpreter` option, which spawns a real
    // interpreter binary rather than taking platform as injected data.
    // Measured 2026-09-11: 33 eligible files match this pattern; 9 of them
    // were outside the committed Windows tier and are added back by this
    // change, taking the tier from 255 to 264 of 931 eligible files (27.4% ->
    // 28.4%), still under the 33% ceiling. All 9 additions were verified by
    // reading the matching source line: 0 false positives, every match is a
    // live `interpreter:` option on a real `runHook`/`runHookSeam` call. As
    // with all counts in this file, these are dated point-in-time
    // measurements, not standing facts.
    test: (content) => /interpreter:\s*['"`](bash|sh|zsh|dash|pwsh|powershell|cmd)['"`]/.test(content),
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
];

// A CATEGORIES entry precise enough for TEST-file classification (this
// module's own purpose) but too broad for SOURCE-file reachability
// (scripts/ci-test-scope.cjs's #4592 use). This set used to hold a second
// member, 'hardcoded-path-vs-path-call', alongside 'symlink-keyword'; that
// category was removed outright from CATEGORIES (#4641 — measured to be the
// single largest driver of Windows-tier over-inclusion, a universal Node
// test-suite idiom rather than a platform signal), not merely exempted here,
// because it was over-broad for BOTH consumers (this module's own Windows
// tier AND source reachability), not source-reachability alone. Only
// 'symlink-keyword' remains: still precise enough for test-file
// classification but, per the same empirical pass described above, too noisy
// for source reachability.
const NOISY_FOR_SOURCE_REACHABILITY = new Set(['symlink-keyword']);

/**
 * Escape hatch, WINDOWS TIER ONLY (union'd into `classifyTree`, never into
 * `classifyMacosTree`/`MACOS_CATEGORIES` — those stay untouched by this map).
 *
 * `classifyContent` above is a STATIC CONTENT classifier: it can only see
 * text in the test file itself. Some files need real-OS coverage for a
 * reason that lives in the CODE UNDER TEST, not in the test's own text — no
 * regex over the test file can ever detect that, because the signal simply
 * isn't there to find. Rather than chase that gap with ever-more-specific
 * content heuristics (the exact failure mode #4641 measured and rolled
 * back — see the header comment above), this map is the single, centrally-
 * enumerated source of truth for those cases, matching ADR-1703's
 * `portability-vocab.cjs` stance and epic #4589 Phase 2's explicit
 * requirement that such overrides be "centrally-enumerated, not a naming
 * convention". It is deliberately NOT a heuristic: it is a `Map` (path ->
 * reason) precisely so every entry is forced to carry a recorded,
 * human-reviewed reason at the call site — an entry without one is
 * impossible by construction (there is no positional/array form that would
 * let a path be added without a paired reason string).
 *
 * Adding an entry requires a recorded reason and should be rare: prefer
 * fixing the classifier (a new CATEGORIES signal) when the real-OS need IS
 * expressible as content; reach for this map only when it structurally is
 * not.
 *
 * Current entries:
 * - tests/external-descriptor-confinement.test.cjs: exercises `isPathConfined`
 *   (src/external-descriptor-trust.cts:41-49), which calls the AMBIENT
 *   `path` module directly — `path.resolve(root, target)` and `path.sep` —
 *   with no platform/path injection seam. Its win32 semantics (drive
 *   letters, UNC paths, `\` separator) are therefore only reachable by
 *   actually running on Windows; the win32 branch is unreachable on Linux.
 *   This is a security-relevant write-confinement gate, so a silent gap
 *   here is a security regression, not a coverage nit (#4641).
 */
const ALWAYS_REAL_OS = new Map([
  [
    'tests/external-descriptor-confinement.test.cjs',
    'Exercises isPathConfined (src/external-descriptor-trust.cts:41-49), which uses the ambient ' +
      'path module (path.resolve/path.sep) with no platform injection; its win32 branch (drive ' +
      'letters, UNC paths, \\ separator) is unreachable on Linux. Security-relevant write-confinement gate.',
  ],
]);

/**
 * macOS-specific detection categories (#4593, design doc
 * .gsd/phase/chore-4593-macos-conformance-tier/40-design.md). Built new,
 * rather than reusing CATEGORIES above minus its Windows-specific entries,
 * because that naive exclusion barely narrows anything (measured: 546 -> 424
 * files, 78%) — most files match multiple general-tier signals simultaneously
 * and only need ONE surviving signal to stay in. `chmod-mode-bit` and
 * `symlink-keyword` ARE deliberately duplicated verbatim from CATEGORIES:
 * both are genuinely Unix-relevant (chmod bits and symlink semantics differ
 * materially on macOS), not Windows-motivated the way the rest of CATEGORIES
 * is. A standalone CRLF/`autocrlf` signal was considered and rejected: even
 * narrowed to `/\bCRLF\b|autocrlf/i` it still hit 143/930 files (15%) — CRLF
 * is primarily a Windows checkout concern in this codebase (ADR-1703's
 * `no-crlf-fragile-split` files it under DEFECT.WINDOWS-TEST-PORTABILITY),
 * so a CRLF signal pulls in Windows-relevant files already covered by the
 * general tier, not a macOS-narrowing one.
 */
const MACOS_CATEGORIES = [
  { name: 'darwin-literal', test: (content) => /\bdarwin\b/.test(content) },
  { name: 'zsh-dispatch', test: (content) => /\bzsh\b/i.test(content) },
  { name: 'case-sensitivity', test: (content) => /case.?insensitiv|case.?sensitiv/i.test(content) },
  { name: 'chmod-mode-bit', test: (content) => /chmodSync|chmod\(/.test(content) || /0o[0-7]{3,4}\b/.test(content) },
  { name: 'symlink-keyword', test: (content) => /\bsymlink/i.test(content) },
];

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
 * Pure classifier, macOS-specific signal set (#4593). Same shape as
 * classifyContent, against MACOS_CATEGORIES instead of CATEGORIES.
 *
 * @param {string} content
 * @returns {{needsRealOs: boolean, signals: string[]}}
 */
function classifyMacosContent(content) {
  const text = typeof content === 'string' ? content : '';
  const signals = [];
  for (const category of MACOS_CATEGORIES) {
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
    const rel = 'tests/' + path.relative(testsDir, absPath).replace(/\\/g, '/');
    const content = fs.readFileSync(absPath, 'utf8');
    const { needsRealOs } = classifyContent(content);
    // The ALWAYS_REAL_OS escape hatch (Windows tier only — see its doc
    // comment) is unioned in HERE, keyed off a file that this walk actually
    // found, rather than blindly appended regardless of `testsDir` — that
    // keeps the escape hatch from leaking a real-repo path into an unrelated
    // temp-fixture-tree classification (e.g. this module's own tests).
    if (needsRealOs || ALWAYS_REAL_OS.has(rel)) {
      flagged.push(rel);
    }
  }
  const result = [...new Set(flagged)].sort();
  return { total: absoluteFiles.length, files: result };
}

/**
 * Same walk/eligibility as classifyTree, classified with the macOS-specific
 * signal set (#4593).
 *
 * @param {string} testsDir
 * @returns {{ total: number, files: string[] }}
 */
function classifyMacosTree(testsDir) {
  const absoluteFiles = walkTestFiles(testsDir);
  const unitFiles = absoluteFiles.filter((absPath) => suiteOf(absPath) === null);
  const flagged = [];
  for (const absPath of unitFiles) {
    const content = fs.readFileSync(absPath, 'utf8');
    const { needsRealOs } = classifyMacosContent(content);
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

/**
 * Render scripts/lib/macos-conformance-tier.generated.cjs's module body,
 * mirroring renderGeneratedFile exactly against the macOS export name.
 *
 * @param {string[]} files - already sorted.
 * @returns {string}
 */
function renderMacosGeneratedFile(files) {
  const lines = files.map((f) => `  ${JSON.stringify(f)},`).join('\n');
  return (
    MACOS_GENERATED_HEADER +
    "'use strict';\n\n" +
    'module.exports = {\n' +
    '  MACOS_CONFORMANCE_TIER_FILES: [\n' +
    (lines.length > 0 ? lines + '\n' : '') +
    '  ],\n' +
    '};\n'
  );
}

/** Resolve the effective target/tests-dir/out-path from argv/env, flag beats env. */
function resolveOverrides(argv) {
  let target = 'windows';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      const value = argv[i + 1];
      if (value !== 'windows' && value !== 'macos') {
        throw new ExitError(1, 'gen-platform-conformance-tier: --target requires "windows" or "macos"');
      }
      target = value;
      i++;
    }
  }

  const defaultOutPath = target === 'macos' ? DEFAULT_MACOS_OUT_PATH : DEFAULT_OUT_PATH;
  let testsDir = process.env.TESTS_DIR || DEFAULT_TESTS_DIR;
  let outPath = process.env.OUT_PATH || defaultOutPath;

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

  return { target, testsDir: path.resolve(testsDir), outPath: path.resolve(outPath) };
}

function main() {
  const argv = process.argv.slice(2);
  const { target, testsDir, outPath } = resolveOverrides(argv);
  const mode = argv.includes('--check') ? 'check' : argv.includes('--write') ? 'write' : 'print';

  const isMacos = target === 'macos';
  const label = isMacos ? 'gen-platform-conformance-tier --target macos' : 'gen-platform-conformance-tier';
  const exportKey = isMacos ? 'MACOS_CONFORMANCE_TIER_FILES' : 'CONFORMANCE_TIER_FILES';
  const { total, files } = isMacos ? classifyMacosTree(testsDir) : classifyTree(testsDir);

  if (mode === 'write') {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, isMacos ? renderMacosGeneratedFile(files) : renderGeneratedFile(files));
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
        `${label}: could not load ${outPath} — run ` +
          `\`node scripts/gen-platform-conformance-tier.cjs${isMacos ? ' --target macos' : ''} --write\` first ` +
          `(${err && err.message ? err.message : err})`,
      );
    }
    const committedFiles = Array.isArray(committed[exportKey]) ? committed[exportKey] : [];
    const committedSet = new Set(committedFiles);
    const liveSet = new Set(files);

    const added = files.filter((f) => !committedSet.has(f));
    const removed = committedFiles.filter((f) => !liveSet.has(f));

    if (added.length > 0 || removed.length > 0) {
      process.stderr.write(
        `${path.relative(ROOT, outPath).replace(/\\/g, '/')} is stale. Run:\n` +
          `  node scripts/gen-platform-conformance-tier.cjs${isMacos ? ' --target macos' : ''} --write\n\n`,
      );
      for (const f of added) process.stderr.write('  + ' + f + '\n');
      for (const f of removed) process.stderr.write('  - ' + f + '\n');
      throw new ExitError(1);
    }

    process.stdout.write(`ok ${label}: ${files.length} conformance-tier files, list matches\n`);
    return;
  }

  // No flag: print a classification summary, write nothing.
  process.stdout.write(
    `${label}: ${total} file(s) scanned, ` +
      `${files.length} need real OS, ${total - files.length} excluded (Linux-only conformance tier eligible)\n`,
  );
}

/* c8 ignore next 3 -- CLI entry guard; this repo measures coverage with c8, which does not honor istanbul pragmas */
if (require.main === module) {
  runMain(main);
}

module.exports = {
  classifyContent,
  CATEGORIES,
  NOISY_FOR_SOURCE_REACHABILITY,
  ALWAYS_REAL_OS,
  walkTestFiles,
  classifyTree,
  renderGeneratedFile,
  classifyMacosContent,
  MACOS_CATEGORIES,
  classifyMacosTree,
  renderMacosGeneratedFile,
};
