#!/usr/bin/env node
'use strict';

/**
 * verify-npm-publish.cjs — verifies a freshly-published npm version is
 * retrievable, tolerating registry/CDN propagation lag via bounded retry.
 * Fixes #623. Used by both Verify-publish steps in .github/workflows/release.yml.
 */

const cp = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

// ---- Constants ---------------------------------------------------------------

const REASON = Object.freeze({
  OK_VERSION_LIVE: 'ok_version_live',
  FAIL_VERSION_NOT_FOUND: 'fail_version_not_found',
});

// #5021: v1.15.0 published fine (npm accepted it and reported it was
// "processing") but took ~6.5 min (390s) to become resolvable via `npm view`
// — well past the old 20 x 5s (~100s) window, which failed the job and
// skipped the release->main merge and next-version sync. The window bounds
// wall-clock time (not attempt count) so slow/hung `npm view` calls can't
// stretch the step: worst case is window + DIST_TAG_WINDOW_MS + 2 x
// NPM_VIEW_TIMEOUT_MS (~13 min: the last version fetch and the last
// dist-tag fetch can each run to their timeout), under release.yml's
// 15-min step timeout-minutes.
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_INTERVAL_MS = 10_000;
// The dist-tag lookup is informational only (it never affects `ok`), so once
// the version is live it must not spend another full window on top — cap its
// retries with BOTH an attempt count and a wall-clock cap so it never spends
// a second full window.
const DIST_TAG_MAX_ATTEMPTS = 6;
const DIST_TAG_WINDOW_MS = 60_000;
// repo convention: npm subprocesses bounded at 60s; a timeout degrades to
// "not found yet"
const NPM_VIEW_TIMEOUT_MS = 60_000;

// ---- Sleep -------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- npm fetchers ------------------------------------------------------------

function defaultFetchVersion(pkg, version, { exec = cp.execFileSync } = {}) {
  try {
    const out = exec('npm', ['view', `${pkg}@${version}`, 'version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: NPM_VIEW_TIMEOUT_MS }).trim();
    return out || null;
  } catch { return null; }
}

function defaultFetchDistTag(pkg, distTag, { exec = cp.execFileSync } = {}) {
  try {
    const out = exec('npm', ['view', pkg, 'dist-tags', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: NPM_VIEW_TIMEOUT_MS });
    const tags = JSON.parse(out);
    return (tags && typeof tags === 'object' && tags[distTag]) || null;
  } catch { return null; }
}

// ---- Core async function (unit-tested seam) ----------------------------------

async function verifyPublish({
  pkg,
  version,
  distTag = null,
  fetchVersion = defaultFetchVersion,
  fetchDistTag = defaultFetchDistTag,
  windowMs = DEFAULT_WINDOW_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = Infinity,
  sleep = defaultSleep,
  now = Date.now,
}) {
  let attempts = 0;
  const start = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const found = fetchVersion(pkg, version);
    attempts++;

    if (found === version) {
      // Version confirmed live — optionally resolve dist-tag informally
      let distTagResult = null;

      if (distTag && typeof distTag === 'string' && distTag.length > 0) {
        let pointsTo = null;
        const tagStart = now();
        const distTagAttempts = Math.min(maxAttempts, DIST_TAG_MAX_ATTEMPTS);
        const distTagWindowMs = Math.min(DIST_TAG_WINDOW_MS, windowMs);

        for (let dt = 1; dt <= distTagAttempts; dt++) {
          const tagVal = fetchDistTag(pkg, distTag);
          if (tagVal !== null) {
            pointsTo = tagVal;
            break;
          }
          if (dt >= distTagAttempts || now() - tagStart + intervalMs > distTagWindowMs) {
            break;
          }
          await sleep(intervalMs);
        }

        distTagResult = {
          name: distTag,
          points_to: pointsTo,
          matches: pointsTo === version,
        };
      }

      return {
        ok: true,
        reason: REASON.OK_VERSION_LIVE,
        pkg,
        version,
        attempts,
        distTag: distTagResult,
        elapsedMs: now() - start,
      };
    }

    // Not found yet — stop once the next sleep would carry us past the
    // window (or the attempt cap), otherwise sleep before retrying.
    if (attempt >= maxAttempts || now() - start + intervalMs > windowMs) {
      break;
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    reason: REASON.FAIL_VERSION_NOT_FOUND,
    pkg,
    version,
    attempts,
    distTag: null,
    elapsedMs: now() - start,
  };
}

// ---- Argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    pkg: null,
    version: null,
    distTag: null,
    windowMs: DEFAULT_WINDOW_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxAttempts: Infinity,
    json: false,
  };

  const args = argv.slice();
  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/verify-npm-publish.cjs --package <pkg> --version <ver> [options]\n' +
        '\n' +
        'Options:\n' +
        '  --package <s>       npm package name (required)\n' +
        '  --version <s>       version to verify (required)\n' +
        '  --dist-tag <s>      dist-tag to report (optional, informational only)\n' +
        `  --window-ms <n>     total wall-clock ms to keep retrying (default: ${DEFAULT_WINDOW_MS})\n` +
        `  --max-attempts <n>  optional cap on attempts (default: unlimited within the window)\n` +
        `  --interval-ms <n>   ms between retries (default: ${DEFAULT_INTERVAL_MS})\n` +
        '  --json              emit structured JSON output\n' +
        '  --help, -h          show this help\n'
      );
      throw new ExitError(0);
    } else if (arg === '--package') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --package requires a value');
      }
      opts.pkg = val;
    } else if (arg === '--version') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --version requires a value');
      }
      opts.version = val;
    } else if (arg === '--dist-tag') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --dist-tag requires a value');
      }
      opts.distTag = val;
    } else if (arg === '--window-ms') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --window-ms requires a value');
      }
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1) {
        throw new ExitError(2, 'error: --window-ms must be a positive integer');
      }
      opts.windowMs = n;
    } else if (arg === '--max-attempts') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --max-attempts requires a value');
      }
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1) {
        throw new ExitError(2, 'error: --max-attempts must be a positive integer');
      }
      opts.maxAttempts = n;
    } else if (arg === '--interval-ms') {
      const val = args.shift();
      if (!val || val.startsWith('-')) {
        throw new ExitError(2, 'error: --interval-ms requires a value');
      }
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 0) {
        throw new ExitError(2, 'error: --interval-ms must be a non-negative integer');
      }
      opts.intervalMs = n;
    } else if (arg === '--json') {
      opts.json = true;
    } else {
      throw new ExitError(2, `unknown argument: ${arg}`);
    }
  }

  if (!opts.pkg) {
    throw new ExitError(2, 'error: --package is required');
  }
  if (!opts.version) {
    throw new ExitError(2, 'error: --version is required');
  }

  return opts;
}

// ---- Main entry point --------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await verifyPublish({
    pkg: opts.pkg,
    version: opts.version,
    distTag: opts.distTag,
    windowMs: opts.windowMs,
    maxAttempts: opts.maxAttempts,
    intervalMs: opts.intervalMs,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.ok) {
      process.stdout.write(
        `✓ Verified: ${result.pkg}@${result.version} is live on npm (after ${result.attempts} attempt(s))\n`
      );
      if (result.distTag) {
        process.stdout.write(`✓ ${result.distTag.name} tag points to: ${result.distTag.points_to}\n`);
        if (!result.distTag.matches) {
          process.stdout.write(
            `::warning::${result.distTag.name} dist-tag points to ${result.distTag.points_to}, expected ${result.version}\n`
          );
        }
      }
    } else {
      process.stdout.write(
        `::error::Published version verification failed. ${result.pkg}@${result.version} not found after ${result.attempts} attempt(s) over ${Math.round(result.elapsedMs / 1000)}s\n`
      );
    }
  }

  return result.ok ? 0 : 1;
}

// ---- Guard -------------------------------------------------------------------

if (require.main === module) {
  runMain(main);
}

module.exports = {
  verifyPublish,
  parseArgs,
  REASON,
  defaultFetchVersion,
  defaultFetchDistTag,
  DEFAULT_WINDOW_MS,
  DEFAULT_INTERVAL_MS,
  DIST_TAG_MAX_ATTEMPTS,
  DIST_TAG_WINDOW_MS,
  NPM_VIEW_TIMEOUT_MS,
};
