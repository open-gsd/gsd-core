'use strict';

/**
 * Fixtures shared by the two test files of hooks/gsd-agent-isolation-guard.js: the isolation suite
 * (tests/gsd-agent-isolation-guard.test.cjs) and the Agent-model check suite (tests/agent-model-check.test.cjs, #5328).
 * One owner of the hook runner, the git-inited project fixture and the config writer.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runHook: runHookSeam } = require('./process-seam.cjs');
const { toLegacyResult } = require('./git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');
const { createFixture } = require('../fixtures/index.cjs');

const HOOK_PATH = path.join(__dirname, '..', '..', 'hooks', 'gsd-agent-isolation-guard.js');

/**
 * Run the hook with a given payload against a given cwd.
 * GSD_RUNTIME is deleted by default so ambient environment can never leak a
 * runtime override into a test that expects the config.json `runtime` key
 * (or the 'claude' default) to be used instead.
 */
function runHook(payload, cwd, extraEnv = {}) {
  const env = { ...process.env };
  delete env.GSD_RUNTIME;
  Object.assign(env, extraEnv);
  // Production code resolves the home directory via `os.homedir()` (correct,
  // cross-platform), which on Windows reads `USERPROFILE`, not `HOME` —
  // `os.homedir()` never honors `HOME` there. Tests below override `HOME` to
  // redirect `os.homedir()` hermetically; mirror the override onto
  // `USERPROFILE` too so that redirection actually takes effect on Windows
  // instead of silently leaking the real CI runner's profile directory.
  if ('HOME' in extraEnv) env.USERPROFILE = extraEnv.HOME;
  // #5017: the defaults store root is GSD_HOME when set, and the test runner exports a sandbox
  // GSD_HOME to every test — so redirecting only HOME no longer redirects the store. A test that
  // redirects HOME redirects the store with it, unless it names GSD_HOME itself.
  if ('HOME' in extraEnv && !('GSD_HOME' in extraEnv)) env.GSD_HOME = extraEnv.HOME;
  const r = runHookSeam(HOOK_PATH, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return toLegacyResult(r);
}

function mkProject(prefix) {
  // #4734: git-inited with a real HEAD. Production GSD project roots are git
  // repositories, and the guard's fallback now degrades to 'none' when the
  // root has NO repository — a non-git fixture here would exercise that
  // degrade instead of the fallback enforcement these suites pin. The
  // dedicated non-git world lives in the #4734 describe of the isolation suite.
  return createFixture({ prefix, planning: true, git: true, projectDoc: false });
}

function writeConfig(dir, content) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), content);
}

module.exports = { HOOK_PATH, runHook, mkProject, writeConfig };
