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
