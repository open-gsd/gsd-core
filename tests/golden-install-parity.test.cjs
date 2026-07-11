'use strict';

/**
 * golden-install-parity.test.cjs — ADR-1239 Phase B safety-net harness.
 *
 * Captures a byte-stable manifest of every file emitted by the installer for
 * all 16 runtimes, so a later PR moving installRuntimeArtifacts can prove
 * byte-identical output parity.
 *
 * ## Determinism invariants (empirically established pre-Phase-B)
 *
 * After replacing every occurrence of the temp root path with the literal
 * '<HOME>' in file contents, the install output is byte-identical run-to-run
 * for ALL files EXCEPT the volatile metadata files that are EXCLUDED
 * from the parity manifest:
 *   - gsd-file-manifest.json    (timestamp + install-time absolute paths)
 *   - gsd-install-state.json    (install-time absolute paths)
 *   - .gsd-source               (#1477, claude-global: install-time source path)
 *
 * Everything else (≈545–616 files per runtime) is deterministic.
 *
 * ## UPDATE mode
 *
 * Run with UPDATE_GOLDEN=1 to (re-)capture fixtures:
 *   UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');
const { walk, RUNTIME_META, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

// hooks/dist is gitignored and built (DEFECT.HOOKS-DIST-SCOPED-CI). The scoped
// CI test lane does not run build:hooks, so a real install there emits no hooks/
// dir — making the golden (captured with hooks built) report "removed (N) hooks/…".
// Build it idempotently here so the harness is lane-independent (mirrors the
// pattern in bug-1834-sh-hooks-installed and install-minimal-hooks).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

const UPDATE = process.env.UPDATE_GOLDEN === '1';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'golden-install-parity');

// Volatile metadata files always excluded from the parity manifest.
// .gsd-source (#1477, claude-global only) records the install-time absolute path
// to the package's commands/gsd source tree, which is the checkout/CI workspace
// path — NOT the temp HOME root, so it is never normalized to '<HOME>' and its
// hash varies by environment. Excluded for the same reason as gsd-install-state.json.
// gsd-core/CHANGELOG.md is excluded because it contains historical version strings
// that cause hash drift between local (PKG_VERSION=1.x.x) and CI (PKG_VERSION=1.x.x-rc.N):
// the PKG_VERSION normalization below replaces only the *current* version, but
// CHANGELOG.md references prior-release versions, so the normalized hash diverges.
const VOLATILE_FILES = new Set([
  'gsd-file-manifest.json',
  'gsd-install-state.json',
  '.gsd-source',
  'gsd-core/CHANGELOG.md',
]);

// The installed package version, normalized to '<VERSION>' in hash computation so
// the golden is stable across version bumps (the rc step runs `npm version X.Y.Z-rc.N`
// before tests, which rebakes the version into hook files and gsd-core/VERSION).
const PKG_VERSION = require('../package.json').version;

// Hook-registration config files excluded from the parity manifest. These are
// written by the hook/permission install path (applySettingsJsonHooks /
// finishInstall) — NOT by installRuntimeArtifacts, so they are outside the scope
// of the engine deep-move this harness guards. They also embed the resolved
// node-runner invocation, whose FORM (absolute-quoted "/abs/bin/node" on macOS
// vs bare `node` resolved from PATH on Linux/CI) — not just the binary path —
// varies by platform and cannot be normalized to a single sentinel reliably.
// Their content is asserted directly by the dedicated hook tests
// (install-minimal-hooks, sh-hook-paths, codex-config, etc.). Matched by basename.
// settings.json = Claude/Antigravity/Augment/etc. hook surface; hooks.json =
// Codex/Cursor hook surface — both embed the platform-varying node-runner command.
// settings.local.json = Claude LOCAL hook surface (#338): same platform-varying
// node-runner command as settings.json, so excluded for the same reason (#2086).
const HOOK_CONFIG_FILES = new Set(['settings.json', 'settings.local.json', 'hooks.json']);

// Kimi's native config.toml (#2095 EoS/kimi Upgrade 1) embeds the same
// platform-varying node-runner command as the HOOK_CONFIG_FILES above (via the
// same buildHookCommand/projectManagedHookCommand machinery), so it needs the
// same exclusion — but it is NOT matched by basename like HOOK_CONFIG_FILES:
// Codex's OWN config.toml (installSurface 'codex-toml') is a stable, tracked
// top-level `config.toml` entry in its golden fixture (it only ever gets a
// platform-stable `[features] hooks = true` flag — the real hook commands
// live in Codex's separate hooks.json, already excluded above). Blanket-
// excluding the 'config.toml' basename would silently blind Codex's fixture
// to any future regression there. Kimi's config.toml instead lives OUTSIDE
// its GSD configDir at runtime (resolveKimiHooksTomlDir resolves ~/.kimi, a
// sibling of the configDir ~/.config/agents) — it only appears inside this
// harness's walked tree at all because runMinimalInstall sets HOME to the
// same temp root used as --config-dir, collapsing the two into one directory
// for the isolated test run. So it is excluded by its exact relative path
// under that collapsed root, not by basename.
const HOOK_CONFIG_RELATIVE_PATHS = new Set(['.kimi/config.toml']);

// Path prefixes excluded from the parity manifest. `gsd-core/bin/lib/` holds the
// tsc-built runtime artifacts (compiled from src/*.cts) that the install COPIES
// verbatim — they are NOT produced by installRuntimeArtifacts (the move's parity
// scope), and their exact bytes depend on the BUILD environment (a clean tsc
// build vs a stale incremental one yields different output for unchanged sources).
// Including them made the golden non-portable: CI's clean build legitimately
// differs from a local incremental build for modules the PR never touched
// (e.g. milestone.cjs, roadmap.cjs). The .cts sources are type-checked + drift-
// guarded + coverage-gated elsewhere; this harness asserts the CONVERTED artifact
// output (skills/commands/agents) that the engine actually emits.
const EXCLUDED_PREFIXES = ['gsd-core/bin/lib/'];

/**
 * Build a deterministic hash-map of all non-volatile files under configDir.
 *
 * For each file:
 *   - rel  = POSIX-slash relative path from configDir
 *   - hash = sha256(content with root replaced by '<HOME>').slice(0,16)
 *
 * Returns a plain object with sorted keys for stable JSON comparison.
 *
 * @param {string} configDir - absolute path to the installed runtime config dir
 * @param {string} root      - temp root path to replace with '<HOME>'
 * @returns {{ [rel: string]: string }}
 */
function buildParityManifest(configDir, root) {
  const allFiles = walk(configDir);
  const unsorted = {};

  // The claude LOCAL install resolves its config dir via realpath, which on macOS
  // prepends `/private` to the temp root (`/var/folders/…` -> `/private/var/folders/…`)
  // and embeds that resolved path in the projected agents/commands/workflows (`@…`
  // references). On Linux the temp root has no `/private` symlink, so normalizing
  // ONLY `root` left the `/private` prefix on macOS and produced platform-divergent
  // hashes (#2086). Normalize the realpath form FIRST (it is the longer, `/private`-
  // prefixed string) so both platforms collapse to `<HOME>`. No-op for the global
  // fixtures (global install uses the literal `--config-dir`, never realpath-resolved).
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* root already gone / not resolvable */ }

  for (const full of allFiles) {
    // Build POSIX-style relative path for cross-platform stability
    const rel = path.relative(configDir, full).split(path.sep).join('/');

    if (VOLATILE_FILES.has(rel)) continue;
    if (HOOK_CONFIG_FILES.has(path.basename(rel))) continue;
    if (HOOK_CONFIG_RELATIVE_PATHS.has(rel)) continue;
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;

    const content = fs.readFileSync(full);
    // Normalize every occurrence of the temp root so hashes are stable across runs.
    // Also normalize the package version so the golden survives `npm version` bumps
    // (the rc release step bakes the new version into hook files before running tests).
    const normalized = content.toString('utf8')
      .split(realRoot).join('<HOME>')
      .split(root).join('<HOME>')
      .split(PKG_VERSION).join('<VERSION>');
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    unsorted[rel] = hash;
  }

  // Reconstruct with sorted keys for stable JSON serialisation
  const sorted = {};
  for (const key of Object.keys(unsorted).sort()) {
    sorted[key] = unsorted[key];
  }
  return sorted;
}

// Ensure the fixture directory exists (needed for UPDATE mode)
if (UPDATE) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
}

const runtimes = Object.keys(RUNTIME_META);

for (const runtime of runtimes) {
  test(`golden parity — ${runtime}`, async (t) => {
    if (process.platform === 'win32') {
      t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
      return;
    }
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    let actual;
    try {
      actual = buildParityManifest(configDir, root);
    } finally {
      cleanup(root);
    }

    const fixturePath = path.join(FIXTURE_DIR, `${runtime}.json`);

    if (UPDATE) {
      fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      const fileCount = Object.keys(actual).length;
      // Report to stdout so the capture run is self-documenting
      process.stdout.write(`  [UPDATE] ${runtime}: wrote ${fileCount} file hashes → ${fixturePath}\n`);
      return;
    }

    // Assert mode: compare against golden fixture
    if (!fs.existsSync(fixturePath)) {
      assert.fail(
        `Golden fixture missing for runtime '${runtime}': ${fixturePath}\n` +
        'Run UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs to capture.'
      );
    }

    const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const goldenKeys = new Set(Object.keys(golden));
    const actualKeys = new Set(Object.keys(actual));

    const added   = [...actualKeys].filter(k => !goldenKeys.has(k));
    const removed = [...goldenKeys].filter(k => !actualKeys.has(k));
    const changed = [...actualKeys].filter(k => goldenKeys.has(k) && actual[k] !== golden[k]);

    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      const lines = [`Parity mismatch for runtime '${runtime}':`];
      if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
      if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
      if (changed.length) lines.push(`  changed (${changed.length}): ${changed.join(', ')}`);
      lines.push('Run UPDATE_GOLDEN=1 to recapture if the change is intentional.');
      assert.deepEqual(actual, golden, lines.join('\n'));
    }
  });
}

// #2086 (EoS/claude): claude is the reference host and the ONLY runtime with a
// distinct LOCAL "legacy flat-commands" layout (commands/gsd-*.md + agents/gsd-*.md).
// The loop above asserts the GLOBAL skills layout; this asserts the LOCAL
// commands/agents layout is byte-identical too, so folding claude's
// `runtime === 'claude'` branches into descriptor-driven hostBehaviors cannot
// silently change the local install output (AC1: "both scopes"). NOTE: the
// settings.local.json ROUTING itself is excluded here (platform-varying node-runner
// path) — that dimension is covered directly by install.test.cjs's #338 suite.
test('golden parity — claude (local legacy layout)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('install output is platform-specific on Windows (backslash paths); parity is asserted on macOS + Linux');
    return;
  }
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'local' });
  let actual;
  try {
    actual = buildParityManifest(configDir, root);
  } finally {
    cleanup(root);
  }

  const fixturePath = path.join(FIXTURE_DIR, 'claude-local.json');

  if (UPDATE) {
    fs.writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    process.stdout.write(`  [UPDATE] claude-local: wrote ${Object.keys(actual).length} file hashes → ${fixturePath}\n`);
    return;
  }

  if (!fs.existsSync(fixturePath)) {
    assert.fail(
      `Golden fixture missing for claude-local: ${fixturePath}\n` +
      'Run UPDATE_GOLDEN=1 node --test tests/golden-install-parity.test.cjs to capture.',
    );
  }

  const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const added   = Object.keys(actual).filter(k => !(k in golden));
  const removed = Object.keys(golden).filter(k => !(k in actual));
  const changed = Object.keys(actual).filter(k => k in golden && actual[k] !== golden[k]);
  if (added.length || removed.length || changed.length) {
    const lines = ['Parity mismatch for claude-local:'];
    if (added.length)   lines.push(`  added   (${added.length}): ${added.join(', ')}`);
    if (removed.length) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);
    if (changed.length) lines.push(`  changed (${changed.length}): ${changed.join(', ')}`);
    lines.push('Run UPDATE_GOLDEN=1 to recapture if the change is intentional.');
    assert.deepEqual(actual, golden, lines.join('\n'));
  }
});
