'use strict';

/**
 * `milestone complete --release-map <file>` (#5706, phase 2 of epic #3628;
 * design rows 6-15, test-matrix rows 6-16). Drives the real CLI against real
 * temporary project directories.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  readArchivedReleaseMap,
  MAX_RELEASE_MAP_ENTRIES,
  MAX_RELEASE_MAP_FIELD_LENGTH,
} = require('../gsd-core/bin/lib/milestone-release-map.cjs');

const STATE_MD = '---\nmilestone: v1.0\nstatus: executing\n---\n\n# Project State\n\n## Current Position\n\nPhase: 1\n';

function entry(overrides = {}) {
  return { repo: 'api', release: 'v1.2.0', reference: 'abc1234', environment: 'production', status: 'released', tag: 'created', ...overrides };
}

function makeProject() {
  const dir = createTempProject();
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
  fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE_MD);
  const phaseDir = path.join(dir, '.planning', 'phases', '01-foundation');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '---\none-liner: Shipped the foundation\n---\n# Summary\n');
  return dir;
}

/** Map every file under `root` (relative POSIX path) to its content. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

function writeMap(dir, value, name = 'release-map.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function complete(dir, extra = []) {
  return runGsdTools(['milestone', 'complete', 'v1.0', '--name', 'Golden', '--confirm', ...extra], dir);
}

const milestonesDir = (dir) => path.join(dir, '.planning', 'milestones');
const mapFilePath = (dir) => path.join(milestonesDir(dir), 'v1.0-RELEASE-MAP.json');

describe('milestone complete without --release-map is unchanged (row 6)', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { cleanup(dir); });

  test('result JSON, archive listing and MILESTONES.md entry equal the pre-change output', () => {
    const result = complete(dir);
    assert.ok(result.success, result.error);
    const out = JSON.parse(result.output);
    // Golden captured from the unmodified tree before the feature existed.
    assert.deepEqual(out, {
      version: 'v1.0',
      name: 'Golden',
      date: out.date,
      phases: 1,
      plans: 1,
      tasks: 0,
      accomplishments: ['Shipped the foundation'],
      archived: {
        roadmap: true,
        requirements: false,
        audit: false,
        phases: true,
        phases_archive_skipped: false,
        phases_archive_skip_reason: null,
        quick: false,
      },
      milestones_updated: true,
      state_updated: true,
      preservation_warnings: [],
    });
    assert.deepEqual(Object.keys(out), ['version', 'name', 'date', 'phases', 'plans', 'tasks', 'accomplishments', 'archived', 'milestones_updated', 'state_updated', 'preservation_warnings']);
    assert.ok(!('release_map' in out));
    assert.deepEqual(Object.keys(snapshot(milestonesDir(dir))).sort(), [
      'v1.0-ROADMAP.md',
      'v1.0-phases/01-foundation/01-01-PLAN.md',
      'v1.0-phases/01-foundation/01-01-SUMMARY.md',
    ]);
    assert.equal(
      fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8'),
      `# Milestones\n\n## v1.0 Golden (Shipped: ${out.date})\n\n**Phases completed:** 1 phases, 1 plans, 0 tasks\n\n**Key accomplishments:**\n- Shipped the foundation\n\n---\n`,
    );
    assert.equal(fs.existsSync(mapFilePath(dir)), false);
  });

  test('an archived milestone without a map reads back as "no map" (row 15)', () => {
    assert.ok(complete(dir).success);
    assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0'), { ok: true, map: null });
  });
});

describe('milestone complete --release-map archives the map (rows 7, 8, 9)', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { cleanup(dir); });

  test('writes RELEASE-MAP.json, appends the table and reports release_map', () => {
    const map = [
      entry(),
      entry({ repo: 'web', release: 'v3.0.1', reference: 'PR#42', environment: 'development', status: 'deployed', tag: 'already_tagged' }),
      entry({ repo: 'worker', release: null, reference: null, environment: null, status: 'unreleased', tag: 'skipped' }),
    ];
    const result = complete(dir, ['--release-map', writeMap(dir, map)]);
    assert.ok(result.success, result.error);
    const out = JSON.parse(result.output);
    assert.deepEqual(out.release_map, { path: '.planning/milestones/v1.0-RELEASE-MAP.json', entries: 3 });

    const archived = JSON.parse(fs.readFileSync(mapFilePath(dir), 'utf8'));
    assert.deepEqual(archived, { version: 'v1.0', entries: map });

    const md = fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8');
    assert.match(md, /\*\*Key accomplishments:\*\*\n- Shipped the foundation\n\n\*\*Release mapping:\*\*\n\n\| Repository \| Release \| Reference \| Environment \| Status \| Tag \|\n/);
    const rows = splitLines(md).filter((l) => /^\| (api|web|worker) /.test(l));
    assert.equal(rows.length, 3);
    assert.ok(rows[2].startsWith('| worker | - | - | - | unreleased | skipped |'));
    assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0'), { ok: true, map });
  });

  test('the rest of the archive is identical to a run without the flag', () => {
    const plain = makeProject();
    try {
      assert.ok(complete(plain).success);
      assert.ok(complete(dir, ['--release-map', writeMap(dir, [entry()])]).success);
      const a = snapshot(milestonesDir(plain));
      const b = snapshot(milestonesDir(dir));
      delete b['v1.0-RELEASE-MAP.json'];
      assert.deepEqual(b, a);
    } finally {
      cleanup(plain);
    }
  });

  test('repos outside planning.sub_repos are archived as recorded, never filtered (row 8)', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: ['only-this'] } }));
    const map = [entry({ repo: 'not-configured' }), entry({ repo: 'only-this' }), entry({ repo: 'removed-since' })];
    assert.ok(complete(dir, ['--release-map', writeMap(dir, map)]).success);
    assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0').map.map((e) => e.repo), ['not-configured', 'only-this', 'removed-since']);

    const empty = makeProject();
    try {
      fs.writeFileSync(path.join(empty, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: [] } }));
      assert.ok(complete(empty, ['--release-map', writeMap(empty, [entry({ repo: 'solo' })])]).success);
      assert.equal(readArchivedReleaseMap(milestonesDir(empty), 'v1.0').map.length, 1);
    } finally {
      cleanup(empty);
    }
  });

  test('unreleased, skipped and null-release repos remain in the map (row 9)', () => {
    const map = [
      entry({ repo: 'a', release: null, status: 'unreleased', tag: 'none' }),
      entry({ repo: 'b', status: 'released', tag: 'skipped' }),
    ];
    assert.ok(complete(dir, ['--release-map', writeMap(dir, map)]).success);
    assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0').map, map);
    const md = fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8');
    assert.match(md, /\| a \| - \| abc1234 \| production \| unreleased \| none \|/);
    assert.match(md, /\| b \| v1\.2\.0 \| abc1234 \| production \| released \| skipped \|/);
  });

  test('hostile field values are escaped in the table; the JSON archive keeps the raw value (row 11)', () => {
    const hostile = entry({
      repo: 'a|b',
      release: 'x\n## Injected\nmore',
      reference: '`tick` <img src=x>',
      environment: '# heading',
    });
    assert.ok(complete(dir, ['--release-map', writeMap(dir, [hostile])]).success);
    const md = fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8');
    assert.ok(!md.includes('## Injected'), 'no injected heading');
    assert.ok(!md.includes('<img'), 'no raw HTML');
    assert.equal((md.match(/^## /gm) || []).length, 1, 'only the milestone heading');
    assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0').map, [hostile]);
  });

  test('--dry-run validates and reports the map without writing anything', () => {
    const file = writeMap(dir, [entry()]);
    const before = snapshot(path.join(dir, '.planning'));
    const result = runGsdTools(['milestone', 'complete', 'v1.0', '--dry-run', '--release-map', file], dir);
    assert.ok(result.success, result.error);
    assert.deepEqual(snapshot(path.join(dir, '.planning')), before);
    assert.deepEqual(JSON.parse(result.output).would_archive.release_map, { target: '.planning/milestones/v1.0-RELEASE-MAP.json', entries: 1 });

    const bad = writeMap(dir, [{ repo: '' }], 'bad.json');
    assert.equal(runGsdTools(['milestone', 'complete', 'v1.0', '--dry-run', '--release-map', bad], dir).success, false);
    assert.deepEqual(snapshot(path.join(dir, '.planning')), before);
  });
});

describe('invalid maps write nothing (rows 10, 12)', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { cleanup(dir); });

  function assertRefusedWithoutWrites(extraArgs, pattern) {
    const before = snapshot(path.join(dir, '.planning'));
    const result = complete(dir, extraArgs);
    assert.equal(result.success, false, 'must fail');
    assert.match(result.error, pattern);
    assert.deepEqual(snapshot(path.join(dir, '.planning')), before, 'tree must be untouched');
    assert.equal(fs.existsSync(milestonesDir(dir)), false, 'no archive directory created');
    assert.equal(fs.readFileSync(path.join(dir, '.planning', 'STATE.md'), 'utf8'), STATE_MD);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'phases', '01-foundation')), 'phase directory not moved');
  }

  const invalid = [
    ['not an array', { repo: 'a' }, /array/],
    ['non-object entry', ['x'], /entries\[0\] must be an object/],
    ['blank repo', [entry({ repo: ' ' })], /repo must be a non-blank string/],
    ['number repo', [entry({ repo: 7 })], /repo must be a non-blank string/],
    ['unknown status', [entry({ status: 'shipped' })], /status must be one of/],
    ['unknown tag', [entry({ tag: 'maybe' })], /tag must be one of/],
    ['field of 201 characters', [entry({ release: 'x'.repeat(MAX_RELEASE_MAP_FIELD_LENGTH + 1) })], /exceeds 200/],
    ['257 entries', Array.from({ length: MAX_RELEASE_MAP_ENTRIES + 1 }, (_, i) => entry({ repo: `r${i}` })), /257 entries/],
    ['duplicate repo', [entry(), entry()], /duplicate/],
  ];
  for (const [name, value, pattern] of invalid) {
    test(`${name}`, () => {
      assertRefusedWithoutWrites(['--release-map', writeMap(dir, value)], pattern);
    });
  }

  test('lists every validation error', () => {
    const result = complete(dir, ['--release-map', writeMap(dir, [entry({ status: 'x' }), entry({ repo: 'b', tag: 'y' })])]);
    assert.equal(result.success, false);
    assert.match(result.error, /entries\[0\]\.status/);
    assert.match(result.error, /entries\[1\]\.tag/);
  });

  test('invalid JSON', () => {
    assertRefusedWithoutWrites(['--release-map', writeMap(dir, '{nope')], /release map/);
  });

  test('length and count limits: 200 characters and 256 entries are accepted', () => {
    const ok = Array.from({ length: MAX_RELEASE_MAP_ENTRIES }, (_, i) => entry({ repo: `r${i}`, release: 'x'.repeat(MAX_RELEASE_MAP_FIELD_LENGTH) }));
    const result = complete(dir, ['--release-map', writeMap(dir, ok)]);
    assert.ok(result.success, result.error);
    assert.equal(JSON.parse(result.output).release_map.entries, MAX_RELEASE_MAP_ENTRIES);
  });

  test('--release-map without a value is refused', () => {
    assertRefusedWithoutWrites(['--release-map'], /--release-map requires/);
  });

  test('a directory is refused', () => {
    const sub = path.join(dir, 'a-directory');
    fs.mkdirSync(sub);
    assertRefusedWithoutWrites(['--release-map', sub], /not a regular file/);
  });

  test('a missing path is refused', () => {
    assertRefusedWithoutWrites(['--release-map', path.join(dir, 'missing.json')], /cannot be read/);
  });

  test('a file over 1 MiB is refused', () => {
    assertRefusedWithoutWrites(['--release-map', writeMap(dir, `[${' '.repeat(1048577)}]`)], /maximum is 1048576/);
  });

  test('a FIFO is refused without blocking', (t) => {
    if (process.platform === 'win32') {
      t.skip('FIFOs are not available on Windows');
      return;
    }
    const fifo = path.join(os.tmpdir(), `gsd-relmap-fifo-${process.pid}-${Date.now()}`);
    const made = spawnSync('mkfifo', [fifo], { timeout: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    if (made.status !== 0) {
      t.skip('mkfifo unavailable');
      return;
    }
    try {
      assertRefusedWithoutWrites(['--release-map', fifo], /not a regular file/);
    } finally {
      fs.unlinkSync(fifo);
    }
  });
});

describe('archived maps are recorded values (rows 13, 14)', () => {
  let dir;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { cleanup(dir); });

  test('a re-run with a different map does not overwrite the archived map', () => {
    const first = [entry()];
    assert.ok(complete(dir, ['--release-map', writeMap(dir, first)]).success);
    const recorded = fs.readFileSync(mapFilePath(dir), 'utf8');
    const second = writeMap(dir, [entry({ repo: 'other', release: 'v9' })], 'second.json');
    const rerun = complete(dir, ['--force', '--release-map', second]);
    assert.equal(rerun.success, false);
    assert.match(rerun.error, /already exists/);
    assert.equal(fs.readFileSync(mapFilePath(dir), 'utf8'), recorded);
  });

  test('a re-run with an identical map leaves the archived map untouched', () => {
    const map = [entry()];
    const file = writeMap(dir, map);
    assert.ok(complete(dir, ['--release-map', file]).success);
    const recorded = fs.readFileSync(mapFilePath(dir), 'utf8');
    const rerun = complete(dir, ['--force', '--release-map', file]);
    assert.ok(rerun.success, rerun.error);
    assert.equal(fs.readFileSync(mapFilePath(dir), 'utf8'), recorded);
  });

  test('rewriting config and removing repos from sub_repos does not change the archived map', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ planning: { sub_repos: ['api', 'web'] } }));
    const map = [entry(), entry({ repo: 'web' })];
    assert.ok(complete(dir, ['--release-map', writeMap(dir, map)]).success);
    const recordedFile = fs.readFileSync(mapFilePath(dir), 'utf8');
    const recordedMd = fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8');

    for (const subRepos of [['web'], [], ['brand-new']]) {
      assert.ok(runGsdTools(['config-set', 'planning.sub_repos', JSON.stringify(subRepos)], dir).success);
      assert.equal(fs.readFileSync(mapFilePath(dir), 'utf8'), recordedFile);
      assert.equal(fs.readFileSync(path.join(dir, '.planning', 'MILESTONES.md'), 'utf8'), recordedMd);
      assert.deepEqual(readArchivedReleaseMap(milestonesDir(dir), 'v1.0').map, map);
    }
  });
});
