'use strict';

/**
 * Declarative reference host — Antigravity (#1682 Slice 2 / ADR-1239 Phase D).
 *
 * Locks in Antigravity as the Declarative-CLI reference host driven through the
 * PUBLIC Host-Integration Interface (the declarative adapter), per #1682 AC:
 *   "invoke a gsd command in the Declarative-CLI reference host (Antigravity)
 *    driven by the embedded engine through the public interface, golden-parity
 *    vs Claude."
 *
 * Byte-identity of adapter output vs today's install is gated globally by
 * golden-install-parity (all 16 runtimes) + adapter-declarative-equivalence.
 * THIS test is the reference-host dogfood: it (1) classifies Antigravity's
 * profile via profileOf, (2) confirms the public adapter classifies it as
 * declarative, and (3) round-trips a real install proving a gsd command surface
 * is emitted through the same engine the adapter delegates to.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { profileOf } = require('../gsd-core/bin/lib/host-integration.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'antigravity', 'capability.json');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

test('Antigravity classifies as the declarative-cli reference profile (profileOf)', () => {
  const desc = JSON.parse(fs.readFileSync(DESC, 'utf8'));
  const axes = desc.runtime.hostIntegration;
  assert.ok(axes && axes.embeddingMode, 'antigravity descriptor declares hostIntegration axes');
  assert.equal(profileOf(axes), 'declarative-cli',
    'Antigravity is the Declarative-CLI reference host');
});

test('the public declarative adapter classifies Antigravity as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'antigravity' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'antigravity');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Antigravity install emits a gsd command/skill surface (invocable)', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'antigravity', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');
    // Antigravity uses the nested gsd-ns-* router skill layout as its command
    // surface (CONTEXT.md installer module). Assert a gsd skill/router is present.
    const gsdSurface = files.filter((f) => /gsd/i.test(path.relative(configDir, f)));
    assert.ok(gsdSurface.length > 0,
      'install must emit a gsd command/skill surface (declarative reference)');
  } finally {
    cleanup(root);
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3608-antigravity-update-runtime-classification.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3608-antigravity-update-runtime-classification (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #3608: /gsd:update must model Antigravity as a first-class runtime, so an
 * Antigravity install (~/.gemini/antigravity*) is not misclassified as base
 * Gemini.
 *
 * The installer (bin/install.js) and SDK already treat Antigravity as a distinct
 * runtime with its own config dirs, env var (ANTIGRAVITY_CONFIG_DIR), and CLI
 * flag (--antigravity). The update flow must agree.
 *
 * Relocation (#498): the update flow's runtime/scope detection moved out of
 * ~280 lines of inline bash in update.md into the tested projection
 * `gsd-core/bin/lib/update-context.cjs` (resolveUpdateContext). The
 * antigravity-first-class contract now lives there as data + behavior, so this
 * test asserts it on the projection. The only piece still authored in update.md
 * is the execution_context path classification (prose the agent applies), which
 * this test still checks for antigravity-before-gemini ordering.
 *
 * Order matters: every probe list / env ladder that contains a Gemini entry
 * MUST place the more-specific Antigravity entry first, else an install with
 * both signals present falls through to gemini.
 */

'use strict';
process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  RUNTIME_DIRS,
  inferPreferredRuntime,
  envRuntimeDirs,
  resolveUpdateContext,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'));
const UPDATE_MD = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');

function runtimeOrder() {
  return RUNTIME_DIRS.map(([rt]) => rt);
}
function firstIndex(arr, token) {
  return arr.indexOf(token);
}

describe('bug #3608 / #498: update-context models Antigravity as a first-class runtime', () => {
  test('RUNTIME_DIRS lists antigravity before gemini', () => {
    const order = runtimeOrder();
    const antIdx = firstIndex(order, 'antigravity');
    const gemIdx = firstIndex(order, 'gemini');
    assert.notStrictEqual(antIdx, -1, 'RUNTIME_DIRS missing antigravity');
    assert.notStrictEqual(gemIdx, -1, 'RUNTIME_DIRS missing gemini');
    assert.ok(antIdx < gemIdx, `antigravity (@${antIdx}) must precede gemini (@${gemIdx}) — first match wins`);
  });

  test('RUNTIME_DIRS includes antigravity 2.x (ide/cli) + legacy dirs', () => {
    const dirs = RUNTIME_DIRS.filter(([rt]) => rt === 'antigravity').map(([, d]) => d);
    assert.ok(dirs.includes('.gemini/antigravity-ide'), 'missing .gemini/antigravity-ide');
    assert.ok(dirs.includes('.gemini/antigravity-cli'), 'missing .gemini/antigravity-cli');
    assert.ok(dirs.includes('.gemini/antigravity'), 'missing legacy .gemini/antigravity fallback');
    // All antigravity dirs precede the .gemini probe.
    const order = RUNTIME_DIRS.map(([, d]) => d);
    const gemIdx = order.indexOf('.gemini');
    for (const d of dirs) {
      assert.ok(order.indexOf(d) < gemIdx, `${d} must precede .gemini in the probe order`);
    }
  });

  test('env inference recognizes ANTIGRAVITY_CONFIG_DIR before GEMINI_CONFIG_DIR', () => {
    const rt = inferPreferredRuntime({
      fs: { exists: () => false },
      env: { ANTIGRAVITY_CONFIG_DIR: '/x', GEMINI_CONFIG_DIR: '/y' },
      preferredConfigDir: '',
    });
    assert.equal(rt, 'antigravity', 'both env vars set must resolve to antigravity, not gemini');
  });

  test('envRuntimeDirs emits an antigravity entry (before gemini) when ANTIGRAVITY_CONFIG_DIR is set', () => {
    const entries = envRuntimeDirs({ env: { ANTIGRAVITY_CONFIG_DIR: '/x/ag', GEMINI_CONFIG_DIR: '/x/gem' }, home: '/home/u' });
    const order = entries.map(([rt]) => rt);
    assert.ok(order.includes('antigravity'), 'expected an antigravity env candidate');
    assert.ok(order.indexOf('antigravity') < order.indexOf('gemini'), 'antigravity env candidate must precede gemini');
  });

  test('behavioral: an Antigravity install resolves to runtime "antigravity", not "gemini"', () => {
    // Normalize paths so the fake fs matches the resolver's path.join/resolve
    // lookups on Windows (backslash + drive) as well as POSIX.
    const normKey = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const HOME = '/home/u';
    const agDir = path.join(HOME, '.gemini', 'antigravity');
    const verFile = normKey(path.join(agDir, 'gsd-core', 'VERSION'));
    const markerFile = normKey(path.join(agDir, 'gsd-core', 'workflows', 'update.md'));
    const fakeFs = {
      exists: (p) => normKey(p) === verFile || normKey(p) === markerFile,
      readFile: (p) => (normKey(p) === verFile ? '1.40.0\n' : null),
    };
    const r = resolveUpdateContext({ home: HOME, cwd: path.resolve('/work'), env: {}, fs: fakeFs });
    assert.equal(r.runtime, 'antigravity');
    assert.equal(normKey(r.gsdDir), normKey(agDir));
  });

  test('update.md execution_context classification still lists antigravity paths before /.gemini/', () => {
    const content = fs.readFileSync(UPDATE_MD, 'utf-8');
    const antIde = content.indexOf('/.gemini/antigravity-ide/');
    const gemBare = content.indexOf('`/.gemini/` -> `gemini`');
    assert.notStrictEqual(antIde, -1, 'update.md must document the antigravity-ide execution_context path');
    assert.notStrictEqual(gemBare, -1, 'update.md must document the bare /.gemini/ -> gemini classification');
    assert.ok(antIde < gemBare, 'antigravity path classification must precede the bare /.gemini/ rule');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-503-update-agent-antigravity-detection.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-503-update-agent-antigravity-detection (consolidation epic #1969 B3 #1972)", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

// allow-test-rule: source-text-is-the-product (see #503)
// update.md's embedded classifier + cache-clear loop are workflow text the
// runtime loads and executes, so asserting on that text tests deployed
// behavior. The runtime/scope detection cascade itself moved out of inline
// bash into the update-context projection (issue #498), so the core guarantee
// is exercised behaviorally against resolveUpdateContext rather than by
// matching a `RUNTIME_DIRS=(...)` literal that no longer lives in update.md.
// Per CONTRIBUTING.md exception matrix.

/**
 * Bug #503: /gsd:update misclassifies local Antigravity (.agent) installs as claude
 *
 * The installer places a LOCAL Antigravity install in ./.agent/
 * (bin/install.js: getDirName('antigravity') === '.agent'). The /gsd:update
 * detection cascade must map .agent -> antigravity across three surfaces:
 *   1. the execution_context path classifier (update.md prose),
 *   2. the RUNTIME_DIRS candidate table (now in the update-context projection),
 *   3. the post-update cache-clear `for dir in` loop (update.md).
 *
 * Surface (2) is the original root cause and is now verified behaviorally: a
 * LOCAL .agent install must resolve to the antigravity runtime. Before the fix
 * (.agent absent from RUNTIME_DIRS) it fell through to UNKNOWN/claude.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPDATE_MD = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'update.md'),
  'utf-8',
);
const { resolveUpdateContext } = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'update-context.cjs'),
);

function normKey(p) { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); }
function fakeFs(files) {
  const set = new Map();
  for (const [k, v] of Object.entries(files)) set.set(normKey(k), v);
  return {
    exists: (p) => set.has(normKey(p)),
    readFile: (p) => { const k = normKey(p); return set.has(k) ? set.get(k) : null; },
  };
}

describe('/gsd:update detects local Antigravity (.agent / .agents) installs (#503 / #791)', () => {
  test('projection resolves a LOCAL ./.agents install to the antigravity runtime (#791 canonical)', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentsDir = `${CWD}/.agents`;
    const ffs = fakeFs({
      [`${agentsDir}/gsd-core/VERSION`]: '1.50.0\n',
      [`${agentsDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a local .agents install must map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.50.0');
  });

  test('projection resolves a LOCAL ./.agent install to the antigravity runtime (#503 backward-compat)', () => {
    const HOME = '/home/u';
    const CWD = '/work/proj';
    const agentDir = `${CWD}/.agent`;
    const ffs = fakeFs({
      [`${agentDir}/gsd-core/VERSION`]: '1.40.0\n',
      [`${agentDir}/gsd-core/workflows/update.md`]: 'x',
    });
    const r = resolveUpdateContext({ home: HOME, cwd: CWD, env: {}, fs: ffs });
    assert.equal(
      r.runtime,
      'antigravity',
      `a legacy .agent install must still map to the antigravity runtime, got "${r.runtime}"`,
    );
    assert.equal(r.scope, 'LOCAL');
    assert.equal(r.installedVersion, '1.40.0');
  });

  test('execution_context classifier maps /.agents/ and /.agent/ paths to antigravity (update.md)', () => {
    const hasAgentsClassifierRule =
      /\/\.agents\/[^\r\n]*->[^\r\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentsClassifierRule,
      'update.md classifier must map a `/.agents/` path to the `antigravity` runtime',
    );
    const hasAgentClassifierRule =
      /\/\.agent\/[^\r\n]*->[^\r\n]*antigravity/.test(UPDATE_MD);
    assert.ok(
      hasAgentClassifierRule,
      'update.md classifier must still map a `/.agent/` path to the `antigravity` runtime (backward-compat)',
    );
  });

  test('every runtime-dir `for dir in` loop in update.md includes .agents and .agent', () => {
    // The LOCAL-scope discovery loop moved into the projection (#498); the
    // post-update cache-clear loop remains inline and still enumerates the
    // runtime config dirs as a literal `.claude ... .codex` list, so it must
    // include both .agents (canonical, #791) and .agent (legacy, #503) or
    // stale indicators could linger.
    const runtimeDirLoops = UPDATE_MD
      .split(/\r?\n/)
      .filter((l) => /for dir in .*\.claude.*\.codex/.test(l));
    assert.ok(
      runtimeDirLoops.length >= 1,
      `expected at least 1 runtime-dir loop in update.md, found ${runtimeDirLoops.length}`,
    );
    for (const loop of runtimeDirLoops) {
      assert.ok(
        /(^|\s)\.agents(\s|$)/.test(loop),
        `every runtime-dir loop must include .agents (canonical), got: ${loop.trim()}`,
      );
      assert.ok(
        /(^|\s)\.agent(\s|$)/.test(loop),
        `every runtime-dir loop must include .agent (legacy backward-compat), got: ${loop.trim()}`,
      );
    }
  });
});
  });
}
