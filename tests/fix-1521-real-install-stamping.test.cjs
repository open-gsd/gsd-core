'use strict';
/**
 * E2E regression tests for #1521: real install path (copyWithPathReplacement)
 * MUST stamp non-Claude runtime defaults into emitted gsd-core/workflows/*.md.
 *
 * The earlier unit tests in fix-1521-non-claude-runtime-default-resolution.test.cjs
 * only verify the engine (_applyRuntimeRewrites). This test verifies the wiring:
 * that a REAL `node bin/install.js --codex/--cursor --global` actually emits
 * execute-phase.md with --default codex / --default cursor (not --default claude).
 *
 * Root cause: copyWithPathReplacement is the emit path for gsd-core/workflows/*.md;
 * it did its own inline path rewrites but never called _stampNonClaudeRuntimeDefaults,
 * so the stamping was dead-on-arrival in real installs.
 *
 * This test must be RED before the fix is applied (Step 1) and GREEN after (Step 2).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const INSTALL = path.join(__dirname, '..', 'bin', 'install.js');

/**
 * Run a real install into a temp config dir and return the emitted
 * execute-phase.md content.
 * @param {string} runtime  e.g. 'codex', 'cursor', 'claude'
 * @returns {string}
 */
function installAndRead(runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-inst-${runtime}-`));
  const res = spawnSync(
    process.execPath,
    [INSTALL, `--${runtime}`, '--global', '--config-dir', dir],
    { encoding: 'utf8', timeout: 120000 },
  );
  assert.strictEqual(res.status, 0, `install --${runtime} failed: ${res.stderr || res.stdout}`);
  const wf = path.join(dir, 'gsd-core', 'workflows', 'execute-phase.md');
  assert.ok(fs.existsSync(wf), `emitted workflow missing for ${runtime}: ${wf}`);
  const content = fs.readFileSync(wf, 'utf8');
  cleanup(dir);
  return content;
}

// ---------------------------------------------------------------------------
// RED tests: these MUST FAIL before the copyWithPathReplacement wiring is added
// ---------------------------------------------------------------------------

test('real install: codex-emitted execute-phase.md resolves runtime=codex and defaults worktrees off (#1521)', () => {
  const c = installAndRead('codex');
  assert.ok(
    c.includes('config-get runtime --default codex --raw'),
    'codex runtime default not stamped in real install',
  );
  assert.ok(
    c.includes('config-get workflow.use_worktrees --default false --raw'),
    'codex use_worktrees not defaulted false in real install',
  );
  assert.ok(
    !c.includes('config-get runtime --default claude --raw'),
    'residual claude default in codex install',
  );
});

test('real install: cursor-emitted execute-phase.md resolves runtime=cursor (#1521)', () => {
  const c = installAndRead('cursor');
  assert.ok(
    c.includes('config-get runtime --default cursor --raw'),
    'cursor runtime default not stamped in real install',
  );
  assert.ok(
    !c.includes('config-get runtime --default claude --raw'),
    'residual claude default in cursor install',
  );
});

test('real install: claude-emitted execute-phase.md keeps claude default + worktrees on (#1521)', () => {
  const c = installAndRead('claude');
  assert.ok(
    c.includes('config-get runtime --default claude --raw'),
    'claude default changed in claude install',
  );
  assert.ok(
    c.includes('config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"'),
    'claude worktrees default changed (should still be true)',
  );
  assert.ok(
    !c.includes('config-get workflow.use_worktrees --default false --raw'),
    'claude install must NOT have use_worktrees=false stamped',
  );
});
