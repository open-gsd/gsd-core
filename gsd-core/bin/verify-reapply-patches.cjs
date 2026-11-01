#!/usr/bin/env node
'use strict';

/**
 * Deterministic verifier for the /gsd-reapply-patches Step 5 "Hunk Verification
 * Gate". For each backed-up patch file, asserts that the user's added lines
 * (computed from a real diff against the pristine baseline, not from the
 * LLM's prose summary) survive into the merged output.
 *
 * Usage:
 *   node scripts/verify-reapply-patches.cjs \
 *     --patches-dir <path>        \  # gsd-local-patches/
 *     --config-dir <path>         \  # ~/.claude (or runtime equivalent)
 *     [--pristine-dir <path>]        # gsd-pristine/; if absent, falls back to
 *                                    # treating every significant backup line as
 *                                    # required (over-broad but safe for #2969:
 *                                    # false-positive halts beat silent successes
 *                                    # on lost content)
 *     [--json]                       # emit JSON report instead of human text
 *     [--classify]                   # pre-merge mode: classify each backed-up
 *                                    # file as incorporated / needs_merge /
 *                                    # unknown (#4136); always exits 0
 *     [--min-baseline-coverage <0..1>]  # OPT-IN strict gate (#4135): exit 3
 *                                    # when the fraction of files verified
 *                                    # against a resolved pristine baseline
 *                                    # (baseline_covered / checked) falls below
 *                                    # the threshold. Default: off — a
 *                                    # low-coverage run stays green per the
 *                                    # documented #934 advisory posture, but
 *                                    # its coverage is ALWAYS headline-reported.
 *
 *     [--hunks]                      # pre-merge mode (#4435): per-hunk stock vs
 *                                    # user text, content hash, recommendation
 *                                    # and exception reasons; always exits 0
 *     [--decisions <path>]           # gate mode only (#4435): JSON file of human
 *                                    # keep/retire/rewrite decisions bound to
 *                                    # hunk content hashes; retire/rewrite drop
 *                                    # that hunk's required lines from the gate
 *
 * Exit codes (default gate mode):
 *   0 — every user-added line is present in the merged file (gate passes)
 *   1 — at least one missing line in at least one file (gate fails); outranks
 *       a coverage-gate failure when both apply
 *   2 — usage / structural error (e.g. patches dir missing)
 *   3 — opt-in coverage gate failed (--min-baseline-coverage not met; #4135)
 *
 * Bug #2969: the Step 5 gate previously trusted Claude's free-text "verified:
 * yes/no" reporting per hunk. The LLM was filling in `yes` even when content
 * had been silently dropped. Moving the check to a deterministic script is the
 * durability fix.
 *
 * Bug #4136 adds --classify (pre-merge mode, always exit 0 — informational;
 * the binding gate remains the post-merge default run): per backed-up file,
 * decides whether the user's modification was already adopted upstream
 * ("Incorporated", reapply-patches.md Step 4 item 6). The classification is
 * ONLY produced from a hash-validated pristine baseline with every
 * significant user-added line present verbatim in the freshly installed
 * version — a false Incorporated silently retires a live customization,
 * which is worse than no Incorporated at all.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
// #4145: shared hash-first recovery for baselines stored at an unexpected
// path under gsd-pristine/ (e.g. without the gsd-core/ prefix an earlier
// release's writer dropped). Same module the installer's preserve-check uses,
// so the two readers cannot drift apart again.
const { findPristineByHash, findPristineInGit } = require('./lib/pristine-baseline.cjs');
// #4435: line matcher (Myers, edit-distance capped) used to split a backup into
// per-hunk user/stock regions and to locate upstream changes over the baseline.
const { matchLines } = require('./lib/markdown-line-diff.cjs');

const SIGNIFICANT_MIN_CHARS = 12;
const GSD_HOOK_VERSION_LINE_RE = /^(?:\/\/|#)\s*gsd-hook-version:\s*\S+\s*$/i;

function parseArgs(argv) {
  const opts = { patchesDir: null, configDir: null, pristineDir: null, json: false, classify: false, minBaselineCoverage: null, hunks: false, decisionsPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--patches-dir') opts.patchesDir = argv[++i];
    else if (arg === '--config-dir') opts.configDir = argv[++i];
    else if (arg === '--pristine-dir') opts.pristineDir = argv[++i];
    else if (arg === '--json') opts.json = true;
    else if (arg === '--classify') opts.classify = true;
    else if (arg === '--hunks') opts.hunks = true;
    else if (arg === '--decisions') {
      const raw = argv[++i];
      if (raw === undefined) throw new ExitError(2, '--decisions requires a path');
      opts.decisionsPath = raw;
    } else if (arg === '--min-baseline-coverage') {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new ExitError(2, '--min-baseline-coverage requires a value between 0 and 1');
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new ExitError(2, `--min-baseline-coverage must be a number between 0 and 1, got: ${raw}`);
      }
      opts.minBaselineCoverage = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: verify-reapply-patches.cjs --patches-dir <path> --config-dir <path> [--pristine-dir <path>] [--json] [--classify] [--hunks] [--decisions <path>] [--min-baseline-coverage <0..1>]\n',
      );
      throw new ExitError(0);
    } else {
      throw new ExitError(2, `unknown argument: ${arg}`);
    }
  }
  return opts;
}

function isSignificantLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < SIGNIFICANT_MIN_CHARS) return false;
  // Pure punctuation / closing brackets carry too little structural info to
  // reliably distinguish a survived hunk from incidental similarity.
  if (/^[\s})\];,]+$/.test(trimmed)) return false;
  // Generic decorative comments like `// ----` similarly fail the test.
  if (/^[\s\-=#*/]+$/.test(trimmed)) return false;
  return true;
}

function normalizeUpstreamOwnedLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (GSD_HOOK_VERSION_LINE_RE.test(trimmed)) {
    const prefix = trimmed.startsWith('#') ? '#' : '//';
    return `${prefix} gsd-hook-version: __GSD_VERSION_TOKEN__`;
  }
  return line;
}

/**
 * Compute the SHA-256 hex digest of a string (UTF-8 encoded).
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read the `pristine_hashes` map from backup-meta.json in the patches dir.
 * Returns an empty object if backup-meta.json is absent, unreadable, or has no
 * `pristine_hashes` field — callers must treat an empty map as "no recorded
 * hash for any file" (no hash-validation possible, not an error).
 */
function readPristineHashes(patchesDir) {
  const metaPath = path.join(patchesDir, 'backup-meta.json');
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pristine_hashes === 'object' && parsed.pristine_hashes !== null) {
      return parsed.pristine_hashes;
    }
  } catch {
    // absent or unreadable — not an error, just no recorded hashes
  }
  return {};
}

/**
 * Walk a directory, returning every file's path relative to the root.
 */
function walk(rootDir, relPrefix = '') {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Compute the set of "user-added" lines: lines present in the backup but
 * absent from the pristine baseline. If no pristine is provided, falls back
 * to using every significant line in the backup (over-broad but safe — favours
 * false-positive failures over silent successes, which is the right side to
 * err on for #2969).
 */
function computeUserAddedLines(backupContent, pristineContent) {
  const backupLines = backupContent.split(/\r?\n/);
  if (!pristineContent) {
    return backupLines.filter(isSignificantLine);
  }
  const pristineSet = new Set(
    pristineContent.split(/\r?\n/).map(normalizeUpstreamOwnedLine),
  );
  return backupLines.filter((line) => {
    if (!isSignificantLine(line)) return false;
    return !pristineSet.has(normalizeUpstreamOwnedLine(line));
  });
}

/**
 * Stable reason codes for the per-file result. Tests assert via
 * `assert.equal(result.reason, REASON.X)` rather than regex-matching prose,
 * so the diagnostic surface is a typed enum, not free text.
 *
 * Adding a new reason requires updating the REASON map AND the tests'
 * shape assertion that locks the documented set of codes.
 */
const REASON = Object.freeze({
  OK_NO_USER_LINES_VS_PRISTINE: 'ok_no_user_lines_vs_pristine',
  OK_NO_SIGNIFICANT_BACKUP_LINES: 'ok_no_significant_backup_lines',
  // Bug #3657: the on-disk gsd-pristine/ file's SHA-256 does not match the
  // hash recorded in backup-meta.json.pristine_hashes.  This means the
  // pristine snapshot was refreshed to a newer GSD version after the backup
  // was captured.  Using the wrong-version pristine as the diff baseline would
  // invert the delta (upstream removals appear as "missing user lines").
  // The verifier skips this file rather than false-failing it.  A separate
  // re-anchor step (or the git-aware fallback in the workflow) is needed to
  // resolve this file; the guard here ensures the gate does not report spurious
  // failures in the meantime.
  OK_PRISTINE_DRIFT_DETECTED: 'ok_pristine_drift_detected',
  // Bug #934: backup-meta.json records a pristine_hash for this file but the
  // gsd-pristine/ file is absent from disk.  This happens on post-#604-rename
  // installs where saveLocalPatches discarded the only pristine candidate
  // because its hash did not match the old-release hash (the file changed
  // upstream between releases).  Without a baseline the verifier cannot
  // distinguish user-added lines from upstream-changed lines, so falling to
  // over-broad mode would produce FAIL_USER_LINES_MISSING false positives for
  // every upstream-removed line.  The correct posture is advisory/non-blocking:
  // report OK_NO_BASELINE so the caller can log a warning without halting the
  // gate on a spurious failure.  This is a bounded "cannot reason → do not
  // block" rather than "ignore everything" — it only applies when the hash was
  // recorded (modern installer) but the file is absent (specific gap).
  OK_NO_BASELINE: 'ok_no_baseline',
  // Bug #4136: an on-disk gsd-pristine/ snapshot exists for this file but
  // backup-meta.json records no pristine_hashes entry for it (older
  // installer), so nothing confirms the snapshot is the baseline the backup
  // was captured against — it could be a drifted newer-version snapshot the
  // #3657 guard cannot see.  The default gate still uses it as the diff
  // baseline (pre-#3657 behaviour, unchanged); --classify refuses to confirm
  // adoption on an unvalidated baseline, so a file is never classified
  // Incorporated on the snapshot's say-so alone.
  OK_UNVALIDATED_BASELINE: 'ok_unvalidated_baseline',
  FAIL_INSTALLED_MISSING: 'fail_installed_missing',
  FAIL_INSTALLED_NOT_REGULAR_FILE: 'fail_installed_not_regular_file',
  FAIL_READ_ERROR: 'fail_read_error',
  FAIL_USER_LINES_MISSING: 'fail_user_lines_missing',
});

/**
 * Bug #4136: stable per-file classification codes for --classify (pre-merge)
 * mode. Tests assert via `assert.equal(result.classification, CLASSIFICATION.X)`
 * rather than regex-matching prose, mirroring the REASON enum contract.
 *
 *   INCORPORATED — hash-validated pristine baseline confirms that every
 *                  significant user-added line is already present verbatim
 *                  in the freshly installed version: upstream adopted the
 *                  customization. The workflow must NOT re-apply the diff.
 *   NEEDS_MERGE  — validated baseline, but at least one significant
 *                  user-added line is absent from the fresh install; the
 *                  missing lines are listed for the merge step.
 *   UNKNOWN      — no confirmable baseline (drift #3657, absent #934,
 *                  unvalidated, or no --pristine-dir), zero significant
 *                  user-added delta, or a structural failure. Never
 *                  Incorporated.
 */
const CLASSIFICATION = Object.freeze({
  INCORPORATED: 'incorporated',
  NEEDS_MERGE: 'needs_merge',
  UNKNOWN: 'unknown',
});

/**
 * Typed outcome of resolving one file's pristine baseline. Shared by the
 * post-merge gate (verifyFile) and the pre-merge classifier (classifyFile)
 * so the two can never drift on what counts as a usable baseline (#4136).
 */
const PRISTINE_RESOLUTION = Object.freeze({
  VALIDATED: 'validated',          // recorded hash matches the resolved snapshot
  UNVALIDATED: 'unvalidated',      // snapshot present, no recorded hash to confirm it
  DRIFTED: 'drifted',              // recorded hash mismatches the snapshot (#3657)
  ABSENT_RECORDED: 'absent_recorded', // recorded hash, no snapshot anywhere (#934/#4145)
  OVERBROAD: 'overbroad',          // no pristine dir, or a non-file at the path
});

/**
 * Resolve the pristine baseline for one backed-up file, applying the #3657
 * drift guard, the #4145 hash-first recovery, and the #934 absent-baseline
 * guard. Extracted from verifyFile's inline block so --classify reasons over
 * the exact same baseline semantics the post-merge gate enforces.
 */
function resolvePristineBaseline({ relPath, configDir, pristineDir, pristineHashes }) {
  const hashKey = relPath.replace(/\\/g, '/');
  const recordedHash = pristineHashes && pristineHashes[hashKey];
  if (pristineDir) {
    const pristinePath = path.join(pristineDir, relPath);
    let pristinePathExists = false;
    try {
      const stat = fs.statSync(pristinePath);
      pristinePathExists = true; // path exists (any type)
      if (stat.isFile()) {
        const candidate = fs.readFileSync(pristinePath, 'utf8');
        if (recordedHash) {
          if (sha256(candidate) === recordedHash) {
            // Hash matches: the on-disk pristine is the correct baseline.
            return { resolution: PRISTINE_RESOLUTION.VALIDATED, content: candidate };
          }
          // Hash mismatch: the on-disk gsd-pristine/ was refreshed to a newer
          // GSD version after the backup was captured (Bug #3657).  Using it as
          // the diff baseline would invert the delta and produce false
          // FAIL_USER_LINES_MISSING reports.
          return { resolution: PRISTINE_RESOLUTION.DRIFTED, content: null };
        }
        // No recorded hash for this file (older installer or absent
        // backup-meta) — the default gate uses the on-disk pristine as-is
        // (pre-fix behaviour); --classify treats it as unvalidated.
        return { resolution: PRISTINE_RESOLUTION.UNVALIDATED, content: candidate };
      }
      // Non-file at pristinePath (e.g. a directory): fall through to
      // over-broad mode below, which is safe and conservative.
    } catch {
      // Pristine stat threw — path is absent (ENOENT) or inaccessible.
      // pristinePathExists stays false.
    }

    // Bug #4145: the canonical join missed, but the recorded hash is the
    // baseline authority the #3657 drift guard already trusts. Before
    // reporting ABSENT_RECORDED, scan gsd-pristine/ for byte-identical content
    // (an earlier release may have stored the snapshot without the gsd-core/
    // prefix). An exact sha-256 match cannot be the wrong baseline, and
    // gsd-pristine/ holds only backed-up files, so the scan is small. The
    // canonical path itself is excluded — a mismatching file at the joined
    // path is drift (#3657), never re-adopted through the scan. A recovered
    // baseline is hash-confirmed by construction, so it VALIDATES.
    if (!pristinePathExists && recordedHash) {
      try {
        const recoveredRel = findPristineByHash(pristineDir, recordedHash, hashKey);
        if (recoveredRel) {
          return {
            resolution: PRISTINE_RESOLUTION.VALIDATED,
            content: fs.readFileSync(path.join(pristineDir, recoveredRel), 'utf8'),
          };
        }
      } catch {
        // scan or read failure — fall through to the ABSENT_RECORDED posture
      }
    }

    if (pristinePathExists) {
      // Present but not a regular file — over-broad mode is the safe side.
      return { resolution: PRISTINE_RESOLUTION.OVERBROAD, content: null };
    }

    // Bug #4135: still nothing under gsd-pristine/ — the multi-version
    // regeneration collapse (the #3407 promotion rule only keeps files
    // byte-identical across the WHOLE version span, so the surviving set is
    // precisely the files upstream did not change). When the config dir is
    // itself a git repository, its history may hold the outgoing bytes: this
    // is the workflow's documented Option A (reapply-patches.md Step 2),
    // anchored by the SAME authority every other tier trusts — exact
    // pristine_hashes equality. Read-only (git log / git show); any failure
    // (no git, not a repo, no matching blob) degrades to ABSENT_RECORDED.
    // A recovered baseline is hash-confirmed by construction, so it VALIDATES.
    if (!pristinePathExists && recordedHash) {
      try {
        const fromGit = findPristineInGit(configDir, hashKey, recordedHash);
        if (fromGit !== null) {
          return { resolution: PRISTINE_RESOLUTION.VALIDATED, content: fromGit };
        }
      } catch {
        // git unavailable or history walk failed — ABSENT_RECORDED posture
      }
    }
    // Bug #934: recordedHash is present (modern installer) but no
    // hash-matching pristine exists anywhere under gsd-pristine/ (the stat
    // missed and the #4145 recovery found nothing).
    if (recordedHash) {
      return { resolution: PRISTINE_RESOLUTION.ABSENT_RECORDED, content: null };
    }
  }
  return { resolution: PRISTINE_RESOLUTION.OVERBROAD, content: null };
}

/**
 * #4086: resolve where a backed-up file's INSTALLED counterpart lives.
 * Primary is the config-dir-relative join (the manifest key's native form).
 * For skills/ keys of a runtime whose skills kind declares a `home` override
 * (codex global → $HOME/.agents/skills), the file lives OUTSIDE configDir, so
 * when the primary path is absent we fall back to the runtime's ACTUAL skills
 * root — derived from the same `resolveRuntimeArtifactLayout` seam the
 * installer writes through. Returns the primary path unchanged whenever the
 * fallback is impossible (no manifest, no runtime, no override, no file).
 */
function resolveInstalledPath(configDir, relPath, skillsRedirect) {
  const primary = path.join(configDir, relPath);
  if (!skillsRedirect) return primary;
  const hashKey = relPath.replace(/\\/g, '/');
  if (!hashKey.startsWith(skillsRedirect.prefix)) return primary;
  if (fs.existsSync(primary)) return primary;
  const alt = path.join(skillsRedirect.root, hashKey.slice(skillsRedirect.prefix.length));
  return fs.existsSync(alt) ? alt : primary;
}

/**
 * #4086: build the skills-root fallback descriptor for a config dir from its
 * own gsd-file-manifest.json (runtime + scope) and the runtime-artifact
 * layout seam. Returns null whenever any step is unavailable — the verifier
 * then behaves exactly as before (config-dir-relative only). Lazy + guarded
 * require: runtime-artifact-layout.cjs is a built lib; a layout-unaware
 * invocation must never crash the gate.
 */
function resolveSkillsRedirect(configDir) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'),
    );
    if (!manifest || typeof manifest.runtime !== 'string' || !manifest.runtime) return null;
    const scope = manifest.scope === 'local' ? 'local' : 'global';
    const { resolveRuntimeArtifactLayout } = require('./lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout(manifest.runtime, configDir, scope);
    const kind = layout.kinds.find((k) => k.kind === 'skills');
    if (!kind) return null;
    const root = path.resolve(path.join(kind.home || configDir, kind.destSubpath));
    const resolvedConfig = path.resolve(configDir);
    if (root === resolvedConfig || root.startsWith(resolvedConfig + path.sep)) return null; // allow-handrolled-containment: answers whether the skills root is a separate location, not a containment/admission decision
    // Same descriptor-driven manifest prefix writeManifest uses for skills
    // keys (hermes nests under 'skills/gsd/', everyone else 'skills/'), read
    // from the same shipped registry the installer's _resolveHostBehaviors
    // consults — never a re-derived literal (generative-fix-divergence guard).
    let prefix = 'skills/';
    try {
      const { runtimes: registryRuntimes } = require('./lib/capability-registry.cjs');
      const declared = registryRuntimes
        && registryRuntimes[manifest.runtime]
        && registryRuntimes[manifest.runtime].runtime
        && registryRuntimes[manifest.runtime].runtime.hostBehaviors;
      if (declared && typeof declared.skillsManifestPrefix === 'string') {
        prefix = declared.skillsManifestPrefix;
      }
    } catch { /* keep default prefix */ }
    return { root, prefix };
  } catch {
    return null;
  }
}

/**
 * #4135: baseline-coverage accounting. A file counts as baseline-covered
 * when its diff was actually computed against a resolved pristine baseline,
 * i.e. its reason is one of the baseline-diff outcomes (null = lines
 * verified present, OK_NO_USER_LINES_VS_PRISTINE = no user lines versus
 * the baseline, FAIL_USER_LINES_MISSING = lines missing). Everything else
 * is uncovered: the silent skips (no baseline anywhere per #934/#4135,
 * drift per #3657, no-pristine over-broad with nothing significant) AND
 * the structural failures (installed missing / not a file / read error),
 * which never reached a baseline — they are loud blocking failures, but
 * they were not baseline-verified either, and this aggregate exists to
 * state exactly how much of the run the gate could reason about. When
 * --pristine-dir is absent the whole run is over-broad (#2998 fallback):
 * no file was verified against a baseline, covered is 0 by construction.
 */
const BASELINE_VERIFIED_REASONS = new Set([
  REASON.OK_NO_USER_LINES_VS_PRISTINE,
  REASON.FAIL_USER_LINES_MISSING,
]);

function classifyBaselineCoverage(results, pristineDirProvided) {
  if (!pristineDirProvided) return 0;
  let covered = 0;
  for (const r of results) {
    if (r.reason === null || BASELINE_VERIFIED_REASONS.has(r.reason)) covered++;
  }
  return covered;
}

/**
 * #4135: the headline string for the human summary. A run with 12 of 13
 * files unbaselined must not present the same way as a fully-verified one —
 * the N-of-M form is the issue's own framing, and the unverified tail is
 * only rendered when it is non-zero.
 */
function coverageHeadline(covered, total) {
  const unverified = Math.max(0, total - covered);
  const base = `Baseline coverage: ${covered} of ${total} file(s) verified against a pristine baseline`;
  return unverified > 0 ? `${base} (${unverified} unverified)` : base;
}

// ── #4435: per-hunk model ────────────────────────────────────────────────
const HUNK_REASON = Object.freeze({
  BASELINE_UNCONFIRMED: 'baseline_unconfirmed',
  DIFF_TOO_LARGE: 'diff_too_large',
  ALREADY_UPSTREAM: 'already_upstream',
  PARTIALLY_UPSTREAM: 'partially_upstream',
  ANCHOR_ORPHANED: 'anchor_orphaned',
  REGION_CHANGED_UPSTREAM: 'region_changed_upstream',
});
const HUNK_RECOMMENDATION = Object.freeze({ KEEP: 'keep', RETIRE: 'retire', REVIEW: 'review' });
const DISPOSITION = Object.freeze({ KEEP: 'keep', RETIRE: 'retire', REWRITE: 'rewrite' });

/**
 * #4435: split a backup into hunks against the pristine baseline. Pure. The
 * union of every hunk's required_lines equals computeUserAddedLines(backup,
 * pristine) — same significance + normalization predicate.
 */
function computeHunks(fileKey, backupContent, pristineContent) {
  const B = backupContent.split(/\r?\n/);
  if (!pristineContent) {
    const required = computeUserAddedLines(backupContent, null);
    if (required.length === 0) return [];
    return numberHunks(fileKey, [{
      kind: 'file',
      user_lines: B.filter(isSignificantLine),
      stock_lines: [],
      required_lines: required,
      anchor_before: null,
      anchor_after: null,
      stock_range: null,
      diff_too_large: false,
    }]);
  }
  const P = pristineContent.split(/\r?\n/);
  const nP = P.map(normalizeUpstreamOwnedLine);
  const nB = B.map(normalizeUpstreamOwnedLine);
  const pristineSet = new Set(nP);
  const isRequired = (line) =>
    isSignificantLine(line) && !pristineSet.has(normalizeUpstreamOwnedLine(line));
  const m = matchLines(nP, nB);
  if (m === null) {
    const required = B.filter(isRequired);
    if (required.length === 0) return [];
    return numberHunks(fileKey, [{
      kind: 'replacement',
      user_lines: required,
      stock_lines: [],
      required_lines: required.slice(),
      anchor_before: null,
      anchor_after: null,
      stock_range: null,
      diff_too_large: true,
    }]);
  }
  const hunks = [];
  let prevP = -1;
  let run = [];
  const flush = (s, e) => {
    const userLines = run;
    run = [];
    const stockLines = P.slice(s, e);
    if (!userLines.some(isSignificantLine) && !stockLines.some(isSignificantLine)) return;
    const kind = userLines.length && stockLines.length ? 'replacement' : userLines.length ? 'addition' : 'deletion';
    let before = null;
    for (let i = s - 1; i >= 0; i--) {
      if (isSignificantLine(P[i])) { before = P[i]; break; }
    }
    let after = null;
    for (let i = e; i < P.length; i++) {
      if (isSignificantLine(P[i])) { after = P[i]; break; }
    }
    hunks.push({
      kind,
      user_lines: userLines,
      stock_lines: stockLines,
      required_lines: userLines.filter(isRequired),
      anchor_before: before,
      anchor_after: after,
      stock_range: [s, e],
      diff_too_large: false,
    });
  };
  for (let j = 0; j < B.length; j++) {
    if (m[j] === -1) {
      run.push(B[j]);
    } else {
      flush(prevP + 1, m[j]);
      prevP = m[j];
    }
  }
  flush(prevP + 1, P.length);
  return numberHunks(fileKey, hunks);
}

function numberHunks(fileKey, hunks) {
  return hunks.map((h, i) => ({
    hunk_id: i + 1,
    hunk_hash: sha256(JSON.stringify([fileKey, h.kind, h.user_lines, h.stock_lines, h.anchor_before, h.anchor_after, h.stock_range])),
    kind: h.kind,
    user_lines: h.user_lines,
    stock_lines: h.stock_lines,
    required_lines: h.required_lines,
    anchor_before: h.anchor_before,
    anchor_after: h.anchor_after,
    stock_range: h.stock_range,
    diff_too_large: h.diff_too_large,
  }));
}

/**
 * #4435: annotate hunks with presence in the fresh install, closed-vocabulary
 * reasons and a recommendation. Pure; strips stock_range / diff_too_large.
 */
function annotateHunks(hunks, { pristineContent, installedContent, baselineConfirmed }) {
  const installed = installedContent == null ? '' : installedContent;
  const iLines = new Set(installed.split(/\r?\n/).map((l) => normalizeUpstreamOwnedLine(l).trim()));
  let upstreamUnknown = false;
  const intervals = [];
  if (pristineContent && hunks.some((h) => h.stock_range)) {
    const P = pristineContent.split(/\r?\n/);
    const nP = P.map(normalizeUpstreamOwnedLine);
    const nI = installed.split(/\r?\n/).map(normalizeUpstreamOwnedLine);
    const u = matchLines(nP, nI);
    if (u === null) {
      upstreamUnknown = true;
    } else {
      let prevP = -1;
      let pendingInsert = false;
      for (let k = 0; k < nI.length; k++) {
        if (u[k] === -1) {
          pendingInsert = true;
        } else {
          if (pendingInsert || u[k] > prevP + 1) intervals.push([prevP + 1, u[k]]);
          pendingInsert = false;
          prevP = u[k];
        }
      }
      if (pendingInsert || P.length > prevP + 1) intervals.push([prevP + 1, P.length]);
    }
  }
  const touches = ([s, e]) => intervals.some(([a, b]) => a <= e && s <= b);
  const inInstall = (l) => iLines.has(normalizeUpstreamOwnedLine(l).trim());

  return hunks.map((h) => {
    const required = h.required_lines;
    const n = required.filter((l) => installed.includes(l)).length;
    const present = required.length === 0 ? 'n/a' : n === required.length ? 'all' : n === 0 ? 'none' : 'some';
    const reasons = [];
    if (!baselineConfirmed) reasons.push(HUNK_REASON.BASELINE_UNCONFIRMED);
    if (h.diff_too_large || (upstreamUnknown && h.stock_range)) reasons.push(HUNK_REASON.DIFF_TOO_LARGE);
    const stockSig = h.stock_lines.filter(isSignificantLine);
    if (
      (h.kind !== 'deletion' && present === 'all') ||
      (h.kind === 'deletion' && stockSig.length > 0 && stockSig.every((l) => !inInstall(l)))
    ) reasons.push(HUNK_REASON.ALREADY_UPSTREAM);
    if (present === 'some') reasons.push(HUNK_REASON.PARTIALLY_UPSTREAM);
    const anchors = [h.anchor_before, h.anchor_after].filter(Boolean);
    if (anchors.length > 0 && anchors.every((a) => !inInstall(a))) reasons.push(HUNK_REASON.ANCHOR_ORPHANED);
    if (h.stock_range && !upstreamUnknown && touches(h.stock_range)) reasons.push(HUNK_REASON.REGION_CHANGED_UPSTREAM);
    let recommendation;
    if (reasons.includes(HUNK_REASON.BASELINE_UNCONFIRMED) || reasons.includes(HUNK_REASON.DIFF_TOO_LARGE)) {
      recommendation = HUNK_RECOMMENDATION.REVIEW;
    } else if (reasons.includes(HUNK_REASON.ALREADY_UPSTREAM)) {
      recommendation = HUNK_RECOMMENDATION.RETIRE;
    } else if (reasons.length > 0) {
      recommendation = HUNK_RECOMMENDATION.REVIEW;
    } else {
      recommendation = HUNK_RECOMMENDATION.KEEP;
    }
    const { stock_range: _sr, diff_too_large: _dtl, ...rest } = h;
    return { ...rest, present_in_install: present, reasons, recommendation, exception: recommendation !== HUNK_RECOMMENDATION.KEEP };
  });
}

/**
 * #4435: per-file hunk record shared by --hunks and --decisions validation.
 */
function buildFileHunks({ relPath, patchesDir, configDir, pristineDir, pristineHashes, skillsRedirect }) {
  const out = { file: relPath, baseline: 'none', reason: null, hunks: [], installedContent: null, pristineContent: null };
  const backupPath = path.join(patchesDir, relPath);
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) return out;
  let backupContent;
  try {
    backupContent = fs.readFileSync(backupPath, 'utf8');
  } catch {
    out.reason = REASON.FAIL_READ_ERROR;
    return out;
  }
  const installedPath = resolveInstalledPath(configDir, relPath, skillsRedirect);
  try {
    const st = fs.statSync(installedPath);
    if (!st.isFile()) out.reason = REASON.FAIL_INSTALLED_NOT_REGULAR_FILE;
    else out.installedContent = fs.readFileSync(installedPath, 'utf8');
  } catch (err) {
    out.reason = err && err.code === 'ENOENT' ? REASON.FAIL_INSTALLED_MISSING : REASON.FAIL_READ_ERROR;
  }
  const { resolution, content } = resolvePristineBaseline({ relPath, configDir, pristineDir, pristineHashes });
  let pristine = null;
  if (resolution === PRISTINE_RESOLUTION.VALIDATED) {
    out.baseline = 'validated';
    pristine = content;
  } else if (resolution === PRISTINE_RESOLUTION.UNVALIDATED) {
    out.baseline = 'unvalidated';
    pristine = content;
  } else if (resolution === PRISTINE_RESOLUTION.DRIFTED) {
    out.reason = REASON.OK_PRISTINE_DRIFT_DETECTED;
  } else if (resolution === PRISTINE_RESOLUTION.ABSENT_RECORDED) {
    out.reason = REASON.OK_NO_BASELINE;
  }
  out.pristineContent = pristine;
  out.hunks = computeHunks(relPath.replace(/\\/g, '/'), backupContent, pristine);
  return out;
}

/**
 * #4435: strict loader for the human decisions file. Every malformed shape is
 * a usage error (exit 2) — a decision file is a trust boundary.
 */
function loadDecisions(decisionsPath) {
  let raw;
  try {
    raw = fs.readFileSync(decisionsPath, 'utf8');
  } catch (err) {
    throw new ExitError(2, `cannot read decisions file: ${decisionsPath}${err && err.code ? ` (${err.code})` : ''}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExitError(2, `decisions file is not valid JSON: ${decisionsPath}`);
  }
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(parsed) || !Array.isArray(parsed.decisions)) {
    throw new ExitError(2, 'decisions file must be an object with a "decisions" array');
  }
  const dispositions = new Set(Object.values(DISPOSITION));
  const byKey = new Map();
  parsed.decisions.forEach((d, i) => {
    if (!isPlain(d)) throw new ExitError(2, `invalid decision at index ${i}: not an object`);
    if (typeof d.file !== 'string' || d.file === '') throw new ExitError(2, `invalid decision at index ${i}: file must be a non-empty string`);
    if (typeof d.hunk_hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hunk_hash)) {
      throw new ExitError(2, `invalid decision at index ${i}: hunk_hash must be 64 lowercase hex characters`);
    }
    if (typeof d.disposition !== 'string' || !dispositions.has(d.disposition)) {
      throw new ExitError(2, `invalid decision at index ${i}: disposition must be one of ${[...dispositions].join(', ')}`);
    }
    const file = d.file.replace(/\\/g, '/');
    const key = `${file}\0${d.hunk_hash}`;
    const prior = byKey.get(key);
    if (prior) {
      if (prior.disposition !== d.disposition) {
        throw new ExitError(2, `conflicting decisions for ${file} ${d.hunk_hash}`);
      }
      return;
    }
    byKey.set(key, { file, hunk_hash: d.hunk_hash, disposition: d.disposition });
  });
  return [...byKey.values()];
}

function verifyFile({ relPath, patchesDir, configDir, pristineDir, pristineHashes, skillsRedirect, retiredHashes }) {
  const backupPath = path.join(patchesDir, relPath);
  const installedPath = resolveInstalledPath(configDir, relPath, skillsRedirect);
  const result = { file: relPath, status: 'ok', missing: [], reason: null };

  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    return result; // walked entry no longer exists — non-fatal
  }

  // Installed path checks: must exist, must be a regular file, must be
  // readable. Anything else is a fail-with-diagnostic, not a crash that
  // aborts the whole gate run and drops structured output.
  let installedStat;
  try {
    installedStat = fs.statSync(installedPath);
  } catch {
    result.status = 'fail';
    result.reason = REASON.FAIL_INSTALLED_MISSING;
    return result;
  }
  if (!installedStat.isFile()) {
    result.status = 'fail';
    result.reason = REASON.FAIL_INSTALLED_NOT_REGULAR_FILE;
    return result;
  }

  let backupContent;
  let installedContent;
  try {
    backupContent = fs.readFileSync(backupPath, 'utf8');
    installedContent = fs.readFileSync(installedPath, 'utf8');
  } catch {
    result.status = 'fail';
    result.reason = REASON.FAIL_READ_ERROR;
    return result;
  }

  // Normalize to forward slashes so the key lookup matches on Windows
  // where path.join produces backslash-separated relPath values but
  // backup-meta.json stores keys written with forward slashes.
  // #4136: the inline baseline block (stat/read + #3657 drift guard + #4145
  // hash-first recovery + #934 absent guard) moved into resolvePristineBaseline
  // so the pre-merge classifier reasons over the exact same semantics.
  const { resolution, content: pristineContent } =
    resolvePristineBaseline({ relPath, configDir, pristineDir, pristineHashes });

  // Bug #3657: the resolved snapshot hash-mismatches the recorded baseline.
  // Skip the file with a diagnostic code rather than diffing against the
  // wrong baseline (a re-anchor or git-aware baseline step is required).
  if (resolution === PRISTINE_RESOLUTION.DRIFTED) {
    result.reason = REASON.OK_PRISTINE_DRIFT_DETECTED;
    return result;
  }

  // Bug #934 / #4145: a hash was recorded (modern installer) but no
  // hash-matching pristine exists anywhere under gsd-pristine/ —
  // advisory/non-blocking, the caller logs a warning.
  if (resolution === PRISTINE_RESOLUTION.ABSENT_RECORDED) {
    result.reason = REASON.OK_NO_BASELINE;
    return result;
  }

  // VALIDATED / UNVALIDATED keep the gate's pre-#4136 semantics: the resolved
  // content (null for OVERBROAD) feeds computeUserAddedLines, whose no-pristine
  // branch is the over-broad fallback.

  let userAdded = computeUserAddedLines(backupContent, pristineContent);
  // #4435: a hunk retired/rewritten by a recorded human decision (bound to its
  // content hash) stops being required; every other hunk's lines still are.
  if (retiredHashes && retiredHashes.size > 0) {
    userAdded = computeHunks(relPath.replace(/\\/g, '/'), backupContent, pristineContent)
      .filter((h) => !retiredHashes.has(h.hunk_hash))
      .flatMap((h) => h.required_lines);
  }
  if (userAdded.length === 0) {
    // Backup and pristine match exactly (or no significant content) — nothing
    // to verify but also nothing to lose. Report as ok with diagnostic code.
    result.reason = pristineContent
      ? REASON.OK_NO_USER_LINES_VS_PRISTINE
      : REASON.OK_NO_SIGNIFICANT_BACKUP_LINES;
    return result;
  }

  for (const line of userAdded) {
    if (!installedContent.includes(line)) {
      result.missing.push(line.trim());
    }
  }
  if (result.missing.length > 0) {
    result.status = 'fail';
    result.reason = REASON.FAIL_USER_LINES_MISSING;
  }
  return result;
}

/**
 * Bug #4136: pre-merge classification for reapply-patches Step 4. Runs over
 * the SAME fixture state the gate sees (patches dir + freshly installed
 * config dir + optional pristine dir) but BEFORE any merge, answering the
 * question the gate cannot: is this file's user modification already adopted
 * upstream, such that the workflow should leave the installed file untouched
 * (status `Incorporated`) instead of re-grafting the diff?
 *
 * The classification is deliberately conservative in the direction the issue
 * demands ("a false Incorporated is worse than no Incorporated"):
 *   - only a hash-VALIDATED pristine baseline can confirm adoption — drift
 *     (#3657), absent (#934/#4145), unvalidated (no recorded hash), and a
 *     missing --pristine-dir all classify UNKNOWN;
 *   - every significant user-added line (structural/trivial lines excluded by
 *     isSignificantLine) must be present verbatim in the fresh install — a
 *     signature-looking short line or a code fence matching anywhere in the
 *     new file proves nothing;
 *   - a backup with zero significant delta vs the validated pristine is
 *     UNKNOWN (the workflow's Critical invariant: a backed-up file is never
 *     concluded to have "no custom content", and Incorporated is a positive
 *     adoption finding, not a skip);
 *   - structural failures are reported with their FAIL_* reason but never
 *     gate the run — the binding enforcement point stays the post-merge gate.
 */
function classifyFile({ relPath, patchesDir, configDir, pristineDir, pristineHashes, skillsRedirect }) {
  const backupPath = path.join(patchesDir, relPath);
  const installedPath = resolveInstalledPath(configDir, relPath, skillsRedirect);
  const result = { file: relPath, classification: CLASSIFICATION.UNKNOWN, reason: null, missing: [] };

  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    return result; // walked entry no longer exists — non-fatal
  }

  let installedStat;
  try {
    installedStat = fs.statSync(installedPath);
  } catch {
    result.reason = REASON.FAIL_INSTALLED_MISSING;
    return result;
  }
  if (!installedStat.isFile()) {
    result.reason = REASON.FAIL_INSTALLED_NOT_REGULAR_FILE;
    return result;
  }

  let backupContent;
  let installedContent;
  try {
    backupContent = fs.readFileSync(backupPath, 'utf8');
    installedContent = fs.readFileSync(installedPath, 'utf8');
  } catch {
    result.reason = REASON.FAIL_READ_ERROR;
    return result;
  }

  const { resolution, content: pristineContent } =
    resolvePristineBaseline({ relPath, configDir, pristineDir, pristineHashes });

  if (resolution === PRISTINE_RESOLUTION.DRIFTED) {
    result.reason = REASON.OK_PRISTINE_DRIFT_DETECTED;
    return result;
  }
  if (resolution === PRISTINE_RESOLUTION.ABSENT_RECORDED) {
    result.reason = REASON.OK_NO_BASELINE;
    return result;
  }
  if (resolution === PRISTINE_RESOLUTION.UNVALIDATED) {
    result.reason = REASON.OK_UNVALIDATED_BASELINE;
    return result;
  }
  if (resolution !== PRISTINE_RESOLUTION.VALIDATED) {
    // OVERBROAD: no --pristine-dir (two-way fallback) or a non-file at the
    // pristine path. Without a baseline there is no adoption evidence.
    return result;
  }

  const userAdded = computeUserAddedLines(backupContent, pristineContent);
  if (userAdded.length === 0) {
    result.reason = REASON.OK_NO_USER_LINES_VS_PRISTINE;
    return result;
  }

  for (const line of userAdded) {
    if (!installedContent.includes(line)) {
      result.missing.push(line.trim());
    }
  }
  if (result.missing.length === 0) {
    result.classification = CLASSIFICATION.INCORPORATED;
  } else {
    result.classification = CLASSIFICATION.NEEDS_MERGE;
  }
  return result;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.hunks && opts.classify) {
    throw new ExitError(2, '--hunks and --classify are mutually exclusive');
  }
  if (opts.decisionsPath !== null && (opts.hunks || opts.classify)) {
    throw new ExitError(2, '--decisions applies only to the post-merge gate');
  }
  if (!opts.patchesDir || !opts.configDir) {
    throw new ExitError(2, '--patches-dir and --config-dir are required');
  }
  if (!fs.existsSync(opts.patchesDir)) {
    throw new ExitError(2, `patches dir not found: ${opts.patchesDir}`);
  }
  if (!fs.existsSync(opts.configDir)) {
    throw new ExitError(2, `config dir not found: ${opts.configDir}`);
  }

  const files = walk(opts.patchesDir).filter((f) => !f.endsWith('backup-meta.json'));
  // Bug #3657: read pristine_hashes from backup-meta.json once and share
  // across all per-file verifications so each can detect drift independently.
  const pristineHashes = readPristineHashes(opts.patchesDir);
  // #4086: skills-root fallback for runtimes whose skills kind declares a
  // `home` override outside configDir (codex global → $HOME/.agents/skills).
  const skillsRedirect = resolveSkillsRedirect(opts.configDir);

  // #4435: --hunks is the pre-merge per-hunk presentation mode. It recommends;
  // it never decides and never gates (always exit 0).
  if (opts.hunks) {
    const fileRecords = files.map((relPath) => {
      const rec = buildFileHunks({
        relPath,
        patchesDir: opts.patchesDir,
        configDir: opts.configDir,
        pristineDir: opts.pristineDir,
        pristineHashes,
        skillsRedirect,
      });
      return {
        file: rec.file,
        baseline: rec.baseline,
        reason: rec.reason,
        hunks: annotateHunks(rec.hunks, {
          pristineContent: rec.pristineContent,
          installedContent: rec.installedContent,
          baselineConfirmed: rec.baseline === 'validated',
        }),
      };
    });
    const hunksTotal = fileRecords.reduce((n, f) => n + f.hunks.length, 0);
    const exceptionsTotal = fileRecords.reduce((n, f) => n + f.hunks.filter((h) => h.exception).length, 0);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ checked: fileRecords.length, hunks_total: hunksTotal, exceptions_total: exceptionsTotal, files: fileRecords }, null, 2) + '\n',
      );
    } else {
      process.stdout.write(`# Reapply Patch Hunks (#4435)\n\n`);
      process.stdout.write(`Checked: ${fileRecords.length} file(s)\n`);
      process.stdout.write(`Hunks: ${hunksTotal} (${exceptionsTotal} exception(s))\n`);
      for (const f of fileRecords) {
        for (const h of f.hunks) {
          if (h.exception) {
            process.stdout.write(`- ${f.file} hunk ${h.hunk_id} [${h.recommendation}] ${h.reasons.join(', ')}\n`);
          }
        }
      }
    }
    return 0;
  }

  // Bug #4136: --classify is the pre-merge mode the workflow runs in Step 4
  // to decide which files NOT to merge. It is informational — always exit 0 —
  // because the binding enforcement stays with the post-merge gate below;
  // a needs_merge or unknown outcome is direction for the merge step, not a
  // failure, and halting here would block the very merge that resolves it.
  if (opts.classify) {
    const classifyResults = files.map((relPath) =>
      classifyFile({
        relPath,
        patchesDir: opts.patchesDir,
        configDir: opts.configDir,
        pristineDir: opts.pristineDir,
        pristineHashes,
        skillsRedirect,
      }),
    );
    const incorporatedResults = classifyResults.filter(
      (r) => r.classification === CLASSIFICATION.INCORPORATED,
    );
    const incorporated = incorporatedResults.length;
    const incorporated_files = incorporatedResults.map((r) => r.file);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ checked: classifyResults.length, incorporated, incorporated_files, results: classifyResults }, null, 2) + '\n',
      );
    } else {
      process.stdout.write(`# Reapply Patch Classification (#4136)\n\n`);
      process.stdout.write(`Checked: ${classifyResults.length} file(s)\n`);
      process.stdout.write(`Incorporated: ${incorporated} file(s)\n`);
      for (const f of incorporated_files) {
        process.stdout.write(`  incorporated: ${f}\n`);
      }
      for (const r of classifyResults) {
        if (r.classification === CLASSIFICATION.NEEDS_MERGE) {
          process.stdout.write(`  needs merge: ${r.file}\n`);
          for (const line of r.missing.slice(0, 5)) {
            process.stdout.write(`    missing: ${line}\n`);
          }
          if (r.missing.length > 5) {
            process.stdout.write(`    …and ${r.missing.length - 5} more line(s)\n`);
          }
        }
      }
    }
    return 0;
  }

  // #4435: validate every decision against the current hunks BEFORE verifying.
  // A decision whose hash no longer matches a hunk is stale and aborts (exit 2).
  let decisions = null;
  const retiredByFile = new Map();
  const retiredList = [];
  if (opts.decisionsPath !== null) {
    decisions = loadDecisions(opts.decisionsPath);
    const fileSet = new Set(files.map((f) => f.replace(/\\/g, '/')));
    const relByKey = new Map(files.map((f) => [f.replace(/\\/g, '/'), f]));
    const hunkCache = new Map();
    for (const d of decisions) {
      if (!fileSet.has(d.file)) {
        throw new ExitError(2, `decision names a file not in the patches dir: ${d.file}`);
      }
      if (!hunkCache.has(d.file)) {
        hunkCache.set(d.file, buildFileHunks({
          relPath: relByKey.get(d.file),
          patchesDir: opts.patchesDir,
          configDir: opts.configDir,
          pristineDir: opts.pristineDir,
          pristineHashes,
          skillsRedirect,
        }).hunks);
      }
      const hunk = hunkCache.get(d.file).find((h) => h.hunk_hash === d.hunk_hash);
      if (!hunk) {
        throw new ExitError(2, `stale decision: hunk ${d.hunk_hash} no longer matches ${d.file} (the backup or baseline changed since it was shown)`);
      }
      if (d.disposition === DISPOSITION.RETIRE || d.disposition === DISPOSITION.REWRITE) {
        if (!retiredByFile.has(d.file)) retiredByFile.set(d.file, new Set());
        retiredByFile.get(d.file).add(d.hunk_hash);
        retiredList.push({ file: d.file, hunk_id: hunk.hunk_id, hunk_hash: d.hunk_hash, disposition: d.disposition });
      }
    }
  }

  const results = files.map((relPath) =>
    verifyFile({
      relPath,
      patchesDir: opts.patchesDir,
      configDir: opts.configDir,
      pristineDir: opts.pristineDir,
      pristineHashes,
      skillsRedirect,
      retiredHashes: retiredByFile.get(relPath.replace(/\\/g, '/')),
    }),
  );

  const failures = results.filter((r) => r.status === 'fail');

  // Bug #3657 (Finding 1): aggregate drifted files into top-level report fields
  // so workflow Step 5a can gate on drift distinctly from failures.  Drift is
  // NOT a failure (exit code stays 0) but the workflow now has structured data
  // to decide whether to proceed.  Per-file shape is unchanged: each drifted
  // result still has status:'ok' + reason:OK_PRISTINE_DRIFT_DETECTED for
  // backward compat.  The new top-level fields are purely additive.
  const driftedResults = results.filter((r) => r.reason === REASON.OK_PRISTINE_DRIFT_DETECTED);
  const drifted = driftedResults.length;
  const drifted_files = driftedResults.map((r) => r.file);

  // Bug #934: aggregate no-baseline files into top-level report fields so the
  // workflow can log a warning about files that could not be verified.  Like
  // drift, this is NOT a failure (exit code stays 0) but gives the caller
  // structured data to surface the advisory condition.
  const noBaselineResults = results.filter((r) => r.reason === REASON.OK_NO_BASELINE);
  const no_baseline = noBaselineResults.length;
  const no_baseline_files = noBaselineResults.map((r) => r.file);

  // Bug #4135: baseline coverage is a first-class aggregate. The collapse
  // this reports is silent by design in every other surface (no_baseline is
  // advisory, exit stays 0), which is exactly why it must be counted here:
  // "A clean verifier exit reads as 'hunks survived'. On this run it meant
  // '12 of 13 files were not checked at all.'"
  const baseline_covered = classifyBaselineCoverage(results, Boolean(opts.pristineDir));

  // Bug #4135: the opt-in strict coverage gate. Threshold semantics are >=
  // (a run exactly at the threshold passes); an empty run is vacuously
  // covered (nothing checked cannot be under-covered). A content failure
  // (exit 1) outranks a coverage failure — it is the louder, more specific
  // signal.
  let coverageGateFailed = false;
  if (opts.minBaselineCoverage !== null) {
    const ratio = results.length === 0 ? 1 : baseline_covered / results.length;
    coverageGateFailed = ratio < opts.minBaselineCoverage;
  }

  if (opts.json) {
    const report = { checked: results.length, failures: failures.length, drifted, drifted_files, no_baseline, no_baseline_files, baseline_covered, results };
    if (decisions) report.decisions = { applied: decisions.length, retired: retiredList };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`# Hunk Verification Gate (#2969)\n\n`);
    process.stdout.write(`Checked: ${results.length} file(s)\n`);
    process.stdout.write(`Failures: ${failures.length}\n`);
    // #4135: the coverage headline is printed on EVERY run, before any
    // per-file detail, so a near-zero-coverage green run can never render
    // identically to a fully-verified one.
    process.stdout.write(`${coverageHeadline(baseline_covered, results.length)}\n`);
    if (decisions) {
      process.stdout.write(`Decisions: ${decisions.length} applied, ${retiredList.length} hunk(s) retired by user decision\n`);
    }
    process.stdout.write('\n');
    if (baseline_covered < results.length) {
      if (!opts.pristineDir) {
        process.stdout.write(`No --pristine-dir: over-broad fallback — nothing was verified against a pristine baseline (#2998).\n\n`);
      } else {
        const skipped = results.filter((r) => r.reason !== null && !BASELINE_VERIFIED_REASONS.has(r.reason));
        process.stdout.write(`## Files not verified against a pristine baseline\n\n`);
        process.stdout.write(`Advisory (non-blocking): their user customizations may or may not have survived the merge.\n\n`);
        for (const r of skipped) {
          process.stdout.write(`- ${r.file} (${r.reason})\n`);
        }
        process.stdout.write('\n');
      }
    }
    if (coverageGateFailed) {
      process.stdout.write(`COVERAGE GATE FAILED: baseline coverage ${(opts.minBaselineCoverage * 100).toFixed(1)}% required, ${results.length === 0 ? 100 : ((baseline_covered / results.length) * 100).toFixed(1)}% achieved (#4135 strict mode).\n\n`);
    }
    if (failures.length > 0) {
      process.stdout.write(`## Files with missing user-added content\n\n`);
      for (const r of failures) {
        process.stdout.write(`- ${r.file}\n`);
        if (r.reason) process.stdout.write(`  reason: ${r.reason}\n`);
        for (const line of r.missing.slice(0, 5)) {
          process.stdout.write(`  missing: ${line}\n`);
        }
        if (r.missing.length > 5) {
          process.stdout.write(`  …and ${r.missing.length - 5} more line(s)\n`);
        }
      }
    }
  }

  if (failures.length > 0) return 1;
  if (coverageGateFailed) return 3;
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = { computeHunks, annotateHunks, buildFileHunks, HUNK_REASON, HUNK_RECOMMENDATION, DISPOSITION, computeUserAddedLines, isSignificantLine, verifyFile, classifyFile, walk, REASON, CLASSIFICATION, PRISTINE_RESOLUTION, resolvePristineBaseline, readPristineHashes, sha256, resolveInstalledPath, resolveSkillsRedirect, coverageHeadline, classifyBaselineCoverage };

