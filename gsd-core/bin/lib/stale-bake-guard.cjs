'use strict';

/**
 * Stale-bake guard for static-frontmatter runtimes (#1688, follow-up to #1650).
 *
 * Runtimes `codex` and `opencode` bake the resolved model ID into each agent's
 * static config at install time (bin/install.js ~5667-5767 for codex,
 * ~10008-10026 for opencode). Their task/spawn_agent interfaces do not accept
 * an inline `model` parameter, so editing `model_overrides` in
 * `.planning/config.json` or `~/.gsd/defaults.json` has NO effect until the
 * user re-runs `gsd install <runtime>` (or `gsd update`). The failure is
 * silent — the sub-agent just uses the prior base model. This module detects
 * that staleness at workflow entry and emits a single stderr warning.
 *
 * Design: pure decision + formatter (testable, no I/O) backed by fs probes
 * that swallow every error (the guard must never break the CLI). Dedup'd per
 * (runtime, cwd) within a process so a single `gsd-tools init *` invocation
 * warns at most once even though multiple agents resolve models underneath.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Runtimes whose agent config is static frontmatter/TOML baked at install time.
 * MUST stay in sync with the bake paths in bin/install.js. The parity test in
 * tests/stale-bake-guard.test.cjs asserts this matches the runtimes that
 * actually emit a baked model: line id #2256 (opencode) and #49/#2256 (codex).
 */
const STATIC_FRONTMATTER_RUNTIMES = Object.freeze(['codex', 'opencode']);

const _warnedKeys = new Set();

/**
 * Pure: decide whether a stale-bake condition exists.
 *
 * Returns `{ stale: true, deltaMs }` when `configMtimeMs` is strictly newer
 * than `agentMtimeMs` on a static-frontmatter runtime. Returns `null` when the
 * guard does not apply (claude / other spawn-time runtime, missing or
 * non-finite mtimes, or agents already at least as new as config).
 */
function detectStaleBake({ runtime, configMtimeMs, agentMtimeMs }) {
  if (!runtime || !STATIC_FRONTMATTER_RUNTIMES.includes(runtime)) return null;
  if (typeof configMtimeMs !== 'number' || typeof agentMtimeMs !== 'number') return null;
  if (!Number.isFinite(configMtimeMs) || !Number.isFinite(agentMtimeMs)) return null;
  if (configMtimeMs <= agentMtimeMs) return null;
  return { stale: true, deltaMs: configMtimeMs - agentMtimeMs };
}

/**
 * Pure: format the warning string. Returns `''` when no warning is warranted
 * (delegates to detectStaleBake so the decision and the message cannot drift).
 */
function formatStaleBakeWarning({ runtime, configPath, configMtimeMs, agentMtimeMs }) {
  const signal = detectStaleBake({ runtime, configMtimeMs, agentMtimeMs });
  if (!signal) return '';
  const configDate = new Date(configMtimeMs).toISOString();
  const installFlag = runtime === 'opencode' ? '--opencode' : '--codex';
  return [
    `gsd: model config in ${configPath} changed since agents were last baked (${configDate}).`,
    `     Static-frontmatter runtime '${runtime}' ignores the new model_overrides`,
    `     until you re-run:  gsd install ${installFlag}`,
    `     (or 'gsd update')`,
  ].join('\n');
}

/**
 * Pure: resolve the active runtime id from a parsed config object.
 * Returns the runtime string, or `'claude'` when unset (the spawn-time default
 * for which the guard is a no-op).
 */
function resolveRuntimeFromConfig(config) {
  if (config && typeof config === 'object'
      && typeof config.runtime === 'string' && config.runtime) {
    return config.runtime;
  }
  return 'claude';
}

/**
 * Resolve the install root for a runtime's agent files, honoring the same env
 * vars the installer does (CODEX_HOME, OPENCODE_CONFIG_DIR). Returns the
 * absolute directory or `null` for unsupported runtimes.
 */
function resolveAgentDir(runtime, { env = process.env, homedir = os.homedir } = {}) {
  if (runtime === 'opencode') {
    const base = (env.OPENCODE_CONFIG_DIR && String(env.OPENCODE_CONFIG_DIR).trim()) || path.join(homedir(), '.config', 'opencode');
    return path.join(base, 'agent');
  }
  if (runtime === 'codex') {
    const base = (env.CODEX_HOME && String(env.CODEX_HOME).trim()) || path.join(homedir(), '.codex');
    return path.join(base, 'agents');
  }
  return null;
}

/**
 * Find the newest mtime across config sources that exist. Mirrors the
 * up-to-8-levels-up walk in readGsdEffectiveModelOverrides (bin/install.js)
 * and includes the global ~/.gsd/defaults.json. Returns
 * `{ mtimeMs, path }` of the newest existing config, or `null` if none exist.
 *
 * `homedir` is injectable so tests can point the global lookup at a fixture
 * dir (otherwise the real ~/.gsd/defaults.json on the CI runner leaks in and
 * skews the newest-config calculation — see warnIfStaleBake orchestrator).
 */
function findNewestConfigMtime(cwd, { fsStatSync = fs.statSync, homedir = os.homedir } = {}) {
  const candidates = [];
  let probe = path.resolve(cwd || '.');
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(probe, '.planning', 'config.json'));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  candidates.push(path.join(homedir(), '.gsd', 'defaults.json'));

  let newest = null;
  for (const p of candidates) {
    try {
      const st = fsStatSync(p);
      if (st && typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)
          && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { mtimeMs: st.mtimeMs, path: p };
      }
    } catch {
      // not present / unreadable — skip
    }
  }
  return newest;
}

/**
 * Find the oldest mtime across installed gsd-* agent files for the runtime.
 * Returns `{ mtimeMs, dir }` or `null` if the agent dir is absent or holds no
 * gsd-* files (e.g. not yet installed, or uninstalled).
 */
function findOldestAgentMtime(runtime, { env = process.env, homedir = os.homedir, fsStatSync = fs.statSync, fsReaddirSync = fs.readdirSync } = {}) {
  const dir = resolveAgentDir(runtime, { env, homedir });
  if (!dir) return null;
  let entries;
  try {
    entries = fsReaddirSync(dir, { withFileTypes: true });
  } catch {
    return null; // dir missing — runtime not installed for this user
  }
  let oldest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('gsd-')) continue;
    const isAgentFile = (runtime === 'opencode' && entry.name.endsWith('.md'))
      || (runtime === 'codex' && (entry.name.endsWith('.toml') || entry.name.endsWith('.md')));
    if (!isAgentFile) continue;
    try {
      const st = fsStatSync(path.join(dir, entry.name));
      if (st && typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)
          && (!oldest || st.mtimeMs < oldest.mtimeMs)) {
        oldest = { mtimeMs: st.mtimeMs, dir };
      }
    } catch {
      // unreadable — skip
    }
  }
  return oldest;
}

/**
 * Orchestrator (side-effecting): probe fs, decide, write warning to stderr.
 *
 * - Silent on claude / other spawn-time runtimes (returns false).
 * - Silent when agents are already at least as new as config.
 * - Silent when config or agent dir is absent (nothing to compare).
 * - Dedup'd per (runtime, cwd): a single process warns at most once per pair,
 *   so repeated `resolveModelInternal` calls under one `gsd-tools init *` do
 *   not repeat the warning.
 * - Swallows every error: a warning helper must never break the CLI.
 *
 * Pass `config` to skip the internal JSON read (caller already loaded it).
 * Returns `true` if a warning was written, `false` otherwise.
 */
function warnIfStaleBake(cwd, options = {}) {
  const {
    stderr = process.stderr,
    config = null,
    env = process.env,
    homedir = os.homedir,
    fsStatSync = fs.statSync,
    fsReaddirSync = fs.readdirSync,
  } = options;
  try {
    const resolvedConfig = config || _readRuntimeConfig(cwd, { fsStatSync });
    const runtime = resolveRuntimeFromConfig(resolvedConfig);
    if (!STATIC_FRONTMATTER_RUNTIMES.includes(runtime)) return false;

    const dedupKey = `${runtime}::${path.resolve(cwd || '.')}`;
    if (_warnedKeys.has(dedupKey)) return false;

    const newest = findNewestConfigMtime(cwd, { fsStatSync, homedir });
    const oldest = findOldestAgentMtime(runtime, { env, homedir, fsStatSync, fsReaddirSync });
    if (!newest || !oldest) return false;

    const warning = formatStaleBakeWarning({
      runtime,
      configPath: newest.path,
      configMtimeMs: newest.mtimeMs,
      agentMtimeMs: oldest.mtimeMs,
    });
    if (!warning) return false;

    stderr.write(warning + '\n');
    _warnedKeys.add(dedupKey);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort minimal read of `.planning/config.json` for the `runtime` key. */
function _readRuntimeConfig(cwd, { fsStatSync = fs.statSync } = {}) {
  let probe = path.resolve(cwd || '.');
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(probe, '.planning', 'config.json');
    try {
      fsStatSync(candidate);
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      return {};
    } catch {
      // not present / unreadable / malformed — walk up
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return {};
}

/** Test-only: reset the in-process dedup set between cases. */
function _resetWarnedForTests() {
  _warnedKeys.clear();
}

module.exports = {
  STATIC_FRONTMATTER_RUNTIMES,
  detectStaleBake,
  formatStaleBakeWarning,
  resolveRuntimeFromConfig,
  resolveAgentDir,
  findNewestConfigMtime,
  findOldestAgentMtime,
  warnIfStaleBake,
  _resetWarnedForTests,
};
