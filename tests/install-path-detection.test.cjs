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

  // ---- #323: fish-shell coverage detection (fish_user_paths / config.fish) ----

  function writeFish(home, name, content) {
    const dir = path.join(home, '.config', 'fish');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  test('homePathCoveredByFishConfig is exported', () => {
    assert.strictEqual(
      typeof installer.homePathCoveredByFishConfig,
      'function',
      'bin/install.js must export homePathCoveredByFishConfig for #323',
    );
  });

  test('detects globalBin in fish_variables SETUVAR fish_user_paths', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      // fish stores absolute, fully-expanded paths, \x1e-delimited.
      writeFish(home, 'fish_variables',
        `# This file contains fish universal variable definitions.\nSETUVAR --export fish_user_paths:${globalBin}\x1e${path.join(home, '.cargo', 'bin')}\n`,
      );
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('detects globalBin via fish_add_path in config.fish', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      writeFish(home, 'config.fish', `fish_add_path ${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('detects globalBin via set -gx PATH in config.fish (HOME-expanded)', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      writeFish(home, 'config.fish', 'set -gx PATH $HOME/.npm-global/bin $PATH\n');
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when fish config does not cover globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      writeFish(home, 'fish_variables', `SETUVAR fish_user_paths:${path.join(home, '.cargo', 'bin')}\n`);
      writeFish(home, 'config.fish', 'fish_add_path $HOME/.cargo/bin\n');
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('returns false when no fish config exists', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('ignores commented fish_add_path lines', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      writeFish(home, 'config.fish', `# fish_add_path ${globalBin}\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('does not treat bare relative fish path token as HOME-relative', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, 'bin');
      writeFish(home, 'config.fish', 'fish_add_path bin\n');
      assert.strictEqual(
        installer.homePathCoveredByFishConfig(globalBin, home),
        false,
        'relative tokens depend on cwd and are not equivalent to $HOME/bin',
      );
    } finally {
      cleanup(home);
    }
  });

  test('swallows unreadable fish config without throwing', () => {
    const home = createTempHome();
    try {
      const dir = path.join(home, '.config', 'fish');
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, 'config.fish')); // directory where a file is expected
      const globalBin = path.join(home, '.npm-global', 'bin');
      assert.doesNotThrow(() => installer.homePathCoveredByFishConfig(globalBin, home));
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), false);
    } finally {
      cleanup(home);
    }
  });

  test('matches fish_user_paths entry regardless of trailing slash', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      writeFish(home, 'fish_variables', `SETUVAR fish_user_paths:${globalBin}/\n`);
      assert.strictEqual(installer.homePathCoveredByFishConfig(globalBin, home), true);
    } finally {
      cleanup(home);
    }
  });

  test('maybeSuggestPathExport suppresses suggestion when fish config covers globalBin', () => {
    const home = createTempHome();
    try {
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      writeFish(home, 'fish_variables', `SETUVAR --export fish_user_paths:${globalBin}\n`);

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };
      try {
        installer.maybeSuggestPathExport(globalBin, home);
      } finally {
        console.log = origLog;
      }

      // Behavioral signal (mirrors the rc-coverage test above): the projected
      // PATH-fix suggestion command must NOT be emitted when fish already
      // covers the directory. The fish suggestion command is `fish_add_path …`.
      const joined = logs.join('\n');
      const fishSuggestion = projection.projectPersistentPathExportActions({
        targetDir: globalBin,
        platform: process.platform,
      }).shellActions.find((a) => a.shell === 'fish');
      assert.ok(
        !joined.includes(fishSuggestion.command),
        `installer must suppress the PATH suggestion when fish covers it; got:\n${joined}`,
      );
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
