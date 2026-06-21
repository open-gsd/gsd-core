'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimeArtifactInstallPlan } = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
const { cleanup } = require('./helpers.cjs');

function kind(name, destSubpath, stagedDir, calls) {
  return {
    kind: name,
    destSubpath,
    prefix: 'gsd-',
    stage: (resolvedProfile) => {
      calls.push([name, resolvedProfile.name]);
      return stagedDir;
    },
  };
}

describe('createRuntimeArtifactInstallPlan', () => {
  test('stages layout kinds in order and projects rewritten source dirs', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const calls = [];
    const rewriteCalls = [];
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        kind('commands', 'commands', '/tmp/staged-commands', calls),
        kind('agents', 'agents', '/tmp/staged-agents', calls),
        kind('skills', 'skills', '/tmp/staged-skills', calls),
        kind('kimi-agents', 'agents', '/tmp/staged-kimi-agents', calls),
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedSkillBodies: (stagedDir, opts) => {
          rewriteCalls.push(['skills', stagedDir, opts.runtime, opts.configDir, opts.scope]);
          return stagedDir;
        },
        rewriteStagedCommandBodies: (stagedDir, opts) => {
          rewriteCalls.push(['commands', stagedDir, opts.runtime, opts.configDir, opts.scope]);
          return `${stagedDir}-rewritten`;
        },
      },
    });

    assert.deepStrictEqual(calls, [
      ['commands', 'core'],
      ['agents', 'core'],
      ['skills', 'core'],
      ['kimi-agents', 'core'],
    ]);
    assert.deepStrictEqual(rewriteCalls, [
      ['commands', '/tmp/staged-commands', 'claude', configDir, 'global'],
      ['skills', '/tmp/staged-skills', 'claude', configDir, 'global'],
      ['skills', '/tmp/staged-kimi-agents', 'claude', configDir, 'global'],
    ]);
    assert.deepStrictEqual(result, {
      ok: true,
      plan: {
        cleanupDirs: ['/tmp/staged-commands-rewritten'],
        items: [
          { kind: 'commands', sourceDir: '/tmp/staged-commands-rewritten', destDir: path.join(configDir, 'commands') },
          { kind: 'agents', sourceDir: '/tmp/staged-agents', destDir: path.join(configDir, 'agents') },
          { kind: 'skills', sourceDir: '/tmp/staged-skills', destDir: path.join(configDir, 'skills') },
          { kind: 'kimi-agents', sourceDir: '/tmp/staged-kimi-agents', destDir: path.join(configDir, 'agents') },
        ],
      },
    });
  });

  test('returns stage_failed when a layout kind stage adapter throws', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        {
          kind: 'skills',
          destSubpath: 'skills',
          stage: () => { throw new Error('stage boom'); },
        },
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedSkillBodies: () => { throw new Error('must not rewrite after stage failure'); },
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'stage_failed');
    assert.strictEqual(result.failedKind, 'skills');
    assert.strictEqual(result.message, 'stage boom');
    assert.deepStrictEqual(result.cleanupDirs, []);
  });

  test('returns rewrite_failed with prior cleanup obligations when conversion throws', () => {
    const configDir = path.join(os.tmpdir(), 'gsd-plan-config');
    const calls = [];
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [
        kind('commands', 'commands', '/tmp/staged-commands', calls),
        kind('skills', 'skills', '/tmp/staged-skills', calls),
      ],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      deps: {
        rewriteStagedCommandBodies: (stagedDir) => `${stagedDir}-rewritten`,
        rewriteStagedSkillBodies: () => { throw new Error('rewrite boom'); },
      },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'rewrite_failed');
    assert.strictEqual(result.failedKind, 'skills');
    assert.strictEqual(result.message, 'rewrite boom');
    assert.deepStrictEqual(result.cleanupDirs, ['/tmp/staged-commands-rewritten']);
  });

  test('uses real command rewrite seam by default', (t) => {
    const stagedCommands = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-plan-commands-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-plan-config-'));
    t.after(() => {
      cleanup(stagedCommands);
      cleanup(configDir);
    });
    fs.writeFileSync(path.join(stagedCommands, 'help.md'), '# help\n');
    const layout = {
      runtime: 'claude',
      configDir,
      scope: 'global',
      kinds: [kind('commands', 'commands', stagedCommands, [])],
    };

    const result = createRuntimeArtifactInstallPlan({
      layout,
      resolvedProfile: { name: 'core' },
      resolveAttribution: () => undefined,
      homedir: () => '/Users/example',
      platform: 'linux',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.plan.items.length, 1);
    assert.strictEqual(result.plan.items[0].kind, 'commands');
    assert.notStrictEqual(result.plan.items[0].sourceDir, stagedCommands);
    assert.ok(fs.existsSync(path.join(result.plan.items[0].sourceDir, 'help.md')));
    assert.deepStrictEqual(result.plan.cleanupDirs, [result.plan.items[0].sourceDir]);
    for (const dir of result.plan.cleanupDirs) cleanup(dir);
  });
});
