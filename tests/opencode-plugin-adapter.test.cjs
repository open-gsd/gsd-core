'use strict';

/**
 * opencode-plugin-adapter.test.cjs — unit + integration coverage for the
 * OpenCode native plugin adapter (.opencode/plugins/gsd-core.js, issue #1914).
 *
 * The adapter bridges OpenCode's plugin event bus onto GSD's existing hook
 * scripts by spawning them as subprocesses. These tests exercise it WITHOUT a
 * live OpenCode runtime by:
 *   1. Unit-testing the pure translation helpers exposed on `_internals`.
 *   2. Building a temp "install" layout (hooks/ with deterministic STUB hooks +
 *      gsd-core/ + plugins/gsd-core.js) and driving the plugin's returned
 *      handlers directly, asserting the real spawn bridge maps block/advisory/
 *      allow correctly and that REPO_ROOT resolves to the payload dir.
 *
 * Cross-platform note: filesystem-failure paths are not exercised here; the
 * adapter's own error handling swallows spawn failures by design (a broken hook
 * must never break a tool call), which the "missing hook" case covers.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

const ADAPTER_SRC = path.join(__dirname, '..', '.opencode', 'plugins', 'gsd-core.js');

// ---------------------------------------------------------------------------
// Pure-helper unit tests (no filesystem / no spawn)
// ---------------------------------------------------------------------------

// Test-only helpers hang off the exported `server` function (see adapter export
// note) so they never appear as top-level exports the OpenCode loader iterates.
const _internals = require(ADAPTER_SRC).server._internals;

test('export shape matches OpenCode\'s getServerPlugin contract', () => {
  const mod = require(ADAPTER_SRC);
  // OpenCode's loader extracts a plugin via getServerPlugin(entry): it accepts a
  // bare function OR an object exposing a `.server` function. Our export is the
  // latter, with an `id` identity — the shape validated on real OpenCode.
  const getServerPlugin = (entry) =>
    typeof entry === 'function'
      ? entry
      : entry && typeof entry === 'object' && typeof entry.server === 'function'
        ? entry.server
        : null;
  assert.equal(mod.id, 'gsd-core');
  assert.equal(typeof getServerPlugin(mod), 'function', 'module.exports must yield a server function');
  // Test-only internals must hang off the server function, NOT leak as a sibling
  // top-level export (which would make a stricter loader iteration reject them).
  assert.equal(mod._internals, undefined);
  assert.equal(typeof mod.server._internals, 'object');
});

test('mapToolName maps OpenCode tool names to Claude names', () => {
  assert.equal(_internals.mapToolName('read'), 'Read');
  assert.equal(_internals.mapToolName('write'), 'Write');
  assert.equal(_internals.mapToolName('edit'), 'Edit');
  assert.equal(_internals.mapToolName('bash'), 'Bash');
  assert.equal(_internals.mapToolName('apply_patch'), 'MultiEdit');
  assert.equal(_internals.mapToolName('webfetch'), 'WebFetch');
  // Unknown tools pass through unchanged; empty is empty.
  assert.equal(_internals.mapToolName('mystery'), 'mystery');
  assert.equal(_internals.mapToolName(''), '');
});

test('mapToolInput normalizes camelCase + snake_case arg keys', () => {
  const out = _internals.mapToolInput({
    filePath: '/a/b.txt',
    oldString: 'x',
    newString: 'y',
    command: 'ls',
    url: 'http://e',
  });
  assert.deepEqual(out, {
    file_path: '/a/b.txt',
    old_string: 'x',
    new_string: 'y',
    command: 'ls',
    url: 'http://e',
  });
  // path/file_path aliases also resolve to file_path.
  assert.equal(_internals.mapToolInput({ path: '/p' }).file_path, '/p');
  assert.deepEqual(_internals.mapToolInput(null), {});
});

test('parseFrontmatter splits frontmatter and body', () => {
  const { frontmatter, body } = _internals.parseFrontmatter(
    '---\ndescription: A command\nmode: primary\n---\nHello body\n',
  );
  assert.equal(frontmatter.description, 'A command');
  assert.equal(frontmatter.mode, 'primary');
  assert.equal(body, 'Hello body\n');
  // No frontmatter → whole content is body.
  const plain = _internals.parseFrontmatter('just text');
  assert.deepEqual(plain.frontmatter, {});
  assert.equal(plain.body, 'just text');
});

test('handleHookResult: block decision throws with the hook reason', () => {
  assert.throws(
    () => _internals.handleHookResult(
      { stdout: JSON.stringify({ decision: 'block', reason: 'blocked!' }), exitCode: 0 },
    ),
    /blocked!/,
  );
});

test('handleHookResult: exit code 2 is a hard block even without JSON', () => {
  assert.throws(
    () => _internals.handleHookResult({ stdout: '', exitCode: 2 }),
    /Blocked by GSD hook/,
  );
});

test('handleHookResult: advisory sets metadata + does not throw', () => {
  const output = {};
  assert.doesNotThrow(() =>
    _internals.handleHookResult(
      { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'heads up' } }), exitCode: 0 },
      output,
    ),
  );
  assert.equal(output.metadata._gsdAdvisory, 'heads up');
});

test('handleHookResult: silent allow is a no-op', () => {
  const output = {};
  assert.doesNotThrow(() => _internals.handleHookResult({ stdout: '', exitCode: 0 }, output));
  assert.deepEqual(output, {});
});

// ---------------------------------------------------------------------------
// Integration: drive the plugin against a temp install layout with STUB hooks
// ---------------------------------------------------------------------------

// Build a self-contained payload dir: <root>/hooks/<stub>.js, <root>/gsd-core/,
// and <root>/plugins/gsd-core.js (a copy of the adapter). Returns the loaded
// plugin module for that layout. Each stub hook echoes a fixed JSON verdict.
function buildInstalledLayout(t, stubHooks) {
  // realpath so `root` matches Node's realpath-resolved __dirname inside the
  // copied plugin (macOS /var → /private/var symlink would otherwise diverge).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-plugin-')));
  t.after(() => cleanup(root));

  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });

  for (const [name, jsBody] of Object.entries(stubHooks)) {
    fs.writeFileSync(path.join(root, 'hooks', name), jsBody);
  }

  // Copy the real adapter into the payload's plugins/ dir so REPO_ROOT resolves
  // to `root` via the walk-up probe (root has both hooks/ and gsd-core/).
  const dest = path.join(root, 'plugins', 'gsd-core.js');
  fs.copyFileSync(ADAPTER_SRC, dest);
  // Fresh module instance (bypass require cache — each layout is distinct).
  delete require.cache[require.resolve(dest)];
  const mod = require(dest);
  return { root, mod };
}

// A stub hook that reads stdin (ignored) and prints the given verdict JSON.
function stubHook(verdictJson, exitCode = 0) {
  return `
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  process.stdout.write(${JSON.stringify(verdictJson)});
  process.exit(${exitCode});
});
process.stdin.on('error',()=>process.exit(${exitCode}));
if(process.stdin.isTTY){process.stdout.write(${JSON.stringify(verdictJson)});process.exit(${exitCode});}
`;
}

test('REPO_ROOT resolves to the payload dir in an installed layout', (t) => {
  const { root, mod } = buildInstalledLayout(t, {});
  assert.equal(mod.server._internals.REPO_ROOT, fs.realpathSync(root));
  // No source commands/gsd/ present → treated as installed (not package) tree.
  assert.equal(mod.server._internals.IS_PACKAGE_TREE, false);
});

test('tool.execute.before: a blocking hook aborts the tool call (throws)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(JSON.stringify({ decision: 'block', reason: 'injection detected' })),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before'](
      { tool: 'write' },
      { args: { filePath: '/proj/.planning/x.md', content: 'evil' } },
    ),
    /injection detected/,
  );
});

test('tool.execute.before: a silent hook allows the tool call (no throw)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(''),
    'gsd-read-guard.js': stubHook(''),
    'gsd-worktree-path-guard.js': stubHook(''),
    'gsd-workflow-guard.js': stubHook(''),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'write' },
      { args: { filePath: '/proj/notes.md', content: 'ok' } },
    ),
  );
});

test('tool.execute.after: Read content rewriting maps ~/.claude/gsd-core paths', async (t) => {
  const { root, mod } = buildInstalledLayout(t, {
    'gsd-read-injection-scanner.js': stubHook(''),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  // A file under the payload's gsd-core/workflows is a GSD-managed file, so its
  // Read output is rewritten (canonical ~/.claude/gsd-core/ → real payload path).
  const managed = path.join(root, 'gsd-core', 'workflows', 'x.md');
  const output = { output: 'see ~/.claude/gsd-core/references/foo.md for details' };
  await handlers['tool.execute.after']({ tool: 'read', args: { filePath: managed } }, output);
  assert.match(output.output, new RegExp(path.join(root, 'gsd-core') + '/references/foo\\.md'));
  assert.doesNotMatch(output.output, /~\/\.claude\/gsd-core\//);
});

test('missing hook script is a silent allow (never breaks the tool call)', async (t) => {
  // No hook stubs written at all → every runHook finds no file → silent allow.
  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'edit' },
      { args: { filePath: '/proj/a.md', old_string: 'a', new_string: 'b' } },
    ),
  );
});

test('config hook is a no-op in installed (non-package) layout', async (t) => {
  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  const config = {};
  await handlers.config(config);
  // No commands/agents/skills registered — native file copy owns that surface.
  assert.deepEqual(config, {});
});
