#!/usr/bin/env node
'use strict';

/**
 * lint-removed-but-needed.cjs — DEFECT.REMOVED-BUT-NEEDED (CONTEXT.md).
 *
 * ## Why
 *
 * A file/key gets removed because "no longer used" without verifying every
 * consumer (workflows, docs, manifests, npm scripts, tests). #3316: root
 * `package-lock.json` was deleted while `package.json` still declares deps
 * and workflows still use `cache: 'npm'` + `npm ci` (which require a
 * lockfile). e3b52c70: docs referenced a removed `/gsd-new-workspace`
 * workflow after it was deleted. #3560: a deleted workflow was pinned by an
 * existence assertion in `tests/phase.test.cjs` — the lint passed clean and
 * the breakage surfaced only as four red tests on the remote runner,
 * because `tests/` was not scanned at all.
 *
 * ## What this checks
 *
 * For every file deleted (`git diff --name-status <base>...HEAD`, status
 * `D`), grep the post-diff tree for the deleted file's basename:
 *
 * - `.github/workflows/`, `gsd-core/`, `docs/` (excluding `docs/adr/**` and
 *   `docs/research/**` — see "Historical-record exemption" below),
 *   `package.json` — ANY surviving reference fails (the original rule).
 * - `tests/` — scanned with a discriminator (#3565): a reference that PINS
 *   existence (`fs.existsSync(path)`, `readFileSync`, `require`, or the
 *   basename as a quoted object key) fails; a reference that ASSERTS
 *   ABSENCE (`assert.ok(!content.includes('x.md'))`, `!fs.existsSync(...)`)
 *   is the correct post-deletion state and passes. The naive widening —
 *   flagging every mention — was tried in #3560 and reverted: an absence
 *   assertion must contain the basename to assert the file is gone, so
 *   without the two kinds separated the guard fires on correct code and
 *   gets disabled. A mention that is neither a pin nor an absence
 *   assertion (prose, a path assembled on another line) is not flagged —
 *   a documented known limit, chosen because a false violation reds a
 *   correct tree while a missed prose mention only loses one detection
 *   channel.
 *
 * `package-lock.json` deletions additionally fail if any workflow still
 * uses `npm ci` or `cache: 'npm'`/`cache: "npm"` — those depend on a
 * lockfile even though they never spell out its filename.
 *
 * ## False-positive risk (moderate, per audit)
 *
 * A common basename (`index.js`, `config.json`) can coincidentally match an
 * unrelated file, and this only catches LITERAL string references — not a
 * variable holding the filename or a glob that happened to match it.
 *
 * ## Basename-collision refinement (#3907)
 *
 * #3907 deleted `bin/lib/ui-safety-gate.cjs` while the SEPARATE, still-live
 * `gsd-core/bin/lib/ui-safety-gate.cjs` survives — every reference to the
 * survivor (including it referencing itself) was misattributed to the
 * deletion, 14 false violations on a correct tree. This epic is about
 * de-duplicating modules, so "delete one of two files sharing a basename"
 * recurs by construction.
 *
 * The fix is precision, not suppression: for each deleted file, if its
 * basename is ALSO the basename of a file that still exists in the
 * post-diff tree — `git ls-files` (tracked files) UNIONED with the
 * already filesystem-walked corpus/testsCorpus file lists, because
 * `git ls-files` alone misses gitignored BUILD ARTIFACTS such as
 * `gsd-core/bin/lib/*.cjs` (compiled from `.cts`, never committed) —
 * matching switches from the bare basename to the deleted file's full
 * repo-relative path. Because the deletion is already committed on this
 * branch, none of these sources can list the deleted file itself, so any
 * hit is necessarily a DIFFERENT file. A genuine
 * full-path reference to the deleted file is still caught (strictly more
 * precise, not weaker); a bare-basename reference becomes correctly
 * unattributable to the deleted file specifically and is no longer
 * blamed on it. When no surviving file shares the basename, nothing
 * changes — the original basename rule still applies exactly as before.
 *
 * Residual known limit: a bare-basename reference to a deleted file whose
 * basename survives elsewhere is now invisible to this guard (it cannot
 * tell whether the bare mention meant the deleted file or its
 * basename-twin). Same trade the docstring already makes for prose
 * mentions above — a false violation reds a correct tree; a missed
 * ambiguous mention only loses one detection channel.
 *
 * ## Gitignored-path refinement (#3677)
 *
 * #3677 deleted `.gsd/phase/.../40-design.md` and `50-test-matrix.md`, files
 * force-committed despite `.gitignore`. Tracked comments cite OTHER,
 * untracked local design docs that carry the same basenames, so the bare
 * basename was misattributed to the deletion (MEASURED: 40 false violations
 * at the pre-fix commit 31782c1fd2 against origin/next, with the built
 * gsd-core/bin/lib copied in).
 *
 * A gitignored path was never meant to be tracked, and its basename is
 * shared by untracked local files that tracked comments cite — so a
 * bare-basename mention cannot be attributed to the deleted file. For each
 * deleted path that `git check-ignore --no-index` reports as ignored,
 * matching switches from the bare basename to the full repo-relative path,
 * the same switch the #3907 collision rule makes (one shared predicate,
 * {@link matchesByFullPath}), in BOTH the live-consumer and tests/ arms. A
 * genuine full-path reference to the deleted file still fails.
 *
 * The verdict must not be steerable by the change under review or depend on
 * the machine, so:
 *
 * - Only ignore rules from TRACKED `.gitignore` files that are unchanged from
 *   the base (committed diff AND local edits) count. The source of
 *   each match (`check-ignore -v`) must be a repo-relative path whose
 *   basename is `.gitignore` AND that `git ls-files` lists; `.git/info/exclude`,
 *   a global `core.excludesFile`, an untracked `.gitignore` and negated (`!`)
 *   patterns are never honored.
 * - If the diff `<base>...HEAD` touches ANY `.gitignore` (any status), the
 *   refinement is off entirely: the post-diff tree's ignore rules are
 *   PR-controlled, and a PR that deleted `x.cjs` and ignored `x.cjs` in the
 *   same diff would otherwise disable its own basename check.
 * - Every git read of paths is NUL-delimited (`-z`), so `core.quotePath`
 *   C-quoting of non-ASCII paths cannot break the lookups.
 * - Degrade, never skip: any failure of the ignore query (non-repo, timeout,
 *   signal, exit 128, output overflow) yields an empty set — the stricter
 *   basename matching — instead of aborting the whole lint.
 *
 * ## Tracked-but-gitignored files, base resolution, echo hygiene (#3677)
 *
 * - Force-adding a file despite `.gitignore` is what created #3677, so the
 *   lint also fails when any tracked file is ignored by a tracked
 *   `.gitignore` (`git ls-files -z -ci --exclude-per-directory=.gitignore`;
 *   deliberately NOT `--exclude-standard`, which would read `.git/info/exclude`
 *   and the global excludes file). A failure of that query is a hard failure.
 * - The deleted-file check is skipped ONLY when the base ref (or its merge
 *   base) is unresolvable. Any other git failure (timeout, signal, output
 *   overflow) exits non-zero. `--no-renames` keeps a deletion paired with a
 *   near-copy a `D`, whatever `diff.renames` says. Under CI (`CI` or
 *   `GITHUB_ACTIONS` non-empty and not "false"/"0") an unresolvable base is a
 *   failure, not a skip — otherwise a shallow checkout would silently pass.
 * - Every path echoed into lint output goes through `sanitizeEcho`, since
 *   `-z` lets a path carry newlines and escape sequences.
 *
 * ## Historical-record exemption (#3942)
 *
 * `docs/adr/**` and `docs/research/**` are excluded from the `docs/` scan.
 * An ADR's or a post-mortem's entire job is to record what was retired —
 * naming the deleted file IS the point of the document, not a defect — so
 * without this exemption a PR could never write the ADR that explains its
 * own deletion in the same PR that performs it (it would have to land in a
 * follow-up, after the fact, which is backwards for a decision record).
 * The exemption is narrow and applies only to these two directories: every
 * other document under `docs/` (guides, `TESTING-SUITES.md`, generated
 * indexes, etc.) still enforces "ANY surviving reference fails" exactly as
 * before. `.github/workflows/`, `gsd-core/`, and `package.json` are
 * likewise unaffected — none of those are historical-record surfaces.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { sanitizeEcho } = require('./command-contract-helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['.github/workflows', 'gsd-core', 'docs'];
const EXTRA_FILES = ['package.json'];
const TESTS_ROOT = 'tests';
// 16 MiB: a large PR's NUL-delimited path lists must not overflow execFileSync's
// default 1 MiB buffer.
const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * The git output buffer cap. `GSD_REMOVED_BUT_NEEDED_GIT_MAX_BUFFER` (bytes)
 * is a test seam that lets a test provoke a real ENOBUFS on a RESOLVABLE base.
 * @returns {number}
 */
function gitMaxBuffer() {
  const n = Number.parseInt(process.env.GSD_REMOVED_BUT_NEEDED_GIT_MAX_BUFFER || '', 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GIT_MAX_BUFFER;
}

// Skip these when walking SCAN_ROOTS — binary/generated content that can
// never carry a meaningful basename reference, and is often large.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.zip']);

/**
 * Pure: does `content` contain a literal reference to `basename`, delimited
 * by non-identifier/non-path characters on both sides (so "foo.json" doesn't
 * match inside "old-foo.json.bak" style names but does match in a normal
 * path/prose context)?
 * @param {string} content
 * @param {string} basename
 * @returns {boolean}
 */
function referencesBasename(content, basename) {
  const re = new RegExp(`(^|[^\\w.-])${escapeRegex(basename)}($|[^\\w.-])`);
  return re.test(content);
}

/**
 * Pure: does `content` contain a literal reference to the FULL
 * repo-relative path `relPath` (used instead of {@link referencesBasename}
 * when the deleted file's basename collides with a surviving file — #3907)?
 *
 * Same delimited-match idea as `referencesBasename`, but the left boundary
 * additionally excludes `/` — a `/` immediately to the left would mean the
 * matched text is really a SUFFIX of a longer path (e.g. content contains
 * `gsd-core/bin/lib/x.cjs` and `relPath` is `bin/lib/x.cjs`: without this,
 * the survivor's own path would be mistaken for a reference to the
 * deleted file it merely shares a basename with).
 * @param {string} content
 * @param {string} relPath - repo-relative path, forward-slash separated
 * @returns {boolean}
 */
function referencesPath(content, relPath) {
  const re = new RegExp(`(^|[^\\w./-])${escapeRegex(relPath)}($|[^\\w.-])`);
  return re.test(content);
}

/**
 * Pure: given the post-diff tree's file list (repo-relative paths), build
 * the set of basenames that still exist. Used to decide, per deleted file,
 * whether basename matching would be ambiguous (#3907).
 * @param {string[]} survivingFiles - repo-relative paths of files present
 *   in the post-diff tree (must NOT include the deleted files themselves)
 * @returns {Set<string>}
 */
function buildSurvivingBasenames(survivingFiles) {
  const set = new Set();
  for (const f of survivingFiles) set.add(path.basename(f));
  return set;
}

/**
 * Pure: given the deleted file's basename, does content contain a
 * lockfile-dependent idiom (`npm ci`, `cache: 'npm'` / `cache: "npm"`)?
 * Only meaningful for package-lock.json deletions.
 * @param {string} content
 * @returns {boolean}
 */
function referencesNpmLockfileDependency(content) {
  return /\bnpm ci\b/.test(content) || /cache:\s*['"]npm['"]/.test(content);
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && !SKIP_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Pure: the ONE predicate both scanning arms use to decide whether a deleted
 * file is matched by its full repo-relative path instead of its bare basename:
 * a surviving file shares the basename (#3907) or the deleted path is
 * gitignored (#3677).
 * @param {string} deletedFile - repo-relative deleted path
 * @param {Set<string>} survivingBasenames
 * @param {Set<string>} ignoredDeletions
 * @returns {boolean}
 */
function matchesByFullPath(deletedFile, survivingBasenames, ignoredDeletions) {
  return survivingBasenames.has(path.basename(deletedFile)) || ignoredDeletions.has(deletedFile);
}

/**
 * Pure: the violation reason for a basename-or-path match (#3907, #3677).
 * @param {string} deletedFile
 * @param {string} basename
 * @param {boolean} collides - a surviving file shares the basename (#3907)
 * @param {boolean} fullPathOnly - matching was by full path (collision or gitignored)
 * @returns {string}
 */
function fullPathReason(deletedFile, basename, collides, fullPathOnly) {
  // Paths come from NUL-delimited git output and may hold control characters;
  // this text is echoed into lint output that AI agents read as trusted.
  const file = sanitizeEcho(deletedFile);
  const base = sanitizeEcho(basename);
  if (collides) {
    return `full path '${file}' still referenced (basename '${base}' also belongs to a surviving file, so matched by path — #3907)`;
  }
  if (fullPathOnly) {
    return `full path '${file}' still referenced (the deleted path is gitignored, so matched by path — other untracked files share basename '${base}' — #3677)`;
  }
  return `basename '${base}' still referenced`;
}

/**
 * Pure: given a list of deleted basenames and a `{ file, content }[]` corpus
 * of the post-diff tree, find every surviving reference.
 * @param {string[]} deletedFiles - repo-relative deleted paths
 * @param {{ file: string, content: string }[]} corpus
 * @param {Set<string>} [survivingBasenames] - basenames still present in the
 *   post-diff tree (#3907); when a deleted file's basename is in this set,
 *   matching switches from basename to the deleted file's full path
 * @param {Set<string>} [ignoredDeletions] - deleted paths that are gitignored
 *   (#3677); matched by full path, same switch as a basename collision
 * @returns {{ deletedFile: string, referencedIn: string, reason: string }[]}
 */
function findSurvivingReferences(deletedFiles, corpus, survivingBasenames = new Set(), ignoredDeletions = new Set()) {
  const violations = [];
  for (const deletedFile of deletedFiles) {
    const basename = path.basename(deletedFile);
    const collides = survivingBasenames.has(basename);
    const fullPathOnly = matchesByFullPath(deletedFile, survivingBasenames, ignoredDeletions);
    for (const { file, content } of corpus) {
      const matched = fullPathOnly ? referencesPath(content, deletedFile) : referencesBasename(content, basename);
      if (matched) {
        violations.push({
          deletedFile,
          referencedIn: file,
          reason: fullPathReason(deletedFile, basename, collides, fullPathOnly),
        });
      }
    }
    if (basename === 'package-lock.json') {
      for (const { file, content } of corpus) {
        if (file.startsWith('.github/workflows') && referencesNpmLockfileDependency(content)) {
          violations.push({
            deletedFile,
            referencedIn: file,
            reason: '`npm ci` / `cache: \'npm\'` still present — both require a lockfile',
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Pure: classify ONE line of a test file that references `basename`.
 * Returns 'asserts-absence' | 'pins-existence' | null.
 *
 * - asserts-absence: a NEGATED check carrying the basename —
 *   `assert.ok(!content.includes('x.md'))`, `!fs.existsSync(p)`,
 *   `!/x\.md/.test(s)`. The basename must appear for the assertion to
 *   work, so this is the CORRECT post-deletion state (#3560's reverted
 *   naive widening fired exactly here).
 * - pins-existence: a direct dependency on the file existing —
 *   `fs.existsSync/readFileSync/statSync/readdirSync/require(...)` on the
 *   same line, or the basename as a quoted object key (`'x.md': ...`,
 *   the allowlist trap — a key means the test resolves against the file).
 * - null: neither (prose mention, path assembled on another line). Not a
 *   violation — see the header's known-limit note.
 *
 * @param {string} line
 * @param {string} basename
 * @param {string} [matchTarget] - text to look for as a quoted object key
 *   (#3907: the deleted file's full path when its basename collides with a
 *   surviving file; defaults to `basename`, the original behaviour)
 * @returns {'asserts-absence'|'pins-existence'|null}
 */
function classifyTestReference(line, basename, matchTarget = basename) {
  const negatedCheck =
    /!\s*[A-Za-z_$][\w.$]*\.(includes|indexOf|search|startsWith|endsWith|match)\s*\(/.test(line) ||
    /!\s*(fs\.)?(existsSync|statSync)\s*\(/.test(line) ||
    // [^/\n]* (not .*) so an adversarial line cannot backtrack the regex
    /!\s*\/[^/\n]*\/\s*\.(test|match)\s*\(/.test(line);
  if (negatedCheck) return 'asserts-absence';
  const pinsByCall =
    /\b(existsSync|readFileSync|statSync|readdirSync|require|accessSync)\s*\(/.test(line) ||
    /\brequire\s*\(?['"]/.test(line);
  if (pinsByCall) return 'pins-existence';
  // Template literal needs \\s so the RegExp constructor receives \s — a
  // bare \s in a template literal collapses to 's' and silently matches a
  // literal 's' instead of whitespace.
  if (new RegExp(`['"\`]${escapeRegex(matchTarget)}['"\`]\\s*:`).test(line)) return 'pins-existence';
  return null;
}

/**
 * Pure: for every deleted basename, scan the tests corpus line by line and
 * report each `pins-existence` reference as a violation. `asserts-absence`
 * references are explicitly NOT violations; unclassifiable mentions are
 * skipped (known limit). Violations are per-reference — one test file
 * carrying both an absence assertion and an existence pin reports the pin.
 *
 * @param {string[]} deletedFiles - repo-relative deleted paths
 * @param {{ file: string, content: string }[]} testsCorpus
 * @param {Set<string>} [survivingBasenames] - basenames still present in the
 *   post-diff tree (#3907); when a deleted file's basename is in this set,
 *   matching switches from basename to the deleted file's full path, same
 *   refinement as {@link findSurvivingReferences} so the two scanners
 *   cannot disagree about what "a reference" means
 * @param {Set<string>} [ignoredDeletions] - deleted paths that are gitignored
 *   (#3677); same full-path switch, same predicate as findSurvivingReferences
 * @returns {{ deletedFile: string, referencedIn: string, reason: string }[]}
 */
function findSurvivingTestReferences(deletedFiles, testsCorpus, survivingBasenames = new Set(), ignoredDeletions = new Set()) {
  const violations = [];
  for (const deletedFile of deletedFiles) {
    const basename = path.basename(deletedFile);
    const fullPathOnly = matchesByFullPath(deletedFile, survivingBasenames, ignoredDeletions);
    const matchTarget = fullPathOnly ? deletedFile : basename;
    // The left-boundary class matches referencesPath's when fullPathOnly
    // (excludes '/' so a survivor's own longer path isn't mistaken for a
    // reference to the deleted file it merely shares a basename with).
    const refRe = fullPathOnly
      ? new RegExp(`(^|[^\\w./-])${escapeRegex(matchTarget)}($|[^\\w.-])`)
      : new RegExp(`(^|[^\\w.-])${escapeRegex(matchTarget)}($|[^\\w.-])`);
    for (const { file, content } of testsCorpus) {
      for (const line of content.split(/\r?\n/)) {
        if (!refRe.test(line)) continue;
        const kind = classifyTestReference(line, basename, matchTarget);
        if (kind === 'pins-existence') {
          violations.push({
            deletedFile,
            referencedIn: file,
            // control-char-stripped + capped: this text is echoed into lint
            // output that AI agents read as trusted instructions
            reason: fullPathOnly
              ? `pins-existence: test depends on deleted path '${sanitizeEcho(matchTarget)}' — ${sanitizeEcho(line.trim())}`
              : `pins-existence: test depends on deleted basename '${sanitizeEcho(basename)}' — ${sanitizeEcho(line.trim())}`,
          });
        }
        // 'asserts-absence' is correct post-deletion state; null is a
        // documented known limit — neither is a violation.
      }
    }
  }
  return violations;
}

function getDeletedFiles(root, baseRef, entries = null) {
  // A git failure propagates as a plain Error. main() has already skipped an
  // UNRESOLVABLE base (isBaseResolvable), so anything thrown here — timeout,
  // signal, output overflow — is a hard failure, never a silent pass.
  return (entries || getDiffEntries(root, baseRef))
    .filter((entry) => entry.status === 'D')
    .map((entry) => entry.paths[0]);
}

/**
 * NUL-delimited `git diff --name-status` of `<baseRef>...HEAD`. `-z` keeps
 * non-ASCII paths verbatim (no `core.quotePath` C-quoting).
 * @param {string} root
 * @param {string} baseRef
 * @param {boolean} [quiet] - discard git's stderr (callers that degrade silently)
 * @returns {string}
 */
function gitDiffNameStatus(root, baseRef, quiet = false) {
  return cp.execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', `${baseRef}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: gitMaxBuffer(),
    ...(quiet ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
  });
}

/**
 * The parsed `git diff --name-status -z <baseRef>...HEAD`, run once per scan
 * and shared by getDeletedFiles and getIgnoredDeletions.
 * @param {string} root
 * @param {string} baseRef
 * @param {boolean} [quiet]
 * @returns {{ status: string, paths: string[] }[]}
 */
function getDiffEntries(root, baseRef, quiet = false) {
  return parseNameStatusZ(gitDiffNameStatus(root, baseRef, quiet));
}

/**
 * Pure: parse `git diff --name-status -z` output. Records are
 * `STATUS NUL path NUL`, except rename/copy (`R<score>`/`C<score>`) which
 * carry TWO paths (`STATUS NUL old NUL new NUL`).
 * @param {string} out
 * @returns {{ status: string, paths: string[] }[]}
 */
function parseNameStatusZ(out) {
  const tokens = out.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i += 1;
      continue;
    }
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    entries.push({ status, paths: tokens.slice(i + 1, i + 1 + pathCount) });
    i += 1 + pathCount;
  }
  return entries;
}

/**
 * Pure: does `source` (the ignore-rule file `git check-ignore -v` reported)
 * look like a repo-relative `.gitignore` path? Rejects `.git/info/exclude`,
 * absolute paths (a global `core.excludesFile`) and any other basename.
 * @param {string} source
 * @returns {boolean}
 */
function isRepoRelativeGitignore(source) {
  if (!source || path.isAbsolute(source) || source.startsWith('/')) return false;
  return source.split('/').pop() === '.gitignore';
}

/**
 * Pure: parse `git check-ignore -v -z` output — records of four
 * NUL-terminated fields `source linenum pattern pathname` — into the matches
 * whose rule is a non-negated pattern from a repo-relative `.gitignore`.
 * @param {string} out
 * @returns {{ source: string, pathname: string }[]}
 */
function parseCheckIgnoreZ(out) {
  const fields = out.split('\0');
  const matches = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [source, , pattern, pathname] = fields.slice(i, i + 4);
    if (!isRepoRelativeGitignore(source) || pattern.startsWith('!')) continue;
    matches.push({ source, pathname });
  }
  return matches;
}

/**
 * Tracked `.gitignore` files with local (staged or unstaged) edits relative to
 * HEAD. Throws if git fails.
 * @param {string} root
 * @returns {string[]} repo-relative paths
 */
function getDirtyGitignores(root) {
  return cp.execFileSync(
    'git',
    ['diff', '--name-only', '-z', 'HEAD', '--', ':(glob)**/.gitignore'],
    { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: gitMaxBuffer(), stdio: ['ignore', 'pipe', 'ignore'] },
  ).split('\0').filter(Boolean);
}

/**
 * Pure: may `rel` (a repo-relative, forward-slash path) be materialized under
 * a sandbox directory? Rejects empty / `.` / `..` segments, backslashes and
 * colons (Windows separators, drive letters, ADS), and any `.git` segment
 * (case-insensitive).
 * @param {string} rel
 * @returns {boolean}
 */
function isSafeRepoPath(rel) {
  if (!rel) return false;
  return rel.split('/').every((seg) => {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes(':')) return false;
    // Windows/NTFS aliases of `.git`: trailing dots/spaces are dropped, and
    // `GIT~1` is its 8.3 short name.
    const folded = seg.replace(/[. ]+$/, '').toLowerCase();
    return folded !== '' && folded !== '.git' && !/^git~\d+$/.test(folded);
  });
}

/**
 * The environment for git commands run in the scratch repo: the parent's with
 * every variable that could redirect git to another repository, index,
 * object store or config removed.
 * @returns {NodeJS.ProcessEnv}
 */
function isolatedGitEnv(scratchDir = null) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|TEMPLATE_DIR|EXEC_PATH|ATTR_.*|CONFIG.*)$/.test(key)) {
      delete env[key];
    }
  }
  // No system or global git config at all (and no per-user config home).
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  if (scratchDir) {
    env.HOME = scratchDir;
    env.XDG_CONFIG_HOME = scratchDir;
  }
  return env;
}

/**
 * `git init` of the scratch repo at `dir/.git` with NO template (`--template=`
 * empty), so neither `init.templateDir` nor `GIT_TEMPLATE_DIR` can seed hooks
 * or an `info/exclude`. Exported as a seam so a test can prove the flag.
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} [env] - defaults to {@link isolatedGitEnv}()
 * @returns {string} the git dir
 */
function initScratchRepo(dir, env = isolatedGitEnv(dir)) {
  const gitDir = path.join(dir, '.git');
  cp.execFileSync('git', ['--git-dir', gitDir, '--work-tree', dir, 'init', '-q', '--template='], {
    cwd: dir,
    env,
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return gitDir;
}

/**
 * Which of `paths` are ignored by the TRACKED `.gitignore` files alone, at
 * their HEAD versions. `check-ignore -v` reports only the highest-precedence
 * rule, so evaluating in the working tree lets an untracked or locally edited
 * nested `.gitignore` mask a tracked rule. Instead every `.gitignore` at HEAD
 * is materialized into a fresh empty repo (no `info/exclude`, global excludes
 * disabled) and `git check-ignore --no-index` runs there; the paths need not
 * exist. The temp dir is always removed. Throws if git fails.
 * @param {string} root
 * @param {string[]} paths - repo-relative, forward-slash separated
 * @returns {Set<string>} the subset ignored by a non-negated tracked rule
 */
function ignoredByTrackedRules(root, paths) {
  if (paths.length === 0) return new Set();
  // `ls-tree -r -z HEAD` records: `<mode> <type> <oid>\t<path>`. Only regular
  // blobs count — a symlinked .gitignore is not read by git >= 2.32.
  const gitignores = [];
  for (const record of cp.execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: gitMaxBuffer(),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type] = record.slice(0, tab).split(' ');
    const rel = record.slice(tab + 1);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    if (rel.split('/').pop() !== '.gitignore') continue;
    if (!isSafeRepoPath(rel)) throw new Error(`unsafe tracked .gitignore path ${sanitizeEcho(rel)}`);
    gitignores.push(rel);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-rbn-ignore-'));
  const gitDir = path.join(tmp, '.git');
  const isolated = { env: isolatedGitEnv(tmp), cwd: tmp };
  try {
    initScratchRepo(tmp, isolated.env);
    const tmpPrefix = path.resolve(tmp) + path.sep;
    for (const rel of gitignores) {
      const dest = path.resolve(tmp, ...rel.split('/'));
      if (!dest.startsWith(tmpPrefix)) throw new Error(`tracked .gitignore path escapes the sandbox: ${sanitizeEcho(rel)}`);
      const blob = cp.execFileSync('git', ['show', `HEAD:${rel}`], {
        cwd: root,
        timeout: 15000,
        maxBuffer: gitMaxBuffer(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, blob);
    }
    let out;
    try {
      out = cp.execFileSync(
        'git',
        ['--git-dir', gitDir, '--work-tree', tmp, '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '-v', '-z', '--stdin'],
        {
          ...isolated,
          encoding: 'utf8',
          // `check-ignore` rejects literal-pathspec mode, so a leading "./"
          // is what keeps a name like `:(top)x` from being read as pathspec
          // magic; it is stripped from the reported names below.
          input: paths.map((f) => `./${f}\0`).join(''),
          timeout: 15000,
          maxBuffer: gitMaxBuffer(),
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
    } catch (e) {
      if (e && e.status === 1) return new Set(); // none ignored
      throw e;
    }
    return new Set(parseCheckIgnoreZ(out).map((m) => (m.pathname.startsWith('./') ? m.pathname.slice(2) : m.pathname)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Which of the deleted paths are gitignored (#3677). Only base-controlled
 * rules count (see the header's "Gitignored-path refinement"):
 *
 * - if the diff `<baseRef>...HEAD` touches any `.gitignore`, nothing is
 *   refined (the post-diff ignore rules are PR-controlled);
 * - the rules are the tracked `.gitignore` files at HEAD only, evaluated in an
 *   isolated temp repo ({@link ignoredByTrackedRules}) so untracked files,
 *   `.git/info/exclude`, global excludes and negated patterns cannot matter;
 * - `-z` throughout, so non-ASCII paths are not C-quoted.
 *
 * Degrades, never throws: exit 1 ("none ignored") and every other failure
 * (non-repo, timeout, signal, 128, buffer overflow) yield an empty Set, which
 * leaves the stricter bare-basename matching in force.
 * @param {string} root
 * @param {string[]} deletedFiles - repo-relative deleted paths
 * @param {string} baseRef - the ref the diff is taken against
 * @returns {Set<string>} the subset that is gitignored, forward-slash separated
 */
function getIgnoredDeletions(root, deletedFiles, baseRef, entries = null) {
  if (deletedFiles.length === 0) return new Set();
  try {
    const diffEntries = entries || getDiffEntries(root, baseRef, true);
    const touchesGitignore = diffEntries
      .some((entry) => entry.paths.some((p) => p.split('/').pop() === '.gitignore'));
    if (touchesGitignore) return new Set();
    // A local (staged or unstaged) edit to a tracked .gitignore is just as
    // un-base-controlled as a committed one.
    if (getDirtyGitignores(root).length > 0) return new Set();
    return ignoredByTrackedRules(root, deletedFiles);
  } catch {
    // Any failure: no refinement.
    return new Set();
  }
}

/**
 * All tracked files at the current tree state (the post-diff tree, since
 * this scan runs against a branch where the deletion is already committed —
 * `git ls-files` therefore CANNOT list a deleted file, so any hit for a
 * deleted file's basename is necessarily a different, surviving file).
 * Used to build `survivingBasenames` for the #3907 collision refinement.
 * @param {string} root
 * @returns {string[]} repo-relative paths, forward-slash separated
 */
function getSurvivingFiles(root) {
  const out = cp.execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: gitMaxBuffer(),
  });
  return out.split('\0').filter(Boolean);
}

// #3942: docs/adr/** and docs/research/** are historical records — an ADR's
// or a post-mortem's whole job is to narrate what was retired, so naming a
// file this same PR deletes is the point, not DEFECT.REMOVED-BUT-NEEDED.
// Narrow and explicit: only these two `docs/` subtrees are exempt; every
// other document under `docs/` still enforces the original rule unchanged.
const DOCS_HISTORICAL_RECORD_PREFIXES = ['docs/adr/', 'docs/research/'];

/**
 * Pure: is `relFile` (repo-relative, forward-slash separated) inside one of
 * the exempt historical-record directories (#3942)?
 * @param {string} relFile
 * @returns {boolean}
 */
function isDocsHistoricalRecord(relFile) {
  return DOCS_HISTORICAL_RECORD_PREFIXES.some((prefix) => relFile.startsWith(prefix));
}

function buildCorpus(root) {
  const corpus = [];
  for (const rel of SCAN_ROOTS) {
    for (const abs of walk(path.join(root, rel))) {
      const relFile = path.relative(root, abs).replace(/\\/g, '/');
      if (rel === 'docs' && isDocsHistoricalRecord(relFile)) continue;
      try {
        corpus.push({ file: relFile, content: fs.readFileSync(abs, 'utf8') });
      } catch {
        // unreadable (broken symlink, binary that slipped past SKIP_EXT) — skip
      }
    }
  }
  for (const rel of EXTRA_FILES) {
    const abs = path.join(root, rel);
    try {
      corpus.push({ file: rel, content: fs.readFileSync(abs, 'utf8') });
    } catch {
      // optional file absent — skip
    }
  }
  return corpus;
}

function scan(root, baseRef, trackedFiles = null) {
  // One `git diff --name-status -z` per scan, shared by both consumers.
  const diffEntries = getDiffEntries(root, baseRef);
  const deletedFiles = getDeletedFiles(root, baseRef, diffEntries);
  if (deletedFiles.length === 0) return [];
  const corpus = buildCorpus(root);
  // tests/ arm (#3565): same deletions, discriminated references. A bare
  // mention that pins nothing is skipped; an absence assertion is the
  // correct post-deletion state; only a pin on a deleted file fails.
  const testsCorpus = [];
  for (const abs of walk(path.join(root, TESTS_ROOT))) {
    try {
      testsCorpus.push({
        file: path.relative(root, abs).replace(/\\/g, '/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    } catch {
      // unreadable (broken symlink, binary that slipped past SKIP_EXT) — skip
    }
  }
  // #3907: per-deletion basename-collision detection — if a surviving file
  // shares the basename, matching switches from basename to full path (see
  // the header's "Basename-collision refinement" section) for BOTH arms.
  // `git ls-files` alone misses gitignored BUILD ARTIFACTS (e.g.
  // gsd-core/bin/lib/*.cjs, compiled from .cts and never committed) —
  // exactly the #3907 collision partner — so it is unioned with the
  // already filesystem-walked corpus/testsCorpus file lists, which do see
  // them.
  const survivingBasenames = buildSurvivingBasenames([
    ...(trackedFiles || getSurvivingFiles(root)),
    ...corpus.map((c) => c.file),
    ...testsCorpus.map((t) => t.file),
  ]);
  // #3677: a gitignored deleted path is matched by full path too.
  const ignoredDeletions = getIgnoredDeletions(root, deletedFiles, baseRef, diffEntries);
  const violations = findSurvivingReferences(deletedFiles, corpus, survivingBasenames, ignoredDeletions);
  violations.push(...findSurvivingTestReferences(deletedFiles, testsCorpus, survivingBasenames, ignoredDeletions));
  return violations;
}

/**
 * Tracked files that a tracked `.gitignore` ignores — force-added despite the
 * ignore rule (#3677). `--exclude-per-directory=.gitignore` reads ONLY the
 * per-directory `.gitignore` files; `--exclude-standard` would also read
 * `.git/info/exclude` and the global excludes file, a machine-dependent verdict.
 * A failure of the query throws (a hard failure, never a silent pass).
 * @param {string} root
 * @returns {string[]} repo-relative paths
 */
function getTrackedIgnoredFiles(root, trackedFiles = null) {
  // Every tracked file is judged against the tracked .gitignore files at HEAD
  // only (see ignoredByTrackedRules), so local/untracked rules cannot mask or
  // add a finding.
  const ignored = ignoredByTrackedRules(root, trackedFiles || getSurvivingFiles(root));
  return [...ignored];
}

/**
 * Can `baseRef` be diffed against HEAD here? Unresolvable (no such ref, or no
 * merge base — e.g. a shallow clone) is the ONLY condition the lint skips on;
 * a timeout/signal/spawn error is thrown so it can never read as a pass.
 * @param {string} root
 * @param {string} baseRef
 * @returns {boolean}
 */
function isBaseResolvable(root, baseRef) {
  const run = (args) => cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  const verify = run(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (verify.error || verify.signal) throw verify.error || new Error(`git rev-parse killed by ${verify.signal}`);
  if (verify.status !== 0) return false;
  const mergeBase = run(['merge-base', baseRef, 'HEAD']);
  if (mergeBase.error || mergeBase.signal) throw mergeBase.error || new Error(`git merge-base killed by ${mergeBase.signal}`);
  return mergeBase.status === 0;
}

/**
 * Is this a CI run? `CI` or `GITHUB_ACTIONS` set to a non-empty value other
 * than "false"/"0".
 * @returns {boolean}
 */
function isCiEnvironment() {
  return ['CI', 'GITHUB_ACTIONS'].some((k) => {
    const v = (process.env[k] || '').trim().toLowerCase();
    return v !== '' && v !== 'false' && v !== '0';
  });
}

const NAME_DENY_RE = /[;|&$`'"<>(){}!\s]/;
const MERGE_QUEUE_REF_RE = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-[0-9a-f]+$/;

/**
 * The branch to diff against (without the `origin/` prefix), in order:
 * `GSD_REMOVED_BUT_NEEDED_BASE`; `GITHUB_BASE_REF` (pull_request); for a
 * `merge_group` event (GITHUB_BASE_REF is empty there) the base encoded in
 * `GITHUB_REF` = `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`, validated
 * against a safe branch-name pattern; otherwise the default `next` (this is
 * also what a `push` or local run gets).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveBaseBranch(env) {
  for (const key of ['GSD_REMOVED_BUT_NEEDED_BASE', 'GITHUB_BASE_REF']) {
    const value = env[key];
    if (!value) continue;
    // An explicit base that is not a safe branch name is a hard failure, never
    // a silent fallback to a different base.
    if (!isSafeBranchName(value)) {
      throw new ExitError(1, `lint-removed-but-needed: invalid base branch in ${key}: '${sanitizeEcho(value)}'`);
    }
    return value;
  }
  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    const m = MERGE_QUEUE_REF_RE.exec(env.GITHUB_REF || '');
    if (m && isSafeBranchName(m[1])) return m[1];
  }
  return 'next';
}

/**
 * Pure: is `name` a safe branch name for `origin/<name>` — safe-character
 * pattern, no `..` anywhere, no empty segment (leading/trailing/double `/`).
 * @param {string} name
 * @returns {boolean}
 */
function isSafeBranchName(name) {
  // A leading '-' would read as an option; shell metacharacters are refused
  // as defence in depth even though git is always spawned without a shell.
  // A bare `@` is valid ref syntax but is git's alias for HEAD.
  if (!name || name === '@' || name.startsWith('-') || NAME_DENY_RE.test(name)) return false;
  // git's own rule (control characters, spaces, `..`, `//`, trailing `/` or
  // `.lock`, `@{`, `~^:?*[\`, ...); legal names like release+hotfix pass.
  // Syntax-only form (`refs/heads/<name>`, no --branch): `--branch` would
  // expand `@` / `@{-N}` against whatever repo the cwd is in.
  const r = cp.spawnSync('git', ['check-ref-format', `refs/heads/${name}`], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.signal) throw r.error || new Error(`git check-ref-format killed by ${r.signal}`);
  return r.status === 0;
}

function main() {
  const baseRef = `origin/${resolveBaseBranch(process.env)}`;
  const failures = [];
  let trackedIgnored;
  let violations = [];
  let skipped = false;
  try {
    const trackedFiles = getSurvivingFiles(ROOT); // one `git ls-files`, two consumers
    trackedIgnored = getTrackedIgnoredFiles(ROOT, trackedFiles);
    if (isBaseResolvable(ROOT, baseRef)) violations = scan(ROOT, baseRef, trackedFiles);
    else skipped = true;
  } catch (e) {
    // A git failure on a resolvable base is NOT "base unreachable": exiting 0
    // here would let a timeout or output overflow pass the whole lint.
    throw new ExitError(
      1,
      `lint-removed-but-needed: git failed, so the check could not run (${sanitizeEcho(e.message)})`,
    );
  }
  if (skipped && isCiEnvironment()) {
    // In CI a silent skip is a silent pass: the gate would never run on a
    // shallow checkout. Fail loudly so the workflow fetches the base.
    throw new ExitError(
      1,
      `lint-removed-but-needed: could not resolve ${sanitizeEcho(baseRef)} in CI, so the deleted-file check cannot run `
        + '(fetch the base ref, e.g. a checkout with fetch-depth 0 or an explicit `git fetch origin <base>`)',
    );
  }
  if (skipped) {
    // origin/<base> unreachable on a local machine (e.g. a shallow clone with
    // no matching remote-tracking ref) — skip the deleted-file check rather
    // than fail it, matching lint-fix-has-regression-tests.cjs.
    console.log(`lint-removed-but-needed: could not resolve ${sanitizeEcho(baseRef)}, skipping the deleted-file check`);
  }
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  ${sanitizeEcho(v.deletedFile)} deleted, but still referenced in ${sanitizeEcho(v.referencedIn)}: ${v.reason}`)
      .join('\n');
    failures.push(
      'lint-removed-but-needed: a deleted file is still referenced by a live consumer\n'
        + '(DEFECT.REMOVED-BUT-NEEDED). Either restore the file or update every consumer in the\n'
        + 'same commit — do not paper over with a workaround that loses reproducibility:\n'
        + detail,
    );
  }
  if (trackedIgnored.length > 0) {
    failures.push(
      'lint-removed-but-needed: tracked file(s) are gitignored by a tracked .gitignore (#3677) —\n'
        + 'force-added despite the ignore rule. `git rm --cached` them (or drop the ignore rule):\n'
        + trackedIgnored.map((f) => `  ${sanitizeEcho(f)} is tracked but gitignored`).join('\n'),
    );
  }
  if (failures.length > 0) throw new ExitError(1, failures.join('\n'));
  if (!skipped) console.log('ok lint-removed-but-needed: no deleted file has a surviving reference');
}

module.exports = {
  referencesBasename,
  referencesPath,
  buildSurvivingBasenames,
  referencesNpmLockfileDependency,
  findSurvivingReferences,
  classifyTestReference,
  findSurvivingTestReferences,
  getDeletedFiles,
  getSurvivingFiles,
  getIgnoredDeletions,
  matchesByFullPath,
  getTrackedIgnoredFiles,
  ignoredByTrackedRules,
  isolatedGitEnv,
  initScratchRepo,
  isSafeRepoPath,
  resolveBaseBranch,
  isBaseResolvable,
  parseNameStatusZ,
  parseCheckIgnoreZ,
  isRepoRelativeGitignore,
  buildCorpus,
  isDocsHistoricalRecord,
  scan,
  SCAN_ROOTS,
  EXTRA_FILES,
  TESTS_ROOT,
  DOCS_HISTORICAL_RECORD_PREFIXES,
};

if (require.main === module) runMain(main);
