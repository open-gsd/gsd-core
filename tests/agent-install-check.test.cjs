'use strict';

/**
 * Agent Install Check Module — behaviour tests (#1268 T0, T1 #1277)
 *
 * Seam: gsd-core/bin/lib/agent-install-check.cjs
 * Interface: getAgentsDir, checkAgentsInstalled
 *
 * Verifies:
 *   1. getAgentsDir behaviour: GSD_AGENTS_DIR override, claude path, non-claude path
 *   2. checkAgentsInstalled behaviour against temp dirs via GSD_AGENTS_DIR:
 *      - missing dir → agents_installed:false, missing_agents = all expected
 *      - existing-but-empty dir → installed_agents:[], agents_installed:false
 *      - no manifest → completeness skipped (incomplete_agents empty)
 *      - partial manifest (agent.toml absent, agent.md present) → incomplete_agents includes agent
 *      - malformed manifest → no throw, completeness skipped
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const AGENT_INSTALL_CHECK_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'agent-install-check.cjs'
);
const RUNTIME_HOMES_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'
);

const agentInstallCheck = require(AGENT_INSTALL_CHECK_PATH);
const { getGlobalConfigDir } = require(RUNTIME_HOMES_PATH);

// Get EXPECTED_AGENTS from model-profiles (same source of truth)
const MODEL_PROFILES = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'model-profiles.cjs')).MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

// ─── Environment isolation ────────────────────────────────────────────────────

let savedAgentsDir;
let savedRuntime;

beforeEach(() => {
  savedAgentsDir = process.env['GSD_AGENTS_DIR'];
  savedRuntime = process.env['GSD_RUNTIME'];
  delete process.env['GSD_AGENTS_DIR'];
  delete process.env['GSD_RUNTIME'];
});

afterEach(() => {
  if (savedAgentsDir === undefined) {
    delete process.env['GSD_AGENTS_DIR'];
  } else {
    process.env['GSD_AGENTS_DIR'] = savedAgentsDir;
  }
  if (savedRuntime === undefined) {
    delete process.env['GSD_RUNTIME'];
  } else {
    process.env['GSD_RUNTIME'] = savedRuntime;
  }
});

// ─── 1. getAgentsDir behaviour ────────────────────────────────────────────────

describe('getAgentsDir', () => {
  test('GSD_AGENTS_DIR override takes priority', () => {
    process.env['GSD_AGENTS_DIR'] = '/tmp/x';
    assert.strictEqual(agentInstallCheck.getAgentsDir(), '/tmp/x');
    assert.strictEqual(agentInstallCheck.getAgentsDir('cursor'), '/tmp/x');
  });

  test('claude runtime returns __dirname-relative path', () => {
    const fromModule = agentInstallCheck.getAgentsDir('claude');
    // Should end with /agents
    assert.ok(fromModule.endsWith(path.sep + 'agents') || fromModule.endsWith('/agents'),
      `Expected path to end with /agents, got: ${fromModule}`);
  });

  test('non-claude runtime returns getGlobalConfigDir(runtime)/agents', () => {
    const runtime = 'cursor';
    const expected = path.join(getGlobalConfigDir(runtime), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(runtime), expected);
  });

  test('GSD_RUNTIME env var is respected when no argument provided', () => {
    process.env['GSD_RUNTIME'] = 'codex';
    const expected = path.join(getGlobalConfigDir('codex'), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(), expected);
  });

  test('defaults to claude when no arg and no GSD_RUNTIME', () => {
    const fromModule = agentInstallCheck.getAgentsDir();
    const fromClaude = agentInstallCheck.getAgentsDir('claude');
    assert.strictEqual(fromModule, fromClaude);
  });
});

// ─── 2. checkAgentsInstalled behaviour ───────────────────────────────────────

describe('checkAgentsInstalled', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-agent-check-');
    // Point GSD_AGENTS_DIR at a path we control
    process.env['GSD_AGENTS_DIR'] = path.join(tmpDir, 'agents');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing dir → agents_installed:false, missing_agents = all expected', () => {
    // agents dir does not exist
    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('existing-but-empty dir → installed_agents:[], agents_installed:false', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.ok(result.missing_agents.length > 0, 'missing_agents should not be empty');
    // No manifest → completeness skipped
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('all agents present, no manifest → agents_installed:true, incomplete_agents:[]', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all expected agent .md files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, true);
    assert.deepStrictEqual(result.missing_agents, []);
    assert.deepStrictEqual(result.installed_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('partial manifest: agent.toml absent but agent.md present → incomplete_agents includes agent', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write all agent .md files so presence check passes
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Pick the first expected agent to make "incomplete" via manifest
    const targetAgent = EXPECTED_AGENTS[0];

    // Write manifest that tracks agent.toml for targetAgent (absent on disk)
    // and tracks agent.md for all others (present)
    const manifestFiles = {};
    for (const agent of EXPECTED_AGENTS) {
      manifestFiles[`agents/${agent}.md`] = {};
    }
    // Add a .toml for targetAgent to manifest (not present on disk)
    manifestFiles[`agents/${targetAgent}.toml`] = {};

    const manifest = { files: manifestFiles };
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(manifest)
    );

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.ok(result.incomplete_agents.includes(targetAgent),
      `Expected ${targetAgent} in incomplete_agents, got: ${JSON.stringify(result.incomplete_agents)}`);
    assert.strictEqual(result.agents_installed, false,
      'agents_installed must be false when any agent is incomplete');
  });

  test('malformed manifest → no throw, completeness skipped (incomplete_agents:[])', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all agent files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Write malformed manifest
    fs.writeFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), '{not json"');

    let result;
    assert.doesNotThrow(() => {
      result = agentInstallCheck.checkAgentsInstalled();
    });
    // Malformed → completeness skipped → incomplete_agents empty
    assert.deepStrictEqual(result.incomplete_agents, []);
    // But presence check still passed
    assert.strictEqual(result.agents_installed, true);
  });

  test('agents_dir and agent_runtime are returned in result', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled('cursor');
    // GSD_AGENTS_DIR overrides, so agents_dir = our tmp path
    assert.strictEqual(result.agents_dir, agentsDir);
    assert.strictEqual(result.agent_runtime, 'cursor');
  });
});

// ─── 3. #2540 regression: sandbox_mode vs tool contract ───────────────────────

describe('#2540 regression: sandbox_mode weaker than declared tool contract is reported', () => {
  let tmpDir;
  let agentsDir;
  const target = EXPECTED_AGENTS[0];

  const writeAllAgents = () => {
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `---\nname: ${agent}\n---\nbody`);
    }
  };
  const codexMd = (tools) =>
    `---\nname: "${target}"\ndescription: "d"\n---\n\n<codex_agent_role>\nrole: ${target}\ntools: ${tools}\npurpose: d\n</codex_agent_role>\n\nbody`;
  const toml = (sandbox) =>
    `name = "${target}"\ndescription = "d"\nsandbox_mode = "${sandbox}"\n`;

  beforeEach(() => {
    tmpDir = createTempDir();
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    process.env['GSD_AGENTS_DIR'] = agentsDir;
    writeAllAgents();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('read-only TOML for a Write-tool role is a violation and fails the check', () => {
    // The pre-#2540 false pass: every file present, contract requires Write,
    // generated sandbox is read-only — the agent cannot write its output.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'one violation reported');
    assert.strictEqual(result.sandbox_violations[0].agent, target);
    assert.strictEqual(result.sandbox_violations[0].sandbox_mode, 'read-only');
    assert.strictEqual(result.agents_installed, false, 'semantic violation fails the install check');
  });

  test('workspace-write TOML for a Write-tool role is clean', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('workspace-write'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });

  test('read-only TOML for a read-only contract is clean', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Bash, Grep, Glob'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });

  test('frontmatter tools contract is honored when no codex_agent_role header exists', () => {
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: ${target}\ntools: Read, Edit\n---\nbody`
    );
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'frontmatter Edit contract flags read-only TOML');
  });

  test('codex TOML with a missing sibling .md is incomplete, not silently skipped (no manifest)', () => {
    // Without this, the semantic check goes vacuous exactly where it matters:
    // a .toml whose contract source is gone would pass unverified. There is no
    // gsd-file-manifest.json in this fixture, so the older manifest-based
    // completeness path cannot be what catches it.
    fs.unlinkSync(path.join(agentsDir, `${target}.md`));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.ok(result.incomplete_agents.includes(target), 'md-less codex toml reported incomplete');
    assert.deepStrictEqual(result.sandbox_violations, [], 'no violation claim without a readable contract');
    assert.strictEqual(result.agents_installed, false);
  });

  test('non-codex TOML with a missing sibling .md keeps the skip (toml-only layouts are legitimate)', () => {
    fs.unlinkSync(path.join(agentsDir, `${target}.md`));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('cursor');
    assert.deepStrictEqual(result.incomplete_agents, []);
    assert.deepStrictEqual(result.sandbox_violations, []);
  });

  test('TOML without a sandbox_mode key is skipped (sandboxTier "none" layouts)', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), `name = "${target}"\ndescription = "d"\n`);

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });
});
