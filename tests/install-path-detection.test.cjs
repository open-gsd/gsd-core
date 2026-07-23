/**
 * Regression test for #2620 — installer should not suggest adding an absolute
 * PATH export when the user's rc file already contains a HOME-relative entry
 * that covers the same directory.
 *
 * Covers `homePathCoveredByRc(globalBin, homeDir, rcFileNames?)` which parses
 * each rc file's `export PATH=` lines, substitutes `$HOME` / `${HOME}` / `~`,
 * and returns true when any resolved PATH entry equals globalBin.
 */

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');

const INSTALL_PATH = path.join(__dirname, '..', 'bin', 'install.js');

const isWindows = process.platform === 'win32';
const PROJECTION_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'lib',
  'shell-command-projection.cjs',
);

function loadInstaller() {
  process.env.GSD_TEST_MODE = '1';
  delete require.cache[require.resolve(INSTALL_PATH)];
  return require(INSTALL_PATH);
}

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-'));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup predates helpers.cjs; name collision prevents import
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('installer HOME-relative PATH detection (#2620)',
  { skip: isWindows ? 'POSIX-only: parses sh-style "export PATH=" rc files; Windows has no rc files and uses registry Path' : false },
  () => {
  let installer;
  let projection;
  before(() => {
    installer = loadInstaller();
    projection = require(PROJECTION_PATH);
  });

  test('homePathCoveredByRc is exported', () => {
    assert.strictEqual(
      typeof installer.homePathCoveredByRc,
      'function',
      'bin/install.js must export homePathCoveredByRc for #2620',
    );
  });

  test('detects $HOME/.npm-global/bin pattern', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="$HOME/.npm-global/bin:$PATH"\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('detects ${HOME}/.npm-global/bin pattern', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.bashrc'),
        'export PATH="${HOME}/.npm-global/bin:$PATH"\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('detects ~/.npm-global/bin tilde form', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.profile'),
        'export PATH=~/.npm-global/bin:$PATH\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('detects absolute path that exactly matches globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        `export PATH="${globalBin}:$PATH"\n`,
      );
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when rc files exist but do not cover globalBin', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="$HOME/.cargo/bin:$PATH"\nexport FOO=bar\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when no rc files exist', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('swallows unreadable rc files without throwing', () => {
    const home = createTempHome();
    try {
      const rc = path.join(home, '.zshrc');
      fs.mkdirSync(rc); // directory where a file is expected — reading throws
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.doesNotThrow(() => installer.homePathCoveredByRc(globalBin, home));
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('ignores commented-out export PATH lines', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        '# export PATH="$HOME/.npm-global/bin:$PATH"\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('matches globalBin regardless of trailing slash', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="$HOME/.npm-global/bin/:$PATH"\n',
      );
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByRc(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  // CodeRabbit finding: bare relative PATH segments (e.g. `bin`) must not be
  // resolved against $HOME. Relative segments depend on the shell's cwd at
  // lookup time and are unrelated to $HOME/bin.
  test('does not treat bare relative PATH segment as HOME-relative', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="bin:$PATH"\n',
      );
      const globalBin = path.join(home, 'bin');
      assert.strictEqual(
        installer.homePathCoveredByRc(globalBin, home),
        false,
        'relative PATH segments must not be resolved against $HOME',
      );
    } finally {
      cleanup(home);
    }
  });

  test('does not treat nested relative PATH segment as HOME-relative', () => {
    const home = createTempHome();
    try {
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="node_modules/.bin:$PATH"\n',
      );
      const globalBin = path.join(home, 'node_modules', '.bin');
      assert.strictEqual(
        installer.homePathCoveredByRc(globalBin, home),
        false,
      );
    } finally {
      cleanup(home);
    }
  });

  // CodeRabbit actionable 1 + nitpick: the installer's PATH-export
  // suggestion banner must be suppressed when an rc file already covers
  // globalBin via a HOME-relative entry.
  test('maybeSuggestPathExport suppresses suggestion when rc covers globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="$HOME/.npm-global/bin:$PATH"\n',
      );

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      const joined = logs.join('\n');
      assert.ok(
        !/echo 'export PATH=/.test(joined),
        `installer should not emit absolute export suggestion; got:\n${joined}`,
      );
    } finally {
      cleanup(home);
    }
  });

  test('maybeSuggestPathExport emits suggestion when rc does not cover globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(
        path.join(home, '.zshrc'),
        'export PATH="$HOME/.cargo/bin:$PATH"\n',
      );

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      const joined = logs.join('\n');
      assert.equal(
        typeof projection.projectPersistentPathExportActions,
        'function',
        'shell command projection module must export projectPersistentPathExportActions',
      );
      const projected = projection.projectPersistentPathExportActions({
        targetDir: globalBin,
        platform: process.platform,
      });
      assert.ok(Array.isArray(projected.shellActions), 'projected.shellActions must be an array');
      assert.ok(projected.shellActions.length >= 2, 'expected at least zsh/bash projected actions');
      for (const action of projected.shellActions) {
        assert.ok(
          joined.includes(action.command),
          `installer should render projected command "${action.command}". Output:\n${joined}`,
        );
      }
    } finally {
      cleanup(home);
    }
  });

  test('maybeSuggestPathExport is a no-op when globalBin already on process.env.PATH', () => {
    const home = createTempHome();
    const origPath = process.env.PATH;
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      process.env.PATH = `${globalBin}${path.delimiter}${origPath || ''}`;

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      assert.strictEqual(logs.length, 0, `expected no output when on PATH; got:\n${logs.join('\n')}`);
    } finally {
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      cleanup(home);
    }
  });

  // #323 — fish has no sh-style `export PATH=` rc file, so homePathCoveredByRc
  // can never see a fish user's PATH. homePathCoveredByFishConfig parses fish's
  // universal-variable store (fish_variables) and config.fish so the installer
  // does not emit a false-positive warning for fish users whose
  // fish_user_paths already covers globalBin.
  describe('fish-shell PATH coverage detection (#323)', () => {
    function writeFishFile(home, name, content) {
      const fishDir = path.join(home, '.config', 'fish');
      fs.mkdirSync(fishDir, { recursive: true });
      fs.writeFileSync(path.join(fishDir, name), content);
    }

    // Mirror fish's universal-variable serialization (`full_escape`): every
    // byte outside [A-Za-z0-9/_] is written as `\xHH`, and list elements are
    // joined by the literal 4-char token `\x1e` — NOT a raw 0x1e byte.
    // Verified against fish 3.7.0 output (space -> \x20, `-` -> \x2d, `.` ->
    // \x2e). Fixtures use this so the decoder is tested against real format.
    function fishEncodeUniversalList(paths) {
      const esc = (p) => p.replace(/[^A-Za-z0-9/_]/g, (ch) =>
        '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
      return paths.map(esc).join('\\x1e');
    }

    test('homePathCoveredByFishConfig is exported', () => {
      assert.strictEqual(
        typeof installer.homePathCoveredByFishConfig,
        'function',
        'bin/install.js must export homePathCoveredByFishConfig for #323',
      );
    });

    test('detects fish_user_paths in the universal-variable store', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        writeFishFile(
          home,
          'fish_variables',
          [
            'SETUVAR --export LANG:en_US',
            `SETUVAR fish_user_paths:${fishEncodeUniversalList([globalBin, '/usr/local/bin'])}`,
            '',
          ].join('\n'),
        );
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
      } finally {
        cleanup(home);
      }
    });

    // Regression: fish escapes `-`, `.`, and space in the universal-variable
    // store, so the detector must decode `\xHH` before comparing. A raw
    // string match (the original, naive implementation) fails here. Mirrors a
    // real nvm path (dots + hyphens) plus a space-containing sibling.
    test('decodes fish-escaped paths (dots, hyphens, spaces) in fish_variables', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
        const spaced = path.join(home, 'my tools', 'bin');
        const encoded = fishEncodeUniversalList([spaced, globalBin]);
        // Sanity: the fixture really is escaped, not a plain path.
        assert.ok(encoded.includes('\\x2e') && encoded.includes('\\x20') && encoded.includes('\\x1e'));
        writeFishFile(home, 'fish_variables', `SETUVAR fish_user_paths:${encoded}\n`);
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
        assert.strictEqual(installer.homePathCoveredByFishConfig(spaced, home), true);
        assert.strictEqual(
          installer.homePathCoveredByFishConfig(path.join(home, 'not', 'there'), home),
          false,
        );
      } finally {
        cleanup(home);
      }
    });

    // Adversarial regression: fish stores a literal `$` in a directory name as
    // `\x24` in the universal store, so the decoded entry contains `$`. That
    // `$` is part of the path, not an unexpanded variable — the uvar route
    // must still match it. (config.fish tokens keep the `$VAR` guard.)
    test('detects a fish_user_paths entry whose directory name contains a literal $', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, 'has $VAR dir', 'bin');
        writeFishFile(home, 'fish_variables', `SETUVAR fish_user_paths:${fishEncodeUniversalList([globalBin])}\n`);
        assert.ok(fishEncodeUniversalList([globalBin]).includes('\\x24'), 'fixture must encode $ as \\x24');
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
      } finally {
        cleanup(home);
      }
    });

    test('detects fish_add_path in config.fish (with flag)', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        writeFishFile(home, 'config.fish', `fish_add_path -g ${globalBin}\n`);
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
      } finally {
        cleanup(home);
      }
    });

    test('detects set -gx PATH in config.fish', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        writeFishFile(home, 'config.fish', `set -gx PATH $PATH ${globalBin}\n`);
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
      } finally {
        cleanup(home);
      }
    });

    test('detects set -Ux fish_user_paths in config.fish', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        writeFishFile(home, 'config.fish', `set -Ux fish_user_paths ${globalBin} /usr/bin\n`);
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
      } finally {
        cleanup(home);
      }
    });

    test('ignores commented-out fish_add_path lines', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        writeFishFile(home, 'config.fish', `# fish_add_path ${globalBin}\n`);
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
      } finally {
        cleanup(home);
      }
    });

    test('returns false when fish config does not cover globalBin', () => {
      const home = createTempHome();
      try {
        writeFishFile(home, 'config.fish', 'fish_add_path /opt/some/other/bin\n');
        const globalBin = path.join(home, '.nvm', 'bin');
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
      } finally {
        cleanup(home);
      }
    });

    test('returns false when no fish config exists', () => {
      const home = createTempHome();
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
      } finally {
        cleanup(home);
      }
    });

    test('does not resolve a bare relative fish_add_path segment against HOME', () => {
      const home = createTempHome();
      try {
        writeFishFile(home, 'config.fish', 'fish_add_path bin\n');
        const globalBin = path.join(home, 'bin');
        assert.strictEqual(
          installer.homePathCoveredByFishConfig(globalBin, home),
          false,
          'relative fish_add_path segments must not be resolved against $HOME',
        );
      } finally {
        cleanup(home);
      }
    });

    test('swallows an unreadable fish config without throwing', () => {
      const home = createTempHome();
      try {
        const fishDir = path.join(home, '.config', 'fish');
        fs.mkdirSync(fishDir, { recursive: true });
        fs.mkdirSync(path.join(fishDir, 'config.fish')); // dir where a file is expected
        const globalBin = path.join(home, '.nvm', 'bin');
        assert.doesNotThrow(() => installer.homePathCoveredByFishConfig(globalBin, home));
        assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
      } finally {
        cleanup(home);
      }
    });

    test('maybeSuggestPathExport suppresses suggestion when fish config covers globalBin', () => {
      const home = createTempHome();
      const origPath = process.env.PATH;
      try {
        const globalBin = path.join(home, '.nvm', 'bin');
        fs.mkdirSync(globalBin, { recursive: true });
        // globalBin not on the current PATH, no sh rc files — only fish covers it.
        process.env.PATH = '/usr/bin';
        writeFishFile(home, 'fish_variables', `SETUVAR fish_user_paths:${fishEncodeUniversalList([globalBin])}\n`);

        const logs = [];
        const origLog = console.log;
        console.log = (...args) => { logs.push(args.join(' ')); };
        try {
          installer.maybeSuggestPathExport(globalBin, home);
        } finally {
          console.log = origLog;
        }

        const joined = logs.join('\n');
        assert.ok(
          !/fish_add_path/.test(joined) && !/Add it with one of/.test(joined),
          `installer should not emit a PATH suggestion when fish already covers it; got:\n${joined}`,
        );
        assert.ok(
          /universal variables/.test(joined),
          `installer should print the fish reopen note; got:\n${joined}`,
        );
      } finally {
        if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
        cleanup(home);
      }
    });

    test('maybeSuggestPathExport emits fish_add_path suggestion when nothing covers globalBin', () => {
      const home = createTempHome();
      const origPath = process.env.PATH;
      try {
        const globalBin = path.join(home, '.npm-global', 'bin');
        fs.mkdirSync(globalBin, { recursive: true });
        process.env.PATH = '/usr/bin';

        const logs = [];
        const origLog = console.log;
        console.log = (...args) => { logs.push(args.join(' ')); };
        try {
          installer.maybeSuggestPathExport(globalBin, home);
        } finally {
          console.log = origLog;
        }

        const joined = logs.join('\n');
        const projected = projection.projectPersistentPathExportActions({
          targetDir: globalBin,
          platform: process.platform,
        });
        const fishAction = projected.shellActions.find((a) => a.shell === 'fish');
        assert.ok(fishAction, 'projection must include a fish action');
        assert.ok(
          joined.includes(fishAction.command),
          `installer should render the projected fish command "${fishAction.command}". Output:\n${joined}`,
        );
      } finally {
        if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
        cleanup(home);
      }
    });
  });
});

// #323 — property-based coverage for the fish universal-variable decoder.
// `decodeFishUniversalValue` is the inverse of fish's `full_escape`; the
// example-based cases above cover dot/hyphen/space/$/unicode, this locks the
// bijection itself: decode(fishEscape(p)) === p over arbitrary strings.
// Platform-agnostic (a pure string transform), so this block is NOT skipped on
// Windows — unlike the rc/fish-config probes above.
describe('decodeFishUniversalValue: round-trip properties (#323)', () => {
  let installer;
  before(() => { installer = loadInstaller(); });

  // Faithful inverse of decodeFishUniversalValue, matching fish's full_escape:
  // keep [A-Za-z0-9/_] literal, \xHH for code units <= 0xFF, \uXXXX otherwise
  // (each UTF-16 code unit is <= 0xFFFF, so astral code points encode as their
  // two surrogate units and decode back identically).
  function fishEscape(value) {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (/[A-Za-z0-9/_]/.test(ch)) { out += ch; continue; }
      const code = value.charCodeAt(i);
      out += code <= 0xff
        ? '\\x' + code.toString(16).padStart(2, '0')
        : '\\u' + code.toString(16).padStart(4, '0');
    }
    return out;
  }

  test('decodeFishUniversalValue is exported', () => {
    assert.strictEqual(typeof installer.decodeFishUniversalValue, 'function');
  });

  // The bijection across arbitrary unicode (spaces, dots, hyphens, $, quotes,
  // astral code points).
  test('decode(fishEscape(p)) === p for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (p) => {
        assert.strictEqual(installer.decodeFishUniversalValue(fishEscape(p)), p);
      }),
    );
  });

  // Realistic shape: absolute POSIX paths built from arbitrary segments — the
  // actual fish_user_paths entries the detector compares — still round-trip.
  test('decode(fishEscape(absPath)) === absPath for arbitrary path segments', () => {
    const segment = fc.string({ unit: 'binary', minLength: 1, maxLength: 24 })
      .filter((s) => !s.includes('/'));
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segs) => {
        const abs = '/' + segs.join('/');
        assert.strictEqual(installer.decodeFishUniversalValue(fishEscape(abs)), abs);
      }),
    );
  });

  // Total function: any unrecognised `\`-sequence (incl. truncated escapes)
  // passes through verbatim and it never throws.
  test('never throws and is total over arbitrary escaped input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (raw) => {
        assert.doesNotThrow(() => installer.decodeFishUniversalValue(raw));
        assert.strictEqual(typeof installer.decodeFishUniversalValue(raw), 'string');
      }),
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3509-path-spaces.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3509-path-spaces (consolidation epic #1969 B6 #1975)", () => {
/**
 * Regression tests for #3509 — CLI breaks when repo path contains spaces
 *
 * Root cause: test code embedded space-containing paths into runGsdTools()
 * string args; the helper's whitespace tokenizer truncated paths at the first
 * space.  All calls that carry dynamic paths must use the array form of
 * runGsdTools() so execFileSync receives the full path as a single argv slot.
 *
 * These tests create a tmpdir whose prefix intentionally contains a space so
 * they remain red on a broken codebase regardless of the host machine's
 * tmpdir location.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runGsdTools, cleanup } = require('./helpers.cjs');

// Create a tmpdir whose name always contains a space — this is the invariant
// that was violated on /Volumes/Mini Me/... machines.
function createSpacedTmpDir(prefix = 'path with spaces-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── dispatcher --cwd= with space in path ────────────────────────────────────

describe('bug-3509: --cwd= survives spaces in path', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createSpacedTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\n'
    );
  });

  afterEach(() => cleanup(tmpDir));

  test('--cwd= array form passes full path with spaces to dispatcher', () => {
    // Array form: path is a single argv slot, never split on whitespace
    const result = runGsdTools(['--cwd=' + tmpDir, 'state', 'load'], process.cwd());
    assert.ok(result.success, `--cwd= with spaced path should succeed, got: ${result.error}`);
  });
});

// ─── frontmatter-cli file path with spaces ───────────────────────────────────

describe('bug-3509: frontmatter get/set/merge/validate survive spaces in file path', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = createSpacedTmpDir();
    tmpFile = path.join(tmpDir, 'test.md');
    fs.writeFileSync(tmpFile, '---\nphase: 01\nplan: 01\ntype: execute\n---\nbody');
  });

  afterEach(() => cleanup(tmpDir));

  test('frontmatter get returns parsed fields when file path contains spaces', () => {
    const result = runGsdTools(['frontmatter', 'get', tmpFile]);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.phase, '01', 'phase field should be "01"');
  });

  test('frontmatter set works when file path contains spaces', () => {
    const setResult = runGsdTools(['frontmatter', 'set', tmpFile, '--field', 'phase', '--value', '02']);
    assert.ok(setResult.success, `set failed: ${setResult.error}`);
    // Verify behaviorally — round-trip via frontmatter get rather than reading the file
    // and grepping (which trips lint-no-source-grep even on tmp files).
    const getResult = runGsdTools(['frontmatter', 'get', tmpFile]);
    assert.ok(getResult.success, `get failed: ${getResult.error}`);
    const parsed = JSON.parse(getResult.output);
    assert.strictEqual(parsed.phase, '02', 'field should be updated to "02"');
  });

  test('frontmatter validate works when file path contains spaces', () => {
    // Plan frontmatter schema — file path contains a space; must reach validation, not fail on path
    const result = runGsdTools(['frontmatter', 'validate', tmpFile, '--schema', 'plan']);
    // Should succeed (exit 0) and return structured JSON with valid/missing, not a path-split error
    assert.ok(result.success, `Command should exit 0, got: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok('valid' in out, 'should return structured JSON with "valid" field');
  });
});

// ─── verify-path-exists with absolute path containing spaces ─────────────────

describe('bug-3509: verify-path-exists survives absolute paths with spaces', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createSpacedTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  });

  afterEach(() => cleanup(tmpDir));

  test('absolute path with spaces resolves correctly via array form', () => {
    const absFile = path.join(tmpDir, 'abs-test.txt');
    fs.writeFileSync(absFile, 'content');

    const result = runGsdTools(['verify-path-exists', absFile], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, true, 'file should be found');
    assert.strictEqual(output.type, 'file');
  });
});

// ─── profile-pipeline --path with spaces ─────────────────────────────────────

describe('bug-3509: scan-sessions --path survives spaces in path', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createSpacedTmpDir();
  });

  afterEach(() => cleanup(tmpDir));

  test('scan-sessions --path with spaces returns empty array, not path-split error', () => {
    const sessionsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const result = runGsdTools(['scan-sessions', '--path', sessionsDir, '--raw'], tmpDir);
    assert.ok(result.success, `Failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(Array.isArray(out), 'should return an array');
    assert.strictEqual(out.length, 0, 'should be empty for empty sessions dir');
  });
});
  });
}
