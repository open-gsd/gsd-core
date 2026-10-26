'use strict';

/**
 * #5465 — `gsd_run` was not resolvable from a later Claude Code Bash call.
 *
 * The resolver snippet persists its PATH export through `$CLAUDE_ENV_FILE`, but Claude
 * Code provides that variable only to SessionStart / Setup / CwdChanged / FileChanged
 * hooks, never to a workflow Bash block, so the write never fired. The managed
 * `gsd-path-export.js` SessionStart hook writes the same line from the one place the
 * variable exists.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_SOURCE = path.join(__dirname, '..', 'hooks', 'gsd-path-export.js');
const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');
const { HOOKS_TO_COPY } = require('../scripts/build-hooks.js');

describe('gsd-path-export SessionStart hook (#5465)', () => {
  let root;
  let envFile;

  /** An installed layout: <root>/hooks/<hook>, <root>/gsd-core/bin/gsd_run. */
  const install = ({ withGsdRun = true, dirName = 'cfg' } = {}) => {
    const configDir = path.join(root, dirName);
    fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(configDir, 'gsd-core', 'bin'), { recursive: true });
    fs.copyFileSync(HOOK_SOURCE, path.join(configDir, 'hooks', 'gsd-path-export.js'));
    // The hook requires ./lib/hook-exit.js; the installer ships hooks/lib/ beside the hooks.
    fs.cpSync(path.join(__dirname, '..', 'hooks', 'lib'), path.join(configDir, 'hooks', 'lib'), { recursive: true });
    if (withGsdRun) fs.writeFileSync(path.join(configDir, 'gsd-core', 'bin', 'gsd_run'), '#!/bin/sh\n', { mode: 0o755 });
    return configDir;
  };

  const run = (configDir, env = {}) => spawnSync(
    process.execPath,
    [path.join(configDir, 'hooks', 'gsd-path-export.js')],
    { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, input: '{}', env: { PATH: process.env.PATH, ...env } },
  );

  beforeEach(() => {
    root = createTempDir('gsd-path-export-');
    envFile = path.join(root, 'claude-env.sh');
  });
  afterEach(() => { cleanup(root); });

  test('appends the bin directory to CLAUDE_ENV_FILE in the form the resolver snippet writes', () => {
    const configDir = install();
    const r = run(configDir, { CLAUDE_ENV_FILE: envFile });
    assert.strictEqual(r.status, 0, r.stderr);
    // The hook writes the directory as the shell that sources the file spells it (`/c/...` on Windows).
    const bin = require('../hooks/gsd-path-export.js').shellPath(fs.realpathSync(path.join(configDir, 'gsd-core', 'bin')));
    assert.strictEqual(fs.readFileSync(envFile, 'utf8'), `export PATH='${bin}':"$PATH"\n`);
  });

  test('is idempotent: a second session start does not duplicate the line', () => {
    const configDir = install();
    run(configDir, { CLAUDE_ENV_FILE: envFile });
    run(configDir, { CLAUDE_ENV_FILE: envFile });
    const lines = splitLines(fs.readFileSync(envFile, 'utf8')).filter(Boolean);
    assert.strictEqual(lines.length, 1);
  });

  test('preserves what the env file already holds', () => {
    const configDir = install();
    fs.writeFileSync(envFile, 'export FOO=bar\n');
    run(configDir, { CLAUDE_ENV_FILE: envFile });
    const content = fs.readFileSync(envFile, 'utf8');
    assert.ok(content.startsWith('export FOO=bar\n'), content);
    assert.match(content, /export PATH='.*gsd-core[\\/]bin':"\$PATH"\n$/);
  });

  test('an env file that lacks a final newline still gets the export on its own line', () => {
    const configDir = install();
    fs.writeFileSync(envFile, 'export FOO=bar');
    run(configDir, { CLAUDE_ENV_FILE: envFile });
    const lines = splitLines(fs.readFileSync(envFile, 'utf8')).filter(Boolean);
    assert.strictEqual(lines[0], 'export FOO=bar');
    assert.match(lines[1], /^export PATH='.*':"\$PATH"$/);
  });

  test('writes nothing and exits 0 when CLAUDE_ENV_FILE is unset or empty', () => {
    const configDir = install();
    for (const env of [{}, { CLAUDE_ENV_FILE: '' }]) {
      const r = run(configDir, env);
      assert.strictEqual(r.status, 0, r.stderr);
    }
    assert.ok(!fs.existsSync(envFile));
  });

  test('exports nothing when gsd_run is not in the bin directory', () => {
    const configDir = install({ withGsdRun: false });
    const r = run(configDir, { CLAUDE_ENV_FILE: envFile });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(envFile), 'only an installed gsd_run directory may be put on PATH');
  });

  test('a single quote in the path is escaped so the line stays one quoted word', () => {
    const configDir = install({ dirName: "it's cfg" });
    const r = run(configDir, { CLAUDE_ENV_FILE: envFile });
    assert.strictEqual(r.status, 0, r.stderr);
    const line = fs.readFileSync(envFile, 'utf8').trimEnd();
    const bin = require('../hooks/gsd-path-export.js').shellPath(fs.realpathSync(path.join(configDir, 'gsd-core', 'bin')));
    if (process.platform === 'win32') {
      // No POSIX sh on the runner's PATH to execute the line; pin the escaped one-word form instead.
      assert.strictEqual(line, `export PATH='${bin.replace(/'/g, "'\\''")}':"$PATH"`);
      return;
    }
    // Executing the line in a shell must put exactly the bin directory on PATH.
    const shell = spawnSync('sh', ['-c', `${line}; printf %s "$PATH"`], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } });
    assert.strictEqual(shell.stdout, `${bin}:/usr/bin:/bin`);
  });

  test('an unwritable env file never fails session start', () => {
    const configDir = install();
    fs.mkdirSync(envFile); // a directory where the file should be
    const r = run(configDir, { CLAUDE_ENV_FILE: envFile });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  test('is a managed hook shipped to dist, so installs and staleness checks see it', () => {
    assert.ok(MANAGED_HOOKS.includes('gsd-path-export.js'));
    assert.ok(HOOKS_TO_COPY.includes('gsd-path-export.js'));
  });

  test('the plugin hooks.json runs it on SessionStart', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
    const commands = hooks.hooks.SessionStart.flatMap((group) => group.hooks.map((h) => h.command));
    assert.ok(commands.some((c) => c.includes('gsd-path-export.js')), commands.join('\n'));
  });

  test('on Windows the line uses the /c/... form Git Bash sources, never a native drive path', () => {
    const { shellPath, exportLine } = require('../hooks/gsd-path-export.js');
    assert.strictEqual(shellPath('C:\\Users\\x\\.claude\\gsd-core\\bin', 'win32'), '/c/Users/x/.claude/gsd-core/bin');
    assert.strictEqual(shellPath('d:/work/gsd-core/bin', 'win32'), '/d/work/gsd-core/bin');
    assert.strictEqual(shellPath('/home/x/.claude/gsd-core/bin', 'linux'), '/home/x/.claude/gsd-core/bin');
    assert.strictEqual(exportLine('C:\\Users\\x\\bin', 'win32'), `export PATH='/c/Users/x/bin':"$PATH"`);
  });

  test('uninstall and the settings.json migration filter recognize the registered hook as GSD-managed', () => {
    const { isManagedHookCommand, isManagedHookBasename } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
    assert.ok(isManagedHookBasename('gsd-path-export.js'));
    assert.ok(isManagedHookCommand('node "/h/.claude/hooks/gsd-path-export.js"'));
  });
});

