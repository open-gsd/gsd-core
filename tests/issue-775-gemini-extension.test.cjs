'use strict';

/**
 * Regression tests for issue #775: additive Gemini CLI extension manifest.
 *
 * Asserts structural and semantic correctness of the Gemini Extension Package:
 *   gemini-extension.json  — extension manifest (consumed by
 *                            `gemini extensions install <git-url>`)
 *   GEMINI.md              — the extension's context-file payload, referenced
 *                            by the manifest's `contextFileName` field.
 *
 * This mirrors tests/issue-766-plugin-manifest.test.cjs (the parallel Claude
 * Code plugin manifest) — the Gemini extension is the same artifact-surface
 * projection onto Gemini CLI's package contract.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const identity = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs'));
const pkg = require(path.join(ROOT, 'package.json'));

const MANIFEST_PATH = path.join(ROOT, 'gemini-extension.json');

// ─── Section A: gemini-extension.json ────────────────────────────────────────
describe('A: gemini-extension.json', () => {

  let manifest;

  test('exists and is valid JSON', () => {
    assert.ok(fs.existsSync(MANIFEST_PATH), 'gemini-extension.json must exist at repo root');
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    manifest = JSON.parse(raw); // throws on invalid JSON
    assert.ok(typeof manifest === 'object' && manifest !== null, 'manifest must be a JSON object');
  });

  test('name equals identity.binName ("gsd-core")', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.name, identity.binName, `name should be "${identity.binName}"`);
  });

  test('name is lowercase/dashes only (Gemini extension naming rule)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    // Gemini reference: "lowercase or numbers and use dashes instead of
    // underscores or spaces".
    assert.match(
      manifest.name,
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'name must be lowercase letters/numbers with dashes (no underscores, spaces, or uppercase)'
    );
  });

  test('version is a non-empty string matching package.json version', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(
      manifest.version,
      pkg.version,
      `gemini-extension.json version (${manifest.version}) must match package.json version (${pkg.version}). ` +
      `When bumping the package version, update gemini-extension.json \`version\` to match — ` +
      `Gemini CLI's \`gemini extensions update\` keys off the manifest version field. (#775)`
    );
  });

  test('description is a non-empty string (required by Gemini manifest schema)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(
      typeof manifest.description === 'string' && manifest.description.trim().length > 0,
      'description must be a non-empty string'
    );
  });

  test('contextFileName points to an existing repo-root file', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.contextFileName, 'GEMINI.md', 'contextFileName must be "GEMINI.md"');
    const ctx = path.join(ROOT, manifest.contextFileName);
    assert.ok(fs.existsSync(ctx), `context file must exist on disk: ${ctx}`);
    const body = fs.readFileSync(ctx, 'utf-8');
    assert.ok(body.trim().length > 0, 'context file must be non-empty');
  });

  test('only declares schema-known top-level keys', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    // Per Gemini extension reference. We intentionally ship the minimal
    // context-loading subset; this guards against typos / unknown keys that
    // would fail `gemini extensions install` manifest validation.
    const ALLOWED = new Set([
      'name', 'version', 'description', 'contextFileName',
      'mcpServers', 'excludeTools', 'migratedTo', 'plan', 'settings', 'themes',
    ]);
    for (const key of Object.keys(manifest)) {
      assert.ok(ALLOWED.has(key), `Unknown top-level manifest key "${key}" is not in the Gemini extension schema`);
    }
  });

  test('does not declare mcpServers (gsd-core ships no MCP server)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest, 'mcpServers'),
      'manifest must NOT declare mcpServers — gsd-core has no MCP server'
    );
  });
});

// ─── Section B: package publication ──────────────────────────────────────────
describe('B: package.json publication', () => {

  test('files[] includes gemini-extension.json and GEMINI.md', () => {
    const files = pkg.files || [];
    for (const required of ['gemini-extension.json', 'GEMINI.md']) {
      assert.ok(
        files.includes(required),
        `package.json "files" must include "${required}" so it ships to npm consumers`
      );
    }
  });
});
