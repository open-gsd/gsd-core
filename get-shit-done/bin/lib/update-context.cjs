'use strict';

/**
 * Update-context resolver (issue #498, candidate 3).
 *
 * Faithful Node port of the ~280-line `get_installed_version` bash step in
 * `workflows/update.md`. That logic resolved the installed GSD version, the
 * install scope (LOCAL / GLOBAL / UNKNOWN), the target runtime, and the config
 * dir — entirely as inline bash inside an LLM prompt, untestable through its
 * interface. This module makes the same cascade a pure, injected-fs function so
 * the workflow shrinks to: call → compare → confirm → install.
 *
 * The fs is injected ({ exists, readFile }) so every precedence branch is
 * testable without a live multi-runtime install. `loadUpdateContext` wires the
 * real fs for the CLI.
 */

const path = require('node:path');

// Runtime -> candidate relative dir. Order matters: it is the probe order, and
// mirrors the RUNTIME_DIRS array the bash used (a runtime may have several
// candidate dirs). Kept here, not derived from the installer's getDirName,
// because update detection probes ALL historical dirs per runtime.
const RUNTIME_DIRS = [
  ['claude', '.claude'],
  ['opencode', '.config/opencode'],
  ['opencode', '.opencode'],
  ['antigravity', '.gemini/antigravity-ide'],
  ['antigravity', '.gemini/antigravity-cli'],
  ['antigravity', '.gemini/antigravity'],
  ['gemini', '.gemini'],
  ['kilo', '.config/kilo'],
  ['kilo', '.kilo'],
  ['codex', '.codex'],
];

const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

function expandHome(p, home) {
  if (!p) return '';
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function versionFile(dir) { return path.join(dir, 'get-shit-done', 'VERSION'); }
function markerFile(dir) { return path.join(dir, 'get-shit-done', 'workflows', 'update.md'); }

// Detection: a dir "has GSD" if it carries a VERSION file or the update.md
// workflow marker.
function hasInstall(fs, dir) {
  return fs.exists(versionFile(dir)) || fs.exists(markerFile(dir));
}

// Read VERSION at dir; return a trimmed semver string, or null if missing/invalid.
function validVersionAt(fs, dir) {
  const raw = fs.readFile(versionFile(dir));
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return SEMVER_PREFIX.test(trimmed) ? trimmed : null;
}

// Infer the preferred runtime from preferredConfigDir config files, then env.
function inferPreferredRuntime({ fs, env, preferredConfigDir }) {
  if (preferredConfigDir) {
    if (fs.exists(path.join(preferredConfigDir, 'kilo.json')) ||
        fs.exists(path.join(preferredConfigDir, 'kilo.jsonc'))) return 'kilo';
    if (fs.exists(path.join(preferredConfigDir, 'opencode.json')) ||
        fs.exists(path.join(preferredConfigDir, 'opencode.jsonc'))) return 'opencode';
    if (fs.exists(path.join(preferredConfigDir, 'config.toml'))) return 'codex';
  }
  if (env.CODEX_HOME) return 'codex';
  if (env.ANTIGRAVITY_CONFIG_DIR) return 'antigravity';
  if (env.GEMINI_CONFIG_DIR) return 'gemini';
  if (env.KILO_CONFIG_DIR || env.KILO_CONFIG) return 'kilo';
  if (env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG) return 'opencode';
  if (env.CLAUDE_CONFIG_DIR) return 'claude';
  return 'claude';
}

// Absolute env-override candidates, mirroring the bash ENV_RUNTIME_DIRS block.
function envRuntimeDirs({ env, home }) {
  const out = [];
  const ex = (v) => expandHome(v, home);
  if (env.CLAUDE_CONFIG_DIR) out.push(['claude', ex(env.CLAUDE_CONFIG_DIR)]);
  if (env.ANTIGRAVITY_CONFIG_DIR) out.push(['antigravity', ex(env.ANTIGRAVITY_CONFIG_DIR)]);
  if (env.GEMINI_CONFIG_DIR) out.push(['gemini', ex(env.GEMINI_CONFIG_DIR)]);
  if (env.KILO_CONFIG_DIR) out.push(['kilo', ex(env.KILO_CONFIG_DIR)]);
  else if (env.KILO_CONFIG) out.push(['kilo', path.dirname(ex(env.KILO_CONFIG))]);
  else if (env.XDG_CONFIG_HOME) out.push(['kilo', path.join(ex(env.XDG_CONFIG_HOME), 'kilo')]);
  if (env.OPENCODE_CONFIG_DIR) out.push(['opencode', ex(env.OPENCODE_CONFIG_DIR)]);
  else if (env.OPENCODE_CONFIG) out.push(['opencode', path.dirname(ex(env.OPENCODE_CONFIG))]);
  else if (env.XDG_CONFIG_HOME) out.push(['opencode', path.join(ex(env.XDG_CONFIG_HOME), 'opencode')]);
  if (env.CODEX_HOME) out.push(['codex', ex(env.CODEX_HOME)]);
  return out;
}

// Stable reorder: entries whose runtime === preferred first, original order kept.
function preferFirst(entries, preferred) {
  const pref = entries.filter(([rt]) => rt === preferred);
  const rest = entries.filter(([rt]) => rt !== preferred);
  return [...pref, ...rest];
}

/**
 * Pure resolver. Returns { installedVersion, scope, runtime, gsdDir }.
 */
function resolveUpdateContext({ home, cwd, env = {}, fs, preferredConfigDir = '', preferredRuntime = '' }) {
  const preferred = preferredRuntime || inferPreferredRuntime({ fs, env, preferredConfigDir });

  // Fast path: a validated preferredConfigDir (custom --config-dir install).
  if (preferredConfigDir && hasInstall(fs, preferredConfigDir)) {
    const resolvedPref = path.resolve(preferredConfigDir);
    let scope = 'GLOBAL';
    for (const [, reldir] of RUNTIME_DIRS) {
      if (path.resolve(cwd, reldir) === resolvedPref) { scope = 'LOCAL'; break; }
    }
    return {
      installedVersion: validVersionAt(fs, preferredConfigDir) || '0.0.0',
      scope,
      runtime: preferred,
      gsdDir: preferredConfigDir,
    };
  }

  const orderedEnv = preferFirst(envRuntimeDirs({ env, home }), preferred);
  const orderedRuntime = preferFirst(RUNTIME_DIRS, preferred);

  // LOCAL probe (relative to cwd).
  let localRuntime = '', localDir = '';
  for (const [rt, reldir] of orderedRuntime) {
    const cand = path.resolve(cwd, reldir);
    if (hasInstall(fs, cand)) { localRuntime = rt; localDir = cand; break; }
  }

  // GLOBAL probe: absolute env candidates first, then $HOME-relative.
  let globalRuntime = '', globalDir = '';
  for (const [rt, absdir] of orderedEnv) {
    if (hasInstall(fs, absdir)) { globalRuntime = rt; globalDir = path.resolve(absdir); break; }
  }
  if (!globalRuntime) {
    for (const [rt, reldir] of orderedRuntime) {
      const cand = path.resolve(home, reldir);
      if (hasInstall(fs, cand)) { globalRuntime = rt; globalDir = cand; break; }
    }
  }

  const localValid = localDir ? validVersionAt(fs, localDir) : null;
  const isLocal = !!localValid && (!globalDir || localDir !== globalDir);

  if (isLocal) {
    return { installedVersion: localValid, scope: 'LOCAL', runtime: localRuntime, gsdDir: localDir };
  }
  const globalValid = globalDir ? validVersionAt(fs, globalDir) : null;
  if (globalValid) {
    return { installedVersion: globalValid, scope: 'GLOBAL', runtime: globalRuntime, gsdDir: globalDir };
  }
  if (localRuntime && fs.exists(markerFile(localDir))) {
    return { installedVersion: '0.0.0', scope: 'LOCAL', runtime: localRuntime, gsdDir: localDir };
  }
  if (globalRuntime && fs.exists(markerFile(globalDir))) {
    return { installedVersion: '0.0.0', scope: 'GLOBAL', runtime: globalRuntime, gsdDir: globalDir };
  }
  return { installedVersion: '0.0.0', scope: 'UNKNOWN', runtime: 'claude', gsdDir: '' };
}

/**
 * CLI wiring: resolve against the real filesystem.
 */
function loadUpdateContext(opts = {}) {
  const nodeFs = require('node:fs');
  const fs = {
    exists: (p) => nodeFs.existsSync(p),
    readFile: (p) => { try { return nodeFs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
  };
  return resolveUpdateContext({
    home: opts.home || require('node:os').homedir(),
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    fs,
    preferredConfigDir: opts.preferredConfigDir || '',
    preferredRuntime: opts.preferredRuntime || '',
  });
}

module.exports = { resolveUpdateContext, loadUpdateContext, RUNTIME_DIRS };
