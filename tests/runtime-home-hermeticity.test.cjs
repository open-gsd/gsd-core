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
 * name pattern to the tests this phase migrated. The positive control proves the
 * hostile env really reaches a child, so the GREEN children are not vacuous.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, formatSeamResult, OUTCOME } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS, QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup, TEST_HOME_SANDBOX_MARKER } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const RUNTIME_HOMES = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs');

const TARGETS = [
  { file: 'runtime-homes-descriptor-drive.test.cjs', namePattern: null },
  { file: 'install.test.cjs', namePattern: 'skills.root' },
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
  return { env, home, claudeConfigDir };
}

function count(stdout, label) {
  const m = new RegExp(`^# ${label} (\\d+)\\r?$`, 'm').exec(stdout);
  return m ? Number(m[1]) : null;
}

describe('#6034 migrated runtime-home tests are hermetic against a hostile host', () => {
  test('positive control: the hostile env reaches a child that does not scrub it', () => {
    const { env, home, claudeConfigDir } = hostileEnv();
    const probe = [
      `const rh = require(${JSON.stringify(RUNTIME_HOMES)});`,
      "process.stdout.write(JSON.stringify({ claude: rh.getGlobalConfigDir('claude'), antigravity: rh.getGlobalConfigDir('antigravity') }));",
    ].join('\n');
    const result = runNode(['-e', probe], { cwd: ROOT, env, timeoutMs: QUICK_SPAWN_TIMEOUT_MS });
    assert.equal(result.outcome, OUTCOME.EXITED, formatSeamResult(result));
    assert.equal(result.exitCode, 0, formatSeamResult(result));
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.claude, claudeConfigDir, 'ambient CLAUDE_CONFIG_DIR must reach the child');
    assert.equal(seen.antigravity, path.join(home, '.gemini', 'antigravity-cli'), 'hostile HOME probe dir must reach the child');
  });

  for (const { file, namePattern } of TARGETS) {
    test(`${file} passes under the hostile env`, () => {
      const { env } = hostileEnv();
      const args = ['--test', '--test-reporter=tap'];
      if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
      args.push(path.join(__dirname, file));
      const result = runNode(args, { cwd: ROOT, env, timeoutMs: INSTALL_TIMEOUT_MS });
      const tail = result.stdout.slice(-3000);
      assert.equal(result.outcome, OUTCOME.EXITED, `${formatSeamResult(result)}\n${tail}`);
      assert.equal(count(result.stdout, 'fail'), 0, `${formatSeamResult(result)}\n${tail}`);
      assert.ok(count(result.stdout, 'pass') > 0, `${file}: no tests executed`);
      assert.equal(result.exitCode, 0, `${formatSeamResult(result)}\n${tail}`);
    });
  }
});
