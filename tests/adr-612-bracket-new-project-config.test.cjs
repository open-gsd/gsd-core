'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

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
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'))), preview);
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
    const result = runGsdTools(['config-set', 'phase_naming', 'sequential'], dir, isolatedEnv({ home: dir }));
    assert.equal(result.success, true, result.error);
    assert.match(result.error, /deprecated/);
    const file = path.join(dir, '.planning', 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(file)).phase_naming, 'generated');
    fs.writeFileSync(file, JSON.stringify({ phase_naming: 'sequential' }));
    const before = fs.readFileSync(file, 'utf8');
    const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
    assert.equal(loadConfig(dir).phase_naming, 'generated');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});
