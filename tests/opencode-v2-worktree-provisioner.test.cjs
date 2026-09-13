'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanup } = require('./helpers.cjs');

const { provisionOpenCodeV2Worktree } = require('../gsd-core/bin/lib/opencode-v2-worktree-provisioner.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-opencode-v2-provisioner-')));
  t.after(() => cleanup(root));
  const worktreePath = path.join(root, 'worktrees', 'agent-one');
  fs.mkdirSync(worktreePath, { recursive: true });
  return { root, worktreePath };
}

test('copies complete nested and hidden .opencode content into an external worktree', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.opencode', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.opencode', 'nested', 'config.json'), '{"ok":true}\n');
  fs.writeFileSync(path.join(f.root, '.opencode', '.hidden-config'), 'hidden\n');

  provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: f.worktreePath });

  assert.equal(fs.readFileSync(path.join(f.worktreePath, '.opencode', 'nested', 'config.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.readFileSync(path.join(f.worktreePath, '.opencode', '.hidden-config'), 'utf8'), 'hidden\n');
});

test('an absent source .opencode directory is a successful no-op', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: f.worktreePath }));
  assert.equal(fs.existsSync(path.join(f.worktreePath, '.opencode')), false);
});

test('surfaces filesystem copy errors to the generic lifecycle', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.opencode'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.opencode', 'config.json'), 'x');
  fs.writeFileSync(path.join(f.worktreePath, '.opencode'), 'not-a-directory');
  assert.throws(
    () => provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: f.worktreePath }),
    /EEXIST|ENOTDIR|cannot overwrite/i,
  );
});

test('rejects the former nested production topology before creating a partial destination copy', (t) => {
  const f = fixture(t);
  const nestedWorktree = path.join(f.root, '.opencode', 'worktrees', 'agent-one');
  fs.mkdirSync(nestedWorktree, { recursive: true });
  fs.writeFileSync(path.join(f.root, '.opencode', 'config.json'), 'source\n');

  assert.throws(
    () => provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: nestedWorktree }),
    /refuses a worktree inside source \.opencode/,
  );
  assert.equal(fs.existsSync(path.join(nestedWorktree, '.opencode')), false);
  assert.equal(fs.readFileSync(path.join(f.root, '.opencode', 'config.json'), 'utf8'), 'source\n');
});

test('rejects source .opencode itself before recursive copy starts', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, '.opencode');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'config.json'), 'source\n');

  assert.throws(
    () => provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: source }),
    /refuses a worktree inside source \.opencode/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'config.json'), 'utf8'), 'source\n');
});

test('allows a prefix sibling of source .opencode', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, '.opencode');
  const prefixSibling = path.join(f.root, '.opencode-other');
  fs.mkdirSync(source);
  fs.mkdirSync(prefixSibling);
  fs.writeFileSync(path.join(source, 'config.json'), 'source\n');

  provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: prefixSibling });

  assert.equal(fs.readFileSync(path.join(prefixSibling, '.opencode', 'config.json'), 'utf8'), 'source\n');
});

test('allows a normal sibling worktree outside source .opencode', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, '.opencode');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'config.json'), 'source\n');

  provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: f.worktreePath });

  assert.equal(fs.readFileSync(path.join(f.worktreePath, '.opencode', 'config.json'), 'utf8'), 'source\n');
});

test('rejects a symlink alias that resolves inside source before recursive copy starts', (t) => {
  const f = fixture(t);
  const source = path.join(f.root, '.opencode');
  const nestedWorktree = path.join(source, 'worktrees', 'agent-one');
  const alias = path.join(f.root, 'external-looking-worktree');
  fs.mkdirSync(nestedWorktree, { recursive: true });
  fs.writeFileSync(path.join(source, 'config.json'), 'source\n');
  fs.symlinkSync(nestedWorktree, alias, 'dir');

  assert.throws(
    () => provisionOpenCodeV2Worktree({ repoRoot: f.root, worktreePath: alias }),
    /refuses a worktree inside source \.opencode/,
  );
  assert.equal(fs.existsSync(path.join(nestedWorktree, '.opencode')), false);
  assert.deepEqual(fs.readdirSync(source).sort(), ['config.json', 'worktrees']);
});
