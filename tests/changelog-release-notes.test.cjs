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
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { EMPTY_RELEASE_PLACEHOLDER } = require('../scripts/changeset/serialize.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runNode, OUTCOME, formatSeamResult, assertSeamExit } = require('./helpers/process-seam.cjs');

const {
  buildChangelogReleaseNotes,
  ChangelogNotesError,
  CHANGELOG_NOTES_ERROR,
  RELEASE_BODY_MAX_CHARS,
  resolveOutputPath,
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

  test('a section with no content or no bullets fails with EMPTY_SECTION', () => {
    const noContent = '# Changelog\n\n## [1.0.1] - 2026-02-01\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- **x** — y. (#1)\n';
    const emptySubsection = '# Changelog\n\n## [1.0.1] - 2026-02-01\n\n### Fixed\n\n## [1.0.0] - 2026-01-01\n';
    assert.equal(codeOf(() => build({ changelog: noContent, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.EMPTY_SECTION);
    assert.equal(codeOf(() => build({ changelog: emptySubsection, version: '1.0.1' })), CHANGELOG_NOTES_ERROR.EMPTY_SECTION);
  });

  test('a zero-fragment release (render --allow-empty placeholder) is accepted and emitted as the body', () => {
    const changelog = `# Changelog\n\n## [1.0.1] - 2026-02-01\n\n${EMPTY_RELEASE_PLACEHOLDER}\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- **x** — y. (#1)\n`;
    const body = build({ changelog, version: '1.0.1' });
    assert.ok(body.includes(`## What's Changed\n\n${EMPTY_RELEASE_PLACEHOLDER}\n\n**Full Changelog**: `));
    assert.ok(body.endsWith('compare/v1.0.0...v1.0.1\n'));
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

// Every `###` heading in the What's Changed body must be followed (ignoring
// blank lines) by an entry, never by the truncation notice, another heading or
// the end of the section.
function assertNoDanglingHeading(body) {
  const lines = body.split('\n');
  lines.forEach((line, i) => {
    if (!/^### /.test(line)) return;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    assert.ok(j < lines.length, 'heading at end of body');
    assert.ok(/^[-*] /.test(lines[j]), `heading ${JSON.stringify(line)} followed by ${JSON.stringify(lines[j])}`);
  });
}

describe('release body budget (#5922)', () => {
  // A 1.8.0-sized section would exceed GitHub's 125,000-character body limit.
  function sectionOf(bulletCount, bulletBody) {
    const out = ['# Changelog', '', '## [2.0.0] - 2026-02-01', '', '### Fixed', ''];
    for (let i = 0; i < bulletCount; i++) out.push(`- **entry-${i}** — ${bulletBody}. (#${i})`);
    out.push('', '## [1.0.0] - 2026-01-01', '', '### Fixed', '', '- **old** — x. (#1)', '');
    return out.join('\n');
  }
  // Independent assembly of the smallest possible body (no entries kept) for a
  // 2.0.0 section of `n` bullets whose predecessor is 1.0.0.
  function zeroEntryBody(n) {
    const noun = n === 1 ? 'entry' : 'entries';
    return [
      '## Install',
      '',
      '```bash',
      `npm i ${PKG}@2.0.0`,
      '# or',
      `npm i ${PKG}@latest`,
      '```',
      '',
      "## What's Changed",
      '',
      `_\u2026and ${n} more ${noun}. See the full [CHANGELOG](https://github.com/${SLUG}/blob/v2.0.0/CHANGELOG.md)._`,
      '',
      `**Full Changelog**: https://github.com/${SLUG}/compare/v1.0.0...v2.0.0`,
      '',
    ].join('\n');
  }
  const buildSized = (changelog, extra) =>
    buildChangelogReleaseNotes({ changelog, version: '2.0.0', packageName: PKG, repoSlug: SLUG, ...extra });

  test('the budget sits under GitHub\'s 125,000-character limit', () => {
    assert.ok(RELEASE_BODY_MAX_CHARS < 125000);
  });

  test('bodies of budget-1, budget and budget+1 characters: only budget+1 is truncated', () => {
    // One bullet of adjustable length; the full body length is linear in it.
    const probe = buildSized(sectionOf(1, 'x'));
    const base = probe.length - 1; // body length minus the one-character filler
    for (const [delta, truncated] of [[-1, false], [0, false], [1, true]]) {
      const fill = RELEASE_BODY_MAX_CHARS + delta - base;
      const body = buildSized(sectionOf(1, 'x'.repeat(fill)));
      // delta 0 -> exactly the budget; the untruncated body is returned whole.
      // the one dropped bullet is announced in the singular
      assert.equal(body.includes('_\u2026and 1 more entry. See the full'), truncated, `delta ${delta}`);
      assert.equal(body.includes('more entries'), false, `delta ${delta}`);
      assert.ok(body.length <= RELEASE_BODY_MAX_CHARS, `delta ${delta}: ${body.length}`);
      if (!truncated) assert.equal(body.length, RELEASE_BODY_MAX_CHARS + delta);
    }
  });

  test('a truncated body keeps leading bullets whole, counts the rest and links the CHANGELOG', () => {
    const body = buildSized(sectionOf(3000, 'y'.repeat(60)));
    assert.ok(body.length <= RELEASE_BODY_MAX_CHARS);
    const kept = (body.match(/^- \*\*entry-\d+\*\*/gm) || []).length;
    assert.ok(kept > 0 && kept < 3000);
    assert.ok(body.includes('- **entry-0** —'));
    assert.ok(body.includes(`_\u2026and ${3000 - kept} more entries. See the full [CHANGELOG](https://github.com/${SLUG}/blob/v2.0.0/CHANGELOG.md)._\n\n**Full Changelog**: `));
    assert.ok(body.endsWith('compare/v1.0.0...v2.0.0\n'));
  });

  // Smallest budget the builder accepts, found by probing the builder itself.
  function floorOf(changelog, whole) {
    let floor = whole;
    for (let max = whole; max > 0; max--) {
      try {
        buildSized(changelog, { maxChars: max });
      } catch (err) {
        assert.equal(err.code, CHANGELOG_NOTES_ERROR.BUDGET_TOO_SMALL);
        break;
      }
      floor = max;
    }
    return floor;
  }

  test('floor-1 throws BUDGET_TOO_SMALL, floor returns the zero-entry body exactly, floor+1 stays within budget', () => {
    for (const bulletCount of [1, 3]) {
      const changelog = sectionOf(bulletCount, 'v'.repeat(80));
      const expected = zeroEntryBody(bulletCount);
      const floor = expected.length;
      assert.equal(codeOf(() => buildSized(changelog, { maxChars: floor - 1 })), CHANGELOG_NOTES_ERROR.BUDGET_TOO_SMALL, `n=${bulletCount}`);
      assert.equal(buildSized(changelog, { maxChars: floor }), expected, `n=${bulletCount}`);
      assert.ok(buildSized(changelog, { maxChars: floor + 1 }).length <= floor + 1, `n=${bulletCount}`);
    }
  });

  test('a cut landing right after the second subsection heading drops that heading', () => {
    const changelog = [
      '# Changelog', '', '## [2.0.0] - 2026-02-01', '',
      '### Added', '', '- **a1** — one. (#1)', '',
      '### Fixed', '', `- **f1** — ${'q'.repeat(300)}. (#2)`, '',
      '## [1.0.0] - 2026-01-01', '', '### Fixed', '', '- **old** — x. (#1)', '',
    ].join('\n');
    const whole = buildSized(changelog).length;
    const floor = floorOf(changelog, whole);
    let sawCutAfterHeading = false;
    // Sweep budgets from the untruncated size down to the builder's own floor.
    for (let max = whole; max >= floor; max--) {
      const body = buildSized(changelog, { maxChars: max });
      assert.ok(body.length <= max);
      assertNoDanglingHeading(body);
      if (body.includes('### Added') && !body.includes('### Fixed') && body.includes('more entry')) sawCutAfterHeading = true;
    }
    assert.ok(sawCutAfterHeading, 'sweep reached the case where only the first subsection survives');
  });

  test('when nothing fits there is no blank run, exactly one blank line between sections, and the count is singular', () => {
    const changelog = sectionOf(1, 'w'.repeat(500));
    const body = buildSized(changelog, { maxChars: 600 });
    assert.ok(body.length <= 600);
    assert.equal(body.includes('\n\n\n'), false);
    assert.ok(body.includes("## What's Changed\n\n_\u2026and 1 more entry. See the full"));
    assert.equal(body.includes('1 more entries'), false);
    const many = buildSized(sectionOf(50, 'w'.repeat(40)), { maxChars: 700 });
    assert.ok(/and \d+ more entries\./.test(many));
  });

  test('property: output never exceeds the budget and emits only verbatim bullets of the section, in order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 250, max: 6000 }),
        (sizes, maxChars) => {
          const bullets = sizes.map((n, i) => `- **b${i}** — ${'z'.repeat(n)}. (#${i})\n  continuation ${i}`);
          const changelog = [
            '# Changelog', '', '## [2.0.0] - 2026-02-01', '', '### Added', '',
            ...bullets, '', '## [1.0.0] - 2026-01-01', '', '### Fixed', '', '- **old** — x. (#1)', '',
          ].join('\n');
          let body;
          try {
            body = buildSized(changelog, { maxChars });
          } catch (err) {
            // Either the output fits, or the budget is below the zero-entry floor (well under 400).
            assert.ok(err instanceof ChangelogNotesError);
            assert.equal(err.code, CHANGELOG_NOTES_ERROR.BUDGET_TOO_SMALL);
            assert.ok(maxChars < zeroEntryBody(bullets.length).length, `floor error at ${maxChars}`);
            return;
          }
          assert.ok(body.length <= maxChars, `${body.length} > ${maxChars}`);
          const emitted = [];
          for (let i = 0; i < bullets.length; i++) if (body.includes(bullets[i])) emitted.push(i);
          // verbatim, a prefix of the section in order
          assert.deepEqual(emitted, bullets.slice(0, emitted.length).map((_b, i) => i));
          assert.equal((body.match(/^- \*\*b\d+\*\*/gm) || []).length, emitted.length);
          assert.equal(body.includes('more entries') || body.includes('more entry'), emitted.length < bullets.length);
          assertNoDanglingHeading(body);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('resolveOutputPath (#5922)', () => {
  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-out-'));
  }

  test('accepts paths under cwd, the OS temp dir and RUNNER_TEMP', () => {
    const cwd = tmp();
    const runner = tmp();
    try {
      assert.equal(path.basename(resolveOutputPath('notes.md', { cwd, tmpdir: '/nonexistent-5922', runnerTemp: null })), 'notes.md');
      assert.equal(path.dirname(resolveOutputPath(path.join(runner, 'n.md'), { cwd: '/nonexistent-5922', tmpdir: '/nonexistent-5922-b', runnerTemp: runner })), fs.realpathSync(runner));
      assert.ok(resolveOutputPath(path.join(os.tmpdir(), 'n.md'), { cwd: '/nonexistent-5922', runnerTemp: null }).endsWith('n.md'));
    } finally {
      cleanup(cwd);
      cleanup(runner);
    }
  });

  test('rejects paths outside every allowed root, traversal, a sibling-prefix dir and a missing directory', () => {
    const root = tmp();
    const cwd = path.join(root, 'work');
    const sibling = path.join(root, 'work-evil');
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling);
    const opts = { cwd, tmpdir: '/nonexistent-5922', runnerTemp: null };
    try {
      for (const bad of [path.join(sibling, 'n.md'), '../n.md', path.join(cwd, 'missing', 'n.md'), '/etc/n.md']) {
        assert.equal(codeOf(() => resolveOutputPath(bad, opts)), CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED, bad);
      }
    } finally {
      cleanup(root);
    }
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
    return runNode([SCRIPT, ...args], { timeoutMs: PROBE_TIMEOUT_MS });
  }
  // A timeout or spawn failure has exitCode null and must not pass as "non-zero".
  function assertFailed(r, label) {
    assert.equal(r.outcome, OUTCOME.EXITED, `${label}: ${formatSeamResult(r)}`);
    assert.notEqual(r.exitCode, 0, `${label} must fail`);
  }

  test('writes the body to --output', () => {
    withTmp((dir) => {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const output = path.join(dir, 'notes.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const res = run(['--version', '1.20.1', '--changelog', changelog, '--output', output, '--package', PKG, '--repo', SLUG]);
      assertSeamExit(assert, res, 0);
      assert.equal(fs.readFileSync(output, 'utf8'), EXPECTED_1_20_1);
    });
  });

  test('--tag is accepted in place of --version and --previous overrides detection', () => {
    withTmp((dir) => {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const output = path.join(dir, 'notes.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const res = run(['--tag', 'v1.20.1', '--changelog', changelog, '--output', output, '--previous', '1.19.0']);
      assertSeamExit(assert, res, 0);
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
        assertFailed(res, args.join(' '));
        assert.ok(res.stderr.includes(reason), `${args.join(' ')}: stderr should name ${reason}, got ${res.stderr}`);
        assert.equal(fs.existsSync(output), false, 'no body file on failure');
      }
      const missing = run(['--version', '1.20.1', '--changelog', path.join(dir, 'absent.md'), '--output', output]);
      assertFailed(missing, 'missing');
      const noOutput = run(['--version', '1.20.1', '--changelog', changelog]);
      assertFailed(noOutput, 'noOutput');
      const noVersion = run(['--changelog', changelog, '--output', output]);
      assertFailed(noVersion, 'noVersion');
      const outside = run(['--version', '1.20.1', '--changelog', changelog, '--output', '/etc/gsd-5922-notes.md']);
      assertFailed(outside, 'outside');
      assert.ok(outside.stderr.includes(CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED));
      const unknown = run(['--version', '1.20.1', '--changelog', changelog, '--output', output, '--bogus', 'x']);
      assertFailed(unknown, 'unknown');
    });
  });
});
