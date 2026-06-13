// #69: namespace nested-skill install layout — multi-runtime parity

// allow-test-rule: source-text-is-the-product
// Reads installed .md files (product artefacts) from a real install run —
// testing their on-disk layout tests the deployed contract.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  installRuntimeArtifacts,
} = require('../bin/install.js');

const { cleanup } = require('./helpers.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const { COMMANDS_GSD, ROUTER_STEMS, routerChildren } = require('./helpers/nested-layout.cjs');

// ---------------------------------------------------------------------------
// Runtime parity decision matrix (#69)
// ---------------------------------------------------------------------------

const NEST = [
  // Claude reverted to flat (#924: nested layout breaks Skill-tool discovery on Claude Code).
  // Only the 6 runtimes below keep the nested layout.
  { runtime: 'cline',       scope: 'global', skillsSub: 'skills',     prefix: 'gsd-' },
  { runtime: 'qwen',        scope: 'global', skillsSub: 'skills',     prefix: 'gsd-' },
  { runtime: 'hermes',      scope: 'global', skillsSub: 'skills/gsd', prefix: 'gsd-' }, // #947: restored canonical prefix
  { runtime: 'augment',     scope: 'global', skillsSub: 'skills',     prefix: 'gsd-' },
  { runtime: 'trae',        scope: 'global', skillsSub: 'skills',     prefix: 'gsd-' },
  { runtime: 'antigravity', scope: 'global', skillsSub: 'skills',     prefix: 'gsd-' },
];

const FLAT = [
  // Claude reverted to flat (#924): Claude Code scans only one level under ~/.claude/skills/
  // so nested concretes were never discoverable by the Skill tool.
  { runtime: 'claude',    scope: 'global', skillsSub: 'skills' },
  { runtime: 'cursor',    scope: 'global', skillsSub: 'skills' },
  { runtime: 'codex',     scope: 'global', skillsSub: 'skills' },
  { runtime: 'copilot',   scope: 'global', skillsSub: 'skills' },
  { runtime: 'windsurf',  scope: 'global', skillsSub: 'skills' },
  { runtime: 'codebuddy', scope: 'global', skillsSub: 'skills' },
  { runtime: 'opencode',  scope: 'global', skillsSub: 'skills' },
  { runtime: 'kilo',      scope: 'global', skillsSub: 'skills' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh temp dir, run installRuntimeArtifacts into it, and return
 * the tmpDir path. Caller must cleanup in finally.
 */
function runInstall(runtime, scope, resolved) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-nest-test-${runtime}-`));
  installRuntimeArtifacts(runtime, tmpDir, scope, resolved);
  return tmpDir;
}

// Resolve the full profile once (shared by all installs)
const MANIFEST = loadSkillsManifest(COMMANDS_GSD);
const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });

// ---------------------------------------------------------------------------
// NEST runtimes: should produce exactly 6 top-level router bundles
// ---------------------------------------------------------------------------

for (const { runtime, scope, skillsSub, prefix } of NEST) {
  describe(`${runtime} (nested layout)`, () => {
    let tmpDir;

    before(() => {
      tmpDir = runInstall(runtime, scope, RESOLVED_FULL);
    });

    after(() => {
      if (tmpDir) {
        try { cleanup(tmpDir); } catch { /* best-effort */ }
      }
    });

    test(`${runtime}: exactly 6 top-level router bundles, no concrete skill at top level`, () => {
      const skillsDir = path.join(tmpDir, skillsSub);
      assert.ok(fs.existsSync(skillsDir), `skillsDir must exist: ${skillsDir}`);

      // Find router bundle dirs (top-level, named <prefix>ns-*)
      const topLevel = fs.readdirSync(skillsDir);
      const routerDirs = topLevel.filter((n) => n.startsWith(`${prefix}ns-`));
      assert.strictEqual(
        routerDirs.length,
        6,
        `Expected exactly 6 router dirs under ${skillsDir}, got ${routerDirs.length}: [${routerDirs.join(', ')}]`,
      );

      // Each router dir must be a real directory with a SKILL.md
      for (const rd of routerDirs) {
        const routerPath = path.join(skillsDir, rd);
        assert.ok(
          fs.statSync(routerPath).isDirectory(),
          `${rd} must be a directory`,
        );
        assert.ok(
          fs.existsSync(path.join(routerPath, 'SKILL.md')),
          `${rd}/SKILL.md must exist`,
        );
      }

      // Sample concrete skills must NOT appear at top level
      for (const concreteSample of ['plan-phase', 'code-review']) {
        const concreteName = `${prefix}${concreteSample}`;
        assert.ok(
          !topLevel.includes(concreteName),
          `Concrete skill ${concreteName} must NOT be at top level for ${runtime}`,
        );
      }

      // Total GSD-owned top-level entries must be EXACTLY 6 (only the routers).
      // All nested runtimes (incl. Hermes after #947) use prefix='gsd-'.
      const gsdTopLevelCount = prefix !== ''
        ? topLevel.filter((n) => n.startsWith(prefix)).length
        : topLevel.filter((n) => fs.statSync(path.join(skillsDir, n)).isDirectory()).length;
      assert.strictEqual(
        gsdTopLevelCount,
        6,
        `Expected exactly 6 total GSD-owned top-level skill dirs for ${runtime} (only routers), got ${gsdTopLevelCount}: [${topLevel.join(', ')}]`,
      );
    });

    test(`${runtime}: every router has a skills/ subdir with its required children as nested SKILL.md`, () => {
      const skillsDir = path.join(tmpDir, skillsSub);

      for (const routerStem of ROUTER_STEMS) {
        const routerDirName = `${prefix}${routerStem}`;
        const routerDir = path.join(skillsDir, routerDirName);
        assert.ok(
          fs.existsSync(routerDir),
          `Router dir must exist: ${routerDir}`,
        );

        const childrenSubdir = path.join(routerDir, 'skills');
        assert.ok(
          fs.statSync(childrenSubdir).isDirectory(),
          `${routerDirName}/skills must be a directory`,
        );

        const children = routerChildren(routerStem);
        assert.ok(children.length > 0, `Router ${routerStem} must have at least one child`);

        for (const child of children) {
          const childSkillMd = path.join(childrenSubdir, child, 'SKILL.md');
          assert.ok(
            fs.existsSync(childSkillMd),
            `${routerDirName}/skills/${child}/SKILL.md must exist (child of ${routerStem})`,
          );
          assert.ok(
            fs.statSync(childSkillMd).isFile(),
            `${routerDirName}/skills/${child}/SKILL.md must be a file`,
          );
        }
      }
    });

    test(`${runtime}: every router body Read-reference resolves to a nested file`, () => {
      const skillsDir = path.join(tmpDir, skillsSub);

      for (const routerStem of ROUTER_STEMS) {
        const routerDirName = `${prefix}${routerStem}`;
        const routerDir = path.join(skillsDir, routerDirName);
        const routerSkillMd = path.join(routerDir, 'SKILL.md');
        assert.ok(fs.existsSync(routerSkillMd), `${routerDirName}/SKILL.md must exist`);

        const body = fs.readFileSync(routerSkillMd, 'utf-8');
        // Extract skills/<stem>/SKILL.md paths from Read-reference lines in the table
        const refs = [...body.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)].map((m) => m[1]);

        // There should be at least one reference in every nested router body
        assert.ok(
          refs.length > 0,
          `${routerDirName}/SKILL.md must contain at least one skills/<stem>/SKILL.md reference`,
        );

        for (const stem of refs) {
          assert.ok(
            fs.existsSync(path.join(routerDir, 'skills', stem, 'SKILL.md')),
            `${routerDirName}/SKILL.md references skills/${stem}/SKILL.md but it does not exist on disk`,
          );
        }
      }
    });

    test(`${runtime}: installed nested skill bodies contain no leaked Claude home paths`, () => {
      const skillsDir = path.join(tmpDir, skillsSub);
      const leakedPathRegex = /(?:~|\$HOME)\/\.claude\b/g;
      const leaks = [];

      const scan = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scan(fullPath);
            continue;
          }
          if (!entry.name.endsWith('.md')) continue;
          const relPath = path.relative(skillsDir, fullPath);
          const content = fs.readFileSync(fullPath, 'utf8');
          const matches = content.match(leakedPathRegex);
          if (matches) leaks.push(`${relPath} (${matches.length})`);
        }
      };

      scan(skillsDir);

      assert.deepStrictEqual(
        leaks,
        [],
        `${runtime} nested skills must not leak Claude home paths: ${leaks.join(', ')}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// claude extra: total top-level gsd- count must be >= 60 (FLAT, #924)
//
// Pre-#924 (nested) this block asserted exactly 6 (only routers).
// Post-#924 (flat) Claude has all concrete skills at the top level.
// ---------------------------------------------------------------------------

describe('claude: total top-level gsd- entries >= 60 (flat layout, #924)', () => {
  let tmpDir;

  before(() => {
    tmpDir = runInstall('claude', 'global', RESOLVED_FULL);
  });

  after(() => {
    if (tmpDir) {
      try { cleanup(tmpDir); } catch { /* best-effort */ }
    }
  });

  test('claude: >= 60 gsd-* top-level skill entries (concrete flat layout, not nested)', () => {
    const skillsDir = path.join(tmpDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ dir must exist');

    const topLevel = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevel.length >= 60,
      `Expected >= 60 gsd-* top-level entries under claude/skills (flat layout after #924 fix). ` +
      `Got ${topLevel.length}: [${topLevel.slice(0, 10).join(', ')}${topLevel.length > 10 ? ', …' : ''}]`,
    );
  });
});

// ---------------------------------------------------------------------------
// FLAT runtimes: concrete skills stay top-level, no nesting
// ---------------------------------------------------------------------------

for (const { runtime, scope, skillsSub } of FLAT) {
  describe(`${runtime} (flat layout)`, () => {
    let tmpDir;

    before(() => {
      tmpDir = runInstall(runtime, scope, RESOLVED_FULL);
    });

    after(() => {
      if (tmpDir) {
        try { cleanup(tmpDir); } catch { /* best-effort */ }
      }
    });

    test(`${runtime}: stays flat — concrete skills remain top-level, no nesting`, () => {
      const skillsDir = path.join(tmpDir, skillsSub);
      assert.ok(fs.existsSync(skillsDir), `skillsDir must exist: ${skillsDir}`);

      const topLevel = fs.readdirSync(skillsDir);
      const gsdEntries = topLevel.filter((n) => n.startsWith('gsd-'));

      // For flat runtimes, there should be many more than 6 top-level gsd- entries
      assert.ok(
        gsdEntries.length >= 60,
        `Flat runtime ${runtime} must have >= 60 gsd-* top-level entries (concrete skills), got ${gsdEntries.length}`,
      );

      // No router dir should contain a skills/ subdirectory (nesting must not have been applied)
      const routerDirsPresent = topLevel.filter((n) => n.startsWith('gsd-ns-'));
      for (const rd of routerDirsPresent) {
        const nestedSkillsDir = path.join(skillsDir, rd, 'skills');
        assert.ok(
          !fs.existsSync(nestedSkillsDir),
          `Flat runtime ${runtime}: router dir ${rd} must NOT have a skills/ subdirectory (nesting must not apply)`,
        );
      }
    });
  });
}
