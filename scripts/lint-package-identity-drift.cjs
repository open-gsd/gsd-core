#!/usr/bin/env node
'use strict';

/**
 * Drift-guard lint for the Package Identity seam (issue #498).
 *
 * The seam (`get-shit-done/bin/lib/package-identity.cjs`, derived from // gsd-allow-legacy-name
 * package.json) is the single source of GSD's published coordinates. Many
 * runtime surfaces still carry a literal copy of those coordinates because
 * they cannot `require()` the seam at runtime: the bash launcher snippet (and
 * its byte-equal copies across ~85 workflows, kept in lockstep by the
 * runtime-launcher parity test) and the installer's user-facing install/help
 * strings.
 *
 * This lint makes those literals *value-checked*: every GSD package/repo
 * coordinate that appears as a literal must equal the seam's current value.
 * It passes today (the literals are correct) and FAILS the moment a repoint is
 * not propagated — rename package.json, regenerate the seam, and every stale
 * literal is reported until updated. That is what turns a repoint into a
 * one-line change with mechanical enforcement.
 *
 * Scope: the runtime/code surface (bin/, hooks/, scripts/, get-shit-done/). // gsd-allow-legacy-name
 * Pure-prose docs and localized READMEs are intentionally out of scope.
 */

const fs = require('node:fs');
const path = require('node:path');

// A GSD package coordinate: a scoped npm name whose package part contains
// "get-shit-done" (so @opengsd/gsd-sdk and unrelated scopes never match). // gsd-allow-legacy-name
const PACKAGE_RE = /@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]*get-shit-done[A-Za-z0-9._-]*/g; // gsd-allow-legacy-name
// A GSD repo slug, only inside a GitHub URL context so it never overlaps the
// scoped package literal above. The `.git` suffix is trimmed before compare.
const SLUG_RE = /(?:github\.com[/:]|raw\.githubusercontent\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]*get-shit-done[A-Za-z0-9._-]*)/g; // gsd-allow-legacy-name

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Pure: find every GSD coordinate literal in `text` that does not match the
 * expected seam values. Returns [{ kind, found, expected, line }].
 */
function findCoordinateDrift(text, { packageName, repoSlug }) {
  const out = [];
  for (const m of text.matchAll(PACKAGE_RE)) {
    if (m[0] !== packageName) {
      out.push({ kind: 'package', found: m[0], expected: packageName, line: lineOf(text, m.index) });
    }
  }
  for (const m of text.matchAll(SLUG_RE)) {
    const slug = m[1].replace(/\.git$/, '');
    if (slug !== repoSlug) {
      out.push({ kind: 'slug', found: slug, expected: repoSlug, line: lineOf(text, m.index) });
    }
  }
  return out;
}

// Directories scanned, relative to repo root.
const SCAN_DIRS = ['bin', 'hooks', 'scripts', 'gsd-core'];
const SCAN_EXT = new Set(['.js', '.cjs', '.sh', '.md']);
// Files exempt because they ARE the source of truth / the tooling that defines
// the coordinate patterns. The generated seam holds the correct value by
// construction; the generator and this lint carry regex/templates, not stray
// literals.
const EXEMPT = new Set([
  path.join('gsd-core', 'bin', 'lib', 'package-identity.cjs'),
  path.join('scripts', 'generate-package-identity.cjs'),
  path.join('scripts', 'lint-package-identity-drift.cjs'),
]);

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Scan the repo's runtime/code surface and return all coordinate drift, each
 * annotated with the repo-relative file path.
 */
function scanRepo(root) {
  const seam = require(path.join(root, 'gsd-core', 'bin', 'lib', 'package-identity.cjs'));
  const expected = { packageName: seam.packageName, repoSlug: seam.repoSlug };
  const violations = [];
  for (const dir of SCAN_DIRS) {
    const files = walk(path.join(root, dir), []);
    for (const file of files) {
      const rel = path.relative(root, file);
      if (EXEMPT.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }
      for (const d of findCoordinateDrift(text, expected)) {
        violations.push({ file: rel, ...d });
      }
    }
  }
  return violations;
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok identity-drift: all GSD coordinate literals match the seam\n');
    return;
  }
  process.stderr.write('identity-drift: stale GSD coordinate literal(s) found.\n');
  process.stderr.write('Repoint by editing package.json, then `node scripts/generate-package-identity.cjs`,\n');
  process.stderr.write('and update the value-checked materialization sites below:\n');
  for (const d of violations) {
    process.stderr.write(`  ${d.file}:${d.line}  ${d.kind} '${d.found}' != '${d.expected}'\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findCoordinateDrift, scanRepo };
