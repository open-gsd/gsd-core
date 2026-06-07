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

// ---- Sleep -------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- npm fetchers ------------------------------------------------------------

function defaultFetchVersion(pkg, version) {
  try {
    const out = cp.execFileSync('npm', ['view', `${pkg}@${version}`, 'version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

function defaultFetchDistTag(pkg, distTag) {
  try {
    const out = cp.execFileSync('npm', ['view', pkg, 'dist-tags', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
  maxAttempts = 20,
  intervalMs = 5000,
  sleep = defaultSleep,
}) {
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const found = fetchVersion(pkg, version);
    attempts++;

    if (found === version) {
      // Version confirmed live — optionally resolve dist-tag informally
      let distTagResult = null;

      if (distTag && typeof distTag === 'string' && distTag.length > 0) {
        let pointsTo = null;

        for (let dt = 1; dt <= maxAttempts; dt++) {
          const tagVal = fetchDistTag(pkg, distTag);
          if (tagVal !== null) {
            pointsTo = tagVal;
            break;
          }
          if (dt < maxAttempts) {
            await sleep(intervalMs);
          }
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
      };
    }

    // Not found yet — sleep before retry (but not after the final attempt)
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  return {
    ok: false,
    reason: REASON.FAIL_VERSION_NOT_FOUND,
    pkg,
    version,
    attempts,
    distTag: null,
  };
}

// ---- Argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    pkg: null,
    version: null,
    distTag: null,
    maxAttempts: 20,
    intervalMs: 5000,
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
        '  --max-attempts <n>  max retry attempts (default: 20)\n' +
        '  --interval-ms <n>   ms between retries (default: 5000)\n' +
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
        `::error::Published version verification failed. ${result.pkg}@${result.version} not found after ${result.attempts} attempt(s)\n`
      );
    }
  }

  return result.ok ? 0 : 1;
}

// ---- Guard -------------------------------------------------------------------

if (require.main === module) {
  runMain(main);
}

module.exports = { verifyPublish, parseArgs, REASON, defaultFetchVersion, defaultFetchDistTag };
