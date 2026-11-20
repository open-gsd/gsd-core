'use strict';

/**
 * #6213: `resolve-agent` refuses a plan `agent_hint` that names one of GSD's own non-executor roles
 * (gsd-verifier, gsd-planner, ...). Such a hint would dispatch that role as the plan's executor, so
 * the route answers `gsd-executor`, says why on stderr, and reports `refused` in `--json`.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TOOLS_PATH, homeSandboxEnv, scrubConfigLocationEnv, cleanup, createTempProject } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode, formatSeamResult, OUTCOME } = require('./helpers/process-seam.cjs');
const { MODEL_PROFILES } = require('../gsd-core/bin/lib/model-profiles.cjs');

const SPECIALIST = 'acme-rails-executor';

describe('#6213 resolve-agent refuses GSD non-executor roles', () => {
  let dir;
  let restoreEnv;
  before(() => {
    restoreEnv = scrubConfigLocationEnv();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resolve-agent-role-'));
    for (const name of [...Object.keys(MODEL_PROFILES), SPECIALIST]) {
      fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
  });
  after(() => { restoreEnv(); cleanup(dir); });

  function resolveAgent(name, ...extra) {
    const r = runNode([TOOLS_PATH, 'resolve-agent', '--name', name, ...extra], {
      cwd: dir,
      env: { ...process.env, ...homeSandboxEnv(dir), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: dir },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    // A timeout or kill is its own failure, never read as a wrong answer.
    assert.strictEqual(r.outcome, OUTCOME.EXITED, `resolve-agent did not exit: ${formatSeamResult(r)}`);
    return { exitCode: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr };
  }

  test('an installed gsd-verifier hint resolves to gsd-executor with a warning', () => {
    const raw = resolveAgent('gsd-verifier', '--raw');
    assert.strictEqual(raw.exitCode, 0);
    assert.strictEqual(raw.stdout, 'gsd-executor');
    assert.ok(raw.stderr.includes('gsd-verifier'), `stderr names the refused hint: ${raw.stderr}`);

    const json = JSON.parse(resolveAgent('gsd-verifier', '--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.fallback, true);
    assert.strictEqual(json.refused, 'non-executor-role');
  });

  test('every GSD role other than gsd-executor is refused', () => {
    const roles = Object.keys(MODEL_PROFILES).filter((name) => name !== 'gsd-executor');
    assert.ok(roles.length > 0, 'the role catalog has non-executor roles');
    for (const role of roles) {
      const out = resolveAgent(role, '--json');
      const json = JSON.parse(out.stdout);
      assert.strictEqual(json.resolved, 'gsd-executor', role);
      assert.strictEqual(json.refused, 'non-executor-role', role);
      assert.ok(out.stderr.includes(role), `stderr names the refused hint ${role}: ${out.stderr}`);
    }
  });

  test('requesting gsd-executor itself resolves to it with no warning and no fallback', () => {
    const raw = resolveAgent('gsd-executor', '--raw');
    assert.strictEqual(raw.stdout, 'gsd-executor');
    assert.strictEqual(raw.stderr, '');
    const json = JSON.parse(resolveAgent('gsd-executor', '--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.fallback, false);
    assert.ok(!('refused' in json), 'no refused key');
  });

  test('whitespace and case do not bypass the refusal', () => {
    for (const name of ['gsd-verifier ', ' gsd-verifier', '\tgsd-planner\t', 'GSD-Verifier', 'Gsd-Planner  ']) {
      const out = resolveAgent(name, '--json');
      const json = JSON.parse(out.stdout);
      assert.strictEqual(json.resolved, 'gsd-executor', JSON.stringify(name));
      assert.strictEqual(json.refused, 'non-executor-role', JSON.stringify(name));
      assert.ok(out.stderr.includes(name.trim()), `stderr names the refused hint: ${out.stderr}`);
    }
  });

  test('gsd-executor with surrounding whitespace or other casing resolves as gsd-executor without a refusal', () => {
    for (const name of ['gsd-executor ', ' gsd-executor', 'GSD-Executor']) {
      const raw = resolveAgent(name, '--raw');
      assert.strictEqual(raw.stdout, 'gsd-executor', JSON.stringify(name));
      assert.strictEqual(raw.stderr, '', JSON.stringify(name));
      const json = JSON.parse(resolveAgent(name, '--json').stdout);
      assert.strictEqual(json.resolved, 'gsd-executor', JSON.stringify(name));
      assert.strictEqual(json.fallback, false, JSON.stringify(name));
      assert.ok(!('refused' in json), JSON.stringify(name));
    }
  });

  test('an installed specialist resolves to itself and carries no refused key', () => {
    const raw = resolveAgent(SPECIALIST, '--raw');
    assert.strictEqual(raw.stdout, SPECIALIST);
    assert.strictEqual(raw.stderr, '');
    const json = JSON.parse(resolveAgent(SPECIALIST, '--json').stdout);
    assert.strictEqual(json.resolved, SPECIALIST);
    assert.strictEqual(json.fallback, false);
    assert.ok(!('refused' in json), 'no refused key');
  });

  test('an unknown hint keeps falling back to gsd-executor without a refusal', () => {
    const json = JSON.parse(resolveAgent('no-such-agent-6213', '--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.fallback, true);
    assert.ok(!('refused' in json), 'no refused key');
  });
});

describe('#6213 resolve-agent --phase --plan reports a refused plan hint like --name does', () => {
  let root;
  let agentsDir;
  let restoreEnv;
  before(() => {
    restoreEnv = scrubConfigLocationEnv();
    root = createTempProject('gsd-resolve-agent-plan-role-');
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-resolve-agent-plan-role-agents-'));
    for (const name of ['gsd-verifier', 'gsd-executor', SPECIALIST]) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nbody\n`);
    }
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    const phaseDir = path.join(root, '.planning', 'phases', '02-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, 'gsd-verifier');
  });
  after(() => { restoreEnv(); cleanup(root); cleanup(agentsDir); });

  function writePlan(phaseDir, hint) {
    const frontmatter = `---\nphase: 02-api\nplan: 01\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: [a.txt]\nautonomous: true\nagent_hint: ${hint}\n---\n`;
    const body = '<objective>\nDo it\n</objective>\n\n<tasks>\n<task type="auto"><name>t</name><action>x</action><done>y</done></task>\n</tasks>\n';
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), frontmatter + body);
  }

  function resolvePlan(...extra) {
    const r = runNode([TOOLS_PATH, 'resolve-agent', '--phase', '02', '--plan', '02-01', ...extra], {
      cwd: root,
      env: { ...process.env, ...homeSandboxEnv(root), GSD_TEST_MODE: '1', GSD_AGENTS_DIR: agentsDir },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, `resolve-agent did not exit: ${formatSeamResult(r)}`);
    return { exitCode: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr };
  }

  test('a plan hinted gsd-verifier prints gsd-executor with the --name warning, and --json carries refused', () => {
    const raw = resolvePlan('--raw');
    assert.strictEqual(raw.exitCode, 0);
    assert.strictEqual(raw.stdout, 'gsd-executor');
    assert.strictEqual(raw.stderr, 'warning: agent_hint "gsd-verifier" names a GSD non-executor role; dispatching gsd-executor instead (#6213)\n');

    const json = JSON.parse(resolvePlan('--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.requested, 'gsd-verifier');
    assert.strictEqual(json.fallback, true);
    assert.strictEqual(json.refused, 'non-executor-role');
  });

  test('a plan hinted with an installed specialist prints it with no warning and no refused key', () => {
    writePlan(path.join(root, '.planning', 'phases', '02-api'), SPECIALIST);
    const raw = resolvePlan('--raw');
    assert.strictEqual(raw.stdout, SPECIALIST);
    assert.strictEqual(raw.stderr, '');
    const json = JSON.parse(resolvePlan('--json').stdout);
    assert.ok(!('refused' in json), 'no refused key');
    assert.strictEqual(json.requested, SPECIALIST);
    assert.strictEqual(json.fallback, false, 'the hint was found and used');
  });

  test('a plan hinted gsd-executor resolves to it with fallback false, like --name', () => {
    writePlan(path.join(root, '.planning', 'phases', '02-api'), 'gsd-executor');
    const json = JSON.parse(resolvePlan('--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.requested, 'gsd-executor');
    assert.strictEqual(json.fallback, false);
    assert.ok(!('refused' in json), 'no refused key');
  });

  test('a plan hinted with an unknown agent falls back with the hint reported as requested', () => {
    writePlan(path.join(root, '.planning', 'phases', '02-api'), 'no-such-agent-6213');
    const json = JSON.parse(resolvePlan('--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.requested, 'no-such-agent-6213');
    assert.strictEqual(json.fallback, true);
    assert.ok(!('refused' in json), 'no refused key');
  });

  test('a plan without an agent_hint reports requested null and fallback true', () => {
    const phaseDir = path.join(root, '.planning', 'phases', '02-api');
    writePlan(phaseDir, SPECIALIST);
    const planFile = path.join(phaseDir, '02-01-PLAN.md');
    fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf-8').replace(`agent_hint: ${SPECIALIST}\n`, ''));
    const json = JSON.parse(resolvePlan('--json').stdout);
    assert.strictEqual(json.resolved, 'gsd-executor');
    assert.strictEqual(json.requested, null);
    assert.strictEqual(json.fallback, true);
  });
});
