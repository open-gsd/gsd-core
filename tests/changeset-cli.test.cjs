'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'changeset', 'cli.cjs');
const { parseChangelog } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));

let tmp;

function writeFragment(name, type, pr, body) {
  fs.mkdirSync(path.join(tmp, '.changeset'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.changeset', `${name}.md`),
    `---\ntype: ${type}\npr: ${pr}\n---\n${body}\n`,
  );
}

function runRender(args = []) {
  const r = cp.spawnSync(
    process.execPath,
    [SCRIPT, 'render', '--repo', tmp, ...args, '--json'],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    report: r.stdout && r.stdout.length ? JSON.parse(r.stdout) : null,
    stderr: r.stderr || '',
  };
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-changeset-')); });
after(() => { cleanup(tmp); });

// Fixtures for extract tests (#3496)
// Written as arrays to avoid template-literal indentation injecting
// leading spaces that would break the ^## regex anchor.
const EXTRACT_CHANGELOG = [
  '# Changelog',
  '',
  '## [1.5.15] - 2026-01-20',
  '',
  '### Added',
  '',
  '- Feature X. (#200)',
  '',
  '## [1.5.14] - 2026-01-18',
  '',
  '### Fixed',
  '',
  '- Single-line fix. (#101)',
  '- **Multi-line fix** — first line of a long',
  '  description that spans two lines. (#102)',
  '',
  '## [1.5.13] - 2026-01-15',
  '',
  '### Fixed',
  '',
  '- Old fix. (#100)',
  '',
  '## [1.5.10] - 2026-01-01',
  '',
  '### Fixed',
  '',
  '- Very old fix. (#50)',
].join('\n');

function runExtract(args = [], changelogText = null) {
  const changelogFile = path.join(tmp, 'CHANGELOG-extract-test.md');
  if (changelogText !== null) {
    fs.writeFileSync(changelogFile, changelogText);
  }
  const r = cp.spawnSync(
    process.execPath,
    [SCRIPT, 'extract', '--changelog', changelogFile, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    json: (() => {
      try { return JSON.parse(r.stdout); } catch { return null; }
    })(),
  };
}

describe('changeset cli extract: version-range changelog extraction (#3496)', () => {
  test('exits 2 with no output when no versions fall in range', (t) => {
    const r = runExtract(['--from', '1.5.15', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 2, `expected exit 2 for empty range, stderr=${r.stderr}`);
    // F11: assert JSON structure is present and releases is empty array
    assert.ok(r.json, 'stdout must be valid JSON even on exit 2');
    assert.strictEqual(r.json.releases.length, 0, 'releases must be empty array on exit 2');
  });

  test('extracts versions strictly after from and up to and including to', (t) => {
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'), '1.5.15 must be in range (inclusive to)');
    assert.ok(versions.includes('1.5.14'), '1.5.14 must be in range (between from and to)');
    assert.ok(!versions.includes('1.5.13'), '1.5.13 must NOT be in range (exclusive from)');
    assert.ok(!versions.includes('1.5.10'), '1.5.10 must NOT be in range (below from)');
  });

  test('accepts v-prefixed version arguments', (t) => {
    const r = runExtract(['--from', 'v1.5.13', '--to', 'v1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'));
    assert.ok(versions.includes('1.5.14'));
    assert.ok(!versions.includes('1.5.13'));
  });

  test('captures multi-line bullets in extracted range', (t) => {
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.14', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const release = r.json.releases.find((rel) => rel.version === '1.5.14');
    assert.ok(release, '1.5.14 must be in result');
    const prs = release.sections.flatMap((s) => s.bullets.map((b) => b.pr));
    assert.ok(prs.includes(101), 'single-line bullet pr=101 must be captured');
    assert.ok(prs.includes(102), 'multi-line bullet pr=102 must be captured');
  });

  test('emits markdown text (non-JSON) when --json is not passed', (t) => {
    // Without --json the output is human-readable markdown, not JSON.
    // Assert on structural facts derivable from the text: exactly the two
    // matched releases appear as ## headers, using parseChangelog so we
    // assert on version strings via the production parser rather than
    // raw substring matches.
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const r = runExtract(['--from', '1.5.13', '--to', '1.5.15'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.stdout.trim().length > 0, 'stdout must be non-empty');
    const parsed = _pc(r.stdout);
    const versions = parsed.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.5.15'), '1.5.15 in markdown output');
    assert.ok(versions.includes('1.5.14'), '1.5.14 in markdown output');
    assert.ok(!versions.includes('1.5.13'), '1.5.13 must not appear in output (excluded by --from)');
  });

  test('missing --from or --to emits usage and exits non-zero', (t) => {
    const r = runExtract(['--from', '1.0.0'], EXTRACT_CHANGELOG);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.length > 0 || r.stdout.length > 0, 'must emit usage text');
  });

  test('rejects malformed --from semver (non-numeric component) with exit 1', (t) => {
    const r = runExtract(['--from', '1.41.x', '--to', '1.5.15', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 1, `expected exit 1 for malformed --from, stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON on error');
    assert.ok(typeof r.json.error === 'string', 'error field must be present');
    assert.ok(r.json.error.includes('--from'), 'error must mention --from');
  });

  test('rejects malformed --to semver (alphabetic) with exit 1', (t) => {
    const r = runExtract(['--from', '1.5.13', '--to', 'foo', '--json'], EXTRACT_CHANGELOG);
    assert.equal(r.status, 1, `expected exit 1 for malformed --to, stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON on error');
    assert.ok(typeof r.json.error === 'string', 'error field must be present');
    assert.ok(r.json.error.includes('--to'), 'error must mention --to');
  });

  test('preserves bullets without PR trailer in extracted output', (t) => {
    // Fixture with one no-PR bullet and one PR bullet.
    const CHANGELOG_NO_PR = [
      '# Changelog',
      '',
      '## [2.0.0] - 2026-01-01',
      '',
      '### Fixed',
      '',
      '- Documented fix without PR reference.',
      '- Fix with PR reference. (#999)',
    ].join('\n');
    const r = runExtract(['--from', '1.9.9', '--to', '2.0.0', '--json'], CHANGELOG_NO_PR);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const section = r.json.releases[0].sections[0];
    assert.equal(section.bullets.length, 2, 'both bullets (with and without PR) must be captured');
    const noPrBullet = section.bullets.find((b) => b.pr === null);
    assert.ok(noPrBullet, 'bullet without PR trailer must be present with pr: null');
    assert.ok(noPrBullet.body.includes('Documented fix'), 'body text preserved');
    const prBullet = section.bullets.find((b) => b.pr === 999);
    assert.ok(prBullet, 'bullet with PR trailer must still be captured');
  });

  // F2: pre-release entries must be excluded from range queries
  test('F2: pre-release entry 1.0.0-rc.1 is excluded from range --from 0.9.9 --to 1.0.0', (t) => {
    const CHANGELOG_WITH_PRERELEASE = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-03-01',
      '',
      '### Added',
      '',
      '- Stable release. (#10)',
      '',
      '## [1.0.0-rc.1] - 2026-02-28',
      '',
      '### Added',
      '',
      '- Release candidate. (#9)',
      '',
      '## [0.9.9] - 2026-02-01',
      '',
      '### Fixed',
      '',
      '- Prior fix. (#8)',
    ].join('\n');
    const r = runExtract(['--from', '0.9.9', '--to', '1.0.0', '--json'], CHANGELOG_WITH_PRERELEASE);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(r.json, 'stdout must be valid JSON');
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.0.0'), '1.0.0 must be in range');
    assert.ok(!versions.includes('1.0.0-rc.1'), '1.0.0-rc.1 (pre-release) must be excluded from range');
    assert.ok(!versions.includes('0.9.9'), '0.9.9 must not be in range (exclusive from)');
  });

  // F3: linked-header format ## [1.42.1](url) - date must parse date correctly
  test('F3: linked-header ## [1.42.1](url) - date parses date correctly', (t) => {
    const CHANGELOG_LINKED = [
      '# Changelog',
      '',
      '## [1.42.1](https://github.com/example/repo/releases/tag/v1.42.1) - 2026-05-15',
      '',
      '### Fixed',
      '',
      '- Linked header fix. (#300)',
      '',
      '## [1.42.0](https://github.com/example/repo/releases/tag/v1.42.0) - 2026-05-10',
      '',
      '### Added',
      '',
      '- Linked header feature. (#299)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_LINKED);
    const r1421 = parsed.releases.find((r) => r.version === '1.42.1');
    assert.ok(r1421, '1.42.1 must parse from linked header');
    assert.equal(r1421.date, '2026-05-15', 'date must be extracted from linked header');
    const r1420 = parsed.releases.find((r) => r.version === '1.42.0');
    assert.ok(r1420, '1.42.0 must parse from linked header');
    assert.equal(r1420.date, '2026-05-10', 'date must be extracted from linked header');
  });

  // F4: nested bullets must remain as separate bullets, not fold into parent
  test('F4: nested bullets are not folded into parent bullet', (t) => {
    const CHANGELOG_NESTED = [
      '# Changelog',
      '',
      '## [3.0.0] - 2026-06-01',
      '',
      '### Changed',
      '',
      '- Parent bullet. (#400)',
      '  - Nested child item.',
      '- Second top-level bullet. (#401)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_NESTED);
    const rel = parsed.releases.find((r) => r.version === '3.0.0');
    assert.ok(rel, '3.0.0 must parse');
    const section = rel.sections[0];
    // The nested bullet terminates the parent; second top-level bullet is separate.
    // We must have both PR 400 and PR 401 as distinct bullets.
    const prs = section.bullets.map((b) => b.pr);
    assert.ok(prs.includes(400), 'parent bullet pr=400 must be captured');
    assert.ok(prs.includes(401), 'second top-level bullet pr=401 must be captured');
    // The nested child must NOT have been folded into parent body
    const parentBullet = section.bullets.find((b) => b.pr === 400);
    assert.ok(!parentBullet.body.includes('Nested child'), 'nested child must not be folded into parent body');
  });

  // F5+F6: 4-part headers and v-prefix in-file headers
  test('F5+F6: 4-part version in CHANGELOG is skipped, v-prefixed version parses without v', (t) => {
    const CHANGELOG_EDGE = [
      '# Changelog',
      '',
      '## [v1.0.0] - 2026-04-01',
      '',
      '### Fixed',
      '',
      '- v-prefixed header fix. (#500)',
      '',
      '## [1.0.0.1] - 2026-03-15',
      '',
      '### Fixed',
      '',
      '- 4-part version fix. (#501)',
      '',
      '## [0.9.9] - 2026-03-01',
      '',
      '### Fixed',
      '',
      '- Old fix. (#499)',
    ].join('\n');
    const { parseChangelog: _pc } = require(path.join(ROOT, 'scripts', 'changeset', 'serialize.cjs'));
    const parsed = _pc(CHANGELOG_EDGE);

    // F6: v-prefixed version should be stored without the leading v
    const v100 = parsed.releases.find((r) => r.version === '1.0.0');
    assert.ok(v100, 'v-prefixed header must parse as version 1.0.0 (v stripped)');

    // Confirm extract skips 1.0.0.1 (4-part) — it appears in parsed but won't
    // satisfy SEMVER_RE inside the range filter
    const r = runExtract(['--from', '0.9.9', '--to', '1.0.0', '--json'], CHANGELOG_EDGE);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const versions = r.json.releases.map((rel) => rel.version);
    assert.ok(versions.includes('1.0.0'), '1.0.0 must be in range');
    assert.ok(!versions.includes('1.0.0.1'), '1.0.0.1 (4-part) must be excluded from range');
  });

  // F1: workflows/update.md must reference the extract subcommand invocation.
  // allow-test-rule: reads a product workflow .md file (not CJS source) to verify
  // the user-facing instruction was wired; there is no behavioural runtime to invoke.
  test('F1: workflows/update.md contains concrete extract subcommand invocation', (t) => {
    const workflowPath = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    // The invocation is: node "$GSD_DIR/gsd-core/scripts/changeset/cli.cjs" extract
    // so the literal substring is 'cli.cjs" extract' (quote between script path and subcommand)
    assert.ok(
      workflowText.includes('cli.cjs" extract') || workflowText.includes('cli.cjs extract'),
      'update.md must invoke cli.cjs extract (fix for #3496 BLOCKER 1)',
    );
    assert.ok(
      workflowText.includes('--from') && workflowText.includes('--to'),
      'update.md extract invocation must include --from and --to flags',
    );
    assert.ok(
      workflowText.includes('--json'),
      'update.md extract invocation must use --json for structured output',
    );
    assert.ok(
      workflowText.includes('EXTRACT_EXIT') || workflowText.includes('EXTRACT_JSON'),
      'update.md must capture exit code or JSON output from extract',
    );
  });
});

describe('changeset cli render: file-I/O wrapper (#2975)', () => {
  test('exits 0 with consumed=N when N fragments are folded into CHANGELOG.md and deleted', () => {
    cleanup(path.join(tmp, '.changeset'));
    fs.writeFileSync(
      path.join(tmp, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- prior fix (#1)\n',
    );
    writeFragment('aaa-bbb-ccc', 'Fixed', 100, 'fragment-driven fix.');
    writeFragment('ddd-eee-fff', 'Added', 101, 'fragment-driven feature.');

    const r = runRender(['--version', '1.1.0', '--date', '2026-05-01']);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.report.consumed, 2);
    assert.equal(r.report.failures.length, 0);

    // Round-trip: parsing the resulting CHANGELOG must reflect the new release
    // and preserve the prior one.
    const text = fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8');
    const parsed = parseChangelog(text);
    const v110 = parsed.releases.find((r) => r.version === '1.1.0');
    assert.ok(v110, 'new 1.1.0 release present');
    assert.deepEqual(
      v110.sections.map((s) => ({ type: s.type, prs: s.bullets.map((b) => b.pr) })),
      [{ type: 'Added', prs: [101] }, { type: 'Fixed', prs: [100] }],
    );
    const v100 = parsed.releases.find((r) => r.version === '1.0.0');
    assert.ok(v100, 'prior 1.0.0 release preserved');
    assert.equal(v100.sections[0].bullets[0].pr, 1);

    // Fragments deleted after consumption.
    const remaining = fs.readdirSync(path.join(tmp, '.changeset'));
    assert.deepEqual(remaining.filter((f) => f.endsWith('.md')), []);
  });
});

// ---------------------------------------------------------------------------
// GROUP A — #690 regression guard (real repo CHANGELOG.md)
// ---------------------------------------------------------------------------

describe('changeset cli #690 regression: CHANGELOG.md has 1.3.0 and 1.3.1 entries', () => {
  const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

  test('CHANGELOG.md has dated 1.3.0 and 1.3.1 release headings (regression #690)', () => {
    const text = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    const { releases } = parseChangelog(text);
    const stableReleases = releases.filter((r) => r.version !== 'Unreleased');

    const v130 = stableReleases.find((r) => r.version === '1.3.0');
    assert.ok(v130, 'CHANGELOG.md must contain a release entry for version 1.3.0');
    assert.ok(v130.date !== null && v130.date !== '', '1.3.0 entry must have a non-null, non-empty date');

    const v131 = stableReleases.find((r) => r.version === '1.3.1');
    assert.ok(v131, 'CHANGELOG.md must contain a release entry for version 1.3.1');
    assert.ok(v131.date !== null && v131.date !== '', '1.3.1 entry must have a non-null, non-empty date');
  });

  test('extract 1.2.0->1.3.1 against repo CHANGELOG returns both 1.3.x releases (regression #690)', () => {
    const r = cp.spawnSync(
      process.execPath,
      [SCRIPT, 'extract', '--from', '1.2.0', '--to', '1.3.1', '--changelog', CHANGELOG_PATH, '--json'],
      { encoding: 'utf8' },
    );
    const json = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    assert.equal(r.status, 0, `expected exit 0 but got ${r.status}; stderr=${r.stderr}; stdout=${r.stdout}`);
    assert.ok(json, 'stdout must be valid JSON');
    const versions = (json.releases || []).map((rel) => rel.version);
    assert.ok(versions.includes('1.3.0'), `releases array must include 1.3.0; got: ${JSON.stringify(versions)}`);
    assert.ok(versions.includes('1.3.1'), `releases array must include 1.3.1; got: ${JSON.stringify(versions)}`);
  });
});

// ---------------------------------------------------------------------------
// GROUP B — unit tests for the (not-yet-implemented) `verify` subcommand
// ---------------------------------------------------------------------------

function runVerify(args, changelogText) {
  const changelogFile = path.join(tmp, 'CHANGELOG-verify-test.md');
  fs.writeFileSync(changelogFile, changelogText);
  const r = cp.spawnSync(
    process.execPath,
    [SCRIPT, 'verify', '--changelog', changelogFile, ...args],
    { encoding: 'utf8' },
  );
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

describe('changeset cli verify subcommand (not yet implemented — TDD red step)', () => {
  // Fixture: inline-URL heading form  ## [1.3.1](url) - 2026-06-04
  const FIXTURE_URL_HEADING = [
    '# Changelog',
    '',
    '## [1.3.1](https://www.npmjs.com/package/@opengsd/gsd-core/v/1.3.1) - 2026-06-04',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: plain dated heading  ## [1.3.1] - 2026-06-04
  const FIXTURE_PLAIN_HEADING = [
    '# Changelog',
    '',
    '## [1.3.1] - 2026-06-04',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: version absent (only Unreleased + 1.2.0)
  const FIXTURE_NO_131 = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.0] - 2026-05-31',
    '',
    '### Added',
    '',
    '- Some feature. (#10)',
  ].join('\n');

  // Fixture: heading present but NO date
  const FIXTURE_NO_DATE = [
    '# Changelog',
    '',
    '## [1.3.1]',
    '',
    '### Fixed',
    '',
    '- Some fix. (#42)',
  ].join('\n');

  test('verify --version 1.3.1 exits 0 when inline-URL dated heading is present', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_URL_HEADING);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 0 when plain dated heading is present', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 1 when version heading is absent', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_131);
    assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 exits 1 when heading has no date', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_DATE);
    assert.equal(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 with no match emits non-empty stderr/message', () => {
    const r = runVerify(['--version', '1.3.1'], FIXTURE_NO_131);
    assert.ok(
      (r.stderr && r.stderr.trim().length > 0) || (r.stdout && r.stdout.trim().length > 0),
      'must emit a non-empty error message to stderr or stdout when version not found',
    );
  });

  test('verify --version 1.3.x exits 1 for invalid semver', () => {
    // Use any non-empty fixture; the version check should fail before reading the file.
    const r = runVerify(['--version', '1.3.x'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 1, `expected exit 1 for invalid semver 1.3.x; stderr=${r.stderr}`);
  });

  test('verify --version v1.3.1 (v-prefixed) exits 0 when dated heading present', () => {
    // The leading `v` must be stripped, matching extract's behavior.
    const FIXTURE_DATED = [
      '# Changelog',
      '',
      '## [1.3.1] - 2026-06-04',
      '',
      '### Fixed',
      '',
      '- Some fix. (#42)',
    ].join('\n');
    const r = runVerify(['--version', 'v1.3.1'], FIXTURE_DATED);
    assert.equal(r.status, 0, `expected exit 0 for v-prefixed version; stderr=${r.stderr}`);
  });

  test('verify --version 1.3.1 --json exits 0 and emits ok/version/date JSON fields', () => {
    const FIXTURE_DATED = [
      '# Changelog',
      '',
      '## [1.3.1] - 2026-06-04',
      '',
      '### Fixed',
      '',
      '- Some fix. (#42)',
    ].join('\n');
    const changelogFile = path.join(tmp, 'CHANGELOG-verify-test.md');
    fs.writeFileSync(changelogFile, FIXTURE_DATED);
    const r = cp.spawnSync(
      process.execPath,
      [SCRIPT, 'verify', '--version', '1.3.1', '--json', '--changelog', changelogFile],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    const json = (() => { try { return JSON.parse(r.stdout); } catch { return null; } })();
    assert.ok(json, 'stdout must be valid JSON');
    assert.strictEqual(json.ok, true, 'json.ok must be true');
    assert.strictEqual(json.version, '1.3.1', 'json.version must equal "1.3.1"');
    assert.ok(json.date && json.date.length > 0, 'json.date must be non-empty');
  });

  test('verify --version 1.3.1-rc.1 (pre-release) exits 1', () => {
    // Non-stable-triplet semver is rejected by the verify subcommand.
    const r = runVerify(['--version', '1.3.1-rc.1'], FIXTURE_PLAIN_HEADING);
    assert.equal(r.status, 1, `expected exit 1 for pre-release version; stderr=${r.stderr}`);
  });
});
