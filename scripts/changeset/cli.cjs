#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper for the changeset-fragment workflow (#2975).
 *
 * Subcommands:
 *   render --repo <dir> --version V --date D [--json]   Fold .changeset/*.md
 *                                                       into CHANGELOG.md;
 *                                                       delete consumed fragments.
 *
 * `--json` emits a structured report on stdout — the only contract tests
 * assert against. Per CONTRIBUTING.md "Prohibited: Raw Text Matching on
 * Test Outputs", the human formatter is operator-only.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('../lib/cli-exit.cjs');
const { parseFragment } = require('./parse.cjs');
const { renderChangelog } = require('./render.cjs');
const { serializeChangelog, parseChangelog } = require('./serialize.cjs');
const { renderGithubReleaseNotes } = require('./github-release-notes.cjs');
const {
  compareSemverCore,
  isStableTripletSemver,
} = require('../../gsd-core/bin/lib/semver-compare.cjs');
const { packageName, repoSlug: defaultRepoSlug } = require('../../gsd-core/bin/lib/package-identity.cjs');

function parseArgs(argv) {
  const opts = {
    cmd: null,
    repo: process.cwd(),
    version: null,
    date: null,
    fromRef: null,
    toRef: null,
    changelog: null,
    output: null,
    repoSlug: defaultRepoSlug,
    installCommand: `npx ${packageName}@latest`,
    json: false,
    allowEmpty: false,
    preview: false,
  };
  if (argv.length === 0) return { ok: true, opts };
  opts.cmd = argv[0];

  // Pull a value for a value-taking flag, validating that the next token
  // exists and is not itself another flag (which is the silently-misparsed
  // case CR called out: e.g. `--repo --json` would consume `--json` as the
  // repo path).
  const requireValue = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      return { ok: false, error: `missing value for ${flag}` };
    }
    return { ok: true, value: v };
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--allow-empty') { opts.allowEmpty = true; continue; }
    if (a === '--preview') { opts.preview = true; continue; }
    if (
      a === '--repo' ||
      a === '--version' ||
      a === '--date' ||
      a === '--from' ||
      a === '--to' ||
      a === '--changelog' ||
      a === '--output' ||
      a === '--repo-slug' ||
      a === '--install-command'
    ) {
      const r = requireValue(a, i);
      if (!r.ok) return { ok: false, error: r.error };
      if (a === '--repo') opts.repo = r.value;
      else if (a === '--version') opts.version = r.value;
      else if (a === '--date') opts.date = r.value;
      else if (a === '--from') opts.fromRef = r.value;
      else if (a === '--to') opts.toRef = r.value;
      else if (a === '--changelog') opts.changelog = r.value;
      else if (a === '--output') opts.output = r.value;
      else if (a === '--repo-slug') opts.repoSlug = r.value;
      else if (a === '--install-command') opts.installCommand = r.value;
      i++;
      continue;
    }
    return { ok: false, error: `unknown argument: ${a}` };
  }
  return { ok: true, opts };
}

function listFragmentFiles(changesetDir) {
  if (!fs.existsSync(changesetDir)) return [];
  return fs.readdirSync(changesetDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => path.join(changesetDir, f));
}

function splitChangelog(text) {
  // Split off the top-level "# Changelog" heading + lead matter (everything
  // before the first "## [version]" block) from the rest. The rest is the
  // priorChangelog passed into renderChangelog. The "## [Unreleased]" block,
  // if present, is dropped (the new release replaces it).
  const lines = text.split(/\r?\n/);
  const firstReleaseIdx = lines.findIndex((l) => /^##\s+\[/.test(l));
  if (firstReleaseIdx === -1) {
    return { lead: text.replace(/\s+$/, ''), prior: '' };
  }
  const lead = lines.slice(0, firstReleaseIdx).join('\n').replace(/\s+$/, '');
  let priorStart = firstReleaseIdx;
  // Skip the [Unreleased] block if present — it's a placeholder, not a release.
  if (/^##\s+\[Unreleased\]/i.test(lines[firstReleaseIdx])) {
    let j = firstReleaseIdx + 1;
    while (j < lines.length && !/^##\s+\[/.test(lines[j])) j++;
    priorStart = j;
  }
  const prior = lines.slice(priorStart).join('\n').trimStart();
  return { lead, prior };
}

// FIX 2: tiny local helper so both render paths share identical assembly logic.
function assembleChangelog(lead, releaseBlock) {
  return [
    lead || '# Changelog',
    '',
    '## [Unreleased]',
    '',
    releaseBlock.replace(/\s+$/, ''),
    '',
  ].join('\n');
}

// Insert a "_No notable changes._" placeholder after the dated release heading
// of an otherwise-empty release block. serializeChangelog with no sections
// yields just "## [v] - d\n"; we expand the trailing newline into a blank line
// + placeholder + blank line so parseChangelog still sees the dated heading
// first and the output is human-readable. Shared by the --allow-empty and
// --preview zero-fragment paths so they can never drift.
function injectEmptyPlaceholder(headerOnlyBlock) {
  return headerOnlyBlock.replace(
    /^(##\s+\[[^\]]+\][^\n]*)\n+/,
    '$1\n\n_No notable changes._\n\n',
  );
}

function cmdRender(opts) {
  const repo = path.resolve(opts.repo);
  const changesetDir = path.join(repo, '.changeset');
  const changelogPath = path.join(repo, 'CHANGELOG.md');
  const fragmentFiles = listFragmentFiles(changesetDir);

  const fragments = [];
  const failures = [];
  for (const file of fragmentFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const r = parseFragment(src);
    if (r.ok) fragments.push({ ...r.fragment, file });
    else failures.push({ file: path.relative(repo, file), reason: r.reason, detail: r.detail || null });
  }

  // 1. parse-failure → exitCode 1 (unchanged).
  if (failures.length > 0) {
    return { exitCode: 1, report: { consumed: 0, failures } };
  }

  // 2. Read priorText once; reuse in all subsequent branches.
  const priorText = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';

  // Preview mode (#759): render the dated release section WITHOUT writing
  // CHANGELOG.md and WITHOUT consuming .changeset fragments. Used by the rc
  // release job to surface the curated notes for the version under test while
  // leaving the fragment set intact for the eventual finalize render.
  if (opts.preview) {
    // priorChangelog is intentionally null: a preview shows ONLY the new dated
    // section for the version under test, not the full file history.
    // serializeChangelog appends priorChangelog verbatim, so passing the prior
    // text here would dump every past release into the rc job summary.
    const ir = renderChangelog({
      fragments,
      version: opts.version,
      date: opts.date,
      priorChangelog: null,
    });
    let releaseBlock = serializeChangelog(ir);
    if (fragments.length === 0) {
      // Mirror --allow-empty: a no-fragment release still shows a dated heading
      // with a placeholder rather than an empty block.
      releaseBlock = injectEmptyPlaceholder(releaseBlock);
    }
    return {
      exitCode: 0,
      report: {
        consumed: 0,
        failures: [],
        preview: releaseBlock,
        fragmentCount: fragments.length,
      },
    };
  }

  // 3. FIX 1: idempotency guard — if the version is already promoted (a dated
  //    release heading for this version already exists in CHANGELOG), split on
  //    whether fragments are still present:
  //    • alreadyPromoted + zero fragments → legitimate CI-retry no-op (the prior
  //      render commit already deleted fragments and wrote the heading).
  //    • alreadyPromoted + fragments present → inconsistent state: the heading
  //      was written out-of-band but fragments were never consumed.  Fail loudly
  //      so the operator resolves it manually rather than silently leaving stale
  //      fragments to be re-consumed in a later release.
  const version = stripV(opts.version);
  const { releases: existingReleases } = parseChangelog(priorText);
  const alreadyPromoted = existingReleases.some(
    (rel) => rel.version === version && rel.date,
  );
  if (alreadyPromoted) {
    if (fragments.length === 0) {
      return { exitCode: 0, report: { consumed: 0, failures: [], alreadyPromoted: true } };
    }
    const errMsg =
      `CHANGELOG.md already has a dated heading for ${version} but ` +
      `${fragments.length} unconsumed fragment(s) remain in .changeset/ — ` +
      `resolve manually (the version was likely promoted out-of-band).`;
    return {
      exitCode: 1,
      report: { consumed: 0, failures: [], alreadyPromoted: true, error: errMsg },
    };
  }

  // 4. Zero-fragment + !allowEmpty early-exit: write nothing.
  if (fragments.length === 0) {
    if (!opts.allowEmpty) {
      return { exitCode: 0, report: { consumed: 0, failures: [] } };
    }
    // --allow-empty: emit a dated heading with a placeholder even though there
    // are no fragments. This lets the render→verify CI chain succeed when a
    // release contains no user-visible changes.
    const { lead, prior } = splitChangelog(priorText);
    // Build a header-only release block and inject the placeholder line.
    const ir = renderChangelog({
      fragments: [],
      version: opts.version,
      date: opts.date,
      priorChangelog: prior || null,
    });
    const headerOnlyBlock = serializeChangelog(ir);
    const releaseBlock = injectEmptyPlaceholder(headerOnlyBlock);
    // FIX 2: use shared assembleChangelog helper.
    const out = assembleChangelog(lead, releaseBlock);
    fs.writeFileSync(changelogPath, out);
    return {
      exitCode: 0,
      report: {
        consumed: 0,
        failures: [],
        written: true,
        release: { version: opts.version, date: opts.date },
      },
    };
  }

  // 5. Normal render path: fragments present — reuse priorText already read above.
  const { lead, prior } = splitChangelog(priorText);

  const ir = renderChangelog({
    fragments,
    version: opts.version,
    date: opts.date,
    priorChangelog: prior || null,
  });
  const releaseBlock = serializeChangelog(ir);
  // FIX 2: use shared assembleChangelog helper.
  const out = assembleChangelog(lead, releaseBlock);

  fs.writeFileSync(changelogPath, out);

  // Delete consumed fragments. If any unlink fails the changelog is written
  // but the fragment is still on disk, so a re-run would double-consume it.
  // Surface the partial-failure as exitCode=1 with structured detail so the
  // operator can manually clean up before retrying.
  const deleteFailures = [];
  for (const f of fragments) {
    try {
      fs.unlinkSync(f.file);
    } catch (e) {
      deleteFailures.push({
        file: path.relative(repo, f.file),
        reason: 'fail_fragment_delete',
        detail: e.code || e.message,
      });
    }
  }

  return {
    exitCode: deleteFailures.length > 0 ? 1 : 0,
    report: {
      consumed: fragments.length - deleteFailures.length,
      failures: deleteFailures,
      release: { version: opts.version, date: opts.date },
    },
  };
}

function stripV(v) { return typeof v === 'string' ? v.replace(/^v/, '') : v; }

function resolveChangelogPath(opts) {
  return opts.changelog
    ? path.resolve(opts.changelog)
    : path.join(path.resolve(opts.repo), 'CHANGELOG.md');
}

/**
 * extract subcommand: extracts all changelog release blocks strictly after
 * `--from` (exclusive) up to and including `--to` (inclusive).  Both
 * arguments accept `v`-prefixed semver (e.g. `v1.5.13`).
 *
 * Exit codes:
 *   0  — one or more releases matched, output written.
 *   2  — no releases fall in the specified range (matches nothing).
 *   1  — I/O error or missing required flags.
 *
 * Fix for #3496: provides a deterministic range-aware helper so the
 * `/gsd-update` show_changes_and_confirm step no longer relies on
 * vague/manual extraction that can silently skip intermediate versions.
 */
function cmdExtract(opts) {
  const from = stripV(opts.fromRef);
  const to = stripV(opts.toRef);

  // Validate that both bounds are strict semver (N.N.N, digits only).
  // Coercing a malformed bound like "1.41.x" to "1.41.0" makes range
  // selection silently wrong; reject early with a structured error.
  if (!isStableTripletSemver(from)) {
    return {
      exitCode: 1,
      report: { error: `invalid semver for --from: "${from}" (expected N.N.N)`, releases: [] },
      textOutput: null,
    };
  }
  if (!isStableTripletSemver(to)) {
    return {
      exitCode: 1,
      report: { error: `invalid semver for --to: "${to}" (expected N.N.N)`, releases: [] },
      textOutput: null,
    };
  }

  const changelogPath = resolveChangelogPath(opts);

  if (!fs.existsSync(changelogPath)) {
    return {
      exitCode: 1,
      report: { error: `CHANGELOG not found: ${changelogPath}`, releases: [] },
      textOutput: null,
    };
  }

  const text = fs.readFileSync(changelogPath, 'utf8');
  const { releases } = parseChangelog(text);

  const matched = releases.filter((rel) => {
    if (rel.version === 'Unreleased') return false;
    // Extract mode intentionally operates on stable releases only.
    if (!isStableTripletSemver(rel.version)) {
      process.stderr.write(`[extract] skipping pre-release/non-semver entry: ${rel.version}\n`);
      return false;
    }
    // from is exclusive: cmp > 0 means rel.version > from
    const afterFrom = compareSemverCore(rel.version, from) > 0;
    // to is inclusive: cmp <= 0 means rel.version <= to
    const upToTo = compareSemverCore(rel.version, to) <= 0;
    return afterFrom && upToTo;
  });

  if (matched.length === 0) {
    return {
      exitCode: 2,
      report: { releases: [], from, to },
      textOutput: null,
    };
  }

  return {
    exitCode: 0,
    report: { releases: matched, from, to },
    textOutput: matched
      .map((rel) => {
        const header = `## [${rel.version}]${rel.date ? ` - ${rel.date}` : ''}`;
        const sections = (rel.sections || [])
          .map((s) => {
            const bullets = s.bullets
              .map((b) => (b.pr !== null ? `- ${b.body} (#${b.pr})` : `- ${b.body}`))
              .join('\n');
            return `### ${s.type}\n\n${bullets}`;
          })
          .join('\n\n');
        return sections ? `${header}\n\n${sections}` : header;
      })
      .join('\n\n'),
  };
}

function cmdVerify(opts) {
  const version = stripV(opts.version);

  if (!isStableTripletSemver(version)) {
    return {
      exitCode: 1,
      report: { error: `invalid semver for --version: "${version}" (expected N.N.N)`, ok: false },
      textOutput: null,
    };
  }

  const changelogPath = resolveChangelogPath(opts);

  if (!fs.existsSync(changelogPath)) {
    return {
      exitCode: 1,
      report: { error: `CHANGELOG not found: ${changelogPath}`, ok: false },
      textOutput: null,
    };
  }

  const text = fs.readFileSync(changelogPath, 'utf8');
  const { releases } = parseChangelog(text);

  const match = releases.find((r) => r.version === version);

  if (!match) {
    return {
      exitCode: 1,
      report: {
        error: `CHANGELOG.md has no \`## [${version}]\` release heading — promote [Unreleased] into a dated section before releasing (see #690)`,
        ok: false,
      },
      textOutput: null,
    };
  }

  if (!match.date) {
    return {
      exitCode: 1,
      report: {
        error: `CHANGELOG.md heading \`## [${version}]\` has no date — expected \`## [${version}] - YYYY-MM-DD\``,
        ok: false,
      },
      textOutput: null,
    };
  }

  return {
    exitCode: 0,
    report: { ok: true, version, date: match.date },
    textOutput: `CHANGELOG.md has a dated heading for ${version} (${match.date})`,
  };
}

function cmdGithubReleaseNotes(opts) {
  const repo = path.resolve(opts.repo);
  const report = renderGithubReleaseNotes({
    repo,
    fromRef: opts.fromRef,
    toRef: opts.toRef,
    repoSlug: opts.repoSlug,
    installCommand: opts.installCommand,
  });

  if (!report.ok) {
    return {
      exitCode: 1,
      report: {
        consumed: 0,
        failures: report.failures,
        release: { from: opts.fromRef, to: opts.toRef },
      },
    };
  }

  if (opts.output) {
    fs.writeFileSync(path.resolve(opts.output), report.body);
  }

  return {
    exitCode: 0,
    report: {
      consumed: report.fragments.length,
      failures: [],
      release: { from: opts.fromRef, to: opts.toRef },
      output: opts.output || null,
      body: opts.output ? null : report.body,
    },
  };
}

function usage() {
  return [
    'usage:',
    '  changeset/cli.cjs render --repo <dir> --version V --date D [--allow-empty] [--preview] [--json]',
    '    --preview renders the dated section to stdout without writing CHANGELOG.md or consuming fragments.',
    '  changeset/cli.cjs github-release-notes --repo <dir> --from REF --to REF [--output FILE] [--repo-slug OWNER/REPO] [--install-command CMD] [--json]',
    '  changeset/cli.cjs extract --from VERSION --to VERSION [--changelog FILE] [--repo <dir>] [--json]',
    '    Extracts changelog entries strictly after --from (exclusive) and up to',
    '    and including --to (inclusive).  Accepts v-prefixed versions.',
    '    Exit 2 when no releases fall in range.',
    '  changeset/cli.cjs verify --version <X.Y.Z> [--changelog <path>]   Exit non-zero if CHANGELOG.md has no dated `## [X.Y.Z]` heading (release gate, #690)',
    '',
  ].join('\n');
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(usage());
    throw new ExitError(2);
  }
  const { opts } = parsed;
  if (opts.cmd !== 'render' && opts.cmd !== 'github-release-notes' && opts.cmd !== 'extract' && opts.cmd !== 'verify') {
    process.stderr.write(usage());
    throw new ExitError(1);
  }
  if (opts.cmd === 'render' && (!opts.version || !opts.date)) {
    throw new ExitError(2, '--version and --date are required for render');
  }
  if (opts.cmd === 'github-release-notes' && (!opts.fromRef || !opts.toRef)) {
    throw new ExitError(2, '--from and --to are required for github-release-notes');
  }
  if (opts.cmd === 'extract' && (!opts.fromRef || !opts.toRef)) {
    process.stderr.write('--from and --to are required for extract\n');
    process.stderr.write(usage());
    throw new ExitError(1);
  }
  if (opts.cmd === 'verify' && !opts.version) {
    throw new ExitError(2, '--version is required for verify');
  }

  if (opts.cmd === 'extract') {
    const { exitCode, report, textOutput } = cmdExtract(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (textOutput) {
      process.stdout.write(textOutput + '\n');
    } else if (exitCode === 2) {
      process.stderr.write(`no releases found in range (from=${report.from}, to=${report.to})\n`);
    }
    return exitCode;
  }

  if (opts.cmd === 'verify') {
    const { exitCode, report, textOutput } = cmdVerify(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (textOutput) {
      process.stdout.write(textOutput + '\n');
    } else {
      process.stderr.write(report.error + '\n');
    }
    return exitCode;
  }

  const { exitCode, report } = opts.cmd === 'render' ? cmdRender(opts) : cmdGithubReleaseNotes(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (opts.cmd === 'render' && opts.preview && typeof report.preview === 'string') {
    // render --preview: emit the rendered section verbatim (no mutation occurred).
    // The `typeof report.preview === 'string'` guard is load-bearing: cmdRender
    // early-returns on a fragment parse failure (failures.length > 0) WITHOUT a
    // `preview` key, so writing report.preview unguarded crashed the rc release
    // job with ERR_INVALID_ARG_TYPE, masking the real cause (a malformed
    // fragment). When preview is absent we fall through to the failure reporter
    // below, which names the offending file and exits non-zero — identical to a
    // non-preview render.
    process.stdout.write(report.preview);
  } else if (opts.cmd === 'github-release-notes' && report.body) {
    process.stdout.write(report.body);
  } else {
    if (report.error) {
      process.stderr.write(`${report.error}\n`);
    }
    process.stdout.write(`Consumed: ${report.consumed} fragment(s)\n`);
    if (report.failures.length > 0) {
      process.stdout.write(`Failures: ${report.failures.length}\n`);
      for (const f of report.failures) {
        process.stdout.write(`  ${f.file}: ${f.reason}${f.detail ? ` (${f.detail})` : ''}\n`);
      }
    }
  }
  return exitCode;
}

if (require.main === module) runMain(main);

module.exports = { cmdRender, cmdExtract, cmdVerify, cmdGithubReleaseNotes, parseArgs, splitChangelog, assembleChangelog, listFragmentFiles, usage };
