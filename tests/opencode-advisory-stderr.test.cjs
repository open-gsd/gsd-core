'use strict';

/**
 * opencode-advisory-stderr.test.cjs — a hook advisory is never written to the process stderr (#5648).
 *
 * OpenCode's TUI draws a plugin's stderr over the prompt input, so the read-before-edit reminder showed
 * as red text on top of the input field. Advisories reach the model through the tool output (OpenCode)
 * and `metadata._gsdAdvisory` (both plugins); the stderr write added nothing. The real hook scripts from
 * hooks/dist run under the real plugin files, for both the OpenCode plugin and its Kilo mirror. The text
 * each plugin must carry is the text the hook itself emitted, read from the hook, not restated here.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const HOOKS_DIST = path.join(ROOT, 'hooks', 'dist');
const PLUGINS = [
  { name: 'OpenCode', src: path.join(ROOT, '.opencode', 'plugins', 'gsd-core.js'), appendsToOutput: true },
  { name: 'Kilo', src: path.join(ROOT, '.kilo', 'plugins', 'gsd-core.js'), appendsToOutput: false },
];
const BLOCK_FALLBACK = 'Blocked by GSD hook (no reason provided).';

// The read guard stays silent under Claude Code, so the session markers a developer's own shell carries
// would turn every advisory case into a silent allow.
const CLAUDE_MARKERS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_SESSION_ID', 'CLAUDECODE'];

async function load(t, pluginSrc) {
  const saved = {};
  for (const key of CLAUDE_MARKERS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => {
    for (const key of CLAUDE_MARKERS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const root = fs.realpathSync(createTempDir('gsd-adv-stderr-'));
  t.after(() => cleanup(root));
  fs.cpSync(path.join(ROOT, 'gsd-core', 'bin', 'lib'), path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.cpSync(HOOKS_DIST, path.join(root, 'hooks'), { recursive: true });
  const dest = path.join(root, 'plugins', 'gsd-core.js');
  fs.copyFileSync(pluginSrc, dest);
  delete require.cache[require.resolve(dest)];
  const mod = require(dest);

  const proj = fs.realpathSync(createTempDir('gsd-adv-stderr-proj-'));
  t.after(() => cleanup(proj));
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ mode: 'yolo' }));
  const existing = path.join(proj, 'existing.txt');
  fs.writeFileSync(existing, 'already here\n');
  const handlers = await mod.server({ directory: proj });
  return { handlers, proj, existing };
}

/** Run a staged hook the way the plugin does and return its exit status and parsed stdout (or null). */
function runHookDirect(script, payload, cwd) {
  const r = spawnSync(process.execPath, [path.join(HOOKS_DIST, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    windowsHide: true,
  });
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim()); } catch { /* no JSON on stdout */ }
  return { status: r.status, parsed };
}

/** Run `fn` while recording everything written to console.error and process.stderr. */
async function withStderrCaptured(fn) {
  const writes = [];
  const realConsoleError = console.error;
  const realStderrWrite = process.stderr.write;
  console.error = (...args) => { writes.push(args.join(' ')); };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    console.error = realConsoleError;
    process.stderr.write = realStderrWrite;
  }
  return writes;
}

const SKIP = process.platform === 'win32' ? 'node hook scripts spawn differently under the Windows harness' : false;

for (const plugin of PLUGINS) {
  test(`${plugin.name}: an advisory is not written to stderr and still reaches the model`, { skip: SKIP }, async (t) => {
    const { handlers, proj, existing } = await load(t, plugin.src);
    const before = { args: { filePath: existing, oldString: 'a', newString: 'b' }, metadata: {} };
    const after = { output: 'edited', metadata: {} };

    // The advisory this edit makes the read guard emit, read from the guard itself.
    const emitted = runHookDirect(
      'gsd-read-guard.js',
      { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: existing }, cwd: proj },
      proj,
    );
    const expected = emitted.parsed.hookSpecificOutput.additionalContext;
    assert.equal(typeof expected, 'string', 'the read guard emits an advisory for an existing file');

    const writes = await withStderrCaptured(async () => {
      await handlers['tool.execute.before']({ tool: 'edit' }, before);
      await handlers['tool.execute.after']({ tool: 'edit', args: before.args }, after);
    });

    assert.deepEqual(writes, [], 'no advisory text may be written to the process stderr');
    assert.deepEqual(before.metadata._gsdAdvisory, [expected], 'the advisory is recorded in metadata');
    if (plugin.appendsToOutput) {
      assert.equal(after.output, `edited\n\n[GSD advisory] ${expected}`, 'the advisory is appended to the tool output');
    }
  });

  test(`${plugin.name}: a blocking hook still aborts the call and writes nothing to stderr`, { skip: SKIP }, async (t) => {
    const { handlers, proj } = await load(t, plugin.src);
    const target = path.join(proj, '.env');
    const out = { args: { filePath: target }, metadata: {} };

    // The secret-read guard must block this read on its own, and the plugin must surface its reason.
    const emitted = runHookDirect(
      'gsd-secret-read-guard.js',
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: target }, cwd: proj },
      proj,
    );
    const blocked = emitted.status === 2 || (emitted.parsed && emitted.parsed.decision === 'block');
    assert.ok(blocked, 'the secret-read guard blocks a read of .env');
    const reason = (emitted.parsed && emitted.parsed.reason) || BLOCK_FALLBACK;

    const writes = await withStderrCaptured(async () => {
      await assert.rejects(
        () => handlers['tool.execute.before']({ tool: 'read' }, out),
        (err) => err instanceof Error && err.message === reason,
      );
    });
    assert.deepEqual(writes, []);
  });

  test(`${plugin.name}: a hook result with no advisory records nothing`, { skip: SKIP }, async (t) => {
    const { handlers, proj } = await load(t, plugin.src);
    const fresh = path.join(proj, 'brand-new.txt');
    const out = { args: { filePath: fresh, content: 'x' }, metadata: {} };
    const writes = await withStderrCaptured(async () => {
      await handlers['tool.execute.before']({ tool: 'write' }, out);
    });
    assert.deepEqual(writes, []);
    assert.equal(out.metadata._gsdAdvisory, undefined);
  });
}
