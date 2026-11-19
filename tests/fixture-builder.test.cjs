const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFixture, seedPhase, seedWorkstream, writeState } = require('./fixtures/index.cjs');
const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const created = [];
afterEach(() => {
  while (created.length > 0) cleanup(created.pop());
});

describe('fixture builder module', () => {
  test('creates canonical planning layout by default', () => {
    const dir = createFixture();
    created.push(dir);

    assert.ok(fs.existsSync(path.join(dir, '.planning')), 'creates .planning directory');
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'phases')), 'creates .planning/phases directory');
  });

  test('seeds phase files declaratively', () => {
    const dir = createFixture();
    created.push(dir);

    const phaseDir = seedPhase(dir, '03-api', {
      '03-01-PLAN.md': '# Plan',
      '03-CONTEXT.md': '# Context',
    });

    assert.ok(fs.existsSync(path.join(phaseDir, '03-01-PLAN.md')));
    assert.ok(fs.existsSync(path.join(phaseDir, '03-CONTEXT.md')));
  });

  test('seeds workstream and active pointer declaratively', () => {
    const dir = createFixture();
    created.push(dir);

    const wsDir = seedWorkstream(dir, {
      name: 'alpha',
      state: '# State\n',
      roadmap: '# Roadmap\n',
      active: true,
    });

    assert.ok(fs.existsSync(path.join(wsDir, 'STATE.md')));
    assert.ok(fs.existsSync(path.join(wsDir, 'ROADMAP.md')));
    assert.strictEqual(
      fs.readFileSync(path.join(dir, '.planning', 'active-workstream'), 'utf8').trim(),
      'alpha'
    );
  });

  test('rejects invalid workstream names', () => {
    const dir = createFixture();
    created.push(dir);
    assert.throws(() => seedWorkstream(dir, { name: '../escape' }), /invalid name/);
  });

  test('writes STATE.md in canonical location', () => {
    const dir = createFixture();
    created.push(dir);

    const p = writeState(dir, '# Project State\n');
    assert.ok(fs.existsSync(p));
    assert.strictEqual(path.basename(p), 'STATE.md');
  });

  test('initializes git fixture with initial commit', () => {
    const dir = createFixture({ git: true });
    created.push(dir);

    const isWorkTree = gitOrThrow(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).trim();
    assert.strictEqual(isWorkTree, 'true', 'fixture should be a git worktree');

    const head = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    assert.ok(head.length > 0, 'fixture should include initial commit');

    assert.ok(
      fs.existsSync(path.join(dir, '.planning', 'PROJECT.md')),
      'git fixture writes canonical PROJECT.md'
    );
  });

  // #5913: the fixture repo's initial branch must not follow the host's `init.defaultBranch`
  // (Apple's Command Line Tools git sets `main` in its system gitconfig). CI leaves it unset, which
  // git reads as `master`, so `master` is the value every fixture user already sees there.
  describe('initial branch ignores the host init.defaultBranch (#5913)', () => {
    for (const hostDefault of ['trunk', 'main', null]) {
      test(`host init.defaultBranch=${hostDefault === null ? '(unset)' : hostDefault}`, (t) => {
        const hostConfigDir = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'gsd-host-gitconfig-'));
        t.after(() => cleanup(hostConfigDir));
        const hostConfig = path.join(hostConfigDir, 'gitconfig');
        fs.writeFileSync(hostConfig, hostDefault === null ? '' : `[init]\n\tdefaultBranch = ${hostDefault}\n`);

        const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
        process.env.GIT_CONFIG_GLOBAL = hostConfig;
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        let dir;
        try {
          dir = createFixture({ git: true });
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
        created.push(dir);

        const branch = gitOrThrow(['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).trim();
        assert.strictEqual(branch, 'master');
      });
    }
  });
});
