/**
 * Regression test for bug #384 — getAgentsDir() is runtime-blind.
 *
 * Before the fix, getAgentsDir() always resolved to the Claude path
 * (~/.claude/agents) regardless of the active runtime, so on an OpenCode
 * install checkAgentsInstalled() always returned agents_installed=false and
 * agent_runtime was not surfaced at all.
 *
 * After the fix:
 *  - GSD_RUNTIME=opencode + OPENCODE_CONFIG_DIR pointing at a temp dir →
 *    agents_installed=true, agent_runtime='opencode', agents_dir under the
 *    opencode config dir
 *  - No GSD_RUNTIME + GSD_AGENTS_DIR pointing at a temp dir →
 *    agents_installed=true, agent_runtime='claude'
 *  - GSD_RUNTIME=opencode but agents dir empty →
 *    agents_installed=false, agent_runtime='opencode'
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const MODEL_PROFILES = require('../get-shit-done/bin/lib/model-profiles.cjs').MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

/**
 * Create an agents directory under configDir/agents and populate it with
 * the expected agent .md files.
 */
function createAgentsInConfigDir(configDir) {
  const agentsDir = path.join(configDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of EXPECTED_AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\ncolor: cyan\n---\nAgent content.\n`
    );
  }
  return agentsDir;
}

describe('bug #384 — getAgentsDir() is runtime-aware', () => {
  let tmpDir;
  let opencodeConfigDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Separate temp dir to act as the opencode global config dir
    opencodeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-opencode-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
    fs.rmSync(opencodeConfigDir, { recursive: true, force: true });
  });

  // ── Test 1: opencode runtime resolves the opencode agents path ──────────────

  test('GSD_RUNTIME=opencode finds agents under OPENCODE_CONFIG_DIR/agents', () => {
    // Place agents under the opencode config dir that getGlobalConfigDir('opencode')
    // will return when OPENCODE_CONFIG_DIR is set.
    const agentsDir = createAgentsInConfigDir(opencodeConfigDir);

    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_RUNTIME: 'opencode',
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
        // Ensure the process HOME does NOT have a conflicting ~/.claude/agents
        // that might accidentally produce a false positive via GSD_AGENTS_DIR
        // (we must NOT set GSD_AGENTS_DIR here — the whole point is that the fix
        // uses the runtime-aware path without needing GSD_AGENTS_DIR).
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, true,
      `agents_installed must be true when agents exist under OPENCODE_CONFIG_DIR/agents. ` +
      `agents_dir=${output.agents_dir}, agent_runtime=${output.agent_runtime}`);

    assert.strictEqual(output.agent_runtime, 'opencode',
      'agent_runtime must be "opencode" when GSD_RUNTIME=opencode');

    assert.strictEqual(output.agents_dir, agentsDir,
      `agents_dir must point at the opencode agents dir (${agentsDir}), got: ${output.agents_dir}`);
  });

  // ── Test 2: claude fallback via GSD_AGENTS_DIR ──────────────────────────────

  test('default runtime (no GSD_RUNTIME) with GSD_AGENTS_DIR → agents_installed=true, agent_runtime=claude', () => {
    // Classic GSD_AGENTS_DIR override: no runtime set, use the env shortcut
    const agentsDir = path.join(tmpDir, 'claude-agents');
    createAgentsInConfigDir(tmpDir);
    // GSD_AGENTS_DIR points directly at the agents dir (not the config dir)
    const directAgentsDir = path.join(tmpDir, 'agents');

    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_AGENTS_DIR: directAgentsDir,
        // Explicitly unset GSD_RUNTIME so no runtime override applies
        GSD_RUNTIME: '',
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, true,
      `agents_installed must be true when GSD_AGENTS_DIR points at a populated agents dir. ` +
      `agents_dir=${output.agents_dir}`);

    assert.strictEqual(output.agent_runtime, 'claude',
      'agent_runtime must be "claude" when no GSD_RUNTIME is set');

    assert.strictEqual(output.agents_dir, directAgentsDir,
      `agents_dir must match GSD_AGENTS_DIR override`);
  });

  // ── Test 3 (negative): opencode runtime, empty agents dir ───────────────────

  test('GSD_RUNTIME=opencode with empty agents dir → agents_installed=false, agent_runtime still surfaced', () => {
    // Create the opencode config dir but leave agents/ empty (no files)
    const emptyAgentsDir = path.join(opencodeConfigDir, 'agents');
    fs.mkdirSync(emptyAgentsDir, { recursive: true });

    const result = runGsdTools(
      ['init', 'quick', 'test description', '--raw'],
      tmpDir,
      {
        GSD_RUNTIME: 'opencode',
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
      }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    assert.strictEqual(output.agents_installed, false,
      'agents_installed must be false when agents dir is empty');

    assert.strictEqual(output.agent_runtime, 'opencode',
      'agent_runtime must still be surfaced even when agents are missing');
  });
});
