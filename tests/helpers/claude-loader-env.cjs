'use strict';

/**
 * #6091 — the environment and arguments for the test that starts the REAL Claude Code loader.
 *
 * `claude -p` authenticates from `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`
 * independently of `CLAUDE_CONFIG_DIR`, and `spawnSync` waits for the whole process, not for `system init`. A
 * loader spawn that inherits the developer's credential variables therefore runs on past `init` into a real model
 * call on their account, and the plugin's SessionStart hook spawns the detached update worker, whose `npm view`
 * reaches the registry. The loader test only needs the `init` event's slash-command list, so its spawn carries no
 * credential or provider-selection variable (absent, not blank: an empty string is still a value), runs offline,
 * and disables hooks.
 */

/** Variables that select an account or a provider, removed from the loader spawn's environment. */
const LOADER_CREDENTIAL_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);

const CREDENTIAL_KEY_SET = new Set(LOADER_CREDENTIAL_KEYS);
// Every other ANTHROPIC_* variable (model pins, proxies, headers) and every CLAUDE_CODE_USE_* provider selector
// (Bedrock, Vertex, and any later one) is account/provider configuration too.
const ACCOUNT_PREFIX_RE = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/i;

function isCredentialKey(key) {
  return CREDENTIAL_KEY_SET.has(key.toUpperCase()) || ACCOUNT_PREFIX_RE.test(key);
}

/**
 * The loader spawn's environment: the parent's, minus every credential/provider variable (matched
 * case-insensitively, as Windows environments are), with the sandboxed home and an offline npm.
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {object} overrides - sandboxed HOME / USERPROFILE / GSD_HOME / CLAUDE_CONFIG_DIR and the suite scrub.
 */
function loaderSpawnEnv(parentEnv, overrides) {
  const env = { ...parentEnv, ...overrides };
  for (const key of Object.keys(env)) {
    if (isCredentialKey(key)) delete env[key];
  }
  // Belt and braces for a hook that still runs: the update worker's `npm view` fails from cache.
  env.npm_config_offline = 'true';
  return env;
}

/** Arguments of the loader spawn: one `-p` turn that never needs auth, with the plugin's hooks off. */
function loaderSpawnArgs(pluginDir) {
  return [
    '-p', '--plugin-dir', pluginDir, '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--model', 'haiku',
    // The check reads only `system init`; disabling hooks keeps the SessionStart update worker from running.
    '--settings', JSON.stringify({ disableAllHooks: true }),
    'reply ok',
  ];
}

module.exports = { LOADER_CREDENTIAL_KEYS, loaderSpawnEnv, loaderSpawnArgs, isCredentialKey };
