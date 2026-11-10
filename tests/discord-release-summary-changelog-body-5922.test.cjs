'use strict';

/**
 * #5922: the release body is now the CHANGELOG section, whose subsections use
 * Keep-a-Changelog names. The Discord summary must bucket them.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChangelogReleaseNotes,
} = require('../scripts/release-notes/changelog-release-notes.cjs');
const { classifyTitle } = require('../scripts/release-notes/format-github-release-notes.cjs');
const {
  buildDiscordReleasePayload,
  collectSections,
} = require('../scripts/release-notes/discord-release-summary.cjs');

const PKG = '@opengsd/gsd-core';
const CHANGELOG = [
  '# Changelog',
  '',
  '## [1.21.0] - 2026-12-01',
  '',
  '### Added',
  '',
  '- **Pi can run GSD agent roles** — Pi has no subagent primitive, so workflows stopped. (#5569) (#5575)',
  '',
  '### Changed',
  '',
  '- **Reviewer lanes cap their prompt** — refuse oversized prompts. (#4559) (#5839)',
  '',
  '### Deprecated',
  '',
  '- **Old flag** — use the new one. (#3)',
  '',
  '### Removed',
  '',
  '- **Legacy installer path** — gone. (#4)',
  '',
  '### Fixed',
  '',
  '- **The fork-probe cache stays inside the project** — the cache no longer writes outside. (#5757) (#5908)',
  '- **`effort sync --apply` keeps the manifest** — wrapped',
  '  continuation line. (#5683) (#5899)',
  '  - nested detail that is not its own entry',
  '',
  '### Security',
  '',
  '- **Path traversal closed** — fixed. (#7)',
  '',
  '## [1.20.0] - 2026-11-03',
  '',
  '### Fixed',
  '',
  '- **Old** — x. (#1)',
  '',
].join('\n');

const body = buildChangelogReleaseNotes({ changelog: CHANGELOG, version: '1.21.0', packageName: PKG, repoSlug: 'open-gsd/gsd-core' });

describe('discord summary of a CHANGELOG-built release body (#5922)', () => {
  test('Keep-a-Changelog subsections land in the matching buckets', () => {
    const sections = collectSections(body);
    assert.deepEqual(sections.get('Feature'), ['Pi can run GSD agent roles (#5569) (#5575)']);
    assert.deepEqual(sections.get('Fix'), [
      'The fork-probe cache stays inside the project (#5757) (#5908)',
      '`effort sync --apply` keeps the manifest (#5683) (#5899)',
    ]);
    assert.deepEqual(sections.get('Enhancement'), ['Reviewer lanes cap their prompt (#4559) (#5839)']);
    assert.deepEqual(sections.get('Deprecated'), ['Old flag (#3)']);
    assert.deepEqual(sections.get('Removed'), ['Legacy installer path (#4)']);
    assert.equal(sections.has('Breaking'), false);
    assert.deepEqual(sections.get('Security'), ['Path traversal closed (#7)']);
  });

  test('nothing from the install block or the compare link becomes a bullet', () => {
    const all = [...collectSections(body).values()].flat();
    assert.equal(all.some((b) => b.includes('npm i') || b.includes('compare/')), false);
  });

  test('the payload lists Fixed bullets under Fixes and Added under Features', () => {
    const payload = buildDiscordReleasePayload({
      release: { tagName: 'v1.21.0', name: 'v1.21.0', isPrerelease: false, url: 'https://github.com/open-gsd/gsd-core/releases/tag/v1.21.0', body },
      packageName: PKG,
      maxContent: 1850,
    });
    const lines = payload.content.split('\n');
    const featuresAt = lines.indexOf('**Features**');
    const fixesAt = lines.indexOf('**Fixes**');
    assert.ok(featuresAt > -1 && fixesAt > -1, 'both groups are present');
    assert.ok(lines[featuresAt + 1].startsWith('- Pi can run GSD agent roles'));
    assert.ok(lines[fixesAt + 1].startsWith('- The fork-probe cache stays inside the project'));
    assert.equal(payload.content.includes('npm i @opengsd/gsd-core@1.21.0'), true);
    const removedAt = lines.indexOf('**Removed**');
    const deprecatedAt = lines.indexOf('**Deprecated**');
    assert.ok(removedAt > -1 && deprecatedAt > -1, 'Removed and Deprecated keep their own groups');
    assert.ok(lines.indexOf('**Security**') < removedAt && removedAt < deprecatedAt && deprecatedAt < featuresAt);
  });

  test('old-format GitHub-generated bodies are still bucketed by title', () => {
    const sections = collectSections([
      "## What's Changed",
      '* feat: add thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/10',
      '* fix: repair thing by @trek-e in https://github.com/open-gsd/gsd-core/pull/11',
    ].join('\n'));
    assert.deepEqual(sections.get('Feature'), ['add thing (#10)']);
    assert.deepEqual(sections.get('Fix'), ['repair thing (#11)']);
  });

  test('old-format bodies are summarised exactly as before: bold bullets, indented lines and all', () => {
    const boldBullet = '* **Breaking** - drop Node 18 by @x in https://github.com/o/r/pull/12';
    const indented = '  * indented line by @y in https://github.com/o/r/pull/13';
    const sections = collectSections(["## What's Changed", boldBullet, indented].join('\n'));
    // base behaviour: every bullet, indented or not, is its own entry; ** is stripped, no headline reduction.
    const expected = new Map();
    for (const [line, text] of [[boldBullet, 'Breaking - drop Node 18 (#12)'], [indented, 'indented line (#13)']]) {
      const bucket = classifyTitle(line.trim());
      expected.set(bucket, [...(expected.get(bucket) || []), text]);
    }
    assert.deepEqual([...sections], [...expected]);
  });

  test('old-format bodies with their own ### Feature/Fix headings keep bold bullets verbatim', () => {
    const sections = collectSections([
      "## What's Changed",
      '### Feature',
      '* **Big thing** - with a long explanation by @x in https://github.com/o/r/pull/20',
      '  continuation that base ignored',
    ].join('\n'));
    assert.deepEqual(sections.get('Feature'), ['Big thing - with a long explanation (#20)']);
  });

  test('a Security-only CHANGELOG body is summarised to headlines with their refs', () => {
    const securityBody = buildChangelogReleaseNotes({
      changelog: [
        '# Changelog', '', '## [1.21.1] - 2026-12-02', '', '### Security', '',
        '- **Path traversal closed** — long explanation here. (#7) (#8)',
        '- **Token no longer logged** — more explanation. (#9)', '',
        '## [1.21.0] - 2026-12-01', '', '### Fixed', '', '- **x** — y. (#1)', '',
      ].join('\n'),
      version: '1.21.1',
      packageName: PKG,
      repoSlug: 'open-gsd/gsd-core',
    });
    assert.deepEqual(collectSections(securityBody).get('Security'), [
      'Path traversal closed (#7) (#8)',
      'Token no longer logged (#9)',
    ]);
  });

  test('an old-format body with a Removed heading is now bucketed under Removed', () => {
    const sections = collectSections(['## Removed', '* dropped thing by @x in https://github.com/o/r/pull/30'].join('\n'));
    assert.deepEqual(sections.get('Removed'), ['dropped thing (#30)']);
  });
});
