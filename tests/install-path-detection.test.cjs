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
});

describe('#323 regression: fish-shell PATH coverage detection',
  { skip: isWindows ? 'POSIX-only: parses ~/.config/fish; fish on Windows is uncommon and uses no rc files here' : false },
  () => {
  let installer;
  before(() => { installer = loadInstaller(); });

  // Writes a fish config file under <home>/.config/fish, returning globalBin.
  function withFish(home, { variables, config } = {}) {
    const globalBin = path.join(home, '.nvm', 'versions', 'node', 'v24', 'bin');
    fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
    fs.mkdirSync(globalBin, { recursive: true });
    if (variables !== undefined) {
      fs.writeFileSync(path.join(home, '.config', 'fish', 'fish_variables'), variables);
    }
    if (config !== undefined) {
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), config);
    }
    return globalBin;
  }

  test('homePathCoveredByFishConfig is exported', () => {
    assert.strictEqual(typeof installer.homePathCoveredByFishConfig, 'function',
      'bin/install.js must export homePathCoveredByFishConfig for #323');
  });

  test('fish_variables SETUVAR fish_user_paths covers globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { variables: '' });
      // Real fish format: the list separator is the literal TEXT `\x1e` (four
      // chars), NOT a raw 0x1e byte — verified against fish 4.x output. The `\\`
      // in this template literal produces that text. Values are stored absolute.
      fs.writeFileSync(path.join(home, '.config', 'fish', 'fish_variables'),
        `# This file contains fish universal variable definitions.\n# VERSION: 3.0\nSETUVAR fish_user_paths:/usr/local/bin\\x1e${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('fish_variables with a path whose space is escaped as \\x20 is matched', () => {
    const home = createTempHome();
    try {
      // fish escapes the space byte as the TEXT `\x20` (verified against fish 4.x).
      const globalBin = path.join(home, 'node bin');
      fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      const escaped = globalBin.replace(/ /g, '\\x20');
      fs.writeFileSync(path.join(home, '.config', 'fish', 'fish_variables'),
        `SETUVAR fish_user_paths:/usr/local/bin\\x1e${escaped}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('fish_variables SETUVAR with --path flag is still parsed', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { variables: '' });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'fish_variables'),
        `SETUVAR --path fish_user_paths:${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish fish_add_path covers globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { config: '' });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        `fish_add_path ${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish single-quoted fish_add_path with a space is matched', () => {
    const home = createTempHome();
    try {
      // This is the exact quoted form the installer itself suggests for spaced
      // paths, so detection must agree with the suggestion it emits.
      const globalBin = path.join(home, 'node bin');
      fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        `fish_add_path '${globalBin}'\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish double-quoted $HOME path with a space is matched', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, 'node bin');
      fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        'fish_add_path "$HOME/node bin"\n');
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish set -gx PATH with $HOME expansion covers globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, {
        config: 'set -gx PATH $HOME/.nvm/versions/node/v24/bin $PATH\n',
      });
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish set -gx PATH /dir:$PATH (colon-joined) covers globalBin', () => {
    const home = createTempHome();
    try {
      // PATH is a path-list variable; fish colon-splits it, so `/dir:$PATH`
      // puts /dir on PATH as its own entry (verified against fish 4.x).
      const globalBin = withFish(home, { config: '' });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        `set -gx PATH ${globalBin}:$PATH\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('fish_variables with a non-ASCII path escaped as \\u00e9 is matched', () => {
    const home = createTempHome();
    try {
      // fish escapes codepoints <= 0xFFFF as the TEXT `\uHHHH` (café -> café,
      // verified against fish 4.x). The value must be codepoint-decoded.
      const globalBin = path.join(home, 'café', 'bin');
      fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      const escaped = `${home}/caf\\u00e9/bin`;
      fs.writeFileSync(path.join(home, '.config', 'fish', 'fish_variables'),
        `SETUVAR fish_user_paths:${escaped}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('config.fish trailing inline # comment is not treated as a path', () => {
    const home = createTempHome();
    try {
      // fish ignores a start-of-word `#` to end-of-line; the commented path must
      // NOT suppress the warning.
      const globalBin = path.join(home, 'node-bin');
      fs.mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        `fish_add_path /some/other/bin # ${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when fish config covers only an unrelated directory', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { config: 'fish_add_path /some/other/bin\n' });
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when no fish files exist (and does not throw)', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.nvm', 'versions', 'node', 'v24', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      assert.doesNotThrow(() => installer.homePathCoveredByFishConfig(globalBin, home));
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('relative fish_add_path entry is not treated as covering globalBin', () => {
    const home = createTempHome();
    try {
      // A bare `bin` is cwd-dependent — must NOT be resolved against HOME.
      const globalBin = withFish(home, { config: 'fish_add_path bin\n' });
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('maybeSuggestPathExport suppresses the add-PATH warning for a covered fish user', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { config: '' });
      fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'),
        `fish_add_path ${globalBin}\n`);

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      const joined = logs.join('\n');
      assert.ok(!/is not on your PATH/.test(joined),
        `fish-covered user should not see the add-PATH warning; got:\n${joined}`);
      assert.ok(!/fish_add_path/.test(joined),
        `fish-covered user should not be told to add the path again; got:\n${joined}`);
      assert.ok(/already on your PATH/.test(joined),
        `expected the "already covered, reopen your shell" note; got:\n${joined}`);
    } finally {
      cleanup(home);
    }
  });

  test('maybeSuggestPathExport still warns (with a fish suggestion) when fish does not cover globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = withFish(home, { config: 'fish_add_path /some/other/bin\n' });

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      const joined = logs.join('\n');
      assert.ok(/is not on your PATH/.test(joined),
        `uncovered user should see the add-PATH warning; got:\n${joined}`);
      assert.ok(joined.includes(`fish_add_path '${globalBin}'`),
        `the warning should include a fish-native suggestion; got:\n${joined}`);
    } finally {
      cleanup(home);
    }
  });
});
