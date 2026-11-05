'use strict';

/**
 * #5922: the finalize job's GitHub Release body is built from the promoted
 * CHANGELOG.md section, not from GitHub's merged-PR list (empty for a hotfix
 * made of cherry-picks).
 *
 * Failure reasons are asserted on the typed CHANGELOG_NOTES_ERROR enum; the CLI
 * is driven as a bounded subprocess and asserted on exit status and the bytes
 * it writes.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  buildChangelogReleaseNotes,
  ChangelogNotesError,
  CHANGELOG_NOTES_ERROR,
} = require('../scripts/release-notes/changelog-release-notes.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release-notes', 'changelog-release-notes.cjs');
const PKG = '@opengsd/gsd-core';
const SLUG = 'open-gsd/gsd-core';

const CHANGELOG = [
  '# Changelog',
  '',
  'Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- **Unreleased thing** — not shipped yet. (#9001)',
  '',
  '## [1.20.1] - 2026-11-05',
  '',
  '### Fixed',
  '',
  '- **The fork-probe cache stays inside the project** — the cache no longer writes outside. (#5757) (#5908)',
  '- **`effort sync --apply` keeps the manifest** — wrapped',
  '  continuation line. (#5683) (#5899)',
  '',
  '## [1.20.0] - 2026-11-03',
  '',
  '### Added',
  '',
  '- **Pi can run GSD agent roles** — dispatch tool. (#5569) (#5575)',
  '',
  '### Changed',
  '',
  '- **Reviewer lanes cap their prompt** — refuse oversized. (#4559) (#5839)',
  '',
  '## [1.19.0] - 2026-10-01',
  '',
  '### Fixed',
  '',
  '- **Old fix** — long ago. (#1) (#2)',
  '',
].join('\n');

const EXPECTED_1_20_1 = [
  '## Install',
  '',
  '```bash',
  `npm i ${PKG}@1.20.1`,
  '# or',
  `npm i ${PKG}@latest`,
  '```',
  '',
  "## What's Changed",
  '',
  '### Fixed',
  '',
  '- **The fork-probe cache stays inside the project** — the cache no longer writes outside. (#5757) (#5908)',
  '- **`effort sync --apply` keeps the manifest** — wrapped',
  '  continuation line. (#5683) (#5899)',
  '',
  `**Full Changelog**: https://github.com/${SLUG}/compare/v1.20.0...v1.20.1`,
  '',
].join('\n');

function build(over) {
  return buildChangelogReleaseNotes({ changelog: CHANGELOG, version: '1.20.1', packageName: PKG, repoSlug: SLUG, ...over });
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ChangelogNotesError, `expected ChangelogNotesError, got ${err && err.stack}`);
    return err.code;
  }
  assert.fail('expected the builder to throw');
  return null;
}

describe('buildChangelogReleaseNotes (#5922)', () => {
  test('builds the exact body for a hotfix section, without the heading line', () => {
    assert.equal(build(), EXPECTED_1_20_1);
  });

  test('a leading v on the version is accepted', () => {
    assert.equal(build({ version: 'v1.20.1' }), EXPECTED_1_20_1);
  });

  test('keeps every subsection of a multi-section release and links to the previous release', () => {
    const body = build({ version: '1.20.0' });
    assert.ok(body.includes('### Added\n\n- **Pi can run GSD agent roles**'));
    assert.ok(body.includes('### Changed\n\n- **Reviewer lanes cap their prompt**'));
    assert.ok(body.endsWith(`**Full Changelog**: https://github.com/${SLUG}/compare/v1.19.0...v1.20.0\n`));
    assert.ok(!body.includes('Unreleased thing'));
    assert.ok(!body.includes('Old fix'));
  });

  test('never includes the [Unreleased] block', () => {
    assert.ok(!build().includes('Unreleased thing'));
  });

  test('CRLF changelogs produce LF output', () => {
    const body = build({ changelog: CHANGELOG.replace(/\n/g, '\r\n') });
    assert.equal(body, EXPECTED_1_20_1);
  });

  test('the section is chosen by exact version, not by prefix', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [1.2.10] - 2026-03-03',
      '',
      '### Fixed',
      '',
      '- **ten** — x. (#10)',
      '',
      '## [1.2.1] - 2026-03-02',
      '',
      '### Fixed',
      '',
      '- **one** — x. (#1)',
      '',
      '## [1.2.1-rc.1] - 2026-03-01',
      '',
      '### Fixed',
      '',
      '- **rc** — x. (#11)',
      '',
      '## [1.2.0] - 2026-02-01',
      '',
      '### Fixed',
      '',
      '- **zero** — x. (#0)',
      '',
    ].join('\n');
    const one = buildChangelogReleaseNotes({ changelog, version: '1.2.1', packageName: PKG, repoSlug: SLUG });
    assert.ok(one.includes('**one**') && !one.includes('**ten**') && !one.includes('**rc**'));
    // previous skips the rc heading and lands on the next stable triplet
    assert.ok(one.endsWith('compare/v1.2.0...v1.2.1\n'));
    const ten = buildChangelogReleaseNotes({ changelog, version: '1.2.10', packageName: PKG, repoSlug: SLUG });
    assert.ok(ten.includes('**ten**') && !ten.includes('**one**'));
    assert.ok(ten.endsWith('compare/v1.2.1...v1.2.10\n'));
    const rc = buildChangelogReleaseNotes({ changelog, version: '1.2.1-rc.1', packageName: PKG, repoSlug: SLUG });
    assert.ok(rc.includes('**rc**') && !rc.includes('**one**'));
  });

  test('a missing section fails with NO_SECTION', () => {
    assert.equal(codeOf(() => build({ version: '9.9.9' })), CHANGELOG_NOTES_ERROR.NO_SECTION);
    assert.equal(codeOf(() => build({ changelog: '' })), CHANGELOG_NOTES_ERROR.NO_SECTION);
  });

  test('an undated section fails with UNDATED_SECTION', () => {
    const changelog = '# Changelog\n\n## [1.0.1]\n\n### Fixed\n\n- **x** — y. (#1)\n\n## [1.0.0] - 2026-01-01\n';
    assert.equal(codeOf(() => build({ changelog, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.UNDATED_SECTION);
  });

  test('a section with no bullets fails with EMPTY_SECTION', () => {
    const noSubsections = '# Changelog\n\n## [1.0.1] - 2026-02-01\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- **x** — y. (#1)\n';
    const emptySubsection = '# Changelog\n\n## [1.0.1] - 2026-02-01\n\n### Fixed\n\n## [1.0.0] - 2026-01-01\n';
    assert.equal(codeOf(() => build({ changelog: noSubsections, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.EMPTY_SECTION);
    assert.equal(codeOf(() => build({ changelog: emptySubsection, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.EMPTY_SECTION);
  });

  test('no previous release heading fails with NO_PREVIOUS, and --previous overrides it', () => {
    const changelog = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- **first** — release. (#1)\n';
    assert.equal(codeOf(() => build({ changelog, version: '1.0.0' })), CHANGELOG_NOTES_ERROR.NO_PREVIOUS);
    const body = build({ changelog, version: '1.0.0', previous: '0.9.0' });
    assert.ok(body.endsWith('compare/v0.9.0...v1.0.0\n'));
  });

  test('an undated or non-triplet heading below does not count as the previous release', () => {
    const changelog = [
      '# Changelog', '',
      '## [1.0.1] - 2026-02-01', '', '### Fixed', '', '- **x** — y. (#1)', '',
      '## [1.0.1-rc.1] - 2026-01-20', '', '### Fixed', '', '- **r** — y. (#2)', '',
      '## [1.0.0]', '', '### Fixed', '', '- **u** — y. (#3)', '',
    ].join('\n');
    assert.equal(codeOf(() => build({ changelog, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.NO_PREVIOUS);
  });

  test('--previous is a strict X.Y.Z triplet: limit-1, limit, limit+1 parts', () => {
    assert.equal(codeOf(() => build({ previous: '1.2' })), CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS);
    assert.ok(build({ previous: '1.2.0' }).endsWith('compare/v1.2.0...v1.20.1\n'));
    assert.equal(codeOf(() => build({ previous: '1.2.0.0' })), CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS);
    for (const bad of ['v1.2.0', '1.2.0-rc.1', '1.x.0', '', ' 1.2.0', '1.2.0\n']) {
      assert.equal(codeOf(() => build({ previous: bad })), CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS, JSON.stringify(bad));
    }
  });

  test('a malformed version fails with INVALID_VERSION before any lookup', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'latest', '1.2.3 ', '1.2.3/../x']) {
      assert.equal(codeOf(() => build({ version: bad })), CHANGELOG_NOTES_ERROR.INVALID_VERSION, JSON.stringify(bad));
    }
  });

  test('property: returns exactly the requested version\'s bullets and never another version\'s', () => {
    const versionArb = fc
      .tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }))
      .map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(
        fc.uniqueArray(versionArb, { minLength: 2, maxLength: 8 }),
        fc.nat(),
        (versions, pick) => {
          const target = pick % (versions.length - 1); // never the last: it needs a predecessor
          const changelog = ['# Changelog', '', '## [Unreleased]', ''];
          versions.forEach((v, i) => {
            changelog.push(`## [${v}] - 2026-01-${String((i % 28) + 1).padStart(2, '0')}`, '', '### Fixed', '');
            changelog.push(`- **marker-${i}-a** — body ${i}. (#${100 + i})`, `- **marker-${i}-b** — body ${i}. (#${200 + i})`, '');
          });
          const body = buildChangelogReleaseNotes({
            changelog: changelog.join('\n'),
            version: versions[target],
            packageName: PKG,
            repoSlug: SLUG,
          });
          for (let i = 0; i < versions.length; i++) {
            const present = body.includes(`**marker-${i}-a**`) && body.includes(`**marker-${i}-b**`);
            const absent = !body.includes(`**marker-${i}-a**`) && !body.includes(`**marker-${i}-b**`);
            assert.ok(i === target ? present : absent, `version index ${i} vs target ${target}`);
          }
          assert.ok(body.endsWith(`compare/v${versions[target + 1]}...v${versions[target]}\n`));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('changelog-release-notes CLI (#5922)', () => {
  function withTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-'));
    try {
      return fn(dir);
    } finally {
      cleanup(dir);
    }
  }
  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  }

  test('writes the body to --output', () => {
    withTmp((dir) => {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const output = path.join(dir, 'notes.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const res = run(['--version', '1.20.1', '--changelog', changelog, '--output', output, '--package', PKG, '--repo', SLUG]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), EXPECTED_1_20_1);
    });
  });

  test('--tag is accepted in place of --version and --previous overrides detection', () => {
    withTmp((dir) => {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const output = path.join(dir, 'notes.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const res = run(['--tag', 'v1.20.1', '--changelog', changelog, '--output', output, '--previous', '1.19.0']);
      assert.equal(res.status, 0, res.stderr);
      assert.ok(fs.readFileSync(output, 'utf8').endsWith('compare/v1.19.0...v1.20.1\n'));
    });
  });

  test('every failure mode exits non-zero, names its typed reason and writes nothing', () => {
    withTmp((dir) => {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const output = path.join(dir, 'notes.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const cases = [
        { args: ['--version', '9.9.9'], reason: CHANGELOG_NOTES_ERROR.NO_SECTION },
        { args: ['--version', '1.20.1', '--previous', '1.2'], reason: CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS },
        { args: ['--version', '1.20.1', '--previous', '1.2.0.0'], reason: CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS },
        { args: ['--version', 'nope'], reason: CHANGELOG_NOTES_ERROR.INVALID_VERSION },
      ];
      for (const { args, reason } of cases) {
        const res = run([...args, '--changelog', changelog, '--output', output]);
        assert.notEqual(res.status, 0, `${args.join(' ')} must fail`);
        assert.ok(res.stderr.includes(reason), `${args.join(' ')}: stderr should name ${reason}, got ${res.stderr}`);
        assert.equal(fs.existsSync(output), false, 'no body file on failure');
      }
      const missing = run(['--version', '1.20.1', '--changelog', path.join(dir, 'absent.md'), '--output', output]);
      assert.notEqual(missing.status, 0);
      const noOutput = run(['--version', '1.20.1', '--changelog', changelog]);
      assert.notEqual(noOutput.status, 0);
      const noVersion = run(['--changelog', changelog, '--output', output]);
      assert.notEqual(noVersion.status, 0);
      const unknown = run(['--version', '1.20.1', '--changelog', changelog, '--output', output, '--bogus', 'x']);
      assert.notEqual(unknown.status, 0);
    });
  });
});
