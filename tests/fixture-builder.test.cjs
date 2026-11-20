const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFixture, seedPhase, seedWorkstream, writeState, buildGitTemplate, templateBuildEnv } = require('./fixtures/index.cjs');
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

  // #5913, #5470: a fixture must not take anything from the machine's git setup.
  // Fixtures are copies of a template (#6336), so this builds a template of its
  // own under a hostile host setup: a default branch, an excludes file that
  // ignores `.planning`, and an init template with an exclude list and a hook.
  describe('a template is not shaped by the host git setup (#5913, #5470)', () => {
    for (const hostDefault of ['trunk', 'main', null]) {
      test(`host init.defaultBranch=${hostDefault === null ? '(unset)' : hostDefault}, a host excludes file and a host init template`, (t) => {
        const host = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'gsd-host-git-'));
        t.after(() => cleanup(host));
        const hostConfig = path.join(host, 'gitconfig');
        const hostExcludes = path.join(host, 'excludes');
        const hostTemplate = path.join(host, 'template');
        fs.mkdirSync(path.join(hostTemplate, 'info'), { recursive: true });
        fs.mkdirSync(path.join(hostTemplate, 'hooks'));
        fs.writeFileSync(path.join(hostTemplate, 'info', 'exclude'), '.planning\n');
        fs.writeFileSync(path.join(hostTemplate, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        fs.writeFileSync(hostExcludes, '.planning\n');
        fs.writeFileSync(hostConfig, [
          hostDefault === null ? '' : `[init]\n\tdefaultBranch = ${hostDefault}`,
          `[core]\n\texcludesFile = ${hostExcludes.replace(/\\/g, '/')}`,
          '[user]\n\tname = Host User\n\temail = host@example.invalid',
          '',
        ].join('\n'));

        const hostile = {
          GIT_CONFIG_GLOBAL: hostConfig,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TEMPLATE_DIR: hostTemplate,
          GIT_AUTHOR_NAME: 'Env Author',
          GIT_COMMITTER_NAME: 'Env Committer',
        };
        const saved = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
        Object.assign(process.env, hostile);
        const root = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'gsd-template-under-host-'));
        created.push(root, `${root}.init-template`);
        t.after(() => cleanup(`${root}.gitconfig`));
        try {
          buildGitTemplate({ scope: 'planning+doc', root });
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }

        // Read back with the same scrubbed setup, so these are facts about the repository.
        const env = templateBuildEnv({ globalConfig: `${root}.gitconfig`, templateDir: `${root}.init-template` });
        const read = (args) => gitOrThrow(args, { cwd: root, env }).trim();
        assert.strictEqual(read(['symbolic-ref', '--short', 'HEAD']), 'master');
        assert.strictEqual(read(['log', '-1', '--format=%an|%cn']), 'Test|Test');
        assert.deepStrictEqual(read(['ls-files']).split('\n'), ['.planning/PROJECT.md']);
        assert.strictEqual(fs.existsSync(path.join(root, '.git', 'info', 'exclude')), false);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, '.git', 'hooks')), []);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, '.git', 'info')), []);
      });
    }
  });
});
