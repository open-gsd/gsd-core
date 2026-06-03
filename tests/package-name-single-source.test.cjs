'use strict';

/**
 * Lint guard: the package name must be single-sourced from package-identity.cjs.
 *
 * Scans runtime files (bin/install.js, gsd-core/bin/**, scripts/*.cjs)
 * and FAILS if the literal `@opengsd/gsd-core` appears in a
 * non-comment, non-identity-module line. This enforces that a future rename
 * is a one-file change in package.json (#516).
 *
 * Comment lines are detected by checking if the trimmed line starts with
 * `//`, `*`, or `/*` (best-effort; covers all common JS comment forms).
 *
 * Tests:
 *   1. No code-literal occurrences of the package name in runtime files
 *      (outside the identity module itself).
 *   2. PACKAGE_NAME exported from the identity module equals package.json name.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LITERAL = '@opengsd/gsd-core';
const IDENTITY_MODULE = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs');

// Files to scan: bin/install.js + everything under gsd-core/bin/ + touched scripts
function getRuntimeFiles() {
  const files = [];

  // bin/install.js
  const installJs = path.join(ROOT, 'bin', 'install.js');
  if (fs.existsSync(installJs)) files.push(installJs);

  // gsd-core/bin/**/*.cjs and *.js (recursive)
  function collectDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectDir(fullPath);
      } else if (entry.isFile() && /\.(cjs|js)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  collectDir(path.join(ROOT, 'gsd-core', 'bin'));

  // scripts/*.cjs
  for (const entry of fs.readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      files.push(path.join(ROOT, 'scripts', entry.name));
    }
  }
  // scripts/changeset/*.cjs
  const changesetDir = path.join(ROOT, 'scripts', 'changeset');
  if (fs.existsSync(changesetDir)) {
    for (const entry of fs.readdirSync(changesetDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.cjs')) {
        files.push(path.join(changesetDir, entry.name));
      }
    }
  }

  return files;
}

function isCommentLine(trimmed) {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

test('no hardcoded @opengsd/gsd-core literals in runtime non-comment code lines (#516)', () => {
  const files = getRuntimeFiles();
  const violations = [];

  for (const file of files) {
    // Skip the identity module itself — it legitimately contains the literal
    if (path.resolve(file) === path.resolve(IDENTITY_MODULE)) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(LITERAL)) continue;
      const trimmed = line.trimStart();
      if (isCommentLine(trimmed)) continue;
      violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found ${violations.length} hardcoded @opengsd/gsd-core literal(s) in non-comment code lines:\n` +
    violations.map(v => `  ${v}`).join('\n') +
    '\n\nReplace each with the PACKAGE_NAME imported from gsd-core/bin/lib/package-identity.cjs'
  );
});

test('PACKAGE_NAME from identity module matches package.json name (#516)', () => {
  const { PACKAGE_NAME } = require('../gsd-core/bin/lib/package-identity.cjs');
  const pkgJson = require('../package.json');
  assert.equal(
    PACKAGE_NAME,
    pkgJson.name,
    `Identity module PACKAGE_NAME (${PACKAGE_NAME}) must equal package.json name (${pkgJson.name})`
  );
});
