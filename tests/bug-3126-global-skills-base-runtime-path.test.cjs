'use strict';
// allow-test-rule: last three tests read init.cjs source to verify delegation contract to runtime-homes.cjs — structural guard, no behavioral IR exposed

// Regression guard for bug #3126.
//
// buildAgentSkillsBlock() in init.cjs hardcoded `globalSkillsBase` to
// `~/.claude/skills` regardless of the active runtime. On a Cursor install,
// global: skills live under `~/.cursor/skills`, causing every global: lookup
// to silently fail with:
//   [agent-skills] WARNING: Global skill not found at "~/.cursor/skills/X/SKILL.md" — skipping
//
// Fix introduces gsd-core/bin/lib/runtime-homes.cjs with first-class
// support for all 15 supported runtimes, including:
//   - hermes: nested skills/gsd/<skillName>/ layout (#2841)
//   - cline: rules-based, returns null (no skills directory)
//   - CLAUDE_CONFIG_DIR env var for Claude (was missing)
//   - All other runtime-specific env vars

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
  getGlobalSkillDir,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));

// Helper: run fn with an env var temporarily set
function withEnv(key, value, fn) {
  const orig = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
}

describe('bug #3126: runtime-homes getGlobalConfigDir — defaults', () => {
  const defaults = [
    ['claude',      path.join(os.homedir(), '.claude')],
    ['cursor',      path.join(os.homedir(), '.cursor')],
    ['gemini',      path.join(os.homedir(), '.gemini')],
    ['codex',       path.join(os.homedir(), '.codex')],
    ['copilot',     path.join(os.homedir(), '.copilot')],
    ['antigravity', path.join(os.homedir(), '.gemini', 'antigravity')],
    ['windsurf',    path.join(os.homedir(), '.codeium', 'windsurf')],
    ['augment',     path.join(os.homedir(), '.augment')],
    ['trae',        path.join(os.homedir(), '.trae')],
    ['qwen',        path.join(os.homedir(), '.qwen')],
    ['hermes',      path.join(os.homedir(), '.hermes')],
    ['codebuddy',   path.join(os.homedir(), '.codebuddy')],
    ['cline',       path.join(os.homedir(), '.cline')],
    ['qoder',       path.join(os.homedir(), '.qoder')],
    ['opencode',    path.join(os.homedir(), '.config', 'opencode')],
    ['kilo',        path.join(os.homedir(), '.config', 'kilo')],
  ];
  for (const [runtime, expected] of defaults) {
    test(`${runtime} default configDir`, () => {
      // Clear all env vars for this runtime
      const envKeys = ['CLAUDE_CONFIG_DIR','CURSOR_CONFIG_DIR','GEMINI_CONFIG_DIR',
        'CODEX_HOME','COPILOT_CONFIG_DIR','COPILOT_HOME','ANTIGRAVITY_CONFIG_DIR','WINDSURF_CONFIG_DIR',
        'AUGMENT_CONFIG_DIR','TRAE_CONFIG_DIR','QWEN_CONFIG_DIR','HERMES_HOME',
        'CODEBUDDY_CONFIG_DIR','CLINE_CONFIG_DIR','QODER_CONFIG_DIR','OPENCODE_CONFIG_DIR','OPENCODE_CONFIG',
        'KILO_CONFIG_DIR','KILO_CONFIG',
        'XDG_CONFIG_HOME'];
      const saved = {};
      for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
      try {
        assert.strictEqual(getGlobalConfigDir(runtime), expected);
      } finally {
        for (const k of envKeys) {
          if (saved[k] !== undefined) process.env[k] = saved[k];
        }
      }
    });
  }
  test('unknown runtime falls back to ~/.claude', () => {
    withEnv('CLAUDE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(getGlobalConfigDir('unknown-xyz'), path.join(os.homedir(), '.claude'));
    });
  });
});

describe('bug #3126: runtime-homes env-var overrides', () => {
  test('claude respects CLAUDE_CONFIG_DIR (was missing in old code)', () => {
    withEnv('CLAUDE_CONFIG_DIR', '/custom/claude', () => {
      assert.strictEqual(getGlobalConfigDir('claude'), '/custom/claude');
    });
  });
  test('cursor respects CURSOR_CONFIG_DIR', () => {
    withEnv('CURSOR_CONFIG_DIR', '/custom/cursor', () => {
      assert.strictEqual(getGlobalConfigDir('cursor'), '/custom/cursor');
    });
  });
  test('opencode respects OPENCODE_CONFIG_DIR', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/custom/opencode', () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        assert.strictEqual(getGlobalConfigDir('opencode'), '/custom/opencode');
      });
    });
  });
  test('opencode uses XDG_CONFIG_HOME when OPENCODE_CONFIG_DIR absent', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', '/xdg', () => {
          assert.strictEqual(getGlobalConfigDir('opencode'), path.join('/xdg', 'opencode'));
        });
      });
    });
  });
  test('kilo uses XDG_CONFIG_HOME when KILO_CONFIG_DIR absent', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', '/xdg', () => {
          assert.strictEqual(getGlobalConfigDir('kilo'), path.join('/xdg', 'kilo'));
        });
      });
    });
  });

  test('qoder respects QODER_CONFIG_DIR', () => {
    withEnv('QODER_CONFIG_DIR', '/custom/qoder', () => {
      assert.strictEqual(getGlobalConfigDir('qoder'), '/custom/qoder');
    });
  });

  test('antigravity detects 2.x IDE dir when legacy dir is absent', () => {
    const home = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-home-'));
    try {
      require('node:fs').mkdirSync(path.join(home, '.gemini', 'antigravity-ide'), { recursive: true });
      const savedHome = process.env.HOME;
      const savedUserProfile = process.env.USERPROFILE;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      withEnv('ANTIGRAVITY_CONFIG_DIR', undefined, () => {
        assert.strictEqual(
          getGlobalConfigDir('antigravity'),
          path.join(home, '.gemini', 'antigravity-ide'),
        );
      });
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    } finally {
      cleanup(home);
    }
  });
});

describe('bug #3126: runtime-homes getGlobalSkillsBase', () => {
  test('most runtimes: skills at <configDir>/skills', () => {
    withEnv('CURSOR_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('cursor'),
        path.join(os.homedir(), '.cursor', 'skills'),
      );
    });
  });
  test('hermes: skills at <configDir>/skills/gsd (nested layout #2841)', () => {
    withEnv('HERMES_HOME', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('hermes'),
        path.join(os.homedir(), '.hermes', 'skills', 'gsd'),
      );
    });
  });
  test('cline: returns ~/.cline/skills (skills-capable since v3.48.0 — #782)', () => {
    withEnv('CLINE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillsBase('cline'),
        path.join(os.homedir(), '.cline', 'skills'),
      );
    });
  });
});

describe('bug #3126: runtime-homes getGlobalSkillDir', () => {
  test('cursor: <configDir>/skills/<skillName>', () => {
    withEnv('CURSOR_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('cursor', 'gsd-executor'),
        path.join(os.homedir(), '.cursor', 'skills', 'gsd-executor'),
      );
    });
  });
  test('hermes: <configDir>/skills/gsd/<skillName>', () => {
    withEnv('HERMES_HOME', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('hermes', 'gsd-executor'),
        path.join(os.homedir(), '.hermes', 'skills', 'gsd', 'gsd-executor'),
      );
    });
  });
  test('cline: returns ~/.cline/skills/gsd-executor (skills-capable since v3.48.0 — #782)', () => {
    withEnv('CLINE_CONFIG_DIR', undefined, () => {
      assert.strictEqual(
        getGlobalSkillDir('cline', 'gsd-executor'),
        path.join(os.homedir(), '.cline', 'skills', 'gsd-executor'),
      );
    });
  });
});

describe('getGlobalConfigDir — explicitDir override and opencode/kilo file-path precedence', () => {
  // ── explicitDir override ──────────────────────────────────────────────────
  test('explicitDir absolute path is returned as-is (claude)', () => {
    assert.strictEqual(getGlobalConfigDir('claude', '/tmp/x'), '/tmp/x');
  });

  test('explicitDir with tilde is expanded (opencode)', () => {
    assert.strictEqual(
      getGlobalConfigDir('opencode', '~/foo'),
      path.join(os.homedir(), 'foo'),
    );
  });

  test('explicitDir wins even when OPENCODE_CONFIG_DIR is also set', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/should/not/win', () => {
      assert.strictEqual(getGlobalConfigDir('opencode', '/explicit/wins'), '/explicit/wins');
    });
  });

  // ── opencode: OPENCODE_CONFIG file-path step ──────────────────────────────
  test('opencode: OPENCODE_CONFIG → path.dirname(expandTilde(value))', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        withEnv('OPENCODE_CONFIG', '/home/u/cfg/opencode.json', () => {
          assert.strictEqual(getGlobalConfigDir('opencode'), '/home/u/cfg');
        });
      });
    });
  });

  test('opencode: OPENCODE_CONFIG_DIR takes precedence over OPENCODE_CONFIG', () => {
    withEnv('OPENCODE_CONFIG_DIR', '/dir/wins', () => {
      withEnv('OPENCODE_CONFIG', '/file/loses.json', () => {
        assert.strictEqual(getGlobalConfigDir('opencode'), '/dir/wins');
      });
    });
  });

  test('opencode: OPENCODE_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', '/cfg/opencode.json', () => {
        withEnv('XDG_CONFIG_HOME', '/xdg/should/lose', () => {
          assert.strictEqual(getGlobalConfigDir('opencode'), '/cfg');
        });
      });
    });
  });

  test('opencode: default ~/.config/opencode when no env vars set', () => {
    withEnv('OPENCODE_CONFIG_DIR', undefined, () => {
      withEnv('OPENCODE_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', undefined, () => {
          assert.strictEqual(
            getGlobalConfigDir('opencode'),
            path.join(os.homedir(), '.config', 'opencode'),
          );
        });
      });
    });
  });

  // ── kilo: KILO_CONFIG file-path step ─────────────────────────────────────
  test('kilo: KILO_CONFIG → path.dirname(expandTilde(value))', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('XDG_CONFIG_HOME', undefined, () => {
        withEnv('KILO_CONFIG', '/home/u/cfg/kilo.json', () => {
          assert.strictEqual(getGlobalConfigDir('kilo'), '/home/u/cfg');
        });
      });
    });
  });

  test('kilo: KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    withEnv('KILO_CONFIG_DIR', '/dir/wins', () => {
      withEnv('KILO_CONFIG', '/file/loses.json', () => {
        assert.strictEqual(getGlobalConfigDir('kilo'), '/dir/wins');
      });
    });
  });

  test('kilo: KILO_CONFIG takes precedence over XDG_CONFIG_HOME', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', '/cfg/kilo.json', () => {
        withEnv('XDG_CONFIG_HOME', '/xdg/should/lose', () => {
          assert.strictEqual(getGlobalConfigDir('kilo'), '/cfg');
        });
      });
    });
  });

  test('kilo: default ~/.config/kilo when no env vars set', () => {
    withEnv('KILO_CONFIG_DIR', undefined, () => {
      withEnv('KILO_CONFIG', undefined, () => {
        withEnv('XDG_CONFIG_HOME', undefined, () => {
          assert.strictEqual(
            getGlobalConfigDir('kilo'),
            path.join(os.homedir(), '.config', 'kilo'),
          );
        });
      });
    });
  });
});

describe('bug #3126: init.cjs uses runtime-homes not hardcoded .claude', () => {
  test('init.cjs has no hardcoded globalSkillsBase assignment to ~/.claude/skills', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'bin', 'lib', 'init.cjs'),
      'utf8',
    );
    assert.ok(
      !src.includes("const globalSkillsBase = path.join(os.homedir(), '.claude', 'skills')"),
      'init.cjs still assigns globalSkillsBase to hardcoded ~/.claude/skills — fix not applied',
    );
  });
  test('init.cjs requires runtime-homes', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'bin', 'lib', 'init.cjs'),
      'utf8',
    );
    assert.ok(
      src.includes('runtime-homes'),
      'init.cjs does not require runtime-homes.cjs',
    );
  });
  test('init.cjs warning message no longer hardcodes ~/.claude/skills', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'bin', 'lib', 'init.cjs'),
      'utf8',
    );
    assert.ok(
      !src.includes("~/.claude/skills/${skillName}/SKILL.md"),
      'init.cjs warning message still hardcodes ~/.claude/skills path',
    );
  });
});
