'use strict';

/**
 * #6034 (epic #4635 Phase 2): the tests this phase moved onto the isolation seams
 * must pass when the machine running them is hostile:
 *   - CLAUDE_CONFIG_DIR and GSD_HOME are exported,
 *   - HOME holds `.gemini/antigravity-cli` (changes the antigravity default, #4312)
 *     and `.gsd/defaults.json` declaring `agent_tools` (#4613),
 *   - TMPDIR sits two levels under a directory whose `.planning/config.json`
 *     declares `agent_tools` and whose `.claude/settings.local.json` declares
 *     `mcpServers` (the ancestor walk, #4613).
 *
 * Each migrated file runs as its own `node --test` child under that env, scoped by
 * name pattern to the tests this phase migrated, and again under a clean host. The
 * hostile run must pass the same number of tests as the clean one. The positive
 * control proves the hostile env really reaches a child, so the GREEN children are
 * not vacuous.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, formatSeamResult, OUTCOME } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS, QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup, TEST_HOME_SANDBOX_MARKER } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const ROOT = path.join(__dirname, '..');
const RUNTIME_HOMES = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs');
const MODEL_OVERRIDE_RESOLVER = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-model-override-resolver.cjs');

const TARGETS = [
  { file: 'runtime-homes-descriptor-drive.test.cjs', namePattern: null },
  { file: 'install.test.cjs', namePattern: 'skills.root|all runtimes default paths' },
  {
    file: 'agent-descriptor-parity.install.test.cjs',
    // The H/I/J rows (#4613) plus the oracle's agent_tools rows.
    namePattern: 'agent-descriptor-parity: (H|I\\d|J\\d|oracle models|an agent with no tools)',
  },
];

const AGENT_TOOLS = { agent_tools: { '*': ['WebFetch'] } };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

const roots = [];
after(() => {
  while (roots.length) cleanup(roots.pop());
});

// The env is deliberately built from process.env plus hostile overrides because
// isolatedEnv() strips the ambient config-location keys this control must leak
// into the child; this is the one sanctioned exception to the CONTRIBUTING.md
// hand-written-env rule.
function hostileEnv() {
  const root = createTempDir('gsd-6034-hostile-');
  roots.push(root);

  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeJson(path.join(home, '.gsd', 'defaults.json'), AGENT_TOOLS);

  const gsdHome = path.join(root, 'gsd-home');
  writeJson(path.join(gsdHome, 'defaults.json'), AGENT_TOOLS);

  const ancestor = path.join(root, 'ancestor');
  writeJson(path.join(ancestor, '.planning', 'config.json'), AGENT_TOOLS);
  writeJson(path.join(ancestor, '.claude', 'settings.local.json'), { mcpServers: { hostile: { command: 'false' } } });
  const tmp = path.join(ancestor, 'a', 'b');
  fs.mkdirSync(tmp, { recursive: true });

  const claudeConfigDir = path.join(root, 'ambient-claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    [TEST_HOME_SANDBOX_MARKER]: home,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    GSD_HOME: gsdHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  };
  delete env.NODE_TEST_CONTEXT; // run as a root test process, not a subtest of this one
  return { env, home, claudeConfigDir, tmp };
}

// A clean host: a fresh empty home with the ambient config-location keys stripped.
function cleanEnv() {
  const home = createTempDir('gsd-6034-clean-');
  roots.push(home);
  const env = isolatedEnv({ home, override: { [TEST_HOME_SANDBOX_MARKER]: home } });
  delete env.NODE_TEST_CONTEXT; // run as a root test process, not a subtest of this one
  return env;
}

// Reads node:test's TAP summary lines (the runner's protocol, not code-under-test
// output), same approach as tests/user-home-isolation-5594.test.cjs.
function tapSummaryCount(stdout, label) {
  const m = new RegExp(`^# ${label} (\\d+)\\r?$`, 'm').exec(stdout);
  return m ? Number(m[1]) : null;
}

function runTarget({ file, namePattern }, env) {
  const args = ['--test', '--test-reporter=tap'];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(path.join(__dirname, file));
  const result = runNode(args, { cwd: ROOT, env, timeoutMs: INSTALL_TIMEOUT_MS });
  return {
    result,
    pass: tapSummaryCount(result.stdout, 'pass'),
    fail: tapSummaryCount(result.stdout, 'fail'),
  };
}

describe('#6034 migrated runtime-home tests are hermetic against a hostile host', () => {
  test('positive control: the hostile env reaches a child that does not scrub it', () => {
    const { env, home, claudeConfigDir, tmp } = hostileEnv();
    const probe = [
      `const rh = require(${JSON.stringify(RUNTIME_HOMES)});`,
      `const resolver = require(${JSON.stringify(MODEL_OVERRIDE_RESOLVER)});`,
      `const startDir = ${JSON.stringify(tmp)};`,
      "process.stdout.write(JSON.stringify({ claude: rh.getGlobalConfigDir('claude'), antigravity: rh.getGlobalConfigDir('antigravity'), agentTools: resolver.readGsdEffectiveAgentTools(startDir) }));",
    ].join('\n');
    const result = runNode(['-e', probe], { cwd: ROOT, env, timeoutMs: QUICK_SPAWN_TIMEOUT_MS });
    assert.equal(result.outcome, OUTCOME.EXITED, formatSeamResult(result));
    assert.equal(result.exitCode, 0, formatSeamResult(result));
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.claude, claudeConfigDir, 'ambient CLAUDE_CONFIG_DIR must reach the child');
    assert.equal(seen.antigravity, path.join(home, '.gemini', 'antigravity-cli'), 'hostile HOME probe dir must reach the child');
    assert.notEqual(seen.agentTools, null, 'the ancestor/home agent_tools must reach an unscrubbed child');
    assert.ok(seen.agentTools['*'].includes('WebFetch'), 'the hostile agent_tools grant must reach an unscrubbed child');
  });

  for (const target of TARGETS) {
    test(`${target.file} passes under the hostile env, with the same pass count as a clean host`, () => {
      const clean = runTarget(target, cleanEnv());
      const cleanTail = clean.result.stdout.slice(-3000);
      assert.equal(clean.fail, 0, `${formatSeamResult(clean.result)}\n${cleanTail}`);
      assert.ok(clean.pass > 0, `${target.file}: no tests executed on the clean host`);

      const hostile = runTarget(target, hostileEnv().env);
      const tail = hostile.result.stdout.slice(-3000);
      assert.equal(hostile.result.outcome, OUTCOME.EXITED, `${formatSeamResult(hostile.result)}\n${tail}`);
      assert.equal(hostile.result.exitCode, 0, `${formatSeamResult(hostile.result)}\n${tail}`);
      assert.equal(hostile.fail, 0, `${formatSeamResult(hostile.result)}\n${tail}`);
      assert.equal(hostile.pass, clean.pass, `${target.file}: pass count differs between clean and hostile host`);
    });
  }
});
