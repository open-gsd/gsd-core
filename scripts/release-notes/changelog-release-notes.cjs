#!/usr/bin/env node
'use strict';

/**
 * Build a stable GitHub Release body from the release's CHANGELOG.md section
 * (#5922).
 *
 * GitHub's generated notes list PRs whose merge commits lie in the tag range.
 * A hotfix's fixes are cherry-picks with new shas, so that list is empty for
 * them. The curated record is the `## [X.Y.Z] - DATE` section that the
 * finalize job's "Promote CHANGELOG" step writes, so the body is built from it.
 *
 * Usage:
 *   node scripts/release-notes/changelog-release-notes.cjs --version <X.Y.Z> \
 *     --output <file> [--changelog <path>] [--package <name>] [--repo <owner/repo>] \
 *     [--previous <X.Y.Z>]
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('../lib/cli-exit.cjs');
const { parseChangelog, RELEASE_HEADING_RE } = require('../changeset/serialize.cjs');
const { isStableTripletSemver } = require('../../gsd-core/bin/lib/semver-compare.cjs');
const { packageName: defaultPackageName, repoSlug: defaultRepoSlug } = require('../../gsd-core/bin/lib/package-identity.cjs');

/** Typed failure reasons; every one maps to a non-zero CLI exit. */
const CHANGELOG_NOTES_ERROR = Object.freeze({
  INVALID_VERSION: 'invalid-version',
  INVALID_PREVIOUS: 'invalid-previous',
  NO_SECTION: 'no-section',
  UNDATED_SECTION: 'undated-section',
  EMPTY_SECTION: 'empty-section',
  NO_PREVIOUS: 'no-previous',
});

class ChangelogNotesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangelogNotesError';
    this.code = code;
  }
}

const STRICT_TRIPLET_RE = /^\d+\.\d+\.\d+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function sliceBody(lines, startIdx, endIdx) {
  const body = lines.slice(startIdx, endIdx);
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.changelog   Full CHANGELOG.md text.
 * @param {string} opts.version     Version, with or without a leading "v".
 * @param {string} [opts.packageName]
 * @param {string} [opts.repoSlug]
 * @param {string} [opts.previous]  Explicit previous release (strict X.Y.Z).
 * @returns {string} Release body, trailing newline included.
 * @throws {ChangelogNotesError}
 */
function buildChangelogReleaseNotes({
  changelog,
  version,
  packageName = defaultPackageName,
  repoSlug = defaultRepoSlug,
  previous = null,
}) {
  const ver = String(version || '').replace(/^v/, '');
  if (!VERSION_RE.test(ver)) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.INVALID_VERSION,
      `invalid version "${version}" (expected X.Y.Z or X.Y.Z-prerelease)`,
    );
  }
  if (previous !== null && previous !== undefined && !STRICT_TRIPLET_RE.test(String(previous))) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.INVALID_PREVIOUS,
      `invalid --previous "${previous}" (expected a strict X.Y.Z triplet)`,
    );
  }

  const text = String(changelog || '');
  const { releases } = parseChangelog(text);
  const lines = text.split(/\r?\n/);
  // parseChangelog pushes exactly one release per heading line matched by
  // RELEASE_HEADING_RE, so heading line i belongs to releases[i].
  const headingLines = [];
  lines.forEach((line, idx) => {
    if (RELEASE_HEADING_RE.test(line)) headingLines.push(idx);
  });

  const relIdx = releases.findIndex((r) => r.version === ver);
  if (relIdx === -1) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.NO_SECTION,
      `CHANGELOG.md has no \`## [${ver}]\` section`,
    );
  }
  const release = releases[relIdx];
  if (!release.date) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.UNDATED_SECTION,
      `CHANGELOG.md heading \`## [${ver}]\` has no date (expected \`## [${ver}] - YYYY-MM-DD\`)`,
    );
  }
  const bulletCount = release.sections.reduce((n, s) => n + s.bullets.length, 0);
  if (bulletCount === 0) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.EMPTY_SECTION,
      `CHANGELOG.md section \`## [${ver}]\` has no bullets`,
    );
  }

  let prev = previous === null || previous === undefined ? null : String(previous);
  if (prev === null) {
    const earlier = releases
      .slice(relIdx + 1)
      .find((r) => r.date && isStableTripletSemver(r.version));
    if (!earlier) {
      throw new ChangelogNotesError(
        CHANGELOG_NOTES_ERROR.NO_PREVIOUS,
        `CHANGELOG.md has no dated X.Y.Z section below \`## [${ver}]\`; pass --previous <X.Y.Z>`,
      );
    }
    prev = earlier.version;
  }

  const endIdx = relIdx + 1 < headingLines.length ? headingLines[relIdx + 1] : lines.length;
  const body = sliceBody(lines, headingLines[relIdx] + 1, endIdx);

  return [
    [
      '## Install',
      '',
      '```bash',
      `npm i ${packageName}@${ver}`,
      '# or',
      `npm i ${packageName}@latest`,
      '```',
    ].join('\n'),
    `## What's Changed\n\n${body}`,
    `**Full Changelog**: https://github.com/${repoSlug}/compare/v${prev}...v${ver}`,
  ].join('\n\n') + '\n';
}

const FLAGS_WITH_VALUE = new Set([
  '--version', '--tag', '--changelog', '--output', '--package', '--repo', '--previous',
]);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAGS_WITH_VALUE.has(arg)) throw new ExitError(2, `error: unknown argument ${arg}`);
    const value = argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new ExitError(2, `error: ${arg} requires a value`);
    }
    opts[arg.slice(2)] = value;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const version = opts.version || opts.tag;
  if (!version) throw new ExitError(2, 'error: --version <X.Y.Z> is required');
  if (!opts.output) throw new ExitError(2, 'error: --output <file> is required');

  const changelogPath = path.resolve(opts.changelog || path.join(__dirname, '..', '..', 'CHANGELOG.md'));
  if (!fs.existsSync(changelogPath)) {
    throw new ExitError(1, `error: CHANGELOG not found: ${changelogPath}`);
  }

  let body;
  try {
    body = buildChangelogReleaseNotes({
      changelog: fs.readFileSync(changelogPath, 'utf8'),
      version,
      packageName: opts.package || defaultPackageName,
      repoSlug: opts.repo || defaultRepoSlug,
      previous: opts.previous === undefined ? null : opts.previous,
    });
  } catch (err) {
    if (err instanceof ChangelogNotesError) {
      throw new ExitError(1, `error[${err.code}]: ${err.message}`);
    }
    throw err;
  }
  fs.writeFileSync(path.resolve(opts.output), body, 'utf8');
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  buildChangelogReleaseNotes,
  ChangelogNotesError,
  CHANGELOG_NOTES_ERROR,
  parseArgs,
};
