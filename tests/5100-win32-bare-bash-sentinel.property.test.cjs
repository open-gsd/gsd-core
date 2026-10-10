'use strict';

/**
 * Property-based tests for the #5100 bare-win32-bash sentinel
 *
 * Module: gsd-core/bin/lib/runtime-hooks-surface.cjs
 * Gate:   validateConfiguredEntrypoints(entries, deps)
 *           -> isWin32BareBashToken(candidate, 'win32') (unexported)
 *
 * The sentinel is a parser-like predicate: `bash` / `bash.exe`, matched
 * case-insensitively, trimmed at the edge, and only when the token carries
 * no path separator. The predicate decides which of two resolvers runs - the Git Bash policy
 * (env GSD_BASH_PATH / ProgramFiles / ProgramFiles(x86) / SystemDrive) or
 * the generic PATH scan. Getting it wrong re-opens #5100 for one spelling.
 *
 * The properties below observe the predicate only through the gate, with
 * the two resolvers rigged to disagree:
 *
 *   - the Git Bash policy is rigged to find nothing
 *     (env {} + existsSync -> false), and
 *   - the PATH scan is rigged to resolve every candidate.
 *
 * So `gate.ok` is true exactly when the token was NOT treated as the
 * sentinel. That makes the predicate's contract directly observable.
 *
 * Properties tested:
 *   (a) case/extension: over per-character case variants of "bash" times a
 *       set of extensions, the token is the sentinel iff the extension is
 *       absent or ".exe"
 *   (b) separator: prefixing a sentinel-shaped token with any path
 *       separator (POSIX, win32, or a drive letter) makes it an ordinary
 *       candidate again
 *   (c) platform: the same token is the sentinel on win32 and an ordinary
 *       candidate on every other platform
 *   (d) whitespace: leading/trailing whitespace around a bare token is
 *       trimmed at the edge rather than smuggling the token past the gate
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const GSD_5100_WSL_BASH = 'C:\\WINDOWS\\System32\\bash.exe';

// Per-character case of "bash" -> 4 booleans.
const caseFlags = fc.array(fc.boolean(), { minLength: 4, maxLength: 4 });

function applyCase(flags) {
  return 'bash'.split('').map((ch, i) => (flags[i] ? ch.toUpperCase() : ch)).join('');
}

/**
 * True when the gate ACCEPTS `token` as an interpreter. The sentinel
 * resolves only through the Git Bash policy (rigged empty here), so an
 * accepted token was routed to the PATH scan instead.
 */
function gateAccepts(token, platform = 'win32') {
  const result = hooksSurface.validateConfiguredEntrypoints([{
    runtime: 'codex',
    configPath: '/cfg',
    scriptPath: '/cfg/hooks/gsd-bar.sh',
    platform,
    interpreterCandidates: [token],
  }], {
    statSync: () => ({ isFile: () => true }),
    accessSync: () => {},
    // Git Bash policy: nothing is installed.
    env: {},
    existsSync: () => false,
    // PATH scan: everything resolves (this is the WSL System32 shape).
    resolveExecutableBinary: (candidate) => (candidate ? GSD_5100_WSL_BASH : null),
  });
  if (!result.ok) {
    assert.equal(result.invalid[0].reason, 'unresolved-interpreter');
  }
  return result.ok;
}

describe('#5100 bare win32 bash sentinel - case and extension', () => {
  test('is the sentinel iff the extension is absent or .exe', () => {
    fc.assert(fc.property(
      caseFlags,
      fc.constantFrom('', '.exe', '.EXE', '.Exe', '.eXe', '.bat', '.sh', '.cmd', '.com', '.bat.exe'),
      (flags, ext) => {
        const token = applyCase(flags) + ext;
        const expectedSentinel = ext === '' || ext.toLowerCase() === '.exe';
        assert.equal(
          gateAccepts(token),
          !expectedSentinel,
          `${JSON.stringify(token)}: expected sentinel=${expectedSentinel}`,
        );
      },
    ));
  });
});

describe('#5100 bare win32 bash sentinel - separators', () => {
  test('a path separator makes an otherwise sentinel-shaped token an ordinary candidate', () => {
    fc.assert(fc.property(
      fc.constantFrom('', '/', '\\', 'C:\\', 'D:/', '/usr/bin/', './', 'Git\\', '\\\\server\\share\\'),
      caseFlags,
      fc.constantFrom('', '.exe', '.bat'),
      (prefix, flags, ext) => {
        const token = prefix + applyCase(flags) + ext;
        const expectedSentinel = prefix === '' && (ext === '' || ext === '.exe');
        assert.equal(
          gateAccepts(token),
          !expectedSentinel,
          `${JSON.stringify(token)}: expected sentinel=${expectedSentinel}`,
        );
      },
    ));
  });
});

describe('#5100 bare win32 bash sentinel - surrounding whitespace', () => {
  test('leading/trailing whitespace is trimmed at the edge, not smuggled past the gate', () => {
    fc.assert(fc.property(
      fc.constantFrom('', ' ', '  ', '\t'),
      fc.constantFrom('', ' ', '  ', '\t'),
      caseFlags,
      fc.constantFrom('', '.exe', '.bat'),
      (pre, post, flags, ext) => {
        const token = pre + applyCase(flags) + ext + post;
        const expectedSentinel = ext === '' || ext.toLowerCase() === '.exe';
        assert.equal(
          gateAccepts(token),
          !expectedSentinel,
          `${JSON.stringify(token)}: expected sentinel=${expectedSentinel}`,
        );
      },
    ));
  });
});

describe('#5100 bare win32 bash sentinel - platform', () => {
  test('the sentinel is win32-only; other platforms keep the PATH scan', () => {
    fc.assert(fc.property(
      caseFlags,
      fc.constantFrom('', '.exe'),
      fc.constantFrom('linux', 'darwin'),
      (flags, ext, platform) => {
        const token = applyCase(flags) + ext;
        assert.equal(
          gateAccepts(token, platform),
          true,
          `${JSON.stringify(token)} must resolve through the PATH scan on ${platform}`,
        );
      },
    ));
  });
});
