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

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_PATH = path.join(__dirname, '..', 'bin', 'install.js');

const isWindows = process.platform === 'win32';
const PROJECTION_PATH = path.join(
  __dirname,
  '..',
  'get-shit-done',
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
      assert.match(joined, /gsd-tools/, 'rc-covered diagnostic should name current gsd-tools binary');
      assert.doesNotMatch(joined, /gsd-sdk/, 'rc-covered diagnostic must not mention retired gsd-sdk');
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
      assert.match(joined, /gsd-tools/, 'PATH suggestion should name current gsd-tools binary');
      assert.doesNotMatch(joined, /gsd-sdk/, 'PATH suggestion must not mention retired gsd-sdk');
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

  test('resolveCurrentGlobalBinDir detects npm global prefix for current gsd-tools install', () => {
    const prefix = path.join(os.tmpdir(), 'gsd-prefix');
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: { npm_config_prefix: prefix, npm_config_global: 'true' },
        installDir: path.join(__dirname, '..', 'bin'),
        platform: 'linux',
      }),
      path.join(prefix, 'bin'),
    );
  });

  test('resolveCurrentGlobalBinDir detects installed global package layout', () => {
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: {},
        installDir: '/opt/npm/lib/node_modules/@opengsd/get-shit-done-redux/bin',
        platform: 'linux',
      }),
      '/opt/npm/bin',
    );
  });

  test('finishInstall emits gsd-tools PATH guidance only when explicitly configured', () => {
    const home = createTempHome();
    const origPath = process.env.PATH;
    try {
      const settingsPath = path.join(home, 'settings.json');
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      process.env.PATH = '/usr/bin:/bin';

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.finishInstall(
          settingsPath,
          {},
          null,
          false,
          'claude',
          true,
          home,
          { pathSuggestionGlobalBin: globalBin, pathSuggestionHomeDir: home },
        );
      } finally {
        console.log = origLog;
      }

      const joined = logs.join('\n');
      assert.match(joined, /gsd-tools/, 'finishInstall should emit current gsd-tools PATH guidance when configured');
      assert.doesNotMatch(joined, /gsd-sdk/, 'finishInstall PATH guidance must not mention retired gsd-sdk');
      assert.match(joined, /not on your PATH/);
    } finally {
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
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

describe('installer current gsd-tools PATH guidance gates', () => {
  let installer;

  before(() => {
    installer = loadInstaller();
  });

  function captureLogs(fn) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      fn();
    } finally {
      console.log = origLog;
    }
    return logs.join('\n');
  }

  test('finishInstall suppresses PATH guidance for local installs even when configured', () => {
    const home = createTempHome();
    const origPath = process.env.PATH;
    try {
      const settingsPath = path.join(home, 'settings.json');
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      process.env.PATH = '/usr/bin:/bin';

      const joined = captureLogs(() => {
        installer.finishInstall(
          settingsPath,
          {},
          null,
          false,
          'claude',
          false,
          home,
          { pathSuggestionGlobalBin: globalBin, pathSuggestionHomeDir: home },
        );
      });

      assert.doesNotMatch(joined, /not on your PATH/, 'local installs must not emit global PATH guidance');
      assert.doesNotMatch(joined, /Add it so your shell can find/, 'local installs must not emit PATH repair commands');
      assert.doesNotMatch(joined, /gsd-sdk/, 'local install output must not mention retired gsd-sdk');
    } finally {
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      cleanup(home);
    }
  });

  test('finishInstall suppresses PATH guidance when global bin dir is unavailable', () => {
    const home = createTempHome();
    const origPath = process.env.PATH;
    try {
      const settingsPath = path.join(home, 'settings.json');
      process.env.PATH = '/usr/bin:/bin';

      const joined = captureLogs(() => {
        installer.finishInstall(
          settingsPath,
          {},
          null,
          false,
          'claude',
          true,
          home,
          { pathSuggestionHomeDir: home },
        );
      });

      assert.doesNotMatch(joined, /not on your PATH/, 'missing global bin dir must not emit PATH guidance');
      assert.doesNotMatch(joined, /Add it so your shell can find/, 'missing global bin dir must not emit PATH repair commands');
      assert.doesNotMatch(joined, /gsd-sdk/, 'global install output must not mention retired gsd-sdk');
    } finally {
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      cleanup(home);
    }
  });

  test('resolveCurrentGlobalBinDir returns npm prefix itself for win32 npm global prefix', () => {
    const prefix = 'C:/Users/alice/AppData/Roaming/npm';
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: { npm_config_prefix: prefix, npm_config_global: 'true' },
        installDir: '/irrelevant/source/bin',
        platform: 'win32',
      }),
      prefix,
    );
  });

  test('resolveCurrentGlobalBinDir returns package prefix without /bin for win32 global package layout', () => {
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: {},
        installDir: '/opt/npm/lib/node_modules/@opengsd/get-shit-done-redux/bin',
        platform: 'win32',
      }),
      '/opt/npm',
    );
  });

  test('resolveCurrentGlobalBinDir returns null for source checkout layout', () => {
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: {},
        installDir: path.join(__dirname, '..', 'bin'),
        platform: 'linux',
      }),
      null,
    );
  });

  test('resolveCurrentGlobalBinDir returns null when npm prefix is not a global install', () => {
    assert.strictEqual(
      installer.resolveCurrentGlobalBinDir({
        env: { npm_config_prefix: '/opt/npm', npm_config_global: 'false' },
        installDir: path.join(__dirname, '..', 'bin'),
        platform: 'linux',
      }),
      null,
    );
  });
});
