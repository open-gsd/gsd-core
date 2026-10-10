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
 * must never break a tool call). A MISSING hook script likewise never breaks
 * the tool call, but since #2305 it warns loudly (once per hook file) — a
 * silently-absent guard script was exactly how every Kilo guard no-opped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('os');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ADAPTER_SRC = path.join(__dirname, '..', '.opencode', 'plugins', 'gsd-core.js');

// ---------------------------------------------------------------------------
// Pure-helper unit tests (no filesystem / no spawn)
// ---------------------------------------------------------------------------

// Test-only helpers hang off the exported `server` function (see adapter export
// note) so they never appear as top-level exports the OpenCode loader iterates.
const _internals = require(ADAPTER_SRC).server._internals;

// Faithful emulation of OpenCode's loader: `getServerPlugin` accepts a bare
// function OR an object with a `.server` function, else the loader THROWS.
function getServerPlugin(entry) {
  if (typeof entry === 'function') return entry;
  if (entry && typeof entry === 'object' && typeof entry.server === 'function') return entry.server;
  return null;
}
// Emulate the loader loop: `for (const entry of Object.values(mod)) { … throw if null }`.
function loaderExtract(mod) {
  const servers = [];
  for (const entry of Object.values(mod)) {
    const s = getServerPlugin(entry);
    if (!s) throw new TypeError('Plugin export is not a function');
    servers.push(s);
  }
  return servers;
}

test('export survives the loader loop as raw CommonJS (require)', () => {
  const mod = require(ADAPTER_SRC);
  // `id` must be readable for identity/dedup...
  assert.equal(mod.id, 'gsd-core');
  // ...but NON-ENUMERABLE so it never lands in Object.values (would throw).
  assert.ok(!Object.keys(mod).includes('id'), 'id must be non-enumerable');
  const servers = loaderExtract(mod); // must not throw
  assert.equal(servers.length, 1);
  assert.equal(typeof servers[0], 'function');
  // Internals hang off the server fn, never as a sibling top-level export.
  assert.equal(mod._internals, undefined);
  assert.equal(typeof mod.server._internals, 'object');
});

test('export survives the loader loop as an ESM/Bun namespace (default + synthesized)', () => {
  const raw = require(ADAPTER_SRC);
  // Worst-case ESM interop: default plus any lexer-synthesized named exports.
  // Because module.exports is assigned from a variable, only `default` is
  // realistically synthesized — but assert robustness even if `server` leaks.
  for (const ns of [{ default: raw }, { default: raw, server: raw.server }]) {
    assert.doesNotThrow(() => loaderExtract(ns), `loader threw on namespace ${Object.keys(ns)}`);
  }
});

test('mapToolName maps OpenCode tool names to Claude names', () => {
  assert.equal(_internals.mapToolName('read'), 'Read');
  assert.equal(_internals.mapToolName('write'), 'Write');
  assert.equal(_internals.mapToolName('edit'), 'Edit');
  assert.equal(_internals.mapToolName('bash'), 'Bash');
  assert.equal(_internals.mapToolName('grep'), 'Grep');
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
  // #4221: OpenCode's grep `include` (and a literal `glob`) reach the secret
  // read guard as Claude's `glob`.
  assert.equal(_internals.mapToolInput({ include: '.env*' }).glob, '.env*');
  assert.equal(_internals.mapToolInput({ glob: '**/*.ts' }).glob, '**/*.ts');
  assert.equal('glob' in _internals.mapToolInput({ command: 'ls' }), false);
  assert.deepEqual(_internals.mapToolInput(null), {});
});

const CLAUDE_TOOL_INPUT_KEYS = ['file_path', 'content', 'new_string', 'old_string', 'command', 'glob', 'url', 'query'];

test('mapToolInput property: never throws and only emits Claude tool_input keys for any value', () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      const out = _internals.mapToolInput(value);
      assert.equal(Object.getPrototypeOf(out), Object.prototype);
      for (const key of Object.keys(out)) assert.ok(CLAUDE_TOOL_INPUT_KEYS.includes(key), key);
      if (value === null || typeof value !== 'object') assert.deepEqual(out, {});
    }),
    { seed: 4918, numRuns: 200, verbose: true },
  );
});

test('mapToolInput property: maps OpenCode 1.x and 2.x tool args to Claude tool_input with path/filePath to file_path', () => {
  const fields = [
    'filePath', 'path', 'file_path', 'content', 'oldString', 'newString', 'old_string', 'new_string', 'replaceAll',
    'command', 'workdir', 'timeout', 'glob', 'include', 'pattern', 'url', 'format', 'query', 'patchText', 'offset', 'limit',
  ];
  const valueArb = fc.oneof(fc.string(), fc.constantFrom('', 0, false, null, undefined), fc.integer());
  const argsArb = fc.record(Object.fromEntries(fields.map((f) => [f, valueArb])), { requiredKeys: [] });
  fc.assert(
    fc.property(argsArb, (args) => {
      const expected = {};
      const filePath = args.filePath || args.path || args.file_path;
      if (filePath) expected.file_path = filePath;
      for (const key of ['content', 'command', 'url', 'query']) {
        if (args[key] !== undefined) expected[key] = args[key];
      }
      const newString = args.newString !== undefined ? args.newString : args.new_string;
      if (newString !== undefined) expected.new_string = newString;
      const oldString = args.oldString !== undefined ? args.oldString : args.old_string;
      if (oldString !== undefined) expected.old_string = oldString;
      const glob = args.glob ?? args.include;
      if (glob !== undefined) expected.glob = glob;
      assert.deepEqual(_internals.mapToolInput(args), expected);
    }),
    { seed: 4919, numRuns: 200, verbose: true },
  );
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
  assert.deepEqual(output.metadata._gsdAdvisory, ['heads up']);
});

test('handleHookResult: multiple advisories accumulate (no clobber)', () => {
  // A single tool call runs several advisory hooks in sequence; each must be
  // preserved, not overwritten by the next.
  const output = {};
  const advise = (ctx) =>
    _internals.handleHookResult(
      { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: ctx } }), exitCode: 0 },
      output,
    );
  advise('prompt-guard note');
  advise('read-guard note');
  advise('workflow-guard note');
  assert.deepEqual(output.metadata._gsdAdvisory, [
    'prompt-guard note',
    'read-guard note',
    'workflow-guard note',
  ]);
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

test('tool.execute.before: the secret read guard blocks a Bash read of .env (#4221)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-workflow-guard.js': stubHook(''),
    'gsd-secret-read-guard.js': stubHook(JSON.stringify({ decision: 'block', code: 'secret-read', reason: 'secret read denied' }), 2),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before']({ tool: 'bash' }, { args: { command: 'cat .env' } }),
    /secret read denied/,
  );
});

test('tool.execute.before: the secret read guard blocks a grep with a secret path (#4221)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-secret-read-guard.js': stubHook(JSON.stringify({ decision: 'block', code: 'secret-read', reason: 'secret grep denied' }), 2),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before']({ tool: 'grep' }, { args: { pattern: 'KEY', path: '/p/.env' } }),
    /secret grep denied/,
  );
});

test('tool.execute.before: the secret read guard is dispatched for read, not for write (#4221)', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(''),
    'gsd-read-guard.js': stubHook(''),
    'gsd-worktree-path-guard.js': stubHook(''),
    'gsd-workflow-guard.js': stubHook(''),
    'gsd-write-guard.js': stubHook(''),
    'gsd-secret-read-guard.js': stubHook(JSON.stringify({ decision: 'block', code: 'secret-read', reason: 'secret read denied' }), 2),
  });
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before']({ tool: 'read' }, { args: { filePath: '/p/.env' } }),
    /secret read denied/,
  );
  await assert.doesNotReject(() =>
    handlers['tool.execute.before']({ tool: 'write' }, { args: { filePath: '/p/.env', content: 'X=1' } }),
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
  // The adapter rewrites `~/.claude/gsd-core/` → `${GSD_CORE}/`, where GSD_CORE
  // is `path.join(root, 'gsd-core')` (OS-native separators). Assert with a plain
  // string include, NOT a RegExp built from a path — on Windows the backslashes
  // in the path would be interpreted as regex escapes and never match.
  const expected = path.join(root, 'gsd-core') + '/references/foo.md';
  assert.ok(
    output.output.includes(expected),
    `expected rewritten path "${expected}" in output: ${output.output}`,
  );
  assert.ok(
    !output.output.includes('~/.claude/gsd-core/'),
    'canonical ~/.claude/gsd-core/ prefix must be rewritten away',
  );
});

test('missing hook script warns loudly but still allows (never breaks the tool call, #2305)', async (t) => {
  // No hook stubs written at all → every runHook finds no file → allow, but
  // each absent guard script must be warned about (once per hook file): a
  // silently-missing guard is how #2305 no-opped every Kilo guard.
  const { mod } = buildInstalledLayout(t, {});
  const warnings = [];
  const realConsoleError = console.error;
  t.after(() => { console.error = realConsoleError; });
  console.error = (...args) => { warnings.push(args.join(' ')); };
  const handlers = await mod.server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'edit' },
      { args: { filePath: '/proj/a.md', old_string: 'a', new_string: 'b' } },
    ),
  );
  const missingWarnings = warnings.filter((w) => w.includes('hook script missing'));
  assert.ok(missingWarnings.length > 0, 'a missing guard script must be warned about');
  // Warn-once: driving a second identical tool call must not re-warn.
  const warnedOnce = missingWarnings.length;
  await assert.doesNotReject(() =>
    handlers['tool.execute.before'](
      { tool: 'edit' },
      { args: { filePath: '/proj/a.md', old_string: 'a', new_string: 'b' } },
    ),
  );
  assert.equal(
    warnings.filter((w) => w.includes('hook script missing')).length,
    warnedOnce,
    'the missing-hook warning fires once per hook file, not once per tool call',
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

// ---------------------------------------------------------------------------
// Session lifecycle + opencode-subset surface parity (#1682 Slice 1b/c)
// ---------------------------------------------------------------------------

test('session.idle event is handled (no-op sentinel) without throwing', async (t) => {
  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  // session.idle ↔ Claude Stop lifecycle point; recognized no-op today.
  await assert.doesNotReject(() => handlers.event({ event: { type: 'session.idle' } }));
});

test('experimental.session.compacting injects the GSD state breadcrumb', async (t) => {
  const { mod } = buildInstalledLayout(t, { 'gsd-context-monitor.js': stubHook('') });
  const handlers = await mod.server({ directory: process.cwd() });
  // Compaction fires only with an active session; session.created sets it.
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: process.cwd() } } },
  });
  const output = {};
  await handlers['experimental.session.compacting']({}, output);
  assert.ok(Array.isArray(output.context) && output.context.length > 0, 'compaction injects a GSD breadcrumb');
  assert.ok(output.context.some((c) => /GSD/.test(c)), 'breadcrumb is GSD-tagged');
});

test('plugin implements the full declared opencode extension-event surface (Claude parity — #1943)', async (t) => {
  const { extensionEventSurfaceFor } = require('../gsd-core/bin/lib/host-integration.cjs');
  const surface = extensionEventSurfaceFor('opencode');
  assert.ok(surface, 'opencode is a consumed extensionEvents dialect (non-null surface)');
  // The engine — not the host bus — owns workflow-phase sequencing on this host.
  assert.ok(!surface.some((e) => /plan:|verify:|ship:/.test(e)),
    'opencode extension events include no workflow-phase events');

  const { mod } = buildInstalledLayout(t, {});
  const handlers = await mod.server({ directory: process.cwd() });
  // Tool + compaction events are top-level handler keys.
  for (const ev of ['tool.execute.before', 'tool.execute.after', 'experimental.session.compacting']) {
    assert.equal(typeof handlers[ev], 'function', `plugin exposes a handler for ${ev}`);
  }
  // Session/file events dispatch through the `event` handler.
  assert.equal(typeof handlers.event, 'function', 'plugin exposes an event dispatcher');
  // Every declared surface event resolves to a plugin handler. Session /
  // permission / error events dispatch through the `event` handler (not
  // top-level handler keys). #2087 added permission.asked/replied + session.error.
  const EVENT_DISPATCHED = new Set([
    'session.created', 'session.idle', 'file.edited',
    'permission.asked', 'permission.replied', 'session.error',
  ]);
  for (const ev of surface) {
    const covered = typeof handlers[ev] === 'function' || EVENT_DISPATCHED.has(ev);
    assert.ok(covered, `plugin covers opencode extension event: ${ev}`);
  }
});

// ---------------------------------------------------------------------------
// Installer integration: copy → manifest → uninstall (real bin/install.js)
// ---------------------------------------------------------------------------

test('installer copies plugin as .js, records it in the manifest, and removes it on uninstall', (t) => {
  const { runNode } = require('./helpers/process-seam.cjs');
  const installer = path.join(__dirname, '..', 'bin', 'install.js');
  const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-install-')));
  t.after(() => cleanup(cfg));

  const run = (args) => {
    const result = runNode([installer, '--opencode', '--global', '--config-dir', cfg, ...args], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      // #3156: sandbox HOME — the installer writes <home>/.gsd/defaults.json via
      // os.homedir() directly, which no env scrub can reach. See installSpawnEnv.
      env: require('./helpers.cjs').installSpawnEnv(),
    });
    result.status = result.exitCode;
    return result;
  };

  // Install
  const install = run([]);
  assert.equal(install.status, 0, `install failed: ${install.stderr}`);

  const pluginPath = path.join(cfg, 'plugins', 'gsd-core.js');
  assert.ok(fs.existsSync(pluginPath), 'plugin must land at plugins/gsd-core.js (matches OpenCode {plugin,plugins}/*.{ts,js} glob)');
  assert.ok(!fs.existsSync(path.join(cfg, 'plugins', 'gsd-core.cjs')), 'must NOT ship a .cjs (never auto-discovered)');

  // Manifest records the plugin for drift/uninstall accounting.
  const manifest = JSON.parse(fs.readFileSync(path.join(cfg, 'gsd-file-manifest.json'), 'utf8'));
  assert.ok(manifest.files['plugins/gsd-core.js'], 'manifest must track plugins/gsd-core.js');

  // The installed plugin loads and resolves REPO_ROOT to the config dir.
  delete require.cache[require.resolve(pluginPath)];
  const installed = require(pluginPath);
  assert.equal(installed.id, 'gsd-core');
  assert.equal(installed.server._internals.REPO_ROOT, cfg);
  assert.equal(installed.server._internals.IS_PACKAGE_TREE, false);

  // Uninstall removes the plugin and prunes the (now empty) plugins/ dir.
  const uninstall = run(['--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}`);
  assert.ok(!fs.existsSync(pluginPath), 'plugin must be removed on uninstall');
  assert.ok(!fs.existsSync(path.join(cfg, 'plugins')), 'empty plugins/ dir must be pruned');
});

// ---------------------------------------------------------------------------
// #2697: context-monitor subprocess is skipped in-process when context_warnings
// is disabled, instead of paying a full Node boot inside the child only to exit.
// The plugin destructures spawnSync at require-time, so we intercept by
// monkeypatching require('child_process').spawnSync BEFORE loading the copied
// plugin, recording every spawn's argv. Restore in t.after.
// ---------------------------------------------------------------------------

/**
 * Build an installed layout, intercept spawnSync, and return { handlers, spawns, projectDir }.
 * `planningConfig` (object|null) is written to <projectDir>/.planning/config.json; null = absent.
 */
async function buildLayoutWithSpawnTrace(t, { stubHooks, planningConfig }) {
  const cp = require('node:child_process');
  const spawns = [];
  const realSpawnSync = cp.spawnSync;
  // IMPORTANT: the plugin destructures spawnSync at require-time
  // (`const { spawnSync } = require("child_process")`), so the patch MUST be in
  // place BEFORE buildInstalledLayout requires the copied plugin, or the plugin
  // captures the original spawnSync and our trace records nothing.
  cp.spawnSync = (...args) => {
    spawns.push(args);
    // Return an allow/no-op result so the adapter's handleHookResult path completes.
    return { stdout: '', status: 0, signal: null };
  };
  t.after(() => { cp.spawnSync = realSpawnSync; });

  const { mod } = buildInstalledLayout(t, stubHooks || {});

  // Project dir is the cwd the plugin reads config from (currentCwd).
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-proj-')));
  t.after(() => cleanup(projectDir));
  if (planningConfig !== null) {
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(planningConfig),
    );
  }

  const handlers = await mod.server({ directory: projectDir });
  // Establish an active session — the context-monitor dispatch is gated on
  // currentSessionId, which session.created populates. Without this the gate
  // short-circuits on the first operand (null) and the toggle is never reached,
  // making the "disabled" assertions pass vacuously and the "enabled" ones fail.
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: projectDir } } },
  });
  return { handlers, spawns, projectDir };
}

function spawnTargetedMonitor(spawns) {
  return spawns.some((a) => {
    const argv = a[1];
    return Array.isArray(argv) && argv.some((s) => String(s).includes('gsd-context-monitor.js'));
  });
}

test('#2697: context-monitor subprocess is skipped when context_warnings is disabled', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: false } },
  });
  // Bash is a non-Read tool → reaches the context-monitor dispatch.
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    !spawnTargetedMonitor(spawns),
    `context-monitor spawn must be skipped when context_warnings:false; spawn argvs: ${JSON.stringify(spawns)}`,
  );
});

test('#2697: context-monitor subprocess still runs when config is absent (default enabled)', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: null,
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must still occur when the config toggle is absent (default = enabled)',
  );
});

test('#2697: context-monitor subprocess runs when context_warnings explicitly true', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: true } },
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must occur when context_warnings is explicitly true',
  );
});

test('#2697: context-monitor subprocess runs when config.json is unparseable (defaults enabled)', async (t) => {
  const cp = require('node:child_process');
  const spawns = [];
  const realSpawnSync = cp.spawnSync;
  // Patch BEFORE requiring the plugin (it destructures spawnSync at require-time).
  cp.spawnSync = (...args) => { spawns.push(args); return { stdout: '', status: 0, signal: null }; };
  t.after(() => { cp.spawnSync = realSpawnSync; });

  const { mod } = buildInstalledLayout(t, { 'gsd-context-monitor.js': stubHook('') });
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-proj-')));
  t.after(() => cleanup(projectDir));
  fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  // Malformed JSON → the in-process check must treat it as "enabled" (Postel: conservative).
  fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), '{ not valid json');

  const handlers = await mod.server({ directory: projectDir });
  // Establish an active session (the dispatch is gated on currentSessionId).
  await handlers.event({
    event: { type: 'session.created', properties: { info: { id: 's1', directory: projectDir } } },
  });
  await handlers['tool.execute.after']({ tool: 'bash', args: { command: 'echo hi' } }, {});
  assert.ok(
    spawnTargetedMonitor(spawns),
    'context-monitor spawn must occur when config.json is unparseable (defaults = enabled)',
  );
});

test('#2697: context-monitor skipped for Write when context_warnings disabled (not Bash-specific)', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: { 'gsd-context-monitor.js': stubHook('') },
    planningConfig: { hooks: { context_warnings: false } },
  });
  // Write reaches context-monitor dispatch (non-Read); the guard hooks run before it
  // via tool.execute.before, not here, so the after-handler only hits the monitor.
  await handlers['tool.execute.after'](
    { tool: 'write', args: { filePath: '/proj/a.md', content: 'x' } },
    {},
  );
  assert.ok(
    !spawnTargetedMonitor(spawns),
    `context-monitor spawn must be skipped for Write when context_warnings:false; spawn argvs: ${JSON.stringify(spawns)}`,
  );
});

// Bun exposes every own property of module.exports, non-enumerable ones
// included, as a named namespace export; Node's namespace is `{ default }` only.
function bunNamespace(raw) {
  const ns = { default: raw };
  for (const key of Object.getOwnPropertyNames(raw)) ns[key] = raw[key];
  return ns;
}

// Emulates the OpenCode 2.x `Module` decode of the namespace default export.
function v2Decode(ns) {
  const d = ns.default;
  const missing = [];
  if (typeof d.id !== 'string') missing.push('["default"]["id"]');
  if (typeof (d.setup ?? d.effect) !== 'function') {
    missing.push('["default"]["effect"]', '["default"]["setup"]');
  }
  if (missing.length) throw new Error('Missing key at ' + missing.join(' / '));
  return 'effect' in d ? { id: d.id, effect: d.effect } : { id: d.id, setup: d.setup };
}

test('V2 loader decode accepts the default export under the Node and Bun namespaces', () => {
  const raw = require(ADAPTER_SRC);
  assert.equal('effect' in raw, false);
  for (const ns of [{ default: raw }, bunNamespace(raw)]) {
    const decoded = v2Decode(ns);
    assert.equal(decoded.id, 'gsd-core');
    assert.equal(typeof decoded.setup, 'function');
    assert.equal('effect' in decoded, false);
  }
});

test('V2 decode emulation rejects a server-only default with the missing setup/effect shape', () => {
  const it = { server() {} };
  Object.defineProperty(it, 'id', { value: 'gsd-core', enumerable: false });
  assert.throws(
    () => v2Decode({ default: it }),
    /^Error: Missing key at \["default"\]\["effect"\] \/ \["default"\]\["setup"\]$/,
  );
});

test('setup is non-enumerable, callable unbound, awaits its hook registrations and resolves a cleanup function', async () => {
  const raw = require(ADAPTER_SRC);
  const desc = Object.getOwnPropertyDescriptor(raw, 'setup');
  assert.equal(desc.enumerable, false);
  assert.equal(desc.writable, false);
  assert.equal(desc.configurable, false);
  const { setup } = v2Decode(bunNamespace(raw));
  const { hooks, settled, ctx } = fakeV2Ctx(os.tmpdir());
  const cleanup = await setup(ctx);
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.deepEqual(settled, Object.keys(hooks));
  cleanup();
});

// Emulates OpenCode >= 1.4 `readV1Plugin(mod.default, spec, "server", "detect")`;
// a null result means the host falls back to its legacy Object.values loop.
function readV1PluginDetect(mod) {
  const d = mod.default;
  if (!d || typeof d !== 'object') return null;
  if (!('server' in d) && !('id' in d)) return null;
  if ('tui' in d && 'server' in d) throw new Error('Plugin exports both server and tui');
  if (typeof d.server !== 'function') throw new TypeError('Plugin server export is not a function');
  if (typeof d.id !== 'string' || d.id === '') throw new Error('Path plugin must export a non-empty id');
  return { id: d.id, server: d.server };
}

test('raw require exposes only server as an enumerable key; id and setup stay non-enumerable', () => {
  const raw = require(ADAPTER_SRC);
  assert.deepEqual(Object.keys(raw), ['server']);
  assert.equal(Object.getOwnPropertyDescriptor(raw, 'id').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(raw, 'setup').enumerable, false);
  const servers = loaderExtract(raw);
  assert.equal(servers.length, 1);
  assert.equal(servers[0], raw.server);
});

test('V1 readV1Plugin detect path on the Bun namespace selects default.server and never reads setup', () => {
  const raw = require(ADAPTER_SRC);
  const ns = bunNamespace(raw);
  assert.ok(Object.keys(ns).includes('id'));
  assert.ok(Object.keys(ns).includes('setup'));
  const seen = [];
  ns.default = new Proxy(raw, {
    get(target, key, receiver) { seen.push(key); return Reflect.get(target, key, receiver); },
    has(target, key) { seen.push(key); return Reflect.has(target, key); },
  });
  const detected = readV1PluginDetect(ns);
  assert.equal(detected.server, raw.server);
  assert.equal(detected.id, 'gsd-core');
  assert.ok(!seen.includes('setup'), `detect path read setup: ${seen.map(String).join(", ")}`);
});

// Opaque passthrough value: hookSpawnOptions never spawns, it only copies options.
const HOOK_SPAWN_BASE_TIMEOUT_MS = 8000;
const HOOK_SPAWN_BASE = { input: '{}', encoding: 'utf8', timeout: HOOK_SPAWN_BASE_TIMEOUT_MS, cwd: os.tmpdir(), windowsHide: true };

test('hookSpawnOptions leaves Node spawn options untouched (no env key)', () => {
  const out = _internals.hookSpawnOptions(HOOK_SPAWN_BASE, { node: '24.0.0' });
  assert.deepEqual(out, HOOK_SPAWN_BASE);
  assert.equal(Object.hasOwn(out, 'env'), false);
});

test('hookSpawnOptions adds BUN_BE_BUN=1 to a copy of process.env under Bun', () => {
  const before = process.env.BUN_BE_BUN;
  const out = _internals.hookSpawnOptions(HOOK_SPAWN_BASE, { node: '24.3.0', bun: '1.4.2' });
  assert.notEqual(out, HOOK_SPAWN_BASE);
  for (const key of Object.keys(HOOK_SPAWN_BASE)) assert.equal(out[key], HOOK_SPAWN_BASE[key]);
  assert.equal(out.env.BUN_BE_BUN, '1');
  assert.equal(out.env.PATH, process.env.PATH);
  assert.equal(Object.hasOwn(HOOK_SPAWN_BASE, 'env'), false);
  assert.equal(process.env.BUN_BE_BUN, before);
});

test('runHook under Node spawns process.execPath with no env override', async (t) => {
  const { handlers, spawns } = await buildLayoutWithSpawnTrace(t, {
    stubHooks: {
      'gsd-prompt-guard.js': stubHook(''),
      'gsd-read-guard.js': stubHook(''),
      'gsd-worktree-path-guard.js': stubHook(''),
      'gsd-workflow-guard.js': stubHook(''),
    },
    planningConfig: null,
  });
  await handlers['tool.execute.before']({ tool: 'write' }, { args: { filePath: '/proj/notes.md', content: 'ok' } });
  assert.ok(spawns.length > 0);
  for (const entry of spawns) {
    assert.equal(entry[0], process.execPath);
    assert.equal(Object.hasOwn(entry[2], 'env'), false);
  }
});

test('V1 server() picked from a Bun namespace by the detect path runs the secret-read guard in a subprocess and blocks', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-secret-read-guard.js': stubHook(JSON.stringify({ decision: 'block', code: 'secret-read', reason: 'secret read denied' }), 2),
  });
  const detected = readV1PluginDetect(bunNamespace(mod));
  assert.equal(detected.id, 'gsd-core');
  assert.equal(detected.server, mod.server);
  const handlers = await detected.server({ directory: process.cwd() });
  await assert.rejects(
    () => handlers['tool.execute.before']({ tool: 'read' }, { args: { filePath: '/p/.env' } }),
    /secret read denied/,
  );

  const { mod: allowMod } = buildInstalledLayout(t, { 'gsd-secret-read-guard.js': stubHook('') });
  const allowHandlers = await readV1PluginDetect(bunNamespace(allowMod)).server({ directory: process.cwd() });
  await assert.doesNotReject(() =>
    allowHandlers['tool.execute.before']({ tool: 'read' }, { args: { filePath: '/p/notes.md' } }),
  );
});

// A V2 event stream the test feeds by hand. The promise push() returns settles
// once the consumer pulls again (it finished that event) or the stream stops.
function fakeEventStream() {
  const queue = [];
  let inFlight = null;
  let parked = null;
  let ended = false;
  let failure = null;
  const settleAll = () => {
    if (inFlight) inFlight();
    inFlight = null;
    for (const item of queue.splice(0)) item.settle();
  };
  const unpark = () => {
    const pull = parked;
    parked = null;
    events.waiting = false;
    return pull;
  };
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (inFlight) inFlight();
      inFlight = null;
      if (events.signal.aborted) return Promise.reject(events.signal.reason);
      if (ended) return Promise.resolve({ done: true, value: undefined });
      if (failure) {
        const err = failure;
        failure = null;
        ended = true;
        return Promise.reject(err);
      }
      if (queue.length) {
        const item = queue.shift();
        inFlight = item.settle;
        return Promise.resolve({ done: false, value: item.event });
      }
      return new Promise((resolve, reject) => {
        parked = { resolve, reject };
        events.waiting = true;
      });
    },
    return() {
      ended = true;
      settleAll();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const events = {
    subscriptions: 0,
    signal: undefined,
    waiting: false,
    subscribe({ signal }) {
      events.subscriptions += 1;
      events.signal = signal;
      signal.addEventListener('abort', () => {
        settleAll();
        if (parked && events.bufferedAtAbort) unpark().resolve({ done: false, value: events.bufferedAtAbort });
        if (parked) unpark().reject(signal.reason);
      });
      return iterator;
    },
    push(event) {
      if (ended || events.signal?.aborted) return Promise.resolve();
      return new Promise((settle) => {
        if (parked) {
          inFlight = settle;
          unpark().resolve({ done: false, value: event });
        } else {
          queue.push({ event, settle });
        }
      });
    },
    end() {
      ended = true;
      settleAll();
      if (parked) unpark().resolve({ done: true, value: undefined });
    },
    fail(err) {
      if (parked) {
        ended = true;
        unpark().reject(err);
      } else {
        failure = err;
      }
    },
  };
  return events;
}

// Records V2 Promise-API hook registrations. Each registration settles on a
// later turn, so a setup that does not await it leaves `settled` short.
function fakeV2Ctx(directory) {
  const events = fakeEventStream();
  const hooks = {};
  const settled = [];
  const domain = (ns) => ({
    hook(name, fn) {
      const key = `${ns}.${name}`;
      hooks[key] = fn;
      return new Promise((resolve) => setImmediate(() => {
        settled.push(key);
        resolve({ dispose() {} });
      }));
    },
  });
  return { hooks, settled, events, ctx: { location: { directory }, tool: domain('tool'), shell: domain('shell'), session: domain('session'), event: { subscribe: events.subscribe } } };
}

test('V2 setup bridges execute.before: a shell read of .env is blocked with the guard reason, an allowed write resolves', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-prompt-guard.js': stubHook(''),
    'gsd-read-guard.js': stubHook(''),
    'gsd-worktree-path-guard.js': stubHook(''),
    'gsd-write-guard.js': stubHook(''),
    'gsd-workflow-guard.js': stubHook(''),
    'gsd-secret-read-guard.js': stubHook(JSON.stringify({ decision: 'block', code: 'secret-read', reason: 'secret read denied' }), 2),
  });
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(process.cwd());
  await setup(ctx);
  const ev = { id: 'c1', tool: 'shell', sessionID: 's1', input: { command: 'cat .env' } };
  await assert.rejects(() => hooks['tool.execute.before'](ev), /secret read denied/);
  assert.equal(ev.tool, 'shell');
  await assert.doesNotReject(() =>
    hooks['tool.execute.before']({ id: 'c2', tool: 'write', sessionID: 's1', input: { path: '/proj/notes.md', content: 'ok' } }),
  );
});

const ALL_GUARD_STUBS = Object.fromEntries([
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-write-guard.js',
  'gsd-workflow-guard.js',
  'gsd-secret-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-context-monitor.js',
].map((name) => [name, stubHook('')]));

// The plugin captures spawnSync at require time, so patch it before loading.
function loadTracedPlugin(t, stubHooks, respond = () => ({ stdout: '', status: 0, signal: null })) {
  const cp = require('node:child_process');
  const spawns = [];
  const realSpawnSync = cp.spawnSync;
  cp.spawnSync = (...args) => {
    spawns.push(args);
    return respond(args);
  };
  t.after(() => { cp.spawnSync = realSpawnSync; });
  const { root, mod } = buildInstalledLayout(t, stubHooks);
  return { root, mod, spawns };
}

function spawnedHooks(spawns) {
  return spawns.map((call) => path.basename(call[1][0]));
}

function makeProjectDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-proj-')));
  t.after(() => cleanup(dir));
  return dir;
}

test('V1 server() and V2 setup() spawn the same PreToolUse hooks in the same order for each tool pair', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const projectDir = makeProjectDir(t);
  const F = path.join(projectDir, 'notes.md');
  const v1 = await mod.server({ directory: projectDir });
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const cases = [
    ['write', { filePath: F, content: 'x' }, 'write', { path: F, content: 'x' }],
    ['edit', { filePath: F, oldString: 'a', newString: 'b' }, 'edit', { path: F, oldString: 'a', newString: 'b' }],
    ['bash', { command: 'git add -f x' }, 'shell', { command: 'git add -f x' }],
    ['bash', {}, 'shell', {}],
    ['apply_patch', { patchText: '*** Begin Patch' }, 'patch', { patchText: '*** Begin Patch' }],
    ['read', { filePath: '/p/.env' }, 'read', { path: '/p/.env' }],
    ['grep', { pattern: 'K', path: '/p', include: '.env*' }, 'grep', { pattern: 'K', path: '/p', include: '.env*' }],
    ['task', { prompt: 'x' }, 'subagent', { agent: 'a', description: 'd', prompt: 'x' }],
    ['glob', { pattern: '*' }, 'glob', { pattern: '*' }],
  ];
  const v2Lists = {};
  for (const [v1Tool, v1Args, v2Tool, v2Input] of cases) {
    await v1['tool.execute.before']({ tool: v1Tool }, { args: v1Args });
    const v1List = spawnedHooks(spawns.splice(0));
    await hooks['tool.execute.before']({ id: 'c', tool: v2Tool, sessionID: 's1', input: v2Input });
    const v2List = spawnedHooks(spawns.splice(0));
    assert.deepEqual(v2List, v1List, `${v1Tool} -> ${v2Tool}`);
    v2Lists[`${v2Tool} ${JSON.stringify(v2Input)}`] = v2List;
  }

  assert.deepEqual(v2Lists['shell {"command":"git add -f x"}'], ['gsd-workflow-guard.js', 'gsd-secret-read-guard.js']);
  assert.deepEqual(v2Lists['shell {}'], ['gsd-workflow-guard.js', 'gsd-secret-read-guard.js']);
  assert.deepEqual(v2Lists['patch {"patchText":"*** Begin Patch"}'], ['gsd-worktree-path-guard.js', 'gsd-workflow-guard.js']);
  assert.deepEqual(v2Lists['subagent {"agent":"a","description":"d","prompt":"x"}'], []);
  assert.deepEqual(v2Lists['glob {"pattern":"*"}'], []);
  for (const [key, list] of Object.entries(v2Lists)) {
    if (key.startsWith('subagent ') || key.startsWith('glob ')) continue;
    assert.ok(list.length > 0, `${key} spawned no hook`);
  }

  assert.equal(_internals.mapToolName('shell'), 'shell');
  assert.equal(_internals.mapToolName('patch'), 'patch');
});

test('each V2 location runs its guards in its own directory when calls interleave', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const dirA = makeProjectDir(t);
  const dirB = makeProjectDir(t);
  const a = fakeV2Ctx(dirA);
  const b = fakeV2Ctx(dirB);
  const { setup } = mod;
  await setup(a.ctx);
  await setup(b.ctx);

  for (const [loc, dir] of [[a, dirA], [b, dirB], [a, dirA]]) {
    await loc.hooks['tool.execute.before']({
      id: 'c', tool: 'write', sessionID: 's', input: { path: path.join(dir, 'notes.md'), content: 'x' },
    });
    const calls = spawns.splice(0);
    assert.ok(calls.length > 0);
    for (const entry of calls) {
      assert.equal(entry[2].cwd, dir);
      assert.equal(JSON.parse(entry[2].input).cwd, dir);
    }
  }
});

test('V2 Read redirect rewrites ev.input.path in place and leaves other paths alone', async (t) => {
  const { root, mod } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const projectDir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const input = { path: '~/.claude/gsd-core/workflows/x.md' };
  const ev = { id: 'c', tool: 'read', sessionID: 's1', input };
  await hooks['tool.execute.before'](ev);
  assert.equal(ev.input, input);
  assert.equal(input.path, path.join(root, 'gsd-core') + '/workflows/x.md');

  const other = { path: '/p/notes.md' };
  const otherEv = { id: 'c2', tool: 'read', sessionID: 's1', input: other };
  await hooks['tool.execute.before'](otherEv);
  assert.equal(otherEv.input, other);
  assert.equal(other.path, '/p/notes.md');
});

test('V2 execute.after rewrites a managed Read result before the injection scanner sees it and skips the context monitor', async (t) => {
  const { root, mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const projectDir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const managed = path.join(root, 'gsd-core', 'workflows', 'x.md');
  const expected = path.join(root, 'gsd-core') + '/references/foo.md';
  const original = '1: see ~/.claude/gsd-core/references/foo.md';
  const result = { content: original, output: 'raw', metadata: { lines: 1 } };
  const ev = { id: 'c1', tool: 'read', sessionID: 's1', input: { path: managed }, status: 'completed', result };
  await hooks['tool.execute.after'](ev);

  assert.notEqual(ev.result, result);
  assert.ok(ev.result.content.includes(expected), `expected "${expected}" in: ${ev.result.content}`);
  assert.ok(!ev.result.content.includes('~/.claude/gsd-core/'));
  assert.equal(ev.result.output, 'raw');
  assert.equal(ev.result.metadata.lines, 1);
  assert.equal(result.content, original);
  assert.deepEqual(spawnedHooks(spawns), ['gsd-read-injection-scanner.js']);
  assert.equal(JSON.parse(spawns[0][2].input).tool_response, ev.result.content);
});

test('V2 execute.after does nothing unless the call completed, and passes non-string content through untouched', async (t) => {
  const { root, mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const projectDir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const errorEv = { id: 'c1', tool: 'shell', sessionID: 's1', input: { command: 'ls' }, status: 'error', error: new Error('x') };
  await hooks['tool.execute.after'](errorEv);
  assert.equal(spawns.length, 0);
  assert.equal(Object.hasOwn(errorEv, 'result'), false);

  const managed = path.join(root, 'gsd-core', 'workflows', 'x.md');
  const parts = [{ type: 'text', text: 'see ~/.claude/gsd-core/x' }];
  const ev = { id: 'c2', tool: 'read', sessionID: 's1', input: { path: managed }, status: 'completed', result: { content: parts } };
  await hooks['tool.execute.after'](ev);
  assert.equal(ev.result.content, parts);
  assert.equal(parts[0].text, 'see ~/.claude/gsd-core/x');
});

test('V2 execute.after attributes the context monitor to ev.sessionID and the location directory, and never reuses a stale session', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const dirA = makeProjectDir(t);
  const dirB = makeProjectDir(t);
  const a = fakeV2Ctx(dirA);
  const b = fakeV2Ctx(dirB);
  const { setup } = mod;
  await setup(a.ctx);
  await setup(b.ctx);

  for (const [loc, dir, sessionID] of [[a, dirA, 'sA'], [b, dirB, 'sB']]) {
    await loc.hooks['tool.execute.after']({
      id: 'c', tool: 'shell', sessionID, input: { command: 'ls' }, status: 'completed', result: { content: 'ok' },
    });
    const calls = spawns.splice(0);
    assert.deepEqual(spawnedHooks(calls), ['gsd-context-monitor.js']);
    const payload = JSON.parse(calls[0][2].input);
    assert.equal(payload.session_id, sessionID);
    assert.equal(payload.cwd, dir);
    assert.equal(calls[0][2].cwd, dir);
  }

  await a.hooks['tool.execute.after']({
    id: 'c', tool: 'shell', input: { command: 'ls' }, status: 'completed', result: { content: 'ok' },
  });
  assert.deepEqual(spawnedHooks(spawns.splice(0)), []);
});

test('V2 execute.after puts scanner advisories in a new metadata object and propagates a scanner block', async (t) => {
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  t.after(() => { console.error = realError; });
  const projectDir = makeProjectDir(t);
  const readEv = (result) => ({
    id: 'c', tool: 'read', sessionID: 's1', input: { path: '/p/notes.md' }, status: 'completed', result,
  });

  const advisory = buildInstalledLayout(t, {
    'gsd-read-injection-scanner.js': stubHook(JSON.stringify({ hookSpecificOutput: { additionalContext: 'heads up' } })),
  });
  const first = fakeV2Ctx(projectDir);
  await advisory.mod.setup(first.ctx);
  const ev = readEv({ content: 'plain text', metadata: Object.freeze({ lines: 1 }) });
  await assert.doesNotReject(() => first.hooks['tool.execute.after'](ev));
  assert.deepEqual(ev.result.metadata, { lines: 1, _gsdAdvisory: ['heads up'] });
  assert.equal(ev.result.content, 'plain text');
  assert.ok(errors.some((line) => line.includes('heads up')));

  const blocking = buildInstalledLayout(t, {
    'gsd-read-injection-scanner.js': stubHook(JSON.stringify({ decision: 'block', reason: 'injection found' }), 2),
  });
  const second = fakeV2Ctx(projectDir);
  await blocking.mod.setup(second.ctx);
  await assert.rejects(
    () => second.hooks['tool.execute.after'](readEv({ content: 'plain text' })),
    /injection found/,
  );
});

test('V1 server() and V2 setup() spawn the same PostToolUse hooks in the same order for each tool pair', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const projectDir = makeProjectDir(t);
  const F = path.join(projectDir, 'notes.md');
  const v1 = await mod.server({ directory: projectDir });
  await v1.event({ event: { type: 'session.created', properties: { info: { id: 's1', directory: projectDir } } } });
  spawns.splice(0);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const cases = [
    ['read', { filePath: '/p/a.md' }, 'read', { path: '/p/a.md' }],
    ['webfetch', { url: 'https://example.com' }, 'webfetch', { url: 'https://example.com' }],
    ['websearch', { query: 'q' }, 'websearch', { query: 'q' }],
    ['bash', { command: 'ls' }, 'shell', { command: 'ls' }],
    ['task', { prompt: 'x' }, 'subagent', { agent: 'a', description: 'd', prompt: 'x' }],
    ['write', { filePath: F, content: 'x' }, 'write', { path: F, content: 'x' }],
    ['edit', { filePath: F, oldString: 'a', newString: 'b' }, 'edit', { path: F, oldString: 'a', newString: 'b' }],
    ['apply_patch', { patchText: '*** Begin Patch' }, 'patch', { patchText: '*** Begin Patch' }],
  ];
  const v2Lists = {};
  for (const [v1Tool, v1Args, v2Tool, v2Input] of cases) {
    await v1['tool.execute.after']({ tool: v1Tool, args: v1Args }, { output: 'text' });
    const v1List = spawnedHooks(spawns.splice(0));
    await hooks['tool.execute.after']({
      id: 'c', tool: v2Tool, sessionID: 's1', input: v2Input, status: 'completed', result: { content: 'text' },
    });
    const v2List = spawnedHooks(spawns.splice(0));
    assert.deepEqual(v2List, v1List, `${v1Tool} -> ${v2Tool}`);
    assert.ok(v2List.length > 0, `${v2Tool} spawned no hook`);
    v2Lists[v2Tool] = v2List;
  }

  assert.deepEqual(v2Lists.shell, ['gsd-context-monitor.js']);
  assert.deepEqual(v2Lists.subagent, ['gsd-context-monitor.js']);
  assert.deepEqual(v2Lists.read, ['gsd-read-injection-scanner.js']);
});

test('V2 shell create.before sets GSD_DIR on the host env object in place, keeps every other key, and is idempotent', async (t) => {
  const { root, mod } = buildInstalledLayout(t, {});
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(process.cwd());
  await setup(ctx);

  const env = { PATH: 'p', HOME: 'h', GSD_DIR: 'old' };
  const ev = { command: 'ls', cwd: '/', env };
  await hooks['shell.create.before'](ev);
  await hooks['shell.create.before'](ev);
  assert.equal(ev.env, env);
  assert.deepEqual(env, { PATH: 'p', HOME: 'h', GSD_DIR: path.join(root, 'gsd-core') });
});

test('V2 shell create.before never throws and never creates an env', async (t) => {
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  t.after(() => { console.error = realError; });
  const { mod } = buildInstalledLayout(t, {});
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(process.cwd());
  await setup(ctx);

  const frozen = Object.freeze({ PATH: 'p' });
  const frozenEv = { command: 'ls', env: frozen };
  await assert.doesNotReject(() => hooks['shell.create.before'](frozenEv));
  assert.equal(frozenEv.env, frozen);
  assert.equal(Object.hasOwn(frozen, 'GSD_DIR'), false);
  assert.ok(errors.some((line) => line.startsWith('[gsd-core]')));

  const bareEv = { command: 'ls' };
  await assert.doesNotReject(() => hooks['shell.create.before'](bareEv));
  assert.equal(Object.hasOwn(bareEv, 'env'), false);
});

// A stub hook that blocks only when tool_input.file_path equals blockedPath.
function pathBlockingHook(blockedPath, reason) {
  return `
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  const p=JSON.parse(d||'{}');
  if((p.tool_input||{}).file_path===${JSON.stringify(blockedPath)}){
    process.stdout.write(JSON.stringify({decision:'block',reason:${JSON.stringify(reason)}}));
    process.exit(2);
  }
  process.exit(0);
});
`;
}

test('V2 patch: the worktree guard sees each patched path, and a blocked path fails the call', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-worktree-path-guard.js': pathBlockingHook('/outside/main/src/x.js', 'outside worktree'),
    'gsd-workflow-guard.js': stubHook(''),
  });
  const projectDir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(projectDir);
  await setup(ctx);

  const blocked = [
    '*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y',
    '*** Add File: /outside/main/src/x.js', '+z', '*** End Patch',
  ].join('\n');
  await assert.rejects(
    () => hooks['tool.execute.before']({ id: 'c1', tool: 'patch', sessionID: 's1', input: { patchText: blocked } }),
    /outside worktree/,
  );

  const allowed = ['*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y', '*** End Patch'].join('\n');
  await assert.doesNotReject(() =>
    hooks['tool.execute.before']({ id: 'c2', tool: 'patch', sessionID: 's1', input: { patchText: allowed } }),
  );
});

const MULTI_PATH_PATCH_LINES = [
  '*** Begin Patch',
  '*** Update File: src/a.js',
  '*** Move to: src/b.js',
  '@@',
  '-x',
  '+y',
  '*** Add File: /abs/c.js',
  '+*** Add File: nope',
  '*** Delete File: src/a.js',
  '*** End Patch',
];
const MULTI_PATH_PATCH = MULTI_PATH_PATCH_LINES.join('\n');

function hookPathPairs(spawns) {
  return spawns.map((call) => [path.basename(call[1][0]), JSON.parse(call[2].input).tool_input.file_path]);
}

async function bothHosts(t, respond) {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS, respond);
  const directory = makeProjectDir(t);
  const v1 = await mod.server({ directory });
  const { hooks, ctx } = fakeV2Ctx(directory);
  await mod.setup(ctx);
  return {
    spawns,
    v1: (patchText) => v1['tool.execute.before']({ tool: 'apply_patch' }, { args: patchText === undefined ? {} : { patchText } }),
    v2: (patchText) => hooks['tool.execute.before']({
      id: 'c', tool: 'patch', sessionID: 's1', input: patchText === undefined ? {} : { patchText },
    }),
  };
}

test('patchFilePaths takes Add, Update, Delete and both Move paths, trimmed, in first-seen order without duplicates', () => {
  const f = _internals.patchFilePaths;
  assert.deepEqual(f(MULTI_PATH_PATCH), ['src/a.js', 'src/b.js', '/abs/c.js']);
  assert.deepEqual(f(MULTI_PATH_PATCH_LINES.join('\r\n')), ['src/a.js', 'src/b.js', '/abs/c.js']);
  assert.deepEqual(f('*** Add File:   spaced name.txt  '), ['spaced name.txt']);
  for (const empty of ['*** Begin Patch\n*** End Patch', 'not a patch', '*** Add File:   ', undefined, null, 42, {}]) {
    assert.deepEqual(f(empty), [], JSON.stringify(empty));
  }
});

test('V1 apply_patch and V2 patch send the worktree and workflow guards every patched path in the same order', async (t) => {
  const host = await bothHosts(t);
  const expected = [
    ['gsd-worktree-path-guard.js', 'src/a.js'],
    ['gsd-worktree-path-guard.js', 'src/b.js'],
    ['gsd-worktree-path-guard.js', '/abs/c.js'],
    ['gsd-workflow-guard.js', 'src/a.js'],
    ['gsd-workflow-guard.js', 'src/b.js'],
    ['gsd-workflow-guard.js', '/abs/c.js'],
  ];
  await host.v1(MULTI_PATH_PATCH);
  assert.deepEqual(hookPathPairs(host.spawns.splice(0)), expected);
  await host.v2(MULTI_PATH_PATCH);
  assert.deepEqual(hookPathPairs(host.spawns.splice(0)), expected);
});

test('a patch stops at the first blocked path on both hosts', async (t) => {
  const allow = { stdout: '', status: 0, signal: null };
  const respond = (args) => {
    const payload = JSON.parse(args[2].input);
    return path.basename(args[1][0]) === 'gsd-worktree-path-guard.js' && payload.tool_input.file_path === 'src/b.js'
      ? { stdout: JSON.stringify({ decision: 'block', reason: 'blocked src/b.js' }), status: 2, signal: null }
      : allow;
  };
  const host = await bothHosts(t, respond);
  const expected = [['gsd-worktree-path-guard.js', 'src/a.js'], ['gsd-worktree-path-guard.js', 'src/b.js']];
  for (const run of [host.v1, host.v2]) {
    await assert.rejects(() => run(MULTI_PATH_PATCH), /blocked src\/b\.js/);
    assert.deepEqual(hookPathPairs(host.spawns.splice(0)), expected);
  }
});

test('a patch with no file header runs the worktree and workflow guards once with no file_path', async (t) => {
  const host = await bothHosts(t);
  for (const patchText of ['*** Begin Patch\n*** End Patch', 'not a patch', undefined]) {
    for (const run of [host.v1, host.v2]) {
      await run(patchText);
      const calls = host.spawns.splice(0);
      assert.deepEqual(spawnedHooks(calls), ['gsd-worktree-path-guard.js', 'gsd-workflow-guard.js'], String(patchText));
      for (const call of calls) {
        assert.equal(Object.hasOwn(JSON.parse(call[2].input).tool_input, 'file_path'), false);
      }
    }
  }
});

test('V1 write, edit and bash send the guards the same payloads as before', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, ALL_GUARD_STUBS);
  const directory = makeProjectDir(t);
  const F = path.join(directory, 'notes.md');
  const v1 = await mod.server({ directory });
  const cases = [
    ['write', { filePath: F, content: 'x' }, ['gsd-prompt-guard.js', 'gsd-read-guard.js', 'gsd-worktree-path-guard.js', 'gsd-write-guard.js', 'gsd-workflow-guard.js'], F],
    ['edit', { filePath: F, oldString: 'a', newString: 'b' }, ['gsd-prompt-guard.js', 'gsd-read-guard.js', 'gsd-worktree-path-guard.js', 'gsd-workflow-guard.js'], F],
    ['bash', { command: 'ls' }, ['gsd-workflow-guard.js', 'gsd-secret-read-guard.js'], undefined],
  ];
  for (const [tool, args, hooks, filePath] of cases) {
    await v1['tool.execute.before']({ tool }, { args });
    const calls = spawns.splice(0);
    assert.deepEqual(spawnedHooks(calls), hooks, tool);
    for (const call of calls) {
      const toolInput = JSON.parse(call[2].input).tool_input;
      if (filePath === undefined) assert.equal(Object.hasOwn(toolInput, 'file_path'), false, tool);
      else assert.equal(toolInput.file_path, filePath, tool);
    }
  }
});

test('patchFilePaths takes a header indented by any whitespace the host trims from a patch line', () => {
  const f = _internals.patchFilePaths;
  const leads = [' ', '\t', '  \t', '\v', '\f', '\r', ...[0x00a0, 0xfeff, 0x3000, 0x2028].map((c) => String.fromCharCode(c))];
  for (const lead of leads) {
    const patchText = ['*** Begin Patch', `${lead}*** Add File: /outside/main/src/x.js`, '+z', '*** End Patch'].join('\n');
    assert.deepEqual(f(patchText), ['/outside/main/src/x.js'], JSON.stringify(lead));
  }

  const mixed = [
    '*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y',
    '  *** Add File: /outside/main/src/x.js', '+z', '+ *** Add File: nope',
    '\t*** Update File: src/u.js', ' \t*** Move to: src/v.js', '\t*** Delete File: src/old.js', '*** End Patch',
  ];
  const expected = ['src/a.js', '/outside/main/src/x.js', 'src/u.js', 'src/v.js', 'src/old.js'];
  assert.deepEqual(f(mixed.join('\n')), expected);
  assert.deepEqual(f(mixed.join('\r\n')), expected);

  for (const body of ['+ *** Add File: nope', '+\t*** Add File: nope', '  *** Add File:   ']) {
    assert.deepEqual(f(body), [], JSON.stringify(body));
  }
  assert.deepEqual(f('*** Add File: /outside/a\rb.js'), ['/outside/a\rb.js']);
});

const patchWhitespaceArb = fc
  .array(fc.constantFrom(' ', '\t', '\v', '\f', '\r', ' ', '﻿', '　', ' '), { maxLength: 3 })
  .map((chars) => chars.join(''));
const singleLineArb = fc.string({ unit: 'binary' }).filter((s) => !s.includes('\n'));
const patchPathArb = fc.oneof(
  fc.constantFrom('src/a.js', 'src/b.js', '/abs/c.js', 'dir with space/d.txt', '../up/e.js'),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 24 }).filter((s) => !s.includes('\n') && s === s.trim()),
);
const patchHeaderArb = fc
  .record({
    kind: fc.constantFrom('Add File', 'Update File', 'Delete File', 'Move to'),
    lead: patchWhitespaceArb,
    gap: patchWhitespaceArb,
    tail: patchWhitespaceArb,
    path: patchPathArb,
  })
  .map(({ kind, lead, gap, tail, path: p }) => ({ text: `${lead}*** ${kind}: ${gap}${p}${tail}`, path: p }));
// No context lines (leading space): every line is trimmed, so a context line holding a header is extracted on purpose.
const patchBodyLineArb = fc.oneof(
  fc.constantFrom('@@', '*** End of File'),
  fc
    .tuple(fc.constantFrom('+', '-', '@@ '), fc.oneof(patchHeaderArb.map((h) => h.text), singleLineArb))
    .map(([prefix, rest]) => prefix + rest),
);

test('patchFilePaths property: takes every header path of a generated patch, in first-seen order without duplicates, and never a body line', () => {
  const itemArb = fc.oneof(patchHeaderArb, patchBodyLineArb.map((text) => ({ text })));
  fc.assert(
    fc.property(fc.array(itemArb, { maxLength: 12 }), fc.constantFrom('\n', '\r\n'), (items, eol) => {
      const text = ['*** Begin Patch', ...items.map((i) => i.text), '*** End Patch'].join(eol);
      const expected = [...new Set(items.filter((i) => 'path' in i).map((i) => i.path))];
      assert.deepEqual(_internals.patchFilePaths(text), expected, JSON.stringify(text));
    }),
    { seed: 4916, numRuns: 200, verbose: true },
  );
});

test('patchFilePaths property: never throws and returns unique, trimmed, non-empty single-line paths for any input', () => {
  fc.assert(
    fc.property(fc.anything().filter((v) => typeof v !== 'string'), (value) => {
      assert.deepEqual(_internals.patchFilePaths(value), []);
    }),
    { seed: 4917, numRuns: 200, verbose: true },
  );
  const textArb = fc.oneof(
    fc.string({ unit: 'binary' }),
    fc.array(fc.oneof(patchHeaderArb.map((h) => h.text), fc.string({ unit: 'binary' }))).map((lines) => lines.join('\n')),
  );
  fc.assert(
    fc.property(textArb, (text) => {
      const out = _internals.patchFilePaths(text);
      assert.ok(Array.isArray(out));
      assert.equal(new Set(out).size, out.length);
      assert.ok(out.length <= text.split('\n').length);
      for (const p of out) {
        assert.ok(p.length > 0);
        assert.equal(p, p.trim());
        assert.equal(p.includes('\n'), false);
      }
    }),
    { seed: 4917, numRuns: 200, verbose: true },
  );
});

test('a patch header indented by a space or a tab still reaches the worktree guard on both hosts', async (t) => {
  const { mod } = buildInstalledLayout(t, {
    'gsd-worktree-path-guard.js': pathBlockingHook('/outside/main/src/x.js', 'outside worktree'),
    'gsd-workflow-guard.js': stubHook(''),
  });
  const directory = makeProjectDir(t);
  const v1 = await mod.server({ directory });
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(directory);
  await setup(ctx);

  for (const lead of [' ', '\t']) {
    const patchText = [
      '*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y',
      `${lead}*** Add File: /outside/main/src/x.js`, '+z', '*** End Patch',
    ].join('\n');
    await assert.rejects(
      () => v1['tool.execute.before']({ tool: 'apply_patch' }, { args: { patchText } }),
      /outside worktree/,
      JSON.stringify(lead),
    );
    await assert.rejects(
      () => hooks['tool.execute.before']({ id: 'c1', tool: 'patch', sessionID: 's1', input: { patchText } }),
      /outside worktree/,
      JSON.stringify(lead),
    );
  }
});

const LIFECYCLE_STUBS = {
  ...ALL_GUARD_STUBS,
  'gsd-ensure-canonical-path.js': stubHook(''),
  'gsd-check-update.js': stubHook(''),
  'gsd-config-reload.js': stubHook(''),
};

function v2SessionCreated(directory, sessionID, data = {}) {
  return {
    type: 'session.created',
    location: { directory },
    data: { sessionID, projectID: 'p', location: { directory }, slug: 'slug', version: 1, ...data },
  };
}

const SESSION_START_HOOKS = ['gsd-ensure-canonical-path.js', 'gsd-check-update.js'];

test('V2 setup starts the session event loop without waiting on it and returns a cleanup that aborts it', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  assert.equal(typeof cleanup, 'function');
  assert.equal(events.subscriptions, 1);
  assert.equal(events.signal.aborted, false);
  assert.equal(events.waiting, true);

  cleanup();
  assert.equal(events.signal.aborted, true);
  await events.push(v2SessionCreated(dir, 's2'));
  assert.deepEqual(spawns, []);
});

test('V2 session.created in this directory runs the SessionStart hooks once with the session id from data', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  t.after(cleanup);

  await events.push(v2SessionCreated(dir, 's1'));
  assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
  for (const call of spawns) {
    assert.deepEqual(JSON.parse(call[2].input), { hook_event_name: 'SessionStart', session_id: 's1', cwd: dir });
    assert.equal(call[2].cwd, dir);
  }

  spawns.splice(0);
  const { location, ...dataOnly } = v2SessionCreated(dir, 's3');
  assert.equal(location.directory, dir);
  await events.push(dataOnly);
  assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
  for (const call of spawns) {
    assert.deepEqual(JSON.parse(call[2].input), { hook_event_name: 'SessionStart', session_id: 's3', cwd: dir });
    assert.equal(call[2].cwd, dir);
  }
});

test('V2 session events from another directory, subagent sessions, other event types and V1-shaped payloads run no SessionStart hook', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const other = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  t.after(cleanup);

  const ignored = [
    v2SessionCreated(other, 'foreign'),
    { ...v2SessionCreated(dir, 'foreign-top'), location: { directory: other } },
    v2SessionCreated(dir, 'child', { parentID: 'parent' }),
    { type: 'session.execution.succeeded', location: { directory: dir }, data: { sessionID: 's1' } },
    { type: 'filesystem.changed', location: { directory: dir }, data: { file: path.join(dir, 'a.txt'), event: 'change' } },
    { type: 'session.created', properties: { info: { id: 'v1', directory: dir } } },
  ];
  for (const event of ignored) {
    await events.push(event);
    assert.equal(spawns.length, 0, JSON.stringify(event));
  }
  assert.equal(events.waiting, true);
});

function captureErrors(t) {
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  t.after(() => { console.error = realError; });
  return errors;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('V2 session event loop logs a bad event without its contents and keeps running SessionStart for later sessions', async (t) => {
  const errors = captureErrors(t);
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  t.after(cleanup);

  await events.push({
    type: 'session.created',
    get location() { throw new Error('bad event'); },
    data: { sessionID: 'sX', title: 'TOPSECRET-TITLE' },
  });
  assert.equal(errors.filter((line) => line.includes('[gsd-core]') && line.includes('bad event')).length, 1);
  assert.ok(!errors.some((line) => line.includes('TOPSECRET-TITLE')));
  assert.deepEqual(spawns, []);

  await events.push(v2SessionCreated(dir, 's1'));
  assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
  for (const call of spawns) assert.equal(JSON.parse(call[2].input).session_id, 's1');
});

test('V2 session event loop logs and stops when the stream fails or ends, and stays silent after cleanup', async (t) => {
  const errors = captureErrors(t);
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;

  const failing = fakeV2Ctx(dir);
  t.after(await setup(failing.ctx));
  failing.events.fail(new Error('stream broke'));
  await nextTurn();
  assert.ok(errors.some((line) => line.includes('[gsd-core]') && line.includes('stream broke')));

  const ending = fakeV2Ctx(dir);
  t.after(await setup(ending.ctx));
  const beforeEnd = errors.length;
  ending.events.end();
  await nextTurn();
  assert.equal(errors.length, beforeEnd + 1);
  assert.ok(errors[beforeEnd].startsWith('[gsd-core]'));
  await ending.events.push(v2SessionCreated(dir, 's1'));
  assert.deepEqual(spawns, []);

  const cleaned = fakeV2Ctx(dir);
  const cleanup = await setup(cleaned.ctx);
  const beforeCleanup = errors.length;
  cleanup();
  await nextTurn();
  assert.equal(errors.length, beforeCleanup);
});

test('V2 hot reload: after cleanup and a second setup, one session.created runs each SessionStart hook once', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const first = fakeV2Ctx(dir);
  const cleanup = await setup(first.ctx);
  cleanup();
  const second = fakeV2Ctx(dir);
  t.after(await setup(second.ctx));

  const event = v2SessionCreated(dir, 's1');
  await first.events.push(event);
  await second.events.push(event);
  assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
});

test('V2 session.created on the server-wide stream runs SessionStart only in the location it belongs to', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dirA = makeProjectDir(t);
  const dirB = makeProjectDir(t);
  const { setup } = mod;
  const a = fakeV2Ctx(dirA);
  const b = fakeV2Ctx(dirB);
  t.after(await setup(a.ctx));
  t.after(await setup(b.ctx));

  for (const [dir, sessionID] of [[dirA, 'sA'], [dirB, 'sB']]) {
    spawns.splice(0);
    const event = v2SessionCreated(dir, sessionID);
    await a.events.push(event);
    await b.events.push(event);
    assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
    for (const call of spawns) {
      const payload = JSON.parse(call[2].input);
      assert.equal(payload.cwd, dir);
      assert.equal(payload.session_id, sessionID);
      assert.equal(call[2].cwd, dir);
    }
  }
});

test('V2 setup still registers every guard hook and resolves a cleanup when event.subscribe throws', async (t) => {
  const errors = captureErrors(t);
  const { mod } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  ctx.event.subscribe = () => { throw new Error('no stream'); };
  const cleanup = await setup(ctx);
  assert.equal(typeof cleanup, 'function');
  for (const key of ['tool.execute.before', 'tool.execute.after', 'shell.create.before']) {
    assert.equal(typeof hooks[key], 'function', key);
  }
  assert.ok(errors.some((line) => line.includes('[gsd-core]') && line.includes('no stream')));
  assert.doesNotThrow(cleanup);
});

const blockWhile = (hookFile, reason, gate) => (args) => (
  gate.block && path.basename(args[1][0]) === hookFile
    ? { stdout: JSON.stringify({ decision: 'block', reason }), status: 2, signal: null }
    : { stdout: '', status: 0, signal: null }
);

test('V2 compaction runs the PreCompact context monitor for ev.sessionID and appends the V1 breadcrumb to ev.system without setting ev.result', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const v1 = await mod.server({ directory: dir });
  await v1.event({ event: { type: 'session.created', properties: { info: { id: 's1', directory: dir } } } });
  const v1Out = {};
  await v1['experimental.session.compacting']({}, v1Out);
  spawns.splice(0);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const existing = { type: 'text', text: 'host identity' };
  const ev = { sessionID: 's1', system: [existing] };
  await hooks['session.compaction'](ev);
  assert.deepEqual(spawnedHooks(spawns), ['gsd-context-monitor.js']);
  assert.deepEqual(JSON.parse(spawns[0][2].input), { hook_event_name: 'PreCompact', session_id: 's1', cwd: dir });
  assert.equal(spawns[0][2].cwd, dir);
  assert.equal(ev.system[0], existing);
  assert.equal(ev.system.length, 2);
  assert.deepEqual(ev.system.slice(1), v1Out.context.map((text) => ({ type: 'text', text })));
  assert.equal(Object.hasOwn(ev, 'result'), false);
});

test('V2 compaction never throws: a blocking monitor or an unwritable ev.system is logged and nothing is pushed', async (t) => {
  const errors = captureErrors(t);
  const gate = { block: true };
  const { mod } = loadTracedPlugin(t, LIFECYCLE_STUBS, blockWhile('gsd-context-monitor.js', 'monitor exploded', gate));
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const existing = { type: 'text', text: 'host identity' };
  const blocked = { sessionID: 's1', system: [existing] };
  await assert.doesNotReject(() => hooks['session.compaction'](blocked));
  assert.deepEqual(blocked.system, [existing]);
  assert.equal(Object.hasOwn(blocked, 'result'), false);
  assert.ok(errors.some((line) => line.includes('[gsd-core]') && line.includes('monitor exploded')));

  gate.block = false;
  const frozen = { sessionID: 's1', system: Object.freeze([]) };
  const beforeFrozen = errors.length;
  await assert.doesNotReject(() => hooks['session.compaction'](frozen));
  assert.equal(frozen.system.length, 0);
  assert.equal(Object.hasOwn(frozen, 'result'), false);
  assert.ok(errors.slice(beforeFrozen).some((line) => line.includes('[gsd-core]')));

  const missing = { sessionID: 's1' };
  await assert.doesNotReject(() => hooks['session.compaction'](missing));
  assert.equal(Object.hasOwn(missing, 'system'), false);
  assert.equal(Object.hasOwn(missing, 'result'), false);
});

test('V2 compaction without a sessionID spawns nothing, pushes nothing and never reuses an earlier session', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const first = { sessionID: 's1', system: [] };
  await hooks['session.compaction'](first);
  assert.deepEqual(spawnedHooks(spawns.splice(0)), ['gsd-context-monitor.js']);
  assert.equal(first.system.length, 1);

  const anonymous = { system: [] };
  await hooks['session.compaction'](anonymous);
  assert.deepEqual(spawns, []);
  assert.deepEqual(anonymous.system, []);
  assert.equal(Object.hasOwn(anonymous, 'result'), false);
});

const configOf = (dir) => path.join(dir, '.planning', 'config.json');

const completed = (tool, input, extra = {}) => ({
  id: 'c', tool, sessionID: 's1', input, status: 'completed', result: { content: 'ok' }, ...extra,
});

const reloadSpawns = (spawns) => spawns.filter((call) => path.basename(call[1][0]) === 'gsd-config-reload.js');

test('V2 execute.after runs gsd-config-reload after a completed write, edit or patch of the location config, resolving relative paths against the location', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const CFG = configOf(dir);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const patchText = ['*** Begin Patch', '*** Update File: .planning/config.json', '@@', '-a', '+b', '*** Add File: src/x.js', '+z', '*** End Patch'].join('\n');
  const cases = [
    completed('write', { path: CFG, content: '{}' }),
    completed('edit', { path: '.planning/config.json', oldString: 'a', newString: 'b' }),
    completed('patch', { patchText }),
  ];
  for (const ev of cases) {
    await hooks['tool.execute.after'](ev);
    const calls = spawns.splice(0);
    assert.deepEqual(spawnedHooks(calls), ['gsd-context-monitor.js', 'gsd-config-reload.js'], ev.tool);
    const [reload] = reloadSpawns(calls);
    assert.deepEqual(JSON.parse(reload[2].input), { hook_event_name: 'FileChanged', file_path: CFG, event: 'change', cwd: dir }, ev.tool);
    assert.equal(reload[2].cwd, dir, ev.tool);
  }
});

test('V2 execute.after runs no config reload for other files, other tools, reads, shell writes, failed calls or filesystem events', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const CFG = configOf(dir);
  const { setup } = mod;
  const { hooks, events, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const cases = [
    [completed('write', { path: path.join(dir, 'notes.md'), content: 'x' }), ['gsd-context-monitor.js']],
    [completed('edit', { path: 'other/config.json', oldString: 'a', newString: 'b' }), ['gsd-context-monitor.js']],
    [completed('patch', { patchText: '*** Begin Patch\n*** Add File: src/x.js\n+z\n*** End Patch' }), ['gsd-context-monitor.js']],
    [completed('read', { path: CFG }), ['gsd-read-injection-scanner.js']],
    [completed('shell', { command: 'echo {} > .planning/config.json' }), ['gsd-context-monitor.js']],
    [completed('write', { path: CFG, content: '{}' }, { status: 'error' }), []],
  ];
  for (const [ev, expected] of cases) {
    await hooks['tool.execute.after'](ev);
    assert.deepEqual(spawnedHooks(spawns.splice(0)), expected, JSON.stringify(ev.input));
  }

  await events.push({ type: 'filesystem.changed', location: { directory: dir }, data: { file: CFG, event: 'change' } });
  assert.deepEqual(spawns, []);
});

test('V2 config reload failure is logged and never fails the completed edit', async (t) => {
  const errors = captureErrors(t);
  const gate = { block: true };
  const { mod } = loadTracedPlugin(t, LIFECYCLE_STUBS, blockWhile('gsd-config-reload.js', 'reload exploded', gate));
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { hooks, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  const result = { content: 'written', metadata: { ok: true } };
  const ev = completed('write', { path: configOf(dir), content: '{}' }, { result });
  await assert.doesNotReject(() => hooks['tool.execute.after'](ev));
  assert.notEqual(ev.result, result);
  assert.equal(ev.result.content, 'written');
  assert.ok(errors.some((line) => line.includes('[gsd-core]') && line.includes('reload exploded')));
});

test('V2 config reload runs in the editing location directory when two locations interleave', async (t) => {
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dirA = makeProjectDir(t);
  const dirB = makeProjectDir(t);
  const a = fakeV2Ctx(dirA);
  const b = fakeV2Ctx(dirB);
  const { setup } = mod;
  t.after(await setup(a.ctx));
  t.after(await setup(b.ctx));

  const writeOf = (dir, sessionID) => ({ ...completed('write', { path: configOf(dir), content: '{}' }), sessionID });
  await Promise.all([
    a.hooks['tool.execute.after'](writeOf(dirA, 'sA')),
    b.hooks['tool.execute.after'](writeOf(dirB, 'sB')),
  ]);
  const reloads = reloadSpawns(spawns.splice(0));
  assert.equal(reloads.length, 2);
  const pairs = reloads.map((call) => {
    const payload = JSON.parse(call[2].input);
    assert.equal(call[2].cwd, payload.cwd);
    return [payload.cwd, payload.file_path];
  });
  assert.deepEqual(pairs.sort(), [[dirA, configOf(dirA)], [dirB, configOf(dirB)]].sort());

  await b.hooks['tool.execute.after']({ ...completed('write', { path: configOf(dirA), content: '{}' }), sessionID: 'sB' });
  assert.deepEqual(reloadSpawns(spawns), []);
});

test('V2 session event loop logs a non-Error stream rejection once and raises no unhandled rejection', async (t) => {
  const errors = captureErrors(t);
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const { mod } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  t.after(cleanup);
  assert.equal(typeof cleanup, 'function');
  assert.equal(events.waiting, true);

  events.fail(undefined);
  await nextTurn();
  assert.deepEqual(rejections, []);
  assert.equal(errors.filter((line) => line.startsWith('[gsd-core] event stream failed')).length, 1);
});

test('V2 session event loop logs a non-Error throw from one event and keeps running SessionStart for later sessions', async (t) => {
  const errors = captureErrors(t);
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  t.after(await setup(ctx));

  await events.push({
    type: 'session.created',
    get location() { throw null; },
    data: { sessionID: 'sX' },
  });
  assert.equal(errors.filter((line) => line.startsWith('[gsd-core] session event failed')).length, 1);
  assert.ok(!errors.some((line) => line.includes('event stream failed')));
  assert.deepEqual(spawns, []);

  await events.push(v2SessionCreated(dir, 's1'));
  assert.deepEqual(spawnedHooks(spawns), SESSION_START_HOOKS);
  for (const call of spawns) assert.equal(JSON.parse(call[2].input).session_id, 's1');
});

test('V2 session event loop runs no SessionStart hook for an event the host yields after cleanup', async (t) => {
  const errors = captureErrors(t);
  const { mod, spawns } = loadTracedPlugin(t, LIFECYCLE_STUBS);
  const dir = makeProjectDir(t);
  const { setup } = mod;
  const { events, ctx } = fakeV2Ctx(dir);
  const cleanup = await setup(ctx);
  assert.equal(events.waiting, true);

  events.bufferedAtAbort = v2SessionCreated(dir, 'late');
  cleanup();
  await nextTurn();
  assert.deepEqual(spawns, []);
  assert.deepEqual(errors, []);
});
