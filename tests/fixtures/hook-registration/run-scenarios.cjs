'use strict';

/**
 * Scenario driver for the #5207 hook-registration parity pin (ADR-5057 Phase 11).
 *
 * Drives the real `applySettingsJsonHooks` across every runtime whose
 * `hooksSurface` is `settings-json` and returns the resulting settings object
 * plus both console streams, for each scenario. `golden.json` was generated
 * from the PRE-migration per-hook-branch implementation (base commit
 * e0762bbeb0) and is the oracle the table-driven implementation must
 * reproduce byte-for-byte. Regenerate only from a known-good implementation:
 *
 *   node tests/fixtures/hook-registration/run-scenarios.cjs --write
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { applySettingsJsonHooks } = require(path.join(ROOT, 'gsd-core/bin/lib/runtime-hooks-surface.cjs'));
const registry = require(path.join(ROOT, 'gsd-core/bin/lib/runtime-config-adapter-registry.cjs'));

const JS_HOOKS = [
  'gsd-check-update.js',
  'gsd-path-export.js',
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js',
  'gsd-agent-isolation-guard.js',
  'gsd-write-guard.js',
  'gsd-secret-read-guard.js',
  'gsd-config-reload.js',
];
const SH_HOOKS = [
  'gsd-validate-commit.sh',
  'gsd-graphify-update.sh',
  'gsd-session-state.sh',
  'gsd-phase-boundary.sh',
];
const ALL_HOOKS = [...JS_HOOKS, ...SH_HOOKS];

// Seconds the pre-#3981 installer wrote for blocking guards; the registration loop raises it.
const LEGACY_HOOK_BUDGET_S = 5;
// A user-chosen budget the installer must leave alone, and the monitor's own budget.
const CUSTOM_BUDGET_S = 90;
const MONITOR_BUDGET_S = 10;

const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function settingsJsonRuntimes() {
  const out = [];
  for (const id of registry.ALLOWED_CONFIG_RUNTIMES) {
    const plan = registry.resolveInstallPlan(id);
    if (plan.hooksSurface === 'settings-json') {
      out.push({ id, hookEvents: plan.hookEvents, extendedHookEvents: plan.extendedHookEvents || [] });
    }
  }
  return out;
}

function capture(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => err.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return { stdout: out.join('\n').replace(ANSI, ''), stderr: err.join('\n').replace(ANSI, '') };
}

/**
 * @param {object} rt     runtime row from settingsJsonRuntimes()
 * @param {object} spec   { isGlobal, present, nullJs, nullSh, seed, runs, configReloadNull }
 * @param {Function} [apply]  registration function under test (defaults to the real one)
 */
function runOne(rt, spec, apply = applySettingsJsonHooks) {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hookreg-'));
  try {
    fs.mkdirSync(path.join(targetDir, 'hooks'), { recursive: true });
    for (const h of spec.present) fs.writeFileSync(path.join(targetDir, 'hooks', h), '// stub\n');

    const localCmd = (f) => (spec.nullJs ? null : `LOCALNODE ${targetDir}/hooks/${f}`);
    const localShellCmd = (f) => (spec.nullSh ? null : `LOCALBASH ${targetDir}/hooks/${f}`);
    const hookOpts = {
      portableHooks: Boolean(spec.portableHooks),
      runtime: rt.id,
      platform: spec.platform || 'linux',
      execPath: '/opt/node/bin/node',
      existsSync: () => true,
      env: {},
    };
    const build = (f) => {
      if (spec.nullJs && f.endsWith('.js')) return null;
      if (spec.nullSh && f.endsWith('.sh')) return null;
      return `GLOBAL ${targetDir}/hooks/${f}`;
    };
    const cmdFor = (f) => (spec.isGlobal ? build(f) : f.endsWith('.sh') ? localShellCmd(f) : localCmd(f));

    const settings = JSON.parse(JSON.stringify(spec.seed || {}));
    let stdout = '';
    let stderr = '';
    for (let i = 0; i < (spec.runs || 1); i += 1) {
      const res = capture(() => {
        apply(settings, {
          runtime: rt.id,
          isGlobal: spec.isGlobal,
          targetDir,
          postToolEvent: rt.hookEvents === 'gemini' ? 'AfterTool' : 'PostToolUse',
          hookEvents: rt.hookEvents,
          extendedHookEvents: rt.extendedHookEvents,
          hooksSurface: spec.hooksSurface || 'settings-json',
          updateCheckCommand: cmdFor('gsd-check-update.js'),
          contextMonitorCommand: cmdFor('gsd-context-monitor.js'),
          promptGuardCommand: cmdFor('gsd-prompt-guard.js'),
          readGuardCommand: cmdFor('gsd-read-guard.js'),
          readInjectionScannerCommand: cmdFor('gsd-read-injection-scanner.js'),
          configReloadCommand: spec.configReloadNull ? null : cmdFor('gsd-config-reload.js'),
          hookOpts,
          localCmd,
          localShellCmd,
        });
      });
      const sep = i ? `\n--- run ${i + 1} ---\n` : '';
      stdout += sep + res.stdout;
      stderr += sep + res.stderr;
    }
    const norm = (s) => s.split(targetDir).join('<TARGET>');
    return { settings: JSON.parse(norm(JSON.stringify(settings))), stdout: norm(stdout), stderr: norm(stderr) };
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

function without(list, f) {
  return list.filter((h) => h !== f);
}

function scenarioSpecs(rt) {
  const specs = {};
  for (const isGlobal of [false, true]) {
    const scope = isGlobal ? 'global' : 'local';
    specs[`${scope}/all-present`] = { isGlobal, present: ALL_HOOKS };
    specs[`${scope}/none-present`] = { isGlobal, present: [] };
    specs[`${scope}/all-present-twice`] = { isGlobal, present: ALL_HOOKS, runs: 2 };
    specs[`${scope}/null-js-commands`] = { isGlobal, present: ALL_HOOKS, nullJs: true };
    specs[`${scope}/null-sh-commands`] = { isGlobal, present: ALL_HOOKS, nullSh: true };
    specs[`${scope}/config-reload-null`] = { isGlobal, present: ALL_HOOKS, configReloadNull: true };
    if ((rt.id === 'claude' || rt.id === 'antigravity') && !isGlobal) {
      for (const f of ALL_HOOKS) specs[`${scope}/missing:${f}`] = { isGlobal, present: without(ALL_HOOKS, f) };
    }
  }
  const claudeish = rt.hookEvents !== 'gemini';
  const pre = claudeish ? 'PreToolUse' : 'BeforeTool';
  const post = claudeish ? 'PostToolUse' : 'AfterTool';
  specs['local/seed-legacy-shapes'] = {
    isGlobal: false,
    present: ALL_HOOKS,
    seed: {
      hooks: {
        [post]: [
          { hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-own-hook.sh' }] },
        ],
        [pre]: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node /x/hooks/gsd-workflow-guard.js', timeout: LEGACY_HOOK_BUDGET_S }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/hooks/gsd-validate-commit.sh', timeout: LEGACY_HOOK_BUDGET_S }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/hooks/gsd-check-update.js' }] }],
      },
    },
  };
  // The #3329 reconcile only rewrites on win32 / portable shapes; seed all four
  // managed `.sh` hooks with legacy bash-runner-prefixed commands so the path
  // that consumes the loop's built `.sh` commands actually executes.
  const legacySh = {
    [pre]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /x/hooks/gsd-validate-commit.sh' }] }],
    [post]: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /x/hooks/gsd-graphify-update.sh' }] },
      { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'bash /x/hooks/gsd-phase-boundary.sh' }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'bash /x/hooks/gsd-session-state.sh' }] }],
  };
  for (const isGlobal of [false, true]) {
    const scope = isGlobal ? 'global' : 'local';
    specs[`${scope}/win32-reconcile-legacy-sh`] = { isGlobal, present: ALL_HOOKS, platform: 'win32', seed: { hooks: legacySh } };
    specs[`${scope}/linux-reconcile-legacy-sh`] = { isGlobal, present: ALL_HOOKS, seed: { hooks: legacySh } };
    specs[`${scope}/portable-all-present`] = { isGlobal, present: ALL_HOOKS, portableHooks: true };
    specs[`${scope}/win32-all-present`] = { isGlobal, present: ALL_HOOKS, platform: 'win32' };
  }
  // Already-registered entries whose hook file is absent: the repair and
  // migration paths still run; nothing is warned and nothing is pushed.
  specs['local/seed-present-but-file-missing'] = {
    isGlobal: false,
    present: [],
    seed: {
      hooks: {
        [post]: [{ hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js' }] }],
        [pre]: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node /x/hooks/gsd-workflow-guard.js' }] }],
      },
    },
  };
  // Partial migrations: matcher without timeout, timeout without matcher,
  // an entry with no `hooks` field, and a blocking guard already past the old budget.
  specs['local/seed-partial-migrations'] = {
    isGlobal: false,
    present: ALL_HOOKS,
    seed: {
      hooks: {
        [post]: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js' }] },
          { hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js', timeout: MONITOR_BUDGET_S }] },
          { matcher: 'Read' },
        ],
        [pre]: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node /x/hooks/gsd-prompt-guard.js', timeout: CUSTOM_BUDGET_S }] },
        ],
      },
    },
  };
  specs['local/seed-user-hooks-only'] = {
    isGlobal: false,
    present: ALL_HOOKS,
    seed: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }], [pre]: [] }, other: { keep: true } },
  };
  return specs;
}

function runAll(apply) {
  const result = {};
  for (const rt of settingsJsonRuntimes()) {
    result[rt.id] = {};
    for (const [name, spec] of Object.entries(scenarioSpecs(rt))) {
      result[rt.id][name] = runOne(rt, spec, apply);
    }
  }
  return result;
}

module.exports = { runAll, runOne, scenarioSpecs, settingsJsonRuntimes, ALL_HOOKS, JS_HOOKS, SH_HOOKS };

if (require.main === module && process.argv.includes('--write')) {
  // `--impl <path>` regenerates from another build of runtime-hooks-surface.cjs
  // (the pre-migration build, e.g. a checkout of the base commit) — the oracle.
  const implIdx = process.argv.indexOf('--impl');
  const apply = implIdx === -1 ? undefined : require(path.resolve(process.argv[implIdx + 1])).applySettingsJsonHooks;
  const out = path.join(__dirname, 'golden.json');
  fs.writeFileSync(out, JSON.stringify(runAll(apply), null, 1) + '\n');
  console.log(`wrote ${out}`);
}
