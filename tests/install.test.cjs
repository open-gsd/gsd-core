// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Installer Module — Sections 1–5.
 *
 * Covers: getDirName/getGlobalConfigDir/getConfigDirFromHome, per-runtime
 * install/uninstall spot-checks (hermes/qwen/trae), uninstall skills
 * cleanup, Claude-reference leak tests, and Kilo-specific helpers.
 *
 * Consolidates (original sources from #3758):
 *   hermes-install.test.cjs
 *   kilo-install.test.cjs
 *   qwen-install.test.cjs
 *   trae-install.test.cjs
 *   antigravity-install.test.cjs
 *
 * Closes #3758
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTempDir, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');
const pkg = require('../package.json');

const {
  getDirName,
  getConfigDirFromHome,
  install,
  uninstall,
  writeManifest,
  allRuntimes,
  runtimeMap,
  buildRuntimePromptText,
  resolveKiloConfigPath,
  configureKiloPermissions,
  selectRuntimesFromArgs,
} = require('../bin/install.js');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

const {
  RUNTIME_META,
  stripAnsi,
  walk,
} = require('./helpers/install-shared.cjs');

const { CHILD_ROUTER, nestedSkillPath } = require('./helpers/nested-layout.cjs');

// ─── Section 1: getDirName / getGlobalConfigDir / getConfigDirFromHome ──────────

describe('getDirName — all runtimes', () => {
  for (const runtime of allRuntimes) {
    test(`getDirName('${runtime}') returns expected local directory name`, () => {
      const expected = RUNTIME_META[runtime].localDir;
      assert.strictEqual(getDirName(runtime), expected,
        `getDirName('${runtime}') should return '${expected}'`);
    });
  }
});

describe('getGlobalConfigDir — all runtimes default paths', () => {
  // Derive env-var list from the registry so it stays auto-correct when new
  // runtimes are added. GROK_AGENTS_HOME is kept explicitly because grok has
  // no registry entry.
  const { runtimes: _registryRuntimes } = require('../gsd-core/bin/lib/capability-registry.cjs');
  const _registryEnvKeys = Object.values(_registryRuntimes).flatMap((r) => {
    const ch = r.runtime?.configHome;
    if (!ch) return [];
    const envs = Array.isArray(ch.env) ? ch.env : [];
    const skillsEnvs = ch.skillsHome && Array.isArray(ch.skillsHome.env) ? ch.skillsHome.env : [];
    return [...envs, ...skillsEnvs];
  });
  const ENV_KEYS = [...new Set([..._registryEnvKeys, 'GROK_AGENTS_HOME', 'XDG_CONFIG_HOME'])];
  let savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  for (const runtime of allRuntimes.filter(runtime => runtime !== 'kimi')) {
    test(`getGlobalConfigDir('${runtime}') returns expected home-relative path`, () => {
      const expected = path.join(os.homedir(), RUNTIME_META[runtime].globalSuffix);
      assert.strictEqual(getGlobalConfigDir(runtime), expected);
    });
  }
});

describe('getGlobalConfigDir/getConfigDirFromHome — antigravity 2.x layout detection', () => {
  const saved = {};
  beforeEach(() => {
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    saved.ANTIGRAVITY_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
  });
  afterEach(() => {
    if (saved.HOME !== undefined) process.env.HOME = saved.HOME;
    else delete process.env.HOME;
    if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE;
    else delete process.env.USERPROFILE;
    if (saved.ANTIGRAVITY_CONFIG_DIR !== undefined) process.env.ANTIGRAVITY_CONFIG_DIR = saved.ANTIGRAVITY_CONFIG_DIR;
    else delete process.env.ANTIGRAVITY_CONFIG_DIR;
  });

  test('uses ~/.gemini/antigravity-ide when legacy dir is absent and ide dir exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-ide-'));
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-ide'), { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.strictEqual(
        getGlobalConfigDir('antigravity'),
        path.join(home, '.gemini', 'antigravity-ide'),
      );
      assert.strictEqual(
        getConfigDirFromHome('antigravity', true),
        "'.gemini', 'antigravity-ide'",
      );
    } finally {
      cleanup(home);
    }
  });

  test('uses ~/.gemini/antigravity-cli when only cli dir exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-cli-'));
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.strictEqual(
        getGlobalConfigDir('antigravity'),
        path.join(home, '.gemini', 'antigravity-cli'),
      );
      assert.strictEqual(
        getConfigDirFromHome('antigravity', true),
        "'.gemini', 'antigravity-cli'",
      );
    } finally {
      cleanup(home);
    }
  });
});

describe('getGlobalConfigDir — explicit configDir overrides env for all runtimes', () => {
  test('explicit dir overrides any env var for hermes', () => {
    const savedHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = '~/from-env';
    try {
      assert.strictEqual(getGlobalConfigDir('hermes', '/explicit/hermes'), '/explicit/hermes');
    } finally {
      if (savedHome !== undefined) process.env.HERMES_HOME = savedHome;
      else delete process.env.HERMES_HOME;
    }
  });

  test('explicit dir overrides KILO_CONFIG_DIR', () => {
    const saved = process.env.KILO_CONFIG_DIR;
    process.env.KILO_CONFIG_DIR = '~/from-env';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo', '/explicit/kilo'), '/explicit/kilo');
    } finally {
      if (saved !== undefined) process.env.KILO_CONFIG_DIR = saved;
      else delete process.env.KILO_CONFIG_DIR;
    }
  });
});

describe('getGlobalConfigDir — HERMES_HOME env var', () => {
  let saved;
  beforeEach(() => { saved = process.env.HERMES_HOME; });
  afterEach(() => {
    if (saved !== undefined) process.env.HERMES_HOME = saved;
    else delete process.env.HERMES_HOME;
  });

  test('respects HERMES_HOME env var (tilde-expanded)', () => {
    process.env.HERMES_HOME = '~/custom-hermes';
    assert.strictEqual(getGlobalConfigDir('hermes'), path.join(os.homedir(), 'custom-hermes'));
  });
});

describe('getGlobalConfigDir — Kilo env var priority', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = {
      KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
      KILO_CONFIG: process.env.KILO_CONFIG,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.KILO_CONFIG_DIR;
    delete process.env.KILO_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  test('respects KILO_CONFIG_DIR', () => {
    process.env.KILO_CONFIG_DIR = '~/custom-kilo';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'custom-kilo'));
  });

  test('falls back to XDG_CONFIG_HOME/kilo', () => {
    process.env.XDG_CONFIG_HOME = '~/xdg-config';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'xdg-config', 'kilo'));
  });

  test('uses dirname(KILO_CONFIG) when KILO_CONFIG_DIR unset', () => {
    process.env.KILO_CONFIG = '~/profiles/work/kilo.jsonc';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'profiles', 'work'));
  });

  test('KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    process.env.KILO_CONFIG_DIR = '~/custom-kilo';
    process.env.KILO_CONFIG = '~/profiles/work/kilo.jsonc';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'custom-kilo'));
  });
});

describe('getConfigDirFromHome — spot-checks', () => {
  test('claude returns .claude for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('claude', false), "'.claude'");
    assert.strictEqual(getConfigDirFromHome('claude', true), "'.claude'");
  });

  test('hermes returns .hermes for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('hermes', false), "'.hermes'");
    assert.strictEqual(getConfigDirFromHome('hermes', true), "'.hermes'");
  });

  test('qwen returns .qwen for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('qwen', false), "'.qwen'");
    assert.strictEqual(getConfigDirFromHome('qwen', true), "'.qwen'");
  });

  test('trae returns .trae for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('trae', false), "'.trae'");
    assert.strictEqual(getConfigDirFromHome('trae', true), "'.trae'");
  });

  test('antigravity returns .agents (local) and legacy fallback global path when no 2.x dirs exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-empty-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedAntigravityConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      assert.strictEqual(getConfigDirFromHome('antigravity', false), "'.agents'");
      assert.strictEqual(getConfigDirFromHome('antigravity', true), "'.gemini', 'antigravity'");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedAntigravityConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityConfig;
      cleanup(home);
    }
  });

  test('kilo returns .kilo (local) and .config, kilo (global)', () => {
    assert.strictEqual(getConfigDirFromHome('kilo', false), "'.kilo'");
    assert.strictEqual(getConfigDirFromHome('kilo', true), "'.config', 'kilo'");
  });
});

// ─── Section 2: Local install / uninstall for subset of runtimes ─────────────
// Full E2E for runtimes that have distinct install paths (hermes nested layout,
// qwen flat layout, trae flat layout). Others are covered by layout-loop tests.

describe('install/uninstall — hermes (nested skills/gsd/<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-hermes-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.hermes and removes it cleanly', () => {
    const result = install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');

    assert.strictEqual(result.runtime, 'hermes');
    assert.strictEqual(result.configDir, fs.realpathSync(targetDir));

    // hermes nests: skills/gsd/gsd-<router>/skills/<stem>/SKILL.md (#947 — canonical gsd- prefix)
    const hermesHelpPath = nestedSkillPath(path.join(targetDir, 'skills', 'gsd'), 'gsd-', 'help');
    assert.ok(fs.existsSync(hermesHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, hermesHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gsd', 'DESCRIPTION.md')),
      'DESCRIPTION.md at category root');
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'hermes');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      ),
      JSON.stringify(manifest.files)
    );

    uninstall(false, 'hermes');

    assert.ok(!fs.existsSync(hermesHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gsd')));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });

  test('installed SKILL.md frontmatter conforms to Hermes spec', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const categoryDir = path.join(targetDir, 'skills', 'gsd');
    const skillDirs = fs.readdirSync(categoryDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'DESCRIPTION.md')
      .map(e => e.name);

    assert.ok(skillDirs.length > 0, 'at least one skill installed');

    for (const dir of skillDirs) {
      const content = fs.readFileSync(path.join(categoryDir, dir, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(content);
      assert.strictEqual(fm.name, dir, `${dir}/SKILL.md name matches dir`);
      assert.ok(typeof fm.description === 'string' && fm.description.length > 0,
        `${dir}/SKILL.md has description`);
      assert.strictEqual(fm.version, pkg.version,
        `${dir}/SKILL.md declares version ${pkg.version}`);
    }

    const desc = fs.readFileSync(path.join(categoryDir, 'DESCRIPTION.md'), 'utf8');
    const descFm = parseFrontmatter(desc);
    assert.strictEqual(descFm.name, 'gsd');
    assert.ok(typeof descFm.description === 'string' && descFm.description.length > 0);
    assert.strictEqual(descFm.version, pkg.version);

    uninstall(false, 'hermes');
  });

  test('replaces CLAUDE.md references with HERMES.md', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const skillsDir = path.join(targetDir, 'skills');

    let referencedHermesMd = false;
    const checkWalk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { checkWalk(full); continue; }
        if (!entry.name.endsWith('.md')) continue;
        const content = fs.readFileSync(full, 'utf8');
        assert.ok(!/\bCLAUDE\.md\b/.test(content),
          `${path.relative(targetDir, full)} still references CLAUDE.md`);
        if (/\bHERMES\.md\b/.test(content)) referencedHermesMd = true;
      }
    };
    checkWalk(skillsDir);
    assert.ok(referencedHermesMd, 'at least one skill references HERMES.md');
    uninstall(false, 'hermes');
  });
});

describe('install/uninstall — qwen (nested skills/gsd-<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-qwen-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.qwen and removes it cleanly', () => {
    const result = install(false, 'qwen');
    const targetDir = path.join(tmpDir, '.qwen');

    assert.strictEqual(result.runtime, 'qwen');
    assert.strictEqual(result.configDir, fs.realpathSync(targetDir));

    // qwen nests: skills/gsd-<router>/skills/<stem>/SKILL.md
    const qwenHelpPath = nestedSkillPath(path.join(targetDir, 'skills'), 'gsd-', 'help');
    assert.ok(fs.existsSync(qwenHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, qwenHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'qwen');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      )
    );

    uninstall(false, 'qwen');
    assert.ok(!fs.existsSync(qwenHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

describe('install/uninstall — trae (nested skills/gsd-<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-trae-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.trae and removes it cleanly (typed IR result)', () => {
    const result = install(false, 'trae');
    const targetDir = path.join(tmpDir, '.trae');

    assert.deepStrictEqual(result, {
      settingsPath: null,
      settings: null,
      statuslineCommand: null,
      updateBannerCommand: null,
      runtime: 'trae',
      configDir: fs.realpathSync(targetDir),
    });

    // trae nests: skills/gsd-<router>/skills/<stem>/SKILL.md
    const traeHelpPath = nestedSkillPath(path.join(targetDir, 'skills'), 'gsd-', 'help');
    assert.ok(fs.existsSync(traeHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, traeHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'trae');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      )
    );

    uninstall(false, 'trae');
    assert.ok(!fs.existsSync(traeHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

// ─── Section 3: Uninstall skills cleanup — parameterised ─────────────────────

describe('uninstall skills cleanup — hermes', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-hermes-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes skills/gsd/ category dir', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const categoryDir = path.join(targetDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryDir));
    const skills = fs.readdirSync(categoryDir, { withFileTypes: true }).filter(e => e.isDirectory());
    assert.ok(skills.length > 0);

    uninstall(false, 'hermes');
    assert.ok(!fs.existsSync(categoryDir));
  });

  test('preserves non-GSD skill directories', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const custom = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '# custom\n');

    uninstall(false, 'hermes');
    assert.ok(fs.existsSync(path.join(custom, 'SKILL.md')));
  });

  test('removes engine directory', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    uninstall(false, 'hermes');
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

// ─── Section 4: No Claude references leak into non-Claude runtimes ────────────

for (const runtime of ['hermes', 'qwen']) {
  describe(`no Claude references leak into ${runtime} install`, () => {
    let tmpDir;
    let previousCwd;

    beforeEach(() => {
      tmpDir = createTempDir(`gsd-${runtime}-refs-`);
      previousCwd = process.cwd();
      process.chdir(tmpDir);
      install(false, runtime);
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('skills contain no CLAUDE.md or Claude Code references', () => {
      const rtDir = path.join(tmpDir, getDirName(runtime));
      const skillsDir = path.join(rtDir, 'skills');
      assert.ok(fs.existsSync(skillsDir));

      const skillFiles = walk(skillsDir).filter(f => f.endsWith('.md'));
      assert.ok(skillFiles.length > 0);

      const leaks = skillFiles.filter(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });

    test('agents contain no CLAUDE.md or Claude Code references', () => {
      const agentsDir = path.join(tmpDir, getDirName(runtime), 'agents');
      assert.ok(fs.existsSync(agentsDir));

      const agentFiles = walk(agentsDir).filter(f => f.endsWith('.md'));
      assert.ok(agentFiles.length > 0);

      const leaks = agentFiles.filter(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });

    test('full tree scan finds zero Claude references outside CHANGELOG.md', () => {
      const rtDir = path.join(tmpDir, getDirName(runtime));
      const allFiles = walk(rtDir).filter(f =>
        (f.endsWith('.md') || f.endsWith('.cjs') || f.endsWith('.js')) &&
        path.basename(f) !== 'CHANGELOG.md'
      );
      const leaks = allFiles.filter(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c) || /\.claude\//.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });
  });
}

// ─── Section 5: Kilo-specific helpers ────────────────────────────────────────

describe('resolveKiloConfigPath', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('gsd-kilo-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('prefers kilo.jsonc when present', () => {
    const configDir = path.join(tmpDir, '.kilo');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'kilo.jsonc'), '{\n}\n');
    assert.strictEqual(resolveKiloConfigPath(configDir), path.join(configDir, 'kilo.jsonc'));
  });

  test('falls back to kilo.json', () => {
    const configDir = path.join(tmpDir, '.kilo');
    fs.mkdirSync(configDir, { recursive: true });
    assert.strictEqual(resolveKiloConfigPath(configDir), path.join(configDir, 'kilo.json'));
  });
});

describe('configureKiloPermissions', () => {
  let tmpDir;
  let configDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-kilo-perms-');
    configDir = path.join(tmpDir, '.config', 'kilo');
    savedEnv = {
      KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.KILO_CONFIG_DIR = configDir;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    cleanup(tmpDir);
  });

  test('writes GSD permissions to kilo.json when config is missing', () => {
    configureKiloPermissions(true);
    const configPath = path.join(configDir, 'kilo.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });

  test('updates existing kilo.jsonc configs via JSONC parsing', () => {
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'kilo.jsonc');
    fs.writeFileSync(configPath, '{\n  // existing\n  "permission": {\n    "bash": "ask",\n  },\n}\n');
    configureKiloPermissions(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.bash, 'ask');
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });

  test('writes permissions to an explicit config dir argument', () => {
    const explicitDir = path.join(tmpDir, 'custom-kilo-config');
    configureKiloPermissions(true, explicitDir);
    const configPath = path.join(explicitDir, 'kilo.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${explicitDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });
});

describe('Kilo integration — install/uninstall behaviour', () => {
  // Product-text reads for test 6 only — update.md and update-context.cjs
  // are deployed artifacts whose text IS the runtime contract (allow-test-rule).
  const updateWorkflowSrc = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md'), 'utf8');
  // #498: update.md's runtime/scope/config-dir resolution moved into the tested
  // projection gsd-core/bin/lib/update-context.cjs. Custom-config-dir
  // detection (kilo.jsonc, KILO_CONFIG) is now asserted there.
  const updateContextSrc = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'update-context.cjs'), 'utf8');

  let tmpDir;
  let previousCwd;
  let savedKiloConfigDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-kilo-integration-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    savedKiloConfigDir = process.env.KILO_CONFIG_DIR;
    // Point KILO_CONFIG_DIR at the install target so configureKiloPermissions
    // and uninstall resolve to the same dir without needing the real ~/.config/kilo.
    process.env.KILO_CONFIG_DIR = path.join(tmpDir, '.kilo');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (savedKiloConfigDir !== undefined) process.env.KILO_CONFIG_DIR = savedKiloConfigDir;
    else delete process.env.KILO_CONFIG_DIR;
    cleanup(tmpDir);
  });

  test('--kilo flag routes to kilo runtime via selectRuntimesFromArgs', () => {
    // Behavioural replacement for source-grep on runtimeArgs.includes('--kilo').
    // The flag must produce ['kilo'] — a rename or deletion of the flag branch
    // would make this go red.
    assert.deepStrictEqual(selectRuntimesFromArgs(['--kilo']), ['kilo']);
  });

  test('runtimeMap has Kilo as option 12 after Kimi', () => {
    assert.strictEqual(runtimeMap['12'], 'kilo');
  });

  test('prompt text shows Kilo above OpenCode without marketing copy', () => {
    const plain = stripAnsi(buildRuntimePromptText());
    assert.ok(/\b12\)\s*Kilo\b/.test(plain));
    assert.ok(plain.indexOf('12) Kilo') < plain.indexOf('OpenCode'));
    assert.ok(!plain.includes('the #1 AI coding platform on OpenRouter'));
  });

  test('install returns configDir and configureKiloPermissions writes to it', () => {
    // Behavioural replacement for source-grep on
    // "configureKiloPermissions(isGlobal, configDir)".
    // The real contract is that the configDir returned by install() is the same
    // dir that configureKiloPermissions targets — if the wiring breaks, either
    // the JSON won't exist or the permission key will use a different path.
    const result = install(false, 'kilo');
    const expectedConfigDir = result.configDir;

    configureKiloPermissions(true, expectedConfigDir);

    const kiloJsonPath = resolveKiloConfigPath(expectedConfigDir);
    assert.ok(
      fs.existsSync(kiloJsonPath),
      `kilo.json must be written to the configDir returned by install(): ${expectedConfigDir}`,
    );
    const config = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
    const gsdGlob = `${expectedConfigDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(
      config.permission.read[gsdGlob],
      'allow',
      'GSD read permission must be keyed to the install configDir',
    );
  });

  test('uninstall removes GSD permissions from the resolved kilo config path', () => {
    // Behavioural replacement for source-grep on
    // "const configPath = resolveKiloConfigPath(targetDir)".
    // The contract: after install + configureKiloPermissions, an uninstall must
    // strip the GSD permission entries from kilo.json at the resolved path.
    const result = install(false, 'kilo');
    const configDir = result.configDir;
    configureKiloPermissions(true, configDir);

    const kiloJsonPath = resolveKiloConfigPath(configDir);
    const beforeConfig = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
    const gsdGlob = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.ok(
      beforeConfig.permission.read[gsdGlob] === 'allow',
      'pre-condition: GSD read permission must exist before uninstall',
    );

    uninstall(false, 'kilo');

    // After uninstall the GSD permission keys must be absent. The file may
    // still exist (Kilo preserves user settings) but the gsd-core/* entries
    // must be gone.
    const afterConfig = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
    assert.ok(
      !(afterConfig.permission && afterConfig.permission.read && afterConfig.permission.read[gsdGlob]),
      `GSD read permission must be removed from ${kiloJsonPath} after uninstall`,
    );
    assert.ok(
      !(afterConfig.permission && afterConfig.permission.external_directory &&
        afterConfig.permission.external_directory[gsdGlob]),
      `GSD external_directory permission must be removed from ${kiloJsonPath} after uninstall`,
    );
  });

  test('update workflow checks preferred custom config dirs', () => {
    // update.md still derives the preferred config dir from execution_context…
    assert.ok(updateWorkflowSrc.includes('PREFERRED_CONFIG_DIR'));
    // …and the custom-dir detection (kilo.jsonc config marker, KILO_CONFIG env)
    // now lives in the tested update-context projection (#498).
    assert.ok(updateContextSrc.includes('kilo.jsonc'));
    assert.ok(updateContextSrc.includes('KILO_CONFIG'));
  });
});

// ─── Section N: changeset CLI install regression (#935) ──────────────────────

describe('install — changeset CLI lands at scripts/changeset/cli.cjs (#935)', () => {
  // Regression guard: the changeset CLI must be copied into the runtime config dir
  // by the installer so $GSD_DIR/scripts/changeset/cli.cjs resolves at runtime.
  // Before this fix, scripts/ was never copied and /gsd-update changelog preview
  // silently failed on every real install.
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-changeset-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install() copies scripts/changeset/cli.cjs to <configDir>/scripts/changeset/cli.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    assert.ok(
      fs.existsSync(cliPath),
      `scripts/changeset/cli.cjs must exist at ${path.relative(tmpDir, cliPath)} after install (#935)`,
    );
  });

  test('install() copies scripts/lib/cli-exit.cjs to <configDir>/scripts/lib/cli-exit.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliExitPath = path.join(claudeDir, 'scripts', 'lib', 'cli-exit.cjs');
    assert.ok(
      fs.existsSync(cliExitPath),
      `scripts/lib/cli-exit.cjs must exist at ${path.relative(tmpDir, cliExitPath)} after install (#935)`,
    );
  });

  test('installed cli.cjs executes without module-resolution errors', () => {
    // Smoke test: node can load the installed changeset CLI without crashing.
    // This catches path mismatches in require('../lib/cli-exit.cjs') etc.
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    // --help exits with code 1 (usage shown), but must NOT throw a MODULE_NOT_FOUND error
    assert.ok(
      !result.stderr.includes('MODULE_NOT_FOUND'),
      `cli.cjs must not produce MODULE_NOT_FOUND errors; stderr=${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes('Cannot find module'),
      `cli.cjs must resolve all modules; stderr=${result.stderr}`,
    );
  });

  test('installed cli.cjs can run extract subcommand end-to-end (#935)', () => {
    // Integration smoke test: the installed CLI's extract path (invoked by update.md)
    // must actually work — this catches require() path issues that --help wouldn't surface.
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    // Use the CHANGELOG.md that was installed into gsd-core/ (installed by the installer)
    const changelogPath = path.join(claudeDir, 'gsd-core', 'CHANGELOG.md');
    assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md must be installed under gsd-core/');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      process.execPath,
      [cliPath, 'extract', '--from', '0.0.0', '--to', '9999.0.0', '--changelog', changelogPath, '--json'],
      { encoding: 'utf8' },
    );
    // extract must NOT throw a MODULE_NOT_FOUND or Cannot find module error
    assert.ok(
      !result.stderr.includes('MODULE_NOT_FOUND') && !result.stderr.includes('Cannot find module'),
      `installed cli.cjs extract must resolve all modules; stderr=${result.stderr}`,
    );
    // extract exit code 0 (found entries) or 2 (no entries in range) are both valid;
    // any other exit code is an error
    assert.ok(
      result.status === 0 || result.status === 2,
      `installed cli.cjs extract must exit 0 or 2; got ${result.status}; stderr=${result.stderr}`,
    );
  });

  test('writeManifest() tracks scripts/changeset/ and scripts/lib/ files', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const manifest = writeManifest(claudeDir, 'claude');
    const changesetKeys = Object.keys(manifest.files).filter(k => k.startsWith('scripts/changeset/'));
    const libKeys = Object.keys(manifest.files).filter(k => k.startsWith('scripts/lib/'));
    assert.ok(changesetKeys.length > 0, 'manifest must track scripts/changeset/ files');
    assert.ok(libKeys.length > 0, 'manifest must track scripts/lib/ files');
    assert.ok(
      changesetKeys.includes('scripts/changeset/cli.cjs'),
      'manifest must include scripts/changeset/cli.cjs',
    );
    assert.ok(
      libKeys.includes('scripts/lib/cli-exit.cjs'),
      'manifest must include scripts/lib/cli-exit.cjs',
    );
  });

  test('uninstall() removes scripts/changeset/ and scripts/lib/', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    assert.ok(fs.existsSync(path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs')),
      'pre-condition: cli.cjs must be installed before uninstall');
    uninstall(false, 'claude');
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'scripts', 'changeset')),
      'scripts/changeset/ must be removed on uninstall',
    );
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'scripts', 'lib')),
      'scripts/lib/ must be removed on uninstall',
    );
  });
});

// ─── Section N: Antigravity .agents canonical workspace dir (#791) ─────────────
// allow-test-rule: runtime-contract-is-the-product
// Reads deployed agent .md files whose text IS the product surface the
// Antigravity runtime loads at startup (path references, command names).

describe('antigravity local install writes to .agents/ canonical dir (#791)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-antigravity-791-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install writes workspace skills under .agents/skills/', () => {
    const result = install(false, 'antigravity');
    const agentsDir = path.join(tmpDir, '.agents');
    assert.strictEqual(result.runtime, 'antigravity');
    assert.ok(fs.existsSync(agentsDir), '.agents/ must be created for local antigravity install');
    const skillsDir = path.join(agentsDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), '.agents/skills/ must exist after install');
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillEntries.length > 0, 'at least one gsd-* skill must be installed under .agents/skills/');
    const firstSkill = path.join(skillsDir, skillEntries[0].name, 'SKILL.md');
    assert.ok(fs.existsSync(firstSkill), `SKILL.md must exist at ${firstSkill}`);
  });

  test('installed agent files reference .agents/ not ~/.claude/ or bare .agent/', () => {
    // NOTE: skill content is intentionally NOT asserted here. The installer calls
    // convertClaudeCommandToAntigravitySkill(content, skillName, runtime, cmdNames)
    // where the 3rd arg is the string "antigravity" (truthy), routing local skills
    // through the global content branch — a pre-existing quirk tracked separately.
    // Agent files are NOT affected: convertClaudeAgentToAntigravityAgent(content, isGlobal)
    // receives the boolean isGlobal correctly, so local agents use the local (.agents/) branch.
    install(false, 'antigravity');
    const agentsDest = path.join(tmpDir, '.agents', 'agents');
    assert.ok(fs.existsSync(agentsDest), '.agents/agents/ must exist after local install');
    const agentFiles = fs.readdirSync(agentsDest)
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'pre-condition: at least one gsd-* agent must be installed');
    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDest, file), 'utf8');
      // Local agent content must not contain global home-dir paths (should be .agents/)
      assert.ok(
        !content.includes('~/.claude/') && !content.includes('$HOME/.claude/'),
        `${file} must not contain ~/.claude/ or $HOME/.claude/ in a local install; content uses .agents/`,
      );
      // Local agent content must not reference the legacy singular .agent/ path
      const bareAgentRefs = content.match(/(?<!\w)\.agent(?!s)\//g) || [];
      assert.strictEqual(
        bareAgentRefs.length, 0,
        `${file} must not reference legacy .agent/ path; found: ${bareAgentRefs.join(', ')}`,
      );
    }
  });

  test('legacy .agent/ is NOT written on a fresh local install', () => {
    install(false, 'antigravity');
    const legacyDir = path.join(tmpDir, '.agent');
    assert.ok(!fs.existsSync(legacyDir),
      '.agent/ must not be created by a fresh install (new installs use .agents/)');
  });

  test('global antigravity install still writes to ~/.gemini/antigravity (unchanged)', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ag-global-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedAntigravityConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'antigravity');
      assert.strictEqual(result.runtime, 'antigravity');
      assert.ok(
        result.configDir.startsWith(homeDir),
        `global antigravity install must go under HOME, got: ${result.configDir}`,
      );
      assert.ok(
        fs.existsSync(path.join(result.configDir, 'skills')),
        'global antigravity install must create skills/ under ~/.gemini/antigravity',
      );
      assert.ok(
        !fs.existsSync(path.join(homeDir, '.agents')),
        '.agents/ must NOT be created by a global install (global path is ~/.gemini/antigravity)',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedAntigravityConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityConfig;
      cleanup(homeDir);
    }
  });
});
// ─── Section 6: Windsurf / devin-desktop alias (#792) ───────────────────────

describe('install — --devin-desktop CLI flag routes to windsurf runtime (#792)', () => {
  test('--devin-desktop resolves to ["windsurf"] via selectRuntimesFromArgs', () => {
    const runtimes = selectRuntimesFromArgs(['--devin-desktop']);
    assert.deepStrictEqual(runtimes, ['windsurf'],
      '--devin-desktop must resolve to ["windsurf"] via selectRuntimesFromArgs');
  });

  test('--windsurf and --devin-desktop both resolve to ["windsurf"]', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--windsurf']), ['windsurf']);
    assert.deepStrictEqual(selectRuntimesFromArgs(['--devin-desktop']), ['windsurf']);
  });
});
// ─── Section N: Windsurf .devin canonical workspace dir (#1085) ─────────────
// allow-test-rule: runtime-contract-is-the-product
// Reads deployed skill .md files whose text IS the product surface the
// Windsurf/Devin Desktop runtime loads at startup (path references, command names).

describe('windsurf local install writes to .devin/ canonical dir (#1085)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-windsurf-1085-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install writes workspace skills under .devin/skills/', () => {
    const result = install(false, 'windsurf');
    const devinDir = path.join(tmpDir, '.devin');
    assert.strictEqual(result.runtime, 'windsurf');
    assert.ok(fs.existsSync(devinDir), '.devin/ must be created for local windsurf install');
    const skillsDir = path.join(devinDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), '.devin/skills/ must exist after install');
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillEntries.length > 0, 'at least one gsd-* skill must be installed under .devin/skills/');
    const firstSkill = path.join(skillsDir, skillEntries[0].name, 'SKILL.md');
    assert.ok(fs.existsSync(firstSkill), `SKILL.md must exist at ${firstSkill}`);
  });

  test('legacy .windsurf/ is NOT written on a fresh local install', () => {
    install(false, 'windsurf');
    const legacyDir = path.join(tmpDir, '.windsurf');
    assert.ok(!fs.existsSync(legacyDir),
      '.windsurf/ must not be created by a fresh install (new installs use .devin/)');
  });

  test('installed skill content references .devin/ not bare .windsurf/ or ~/.claude/', () => {
    install(false, 'windsurf');
    const skillsDir = path.join(tmpDir, '.devin', 'skills');
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillEntries.length > 0, 'pre-condition: at least one gsd-* skill must be installed');
    for (const skillEntry of skillEntries) {
      const skillFile = path.join(skillsDir, skillEntry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf8');
      assert.ok(
        !content.includes('~/.claude/') && !content.includes('$HOME/.claude/'),
        `${skillEntry.name}/SKILL.md must not contain ~/.claude/ or $HOME/.claude/ in a local install`,
      );
      // Local install must use workspace-relative .devin/ form, not the legacy .windsurf/ form
      assert.ok(
        !content.includes('~/.windsurf/') && !content.includes('.windsurf/skills/'),
        `${skillEntry.name}/SKILL.md must not contain bare .windsurf/ path in a local install (use .devin/ instead)`,
      );
    }
  });

  test('global windsurf install still writes to ~/.codeium/windsurf/ (unchanged)', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ws-global-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedWindsurfConfig = process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'windsurf');
      assert.strictEqual(result.runtime, 'windsurf');
      assert.ok(
        result.configDir.includes('codeium') || result.configDir.includes('windsurf'),
        `global windsurf install must go to codeium/windsurf path, got: ${result.configDir}`,
      );
      assert.ok(
        fs.existsSync(path.join(result.configDir, 'skills')),
        'global windsurf install must create skills/ under ~/.codeium/windsurf',
      );
      assert.ok(
        !fs.existsSync(path.join(homeDir, '.devin')),
        '.devin/ must NOT be created by a global install (global path is ~/.codeium/windsurf)',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedWindsurfConfig === undefined) delete process.env.WINDSURF_CONFIG_DIR;
      else process.env.WINDSURF_CONFIG_DIR = savedWindsurfConfig;
      cleanup(homeDir);
    }
  });

  test('global windsurf install skill content references codeium path not .devin/', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ws-global-c-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedWindsurfConfig = process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'windsurf');
      const skillsDir = path.join(result.configDir, 'skills');
      if (!fs.existsSync(skillsDir)) return; // no skills emitted — skip
      const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      // At least one skill body must reference the codeium/windsurf global path (#1085):
      // the isGlobal-threaded rewrite converts .devin/skills/ → $HOME/.codeium/windsurf/skills/
      let foundGlobalRef = false;
      for (const skillEntry of skillEntries) {
        const skillFile = path.join(skillsDir, skillEntry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const content = fs.readFileSync(skillFile, 'utf8');
        // Global skill content must not reference local workspace-relative .devin/ paths
        assert.ok(
          !content.includes('.devin/skills/'),
          `${skillEntry.name}/SKILL.md must not reference .devin/skills/ in global install (should use codeium path)`,
        );
        assert.ok(
          !content.includes('~/.claude/') && !content.includes('$HOME/.claude/'),
          `${skillEntry.name}/SKILL.md must not contain ~/.claude/ or $HOME/.claude/ in global install`,
        );
        if (content.includes('codeium/windsurf/skills/') || content.includes('$HOME/.codeium/windsurf/skills/')) {
          foundGlobalRef = true;
        }
      }
      // Verify the global-path rewrite actually fired on at least one skill (FIX 1 guard)
      if (skillEntries.some(e => fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))) {
        assert.ok(
          foundGlobalRef,
          'at least one global windsurf SKILL.md must reference the codeium/windsurf/skills/ path (isGlobal rewrite must have fired)',
        );
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedWindsurfConfig === undefined) delete process.env.WINDSURF_CONFIG_DIR;
      else process.env.WINDSURF_CONFIG_DIR = savedWindsurfConfig;
      cleanup(homeDir);
    }
  });
});
// ─── Section N+1: #767 — disallowedTools injection for read-only agents ──────
//
// Verifies (installer-behavioral test — drives install() to a temp dir):
//   1. Claude install: Group A agents have disallowedTools == {Write, Edit, MultiEdit} exactly.
//   2. Claude install: Group B agents have disallowedTools == {Edit, MultiEdit} exactly.
//   3. Negative: gsd-nyquist-auditor has NO disallowedTools key (legitimately writes+edits).
//   4. Cross-runtime no-leak: Gemini-installed read-only agents do NOT contain disallowedTools.
//   5. Source purity: source agents/*.md must not contain disallowedTools (inject-only).
//   6. Parity: docs/AGENTS.md "Disallowed Tools" rows match READONLY_AGENT_DISALLOWED_TOOLS.
//      (DEFECT.GENERATIVE-FIX guard)

// #767 — must mirror READONLY_AGENT_DISALLOWED_TOOLS in bin/install.js.
// If you change the map there, update this too (the parity test will catch drift).
const READONLY_AGENT_DISALLOWED_TOOLS_767 = {
  'gsd-plan-checker': 'Write, Edit, MultiEdit',
  'gsd-integration-checker': 'Write, Edit, MultiEdit',
  'gsd-ui-checker': 'Write, Edit, MultiEdit',
  'gsd-verifier': 'Edit, MultiEdit',
  'gsd-doc-verifier': 'Edit, MultiEdit',
  'gsd-eval-auditor': 'Edit, MultiEdit',
  'gsd-ui-auditor': 'Edit, MultiEdit',
};

const GROUP_A_767 = ['gsd-plan-checker', 'gsd-integration-checker', 'gsd-ui-checker'];
const GROUP_B_767 = ['gsd-verifier', 'gsd-doc-verifier', 'gsd-eval-auditor', 'gsd-ui-auditor'];

const REPO_ROOT_767 = path.resolve(__dirname, '..');
const SOURCE_AGENTS_DIR_767 = path.join(REPO_ROOT_767, 'agents');
const AGENTS_DOC_PATH_767 = path.join(REPO_ROOT_767, 'docs', 'AGENTS.md');

function readFrontmatterText(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

function parseDisallowedToolsSet(fm) {
  const match = fm.match(/^disallowedTools:\s*(.+)$/m);
  if (!match) return null;
  return new Set(match[1].split(',').map((t) => t.trim()).filter(Boolean));
}

/**
 * Run a global install for the given runtime, redirecting its home dir to
 * tmpHome. Stubs both HOME and USERPROFILE for Windows parity, and
 * suppresses the stale-SDK npm subprocess.
 */
function runGlobalInstall767(runtime, tmpHome) {
  const envVarMap = {
    claude: 'CLAUDE_CONFIG_DIR',
    gemini: 'GEMINI_CONFIG_DIR',
    qwen: 'QWEN_CONFIG_DIR',
  };
  const envVar = envVarMap[runtime];
  if (!envVar) throw new Error(`Unsupported runtime in #767 test: ${runtime}`);

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-767-home-'));

  const prevEnvVar = process.env[envVar];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env[envVar] = tmpHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT_767);

  try {
    install(true, runtime);
  } finally {
    process.chdir(prevCwd);
    if (prevEnvVar === undefined) delete process.env[envVar];
    else process.env[envVar] = prevEnvVar;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }

  return tmpHome;
}

describe('#767 Claude install: Group A agents have disallowedTools = {Write, Edit, MultiEdit}', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-a-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const EXPECTED_A_767 = new Set(['Write', 'Edit', 'MultiEdit']);

  for (const agent of GROUP_A_767) {
    test(`${agent}: disallowedTools is exactly {Write, Edit, MultiEdit}`, () => {
      const fm = readFrontmatterText(path.join(claudeHome, 'agents', `${agent}.md`));
      const tools = parseDisallowedToolsSet(fm);
      assert.ok(tools !== null,
        `${agent} must have a disallowedTools key in Claude frontmatter\nFrontmatter:\n${fm}`);
      assert.deepEqual(tools, EXPECTED_A_767,
        `${agent} disallowedTools must be exactly {Write, Edit, MultiEdit}\nGot: ${[...tools].join(', ')}`);
    });
  }
});

describe('#767 Claude install: Group B agents have disallowedTools = {Edit, MultiEdit}', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-b-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const EXPECTED_B_767 = new Set(['Edit', 'MultiEdit']);

  for (const agent of GROUP_B_767) {
    test(`${agent}: disallowedTools is exactly {Edit, MultiEdit}`, () => {
      const fm = readFrontmatterText(path.join(claudeHome, 'agents', `${agent}.md`));
      const tools = parseDisallowedToolsSet(fm);
      assert.ok(tools !== null,
        `${agent} must have a disallowedTools key in Claude frontmatter\nFrontmatter:\n${fm}`);
      assert.deepEqual(tools, EXPECTED_B_767,
        `${agent} disallowedTools must be exactly {Edit, MultiEdit}\nGot: ${[...tools].join(', ')}`);
    });
  }
});

describe('#767 Claude install: gsd-nyquist-auditor has no disallowedTools (legitimately writes+edits)', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-nyquist-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-nyquist-auditor.md has NO disallowedTools key', () => {
    const fm = readFrontmatterText(path.join(claudeHome, 'agents', 'gsd-nyquist-auditor.md'));
    const tools = parseDisallowedToolsSet(fm);
    assert.equal(tools, null,
      `gsd-nyquist-auditor must NOT have disallowedTools in Claude frontmatter\nFrontmatter:\n${fm}`);
  });
});

describe('#767 Gemini install: read-only agents do NOT contain disallowedTools (cross-runtime leak guard)', () => {
  let tmpDir;
  let geminiHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-gemini-');
    geminiHome = path.join(tmpDir, 'gemini-home');
    fs.mkdirSync(geminiHome, { recursive: true });
    runGlobalInstall767('gemini', geminiHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const agent of [...GROUP_A_767, ...GROUP_B_767]) {
    test(`Gemini ${agent}.md has no disallowedTools`, () => {
      const agentPath = path.join(geminiHome, 'agents', `${agent}.md`);
      const content = fs.readFileSync(agentPath, 'utf8');
      assert.ok(!content.includes('disallowedTools'),
        `${agent} (Gemini) must NOT contain disallowedTools\nContent excerpt:\n${content.slice(0, 400)}`);
    });
  }
});

describe('#767 Source purity: source agents/*.md must not contain disallowedTools (inject-only)', () => {
  for (const agent of [...GROUP_A_767, ...GROUP_B_767]) {
    test(`source agents/${agent}.md has no disallowedTools`, () => {
      const content = fs.readFileSync(path.join(SOURCE_AGENTS_DIR_767, `${agent}.md`), 'utf8');
      assert.ok(!content.includes('disallowedTools'),
        `Source agents/${agent}.md must NOT contain disallowedTools (injection is install-time only, source must stay runtime-neutral)`);
    });
  }
});

describe('#767 Parity: docs/AGENTS.md "Disallowed Tools" rows match READONLY_AGENT_DISALLOWED_TOOLS', () => {
  const agentsDoc = fs.readFileSync(AGENTS_DOC_PATH_767, 'utf8');

  for (const [agent, expectedTools] of Object.entries(READONLY_AGENT_DISALLOWED_TOOLS_767)) {
    test(`docs/AGENTS.md has matching Disallowed Tools row for ${agent}`, () => {
      const agentHeaderIdx = agentsDoc.indexOf(`### ${agent}`);
      assert.ok(agentHeaderIdx !== -1,
        `docs/AGENTS.md must contain a ### ${agent} section`);

      const nextSectionIdx = agentsDoc.indexOf('\n### ', agentHeaderIdx + 1);
      const sectionEnd = nextSectionIdx === -1 ? agentsDoc.length : nextSectionIdx;
      const section = agentsDoc.slice(agentHeaderIdx, sectionEnd);

      const disallowedMatch = section.match(/\|\s*\*\*Disallowed Tools\*\*\s*\|\s*([^|]+)\|/);
      assert.ok(disallowedMatch,
        `docs/AGENTS.md section for ${agent} must have a "Disallowed Tools" table row`);

      const docTools = disallowedMatch[1].trim();
      assert.equal(docTools, expectedTools,
        `docs/AGENTS.md "Disallowed Tools" for ${agent} must be "${expectedTools}" but got "${docTools}"`);
    });
  }
});
