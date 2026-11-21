'use strict';

/**
 * #6091 — the real-loader spawn's environment carries no credential or provider variable, whatever the
 * developer's shell holds, and its arguments disable the plugin's hooks.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { LOADER_CREDENTIAL_KEYS, loaderSpawnEnv, loaderSpawnArgs } = require('./helpers/claude-loader-env.cjs');

const SANDBOX = { HOME: '/sandbox', USERPROFILE: '/sandbox', GSD_HOME: '/sandbox', CLAUDE_CONFIG_DIR: '/sandbox/.claude' };
const has = (env, key) => Object.prototype.hasOwnProperty.call(env, key);

describe('#6091: the loader spawn environment', () => {
  test('every credential/provider variable the issue names is absent (not blank) when set in the parent', () => {
    const parent = { PATH: '/bin', ...Object.fromEntries(LOADER_CREDENTIAL_KEYS.map((k) => [k, 'secret'])) };
    const env = loaderSpawnEnv(parent, SANDBOX);
    for (const key of LOADER_CREDENTIAL_KEYS) assert.equal(has(env, key), false, `${key} must be deleted, not blanked`);
    assert.equal(env.PATH, '/bin', 'unrelated variables pass through');
  });

  test('a credential variable is matched case-insensitively; any ANTHROPIC_* variable and any CLAUDE_CODE_USE_* selector goes too', () => {
    const env = loaderSpawnEnv({
      anthropic_api_key: 'x', Claude_Code_Oauth_Token: 'x', ANTHROPIC_MODEL: 'x', ANTHROPIC_CUSTOM_HEADERS: 'x',
      CLAUDE_CODE_USE_FOUNDRY: '1', claude_code_use_bedrock: '1', PATH: '/bin',
    }, SANDBOX);
    // judged against a literal pattern here, not the implementation's own predicate
    assert.deepEqual(Object.keys(env).filter((k) => /^(anthropic_|claude_code_use_|claude_code_oauth_token$)/i.test(k)), []);
    assert.equal(env.PATH, '/bin');
  });

  test('the sandboxed home wins over the parent, and npm is offline', () => {
    const env = loaderSpawnEnv({ HOME: '/real/home', CLAUDE_CONFIG_DIR: '/real/.claude' }, SANDBOX);
    assert.equal(env.HOME, '/sandbox');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/sandbox/.claude');
    assert.equal(env.npm_config_offline, 'true');
  });

  test('property: whatever subset of credential variables the parent holds, none reaches the spawn', () => {
    const subset = fc.subarray([...LOADER_CREDENTIAL_KEYS, 'ANTHROPIC_MODEL', 'anthropic_api_key']);
    fc.assert(
      fc.property(subset, fc.string(), (keys, value) => {
        const parent = { PATH: '/bin', ...Object.fromEntries(keys.map((k) => [k, value])) };
        const env = loaderSpawnEnv(parent, SANDBOX);
        assert.deepEqual(Object.keys(env).filter((k) => /^(anthropic_|claude_code_use_|claude_code_oauth_token$)/i.test(k)), []);
        assert.equal(env.PATH, '/bin');
      }),
      { numRuns: 50 },
    );
  });

  test('the loader arguments disable the plugin hooks and still run one -p turn with the plugin dir', () => {
    const args = loaderSpawnArgs('/plugin');
    assert.deepEqual(args.slice(0, 3), ['-p', '--plugin-dir', '/plugin']);
    const settings = args[args.indexOf('--settings') + 1];
    assert.deepEqual(JSON.parse(settings), { disableAllHooks: true });
    assert.ok(args.includes('stream-json') && args.includes('--max-turns'));
  });
});
