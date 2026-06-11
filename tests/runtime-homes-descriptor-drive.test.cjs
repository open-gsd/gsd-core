'use strict';

/**
 * Equivalence proof for ADR-857 phase 5b: descriptor-driven getGlobalConfigDir.
 *
 * For every runtime in the 16-entry capability registry, plus grok and unknown
 * runtime, this test asserts that getGlobalConfigDir() produces exactly the
 * same path that the old hardcoded switch produced (golden expected values
 * captured from the switch BEFORE any edits). All assertions are byte-identical.
 *
 * The injected opts seam on resolveConfigHomeFromDescriptor is used to control:
 *   - the env record (avoid ambient env var pollution)
 *   - the home directory (make tests hermetic)
 *   - existsSync (control probe-hit / probe-miss scenarios)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  resolveAntigravityGlobalDir,
  resolveKimiGlobalDir,
  resolveConfigHomeFromDescriptor,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

const HOME = os.homedir();

// ── Helper: run fn with process.env temporarily mutated ──────────────────────

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// All env vars for all runtimes — cleared in each test that calls getGlobalConfigDir directly
const ALL_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'GEMINI_CONFIG_DIR', 'CODEX_HOME',
  'GROK_AGENTS_HOME', 'COPILOT_CONFIG_DIR', 'COPILOT_HOME', 'ANTIGRAVITY_CONFIG_DIR',
  'WINDSURF_CONFIG_DIR', 'AUGMENT_CONFIG_DIR', 'TRAE_CONFIG_DIR', 'QWEN_CONFIG_DIR',
  'HERMES_HOME', 'CODEBUDDY_CONFIG_DIR', 'CLINE_CONFIG_DIR', 'KIMI_CONFIG_DIR',
  'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'KILO_CONFIG_DIR', 'KILO_CONFIG',
  'XDG_CONFIG_HOME',
];

function clearAllEnvKeys() {
  const saved = {};
  for (const k of ALL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnvKeys(saved) {
  for (const k of ALL_ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
}

// ── STEP 0: golden scenarios captured from old switch BEFORE edits ────────────

// GOLDEN DEFAULTS (no env vars set, no existsSync probe hits).
// kimi is NOT included here because it depends on real filesystem probing —
// its probe-miss/hit scenarios are covered separately via injected existsSync.
// antigravity default also depends on probing; the default assumes NO dirs exist.
const GOLDEN_DEFAULTS = {
  claude:      path.join(HOME, '.claude'),
  cursor:      path.join(HOME, '.cursor'),
  gemini:      path.join(HOME, '.gemini'),
  codex:       path.join(HOME, '.codex'),
  grok:        path.join(HOME, '.agents'),
  copilot:     path.join(HOME, '.copilot'),
  antigravity: path.join(HOME, '.gemini', 'antigravity'),  // probe-miss → first candidate
  windsurf:    path.join(HOME, '.codeium', 'windsurf'),
  augment:     path.join(HOME, '.augment'),
  trae:        path.join(HOME, '.trae'),
  qwen:        path.join(HOME, '.qwen'),
  hermes:      path.join(HOME, '.hermes'),
  codebuddy:   path.join(HOME, '.codebuddy'),
  cline:       path.join(HOME, '.cline'),
  opencode:    path.join(HOME, '.config', 'opencode'),
  kilo:        path.join(HOME, '.config', 'kilo'),
};

// ── GOLDEN DEFAULTS ────────────────────────────────────────────────────────────

describe('descriptor-driven equivalence: defaults (no env vars, no probe hits)', () => {
  // kimi is excluded: its default depends on real filesystem probing (probe-hit/miss
  // vary by machine). kimi probe scenarios are covered in the generic-agents-root suite
  // with injected existsSync.
  // antigravity is excluded: it also depends on real fs probing (probe candidates
  // ~/.gemini/antigravity, ~/.gemini/antigravity-ide, ~/.gemini/antigravity-cli);
  // a machine that has antigravity-ide or antigravity-cli but not antigravity gets a
  // different result. antigravity probe scenarios are covered in the dot-home-nested
  // suite with injected existsSync.
  for (const [runtime, expected] of Object.entries(GOLDEN_DEFAULTS).filter(
    ([r]) => r !== 'antigravity',
  )) {
    test(`${runtime} default → ${expected}`, () => {
      const saved = clearAllEnvKeys();
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), expected);
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }

  test('unknown runtime falls back to ~/.claude (CLAUDE_CONFIG_DIR unset)', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('totally-unknown-runtime-xyz'), path.join(HOME, '.claude'));
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN ENV OVERRIDES ──────────────────────────────────────────────────────

describe('descriptor-driven equivalence: env-var overrides', () => {
  const cases = [
    { runtime: 'claude',    envKey: 'CLAUDE_CONFIG_DIR',    value: '/custom/claude' },
    { runtime: 'cursor',    envKey: 'CURSOR_CONFIG_DIR',    value: '/custom/cursor' },
    { runtime: 'gemini',    envKey: 'GEMINI_CONFIG_DIR',    value: '/custom/gemini' },
    { runtime: 'codex',     envKey: 'CODEX_HOME',           value: '/custom/codex' },
    { runtime: 'grok',      envKey: 'GROK_AGENTS_HOME',     value: '/custom/grok' },
    { runtime: 'augment',   envKey: 'AUGMENT_CONFIG_DIR',   value: '/custom/augment' },
    { runtime: 'trae',      envKey: 'TRAE_CONFIG_DIR',      value: '/custom/trae' },
    { runtime: 'qwen',      envKey: 'QWEN_CONFIG_DIR',      value: '/custom/qwen' },
    { runtime: 'hermes',    envKey: 'HERMES_HOME',          value: '/custom/hermes' },
    { runtime: 'codebuddy', envKey: 'CODEBUDDY_CONFIG_DIR', value: '/custom/codebuddy' },
    { runtime: 'cline',     envKey: 'CLINE_CONFIG_DIR',     value: '/custom/cline' },
    { runtime: 'windsurf',  envKey: 'WINDSURF_CONFIG_DIR',  value: '/custom/windsurf' },
    { runtime: 'antigravity', envKey: 'ANTIGRAVITY_CONFIG_DIR', value: '/custom/antigravity' },
    { runtime: 'kimi',      envKey: 'KIMI_CONFIG_DIR',      value: '/custom/kimi' },
    { runtime: 'opencode',  envKey: 'OPENCODE_CONFIG_DIR',  value: '/custom/opencode' },
    { runtime: 'kilo',      envKey: 'KILO_CONFIG_DIR',      value: '/custom/kilo' },
  ];

  for (const { runtime, envKey, value } of cases) {
    test(`${runtime}: ${envKey} override → ${value}`, () => {
      const saved = clearAllEnvKeys();
      process.env[envKey] = value;
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), value);
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }

  // copilot: COPILOT_CONFIG_DIR takes precedence over COPILOT_HOME
  test('copilot: COPILOT_CONFIG_DIR override (first env wins)', () => {
    const saved = clearAllEnvKeys();
    process.env['COPILOT_CONFIG_DIR'] = '/custom/copilot-dir';
    process.env['COPILOT_HOME'] = '/should/not/win';
    try {
      assert.strictEqual(getGlobalConfigDir('copilot'), '/custom/copilot-dir');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('copilot: COPILOT_HOME fallback when COPILOT_CONFIG_DIR absent', () => {
    const saved = clearAllEnvKeys();
    process.env['COPILOT_HOME'] = '/custom/copilot-home';
    try {
      assert.strictEqual(getGlobalConfigDir('copilot'), '/custom/copilot-home');
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN TILDE EXPANSION ─────────────────────────────────────────────────────

describe('descriptor-driven equivalence: tilde expansion in env overrides', () => {
  test('claude: CLAUDE_CONFIG_DIR=~/foo expands to homedir/foo', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '~/foo' }, () => {
      assert.strictEqual(getGlobalConfigDir('claude'), path.join(HOME, 'foo'));
    });
  });

  test('kimi: KIMI_CONFIG_DIR=~/kimi expands to homedir/kimi', () => {
    withEnv({ KIMI_CONFIG_DIR: '~/kimi' }, () => {
      assert.strictEqual(getGlobalConfigDir('kimi'), path.join(HOME, 'kimi'));
    });
  });
});

// ── GOLDEN XDG SCENARIOS ──────────────────────────────────────────────────────

describe('descriptor-driven equivalence: xdg runtimes (opencode, kilo)', () => {
  // opencode
  test('opencode: OPENCODE_CONFIG (file-path) → dirname', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '/home/u/cfg/opencode.json';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), '/home/u/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: OPENCODE_CONFIG_DIR takes precedence over OPENCODE_CONFIG', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG_DIR'] = '/dir/wins';
    process.env['OPENCODE_CONFIG'] = '/file/loses.json';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), '/dir/wins');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: OPENCODE_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '/cfg/opencode.json';
    process.env['XDG_CONFIG_HOME'] = '/xdg/should/lose';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), '/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: XDG_CONFIG_HOME → ~/.config/opencode subdir', () => {
    const saved = clearAllEnvKeys();
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), path.join('/xdg', 'opencode'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('opencode: tilde in OPENCODE_CONFIG → dirname expands tilde', () => {
    const saved = clearAllEnvKeys();
    process.env['OPENCODE_CONFIG'] = '~/cfg/opencode.json';
    try {
      assert.strictEqual(getGlobalConfigDir('opencode'), path.join(HOME, 'cfg'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  // kilo
  test('kilo: KILO_CONFIG (file-path) → dirname', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG'] = '/home/u/cfg/kilo.json';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo'), '/home/u/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG_DIR'] = '/dir/wins';
    process.env['KILO_CONFIG'] = '/file/loses.json';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo'), '/dir/wins');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: KILO_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    const saved = clearAllEnvKeys();
    process.env['KILO_CONFIG'] = '/cfg/kilo.json';
    process.env['XDG_CONFIG_HOME'] = '/xdg/should/lose';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo'), '/cfg');
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('kilo: XDG_CONFIG_HOME → ~/.config/kilo subdir', () => {
    const saved = clearAllEnvKeys();
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    try {
      assert.strictEqual(getGlobalConfigDir('kilo'), path.join('/xdg', 'kilo'));
    } finally {
      restoreEnvKeys(saved);
    }
  });
});

// ── GOLDEN DOT-HOME-NESTED (antigravity probe) ────────────────────────────────

describe('descriptor-driven equivalence: dot-home-nested antigravity probe hit/miss', () => {
  test('antigravity probe-miss → ~/.gemini/antigravity (first candidate)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-miss-'));
    try {
      // no candidates exist → fallback to first
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: () => false },
      );
      assert.strictEqual(result, path.join(tmpHome, '.gemini', 'antigravity'));
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity → returns ~/.gemini/antigravity', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-hit-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity-ide → returns ~/.gemini/antigravity-ide', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-ide-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-ide');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity probe-hit antigravity-cli (only cli exists) → returns ~/.gemini/antigravity-cli', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-antigravity-cli-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-cli');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'dot-home-nested',
          name: 'antigravity',
          parent: '.gemini',
          env: ['ANTIGRAVITY_CONFIG_DIR'],
          probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
        },
        { env: {}, home: tmpHome, existsSync: (p) => p === hitPath },
      );
      assert.strictEqual(result, hitPath);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('antigravity: ANTIGRAVITY_CONFIG_DIR env override wins over any probe', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'dot-home-nested',
        name: 'antigravity',
        parent: '.gemini',
        env: ['ANTIGRAVITY_CONFIG_DIR'],
        probe: ['antigravity', 'antigravity-ide', 'antigravity-cli'],
      },
      { env: { ANTIGRAVITY_CONFIG_DIR: '/custom/ag' }, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, '/custom/ag');
  });

  test('windsurf (no probe) → ~/.codeium/windsurf regardless of existsSync', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'dot-home-nested',
        name: 'windsurf',
        parent: '.codeium',
        env: ['WINDSURF_CONFIG_DIR'],
      },
      { env: {}, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, '/home/u/.codeium/windsurf');
  });
});

// ── GOLDEN GENERIC-AGENTS-ROOT (kimi probe) ───────────────────────────────────

describe('descriptor-driven equivalence: generic-agents-root kimi probe hit/miss', () => {
  test('kimi probe-miss → recommended root ~/.config/agents', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-miss-'));
    try {
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        { env: {}, home: tmpHome, existsSync: () => false },
      );
      assert.strictEqual(result, path.join(tmpHome, '.config', 'agents'));
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi probe-hit on recommended root ~/.config/agents/skills', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-recommended-'));
    try {
      const recommended = path.join(tmpHome, '.config', 'agents');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        {
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(recommended, 'skills'),
        },
      );
      assert.strictEqual(result, recommended);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi probe-hit on fallback ~/.agents/skills (recommended does not exist)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-kimi-fallback-'));
    try {
      const fallback = path.join(tmpHome, '.agents');
      const result = resolveConfigHomeFromDescriptor(
        {
          kind: 'generic-agents-root',
          name: 'agents',
          env: ['KIMI_CONFIG_DIR'],
          probe: ['~/.config/agents', '~/.agents'],
          probeExists: 'skills',
        },
        {
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(fallback, 'skills'),
        },
      );
      assert.strictEqual(result, fallback);
    } finally {
      cleanup(tmpHome);
    }
  });

  test('kimi: KIMI_CONFIG_DIR env override wins over any probe', () => {
    const result = resolveConfigHomeFromDescriptor(
      {
        kind: 'generic-agents-root',
        name: 'agents',
        env: ['KIMI_CONFIG_DIR'],
        probe: ['~/.config/agents', '~/.agents'],
        probeExists: 'skills',
      },
      { env: { KIMI_CONFIG_DIR: '/custom/kimi' }, home: '/home/u', existsSync: () => true },
    );
    assert.strictEqual(result, '/custom/kimi');
  });

  // Verify resolveKimiGlobalDir wrapper delegates correctly
  test('resolveKimiGlobalDir wrapper: probe-miss → recommended root', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-rkgd-miss-'));
    try {
      assert.strictEqual(
        resolveKimiGlobalDir({ env: {}, home: tmpHome, existsSync: () => false }),
        path.join(tmpHome, '.config', 'agents'),
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  test('resolveKimiGlobalDir wrapper: fallback probe-hit', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-rkgd-hit-'));
    try {
      const fallback = path.join(tmpHome, '.agents');
      assert.strictEqual(
        resolveKimiGlobalDir({
          env: {},
          home: tmpHome,
          existsSync: (p) => p === path.join(fallback, 'skills'),
        }),
        fallback,
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  // Verify resolveAntigravityGlobalDir wrapper delegates correctly
  test('resolveAntigravityGlobalDir wrapper: probe-miss → ~/.gemini/antigravity', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-ragd-miss-'));
    try {
      assert.strictEqual(
        resolveAntigravityGlobalDir({ env: {}, home: tmpHome, existsSync: () => false }),
        path.join(tmpHome, '.gemini', 'antigravity'),
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  test('resolveAntigravityGlobalDir wrapper: probe-hit antigravity-ide', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-equiv-ragd-hit-'));
    try {
      const hitPath = path.join(tmpHome, '.gemini', 'antigravity-ide');
      assert.strictEqual(
        resolveAntigravityGlobalDir({
          env: {},
          home: tmpHome,
          existsSync: (p) => p === hitPath,
        }),
        hitPath,
      );
    } finally {
      cleanup(tmpHome);
    }
  });
});

// ── GOLDEN EXPLICIT DIR OVERRIDE ──────────────────────────────────────────────

describe('descriptor-driven equivalence: explicitDir short-circuit', () => {
  test('explicitDir absolute path returned as-is (any runtime)', () => {
    assert.strictEqual(getGlobalConfigDir('claude', '/tmp/explicit'), '/tmp/explicit');
    assert.strictEqual(getGlobalConfigDir('opencode', '/tmp/explicit'), '/tmp/explicit');
    assert.strictEqual(getGlobalConfigDir('kimi', '/tmp/explicit'), '/tmp/explicit');
    assert.strictEqual(getGlobalConfigDir('grok', '/tmp/explicit'), '/tmp/explicit');
  });

  test('explicitDir with ~ is expanded', () => {
    assert.strictEqual(
      getGlobalConfigDir('claude', '~/foo'),
      path.join(HOME, 'foo'),
    );
  });

  test('explicitDir wins even when env var is set', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '/should/not/win' }, () => {
      assert.strictEqual(getGlobalConfigDir('claude', '/explicit/wins'), '/explicit/wins');
    });
  });
});

// ── GOLDEN GROK (not in registry, hardcoded) ──────────────────────────────────

describe('descriptor-driven equivalence: grok (not in registry)', () => {
  test('grok default → ~/.agents', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('grok'), path.join(HOME, '.agents'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('grok: GROK_AGENTS_HOME override', () => {
    withEnv({ GROK_AGENTS_HOME: '/custom/grok-agents' }, () => {
      assert.strictEqual(getGlobalConfigDir('grok'), '/custom/grok-agents');
    });
  });

  test('grok: GROK_AGENTS_HOME tilde expansion', () => {
    withEnv({ GROK_AGENTS_HOME: '~/grok' }, () => {
      assert.strictEqual(getGlobalConfigDir('grok'), path.join(HOME, 'grok'));
    });
  });
});

// ── GOLDEN UNKNOWN RUNTIME (Claude fallback) ──────────────────────────────────

describe('descriptor-driven equivalence: unknown runtime fallback', () => {
  test('unknown runtime → ~/.claude default', () => {
    const saved = clearAllEnvKeys();
    try {
      assert.strictEqual(getGlobalConfigDir('no-such-runtime'), path.join(HOME, '.claude'));
    } finally {
      restoreEnvKeys(saved);
    }
  });

  test('unknown runtime → CLAUDE_CONFIG_DIR if set', () => {
    withEnv({ CLAUDE_CONFIG_DIR: '/custom/claude-for-unknown' }, () => {
      assert.strictEqual(getGlobalConfigDir('no-such-runtime'), '/custom/claude-for-unknown');
    });
  });
});

// ── GOLDEN PARITY: getGlobalConfigDir via process.env for all 16 registry runtimes ──

describe('descriptor-driven parity: 14 non-probe registry runtimes × no-env-vars = golden defaults', () => {
  // This is the hardest assertion: it drives getGlobalConfigDir() (which calls
  // the registry internally) and compares against GOLDEN_DEFAULTS captured from
  // the old switch. Any discrepancy means a regression.
  // kimi is excluded because its default depends on real filesystem probing.
  // antigravity is excluded because it also depends on real fs probing — a machine
  // with ~/.gemini/antigravity-ide or ~/.gemini/antigravity-cli (but not
  // ~/.gemini/antigravity) gets a different result. Probe scenarios are covered in
  // the dot-home-nested suite with injected existsSync.
  // grok is excluded because it is not in the registry (hardcoded branch).
  const registryRuntimes = Object.keys(GOLDEN_DEFAULTS).filter(
    r => r !== 'grok' && r !== 'antigravity',
  );

  for (const runtime of registryRuntimes) {
    test(`${runtime} via getGlobalConfigDir matches golden: ${GOLDEN_DEFAULTS[runtime]}`, () => {
      const saved = clearAllEnvKeys();
      try {
        assert.strictEqual(
          getGlobalConfigDir(runtime),
          GOLDEN_DEFAULTS[runtime],
          `getGlobalConfigDir('${runtime}') diverged from golden`,
        );
      } finally {
        restoreEnvKeys(saved);
      }
    });
  }
});
