'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { runGsdTools, runGsdToolsCaptured, createTempProject, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

// A local mkfifo fixture should finish immediately; bound setup without changing runtime guards.
const FIFO_FIXTURE_TIMEOUT_MS = 5000;

const projects = new Set();
afterEach(() => {
  for (const dir of projects) cleanup(dir);
  projects.clear();
});

function project() {
  const dir = createTempProject('adr-612-new-project-');
  projects.add(dir);
  return dir;
}

describe('#5067 / ADR-612 Decision 2: bracket new-project defaults', () => {
  test('empty choices materialize generated bracket naming and a derived code', () => {
    const dir = project();
    const result = runGsdTools(
      ['config-new-project', '{}'],
      dir,
      isolatedEnv({ home: dir }),
    );
    assert.equal(result.success, true, result.error || result.output);

    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_naming, 'generated');
    assert.match(config.project_code, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(config.phase_id_convention, 'bracket');
  });

  test('an explicit bracket choice derives a project code', () => {
    const dir = project();
    const choices = JSON.stringify({ phase_id_convention: 'bracket' });
    const result = runGsdTools(
      ['config-new-project', choices],
      dir,
      isolatedEnv({ home: dir }),
    );
    assert.equal(result.success, true, result.error || result.output);

    const config = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
    assert.equal(config.phase_id_convention, 'bracket');
    assert.match(config.project_code, /^[A-Z][A-Z0-9_]*$/);
  });

  test('phase_id_convention documentation says these exact strings without a stale count', () => {
    const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CONFIGURATION.md'), 'utf8');
    const row = splitLines(documentation).find((line) => line.startsWith('| `phase_id_convention` |'));
    assert.ok(row, 'phase_id_convention must have a configuration row');
    assert.ok(row.includes('accepts only these exact strings'), row);
  });
});


describe('#5067 initialization and alias contracts', () => {
  for (const [title, code] of [['Northwind Trading Company', 'NTC'], ['gsd-core', 'GC'], ['Lighthouse', 'LIGHTH'], ['007', 'P007'], ['💫', 'PROJ'], ['northWind', 'NW']]) {
    test(`derives ${code} from ${title} without preview writes`, () => {
      const dir = project();
      fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), `# ${title}\n`);
      const args = ['config-new-project', '{}', '--dry-run'];
      const result = runGsdTools(args, dir, isolatedEnv({ home: dir }));
      assert.equal(result.success, true, result.error);
      const preview = JSON.parse(result.output).config;
      assert.equal(preview.project_code, code);
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
      assert.equal(runGsdTools(['config-new-project', '{}'], dir, isolatedEnv({ home: dir })).success, true);
      const written = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json')));
      for (const key of ['project_code', 'phase_naming', 'phase_id_convention']) assert.equal(written[key], preview[key]);
    });
  }
  test('legacy opt-out keeps explicit codes verbatim; bracket refuses invalid codes without writes', () => {
    for (const convention of ['bracket', 'sequential']) {
      const dir = project();
      const result = runGsdTools(['--json-errors', 'config-new-project', JSON.stringify({ phase_id_convention: convention, project_code: '007' })], dir, isolatedEnv({ home: dir }));
      assert.equal(result.success, convention === 'sequential', result.error);
      if (!result.success) {
        assert.equal(JSON.parse(result.error).reason, 'usage');
        assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
      }
    }
  });
  test('deprecated naming setter warns and persists generated; loader silently projects old spelling', () => {
    const dir = project();
    const result = runGsdToolsCaptured(['config-set', 'phase_naming', 'sequential'], dir, isolatedEnv({ home: dir }));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /deprecated/);
    const file = path.join(dir, '.planning', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).phase_naming, 'generated');
    fs.writeFileSync(file, JSON.stringify({ phase_naming: 'sequential' }));
    const before = fs.readFileSync(file, 'utf8');
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.equal(loadConfig(dir).phase_naming, 'generated');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});


describe('#5067 initialization boundaries', () => {
  test('null convention uses bracket; explicit code wins and existing config is byte stable', () => {
    const dir = project();
    const args = ['config-new-project', JSON.stringify({ phase_id_convention: null, project_code: 'EXPLICIT' })];
    assert.equal(runGsdTools(args, dir, isolatedEnv({ home: dir })).success, true);
    const file = path.join(dir, '.planning', 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(before).project_code, 'EXPLICIT');
    assert.equal(JSON.parse(before).phase_id_convention, 'bracket');
    assert.equal(runGsdTools(args, dir, isolatedEnv({ home: dir })).success, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  test('ensure stays legacy and reads do not fill in a missing convention', () => {
    const dir = project();
    const ensured = runGsdTools(['config-ensure-section'], dir, isolatedEnv({ home: dir }));
    assert.equal(ensured.success, true, ensured.error);
    const file = path.join(dir, '.planning', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).phase_id_convention, undefined);
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.equal(loadConfig(dir).phase_id_convention, null);
  });
  test('defaults and choices layer before derivation', () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify({ project_code: 'KEEP', phase_naming: 'sequential' }));
    const preview = runGsdTools(['config-new-project', '{}', '--dry-run'], dir, isolatedEnv({ home: dir }));
    assert.equal(JSON.parse(preview.output).config.project_code, 'KEEP');
    assert.equal(JSON.parse(preview.output).config.phase_naming, 'generated');
    const override = runGsdTools(['config-new-project', '{"project_code":"WIN"}', '--dry-run'], dir, isolatedEnv({ home: dir }));
    assert.equal(JSON.parse(override.output).config.project_code, 'WIN');
  });
  test('project title is scoped to project, independent of workstream', () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, '.planning', 'northwind'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# Wrong Name\n');
    fs.writeFileSync(path.join(dir, '.planning', 'northwind', 'PROJECT.md'), '# Northwind Trading Company\n');
    const result = runGsdTools(['config-new-project', '{}', '--dry-run'], dir,
      isolatedEnv({ home: dir, override: { GSD_PROJECT: 'northwind', GSD_WORKSTREAM: 'lane' } }));
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).config.project_code, 'NTC');
  });
});


test('#5067 explicit bracket codes cannot smuggle identity dimensions', () => {
  for (const code of ['lower', '', 'CK.02-05', 'CK.02-05-tail', 'BAD-CODE', '7UP']) {
    const dir = project();
    const result = runGsdTools(['--json-errors', 'config-new-project', JSON.stringify({ project_code: code })], dir, isolatedEnv({ home: dir }));
    assert.equal(result.success, false, code);
    assert.equal(JSON.parse(result.error).reason, 'usage');
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
  }
});


describe('#6657 maintainer regressions', () => {
  test('M1 invalid global-default code derives with a source and opt-out warning; choices fail clearly', () => {
    for (const code of ['gsd', 'AUTH-X']) {
      const dir = project();
      fs.mkdirSync(path.join(dir, '.gsd'));
      fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify({ project_code: code }));
      fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), '# Northwind Trading Company\n');
      const result = runGsdToolsCaptured(['config-new-project', '{}', '--dry-run'], dir, isolatedEnv({ home: dir }));
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).config.project_code, 'NTC');
      assert.match(result.stderr, /global defaults.*defaults\.json/);
      assert.match(result.stderr, /phase_id_convention: "sequential"/);
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'defaults.json'))).project_code, code);
      const explicit = runGsdTools(['--json-errors', 'config-new-project', JSON.stringify({ project_code: code })], dir, isolatedEnv({ home: dir }));
      assert.equal(explicit.success, false);
      const failure = JSON.parse(explicit.error);
      assert.equal(failure.reason, 'usage');
      assert.equal(failure.message, 'Invalid project_code from choices for bracket: start with an uppercase ASCII letter, followed by uppercase ASCII letters, digits or underscores. Set phase_id_convention: "sequential" to keep a legacy code.');
    }
  });

  test('M4 deriveProjectCode obeys the six-character cap at word and digit boundaries', () => {
    for (const [title, expected] of [
      ['123456', 'P12345'], ['12345', 'P12345'], ['1234567', 'P12345'],
      ['alpha bravo charlie delta echo', 'ABCDE'],
      ['alpha bravo charlie delta echo foxtrot', 'ABCDEF'],
      ['alpha bravo charlie delta echo foxtrot golf', 'ABCDEF'],
      ['abcde', 'ABCDE'], ['abcdef', 'ABCDEF'], ['abcdefg', 'ABCDEF'],
      ['1 bravo charlie delta echo foxtrot', 'P1BCDE'],
      ['Café Atlas', 'CA'], ['東京計画', 'PROJ'],
    ]) {
      const dir = project();
      fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), `# ${title}\n`);
      const result = runGsdTools(['config-new-project', '{}', '--dry-run'], dir, isolatedEnv({ home: dir }));
      assert.equal(result.success, true, result.error);
      assert.equal(JSON.parse(result.output).config.project_code, expected, title);
    }
  });

  test('M4 fast-check: arbitrary titles produce deterministic grammar-valid codes of at most six characters', () => {
    const dir = project();
    const titleFile = path.join(dir, '.planning', 'PROJECT.md');
    const codeFor = (title) => {
      fs.writeFileSync(titleFile, `# ${title}\n`);
      const result = runGsdTools(['config-new-project', '{}', '--dry-run'], dir, isolatedEnv({ home: dir }));
      assert.equal(result.success, true, result.error);
      return JSON.parse(result.output).config.project_code;
    };
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 120 }), fc.integer({ min: 100000, max: 999999999 }).map(String)), (title) => {
      const code = codeFor(title);
      assert.match(code, /^[A-Z][A-Z0-9_]{0,5}$/);
      assert.equal(codeFor(title), code);
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
    }), { seed: 6657, numRuns: 100 });
  });

  test('M4 project title skips fenced examples and uses the first real title', () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, '.planning', 'PROJECT.md'), ['```md', '# Wrong Title', '```', '# Northwind Trading Company', '# Later Title', ''].join('\n'));
    const result = runGsdTools(['config-new-project', '{}', '--dry-run'], dir, isolatedEnv({ home: dir }));
    assert.equal(JSON.parse(result.output).config.project_code, 'NTC');
  });

  test('m1 case-insensitive alias normalization agrees at initializer, setter, loader and directory projection', () => {
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    const { phaseDirectoryOptions } = require('../gsd-core/bin/lib/phase-locator.cjs');
    for (const alias of ['sequential', 'Sequential', 'SEQUENTIAL', 'sEqUeNtIaL']) {
      const dir = project();
      const result = runGsdToolsCaptured(['config-new-project', JSON.stringify({ phase_naming: alias }), '--dry-run'], dir, isolatedEnv({ home: dir }));
      assert.equal(JSON.parse(result.stdout).config.phase_naming, 'generated');
      const set = runGsdToolsCaptured(['config-set', 'phase_naming', alias], dir, isolatedEnv({ home: dir }));
      assert.equal(set.exitCode, 0, set.stderr);
      assert.match(set.stderr, /deprecated/);
      const file = path.join(dir, '.planning', 'config.json');
      assert.equal(JSON.parse(fs.readFileSync(file)).phase_naming, 'generated');
      fs.writeFileSync(file, JSON.stringify({ phase_naming: alias }));
      const before = fs.readFileSync(file, 'utf8');
      const read = runGsdToolsCaptured(['config-get', 'phase_naming'], dir, isolatedEnv({ home: dir }));
      assert.equal(JSON.parse(read.stdout), 'generated');
      assert.equal(read.stderr, '');
      assert.equal(loadConfig(dir).phase_naming, 'generated');
      assert.equal(phaseDirectoryOptions(dir).phaseNaming, 'generated');
      assert.equal(phaseDirectoryOptions(dir, { phase_naming: alias }).phaseNaming, 'generated');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  });

  test('m2 hostile PROJECT.md symlinks and out-of-window titles fall back to the directory', (t) => {
    const dir = project();
    const env = isolatedEnv({ home: dir });
    const preview = () => JSON.parse(runGsdTools(['config-new-project', '{}', '--dry-run'], dir, env).output).config.project_code;
    const fallback = preview();
    const file = path.join(dir, '.planning', 'PROJECT.md');
    const target = path.join(dir, 'untrusted.md');
    fs.writeFileSync(target, '# Evil Title\n');
    fs.symlinkSync(target, file);
    assert.equal(preview(), fallback, 'symlink must not supply the title');
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'x'.repeat(8192) + '\n# Late Title\n');
    assert.equal(preview(), fallback, 'title beyond bounded prefix must not be read');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.equal(preview(), fallback, 'non-regular PROJECT.md must be rejected');
    fs.rmdirSync(file);
    if (process.platform !== 'win32') {
      const { execFileSync } = require('node:child_process');
      execFileSync('mkfifo', [file], { timeout: FIFO_FIXTURE_TIMEOUT_MS });
      const originalOpen = fs.openSync;
      let openedFifo = false;
      t.mock.method(fs, 'openSync', function (candidate, ...args) {
        if (candidate === file) { openedFifo = true; throw new Error('test prevents blocking FIFO open'); }
        return originalOpen.call(this, candidate, ...args);
      });
      assert.equal(preview(), fallback);
      assert.equal(openedFifo, false, 'non-regular title must be rejected before opening');
    }
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
  });

  test('M3 CONTEXT owns greppable alias, derived-code and custom-bracket facts', () => {
    const context = fs.readFileSync(path.join(__dirname, '..', 'CONTEXT.md'), 'utf8');
    for (const fact of [
      'CONFIG.phase-naming-alias=sequential is a case-insensitive deprecated alias for generated; writes warn and reads silently normalize',
      'CONFIG.derived-project-code=new bracket projects derive at most six characters from the first unfenced PROJECT.md title when present, otherwise the directory name',
      'SEAM.custom-bracket-add=phase add --id validates the full active project+milestone+phase+subphase identity; add-batch requires individual phase add --id commands',
    ]) assert.ok(context.includes(fact), fact);
    assert.doesNotMatch(context, /refuse a supplied `--id` or `phase_naming: "custom"`/);
  });

  test('m4 initialization docs name the PROJECT.md title and directory fallback', () => {
    for (const relative of ['gsd-core/workflows/new-project.md', 'gsd-core/workflows/new-project/steps/auto-mode-config.md', 'docs/CONFIGURATION.md', 'docs/CLI-TOOLS.md']) {
      const document = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      assert.match(document, /PROJECT\.md title when it exists, otherwise from the directory name/, relative);
    }
  });

  test('m6 changeset uses the bold change and symptom-led explanation form', () => {
    const fragment = fs.readFileSync(path.join(__dirname, '..', '.changeset', 'plucky-ibex-hop.md'), 'utf8');
    assert.match(fragment, /\*\*New projects use bracket phase IDs\*\* — Previously,/);
  });

  test('n1 custom bracket add has its own heading and no doubled blank line', () => {
    const document = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CLI-TOOLS.md'), 'utf8');
    assert.match(document, /### Custom bracket phase IDs\n\n/);
    const section = document.split('### Custom bracket phase IDs\n')[1].split('\n### ')[0];
    assert.doesNotMatch(section, /\n\n\n/);
  });

  test('n2 CLI docs name phase_id_collision beside usage', () => {
    const document = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CLI-TOOLS.md'), 'utf8');
    assert.match(document, /`usage`[^\n]*`phase_id_collision`/);
  });
});
