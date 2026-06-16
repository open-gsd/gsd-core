'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  canonicalizeRuntimeName,
  resolveRuntimeNameFromCandidates,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

describe('runtime-name-policy canonical runtime ids', () => {
  test('canonicalizes Kimi without adding extra aliases', () => {
    assert.strictEqual(canonicalizeRuntimeName('kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName(' KIMI '), 'kimi');
    assert.strictEqual(resolveRuntimeNameFromCandidates('', null, 'kimi'), 'kimi');
    assert.strictEqual(canonicalizeRuntimeName('kimi-cli'), null);
  });

  test('canonicalizes devin-desktop to windsurf (#792)', () => {
    assert.strictEqual(canonicalizeRuntimeName('devin-desktop'), 'windsurf');
    assert.strictEqual(canonicalizeRuntimeName('DEVIN-DESKTOP'), 'windsurf');
    assert.strictEqual(resolveRuntimeNameFromCandidates('devin-desktop'), 'windsurf');
  });
});

describe('runtime-name-policy windsurf alias parity — manifest vs FALLBACK_ALIASES (#792)', () => {
  // DEFECT.GENERATIVE-FIX: manifest and FALLBACK_ALIASES are manually mirrored;
  // this test fails if they diverge for the windsurf key.
  const manifestPath = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'runtime-aliases.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  test('manifest windsurf array includes devin-desktop', () => {
    assert.ok(
      Array.isArray(manifest.windsurf) && manifest.windsurf.includes('devin-desktop'),
      `runtime-aliases.manifest.json windsurf array must include 'devin-desktop'; got: ${JSON.stringify(manifest.windsurf)}`,
    );
  });

  test('FALLBACK_ALIASES windsurf includes devin-desktop (via canonicalization round-trip)', () => {
    // The built module merges manifest over FALLBACK_ALIASES; if the manifest is present
    // this verifies the combined set. The manifest test above separately guards the manifest.
    // Here we verify the live canonicalizer sees devin-desktop -> windsurf.
    assert.strictEqual(
      canonicalizeRuntimeName('devin-desktop'),
      'windsurf',
      'devin-desktop must resolve to windsurf via alias lookup',
    );
  });

  test('manifest and FALLBACK_ALIASES windsurf alias sets are identical', () => {
    // Read FALLBACK_ALIASES from source to detect manual drift before a build.
    const srcPath = path.join(ROOT, 'src', 'runtime-name-policy.cts');
    // allow-test-rule: runtime-contract-is-the-product — FALLBACK_ALIASES source text IS the
    // product contract for runtimes that can't load the manifest at runtime; verifying
    // both surfaces contain the same windsurf aliases catches manual-mirror drift.
    const src = fs.readFileSync(srcPath, 'utf8');
    const match = src.match(/windsurf:\s*\[([^\]]+)\]/);
    assert.ok(match, 'FALLBACK_ALIASES windsurf row must exist in src/runtime-name-policy.cts');
    const srcAliases = match[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const manifestAliases = [...manifest.windsurf].sort();
    assert.deepStrictEqual(
      [...srcAliases].sort(),
      manifestAliases,
      `FALLBACK_ALIASES windsurf=${JSON.stringify(srcAliases.sort())} must match manifest windsurf=${JSON.stringify(manifestAliases)}`,
    );
  });
});
