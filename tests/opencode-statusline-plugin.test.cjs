'use strict';

/**
 * opencode-statusline-plugin.test.cjs — the OpenCode 2.x terminal-client plugin that shows GSD's statusline
 * and update banner in the footer (ADR-5331 Phase 3, epic #5331 / #5339).
 *
 * The installer tests always run. The real-terminal test is opt-in: set GSD_TEST_OPENCODE_V2_BIN to a 2.x
 * `opencode` executable (needs python3 for a pseudo-terminal); a local OpenAI-compatible stub stands in for the
 * model, nothing leaves the machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// A pseudo-terminal capture of a real OpenCode terminal client: the capture window plus startup and teardown.
const TERMINAL_CAPTURE_TIMEOUT_MS = 60000;

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '.opencode', 'plugins', 'gsd-statusline', 'tui.tsx');

function install(t, runtime) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-oc-sl-')));
  t.after(() => cleanup(home));
  const configDir = path.join(home, 'cfg', runtime);
  const args = [INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', configDir];
  const result = runNode(args, { env: installerEnv({ HOME: home, USERPROFILE: home }), timeoutMs: INSTALL_TIMEOUT_MS });
  assert.strictEqual(result.exitCode, 0, `install failed\n${result.stdout}\n${result.stderr}`);
  return { home, configDir };
}

test('opencode install stages the terminal-client plugin byte-identical to its source and tracks it', (t) => {
  const { configDir } = install(t, 'opencode');
  const staged = path.join(configDir, 'plugins', 'gsd-statusline', 'tui.tsx');
  assert.equal(fs.readFileSync(staged, 'utf8'), fs.readFileSync(SOURCE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'));
  assert.ok(manifest.files['plugins/gsd-statusline/tui.tsx'], 'the plugin is in the file manifest');
  assert.ok(fs.existsSync(path.join(configDir, 'hooks', 'gsd-statusline.js')), 'the script it runs is installed');
});

test('kilo install stages no terminal-client plugin (Kilo output unchanged)', (t) => {
  const { configDir } = install(t, 'kilo');
  assert.equal(fs.existsSync(path.join(configDir, 'plugins', 'gsd-statusline')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'plugin', 'gsd-statusline')), false);
});

test('opencode uninstall removes the terminal-client plugin and its directory', (t) => {
  const { home, configDir } = install(t, 'opencode');
  const result = runNode([INSTALL_SCRIPT, '--opencode', '--global', '--config-dir', configDir, '--uninstall'], {
    env: installerEnv({ HOME: home, USERPROFILE: home }),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  assert.strictEqual(result.exitCode, 0, `uninstall failed\n${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(configDir, 'plugins', 'gsd-statusline')), false);
});

test('the plugin only runs GSD\'s own statusline script and strips colour codes', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(src, /gsd-statusline\.js/);
  assert.match(src, /home\.footer\.status/);
  assert.match(src, /prompt\.footer\.status/);
  assert.match(src, /\.planning/);
});

const V2 = process.env.GSD_TEST_OPENCODE_V2_BIN;
const PY = process.platform === 'win32' ? null : spawnSync('python3', ['--version'], { timeout: PROBE_TIMEOUT_MS }).status === 0 ? 'python3' : null;

test('OpenCode 2.x terminal: the footer shows the GSD statusline for a GSD project', { skip: (!V2 && 'GSD_TEST_OPENCODE_V2_BIN not set') || (!PY && 'python3 pseudo-terminal unavailable') }, (t) => {
  const { home, configDir } = install(t, 'opencode');
  const proj = path.join(home, 'gsdstatusproj');
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.planning', 'config.json'), '{"mode":"yolo"}');
  // The installed MCP companion would make OpenCode start `npx` and download the package; this test is about the footer.
  const cfgFile = path.join(configDir, 'opencode.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  delete cfg.mcp;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const out = path.join(home, 'tui.out');
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_AUTOUPDATE: 'true', TERM: 'xterm-256color', PWD: proj,
  };
  const run = spawnSync(PY, [path.join(__dirname, 'helpers', 'pty-capture.py'), out, '14', proj, V2, '--standalone'], { env, timeout: TERMINAL_CAPTURE_TIMEOUT_MS });
  assert.equal(run.status, 0, String(run.stderr));
  // eslint-disable-next-line no-control-regex -- ESC (\x1b) and BEL (\x07) are the delimiters of the terminal control sequences being stripped from the capture
  const text = fs.readFileSync(out, 'utf8').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '');
  assert.match(text, /OpenCode\s*│\s*gsdstatusproj/);
});
