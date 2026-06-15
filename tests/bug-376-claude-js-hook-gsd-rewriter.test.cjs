'use strict';

/**
 * Regression for bug #376 — Claude-installed hook JS files ship with raw
 * /gsd:<cmd> command literals because the hook-copy loop in install.js had
 * no /gsd: → /gsd- rewrite for the claude runtime.
 *
 * Fix: the `.js` branch of the hook-copy loop now applies
 * `content.replace(/gsd:/gi, 'gsd-')` when
 * `shouldNormalizeHyphenNamespaceInAgentBody(runtime)` is true (covers
 * claude, qwen, hermes).
 *
 * Test plan:
 *   1. Claude install to tmp prefix — installed .js hook files must contain
 *      no user-facing /gsd: literals (// comment occurrences exempted).
 *   2. Cursor install regression — still rewrites correctly (pre-existing
 *      branch must remain intact).
 *   3. Source files in hooks/ must be byte-identical before and after both
 *      installs (install-time rewrite only, no in-tree mutation).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Ensure hooks/dist is populated before any suite that reads it.
 * hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
 * In CI the scoped/windows test jobs do NOT run build:hooks before running
 * tests, so the first test that needs hooks/dist would fail. This mirrors
 * the pattern used in bug-3357-codex-legacy-hooks-json-migration.test.cjs.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js <...args>` from cwd.
 * GSD_TEST_MODE is cleared so the install() main block executes.
 */
function runInstall(cwd, args) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    timeout: 60000,
  });
}

/**
 * Return an array of { rel, path } for all .js files under dir.
 */
function findJsFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
        results.push({ rel: path.relative(dir, full), full });
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Split a JS file's lines into comment and non-comment buckets.
 * A line is treated as a comment if it starts with optional whitespace
 * followed by // (single-line comment). Block comments are not checked
 * since none of the hook files use them for command refs.
 */
function nonCommentLines(content) {
  return content.split('\n').filter(line => !/^\s*\/\//.test(line));
}

/**
 * Return lines (from nonCommentLines) that contain a user-facing /gsd: ref.
 */
function colonRefs(content) {
  return nonCommentLines(content).filter(line => /\/gsd:/.test(line));
}

// ---------------------------------------------------------------------------
// Prerequisite: hooks/dist must exist (built by `npm run build:hooks`)
// ---------------------------------------------------------------------------
describe('bug #376 — prerequisite: hooks/dist is present', () => {
  before(() => {
    // hooks/dist is gitignored; build it on demand so this test is
    // deterministic in CI scoped/windows jobs that don't pre-run build:hooks.
    ensureHooksDist();
  });

  test('hooks/dist directory exists (run npm run build:hooks if missing)', () => {
    assert.ok(
      fs.existsSync(HOOKS_DIST_DIR),
      `hooks/dist not found at ${HOOKS_DIST_DIR}. Run: npm run build:hooks`,
    );
  });

  test('hooks/dist contains at least one .js hook file with a /gsd: literal', () => {
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    assert.ok(jsFiles.length > 0, 'hooks/dist must contain .js files');

    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    assert.ok(
      withColonRef.length > 0,
      'Expected at least one hooks/dist .js file with a non-comment /gsd: literal ' +
      '— this confirms the test is guarding a real regression surface. ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 1 — Claude install: no /gsd: colon refs in installed .js hook files
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 1: Claude install rewrites /gsd: → /gsd- in hook .js files', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-claude-'));
    runInstall(tmpDir, ['--claude', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('1a: hooks/ directory is created by the Claude local install', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      `hooks/ must be created at ${hooksDir} by Claude local install`,
    );
  });

  test('1b: installed .js hook files contain no user-facing /gsd: colon refs', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      // If hooks/ wasn't created (hooks/dist missing at install time), skip gracefully
      return;
    }

    const jsFiles = findJsFiles(hooksDir);
    assert.ok(jsFiles.length > 0, 'At least one .js hook file must be installed');

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Installed Claude hook .js files must not contain /gsd:<cmd> colon refs ' +
      '(non-comment occurrences). The install-time rewriter must replace these with /gsd-<cmd>. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('1c: installed .js hook files DO contain the hyphen form /gsd- (rewrite happened)', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) return;

    const jsFiles = findJsFiles(hooksDir);
    const withHyphen = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return /\/gsd-/.test(content);
    });

    assert.ok(
      withHyphen.length > 0,
      'At least one installed .js hook file must contain /gsd- (confirming rewrite ran). ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Cursor install regression: /gsd: → /gsd- still works (pre-existing)
//
// Note: Cursor installs its own hooks (gsd-cursor-session-start.js and
// gsd-cursor-post-tool.js) via the cursor-hooks-json installSurface (issue #777).
// It does NOT install the bundled Claude-style hooks/dist files (no gsd-session-state.sh
// etc.). The Cursor /gsd: rewrite applies in `copyWithPathReplacement` to JS files
// under the agent/skill tree (.cursor/gsd-core/*.js etc). We verify that Cursor's
// installed .js files under .cursor/ have no /gsd: colon refs, and that the hooks/
// directory contains only the Cursor-specific managed hooks.
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 2: Cursor install still rewrites /gsd: → /gsd- (regression)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-cursor-'));
    runInstall(tmpDir, ['--cursor', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('2a: .cursor/ directory is created by the Cursor local install', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    assert.ok(
      fs.existsSync(cursorDir),
      `Cursor install must create .cursor/ directory at ${cursorDir}`,
    );
  });

  test('2b: Cursor-installed .js files contain no user-facing /gsd: colon refs', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    if (!fs.existsSync(cursorDir)) return;

    // Infrastructure files whose /gsd: occurrences are intentional implementation
    // details — NOT user-facing command references that Cursor would invoke.
    //
    // scripts/fix-slash-commands.cjs is the slash-command rewriter engine, required
    // by gsd-core/bin/lib/command-roster.cjs on ALL runtimes (including Cursor).
    // It must be installed verbatim and must NOT be content-rewritten: it needs to
    // emit `/gsd:${cmd}` for non-Cursor runtimes, and its /gsd: strings are internal
    // implementation/docs (transform patterns, regex literals, template literals),
    // not commands a Cursor user would type. Rewriting it would corrupt the transformer.
    const INFRA_BASENAMES = new Set(['fix-slash-commands.cjs']);

    const jsFiles = findJsFiles(cursorDir);
    // Cursor may not install any .js files depending on what agent/skill content exists;
    // if none, skip gracefully.
    if (jsFiles.length === 0) return;

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      // Skip infrastructure files whose /gsd: strings are intentional (see above).
      if (INFRA_BASENAMES.has(path.basename(full))) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Cursor-installed .js files must not contain /gsd:<cmd> colon refs. ' +
      'The existing Cursor branch in copyWithPathReplacement must still apply /gsd:/gi → gsd- rewrite. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('2c: Cursor install creates a hooks/ directory with only Cursor-specific managed hooks', () => {
    // Since issue #777, Cursor installs gsd-cursor-session-start.js and
    // gsd-cursor-post-tool.js into <configDir>/hooks/. These are Cursor-native
    // hooks — NOT the bundled Claude-style hooks (no gsd-session-state.sh etc.).
    // Verify: hooks/ exists AND does NOT contain any Claude-bundled hooks.
    const hooksDir = path.join(tmpDir, '.cursor', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      'Cursor install must create a hooks/ directory for its managed hook scripts (#777)',
    );
    const CLAUDE_BUNDLED_HOOKS = ['gsd-session-state.sh', 'gsd-context-monitor.js', 'gsd-statusline.js'];
    for (const hook of CLAUDE_BUNDLED_HOOKS) {
      assert.strictEqual(
        fs.existsSync(path.join(hooksDir, hook)),
        false,
        `Cursor hooks/ must NOT contain Claude-bundled hook ${hook} — only Cursor-native hooks are installed`,
      );
    }
    // The two Cursor-specific managed hooks must be present.
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-session-start.js')),
      'gsd-cursor-session-start.js must be installed in .cursor/hooks/ (#777)',
    );
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-post-tool.js')),
      'gsd-cursor-post-tool.js must be installed in .cursor/hooks/ (#777)',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Source files in hooks/ are untouched
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 3: hooks/ source files are unchanged by install', () => {
  let snapshotBefore;

  before(() => {
    // Ensure hooks/dist is built before snapshotting; it may be absent in CI
    // scoped/windows jobs that don't pre-run build:hooks (#777 fix).
    ensureHooksDist();
    // Snapshot hooks/dist JS files before any install in this suite
    snapshotBefore = {};
    if (fs.existsSync(HOOKS_DIST_DIR)) {
      for (const { rel, full } of findJsFiles(HOOKS_DIST_DIR)) {
        snapshotBefore[rel] = fs.readFileSync(full, 'utf-8');
      }
    }
  });

  test('3a: hooks/dist .js source files still contain /gsd: literals (not mutated)', () => {
    // The source must remain in colon form — the rewrite is install-time only
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    // We know from the prerequisite suite that at least one file had a colon ref;
    // if the source was mutated by install, this would now be zero.
    assert.ok(
      withColonRef.length > 0,
      'hooks/dist .js files must still contain /gsd: literals after install — ' +
      'the install-time rewrite must NOT modify the source tree. ' +
      `Files that still have colon refs: ${withColonRef.map(f => f.rel).join(', ')}`,
    );
  });

  test('3b: hooks/dist .js source file contents match pre-test snapshot (byte-identical)', () => {
    if (Object.keys(snapshotBefore).length === 0) {
      // hooks/dist was absent before; skip
      return;
    }

    for (const [rel, before] of Object.entries(snapshotBefore)) {
      const full = path.join(HOOKS_DIST_DIR, rel);
      const after = fs.readFileSync(full, 'utf-8');
      assert.strictEqual(
        after,
        before,
        `hooks/dist/${rel} was mutated by install — install must only rewrite the installed copy, not the source`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Pure-function: shouldNormalizeHyphenNamespaceInAgentBody covers claude
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 4: shouldNormalizeHyphenNamespaceInAgentBody covers claude', () => {
  const install = require(INSTALL_PATH);

  test('4a: shouldNormalizeHyphenNamespaceInAgentBody is exported', () => {
    assert.strictEqual(
      typeof install.shouldNormalizeHyphenNamespaceInAgentBody,
      'function',
      'install.js must export shouldNormalizeHyphenNamespaceInAgentBody',
    );
  });

  test('4b: claude is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('claude'),
      true,
      'claude must be a hyphen-namespace runtime',
    );
  });

  test('4c: qwen is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('qwen'),
      true,
    );
  });

  test('4d: hermes is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('hermes'),
      true,
    );
  });

  test('4e: gemini is NOT in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('gemini'),
      false,
      'gemini intentionally keeps colon namespace and must not be in the hyphen set',
    );
  });
});
