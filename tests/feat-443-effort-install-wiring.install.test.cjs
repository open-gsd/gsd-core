// allow-test-rule: integration-test-input
// Exercises install() + generateCodexAgentToml() as a black-box by inspecting
// produced output files in temp dirs. Source agent .md files are inputs whose
// installed transformation is asserted — not inspected for string presence.

/**
 * #443 — Effort per-runtime wiring at install time.
 *
 * Verifies:
 *   1. Claude global install injects `effort:` into agent .md frontmatter.
 *   2. Gemini global install does NOT inject `effort:` (Gemini-safe .md).
 *   3. Codex global install emits `model_reasoning_effort` in .toml via the
 *      unified resolver (not the old catalog-static path).
 *   4. Config-driven proof: effort.agent_overrides wins over tier defaults
 *      for both Claude .md and Codex .toml.
 *   5. Source agents/gsd-planner.md has NO effort: key (injection is
 *      install-only, source stays Gemini-safe).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_AGENTS_DIR = path.join(REPO_ROOT, 'agents');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for the given runtime, redirecting its home dir to
 * tmpHome. Returns the tmpHome for inspection.
 *
 * Env-var redirection:
 *   claude   → CLAUDE_CONFIG_DIR
 *   gemini   → GEMINI_CONFIG_DIR
 *   codex    → CODEX_HOME
 *
 * HOME is also redirected to an isolated temp dir for the duration of the
 * install call. This prevents any install.js code that uses os.homedir()
 * directly (e.g. ~/.cache/gsd update-check deletion, ~/.gsd/defaults.json
 * reads, stale-SDK npm subprocess writes to ~/.npm) from touching the real
 * HOME and polluting the test environment for other concurrently-running
 * test files (e.g. runtime-launcher-parity test (D) checks that
 * $HOME/.claude/gsd-core/bin/gsd-tools.cjs is absent).
 *
 * GSD_SKIP_STALE_SDK_CHECK=1 is set to suppress the `npm ls -g` subprocess
 * that the installer spawns for global installs — that subprocess is slow,
 * writes to ~/.npm cache, and is irrelevant to effort-wiring assertions.
 *
 * The working directory is set to REPO_ROOT so install() can find the source
 * agents/. For config-driven tests, place tmpHome inside the project dir
 * so that readGsdEffectiveEffortConfig(targetDir) can walk up from tmpHome
 * and find .planning/config.json.
 */
function runGlobalInstall(runtime, tmpHome) {
  const envVarMap = {
    claude: 'CLAUDE_CONFIG_DIR',
    gemini: 'GEMINI_CONFIG_DIR',
    codex: 'CODEX_HOME',
  };
  const envVar = envVarMap[runtime];
  if (!envVar) throw new Error(`Unsupported runtime in test: ${runtime}`);

  // Isolate HOME to a fresh temp dir so install.js code that calls
  // os.homedir() (cache deletion, defaults.json reads, npm subprocess)
  // never touches the real $HOME/.claude / $HOME/.cache / $HOME/.gsd.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-443-home-'));

  const prev = process.env[envVar];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env[envVar] = tmpHome;
  process.env.HOME = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, runtime);
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env[envVar];
    else process.env[envVar] = prev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    // Clean up the isolated HOME dir
    cleanup(isolatedHome);
  }

  return tmpHome;
}

// ─── Tier default expectations ────────────────────────────────────────────────
// light → low, standard → high, heavy → xhigh  (catalog defaults)
// gsd-planner: heavy → xhigh
// gsd-codebase-mapper: light → low
// gsd-executor: standard → high

// ─── describe 1: Claude install injects effort: ───────────────────────────────

describe('#443 Claude install: effort: injected into frontmatter', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.md contains effort: xhigh (heavy tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*xhigh$/m,
      `gsd-planner frontmatter should have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-codebase-mapper.md contains effort: low (light tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-codebase-mapper.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-codebase-mapper frontmatter should have effort: low\nActual:\n${fm}`);
  });

  test('gsd-executor.md contains effort: high (standard tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-executor.md'));
    assert.match(fm, /^effort:\s*high$/m,
      `gsd-executor frontmatter should have effort: high\nActual:\n${fm}`);
  });
});

// ─── describe 2: Gemini install does NOT inject effort: ──────────────────────

describe('#443 Gemini install: effort: absent (Gemini-safe)', () => {
  let tmpDir;
  let geminiHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-gemini-');
    geminiHome = path.join(tmpDir, 'gemini-home');
    fs.mkdirSync(geminiHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.md does NOT contain effort: (Gemini install)', () => {
    runGlobalInstall('gemini', geminiHome);
    const fm = readFrontmatter(path.join(geminiHome, 'agents', 'gsd-planner.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `gsd-planner (Gemini) frontmatter must NOT have effort:\nActual:\n${fm}`);
  });

  test('gsd-executor.md does NOT contain effort: (Gemini install)', () => {
    runGlobalInstall('gemini', geminiHome);
    const fm = readFrontmatter(path.join(geminiHome, 'agents', 'gsd-executor.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `gsd-executor (Gemini) frontmatter must NOT have effort:\nActual:\n${fm}`);
  });
});

// ─── describe 3: Codex install emits model_reasoning_effort in .toml ─────────

describe('#443 Codex install: model_reasoning_effort in .toml (unified resolver)', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-codex-');
    codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.toml contains model_reasoning_effort = "xhigh" (heavy tier)', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"xhigh"$/m,
      `gsd-planner.toml should have model_reasoning_effort = "xhigh"\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 4: Config-driven proof ─────────────────────────────────────────
//
// The runtime home dir must be INSIDE (or a sibling of) the project root so
// that readGsdEffectiveEffortConfig(targetDir) can walk up from the runtime
// home and find .planning/config.json. We put .claude/ and .codex/ as siblings
// of .planning/ inside the project dir — this is the natural local-install shape.

describe('#443 Config-driven: effort.agent_overrides drives install-time effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root (cwd for install)
    //           .planning/config.json
    //           .claude/          <-- claudeHome (CLAUDE_CONFIG_DIR)
    //           .codex/           <-- codexHome (CODEX_HOME)
    tmpDir = makeTmpDir('gsd-443-cfg-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });

    // Write a project config with effort.agent_overrides overriding gsd-planner to 'low'
    const config = {
      effort: {
        agent_overrides: {
          'gsd-planner': 'low',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Claude .md gets effort: low when agent_overrides.gsd-planner=low', () => {
    // projectDir is the cwd for install — chdir handled inside runGlobalInstall.
    // claudeHome is inside projectDir, so walking up from claudeHome finds .planning/config.json.
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-planner should have effort: low from config override\nActual:\n${fm}`);
  });

  test('Codex .toml gets model_reasoning_effort = "low" when agent_overrides.gsd-planner=low', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"low"$/m,
      `gsd-planner.toml should have model_reasoning_effort = "low" from config override\nActual:\n${tomlContent.slice(0, 500)}`);
  });

  test('Codex .toml clamps effort max → xhigh when agent_overrides.gsd-planner=max', () => {
    const projectDir = path.dirname(codexHome);
    // Overwrite config with max override
    const config = {
      effort: {
        agent_overrides: {
          'gsd-planner': 'max',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );

    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    // Codex does not support 'max' → clamped to 'xhigh'
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"xhigh"$/m,
      `gsd-planner.toml should clamp max → xhigh for Codex\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.doesNotMatch(tomlContent, /model_reasoning_effort\s*=\s*"max"/,
      'Codex .toml must never contain model_reasoning_effort = "max"');
  });
});

// ─── describe 5b: Invalid effort tokens fall through (Codex adversarial finding #2) ─
//
// These tests FAIL before the fix: resolveInstallTimeEffort returns the raw
// invalid string without validating it against VALID_EFFORTS.

describe('#443 resolveInstallTimeEffort: invalid tokens fall through to valid effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root
    //           .planning/config.json
    //           .claude/          <-- claudeHome
    //           .codex/           <-- codexHome
    tmpDir = makeTmpDir('gsd-443-invalid-effort-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeProjectConfig(config) {
    const projectDir = path.dirname(claudeHome);
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  test('effort.default="ultra" (invalid) -> Claude .md effort: is a VALID value (falls through to high)', () => {
    // BUG before fix: resolveInstallTimeEffort returns "ultra" verbatim
    writeProjectConfig({ effort: { default: 'ultra' } });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
  });

  test('effort.agent_overrides.gsd-planner="bogus" (invalid) with valid default -> falls through to valid default', () => {
    // BUG before fix: "bogus" is returned and written verbatim
    writeProjectConfig({
      effort: {
        agent_overrides: { 'gsd-planner': 'bogus' },
        default: 'medium',
      },
    });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
    // Falls through invalid "bogus" -> valid tier default or "medium" default
    // "medium" is valid, so it should appear (or tier default if medium is invalid, but medium is valid)
  });

  test('effort.default="ultra" (invalid) -> Codex .toml model_reasoning_effort is VALID', () => {
    // BUG before fix: "ultra" written into .toml verbatim
    writeProjectConfig({ effort: { default: 'ultra' } });
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    const match = tomlContent.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    assert.ok(match, `model_reasoning_effort must be present in .toml\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `model_reasoning_effort must be VALID, got: "${match[1]}"\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 5: Source stays clean ──────────────────────────────────────────

describe('#443 Source purity: agents/gsd-planner.md has no effort: key', () => {
  test('source agents/gsd-planner.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-planner.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-planner.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-executor.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-executor.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-executor.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-codebase-mapper.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-codebase-mapper.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-codebase-mapper.md must NOT contain effort: (injection is install-only)`);
  });
});
