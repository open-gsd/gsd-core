// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Tests - path replacement in install.js
 *
 * Verifies that global installs produce $HOME/ paths in .md files,
 * so that shell commands expand correctly inside double quotes.
 * ~ does NOT expand inside double quotes in POSIX shells, causing
 * MODULE_NOT_FOUND errors (see #1284).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.join(__dirname, '..');

// #5923: drop gsd-core/CHANGELOG.md when byte-identical to the repo-root CHANGELOG.md (copied verbatim,
// bin/install.js:12364-12368); its release notes quote installer bugs in prose.
function isChangelogCopy(file, text) {
  return path.basename(file) === 'CHANGELOG.md' && text === fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
}
function withoutChangelogCopy(files) {
  return new Map([...files].filter(([file, text]) => !isChangelogCopy(file, text)));
}

// Thin adapter over the REAL _computePathPrefix (ADR-1508 Phase 2: deleted hand-copy).
// Old signature: computePathPrefix(homedir, targetDir) assumed isGlobal=true, isOpencode=false.
// This adapter preserves that contract so existing call-sites stay unchanged.
process.env['GSD_TEST_MODE'] = '1';
const { _computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
function computePathPrefix(homedir, targetDir) {
  return _computePathPrefix({
    isGlobal: true,
    isOpencode: false,
    isWindowsHost: process.platform === 'win32',
    resolvedTarget: path.resolve(targetDir).replace(/\\/g, '/'),
    homeDir: homedir.replace(/\\/g, '/'),
  });
}

// Detect whether `content` leaks a resolved absolute homedir path (e.g.
// /home/alice or /root). A bare substring match false-positives when homedir
// is short and happens to appear inside ordinary words or tags — for example
// `</root_cause_analysis>` when os.homedir() === '/root' (Docker). Real path
// leaks are followed by a path separator, so we require a trailing '/'.
// See #3503.
function containsResolvedHomedir(content, normalizedHomedir) {
  if (!normalizedHomedir || normalizedHomedir === '$HOME') return false;
  return content.includes(normalizedHomedir + '/');
}

describe('pathPrefix computation', () => {
  test('default Claude global install uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.claude');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.strictEqual(prefix, '$HOME/.claude/');
  });

  test('default Gemini global install uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.gemini');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.strictEqual(prefix, '$HOME/.gemini/');
  });

  test('custom config dir under home uses $HOME/', () => {
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.config', 'claude');
    const prefix = computePathPrefix(homedir, targetDir);
    assert.ok(prefix.startsWith('$HOME/'), `Expected $HOME/ prefix, got: ${prefix}`);
    assert.ok(!prefix.includes(homedir), `Should not contain homedir: ${homedir}`);
  });

  test('Windows-style paths produce $HOME/ not C:/', () => {
    // Call the REAL _computePathPrefix with Windows-style paths.
    // isWindowsHost=true is passed; today the function ignores it (no-op) and
    // the $HOME shorthand is determined by the startsWith(homeDir) check alone.
    const prefix = _computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/matte/.claude',
      homeDir: 'C:/Users/matte',
    });
    assert.strictEqual(prefix, '$HOME/.claude/');
    assert.ok(!prefix.includes('C:'), `Should not contain drive letter, got: ${prefix}`);
  });

  test('target outside home uses absolute path', () => {
    const prefix = _computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/opt/gsd/.claude',
      homeDir: '/home/user',
    });
    assert.strictEqual(prefix, '/opt/gsd/.claude/');
    assert.ok(!prefix.includes('$HOME'), `Should not contain $HOME for non-home paths`);
  });

  test('$HOME expands inside double-quoted shell commands', () => {
    // This is the core regression test for #1284:
    // ~ does NOT expand inside double quotes in POSIX shells,
    // but $HOME does expand inside double quotes.
    const homedir = os.homedir();
    const targetDir = path.join(homedir, '.claude');
    const prefix = computePathPrefix(homedir, targetDir);
    // Verify the prefix uses $HOME, not ~
    assert.ok(!prefix.startsWith('~/'), `pathPrefix must not use ~ (breaks in double-quoted shell commands), got: ${prefix}`);
    assert.ok(prefix.startsWith('$HOME/'), `pathPrefix must use $HOME for shell expansion, got: ${prefix}`);
  });
});

describe('source .md files have no quoted-tilde shell patterns', () => {
  function collectMdFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const dirsToCheck = ['commands', 'gsd-core', 'agents'].map(d => path.join(repoRoot, d));
  const mdFiles = dirsToCheck.flatMap(collectMdFiles);

  test('source .md files exist', () => {
    assert.ok(mdFiles.length > 0, `Expected .md files, found ${mdFiles.length}`);
  });

  test('no .md file contains node "~/ pattern (quoted tilde breaks shell expansion)', () => {
    const quotedTildePattern = /node\s+"~\//;
    const failures = [];
    for (const file of mdFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (quotedTildePattern.test(content)) {
        failures.push(path.relative(repoRoot, file));
      }
    }
    assert.deepStrictEqual(failures, [], `Files with quoted-tilde node paths: ${failures.join(', ')}`);
  });
});

describe('installed .md files contain no resolved absolute paths', () => {
  const homedir = os.homedir();
  const targetDir = path.join(homedir, '.claude');
  const pathPrefix = computePathPrefix(homedir, targetDir);
  const claudeDirRegex = /~\/\.claude\//g;
  const claudeHomeRegex = /\$HOME\/\.claude\//g;
  const normalizedHomedir = homedir.replace(/\\/g, '/');

  function collectMdFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const dirsToCheck = ['commands', 'gsd-core', 'agents'].map(d => path.join(repoRoot, d));
  const mdFiles = dirsToCheck.flatMap(collectMdFiles);

  test('after replacement, no .md file contains os.homedir()', () => {
    const failures = [];
    for (const file of mdFiles) {
      let content = fs.readFileSync(file, 'utf8');
      content = content.replace(claudeDirRegex, pathPrefix);
      content = content.replace(claudeHomeRegex, pathPrefix);
      if (containsResolvedHomedir(content, normalizedHomedir)) {
        failures.push(path.relative(repoRoot, file));
      }
    }
    assert.deepStrictEqual(failures, [], `Files with resolved absolute paths: ${failures.join(', ')}`);
  });
});

describe('containsResolvedHomedir predicate (#3503)', () => {
  test('flags a real homedir path leak with trailing slash', () => {
    const content = 'see /home/alice/.claude/config for details';
    assert.strictEqual(containsResolvedHomedir(content, '/home/alice'), true);
  });

  test('does NOT flag short homedir appearing as substring of an identifier (#3503)', () => {
    // Regression: in Docker, os.homedir() === '/root'. Agent markdown contains
    // `<root_cause_analysis>` / `</root_cause_analysis>` tags. The old naive
    // substring check false-fired on these. The trailing-slash rule fixes it.
    const content = '<root_cause_analysis>\nfoo\n</root_cause_analysis>';
    assert.strictEqual(containsResolvedHomedir(content, '/root'), false);
  });

  test('still flags /root when followed by a real path separator', () => {
    const content = 'cat /root/.claude/agents.md';
    assert.strictEqual(containsResolvedHomedir(content, '/root'), true);
  });

  test('returns false for $HOME placeholder', () => {
    assert.strictEqual(containsResolvedHomedir('$HOME/.claude/', '$HOME'), false);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2376-opencode-windows-home-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2376-opencode-windows-home-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #2376: @$HOME not correctly mapped in OpenCode on Windows.
 *
 * On Windows, $HOME is not expanded by PowerShell/cmd.exe, so OpenCode cannot
 * resolve @$HOME/... file references in installed command files.
 *
 * Fix: install.js must use the absolute path (not $HOME-relative) when installing
 * for OpenCode. (Generalized to all platforms in #2831 — OpenCode `@file`
 * references are not shell-expanded on any platform.)
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let computePathPrefix;

before(() => {
  process.env.GSD_TEST_MODE = '1';
  // Re-require fresh in case other tests already loaded it.
  delete require.cache[require.resolve('../gsd-core/bin/lib/runtime-artifact-conversion.cjs')];
  ({ _computePathPrefix: computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2376: OpenCode on Windows must use absolute path, not $HOME', () => {
  test('computePathPrefix (_computePathPrefix) is exported by runtime-artifact-conversion.cjs', () => {
    assert.equal(typeof computePathPrefix, 'function');
  });

  test('OpenCode on Windows: pathPrefix is absolute (no $HOME substitution)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/user/.config/opencode',
      homeDir: 'C:/Users/user',
    });
    assert.strictEqual(pathPrefix, 'C:/Users/user/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('Claude Code on Windows: pathPrefix still uses $HOME (unaffected)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/user/.claude',
      homeDir: 'C:/Users/user',
    });
    assert.strictEqual(pathPrefix, '$HOME/.claude/');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2831-opencode-home-path-prefix.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2831-opencode-home-path-prefix (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #2831)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2831: OpenCode @file references contain literal `$HOME`
 * which OpenCode does not expand — `@$HOME/.config/opencode/...` is resolved
 * as a path relative to the config command/ dir, producing
 * `command/$HOME/.config/opencode/...` (file not found).
 *
 * Root cause: install.js pathPrefix used `$HOME`-relative paths for OpenCode on
 * non-Windows hosts (only Windows was guarded by #2376). OpenCode's `@file`
 * include syntax does NOT shell-expand `$HOME` on any platform.
 *
 * Fix: pathPrefix must use the absolute path for OpenCode on all platforms.
 *
 * Tests exercise install.js's exported `computePathPrefix` directly (no source
 * grepping) and additionally simulate the `copyFlattenedCommands` substitution
 * pipeline on a temp tree to verify no `$HOME` literal leaks into emitted files.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cleanup } = require('./helpers.cjs');

let computePathPrefix;

before(() => {
  process.env.GSD_TEST_MODE = '1';
  delete require.cache[require.resolve('../gsd-core/bin/lib/runtime-artifact-conversion.cjs')];
  ({ _computePathPrefix: computePathPrefix } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs'));
});

after(() => {
  delete process.env.GSD_TEST_MODE;
});

describe('bug-2831: OpenCode pathPrefix uses absolute path on all platforms', () => {
  test('computePathPrefix (_computePathPrefix) is exported by runtime-artifact-conversion.cjs', () => {
    assert.equal(typeof computePathPrefix, 'function');
  });

  test('OpenCode on macOS: pathPrefix is absolute (no $HOME)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/.config/opencode',
    });
    assert.strictEqual(pathPrefix, '/Users/alice/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('OpenCode on Linux: pathPrefix is absolute (no $HOME)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      homeDir: '/home/bob',
      resolvedTarget: '/home/bob/.config/opencode',
    });
    assert.strictEqual(pathPrefix, '/home/bob/.config/opencode/');
    assert.ok(!pathPrefix.includes('$HOME'));
  });

  test('OpenCode on Windows: pathPrefix is absolute (preserves #2376)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: true,
      homeDir: 'C:/Users/carol',
      resolvedTarget: 'C:/Users/carol/.config/opencode',
    });
    assert.strictEqual(pathPrefix, 'C:/Users/carol/.config/opencode/');
  });

  test('Claude Code on macOS: pathPrefix still uses $HOME (unaffected)', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/.claude',
    });
    assert.strictEqual(pathPrefix, '$HOME/.claude/');
  });

  test('Local install (non-global): pathPrefix uses absolute path regardless of runtime', () => {
    const pathPrefix = computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: false,
      homeDir: '/Users/alice',
      resolvedTarget: '/Users/alice/projects/foo/.claude',
    });
    assert.strictEqual(pathPrefix, '/Users/alice/projects/foo/.claude/');
  });

  test('Substitution pipeline simulation: OpenCode emits no @$HOME literal', () => {
    // This validates the same regex substitution pipeline used by
    // copyFlattenedCommands when writing OpenCode command files. We invoke the
    // real exported computePathPrefix; the regex passes mirror the install.js
    // call sites (globalClaudeRegex / globalClaudeHomeRegex).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2831-'));
    try {
      const srcRoot = path.join(tmp, 'src');
      const targetRoot = path.join(tmp, 'home', '.config', 'opencode');
      const srcCmdDir = path.join(srcRoot, 'commands', 'gsd');
      fs.mkdirSync(srcCmdDir, { recursive: true });
      fs.mkdirSync(targetRoot, { recursive: true });

      const srcFile = path.join(srcCmdDir, 'autonomous.md');
      fs.writeFileSync(
        srcFile,
        '---\nname: autonomous\n---\n<execution_context>\n@~/.claude/gsd-core/workflows/autonomous.md\n@$HOME/.claude/gsd-core/references/ui-brand.md\n</execution_context>\n'
      );

      const homeDir = path.join(tmp, 'home').replace(/\\/g, '/');
      const resolvedTarget = targetRoot.replace(/\\/g, '/');
      const pathPrefix = computePathPrefix({
        isGlobal: true,
        isOpencode: true,
        isWindowsHost: false,
        homeDir,
        resolvedTarget,
      });

      let content = fs.readFileSync(srcFile, 'utf8');
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);

      assert.ok(
        !/@\$HOME\b/.test(content),
        `output must not contain @$HOME literal; got:\n${content}`
      );
      assert.ok(
        !/\$HOME\b/.test(content),
        `output must not contain $HOME literal; got:\n${content}`
      );
      assert.ok(
        content.includes(`@${resolvedTarget}/`),
        `output should include absolute path with @ prefix; got:\n${content}`
      );
    } finally {
      cleanup(tmp);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// #3133: global Claude @-references must resolve (tilde), not $HOME.
//
// Claude Code expands `~` and absolute paths in @-file references but NOT
// `$HOME`. computePathPrefix returns `$HOME/.claude/` for global installs
// (correct for double-quoted shell commands — `~` does not expand inside
// double quotes, #1284), so context-blind substitution rewrote every
// `@~/.claude/…` include to `@$HOME/.claude/…`, which silently resolves to
// nothing — skills load with an empty <execution_context>. OpenCode already
// has an absolute-path carve-out for the identical limitation (#2376/#2831);
// Claude is not special. Fix: in the `claude` rewrite case, restore the
// tilde form for @-references when the prefix is the $HOME (global) form.
// ────────────────────────────────────────────────────────────────────────
describe('#3133: global Claude @-references resolve on tilde, not $HOME', () => {
  // Re-require to also pull _applyRuntimeRewrites (module is cached under GSD_TEST_MODE).
  const conv = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const _computePathPrefix = conv._computePathPrefix;
  const _applyRuntimeRewrites = conv._applyRuntimeRewrites;

  const homeDir = os.homedir().replace(/\\/g, '/');
  const isWin = process.platform === 'win32';
  const globalClaudePrefix = _computePathPrefix({
    isGlobal: true, isOpencode: false, isWindowsHost: isWin,
    resolvedTarget: homeDir + '/.claude', homeDir,
  });
  // Sanity: the global claude prefix IS the $HOME form (the precondition for the bug).
  assert.ok(globalClaudePrefix.startsWith('$HOME/'), `expected $HOME prefix, got ${globalClaudePrefix}`);

  test('row 1 — global Claude @-reference stays on tilde (resolves), not $HOME', () => {
    const src = '---\nname: gsd-stats\n---\n<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/workflows\/stats\.md/, `@-ref must stay on tilde; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `must not emit @$HOME (Claude does not expand it); got:\n${out}`);
  });

  test('row 2 — global Claude normalizes an @$HOME source reference to @~', () => {
    // Source may already carry @$HOME (e.g. a prior bad render); it must end on @~.
    const src = '<execution_context>\n@$HOME/.claude/gsd-core/references/ui-brand.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/references\/ui-brand\.md/, `@$HOME source must normalize to @~; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `no @$HOME may remain; got:\n${out}`);
  });

  test('row 3 — global Claude shell contexts keep $HOME (#1284 preserved)', () => {
    // `~` does NOT expand inside double quotes; $HOME does. Shell commands must stay $HOME.
    const src = 'Run: node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" query state\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /node "\$HOME\/\.claude\/gsd-core\/bin\/gsd-tools\.cjs"/, `shell $HOME must be preserved; got:\n${out}`);
    assert.doesNotMatch(out, /node "~\//, `must not introduce quoted-tilde (re-introduces #1284); got:\n${out}`);
  });

  test('row 4 — global Claude bare ~/ shell (unquoted) becomes $HOME', () => {
    const src = 'cat ~/.claude/gsd-core/VERSION\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /cat \$HOME\/\.claude\/gsd-core\/VERSION/, `unquoted ~/ shell must become $HOME; got:\n${out}`);
  });

  test('row 5 — local Claude @-reference rewrites to the absolute target', () => {
    // Local install is NOT under $HOME/.claude; @~/ would point at global home.
    // pathPrefix is absolute; @-refs must follow it (Claude resolves absolute).
    const localPrefix = _computePathPrefix({
      isGlobal: false, isOpencode: false, isWindowsHost: isWin,
      resolvedTarget: '/abs/projects/foo/.claude', homeDir,
    });
    assert.ok(!localPrefix.startsWith('$HOME'), `local prefix must be absolute, got ${localPrefix}`);
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'claude', localPrefix, false, undefined);
    assert.match(out, /@\/abs\/projects\/foo\/\.claude\/gsd-core\/workflows\/stats\.md/, `local @-ref must rewrite to absolute target; got:\n${out}`);
    assert.doesNotMatch(out, /@~\/\.claude/, `local @-ref must not stay on global ~/; got:\n${out}`);
  });

  test('row 6 — global Claude @-ref normalization is idempotent (re-surface safe)', () => {
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const once = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    const twice = _applyRuntimeRewrites(once, 'claude', globalClaudePrefix, true, undefined);
    assert.equal(twice, once, `re-running the rewrite must be stable (idempotent)`);
    assert.doesNotMatch(twice, /@\$HOME/, `no @$HOME after 2nd pass; got:\n${twice}`);
  });

  test('row 7 — global Claude emits no resolved homedir literal (#3503 preserved)', () => {
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\nnode "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    // A real homedir leak is followed by a path separator (#3503 trailing-slash rule).
    assert.ok(!out.includes(homeDir + '/'), `must not leak resolved homedir ${homeDir}/; got:\n${out}`);
  });

  test('row 8 — non-Claude runtime (codex) is unaffected by the claude @-ref fix', () => {
    // The claude normalization targets @$HOME/.claude/; codex rewrites to .codex/,
    // so its output must be byte-identical to pre-fix (no @~/.claude/ restoration).
    const codexPrefix = _computePathPrefix({
      isGlobal: true, isOpencode: false, isWindowsHost: isWin,
      resolvedTarget: homeDir + '/.codex', homeDir,
    });
    const src = '<execution_context>\n@~/.claude/gsd-core/workflows/stats.md\n</execution_context>\n';
    const out = _applyRuntimeRewrites(src, 'codex', codexPrefix, true, undefined);
    // Codex rewrites .claude -> .codex; the @-ref must NOT have been restored to @~/.claude/.
    assert.doesNotMatch(out, /@~\/\.claude\//, `codex must not get the claude @~/.claude restoration; got:\n${out}`);
    assert.match(out, /@\$HOME\/\.codex\/gsd-core\/workflows\/stats\.md/, `codex keeps its own rewrite; got:\n${out}`);
  });

  test('row 9 — global Claude @-ref preserves the full tail path', () => {
    // Deeper subpath than row 1 — ensures the @-ref normalization does not
    // truncate the tail. (No `$` anchor: a realistic @-ref line ends with `\n`.)
    const src = '@~/.claude/gsd-core/references/ui-brand.md\n';
    const out = _applyRuntimeRewrites(src, 'claude', globalClaudePrefix, true, undefined);
    assert.match(out, /@~\/\.claude\/gsd-core\/references\/ui-brand\.md/, `tail must be intact; got:\n${out}`);
    assert.doesNotMatch(out, /@\$HOME/, `no @$HOME; got:\n${out}`);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3544: `$HOME` does NOT expand in a Claude Code @-import (measured — see
// .gsd/bug/fix-3544-home-expansion-spec-tree/10-diagnosis.md's ADDENDUM).
// #3133 (above) already fixed this for the SKILL/command staging pipeline
// (_applyRuntimeRewrites's 'claude' case) by restoring @-anchored $HOME
// references to tilde AFTER the blanket $HOME substitution. #3544 found the
// identical defect in bin/install.js's copyWithPathReplacement — the
// gsd-core/ SPEC-TREE emit path — which never had that restore step: every
// `@~/.claude/gsd-core/…` include in a global install's workflows/references
// tree (e.g. gsd-core/workflows/plan-phase.md's own @-includes) silently
// resolved to nothing.
//
// The old test at the top of this file ('$HOME expands inside double-quoted
// shell commands') asserted only the raw computePathPrefix STRING, never
// that an @-reference actually resolves — which is exactly why the spec-tree
// defect survived undetected. That assertion is preserved above (unchanged:
// computePathPrefix's raw $HOME form is CORRECT and must stay — it is what
// keeps double-quoted shell commands working, #1284). What was missing is
// coverage of the @-anchored restore step. This section adds it, plus a
// real spawned-installer proof that the fix reaches the actual emit path
// (not just the pure function), plus negative-proof rows for OpenCode,
// local installs, and a second non-Claude global runtime (Cursor).
// ────────────────────────────────────────────────────────────────────────
describe('#3544: _restoreClaudeGlobalAtRefTilde (spec-tree @-ref restore, unit)', () => {
  const { _restoreClaudeGlobalAtRefTilde } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('restores an @$HOME/.claude/ reference to @~/.claude/ when pathPrefix is the $HOME form', () => {
    const src = '@$HOME/.claude/gsd-core/references/ui-brand.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, '@~/.claude/gsd-core/references/ui-brand.md\n');
  });

  test('leaves a non-@-anchored $HOME/.claude/ shell reference untouched (#1284)', () => {
    const src = 'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" query state\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a double-quoted shell $HOME reference must never be rewritten to ~ (breaks #1284)');
  });

  test('is a no-op when pathPrefix is an absolute (local-install) path', () => {
    const src = '@$HOME/.claude/gsd-core/references/ui-brand.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '/abs/projects/foo/.claude/');
    assert.strictEqual(out, src);
  });

  test('handles multiple @-references and preserves an interleaved shell reference', () => {
    const src =
      '@$HOME/.claude/gsd-core/references/a.md\n' +
      'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n' +
      '@$HOME/.claude/gsd-core/references/b.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(
      out,
      '@~/.claude/gsd-core/references/a.md\n' +
      'node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs"\n' +
      '@~/.claude/gsd-core/references/b.md\n',
    );
  });

  // #3544 review (Finding 1): a custom --config-dir under $HOME produces a
  // pathPrefix like '$HOME/.claude-work/' — the directory name is NOT
  // '.claude'. The restore must derive the tilde form from pathPrefix itself
  // rather than a hardcoded '.claude' literal, or it silently no-ops for any
  // non-default config-dir name (reproducing the exact defect #3544 fixes).
  test('generalizes to a non-default config-dir name (not hardcoded to .claude)', () => {
    const src = '@$HOME/.claude-work/gsd-core/workflows/plan-phase.md\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude-work/');
    assert.strictEqual(out, '@~/.claude-work/gsd-core/workflows/plan-phase.md\n');
  });

  // #3544 review (Finding 2): quote-aware, not line-start-anchored. A
  // double-quoted or single-quoted `@$HOME/...` sequence must be left alone
  // (rewriting $HOME -> ~ inside a quoted shell string reintroduces #1284 —
  // ~ does not expand in double quotes). A bare line-start `@$HOME/...` and a
  // legitimate MID-LINE `@`-reference (Claude Code documents @-references as
  // valid "anywhere in your CLAUDE.md") must both still be rewritten.
  test('leaves a double-quoted @$HOME/.claude/ sequence untouched (quote-aware)', () => {
    const src = 'echo "@$HOME/.claude/x"\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a double-quoted @$HOME sequence must not be rewritten');
  });

  test('leaves a single-quoted @$HOME/.claude/ sequence untouched (quote-aware)', () => {
    const src = "'@$HOME/.claude/x'\n";
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, src, 'a single-quoted @$HOME sequence must not be rewritten');
  });

  test('rewrites a bare line-start @$HOME/.claude/ reference', () => {
    const src = '@$HOME/.claude/x\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  test('rewrites a legitimate mid-line @$HOME/.claude/ reference (not line-start-anchored)', () => {
    const src = 'See @$HOME/.claude/x for details\n';
    const out = _restoreClaudeGlobalAtRefTilde(src, '$HOME/.claude/');
    assert.strictEqual(out, 'See @~/.claude/x for details\n');
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3719 GAP 2: restoreClaudeGlobalAtRefTilde used to build the substitution
// with a STRING passed as the 2nd arg to .replace() — `content.replace(re,
// '@' + tildeEquivalent)`. When tildeEquivalent (derived from an
// operator-controlled --config-dir pathPrefix) contains the literal sequence
// `$&` or `` $` ``, the JS engine treats those as REPLACEMENT PATTERNS, not
// literal text: `$&` re-inserts the whole match (duplicating the matched
// `@$HOME/...` span back into the output) and `` $` `` inserts the substring
// before the match (which is empty at position 0, silently dropping the
// literal text that followed it). Measured pre-fix:
//   prefix "$HOME/.cl$&ude/"  -> "@~/.cl@$HOME/.cl$&ude/ude/x" (corrupted, duplicated)
//   prefix "$HOME/.cl$`ude/"  -> "@~/.clude/x"                 (corrupted, text dropped)
// Fixed by passing a FUNCTION as the 2nd arg (`() => '@' + tildeEquivalent`),
// which the engine never pattern-scans. These pathological prefixes are built
// via string concatenation / String.fromCharCode, not template literals, so an
// editor normalizing a literal backtick-dollar sequence can't silently defang
// the fixture.
// ────────────────────────────────────────────────────────────────────────
describe('#3719 GAP 2: _restoreClaudeGlobalAtRefTilde is immune to $&/$` in pathPrefix', () => {
  const { _restoreClaudeGlobalAtRefTilde } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

  test('a pathPrefix containing a literal "$&" round-trips to the plain tilde form (not duplicated)', () => {
    const dollarAmp = '$' + '&';
    const prefix = '$HOME/.cl' + dollarAmp + 'ude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.cl' + dollarAmp + 'ude/x',
      'a literal $& in pathPrefix must not re-insert the whole match into the output');
  });

  test('a pathPrefix containing a literal "$`" (backtick-dollar) round-trips to the plain tilde form (not dropped)', () => {
    const dollarBacktick = '$' + String.fromCharCode(96);
    const prefix = '$HOME/.cl' + dollarBacktick + 'ude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.cl' + dollarBacktick + 'ude/x',
      'a literal $` in pathPrefix must not be treated as a "text before match" replacement pattern');
  });

  test('an ordinary pathPrefix (no special replacement chars) is unaffected by the function-replacement fix', () => {
    const prefix = '$HOME/.claude/';
    const src = '@' + prefix + 'x';
    const out = _restoreClaudeGlobalAtRefTilde(src, prefix);
    assert.strictEqual(out, '@~/.claude/x');
  });
});

// Verification boundary (#3544): this suite proves the emitted @-line takes
// the `~` STRING form Claude Code documents as expanding. It cannot prove
// the host actually resolves it — no automated test can spawn a live Claude
// Code session and read `/context` in CI. Read a green run here as "the
// installer emits the documented form", not as "the include loads". See
// restoreClaudeGlobalAtRefTilde's doc comment (runtime-artifact-conversion.cts)
// for the controlled measurement that established the documented form is the
// one that actually resolves.
describe('#3544: spawned installer — gsd-core/ spec tree @-refs resolve on tilde', () => {
  const { before, after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

  const sandboxes = [];
  function makeSandbox(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-3544-${prefix}-`));
    sandboxes.push(dir);
    return dir;
  }

  // No --config-dir: install.js must resolve the DEFAULT <HOME>/.claude (or
  // runtime equivalent) under the sandboxed HOME, so the emitted tree has the
  // real `~/.claude/gsd-core/…` shape the diagnosis measured — a --config-dir
  // run pins configDir to the sandbox root itself (target === home), which
  // never reproduces that layout.
  function spawnInstall(args, home) {
    return runNode([INSTALL_SCRIPT, ...args], {
      cwd: home,
      env: installerEnv({ HOME: home, USERPROFILE: home }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  }

  function collectAtLines(rootDir) {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(rootDir, full);
        const topLevel = rel.split(path.sep)[0];
        // The durable Runtime Surface corpus is intentionally raw canonical
        // input, not an emitted/runtime-rewritten spec tree. Its paths are
        // validated when staged, so exclude only these two known corpus roots
        // from this legacy emitted-content oracle.
        if (topLevel === 'commands' || topLevel === 'agents') continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          if (isChangelogCopy(full, content)) continue;
          for (const line of splitLines(content)) {
            if (line.startsWith('@')) out.push({ file: full, line });
          }
        }
      }
    };
    if (fs.existsSync(rootDir)) walk(rootDir);
    return out;
  }

  let claudeGlobalHome, claudeLocalHome, opencodeGlobalHome, cursorGlobalHome, claudeConfigDirHome, claudeConfigDirTarget;

  before(() => {
    claudeGlobalHome = makeSandbox('claude-global');
    const g = spawnInstall(['--claude', '--global'], claudeGlobalHome);
    assert.strictEqual(g.exitCode, 0, `claude --global install failed:\n${g.stdout}\n${g.stderr}`);

    claudeLocalHome = makeSandbox('claude-local');
    const l = spawnInstall(['--claude', '--local'], claudeLocalHome);
    assert.strictEqual(l.exitCode, 0, `claude --local install failed:\n${l.stdout}\n${l.stderr}`);

    opencodeGlobalHome = makeSandbox('opencode-global');
    const o = spawnInstall(['--opencode', '--global'], opencodeGlobalHome);
    assert.strictEqual(o.exitCode, 0, `opencode --global install failed:\n${o.stdout}\n${o.stderr}`);

    cursorGlobalHome = makeSandbox('cursor-global');
    const c = spawnInstall(['--cursor', '--global'], cursorGlobalHome);
    assert.strictEqual(c.exitCode, 0, `cursor --global install failed:\n${c.stdout}\n${c.stderr}`);

    // #3544 review (Finding 1): a custom --config-dir name under $HOME
    // (i.e. NOT the default .claude) — the target must be a subdirectory of
    // HOME (not HOME itself) so computePathPrefix takes the $HOME-shorthand
    // branch with a non-'.claude' suffix, the exact precondition the
    // hardcoded-'.claude' bug required.
    claudeConfigDirHome = makeSandbox('claude-config-dir-home');
    claudeConfigDirTarget = path.join(claudeConfigDirHome, '.claude-work');
    const cd = spawnInstall(['--claude', '--global', '--config-dir', claudeConfigDirTarget], claudeConfigDirHome);
    assert.strictEqual(cd.exitCode, 0, `claude --global --config-dir install failed:\n${cd.stdout}\n${cd.stderr}`);
  });

  after(() => {
    for (const dir of sandboxes) cleanup(dir);
  });

  test('claude --global: gsd-core/workflows/plan-phase.md @-lines use ~/, never @$HOME', () => {
    const planPhase = path.join(claudeGlobalHome, '.claude', 'gsd-core', 'workflows', 'plan-phase.md');
    assert.ok(fs.existsSync(planPhase), `expected ${planPhase} to exist`);
    const content = fs.readFileSync(planPhase, 'utf8');
    const atLines = splitLines(content).filter((l) => l.startsWith('@'));
    assert.ok(atLines.length > 0, 'expected plan-phase.md to carry at least one @-line');
    for (const line of atLines) {
      assert.ok(!/^@\$HOME/.test(line), `plan-phase.md @-line must not use @$HOME: ${line}`);
    }
    assert.ok(
      atLines.some((l) => l.startsWith('@~/')),
      `expected at least one @~/ line, got: ${JSON.stringify(atLines)}`,
    );
  });

  test('claude --global: zero ^@$HOME lines remain anywhere under the emitted gsd-core/ tree', () => {
    const gsdCoreDir = path.join(claudeGlobalHome, '.claude', 'gsd-core');
    const homeLines = collectAtLines(gsdCoreDir).filter(({ line }) => /^@\$HOME/.test(line));
    assert.deepStrictEqual(homeLines, [], `found @$HOME lines: ${JSON.stringify(homeLines)}`);
  });

  // #3544 review (Finding 1): a real install under a non-default --config-dir
  // name reproduces the exact defect #3544 fixes if the restore is hardcoded
  // to '.claude/'. This must FAIL against the pre-fix restoreClaudeGlobalAtRefTilde.
  test('claude --global --config-dir <custom>: zero @$HOME lines remain, and @~/<custom>/ appears', () => {
    const gsdCoreDir = path.join(claudeConfigDirTarget, 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const homeLines = collectAtLines(gsdCoreDir).filter(({ line }) => /^@\$HOME/.test(line));
    assert.deepStrictEqual(homeLines, [], `found @$HOME lines under a custom --config-dir: ${JSON.stringify(homeLines)}`);
    const tildeLines = collectAtLines(gsdCoreDir).filter(({ line }) => line.startsWith('@~/.claude-work/'));
    assert.ok(
      tildeLines.length > 0,
      `expected at least one @~/.claude-work/ line under a custom --config-dir, got: ${JSON.stringify(collectAtLines(gsdCoreDir))}`,
    );
  });

  test('claude --global: double-quoted shell $HOME references are preserved (#1284)', () => {
    // At least one emitted file must still carry a double-quoted
    // "$HOME/.claude/" shell reference — proving the restore step did NOT
    // blanket-convert every $HOME occurrence, only @-anchored ones.
    const gsdCoreDir = path.join(claudeGlobalHome, '.claude', 'gsd-core');
    let sawShellHome = false;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md') && fs.readFileSync(full, 'utf8').includes('"$HOME/.claude/')) {
          sawShellHome = true;
        }
      }
    };
    walk(gsdCoreDir);
    assert.ok(sawShellHome, 'expected at least one emitted file to preserve a "$HOME/.claude/ shell reference');
  });

  test('claude --local: pathPrefix is absolute — no @$HOME or bare @~ leak (negative proof)', () => {
    const gsdCoreDir = path.join(claudeLocalHome, '.claude', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const badLines = collectAtLines(gsdCoreDir).filter(
      ({ line }) => /^@\$HOME/.test(line) || /^@~\//.test(line),
    );
    assert.deepStrictEqual(badLines, [], `local install must not emit @$HOME or @~/: ${JSON.stringify(badLines)}`);
  });

  test('opencode --global: unaffected — never emits an @~/.claude/ line (negative proof)', () => {
    const gsdCoreDir = path.join(opencodeGlobalHome, '.config', 'opencode', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const leaked = collectAtLines(gsdCoreDir).filter(({ line }) => line.startsWith('@~/.claude/'));
    assert.deepStrictEqual(
      leaked, [],
      `opencode must never emit a @~/.claude/ line (claude-only restore leaked): ${JSON.stringify(leaked)}`,
    );
  });

  test('cursor --global: unaffected — still emits @$HOME/.cursor/ (unrestored), never @~/.claude/ (negative proof)', () => {
    const gsdCoreDir = path.join(cursorGlobalHome, '.cursor', 'gsd-core');
    assert.ok(fs.existsSync(gsdCoreDir), `expected ${gsdCoreDir} to exist`);
    const atLines = collectAtLines(gsdCoreDir);
    const leaked = atLines.filter(({ line }) => line.startsWith('@~/.claude/'));
    assert.deepStrictEqual(
      leaked, [],
      `cursor must never emit a @~/.claude/ line (claude-only restore leaked): ${JSON.stringify(leaked)}`,
    );
    assert.ok(
      atLines.some(({ line }) => line.startsWith('@$HOME/.cursor/')),
      `expected cursor's own $HOME-form @-refs to remain unrestored, got: ${JSON.stringify(atLines)}`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// #3719: applyAgentPathRewrites (the agents/ staging pipeline's pre-converter
// path-rewrite step, install-profiles.cts:964) does the 4 base ~/.claude/ and
// $HOME/.claude/ substitutions but NEVER calls restoreClaudeGlobalAtRefTilde
// — the SAME restore #3133 wired into `_applyRuntimeRewrites`'s 'claude' case
// and #3544 wired into the gsd-core/ spec-tree emit path. Consequence: every
// `agents/gsd-*.md` `@`-include (mandatory-initial-read.md, the
// untrusted-input boundary, the agent-skills bootstrap, etc.) ships as
// `@$HOME/.claude/...` in a global Claude install, which Claude Code does not
// expand — the include silently loads nothing. Unlike #3133/#3544, this is a
// MISSING call, not a wrong regex; fixing it must not touch the ordinary
// $HOME/.claude/ substitutions non-@-anchored text still needs (#1284).
// ────────────────────────────────────────────────────────────────────────
describe('#3719: applyAgentPathRewrites must restore @-anchored $HOME refs to tilde', () => {
  const { applyAgentPathRewrites } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const globalHomePrefix = '$HOME/.claude/';

  test('row 1 [RED] — an @-include through the agents path emits @~/… not @$HOME/…', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/gsd-core/references/mandatory-initial-read.md\n');
  });

  // #3719 review (MINOR 3): the original control string contained no `@` at
  // all, so `restoreClaudeGlobalAtRefTilde`'s `atRefRe` (which only matches
  // an `@`-anchored sequence) could never match it — the row passed even
  // with the quote-lookbehind deleted entirely, proving nothing about
  // quote-awareness. A real control needs an `@`-anchored $HOME reference
  // INSIDE quotes: `~` does not expand inside double-quoted shell strings
  // (#1284), so a quoted `@~/.claude/x` must stay on `@$HOME/.claude/x`
  // after the restore pass, not be rewritten back to `@~/`. Confirmed this
  // row fails (asserts the wrong string) if the lookbehind
  // `(?<!["'])` is deleted from `restoreClaudeGlobalAtRefTilde`'s `atRefRe` —
  // without it the quoted `@$HOME/.claude/x` matches unconditionally and is
  // rewritten to `@~/.claude/x`, breaking the assertion below.
  test('row 2 [CONTROL] — a quoted @-reference stays on $HOME (quote-aware, #1284)', () => {
    const src = 'echo "@~/.claude/x"\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'echo "@$HOME/.claude/x"\n');
  });

  test('row 7 [CONTROL] — a noPathRewrite runtime (copilot) is untouched', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'copilot', globalHomePrefix);
    assert.strictEqual(out, src, 'noPathRewrite runtimes must be returned unchanged (no substitutions at all)');
  });

  // #3719 review (MINOR 2): row 7 (copilot) returns early at the
  // `noPathRewrite` check and never reaches the `if (runtime === 'claude')`
  // restore guard at all — zero coverage of the guard itself. Cursor and
  // Kilo are NOT noPathRewrite, so they exercise the base `.claude/` ->
  // pathPrefix substitution AND then hit the guard, which must suppress the
  // `@~` restore because they are not `claude`.
  test('row 10 [CONTROL] — cursor (non-claude, non-noPathRewrite) keeps @$HOME/.cursor/…, does not restore to tilde', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'cursor', '$HOME/.cursor/');
    assert.strictEqual(out, '@$HOME/.cursor/gsd-core/references/mandatory-initial-read.md\n',
      'cursor must keep the @$HOME/.cursor/ form — the runtime guard must suppress the claude-only tilde restore');
  });

  test('row 11 [CONTROL] — kilo (non-claude, non-noPathRewrite) keeps @$HOME/.kilo/…, does not restore to tilde', () => {
    const src = '@~/.claude/gsd-core/references/mandatory-initial-read.md\n';
    const out = applyAgentPathRewrites(src, 'kilo', '$HOME/.kilo/');
    assert.strictEqual(out, '@$HOME/.kilo/gsd-core/references/mandatory-initial-read.md\n',
      'kilo must keep the @$HOME/.kilo/ form — the runtime guard must suppress the claude-only tilde restore');
  });

  // ── boundary rows ──
  test('boundary — leading @~/.claude/x @-include', () => {
    const src = '@~/.claude/x\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  test('boundary — mid-sentence @~/.claude/x @-include', () => {
    const src = 'See @~/.claude/x for details\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'See @~/.claude/x for details\n');
  });

  test('boundary — ~/.claude/x with NO @ prefix must stay on $HOME (not an @-include)', () => {
    const src = 'See ~/.claude/x for details\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, 'See $HOME/.claude/x for details\n');
  });

  test('boundary — @~/.claude with no trailing slash (word-boundary variant)', () => {
    const src = '@~/.claude\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude\n');
  });

  test('boundary — @$HOME/.claude/x already present in source is restored, not double-rewritten', () => {
    const src = '@$HOME/.claude/x\n';
    const out = applyAgentPathRewrites(src, 'claude', globalHomePrefix);
    assert.strictEqual(out, '@~/.claude/x\n');
  });

  // #3719 GAP 1: `-work-work` doubling guard. The MAJOR fix changed the two
  // `~/.claude` / `$HOME/.claude` replaces in this function from a bare `\b`
  // to `(?![\w-])`, because `\b` is satisfied by ANY non-word character —
  // including '-'. For a --config-dir whose name EXTENDS '.claude' (e.g.
  // '.claude-work'), the bare-`\b` regex re-matched the '.claude' PREFIX of
  // the already-substituted '.claude-work' path and corrupted it to
  // '.claude-work-work'. Security measured 120 doubled paths before the fix
  // and 0 after. Nothing else in this file installs under a config dir that
  // extends '.claude', so without this block the fix ships unpinned.
  describe('-work-work doubling guard (#3719 MAJOR: \\b -> (?![\\w-]))', () => {
    const extendedPrefix = '$HOME/.claude-work/';

    test('@-include: @~/.claude/x.md -> @~/.claude-work/x.md (not .claude-work-work)', () => {
      const src = '@~/.claude/x.md';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, '@~/.claude-work/x.md');
    });

    test('no-trailing-slash variant: @~/.claude -> @~/.claude-work', () => {
      const src = '@~/.claude';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, '@~/.claude-work');
    });

    test('prose (non-@-anchored): See ~/.claude/p.md -> See $HOME/.claude-work/p.md', () => {
      const src = 'See ~/.claude/p.md';
      const out = applyAgentPathRewrites(src, 'claude', extendedPrefix);
      assert.strictEqual(out, 'See $HOME/.claude-work/p.md');
    });

    // Different extension character class (word char 'x' immediately after
    // '.claude', vs. '-' above) — confirms the lookahead's `[\w-]` class
    // covers both.
    test('.claudex prefix (word-char extension): @~/.claude/x.md -> @~/.claudex/x.md', () => {
      const src = '@~/.claude/x.md';
      const out = applyAgentPathRewrites(src, 'claude', '$HOME/.claudex/');
      assert.strictEqual(out, '@~/.claudex/x.md');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// #5501: the skill/command pipeline (`_applyRuntimeRewrites`, Claude's
// 'slash-tilde-restore' profile) rewrote only the slash forms `~/.claude/`
// and `$HOME/.claude/`. The runtime launcher's shell default
// `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` has no trailing slash, so it survived
// verbatim and a `--config-dir` install kept probing `~/.claude/gsd-core` —
// gsd-discuss-phase and gsd-surface failed with "gsd-tools.cjs not found".
// The gsd-core/ spec-tree copy already handled the bare form (#3544); this
// pins the same behaviour for staged skills and commands.
// ────────────────────────────────────────────────────────────────────────
describe('#5501: Claude skill/command bodies rewrite the bare ~/.claude and $HOME/.claude forms', () => {
  const { _applyRuntimeRewrites } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const launcherDefault = '_gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}"; }\n';

  test('the launcher default follows a custom $HOME-form config dir', () => {
    const out = _applyRuntimeRewrites(launcherDefault, 'claude', '$HOME/.claude-work/', true, undefined);
    assert.strictEqual(out, '_gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude-work}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}"; }\n');
  });

  test('the launcher default follows an absolute config dir', () => {
    const out = _applyRuntimeRewrites(launcherDefault, 'claude', '/opt/gsd/cfg/', true, undefined);
    assert.strictEqual(out, '_gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-/opt/gsd/cfg}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}"; }\n');
  });

  test('a .claude-work prefix is not doubled to .claude-work-work', () => {
    const src = 'cat ~/.claude/gsd-core/VERSION; ls $HOME/.claude; echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\n';
    const out = _applyRuntimeRewrites(src, 'claude', '$HOME/.claude-work/', true, undefined);
    assert.strictEqual(out, 'cat $HOME/.claude-work/gsd-core/VERSION; ls $HOME/.claude-work; echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude-work}"\n');
  });

  test('.claude-plugin and .claudeignore are left alone', () => {
    const src = 'see ~/.claude-plugin/plugin.json and $HOME/.claudeignore\n';
    const out = _applyRuntimeRewrites(src, 'claude', '$HOME/.claude-work/', true, undefined);
    assert.strictEqual(out, src);
  });

  test('@-references, slash and bare, are still restored to the tilde form', () => {
    const src = '@~/.claude/gsd-core/workflows/stats.md\n@~/.claude\n';
    assert.strictEqual(
      _applyRuntimeRewrites(src, 'claude', '$HOME/.claude-work/', true, undefined),
      '@~/.claude-work/gsd-core/workflows/stats.md\n@~/.claude-work\n',
    );
    assert.strictEqual(_applyRuntimeRewrites(src, 'claude', '$HOME/.claude/', true, undefined), src);
  });

  test('a project-relative prefix keeps the launcher default absolute (#4377)', () => {
    const out = _applyRuntimeRewrites(launcherDefault, 'claude', '.claude/', false, undefined);
    assert.strictEqual(out, launcherDefault);
  });

  test('the default ~/.claude install keeps the launcher default as written', () => {
    const out = _applyRuntimeRewrites(launcherDefault, 'claude', '$HOME/.claude/', true, undefined);
    assert.strictEqual(out, launcherDefault);
  });

  // #5501 review (F1): the slash pass used to emit the prefix and the bare pass then
  // re-matched the `.claude` inside it, so a config dir nested under `~/.claude`
  // (or one named `.claude.d`) was rewritten again. One pass rewrites each source
  // occurrence exactly once.
  test('a config dir nested under ~/.claude is not re-matched', () => {
    const src = 'cat ~/.claude/gsd-core/x; echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\n';
    const out = _applyRuntimeRewrites(src, 'claude', '$HOME/.claude/profiles/work/', true, undefined);
    assert.strictEqual(
      out,
      'cat $HOME/.claude/profiles/work/gsd-core/x; echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude/profiles/work}"\n',
    );
  });

  test('a config dir whose name starts .claude. is not re-matched', () => {
    const out = _applyRuntimeRewrites('cat ~/.claude/gsd-core/x\n', 'claude', '$HOME/.claude.d/', true, undefined);
    assert.strictEqual(out, 'cat $HOME/.claude.d/gsd-core/x\n');
  });

  // #5501 review (F6): a string replacement interprets `$&`; the prefix is emitted verbatim.
  test('a config dir containing $& is emitted verbatim', () => {
    const out = _applyRuntimeRewrites('ls ~/.claude ~/.claude/x\n', 'claude', '$HOME/.cl$&ude/', true, undefined);
    assert.strictEqual(out, 'ls $HOME/.cl$&ude $HOME/.cl$&ude/x\n');
  });

  test('.claude.json and .claude.d style names keep their bytes', () => {
    const src = 'read ~/.claude.json and $HOME/.claude.d/x\n';
    assert.strictEqual(_applyRuntimeRewrites(src, 'claude', '$HOME/.claude-work/', true, undefined), src);
  });

  // #5501 review (F7): handing the restore the normalized prefix must not turn a
  // look-alike @-ref on a default install into the tilde form.
  test('bare prose keeps its bytes on a default install', () => {
    const src = 'see ~/.claude and $HOME/.claude for details\n';
    assert.strictEqual(_applyRuntimeRewrites(src, 'claude', '$HOME/.claude/', true, undefined), src);
  });

  test('a look-alike @-ref keeps its bytes on a default install', () => {
    const src = '@$HOME/.claude-plugin/x\n@$HOME/.claudeignore\n';
    assert.strictEqual(_applyRuntimeRewrites(src, 'claude', '$HOME/.claude/', true, undefined), src);
  });

  test('property: each home form is rewritten once and everything else keeps its bytes', () => {
    const fc = require('fast-check');
    const PREFIXES = [
      '$HOME/.claude-work/', '$HOME/.claude/profiles/work/', '$HOME/.claude.d/',
      '/opt/gsd/cfg/', '$HOME/.cl$&ude/', '$HOME/.claude/',
    ];
    // [source token, expected output given (prefix, prefix without trailing slash)]
    const TOKENS = [
      ['~/.claude/gsd-core/x', (p) => `${p}gsd-core/x`],
      ['$HOME/.claude/gsd-core/x', (p) => `${p}gsd-core/x`],
      // a default install keeps the bare spelling it was written with
      ['~/.claude', (_p, n) => (n === '$HOME/.claude' ? '~/.claude' : n)],
      ['$HOME/.claude', (_p, n) => n],
      ['~/.claude-plugin/x', () => '~/.claude-plugin/x'],
      ['$HOME/.claudeignore', () => '$HOME/.claudeignore'],
      ['~/.claude.json', () => '~/.claude.json'],
      ['plain text', () => 'plain text'],
    ];
    fc.assert(fc.property(
      fc.constantFrom(...PREFIXES),
      fc.array(fc.integer({ min: 0, max: TOKENS.length - 1 }), { minLength: 1, maxLength: 12 }),
      (prefix, picks) => {
        const normalized = prefix.replace(/\/$/, '');
        const src = picks.map((i) => TOKENS[i][0]).join('\n');
        const expected = picks.map((i) => TOKENS[i][1](prefix, normalized)).join('\n');
        assert.strictEqual(_applyRuntimeRewrites(src, 'claude', prefix, true, undefined), expected);
      },
    ), { seed: 5501, numRuns: 100 });
  });
});

describe('#5501: spawned installer — --config-dir skills find gsd-tools under the install path', () => {
  const { before, after } = require('node:test');
  const { spawnSync } = require('child_process');
  const { cleanup } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

  let home, configDir, runCwd;

  function stagedBodies() {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) out.push({ file: full, content: fs.readFileSync(full, 'utf8') });
      }
    };
    for (const sub of ['skills', 'commands']) {
      const dir = path.join(configDir, sub);
      if (fs.existsSync(dir)) walk(dir);
    }
    return out;
  }

  before(() => {
    // The config dir sits under HOME with a name that EXTENDS '.claude', so
    // the prefix is '$HOME/.claude-work/' — the shape that exposes both the
    // missed bare default and any '.claude-work-work' doubling.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5501-home-'));
    configDir = path.join(home, '.claude-work');
    runCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5501-cwd-'));
    const r = runNode([INSTALL_SCRIPT, '--claude', '--global', '--config-dir', configDir, '--minimal'], {
      cwd: home,
      env: installerEnv({ HOME: home, USERPROFILE: home }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(r.exitCode, 0, `claude --global --config-dir install failed:\n${r.stdout}\n${r.stderr}`);
  });

  after(() => {
    cleanup(home);
    cleanup(runCwd);
  });

  test('no staged skill or command body keeps the ${CLAUDE_CONFIG_DIR:-$HOME/.claude} default', () => {
    const bodies = stagedBodies();
    assert.ok(bodies.some(({ file }) => file.includes('gsd-discuss-phase')), 'expected gsd-discuss-phase to be staged');
    const stale = bodies.filter(({ content }) => content.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude}')).map(({ file }) => file);
    assert.deepStrictEqual(stale, []);
  });

  test('staged bodies use .claude-work paths, never .claude-work-work', () => {
    const bodies = stagedBodies();
    const doubled = bodies.filter(({ content }) => content.includes('.claude-work-work')).map(({ file }) => file);
    assert.deepStrictEqual(doubled, []);
    assert.ok(
      bodies.some(({ content }) => content.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude-work}')),
      'expected the launcher default to point at $HOME/.claude-work',
    );
  });

  test('the staged discuss-phase launcher resolves gsd-tools under <config-dir>/gsd-core', { skip: process.platform === 'win32' && 'POSIX shell launcher' }, () => {
    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-discuss-phase', 'SKILL.md'), 'utf8');
    const launcher = splitLines(skill).find((line) => line.startsWith('_GSD_SHIM_NAME='));
    assert.ok(launcher, 'expected the runtime launcher line in gsd-discuss-phase');
    // A minimal env: no CLAUDE_CONFIG_DIR or other runtime homes, cwd outside
    // any project, so only the install-path default can find gsd-tools.
    const r = spawnSync('bash', ['-c', `${launcher}\nprintf '%s' "$GSD_TOOLS"`], {
      cwd: runCwd,
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    assert.strictEqual(r.status, 0, `launcher failed:\n${r.stdout}\n${r.stderr}`);
    assert.strictEqual(r.stdout, path.join(configDir, 'gsd-core', 'bin', 'gsd-tools.cjs'));
  });
});

// ────────────────────────────────────────────────────────────────────────
// #5715: the per-profile rewrites, the agents pipeline and the spec-tree copy
// ran sequential `.replace()` passes, so a later pass re-scanned the prefix an
// earlier pass had just emitted (nested / `.claude.`-named config dirs repeated
// the prefix) and string replacement values expanded `$&`. One pass, literal
// replacement, each source occurrence rewritten exactly once.
// ────────────────────────────────────────────────────────────────────────
describe('#5715: config-dir rewrites are single-pass and literal', () => {
  const fc = require('fast-check');
  const conv = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const { _applyRuntimeRewrites, applyAgentPathRewrites } = conv;
  const installJs = require('../bin/install.js');

  // Profiles that rewrite the bare `~/.claude` / `$HOME/.claude` forms to the prefix.
  const BARE_IDS = ['cline', 'codebuddy', 'cursor', 'augment', 'windsurf', 'trae', 'kimi', 'pi'];
  // Branded profiles rewrite the slash forms only (bare stays); codex is slash-only.
  const SLASH_IDS = ['codex', 'hermes', 'qwen'];
  const ALL_IDS = [...BARE_IDS, ...SLASH_IDS];
  const SLASH_SRC = ['A ~/.claude/x', 'B $HOME/.claude/y'].join('\n');
  const BARE_SRC = ['A ~/.claude/x', 'B ~/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude'].join('\n');
  const occurrences = (s, sub) => s.split(sub).length - 1;
  const bareOf = (prefix) => prefix.replace(/\/$/, '');
  const expectedBare = (prefix) =>
    ['A ' + prefix + 'x', 'B ' + bareOf(prefix), 'C ' + prefix + 'y', 'D ' + bareOf(prefix)].join('\n');
  const expectedSlash = (prefix) => ['A ' + prefix + 'x', 'B ' + prefix + 'y'].join('\n');

  test('#5715: nested config dir rewritten once per profile (exact output)', () => {
    const prefix = '$HOME/.claude/profiles/work/';
    for (const id of ALL_IDS) {
      assert.strictEqual(_applyRuntimeRewrites(SLASH_SRC, id, prefix, true, undefined), expectedSlash(prefix), id);
    }
  });

  describe('branded profiles (qwen, hermes)', () => {
    const src = ['A ~/.claude/x', 'B $HOME/.claude', 'C ./.claude/z', 'D .claude/skills/q', 'E a/.claude/b'].join('\n');
    const expectedBranded = (id, prefix) =>
      ['A ' + prefix + 'x', 'B ' + bareOf(prefix), `C ./.${id}/z`, `D .${id}/skills/q`, `E a/.${id}/b`].join('\n');
    for (const id of ['qwen', 'hermes']) {
      test(`#5715: ${id} nested prefix is emitted once and never re-branded`, () => {
        const prefix = '$HOME/.claude/profiles/work/';
        assert.strictEqual(_applyRuntimeRewrites(src, id, prefix, true, undefined), expectedBranded(id, prefix));
      });

      test(`#5715: ${id} default prefix output`, () => {
        const prefix = `$HOME/.${id}/`;
        assert.strictEqual(_applyRuntimeRewrites(src, id, prefix, true, undefined), expectedBranded(id, prefix));
      });

      test(`#5715: ${id} absolute prefix containing .claude/ is emitted once`, () => {
        const prefix = '/opt/proj/.claude/home/';
        assert.strictEqual(_applyRuntimeRewrites(src, id, prefix, true, undefined), expectedBranded(id, prefix));
      });
    }
  });

  test('#5715: bare form nested rewritten once', () => {
    const prefix = '$HOME/.claude/profiles/work/';
    for (const id of BARE_IDS) {
      const out = _applyRuntimeRewrites(BARE_SRC, id, prefix, true, undefined);
      assert.strictEqual(out, expectedBare(prefix), id);
      assert.strictEqual(occurrences(out, '$HOME/.claude/profiles/work'), 4, id);
    }
  });

  test('#5715: .claude.-named config dir not re-matched', () => {
    const prefix = '$HOME/.claude.d/';
    for (const id of BARE_IDS) {
      assert.strictEqual(_applyRuntimeRewrites(BARE_SRC, id, prefix, true, undefined), expectedBare(prefix), id);
    }
    for (const id of SLASH_IDS) {
      const out = _applyRuntimeRewrites(SLASH_SRC, id, prefix, true, undefined);
      assert.ok(!out.includes('.d.d'), `${id}: ${JSON.stringify(out)}`);
    }
    assert.strictEqual(_applyRuntimeRewrites(SLASH_SRC, 'codex', prefix, true, undefined), expectedSlash(prefix));
  });

  test('#5715: replacement is literal', () => {
    for (const prefix of ['$HOME/.cl$&ude/', '$HOME/.a$`b/', "$HOME/.a$'b/"]) {
      for (const id of BARE_IDS) {
        assert.strictEqual(_applyRuntimeRewrites(BARE_SRC, id, prefix, true, undefined), expectedBare(prefix), `${id} ${prefix}`);
      }
      assert.strictEqual(_applyRuntimeRewrites(SLASH_SRC, 'codex', prefix, true, undefined), expectedSlash(prefix), `codex ${prefix}`);
    }
  });

  test('#5715: agents pipeline single-pass', () => {
    const src = ['A ~/.claude/x', 'C $HOME/.claude/y'].join('\n');
    for (const prefix of ['$HOME/.claude/profiles/work/', '$HOME/.claude.d/', '$HOME/.cl$&ude/']) {
      assert.strictEqual(
        applyAgentPathRewrites(src, 'claude', prefix),
        ['A ' + prefix + 'x', 'C ' + prefix + 'y'].join('\n'),
        prefix,
      );
    }
  });

  describe('spec-tree copy (copyWithPathReplacement)', () => {
    const copied = (prefix, src) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-'));
      try {
        const from = path.join(root, 'from');
        const to = path.join(root, 'to');
        fs.mkdirSync(from);
        fs.writeFileSync(path.join(from, 'a.md'), src);
        installJs.copyWithPathReplacement(from, to, prefix, 'claude', false, true, root);
        return fs.readFileSync(path.join(to, 'a.md'), 'utf8');
      } finally {
        require('./helpers.cjs').cleanup(root);
      }
    };
    const src = ['A ~/.claude/x', 'C $HOME/.claude/y'].join('\n');

    test('#5715: spec-tree copy single-pass', () => {
      for (const prefix of ['$HOME/.claude/profiles/work/', '$HOME/.claude.d/', '$HOME/.cl$&ude/']) {
        assert.strictEqual(copied(prefix, src), ['A ' + prefix + 'x', 'C ' + prefix + 'y'].join('\n'), prefix);
      }
    });

    test('#5715: surfaces agree', () => {
      for (const prefix of ['$HOME/.claude/profiles/work/', '$HOME/.claude.d/', '$HOME/.cl$&ude/', '$HOME/.claude/']) {
        const skill = _applyRuntimeRewrites(src, 'claude', prefix, true, undefined);
        assert.strictEqual(applyAgentPathRewrites(src, 'claude', prefix), skill, `agents ${prefix}`);
        assert.strictEqual(copied(prefix, src), skill, `spec-tree ${prefix}`);
      }
    });
  });

  test('#5715: own dot-dir prefix not rescanned', () => {
    const cursor = _applyRuntimeRewrites('A ~/.cursor/x', 'cursor', '$HOME/.cursor/sub/', true, undefined);
    assert.strictEqual(cursor, 'A $HOME/.cursor/sub/x');
    const hermes = _applyRuntimeRewrites('A ~/.hermes/x', 'hermes', '$HOME/.hermes/sub/', true, undefined);
    assert.strictEqual(hermes, 'A $HOME/.hermes/sub/x');
    const qwen = _applyRuntimeRewrites('A ~/.qwen/x', 'qwen', '$HOME/.qwen/sub/', true, undefined);
    assert.strictEqual(qwen, 'A $HOME/.qwen/sub/x');
  });

  test('#5715: default installs byte-identical', () => {
    const src = ['A ~/.claude/x', 'B ~/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.claude/z'].join('\n');
    const golden = {
      codex: ['A $HOME/.claude/x', 'B ~/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.codex/z'],
      cline: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.cline/z'],
      codebuddy: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.codebuddy/z'],
      cursor: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.cursor/z'],
      augment: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.augment/z'],
      windsurf: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.windsurf/z'],
      trae: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.trae/z'],
      kimi: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.kimi-code/z'],
      pi: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.pi/z'],
      hermes: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.hermes/z'],
      qwen: ['A $HOME/.claude/x', 'B $HOME/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.qwen/z'],
      claude: ['A $HOME/.claude/x', 'B ~/.claude', 'C $HOME/.claude/y', 'D $HOME/.claude', 'E ./.claude/z'],
    };
    for (const [id, lines] of Object.entries(golden)) {
      assert.strictEqual(_applyRuntimeRewrites(src, id, '$HOME/.claude/', true, undefined), lines.join('\n'), id);
    }
    const own = {
      codex: ['A $HOME/.codex/x', 'B ~/.claude', 'C $HOME/.codex/y', 'D $HOME/.claude', 'E ./.codex/z'],
      cline: ['A $HOME/.cline/x', 'B $HOME/.cline', 'C $HOME/.cline/y', 'D $HOME/.cline', 'E ./.cline/z'],
      codebuddy: ['A $HOME/.codebuddy/x', 'B $HOME/.codebuddy', 'C $HOME/.codebuddy/y', 'D $HOME/.codebuddy', 'E ./.codebuddy/z'],
      cursor: ['A $HOME/.cursor/x', 'B $HOME/.cursor', 'C $HOME/.cursor/y', 'D $HOME/.cursor', 'E ./.cursor/z'],
      augment: ['A $HOME/.augment/x', 'B $HOME/.augment', 'C $HOME/.augment/y', 'D $HOME/.augment', 'E ./.augment/z'],
      windsurf: ['A $HOME/.windsurf/x', 'B $HOME/.windsurf', 'C $HOME/.windsurf/y', 'D $HOME/.windsurf', 'E ./.windsurf/z'],
      trae: ['A $HOME/.trae/x', 'B $HOME/.trae', 'C $HOME/.trae/y', 'D $HOME/.trae', 'E ./.trae/z'],
      kimi: ['A $HOME/.kimi/x', 'B $HOME/.kimi', 'C $HOME/.kimi/y', 'D $HOME/.kimi', 'E ./.kimi-code/z'],
      pi: ['A $HOME/.pi/x', 'B $HOME/.pi', 'C $HOME/.pi/y', 'D $HOME/.pi', 'E ./.pi/z'],
      hermes: ['A $HOME/.hermes/x', 'B $HOME/.hermes', 'C $HOME/.hermes/y', 'D $HOME/.hermes', 'E ./.hermes/z'],
      qwen: ['A $HOME/.qwen/x', 'B $HOME/.qwen', 'C $HOME/.qwen/y', 'D $HOME/.qwen', 'E ./.qwen/z'],
    };
    for (const [id, lines] of Object.entries(own)) {
      const prefix = `$HOME/.${id}/`;
      assert.strictEqual(_applyRuntimeRewrites(src, id, prefix, true, undefined), lines.join('\n'), `${id} own default`);
    }
  });

  // Reference model: the output for ANY prefix equals the output for a placeholder
  // prefix that contains no source form, with the placeholder replaced literally.
  // A prefix can only differ from the model if a rewrite pass re-scanned it.
  const PLACEHOLDER = '$HOME/.zzplaceholder/';
  const modelOf = (id, source, prefix) =>
    _applyRuntimeRewrites(source, id, PLACEHOLDER, true, undefined)
      .split(PLACEHOLDER)
      .join(prefix)
      .split(bareOf(PLACEHOLDER))
      .join(bareOf(prefix));
  const PROFILE_IDS = ['codex', 'cline', 'cursor', 'windsurf', 'augment', 'trae', 'codebuddy', 'claude', 'pi', 'qwen', 'hermes', 'kimi'];
  const OWN_FORM = {
    codex: '~/.codex/o', cline: '~/.cline/o', cursor: '~/.cursor/o', windsurf: '~/.codeium/windsurf/o',
    augment: '~/.augment/o', trae: '~/.trae/o', codebuddy: '~/.codebuddy/o', qwen: '~/.qwen/o', hermes: '~/.hermes/o',
  };
  const SOURCE_FORMS = [
    '~/.claude/x', '$HOME/.claude/y', '~/.claude', '$HOME/.claude', './.claude/z', './.claude',
    '.claude/skills/q', '~/.claude.json', '~/.claude-plugin/q', '$HOME/.claudex', './.claude-x',
    '~/.devin/skills/x', './.devin/skills/x', '.devin/skills/y', './.devin/x', '~/.devin', '$HOME/.devin',
  ];

  test('#5715: config dir name boundaries around .claude (limit-1, limit, limit+1)', () => {
    // `.claud` is one short of a source form; `.claude` is the form itself; `.claude.`,
    // `.claude-`, `.claudex` and `.claude/` are the characters just past it.
    const source = SOURCE_FORMS.join('\n');
    for (const cfg of ['.claud', '.claude', '.claude.', '.claude-', '.claudex', '.claude/', '.claude/profiles/work']) {
      const prefix = `$HOME/${cfg}/`;
      for (const id of PROFILE_IDS) {
        if (id === 'claude' && cfg === '.claude') continue; // a default install keeps the bare spelling
        assert.strictEqual(_applyRuntimeRewrites(source, id, prefix, true, undefined), modelOf(id, source, prefix), `${id} ${cfg}`);
      }
    }
  });

  test('#5715: default-install output for .claude look-alikes equals the pre-#5715 output, except the intentionally changed home and local look-alike files', () => {
    // Goldens captured from a build of origin/next (the code before #5715). Two
    // classes are INTENTIONALLY different from that build: a `.claude`-prefixed name
    // that is not the config dir itself (`.claude.json`, `.claude-plugin`) is Claude
    // Code's own file and now stays unchanged, in its `~/`, `$HOME/` and `./` forms.
    const forms = ['~/.claude', '~/.claude.', '~/.claude-', '~/.claudex', '~/.claude/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'];
    const golden = {
      codex: ['~/.claude', '~/.claude.', '~/.claude-', '~/.claudex', '$HOME/.codex/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      cline: ['$HOME/.cline', '$HOME/.cline.', '~/.claude-', '~/.claudex', '$HOME/.cline/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      cursor: ['$HOME/.cursor', '$HOME/.cursor.', '~/.claude-', '~/.claudex', '$HOME/.cursor/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      windsurf: ['$HOME/.windsurf', '$HOME/.windsurf.', '~/.claude-', '~/.claudex', '$HOME/.windsurf/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      augment: ['$HOME/.augment', '$HOME/.augment.', '~/.claude-', '~/.claudex', '$HOME/.augment/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      trae: ['$HOME/.trae', '$HOME/.trae.', '~/.claude-', '~/.claudex', '$HOME/.trae/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      codebuddy: ['$HOME/.codebuddy', '$HOME/.codebuddy.', '~/.claude-', '~/.claudex', '$HOME/.codebuddy/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      claude: ['~/.claude', '~/.claude.', '~/.claude-', '~/.claudex', '$HOME/.claude/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      pi: ['$HOME/.pi', '$HOME/.pi.', '~/.claude-', '~/.claudex', '$HOME/.pi/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      qwen: ['$HOME/.qwen', '$HOME/.qwen.', '~/.claude-', '~/.claudex', '$HOME/.qwen/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
      hermes: ['$HOME/.hermes', '$HOME/.hermes.', '~/.claude-', '~/.claudex', '$HOME/.hermes/', '~/.claude.json', '~/.claude-plugin', '$HOME/.claude.json', '$HOME/.claude-plugin', '$HOME/.claudex', './.claude.json', './.claude-x', './.claudex'],
    };
    for (const [id, expected] of Object.entries(golden)) {
      const actual = forms.map((form) => _applyRuntimeRewrites(form, id, `$HOME/.${id}/`, true, undefined));
      assert.deepStrictEqual(actual, expected, id);
    }
  });

  test('#5715: no-op inputs', () => {
    for (const id of ALL_IDS) {
      assert.strictEqual(_applyRuntimeRewrites('', id, '$HOME/.claude/profiles/work/', true, undefined), '', id);
      const plain = 'nothing to rewrite here\n';
      assert.strictEqual(_applyRuntimeRewrites(plain, id, '$HOME/.claude/profiles/work/', true, undefined), plain, id);
    }
  });

  test('#5715: slash-only profile keeps bare form', () => {
    const src = ['B ~/.claude', 'D $HOME/.claude'].join('\n');
    for (const prefix of ['$HOME/.claude/profiles/work/', '$HOME/.claude.d/', '$HOME/.codex/']) {
      assert.strictEqual(_applyRuntimeRewrites(src, 'codex', prefix, true, undefined), src, prefix);
    }
  });

  test('#5715: trae converter does not rescan prefix', () => {
    const prefix = '$HOME/.claude/profiles/work/';
    const skill = _applyRuntimeRewrites(installJs.convertClaudeCommandToTraeSkill(SLASH_SRC, 'gsd-x'), 'trae', prefix, true, undefined);
    assert.strictEqual(occurrences(skill, '$HOME/.claude/profiles/work/'), 2, skill);
    assert.ok(!skill.includes('.trae/profiles'), skill);
  });

  test('#5715: Trae own-dir forms follow the install prefix', () => {
    const src = ['A ~/.trae/x', 'B $HOME/.trae/y', 'C ~/.trae', 'D $HOME/.trae', 'E ~/.trae-plugin', 'F $HOME/.traex', 'G ~/.trae.json', 'H $HOME/.trae.json'].join('\n');
    const tail = ['E ~/.trae-plugin', 'F $HOME/.traex', 'G ~/.trae.json', 'H $HOME/.trae.json'];
    const cases = [
      ['$HOME/.trae/', true, ['A $HOME/.trae/x', 'B $HOME/.trae/y', 'C ~/.trae', 'D $HOME/.trae', ...tail]],
      ['$HOME/.claude/profiles/work/', true, ['A $HOME/.claude/profiles/work/x', 'B $HOME/.claude/profiles/work/y', 'C $HOME/.claude/profiles/work', 'D $HOME/.claude/profiles/work', ...tail]],
      ['.trae/', false, ['A .trae/x', 'B .trae/y', 'C .trae', 'D .trae', ...tail]],
      ['/p/proj/.trae/', false, ['A /p/proj/.trae/x', 'B /p/proj/.trae/y', 'C /p/proj/.trae', 'D /p/proj/.trae', ...tail]],
    ];
    for (const [prefix, isGlobal, expected] of cases) {
      assert.strictEqual(_applyRuntimeRewrites(src, 'trae', prefix, isGlobal, undefined), expected.join('\n'), prefix);
    }
  });

  test('#5715: Trae converter leaves .claude.json alone', () => {
    assert.strictEqual(
      installJs.convertClaudeToTraeMarkdown('Cfg ~/.claude.json and $HOME/.claude.json, dir ~/.claude/skills'),
      'Cfg ~/.claude.json and $HOME/.claude.json, dir ~/.trae/skills',
    );
  });

  describe('windsurf .devin forms', () => {
    const WS = '$HOME/.codeium/windsurf/';
    // The pre-#5715 sequential output, pinned, except the `~/` and `$HOME/` skills
    // forms: those emitted a stray `~/` or a doubled `$HOME/` and now yield the
    // normalized windsurf prefix followed by `skills/x`.
    const cases = [
      ['~/.devin/skills/x', '$HOME/.codeium/windsurf/skills/x'],
      ['$HOME/.devin/skills/x', '$HOME/.codeium/windsurf/skills/x'],
      ['./.devin/skills/x', './$HOME/.codeium/windsurf/skills/x'],
      ['.devin/skills/y', '$HOME/.codeium/windsurf/skills/y'],
      ['./.devin/x', '$HOME/.codeium/windsurf/x'],
      ['~/.devin/x', '$HOME/.codeium/windsurf/x'],
      ['~/.devin', '$HOME/.codeium/windsurf'],
      ['~/.devin.json', '$HOME/.codeium/windsurf.json'],
      ['~/.devin-x', '~/.devin-x'],
    ];
    test('#5715: global install .devin output (skills forms corrected, the rest as before)', () => {
      for (const [input, expected] of cases) {
        assert.strictEqual(_applyRuntimeRewrites(input, 'windsurf', WS, true, undefined), expected, input);
      }
    });

    test('#5715: workspace install leaves .devin forms alone', () => {
      for (const [input] of cases) {
        assert.strictEqual(_applyRuntimeRewrites(input, 'windsurf', './.windsurf/', false, undefined), input, input);
      }
    });

    test('#5715: a .devin-named prefix is emitted once (the sequential pass rescanned it)', () => {
      assert.strictEqual(_applyRuntimeRewrites('~/.devin/x', 'windsurf', '$HOME/.devin/sub/', true, undefined), '$HOME/.devin/sub/x');
      assert.strictEqual(_applyRuntimeRewrites('~/.devin', 'windsurf', '$HOME/.devin/sub/', true, undefined), '$HOME/.devin/sub');
    });
  });

  describe('Trae agents and spec-tree paths (the prefix is emitted before the Trae converter)', () => {
    const TRAE_SRC = 'See ~/.claude/gsd-core/x.md and $HOME/.claude y and .claude/skills/z and ./.claude/k';
    const TRAE_PREFIXES = ['/opt/proj/.claude/trae-home/', './.claude/x/', '.claude/x/', '$HOME/.claude/profiles/work/'];
    const expectedTrae = (prefix) => `See ${prefix}gsd-core/x.md and ${bareOf(prefix)} y and .trae/skills/z and ./.trae/k`;

    test('#5715: spec-tree copy leaves a prefix containing .claude/ intact', () => {
      for (const prefix of TRAE_PREFIXES) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-trae-tree-'));
        try {
          fs.mkdirSync(path.join(root, 'from'));
          fs.writeFileSync(path.join(root, 'from', 'a.md'), TRAE_SRC);
          installJs.copyWithPathReplacement(path.join(root, 'from'), path.join(root, 'to'), prefix, 'trae', false, true, root);
          assert.strictEqual(fs.readFileSync(path.join(root, 'to', 'a.md'), 'utf8'), expectedTrae(prefix), prefix);
        } finally {
          require('./helpers.cjs').cleanup(root);
        }
      }
    });

    test('#5715: agents pipeline leaves a prefix containing .claude/ intact', () => {
      const { stageAgentsForRuntimeWithConverter } = require('../gsd-core/bin/lib/install-profiles.cjs');
      for (const prefix of TRAE_PREFIXES) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-trae-agents-'));
        let staged;
        try {
          const agentsDir = path.join(root, 'agents');
          fs.mkdirSync(agentsDir);
          fs.writeFileSync(path.join(agentsDir, 'probe.md'), '---\nname: probe\ndescription: d\n---\n' + TRAE_SRC);
          staged = stageAgentsForRuntimeWithConverter(
            agentsDir,
            { name: 'full', skills: '*', agents: new Set() },
            (content, isGlobal, meta) => conv.convertClaudeAgentToTraeAgent(content, isGlobal, meta),
            true,
            { runtime: 'trae', pathPrefix: prefix, attribution: undefined, targetDir: root, projectDir: root },
          );
          const out = fs.readFileSync(path.join(staged, 'probe.md'), 'utf8');
          assert.ok(out.endsWith(expectedTrae(prefix)), `${prefix}: ${JSON.stringify(out)}`);
          assert.strictEqual(occurrences(out, bareOf(prefix)), 2, `${prefix}: ${JSON.stringify(out)}`);
        } finally {
          require('./helpers.cjs').cleanup(root);
          if (staged) require('./helpers.cjs').cleanup(staged);
        }
      }
    });

    test('#5715: the Trae layout threads the emitted prefix to the agent converter', () => {
      const prefix = '/opt/proj/.claude/trae-home/';
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-trae-layout-'));
      let staged;
      try {
        // The marker names the shipped commands root, which locates the shipped agents/.
        fs.writeFileSync(path.join(configDir, '.gsd-source'), path.resolve(__dirname, '..', 'commands', 'gsd'));
        const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs').resolveRuntimeArtifactLayout('trae', configDir, 'global');
        const agents = layout.kinds.find((kind) => kind.kind === 'agents');
        staged = agents.stage(
          { name: 'full', skills: '*', agents: new Set() },
          { runtime: 'trae', pathPrefix: prefix, attribution: undefined, targetDir: configDir, projectDir: configDir },
        );
        const files = fs.readdirSync(staged).filter((name) => name.endsWith('.md'));
        assert.ok(files.length > 0);
        const all = files.map((name) => fs.readFileSync(path.join(staged, name), 'utf8')).join('\n');
        assert.ok(all.includes(prefix), 'the emitted prefix is present');
        assert.ok(!all.includes('/opt/proj/.trae/'), 'the emitted prefix was not rewritten to .trae/');
      } finally {
        require('./helpers.cjs').cleanup(configDir);
        if (staged) require('./helpers.cjs').cleanup(staged);
      }
    });
  });

  test('#5715 property: every profile emits the prefix once per source form and never rescans it', () => {
    const cfg = fc.constantFrom('.claude', '.claude.', '.claude-', '.claudex', '.claude/', '.claude/profiles/work', '.claude.d', '.cl$&ude', '.a$`b', ".a$'b", '.cfg');
    fc.assert(
      fc.property(fc.constantFrom(...PROFILE_IDS), fc.array(fc.constantFrom(...SOURCE_FORMS), { maxLength: 8 }), cfg, (id, pieces, dir) => {
        if (id === 'claude' && dir === '.claude') return; // a default install keeps the bare spelling
        const prefix = `$HOME/${dir}/`;
        const source = pieces.concat(OWN_FORM[id] ? [OWN_FORM[id]] : []).join('\n');
        assert.strictEqual(_applyRuntimeRewrites(source, id, prefix, true, undefined), modelOf(id, source, prefix));
      }),
      { seed: 5715, numRuns: 400 },
    );
  });

  test('#5715 property: every runtime id, $HOME / absolute / ./ prefixes, never rescans the prefix', () => {
    const KINDS = { home: (d) => `$HOME/${d}/`, abs: (d) => `/opt/x/${d}/`, rel: (d) => `./${d}/` };
    const cfg = fc.constantFrom('.claude', '.claude.', '.claude-', '.claudex', '.claude/', '.claude/profiles/work', '.claude.d', '.cl$&ude', '.a$`b', ".a$'b", '.cfg');
    fc.assert(
      fc.property(
        fc.constantFrom('claude', ...conv.NON_CLAUDE_RUNTIMES),
        fc.constantFrom('home', 'abs', 'rel'),
        fc.array(fc.constantFrom(...SOURCE_FORMS), { maxLength: 8 }),
        cfg,
        (id, kind, pieces, dir) => {
          if (id === 'claude' && dir === '.claude' && kind === 'home') return; // a default install keeps the bare spelling
          const prefix = KINDS[kind](dir);
          const placeholder = KINDS[kind]('.zzplaceholder');
          const source = pieces.concat(OWN_FORM[id] ? [OWN_FORM[id]] : []).join('\n');
          const model = _applyRuntimeRewrites(source, id, placeholder, true, undefined)
            .split(placeholder).join(prefix)
            .split(bareOf(placeholder)).join(bareOf(prefix));
          assert.strictEqual(_applyRuntimeRewrites(source, id, prefix, true, undefined), model, `${id} ${prefix}`);
        },
      ),
      { seed: 5715, numRuns: 1500 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// #5715: the emitted-prefix shield. Converters that run AFTER the prefix pass (agents,
// the gsd-core spec tree, OpenCode/Kilo commands and skills, command bodies, the Codex
// agent TOML) must not rescan the prefix or expand `$&` in it.
// ────────────────────────────────────────────────────────────────────────
describe('#5715: shieldEmittedPrefix', () => {
  const fc = require('fast-check');
  const conv = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  const { _shieldEmittedPrefix: shield } = conv;
  // A converter that rewrites every source form the Trae/Kilo/OpenCode converters touch.
  const rewriteAll = (s) => s
    .replace(/\/gsd:([a-z0-9-]+)/g, '/gsd-$1')
    .replace(/\bBash\(/g, 'Shell(')
    .replace(/\bEdit\(/g, 'StrReplace(')
    .replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}')
    .replace(/\.claude\//g, '.x/');

  test('#5715: a prefix without a Claude name is shielded too (/gsd:, Bash(, Edit(, $ARGUMENTS)', () => {
    for (const prefix of ['/home/u/gsd:x/', '/opt/Bash(1)/', '/opt/Edit(2)/', '/opt/$ARGUMENTS/']) {
      const content = `A ${prefix}f.md and /gsd:plan and Bash(ls) and Edit(f) and $ARGUMENTS`;
      assert.strictEqual(
        shield(content, prefix, rewriteAll),
        `A ${prefix}f.md and /gsd-plan and Shell(ls) and StrReplace(f) and {{GSD_ARGS}}`,
        prefix,
      );
    }
  });

  test('#5715: the prefix is restored byte for byte, in its trailing-slash, bare and tilde spellings', () => {
    const prefix = '$HOME/.claude/profiles/work/';
    const content = `@${prefix}a.md ${prefix.slice(0, -1)} @~/.claude/profiles/work/b.md`;
    assert.strictEqual(shield(content, prefix, rewriteAll), content);
  });

  test('#5715: the replacement is literal, `$&` in the prefix is not expanded', () => {
    const prefix = '/opt/p/$&x/';
    const content = `A ${prefix}f.md /gsd:a`;
    assert.strictEqual(shield(content, prefix, rewriteAll), `A ${prefix}f.md /gsd-a`);
  });

  test('#5715: content holding the old control characters is still shielded', () => {
    const prefix = '/opt/p/.claude/x/';
    const content = `\u0001\u0002\u0003\u0004 ${prefix}f.md .claude/g`;
    assert.strictEqual(shield(content, prefix, rewriteAll), `\u0001\u0002\u0003\u0004 ${prefix}f.md .x/g`);
  });

  test('#5715: the sentinel namespace is chosen per call, absent from the content', () => {
    const prefix = '/opt/p/.claude/x/';
    for (const taken of [0, 1, 17, 254]) {
      const decoys = Array.from({ length: taken + 1 }, (_, n) => `\uE000${n}:0\uE001`).join('');
      const content = `${decoys} ${prefix}f.md .claude/g`;
      assert.strictEqual(shield(content, prefix, rewriteAll), `${decoys} ${prefix}f.md .x/g`, `${taken}`);
    }
  });

  test('#5715: when no sentinel namespace is free it throws, it never converts unshielded', () => {
    const prefix = '/opt/p/.claude/x/';
    const decoys = Array.from({ length: 256 }, (_, n) => `\uE000${n}:`).join('');
    let converted = false;
    assert.throws(
      () => shield(`${decoys} ${prefix}f.md`, prefix, (s) => { converted = true; return s; }),
      /no free sentinel namespace/,
    );
    assert.strictEqual(converted, false);
    // the limit - 1 boundary still shields
    const almost = Array.from({ length: 255 }, (_, n) => `\uE000${n}:`).join('');
    assert.strictEqual(shield(`${almost} ${prefix}f.md`, prefix, rewriteAll), `${almost} ${prefix}f.md`);
  });

  test('#5715: a prefix that is only the Claude config dir is never shielded', () => {
    for (const prefix of ['.claude/', '.claude', './.claude/', './.claude', '././.claude/']) {
      assert.strictEqual(shield('a .claude/b ./.claude/c', prefix, rewriteAll), 'a .x/b ./.x/c', prefix);
    }
    for (const prefix of ['', '/', './', '.']) {
      assert.strictEqual(shield('a .claude/b', prefix, rewriteAll), 'a .x/b', JSON.stringify(prefix));
    }
  });

  test('#5715: only exact occurrences of the full prefix are shielded, other .claude/ text is converted', () => {
    const prefix = '.claude/profiles/work/';
    const content = `@${prefix}a.md .claude/skills/q ./.claude/other .claude/profiles/other/z`;
    assert.strictEqual(
      shield(content, prefix, rewriteAll),
      `@${prefix}a.md .x/skills/q ./.x/other .x/profiles/other/z`,
    );
  });

  test('#5715: a non-string prefix and a prefix absent from the content pass straight through', () => {
    assert.strictEqual(shield('a .claude/b', undefined, rewriteAll), 'a .x/b');
    assert.strictEqual(shield('a .claude/b', null, rewriteAll), 'a .x/b');
    assert.strictEqual(shield('a .claude/b', '/opt/p/.claude/zz/', rewriteAll), 'a .x/b');
  });

  test('#5715 property: a shielded identity conversion round-trips, a shielded rewrite never touches the prefix', () => {
    const piece = fc.constantFrom('.claude/', '/gsd:a ', 'Bash(x)', '$ARGUMENTS', '\u0001', '\uE0000:0\uE001', 'text ', '\n');
    const prefix = fc.constantFrom('/opt/p/.claude/x/', '$HOME/.claude/profiles/work/', '/home/u/gsd:x/', '/opt/$&q/', './.claude/x/', '.claude/x/');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), prefix, fc.nat({ max: 12 }), (pieces, p, at) => {
        const content = pieces.slice(0, at).concat([`@${p}f.md `], pieces.slice(at)).join('');
        assert.strictEqual(shield(content, p, (s) => s), content);
        const out = shield(content, p, rewriteAll);
        assert.ok(out.includes(`@${p}f.md `), `${JSON.stringify(out)}`);
        // the prefix text survives exactly as often as it was emitted
        assert.strictEqual(out.split(p.replace(/\/$/, '')).length, content.split(p.replace(/\/$/, '')).length);
      }),
      { seed: 5715, numRuns: 500 },
    );
  });

  test('#5715: Trae resolves the instruction file at the emitted .trae prefix, as before', () => {
    for (const prefix of ['$HOME/.trae/', './.trae/', '/opt/p/.trae/']) {
      assert.strictEqual(
        conv.convertClaudeToTraeMarkdown(`see ${prefix}CLAUDE.md and \`${prefix}CLAUDE.md\``, prefix),
        `see ${prefix}rules/rules.md and \`${prefix}rules/rules.md\``,
        prefix,
      );
    }
  });

});

describe('#5715: --config-dir containing .claude/ and $& on every runtime with a post-prefix converter (spawned installer)', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const { after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');

  // Nested under .claude, with `$&`: every earlier pass rescanned or expanded this.
  const REAL = '.claude/$&x/profiles/work';
  const PLACEHOLDER = '.zzph/qqx/profiles/work';
  const RUNTIMES = ['kilo', 'opencode', 'codex', 'cline', 'codebuddy', 'hermes', 'qwen', 'windsurf', 'kimi', 'trae', 'augment', 'cursor', 'pi'];
  const created = [];

  function install(runtime, rel) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-e2e-'));
    created.push(home);
    const configDir = path.join(home, rel);
    const r = runNode([INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', configDir, '--minimal'], {
      cwd: home,
      env: installerEnv({ HOME: home, USERPROFILE: home }),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(r.exitCode, 0, `${runtime} --config-dir ${rel} install failed:\n${r.stdout}\n${r.stderr}`);
    return { home, configDir };
  }

  // Every .md / .toml under the config dir, with the install's own home path and the
  // per-install terminator nonce normalized.
  function emitted({ home, configDir }) {
    const homes = [home, fs.realpathSync(home)];
    const out = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (/\.(md|toml)$/.test(entry.name)) {
          let text = fs.readFileSync(full, 'utf8');
          for (const h of homes) text = text.split(h).join('@HOME');
          out.set(path.relative(configDir, full), text.replace(/GSD_(QUICK_BATCH_)?ARGS_END_[0-9a-f]{32}/g, 'ARGS_END_N'));
        }
      }
    };
    walk(configDir);
    return out;
  }

  after(() => {
    for (const dir of created) cleanup(dir);
  });

  // #5923: verbatim-copied files (gsd-core/CHANGELOG.md) quote the #5715 bug in prose; only files
  // whose text depends on the config dir (differ between real and placeholder installs) can show it.
  function prefixDependent(real, model) {
    return [...real].filter(([file, text]) => text !== model.get(file)).map(([, text]) => text).join('\n');
  }

  test('#5923: prefixDependent drops files identical across installs and keeps differing ones', () => {
    const repeated = 'see profiles/work/profiles/work';
    const same = prefixDependent(new Map([['a.md', repeated]]), new Map([['a.md', repeated]]));
    assert.ok(!same.includes('profiles/work/profiles/work'));
    const differing = prefixDependent(new Map([['b.md', repeated]]), new Map([['b.md', 'other']]));
    assert.ok(differing.includes('profiles/work/profiles/work'));
  });

  for (const runtime of RUNTIMES) {
    test(`#5715: ${runtime} emits the prefix once, literally, exactly as for a config dir with no source form in its name`, () => {
      const real = emitted(install(runtime, REAL));
      const model = emitted(install(runtime, PLACEHOLDER));
      assert.ok(real.size > 20, `${runtime}: expected an emitted tree, got ${real.size} files`);
      assert.deepStrictEqual([...real.keys()].sort(), [...model.keys()].sort(), `${runtime}: file set`);
      const wrong = [];
      for (const [file, text] of real) {
        if (text !== model.get(file).split(PLACEHOLDER).join(REAL)) wrong.push(file);
      }
      assert.deepStrictEqual(wrong.slice(0, 5), [], `${runtime}: ${wrong.length} files differ from the model`);
      const all = prefixDependent(real, model);
      assert.ok(!all.includes('profiles/work/profiles/work'), `${runtime}: prefix repeated`);
      assert.ok(!all.includes('.claude/~/'), `${runtime}: $& expanded to a tilde path`);
      assert.ok(!all.includes('@GSD core/x'), `${runtime}: $& expanded in the Kimi include`);
    });
  }

  test('#5715: copilot and antigravity includes retargeted to a config dir under their own default home emit the prefix once', () => {
    for (const [runtime, rel] of [['copilot', '.copilot/pp'], ['antigravity', '.gemini/antigravity/pp']]) {
      const files = withoutChangelogCopy(emitted(install(runtime, rel)));
      assert.ok(files.size > 20, `${runtime}: expected an emitted tree`);
      const repeated = [...files].filter(([, text]) => text.includes('/pp/pp/')).map(([file]) => file);
      assert.deepStrictEqual(repeated.slice(0, 5), [], `${runtime}: prefix repeated in ${repeated.length} files`);
    }
  });

  test('#5715: the reviewer repros (kilo, opencode, codex agents) are clean', () => {
    const kilo = withoutChangelogCopy(emitted(install('kilo', '.claude/profiles/work')));
    assert.ok(![...kilo.values()].some((t) => t.includes('/profiles/work/profiles/work/')), 'kilo repeated prefix');
    const opencode = withoutChangelogCopy(emitted(install('opencode', REAL)));
    assert.ok(![...opencode.values()].some((t) => t.includes('.claude/~/.config/opencode')), 'opencode $& expansion');
    const codex = emitted(install('codex', REAL));
    const agents = [...codex].filter(([file]) => file.startsWith('agents/') && file.endsWith('.toml'));
    assert.ok(agents.length > 0, 'codex agent tomls');
    assert.ok(agents.every(([, t]) => !t.includes('~/.codex/gsd-core/x')), 'codex agent $& expansion');
    assert.ok(agents.some(([, t]) => t.includes('@HOME/.claude/$&x/profiles/work/gsd-core/')), 'codex agent prefix');
  });
});

describe('#5715: Trae local install writes the local include path (intentional correction)', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const { cleanup } = require('./helpers.cjs');
  const { runNode } = require('./helpers/process-seam.cjs');
  const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');

  function skillFiles(root) {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'SKILL.md') out.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(root);
    return out;
  }

  test('#5715: a local Trae skill include points at the project .trae/, not at $HOME/.trae/', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-trae-home-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5715-trae-proj-'));
    try {
      const r = runNode([INSTALL_SCRIPT, '--trae', '--local', '--minimal'], {
        cwd: project,
        env: installerEnv({ HOME: home, USERPROFILE: home }),
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(r.exitCode, 0, `${r.stdout}\n${r.stderr}`);
      const bodies = skillFiles(path.join(project, '.trae', 'skills'));
      assert.ok(bodies.length > 0, 'expected installed Trae skills');
      const real = fs.realpathSync(project);
      const includes = bodies.filter((b) => b.includes('gsd-core/workflows/'));
      assert.ok(includes.length > 0, 'expected skills that include a workflow');
      assert.ok(includes.every((b) => !b.includes('@$HOME/.trae/')), 'a local skill still points at the global dir');
      assert.ok(includes.some((b) => b.includes(`@${real}/.trae/gsd-core/workflows/`)), 'expected the project-local include path');
      // Every real Trae path rewrites the ~/.claude and $HOME/.claude forms after the converter.
      assert.ok(bodies.every((b) => !/(~|\$HOME)\/\.claude\//.test(b)), 'a Claude home form survived the rewrite pass');
    } finally {
      cleanup(home);
      cleanup(project);
    }
  });
});
