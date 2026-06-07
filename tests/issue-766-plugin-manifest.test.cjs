'use strict';

/**
 * Regression tests for issue #766: additive Claude Code plugin manifest.
 *
 * Asserts structural and semantic correctness of:
 *   .claude-plugin/plugin.json  — plugin manifest
 *   hooks/hooks.json            — plugin hook wiring
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const identity = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs'));
const pkg = require(path.join(ROOT, 'package.json'));
const { MANAGED_HOOKS } = require(path.join(ROOT, 'hooks', 'managed-hooks-registry.cjs'));

const PLUGIN_JSON_PATH = path.join(ROOT, '.claude-plugin', 'plugin.json');
const HOOKS_JSON_PATH  = path.join(ROOT, 'hooks', 'hooks.json');

// ─── Section A: plugin.json ───────────────────────────────────────────────────
describe('A: .claude-plugin/plugin.json', () => {

  let manifest;

  test('exists and is valid JSON', () => {
    assert.ok(fs.existsSync(PLUGIN_JSON_PATH), '.claude-plugin/plugin.json must exist');
    const raw = fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8');
    manifest = JSON.parse(raw); // throws on invalid JSON
    assert.ok(typeof manifest === 'object' && manifest !== null, 'manifest must be a JSON object');
  });

  test('name equals identity.binName ("gsd-core")', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.name, identity.binName, `name should be "${identity.binName}"`);
  });

  test('name is kebab-case, no colons, spaces, or uppercase', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.match(
      manifest.name,
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'name must be kebab-case (no colon, space, or uppercase) to be namespace-safe'
    );
  });

  test('version matches package.json version', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.version, pkg.version, `.claude-plugin/plugin.json version (${manifest.version}) must match package.json version (${pkg.version}). When bumping the package version, update .claude-plugin/plugin.json \`version\` to match — Claude Code plugin --strict validation requires a version field and the plugin manifest must track the package version. (#766)`);
  });

  test('repository equals identity.repoUrl', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.repository, identity.repoUrl, 'repository must equal identity.repoUrl');
  });

  test('homepage equals identity.repoUrl', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.homepage, identity.repoUrl, 'homepage must equal identity.repoUrl');
  });

  test('license matches package.json license', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.license, pkg.license, 'license must match package.json');
  });

  test('author.name is a non-empty string', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(
      manifest.author && typeof manifest.author.name === 'string' && manifest.author.name.trim().length > 0,
      'author.name must be a non-empty string'
    );
  });

  test('commands field is "./commands/gsd/" and that dir exists with at least one .md file', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.commands, './commands/gsd/', 'commands must be "./commands/gsd/"');
    const resolvedDir = path.resolve(path.dirname(PLUGIN_JSON_PATH), '..', manifest.commands);
    assert.ok(fs.existsSync(resolvedDir), `resolved commands dir must exist: ${resolvedDir}`);
    const mdFiles = fs.readdirSync(resolvedDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length > 0, `commands dir must contain at least one .md file`);
  });

  test('hooks field is "./hooks/hooks.json" and that file exists', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.hooks, './hooks/hooks.json', 'hooks must be "./hooks/hooks.json"');
    const resolvedHooks = path.resolve(path.dirname(PLUGIN_JSON_PATH), '..', manifest.hooks);
    assert.ok(fs.existsSync(resolvedHooks), `resolved hooks file must exist: ${resolvedHooks}`);
  });

  test('no "$schema" key (intentionally omitted)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(!Object.prototype.hasOwnProperty.call(manifest, '$schema'), 'plugin.json must NOT contain a $schema key');
  });
});

// ─── Section B: hooks/hooks.json ─────────────────────────────────────────────
describe('B: hooks/hooks.json', () => {

  let hooksConfig;

  test('exists and is valid JSON with top-level "hooks" object', () => {
    assert.ok(fs.existsSync(HOOKS_JSON_PATH), 'hooks/hooks.json must exist');
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    hooksConfig = JSON.parse(raw);
    assert.ok(
      typeof hooksConfig === 'object' && hooksConfig !== null &&
      typeof hooksConfig.hooks === 'object' && hooksConfig.hooks !== null,
      'hooks.json must have a top-level "hooks" object'
    );
  });

  test('every event name is one of: SessionStart, PreToolUse, PostToolUse', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    const validEvents = new Set(['SessionStart', 'PreToolUse', 'PostToolUse']);
    for (const eventName of Object.keys(hooksConfig.hooks)) {
      assert.ok(validEvents.has(eventName), `Unknown hook event: "${eventName}"`);
    }
  });

  test('every hook entry has type "command" and command contains ${CLAUDE_PLUGIN_ROOT}', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    for (const [eventName, eventEntries] of Object.entries(hooksConfig.hooks)) {
      assert.ok(Array.isArray(eventEntries), `Event "${eventName}" must be an array`);
      for (const entry of eventEntries) {
        assert.ok(Array.isArray(entry.hooks), `Entry in "${eventName}" must have a hooks array`);
        for (const hook of entry.hooks) {
          assert.equal(hook.type, 'command', `All hook entries must have type "command" (got "${hook.type}")`);
          assert.ok(
            typeof hook.command === 'string' && hook.command.includes('${CLAUDE_PLUGIN_ROOT}'),
            `Hook command must contain "\${CLAUDE_PLUGIN_ROOT}": ${hook.command}`
          );
        }
      }
    }
  });

  test('every referenced script file exists on disk and its basename is in MANAGED_HOOKS', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    // Extract script path: substring after ${CLAUDE_PLUGIN_ROOT}/ up to next "
    const scriptPathRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/g;
    const allScripts = [];
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          const matches = [...hook.command.matchAll(scriptPathRe)];
          for (const m of matches) {
            allScripts.push(m[1]);
          }
        }
      }
    }
    assert.ok(allScripts.length > 0, 'Should have found at least one script path in hooks.json');
    for (const scriptPath of allScripts) {
      const fullPath = path.join(ROOT, scriptPath);
      assert.ok(fs.existsSync(fullPath), `Script referenced in hooks.json does not exist on disk: ${fullPath}`);
      const basename = path.basename(scriptPath);
      assert.ok(
        MANAGED_HOOKS.includes(basename),
        `Script basename "${basename}" is not listed in hooks/managed-hooks-registry.cjs MANAGED_HOOKS`
      );
    }
  });

  test('all six always-on hooks are wired', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    const REQUIRED_HOOKS = [
      'gsd-check-update.js',
      'gsd-prompt-guard.js',
      'gsd-read-guard.js',
      'gsd-worktree-path-guard.js',
      'gsd-context-monitor.js',
      'gsd-read-injection-scanner.js',
    ];
    // Collect all basenames wired in hooks.json
    const wiredBasenames = new Set();
    const scriptPathRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"]+)/g;
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          const matches = [...hook.command.matchAll(scriptPathRe)];
          for (const m of matches) {
            wiredBasenames.add(m[1]);
          }
        }
      }
    }
    for (const required of REQUIRED_HOOKS) {
      assert.ok(wiredBasenames.has(required), `Required hook "${required}" is not wired in hooks/hooks.json`);
    }
  });

  test('gsd-context-monitor.js entry has timeout === 10', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    let found = false;
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          if (hook.command && hook.command.includes('gsd-context-monitor.js')) {
            found = true;
            assert.equal(hook.timeout, 10, 'gsd-context-monitor.js must have timeout === 10');
          }
        }
      }
    }
    assert.ok(found, 'gsd-context-monitor.js entry was not found in hooks.json');
  });
});

// ─── Section C: Optional CLI integration test ─────────────────────────────────
describe('C: claude plugin validate (CLI integration)', () => {

  const claudeAvailable = (() => {
    try {
      const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      return result.status === 0;
    } catch (_) {
      return false;
    }
  })();

  test(
    'claude plugin validate . --strict exits 0 (skip if claude not on PATH)',
    { skip: !claudeAvailable ? 'claude binary not available on PATH' : false },
    () => {
      const result = spawnSync('claude', ['plugin', 'validate', '.', '--strict'], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 15000,
      });
      assert.equal(
        result.status,
        0,
        `claude plugin validate . --strict exited with ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }
  );
});

// ─── Section D: Always-on hook contract (drift guard) ────────────────────────
describe('D: always-on hook contract drift guard', () => {

  /**
   * Parses hooks.json and builds a map:
   *   event -> matcher (or '' for no-matcher) -> [{script, timeout}]
   *
   * script: basename of the .js/.sh file referenced in the command string
   * timeout: numeric value from hook.timeout, or undefined if absent
   */
  function buildHookMap() {
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    const hooksConfig = JSON.parse(raw);
    const scriptRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+)/;
    const map = {};
    for (const [eventName, eventEntries] of Object.entries(hooksConfig.hooks)) {
      map[eventName] = map[eventName] || {};
      for (const entry of eventEntries) {
        const matcher = entry.matcher || '';
        map[eventName][matcher] = map[eventName][matcher] || [];
        for (const hook of entry.hooks) {
          const m = hook.command.match(scriptRe);
          if (m) {
            map[eventName][matcher].push({
              script: m[1],
              timeout: hook.timeout,
            });
          }
        }
      }
    }
    return map;
  }

  test('SessionStart: exactly one no-matcher group with gsd-check-update.js and no timeout', () => {
    const map = buildHookMap();
    const groups = map['SessionStart'];
    assert.ok(groups, 'SessionStart must be present in hooks.json');
    // There must be exactly one entry group (key '' = no matcher)
    const noMatcherHooks = groups[''];
    assert.ok(
      Array.isArray(noMatcherHooks) && noMatcherHooks.length === 1,
      `SessionStart no-matcher group must contain exactly one hook; got: ${JSON.stringify(noMatcherHooks)}`
    );
    const h = noMatcherHooks[0];
    assert.equal(h.script, 'gsd-check-update.js', 'SessionStart hook must be gsd-check-update.js');
    assert.equal(h.timeout, undefined, 'gsd-check-update.js must NOT have a timeout field');
  });

  test('PreToolUse Write|Edit group: gsd-prompt-guard.js (timeout 5) + gsd-read-guard.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PreToolUse'];
    assert.ok(groups, 'PreToolUse must be present in hooks.json');
    const hooks = groups['Write|Edit'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 2,
      `PreToolUse Write|Edit must have exactly 2 hooks; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-prompt-guard.js', 'first hook must be gsd-prompt-guard.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-prompt-guard.js must have timeout 5');
    assert.equal(hooks[1].script, 'gsd-read-guard.js', 'second hook must be gsd-read-guard.js');
    assert.equal(hooks[1].timeout, 5, 'gsd-read-guard.js must have timeout 5');
  });

  test('PreToolUse Write|Edit|MultiEdit group: gsd-worktree-path-guard.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PreToolUse'];
    assert.ok(groups, 'PreToolUse must be present in hooks.json');
    const hooks = groups['Write|Edit|MultiEdit'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PreToolUse Write|Edit|MultiEdit must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-worktree-path-guard.js', 'hook must be gsd-worktree-path-guard.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-worktree-path-guard.js must have timeout 5');
  });

  test('PostToolUse Bash|Edit|Write|MultiEdit|Agent|Task group: gsd-context-monitor.js (timeout 10)', () => {
    const map = buildHookMap();
    const groups = map['PostToolUse'];
    assert.ok(groups, 'PostToolUse must be present in hooks.json');
    const hooks = groups['Bash|Edit|Write|MultiEdit|Agent|Task'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PostToolUse Bash|Edit|Write|MultiEdit|Agent|Task must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-context-monitor.js', 'hook must be gsd-context-monitor.js');
    assert.equal(hooks[0].timeout, 10, 'gsd-context-monitor.js must have timeout 10');
  });

  test('PostToolUse Read group: gsd-read-injection-scanner.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PostToolUse'];
    assert.ok(groups, 'PostToolUse must be present in hooks.json');
    const hooks = groups['Read'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PostToolUse Read must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-read-injection-scanner.js', 'hook must be gsd-read-injection-scanner.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-read-injection-scanner.js must have timeout 5');
  });
});

// ─── Section E: Config-gated hooks must be absent from hooks.json ─────────────
describe('E: config-gated (opt-in) hooks must not appear in hooks.json', () => {

  const CONFIG_GATED_HOOKS = [
    'gsd-workflow-guard.js',
    'gsd-validate-commit.sh',
    'gsd-graphify-update.sh',
    'gsd-session-state.sh',
    'gsd-phase-boundary.sh',
    'gsd-update-banner.js',
    'gsd-statusline.js',
    'gsd-check-update-worker.js',
  ];

  test('none of the config-gated hook basenames appear in hooks.json command strings', () => {
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    // Check raw text — simple and resistant to structure changes
    for (const hookBasename of CONFIG_GATED_HOOKS) {
      assert.ok(
        !raw.includes(hookBasename),
        `Config-gated hook "${hookBasename}" must NOT appear in hooks/hooks.json ` +
        `(it is opt-in and must not run unconditionally on the plugin path)`
      );
    }
  });
});
