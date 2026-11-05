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
const os = require('node:os');
const path = require('node:path');

const { ExitError, runMain } = require('../lib/cli-exit.cjs');
const { parseChangelog, RELEASE_HEADING_RE, EMPTY_RELEASE_PLACEHOLDER } = require('../changeset/serialize.cjs');
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
  OUTPUT_NOT_ALLOWED: 'output-not-allowed',
  BUDGET_TOO_SMALL: 'budget-too-small',
});

class ChangelogNotesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangelogNotesError';
    this.code = code;
  }
}

// GitHub rejects release bodies over 125,000 characters; stay well inside.
const RELEASE_BODY_MAX_CHARS = 120000;

// Stricter than isStableTripletSemver (src/semver-compare.cts:49-51), which
// strips a leading `v` before testing: --previous must be a bare X.Y.Z, so a
// `v1.2.0` is rejected here rather than silently accepted.
const STRICT_TRIPLET_RE = /^\d+\.\d+\.\d+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function sliceBody(lines, startIdx, endIdx) {
  const body = lines.slice(startIdx, endIdx);
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return body.join('\n');
}

/**
 * Split a section body into ordered units: `###` headings, top-level bullets
 * (with their continuation lines) and any leading text. Raw lines are kept so
 * concatenating all units reproduces the body exactly.
 */
function splitUnits(body) {
  const units = [];
  for (const line of body.split('\n')) {
    if (/^#{3,6}\s/.test(line)) units.push({ kind: 'heading', lines: [line] });
    else if (/^[-*]\s/.test(line)) units.push({ kind: 'bullet', lines: [line] });
    else if (units.length === 0) units.push({ kind: 'text', lines: [line] });
    else units[units.length - 1].lines.push(line);
  }
  return units;
}

/**
 * @param {object} opts
 * @param {string} opts.changelog   Full CHANGELOG.md text.
 * @param {string} opts.version     Version, with or without a leading "v".
 * @param {string} [opts.packageName]
 * @param {string} [opts.repoSlug]
 * @param {string} [opts.previous]  Explicit previous release (strict X.Y.Z).
 * @param {number} [opts.maxChars]  Body budget (default RELEASE_BODY_MAX_CHARS).
 * @returns {string} Release body, trailing newline included.
 * @throws {ChangelogNotesError}
 */
function buildChangelogReleaseNotes({
  changelog,
  version,
  packageName = defaultPackageName,
  repoSlug = defaultRepoSlug,
  previous = null,
  maxChars = RELEASE_BODY_MAX_CHARS,
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
  const endIdx = relIdx + 1 < headingLines.length ? headingLines[relIdx + 1] : lines.length;
  const body = sliceBody(lines, headingLines[relIdx] + 1, endIdx);
  // `render --allow-empty` writes a dated heading plus a placeholder for a
  // zero-fragment release; that is a valid (if sparse) section.
  if (bulletCount === 0 && body !== EMPTY_RELEASE_PLACEHOLDER) {
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

  const install = [
    '## Install',
    '',
    '```bash',
    `npm i ${packageName}@${ver}`,
    '# or',
    `npm i ${packageName}@latest`,
    '```',
  ].join('\n');
  const footer = `**Full Changelog**: https://github.com/${repoSlug}/compare/v${prev}...v${ver}`;
  const changelogUrl = `https://github.com/${repoSlug}/blob/v${ver}/CHANGELOG.md`;
  const assemble = (bodyText, dropped) => {
    // An empty body (nothing fit) leaves just the heading, never a blank run.
    const parts = [install, bodyText ? `## What's Changed\n\n${bodyText}` : "## What's Changed"];
    if (dropped > 0) {
      const noun = dropped === 1 ? 'entry' : 'entries';
      parts.push(`_\u2026and ${dropped} more ${noun}. See the full [CHANGELOG](${changelogUrl})._`);
    }
    parts.push(footer);
    return parts.join('\n\n') + '\n';
  };

  const full = assemble(body, 0);
  if (full.length <= maxChars) return full;

  // Over budget: keep whole units (headings, bullets with continuations) in
  // order until the next one would not fit alongside the notice and footer.
  const units = splitUnits(body);
  let remaining = units.filter((u) => u.kind === 'bullet').length;
  // The smallest possible body carries no entries at all; if even that is over
  // budget no truncation can help, so fail instead of returning an oversized body.
  const floor = assemble('', remaining).length;
  if (floor > maxChars) {
    throw new ChangelogNotesError(
      CHANGELOG_NOTES_ERROR.BUDGET_TOO_SMALL,
      `release body budget ${maxChars} is below the ${floor}-character floor (install block, notice and footer)`,
    );
  }
  const kept = [];
  for (const unit of units) {
    const after = remaining - (unit.kind === 'bullet' ? 1 : 0);
    const candidate = [...kept, unit].map((u) => u.lines.join('\n')).join('\n').replace(/\s+$/, '');
    if (assemble(candidate, after).length > maxChars) break;
    kept.push(unit);
    remaining = after;
  }
  // Never leave a heading with no entries under it.
  while (kept.length > 0 && kept[kept.length - 1].kind === 'heading') kept.pop();
  const keptBullets = kept.filter((u) => u.kind === 'bullet').length;
  const dropped = units.filter((u) => u.kind === 'bullet').length - keptBullets;
  const keptBody = kept.map((u) => u.lines.join('\n')).join('\n').replace(/\s+$/, '');
  return assemble(keptBody, dropped);
}

/**
 * Resolve `--output` and require it to sit under the working directory, the OS
 * temp directory or RUNNER_TEMP (symlinks resolved on the parent directory).
 * An existing symlink as the final component is refused outright.
 * @returns {string} Absolute path to write.
 * @throws {ChangelogNotesError}
 */
function resolveOutputPath(output, { cwd = process.cwd(), tmpdir = os.tmpdir(), runnerTemp = process.env.RUNNER_TEMP } = {}) {
  const abs = path.resolve(cwd, output);
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(abs));
  } catch (_e) {
    throw new ChangelogNotesError(CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED, `--output directory does not exist: ${path.dirname(abs)}`);
  }
  const target = path.join(realParent, path.basename(abs));
  for (const root of [cwd, tmpdir, runnerTemp]) {
    if (!root) continue;
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch (_e) {
      continue;
    }
    if (target.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)) {
      let st = null;
      try {
        st = fs.lstatSync(target);
      } catch (_e) {
        st = null; // does not exist yet
      }
      if (st && st.isSymbolicLink()) {
        throw new ChangelogNotesError(CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED, `--output ${output} is a symbolic link`);
      }
      return target;
    }
  }
  throw new ChangelogNotesError(
    CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED,
    `--output ${output} is outside the working directory, the temp directory and RUNNER_TEMP`,
  );
}

/**
 * Write the body without following a symlink at the final path component.
 * O_NOFOLLOW (where defined) closes the window between resolveOutputPath's
 * lstat and the open; ELOOP is mapped to a typed error.
 * @throws {ChangelogNotesError}
 */
function writeOutput(target, body) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(target, flags, 0o644);
  } catch (err) {
    if (err && err.code === 'ELOOP') {
      throw new ChangelogNotesError(CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED, `--output ${target} is a symbolic link`);
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, body, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
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
  let outputPath;
  try {
    outputPath = resolveOutputPath(opts.output);
    body = buildChangelogReleaseNotes({
      changelog: fs.readFileSync(changelogPath, 'utf8'),
      version,
      packageName: opts.package || defaultPackageName,
      repoSlug: opts.repo || defaultRepoSlug,
      previous: opts.previous === undefined ? null : opts.previous,
    });
    writeOutput(outputPath, body);
  } catch (err) {
    if (err instanceof ChangelogNotesError) {
      throw new ExitError(1, `error[${err.code}]: ${err.message}`);
    }
    throw err;
  }
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  buildChangelogReleaseNotes,
  ChangelogNotesError,
  CHANGELOG_NOTES_ERROR,
  RELEASE_BODY_MAX_CHARS,
  resolveOutputPath,
  writeOutput,
  parseArgs,
};
