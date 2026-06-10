'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Named-set allowlist guard against Windows-test-parity regressions.
 *
 * PR #3649 cleared ~270 Windows-only test failures from the chunking fix
 * in #3597 surfaced. Each cluster reduced to a handful of repeating
 * patterns. This guard prevents the patterns from being re-introduced.
 *
 * Strategy (updated from integer-count ratchet): each rule's known offenders
 * are enumerated by filename in a frozen KNOWN_OFFENDERS set. The guard uses
 * the shared assertWithinAllowlist primitive (scripts/lib/allowlist-ratchet.cjs)
 * which enforces BOTH directions:
 *   - Novel offenders (current \ known) → fail immediately.
 *   - Stale allowlist entries (known \ current) → also fail, forcing the
 *     allowlist to shrink as defects are fixed (ratchet-DOWN enforcement).
 *
 * When you fix an existing offender, you MUST remove its entry from
 * KNOWN_OFFENDERS — the guard will fail on stale entries to enforce progress.
 * When CI breaks because a new file introduced an anti-pattern, fix the
 * anti-pattern — do not just add the filename to the set to silence the guard.
 *
 * rmSync teardown safety is now enforced at write-time by the ESLint rule
 * local/no-raw-rmsync-in-tests (see issue #597); it is no longer ratcheted here.
 *
 * Scope: tests/ only. Production-code Windows-compat is enforced via
 * behavioural tests (see no-unconditional-win32-skip.test.cjs).
 */

// allow-test-rule: structural-regression-guard

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertWithinAllowlist } = require('../scripts/lib/allowlist-ratchet.cjs');

const TESTS_DIR = path.join(__dirname);
const SELF = path.basename(__filename);

// ── Known offenders after PR #3649 batch (named-set allowlist) ───────────
// These are the files that matched each anti-pattern at the time of writing.
// A test fails when a file NOT in the set starts matching (novel regression),
// OR when a file in the set stops matching (stale entry — must be pruned).
// Edit this object to update the allowlists:
//   edit KNOWN_OFFENDERS in tests/windows-test-parity-guard.test.cjs
const KNOWN_OFFENDERS = Object.freeze({
  splitNewlineOnFileContent: new Set([
    'release-coverage-scope.test.cjs',
    'secret-scan-lint.security.test.cjs',
    'security-scan.security.test.cjs',
  ]),
  fenceRegexLiteralNewline: new Set([
    'bug-2995-post-install-script-paths.test.cjs',
    'security-scan.security.test.cjs',
  ]),
  frontmatterAnchorLiteralNewline: new Set([
    'bug-1967-cache-invalidation.test.cjs',
    'bug-2643-skill-frontmatter-name.test.cjs',
    'bug-2808-skill-hyphen-name.test.cjs',
    'bug-3168-task-to-agent-rename.test.cjs',
    'qwen-skills-migration.test.cjs',
  ]),
  hardcodedTmpToFsCall: new Set([
    // (none at time of writing)
  ]),
  bareNpmExecWithoutShell: new Set([
    // (none at time of writing)
  ]),
  stubsHomeNoUserProfile: new Set([
    'bug-130-finishinstall-opencode-testmode.test.cjs',
    'bug-2794-opencode-model-profile-overrides.test.cjs',
    'claude-md.test.cjs',
    'feat-443-effort-install-wiring.install.test.cjs',
    'issue-2517-runtime-aware-profiles.test.cjs',
  ]),
});

function listTestFiles() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => /\.(test|spec)\.cjs$/.test(f))
    .filter((f) => f !== SELF)
    .map((f) => path.join(TESTS_DIR, f));
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// Strip line comments and block comments before pattern matching to avoid
// false-positives in commentary describing the very pattern we forbid.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function countMatchingFiles(predicate) {
  let count = 0;
  const offenders = [];
  for (const file of listTestFiles()) {
    const text = stripComments(readFileText(file));
    if (predicate(text, file)) {
      count += 1;
      offenders.push(path.basename(file));
    }
  }
  return { count, offenders };
}

const PRUNE_HINT = 'edit KNOWN_OFFENDERS in tests/windows-test-parity-guard.test.cjs';

describe('Windows test-parity lint guards (named-set allowlist: PR #3649)', () => {
  // ── G1 — CRLF: file-content split on literal '\n' ─────────────────────
  test('split-on-newline after readFileSync (use /\\r?\\n/)', () => {
    const { offenders } = countMatchingFiles((text) => {
      return /\.readFileSync\s*\([^)]*\)[^;]*\.split\(\s*['"]\\n['"]\s*\)/.test(text);
    });
    assertWithinAllowlist({
      label: 'splitNewlineOnFileContent',
      current: offenders,
      known: KNOWN_OFFENDERS.splitNewlineOnFileContent,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });

  // ── G2 — CRLF: ```bash|sh\n fence regex on file content ──────────────
  test('markdown-fence regex with literal \\n after ```bash/sh', () => {
    const { offenders } = countMatchingFiles((text) => {
      return /\/[^/]*```(?:bash|sh)\\n[^/]*\//.test(text);
    });
    assertWithinAllowlist({
      label: 'fenceRegexLiteralNewline',
      current: offenders,
      known: KNOWN_OFFENDERS.fenceRegexLiteralNewline,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });

  // ── G3 — CRLF: frontmatter regex with literal '\n' ────────────────────
  test('frontmatter regex anchors on /^---\\n/', () => {
    const { offenders } = countMatchingFiles((text) => {
      return /\/\^---\\n/.test(text);
    });
    assertWithinAllowlist({
      label: 'frontmatterAnchorLiteralNewline',
      current: offenders,
      known: KNOWN_OFFENDERS.frontmatterAnchorLiteralNewline,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });

  // ── G4 — POSIX-tmp: hardcoded '/tmp/' literal passed to fs.* ─────────
  test('fs.* call receives a hardcoded "/tmp/..." literal', () => {
    const { offenders } = countMatchingFiles((text) => {
      return /\bfs\.[A-Za-z]+\s*\([^)]*['"]\/tmp\/[^'"]+['"][^)]*\)/.test(text);
    });
    assertWithinAllowlist({
      label: 'hardcodedTmpToFsCall',
      current: offenders,
      known: KNOWN_OFFENDERS.hardcodedTmpToFsCall,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });

  // ── G5 — npm.cmd: bare 'npm' to exec*Sync without shell:true ─────────
  test('bare npm exec without shell-true Windows fallback', () => {
    const { offenders } = countMatchingFiles((text) => {
      const re = /\b(?:execFileSync|spawnSync)\s*\(\s*['"]npm['"]\s*,[^)]*\)/g;
      const matches = text.match(re) || [];
      return matches.some((m) =>
        !/shell\s*:\s*true/.test(m) && !/shell\s*:\s*isWindows/.test(m),
      );
    });
    assertWithinAllowlist({
      label: 'bareNpmExecWithoutShell',
      current: offenders,
      known: KNOWN_OFFENDERS.bareNpmExecWithoutShell,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });

  // ── G6 — Test stubs HOME without USERPROFILE ─────────────────────────
  test('test stubs process.env.HOME but never references USERPROFILE', () => {
    const { offenders } = countMatchingFiles((text) => {
      return /process\.env\.HOME\s*=\s*/.test(text) && !/USERPROFILE/.test(text);
    });
    assertWithinAllowlist({
      label: 'stubsHomeNoUserProfile',
      current: offenders,
      known: KNOWN_OFFENDERS.stubsHomeNoUserProfile,
      fail: assert.fail,
      pruneHint: PRUNE_HINT,
    });
  });
});
