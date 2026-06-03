#!/usr/bin/env node
/**
 * lint-legacy-dir-name.cjs
 *
 * Prevents accidental re-introduction of the bare legacy directory token
 * `get-shit-done` now that the package has been renamed to `gsd-core` (#604).
 *
 * The forbidden token is constructed by splitting across the concat operator
 * so this guard script cannot flag itself:
 *   const FORBIDDEN = 'get-shit' + '-done';
 *
 * Regex: FORBIDDEN + '(?!-\\w)' — allows any hyphenated slug variant
 *   (get-shit-done-OLD, get-shit-done-classic, get-shit-done-cli, etc.)
 *   while forbidding the bare word boundary that would indicate a stale
 *   directory reference. This is the exact pattern that would appear in a
 *   path like `~/.claude/get-shit-done/` or `'get-shit-done'` in code.
 *
 * Allowlist:
 *   - CHANGELOG.md (historical record; reviewed manually)
 *   - .changeset/ (ephemeral release-note fragments; consumed into CHANGELOG on
 *     release — like CHANGELOG, not swept by rename PRs)
 *   - Translated READMEs: README.ja-JP.md, README.ko-KR.md, README.pt-BR.md, README.zh-CN.md
 *   - Locale-specific docs dirs: docs/ja-JP/, docs/ko-KR/, docs/pt-BR/, docs/zh-CN/
 *   - Lines containing the marker `gsd-allow-legacy-name` (intentional uses)
 *   - Binary files (detected by NUL byte scan)
 *   - This guard script itself (by path)
 *
 * Exit 0 if no violations; exit 1 if any are found (with stderr diagnostics).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Constructed with split to avoid self-match when this script is scanned.
const FORBIDDEN = 'get-shit' + '-done';
const FORBIDDEN_RE = new RegExp(FORBIDDEN + '(?!-\\w)', 'gi');

const ALLOW_MARKER = 'gsd-allow-legacy-name';
const SELF_PATH = path.resolve(__filename);
// GSD_LINT_LEGACY_REPO_ROOT is used by tests to redirect the guard to a
// temporary fixture git repo without touching the real working tree.
const REPO_ROOT = process.env.GSD_LINT_LEGACY_REPO_ROOT
  ? path.resolve(process.env.GSD_LINT_LEGACY_REPO_ROOT)
  : path.resolve(__dirname, '..');

const ALLOWLIST_FILES = new Set([
  'CHANGELOG.md',
  'README.ja-JP.md',
  'README.ko-KR.md',
  'README.pt-BR.md',
  'README.zh-CN.md',
]);

const ALLOWLIST_DIR_PREFIXES = [
  // Pending changeset fragments are ephemeral release-note stubs consumed into
  // CHANGELOG on release — like CHANGELOG itself, they should not be swept by
  // rename PRs and may legitimately contain the legacy token in historical prose.
  '.changeset/',
  'docs/ja-JP/',
  'docs/ko-KR/',
  'docs/pt-BR/',
  'docs/zh-CN/',
];

function isAllowlisted(relPath) {
  if (ALLOWLIST_FILES.has(relPath)) return true;
  for (const prefix of ALLOWLIST_DIR_PREFIXES) {
    if (relPath.startsWith(prefix)) return true;
  }
  return false;
}

function isBinary(fullPath) {
  // Read a small chunk and check for NUL bytes.
  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.allocUnsafe(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

// Enumerate tracked files via git ls-files so only committed/staged source is checked.
let trackedFiles;
try {
  trackedFiles = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
} catch (err) {
  process.stderr.write('ERROR lint-legacy-dir-name: git ls-files failed: ' + err.message + '\n');
  process.exit(1);
}

const violations = [];

for (const relPath of trackedFiles) {
  if (isAllowlisted(relPath)) continue;

  const fullPath = path.join(REPO_ROOT, relPath);

  // Skip this guard script itself.
  if (path.resolve(fullPath) === SELF_PATH) continue;

  if (isBinary(fullPath)) continue;

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    // Unreadable files (permissions, etc.) — skip silently.
    continue;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that carry the explicit allow marker.
    if (line.includes(ALLOW_MARKER)) continue;

    FORBIDDEN_RE.lastIndex = 0;
    let match;
    while ((match = FORBIDDEN_RE.exec(line)) !== null) {
      violations.push({
        file: relPath,
        line: i + 1,
        col: match.index + 1,
        text: match[0],
      });
    }
  }
}

if (violations.length === 0) {
  process.stdout.write('ok lint-legacy-dir-name: ' + trackedFiles.length + ' tracked file(s) checked, 0 violations\n');
  process.exit(0);
}

process.stderr.write('\nERROR lint-legacy-dir-name: ' + violations.length + ' violation(s) found\n\n');
for (const v of violations) {
  process.stderr.write('  ' + v.file + ':' + v.line + ':' + v.col + ' — ' + JSON.stringify(v.text) + '\n');
}
process.stderr.write('\n');
process.stderr.write('Fix: rename to gsd-core, or add `gsd-allow-legacy-name` marker on the line if the\n');
process.stderr.write('      use is intentional (migration modules, tests, guard, changeset).\n\n');
process.exit(1);
