'use strict';

/**
 * Platform-sensitive tests split out of tests/config.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/config.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - #4976 config-new-project (nine tests) and init new-project (two tests) —
 *   defaults, migration writes and provider keys must resolve through GSD_HOME
 *   instead of the separate OS home (USERPROFILE on Windows). These regressions
 *   are introduced by PR #5015 and live in this platform suite; they were not
 *   part of the upstream config.test.cjs / init.test.cjs platform split.
 * - #5268 config-new-project (three tests) — the deferred depth -> granularity
 *   rewrite of the user defaults file must land in $GSD_HOME, not in the OS home
 *   that HOME and USERPROFILE point at (USERPROFILE on Windows), and only once
 *   config.json is written.
 * - "detects Brave Search from file-based key" — reads brave_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Tavily Search from env var" — asserts TAVILY_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "tavily_search is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Tavily Search from file-based key" — reads tavily_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Ref Search from env var" — asserts REF_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "ref_search is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Ref Search from file-based key" — reads ref_api_key from the sandboxed
 *   home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Perplexity from env var" — asserts PERPLEXITY_API_KEY detection resolved
 *   against the sandboxed home directory (windows-env-var)
 * - "perplexity is false when env var absent and no key file" — asserts absence
 *   against the sandboxed home — on Windows only USERPROFILE keeps a real key file
 *   from leaking in (windows-env-var)
 * - "detects Perplexity from file-based key" — reads perplexity_api_key from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "detects Jina from env var" — asserts JINA_API_KEY detection resolved against
 *   the sandboxed home directory (windows-env-var)
 * - "jina is false when env var absent and no key file" — asserts absence against
 *   the sandboxed home — on Windows only USERPROFILE keeps a real key file from
 *   leaking in (windows-env-var)
 * - "detects Jina from file-based key" — reads jina_api_key from the sandboxed home
 *   directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "merges user defaults from defaults.json" — reads defaults.json from the
 *   sandboxed home directory, resolved via USERPROFILE on Windows (windows-env-var)
 * - "merges nested workflow keys from defaults.json preserving unset keys" — same
 *   defaults.json read from the sandboxed home directory, resolved via USERPROFILE
 *   on Windows (windows-env-var)
 * - #5681 "a symlinked store is written through, and the link survives" — creates
 *   a real file symlink at defaults.json; creation needs privilege on Windows
 *   (symlink-keyword)
 * - #5681 "a dangling symlinked store is refused, and the link is left as it was"
 *   — creates a real dangling file symlink (symlink-keyword)
 * - #5681 "a FIFO at defaults.json is refused instead of waited on" and the two
 *   "planted at the old predictable temp name" rows — create real named pipes with
 *   `mkfifo` and a real file symlink; there is no FIFO on Windows and the temp-file
 *   hardening they pin (#5759) is POSIX link semantics (process-platform,
 *   raw-child-process, symlink-keyword). Skipped on win32.
 * - #5681 "a save keeps the store file mode" — asserts POSIX mode bits (0600) on the
 *   replaced store; Windows has no such bits (process-platform). Skipped on win32.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { runGsdTools, createTempProject, createTempDir, cleanup, homeSandboxEnv, installSpawnEnv, TOOLS_PATH } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createFixture } = require('./fixtures/index.cjs');

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// #4976: GSD_HOME and the OS home contain distinct stores; both setup commands
// must use the GSD-owned store for defaults and provider-key detection.
describe('#4976: config-new-project resolves the global-defaults store through GSD_HOME', () => {
  let tmpDir;
  let gsdHome;
  let decoyHome;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-4976-project-');
    gsdHome = createTempDir('gsd-4976-gsd-home-');
    decoyHome = createTempDir('gsd-4976-os-home-');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(gsdHome);
    cleanup(decoyHome);
  });

  // Every per-provider probe: the key file, the config key it sets, and the env
  // var that would otherwise satisfy it (blanked so only the file can).
  const API_KEY_PROBES = [
    { file: 'brave_api_key', key: 'brave_search', env: 'BRAVE_API_KEY' },
    { file: 'firecrawl_api_key', key: 'firecrawl', env: 'FIRECRAWL_API_KEY' },
    { file: 'exa_api_key', key: 'exa_search', env: 'EXA_API_KEY' },
    { file: 'tavily_api_key', key: 'tavily_search', env: 'TAVILY_API_KEY' },
    { file: 'ref_api_key', key: 'ref_search', env: 'REF_API_KEY' },
    { file: 'perplexity_api_key', key: 'perplexity', env: 'PERPLEXITY_API_KEY' },
    { file: 'jina_api_key', key: 'jina', env: 'JINA_API_KEY' },
  ];

  function writeStoreFile(home, name, content) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', name), content, 'utf-8');
  }

  function readStoreDefaults(home) {
    return JSON.parse(fs.readFileSync(path.join(home, '.gsd', 'defaults.json'), 'utf-8'));
  }

  // withGsdHome: false leaves GSD_HOME to runGsdTools, which blanks it for
  // every child — and a blank GSD_HOME is unset under `GSD_HOME || homedir()`.
  function storeEnv({ withGsdHome = true } = {}) {
    const env = { HOME: decoyHome, USERPROFILE: decoyHome };
    if (withGsdHome) env.GSD_HOME = gsdHome;
    for (const probe of API_KEY_PROBES) env[probe.env] = '';
    return env;
  }

  test('seeds the project config from $GSD_HOME/.gsd/defaults.json, not the home directory copy', () => {
    writeStoreFile(gsdHome, 'defaults.json', JSON.stringify({
      model_profile: 'budget',
      commit_docs: false,
      workflow: { research: false },
    }));
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({
      model_profile: 'quality',
      commit_docs: true,
      workflow: { research: true },
    }));

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'budget');
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(config.workflow.research, false);
  });

  test('seeds the same defaults.json the config loader resolves in the same run', (t) => {
    // `init new-project` outside any project resolves through the loader's
    // global-defaults branch — the /gsd-new-project step that precedes
    // config-new-project, and the file the #3532 shadow warning later names.
    const bareDir = createTempDir('gsd-4976-bare-');
    t.after(() => cleanup(bareDir));
    writeStoreFile(gsdHome, 'defaults.json', JSON.stringify({ commit_docs: false }));
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({ commit_docs: true }));

    const loaderRun = runGsdTools(['init', 'new-project'], bareDir, storeEnv());
    assert.ok(loaderRun.success, `init new-project failed: ${loaderRun.error}`);
    const created = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(created.success, `config-new-project failed: ${created.error}`);

    assert.strictEqual(JSON.parse(loaderRun.output).commit_docs, false);
    assert.strictEqual(readConfig(tmpDir).commit_docs, false);
  });

  test('detects every provider from a key file under $GSD_HOME/.gsd', () => {
    for (const probe of API_KEY_PROBES) writeStoreFile(gsdHome, probe.file, 'gsd-home-key');

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    for (const probe of API_KEY_PROBES) {
      assert.strictEqual(config[probe.key], true, `${probe.key} must come from $GSD_HOME/.gsd/${probe.file}`);
    }
  });

  test('ignores key files in the home directory store when GSD_HOME is set', () => {
    for (const probe of API_KEY_PROBES) writeStoreFile(decoyHome, probe.file, 'decoy-key');

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    for (const probe of API_KEY_PROBES) {
      assert.strictEqual(config[probe.key], false, `${probe.key} must not be read from the home directory store`);
    }
  });

  test('writes the depth -> granularity migration back to $GSD_HOME and leaves the home directory copy untouched', () => {
    writeStoreFile(gsdHome, 'defaults.json', JSON.stringify({ depth: 'quick' }));
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({ depth: 'comprehensive' }));

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.strictEqual(readConfig(tmpDir).granularity, 'coarse');
    assert.deepStrictEqual(readStoreDefaults(gsdHome), { granularity: 'coarse' });
    assert.deepStrictEqual(readStoreDefaults(decoyHome), { depth: 'comprehensive' });
  });

  test('without GSD_HOME the home directory store still seeds the config and the key probes', () => {
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({ model_profile: 'quality', commit_docs: false }));
    writeStoreFile(decoyHome, 'tavily_api_key', 'home-key');

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv({ withGsdHome: false }));
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality');
    assert.strictEqual(config.commit_docs, false);
    assert.strictEqual(config.tavily_search, true);
  });

  // Baseline for the degraded-input cases below: a project seeded while BOTH
  // stores are empty, i.e. from the built-in defaults alone.
  function builtInDefaultsConfig(t) {
    const baselineDir = createTempProject('gsd-4976-baseline-');
    t.after(() => cleanup(baselineDir));
    const baseline = runGsdTools(['config-new-project', '{}'], baselineDir, storeEnv());
    assert.ok(baseline.success, `Baseline config-new-project failed: ${baseline.error}`);
    return readConfig(baselineDir);
  }

  function writeDecoyStore() {
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({ model_profile: 'quality', commit_docs: false }));
    for (const probe of API_KEY_PROBES) writeStoreFile(decoyHome, probe.file, 'decoy-key');
  }

  // QA matrix — missing input: GSD_HOME names a directory that does not exist.
  test('a GSD_HOME without a store yields the built-in defaults, never the home directory store', (t) => {
    const expected = builtInDefaultsConfig(t);
    writeDecoyStore();
    const missingHome = path.join(gsdHome, 'does-not-exist');

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { ...storeEnv(), GSD_HOME: missingHome });
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(readConfig(tmpDir), expected);
    assert.strictEqual(fs.existsSync(missingHome), false, 'seeding must not create a store under GSD_HOME');
  });

  // QA matrix — malformed input: an unparseable $GSD_HOME/.gsd/defaults.json
  // degrades to the built-in defaults; it must not fall through to the home store.
  test('an unparseable $GSD_HOME defaults.json degrades to the built-in defaults, not the home directory copy', (t) => {
    const expected = builtInDefaultsConfig(t);
    writeDecoyStore();
    writeStoreFile(gsdHome, 'defaults.json', '{"model_profile": "budget"');

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, storeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.deepStrictEqual(readConfig(tmpDir), expected);
  });

  // QA matrix — cross-platform path: spaces and non-ASCII characters in GSD_HOME.
  test('a GSD_HOME path containing spaces and non-ASCII characters is honored', (t) => {
    const spacedHome = createTempDir('gsd 4976 höme ');
    t.after(() => cleanup(spacedHome));
    writeStoreFile(spacedHome, 'defaults.json', JSON.stringify({ model_profile: 'budget' }));
    writeStoreFile(decoyHome, 'defaults.json', JSON.stringify({ model_profile: 'quality' }));

    const result = runGsdTools(['config-new-project', '{}'], tmpDir, { ...storeEnv(), GSD_HOME: spacedHome });
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.strictEqual(readConfig(tmpDir).model_profile, 'budget');
  });
});

// #5268: config-new-project rewrites the user defaults file only after
// config.json is written. HOME and USERPROFILE point at the project dir and
// GSD_HOME at a separate store, so a rewrite resolved through the OS home
// instead of GSD_HOME fails these.
describe('#5268: config-new-project defers the user-defaults rewrite until config.json is written', () => {
  let dirs;

  beforeEach(() => { dirs = []; });
  afterEach(() => { dirs.forEach((dir) => cleanup(dir)); });

  // A bare directory: no .planning/, so a refusal that created anything shows.
  function bareDir() {
    const dir = createTempDir();
    dirs.push(dir);
    return dir;
  }

  function assertNothingWritten(dir) {
    assert.strictEqual(fs.existsSync(path.join(dir, '.planning')), false, '.planning must not be created');
  }

  test('--dry-run leaves the user defaults file unmigrated', () => {
    const dir = bareDir();
    const gsdHome = bareDir();
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    const defaultsBefore = JSON.stringify({ depth: 'quick' });
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, defaultsBefore);

    const result = runGsdTools(['config-new-project', '{}', '--dry-run'], dir, { ...homeSandboxEnv(dir), GSD_HOME: gsdHome });

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).config.granularity, 'coarse');
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), defaultsBefore);
    assertNothingWritten(dir);
  });

  test('a payload refused while the config is built leaves the user defaults file unmigrated', () => {
    const dir = bareDir();
    const gsdHome = bareDir();
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    // The choices are valid; the user defaults are not (their contents are
    // not validated as choices), so the builder's own array check refuses.
    const defaultsBefore = JSON.stringify({ depth: 'quick', ship: { pr_body_sections: 'not-a-list' } });
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, defaultsBefore);

    const result = runGsdTools(['config-new-project', JSON.stringify({ mode: 'yolo' })], dir, { ...homeSandboxEnv(dir), GSD_HOME: gsdHome });

    assert.strictEqual(result.success, false);
    assert.match(result.error, /Invalid ship\.pr_body_sections value/);
    assert.strictEqual(fs.readFileSync(defaultsPath, 'utf-8'), defaultsBefore);
    assertNothingWritten(dir);
  });

  test('a successful creation migrates the user defaults file', () => {
    const dir = bareDir();
    const gsdHome = bareDir();
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, JSON.stringify({ depth: 'quick' }));

    const result = runGsdTools(['config-new-project', '{}'], dir, { ...homeSandboxEnv(dir), GSD_HOME: gsdHome });

    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { granularity: 'coarse' });
  });
});

describe('cmdInitNewProject: API-key probes resolve through GSD_HOME (#4976)', () => {
  let tmpDir;
  let gsdHome;
  let decoyHome;

  beforeEach(() => {
    tmpDir = createFixture();
    gsdHome = createTempDir('gsd-4976-gsd-home-');
    decoyHome = createTempDir('gsd-4976-os-home-');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(gsdHome);
    cleanup(decoyHome);
  });

  const API_KEY_PROBES = [
    { file: 'brave_api_key', field: 'brave_search_available', env: 'BRAVE_API_KEY' },
    { file: 'firecrawl_api_key', field: 'firecrawl_available', env: 'FIRECRAWL_API_KEY' },
    { file: 'exa_api_key', field: 'exa_search_available', env: 'EXA_API_KEY' },
  ];

  function writeKeyFiles(home) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    for (const probe of API_KEY_PROBES) {
      fs.writeFileSync(path.join(home, '.gsd', probe.file), 'test-key', 'utf-8');
    }
  }

  function probeEnv() {
    const env = { GSD_HOME: gsdHome, HOME: decoyHome, USERPROFILE: decoyHome };
    for (const probe of API_KEY_PROBES) env[probe.env] = '';
    return env;
  }

  test('reports a provider available from a key file under $GSD_HOME/.gsd', () => {
    writeKeyFiles(gsdHome);

    const result = runGsdTools('init new-project', tmpDir, probeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const probe of API_KEY_PROBES) {
      assert.strictEqual(output[probe.field], true, `${probe.field} must come from $GSD_HOME/.gsd/${probe.file}`);
    }
  });

  test('ignores key files in the home directory store when GSD_HOME is set', () => {
    writeKeyFiles(decoyHome);

    const result = runGsdTools('init new-project', tmpDir, probeEnv());
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const probe of API_KEY_PROBES) {
      assert.strictEqual(output[probe.field], false, `${probe.field} must not be read from the home directory store`);
    }
  });
});

// ─── config-ensure-section (home-resolved API-key / defaults.json tests) ──────

describe('config-ensure-section command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('detects Brave Search from file-based key', () => {
    // runGsdTools sandboxes HOME=tmpDir, so brave_api_key is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'brave_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.brave_search, true);
  });

  test('detects Tavily Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('tavily_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, false);
  });

  test('detects Tavily Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'tavily_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, TAVILY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.tavily_search, true);
  });

  test('detects Ref Search from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('ref_search is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, false);
  });

  test('detects Ref Search from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'ref_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, REF_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.ref_search, true);
  });

  test('detects Perplexity from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('perplexity is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, false);
  });

  test('detects Perplexity from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'perplexity_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, PERPLEXITY_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.perplexity, true);
  });

  test('detects Jina from env var', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: 'test-key' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('jina is false when env var absent and no key file', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, false);
  });

  test('detects Jina from file-based key', () => {
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'jina_api_key'), 'test-key', 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir, JINA_API_KEY: '' });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.jina, true);
  });

  test('merges user defaults from defaults.json', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      model_profile: 'quality',
      commit_docs: false,
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.model_profile, 'quality', 'model_profile should be overridden');
    assert.strictEqual(config.commit_docs, false, 'commit_docs should be overridden');
    assert.ok(config.git && typeof config.git === 'object', 'git should be an object');
    assert.strictEqual(typeof config.git.branching_strategy, 'string', 'git.branching_strategy should be a string');
  });

  test('merges nested workflow keys from defaults.json preserving unset keys', () => {
    // runGsdTools sandboxes HOME=tmpDir, so defaults.json is written there —
    // no real filesystem side effects, cleanup happens via afterEach.
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({
      workflow: { research: false },
    }), 'utf-8');

    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.strictEqual(config.workflow.research, false, 'research should be overridden');
    assert.strictEqual(typeof config.workflow.plan_check, 'boolean', 'plan_check should be a boolean');
    assert.strictEqual(typeof config.workflow.verifier, 'boolean', 'verifier should be a boolean');
  });
});

describe('#5681: a symlinked defaults store', () => {
  test('a symlinked store is written through, and the link survives', { skip: process.platform === 'win32' }, (t) => {
    const gsdHome = createTempDir('gsd-5681-link-');
    const dotfiles = createTempDir('gsd-5681-dotfiles-');
    t.after(() => { cleanup(gsdHome); cleanup(dotfiles); });
    const real = path.join(dotfiles, 'defaults.json');
    fs.writeFileSync(real, JSON.stringify({ runtime: 'codex', model_profile: 'quality' }));
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.symlinkSync(real, defaultsPath);

    const result = runGsdTools(['config-save-defaults', JSON.stringify({ model_profile: 'balanced' })], gsdHome, { GSD_HOME: gsdHome });
    assert.ok(result.success, result.error);
    assert.ok(fs.lstatSync(defaultsPath).isSymbolicLink(), 'the store must still be a symlink after a save');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(real, 'utf-8')), { runtime: 'codex', model_profile: 'balanced' },
      'the save must land in the link target, merged');
  });

  // Codex review: existsSync follows a link, so a dangling one read as a missing
  // store and the write replaced the link with a regular file.
  test('a dangling symlinked store is refused, and the link is left as it was', { skip: process.platform === 'win32' }, (t) => {
    const gsdHome = createTempDir('gsd-5681-dangling-');
    t.after(() => cleanup(gsdHome));
    const missing = path.join(gsdHome, 'unmounted', 'defaults.json');
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.symlinkSync(missing, defaultsPath);

    const result = runGsdTools(['--json-errors', 'config-save-defaults', JSON.stringify({ model_profile: 'balanced' })], gsdHome, { GSD_HOME: gsdHome });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(JSON.parse(result.error).reason, 'config_defaults_invalid');
    assert.ok(fs.lstatSync(defaultsPath).isSymbolicLink(), 'the link must survive a refused save');
    assert.strictEqual(fs.readlinkSync(defaultsPath), missing);
    assert.ok(!fs.existsSync(missing), 'nothing is written at the missing target');
  });
});

// The store is a config file like any other (#5759): it is read as a bounded regular
// file, so a FIFO there cannot block the save, and it is replaced through a temp file
// created exclusively under a random name, so nothing planted beside it is opened.
describe('#5681: the defaults store is read bounded and replaced through an exclusive temp file', {
  skip: process.platform === 'win32' ? 'no FIFOs on Windows' : false,
}, () => {
  const CONFIG_LIB_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config.cjs');
  const PATCH = JSON.stringify({ model_profile: 'balanced' });

  function seedStore(t, contents) {
    const gsdHome = createTempDir('gsd-5681-bounded-');
    t.after(() => cleanup(gsdHome));
    const defaultsPath = path.join(gsdHome, '.gsd', 'defaults.json');
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    if (contents !== undefined) fs.writeFileSync(defaultsPath, contents);
    return { gsdHome, defaultsPath };
  }

  test('a FIFO at defaults.json is refused instead of waited on, and is left a FIFO', (t) => {
    const { gsdHome, defaultsPath } = seedStore(t);
    execFileSync('mkfifo', [defaultsPath], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });

    const r = runNode([TOOLS_PATH, '--json-errors', 'config-save-defaults', PATCH], {
      cwd: gsdHome,
      env: installSpawnEnv({ GSD_HOME: gsdHome }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    assert.strictEqual(r.outcome, OUTCOME.EXITED, `the save must return, not block on the FIFO: ${r.summary}`);
    assert.strictEqual(r.exitCode, 1, r.summary);
    assert.strictEqual(JSON.parse(r.stderr.trim()).reason, 'config_defaults_invalid');
    assert.ok(fs.lstatSync(defaultsPath).isFIFO(), 'the FIFO is left as it was');
  });

  // The pre-fix temp name was `<store>.tmp-<pid>`, so the child plants its own
  // pid-keyed entry before it saves. A random-suffixed exclusive temp never meets it.
  const PLANTED_TMP_SCRIPT = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { execFileSync } = require("node:child_process");',
    'const config = require(process.argv[1]);',
    'const gsdHome = process.argv[2];',
    'const planted = path.join(gsdHome, ".gsd", "defaults.json") + ".tmp-" + process.pid;',
    'if (process.argv[3] === "fifo") execFileSync("mkfifo", [planted]);',
    'else fs.symlinkSync(process.argv[4], planted);',
    'config.cmdConfigSaveDefaults(gsdHome, process.argv[5], false);',
  ].join('\n');

  function saveWithPlanted(gsdHome, kind, victim = '') {
    return runNode(['-e', PLANTED_TMP_SCRIPT, CONFIG_LIB_PATH, gsdHome, kind, victim, PATCH], {
      cwd: gsdHome,
      env: installSpawnEnv({ GSD_HOME: gsdHome }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  test('a symlink planted at the old predictable temp name is not written through', (t) => {
    const { gsdHome, defaultsPath } = seedStore(t, JSON.stringify({ runtime: 'codex' }));
    const victim = path.join(gsdHome, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');

    const r = saveWithPlanted(gsdHome, 'symlink', victim);

    assert.strictEqual(r.outcome, OUTCOME.EXITED, r.summary);
    assert.strictEqual(r.exitCode, 0, r.summary);
    assert.strictEqual(fs.readFileSync(victim, 'utf-8'), 'ORIGINAL', 'the link target is never written');
    assert.ok(fs.lstatSync(defaultsPath).isFile(), 'the store is a regular file, not the planted link');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { runtime: 'codex', model_profile: 'balanced' });
  });

  // The store is replaced by rename, so the replacement's creation mode is what the
  // store ends with: a private store must not come back group- and world-readable.
  test('a save keeps the store file mode', (t) => {
    const { gsdHome, defaultsPath } = seedStore(t, JSON.stringify({ runtime: 'codex' }));
    fs.chmodSync(defaultsPath, 0o600);

    const result = runGsdTools(['config-save-defaults', PATCH], gsdHome, { GSD_HOME: gsdHome });

    assert.ok(result.success, result.error);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(defaultsPath).mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { runtime: 'codex', model_profile: 'balanced' });
  });

  test('a FIFO planted at the old predictable temp name does not hang the save', (t) => {
    const { gsdHome, defaultsPath } = seedStore(t, JSON.stringify({ runtime: 'codex' }));

    const r = saveWithPlanted(gsdHome, 'fifo');

    assert.strictEqual(r.outcome, OUTCOME.EXITED, `the save must return, not block on the planted FIFO: ${r.summary}`);
    assert.strictEqual(r.exitCode, 0, r.summary);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')), { runtime: 'codex', model_profile: 'balanced' });
  });
});
