'use strict';

/**
 * Regression test for #551 — the ESLint harness (ADR-452) silently excluded 12
 * hand-written `get-shit-done/bin/lib/*.cjs` modules via a `GENERATED_CJS_IGNORES`
 * list mislabeled "Generated bin/lib files — never lint". The files are hand-written
 * (no `@generated` header, no generator emits them), so they belong in the harness.
 *
 * Invariant under test (not just today's file list): a `bin/lib/*.cjs` module must
 * be linted UNLESS it is genuinely generated — i.e. it carries an `@generated`
 * header or has a `src/<name>.cts|.ts` source it is compiled from (ADR-457). This
 * catches the next mislabeled file, not only the original 12.
 *
 * Behavior is checked through ESLint's own `isPathIgnored` API so the test reflects
 * real resolved flat-config precedence, not a textual scan of eslint.config.mjs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'get-shit-done', 'bin', 'lib');

// The 12 modules that #551 restored to lint coverage.
const HAND_WRITTEN = [
  'command-aliases',
  'configuration',
  'decisions',
  'phase-lifecycle',
  'plan-scan',
  'project-root',
  'schema-detect',
  'secrets',
  'state-document',
  'validate',
  'workstream-inventory-builder',
  'workstream-name-policy',
].map((name) => path.join(LIB_DIR, `${name}.cjs`));

function isGenerated(absPath) {
  if (!fs.existsSync(absPath)) return false;
  const head = fs.readFileSync(absPath, 'utf8').slice(0, 500);
  if (/@generated/.test(head)) return true;
  const base = path.basename(absPath, '.cjs');
  return (
    fs.existsSync(path.join(ROOT, 'src', `${base}.cts`)) ||
    fs.existsSync(path.join(ROOT, 'src', `${base}.ts`))
  );
}

let eslint;
before(() => {
  eslint = new ESLint({ cwd: ROOT });
});

describe('#551: ESLint covers hand-written bin/lib/*.cjs', () => {
  for (const file of HAND_WRITTEN) {
    test(`lints ${path.basename(file)} (not ignored)`, async () => {
      assert.equal(
        await eslint.isPathIgnored(file),
        false,
        `${path.relative(ROOT, file)} is hand-written and must be linted, not ignored`,
      );
    });
  }

  test('no hand-written bin/lib/*.cjs is silently ignored', async () => {
    const offenders = [];
    for (const entry of fs.readdirSync(LIB_DIR)) {
      if (!entry.endsWith('.cjs')) continue;
      const abs = path.join(LIB_DIR, entry);
      if (isGenerated(abs)) continue; // legitimately excluded from the harness
      if (await eslint.isPathIgnored(abs)) offenders.push(entry);
    }
    assert.deepEqual(
      offenders,
      [],
      `Hand-written modules silently excluded from ESLint: ${offenders.join(', ')}`,
    );
  });

  test('genuinely tsc-generated semver-compare.cjs stays ignored (ADR-457)', async () => {
    // Publish-time artifact compiled from src/semver-compare.cts; must not be linted.
    const f = path.join(LIB_DIR, 'semver-compare.cjs');
    assert.equal(
      await eslint.isPathIgnored(f),
      true,
      'semver-compare.cjs is a tsc-generated publish-time artifact and must stay ignored',
    );
  });
});
