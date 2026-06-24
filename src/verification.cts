/**
 * Verification Status — single queryable home for verification-status routing.
 *
 * Issue #651: consolidate the pass/gaps_found/human_needed routing that was
 * previously scattered across ship.md and execute-phase.md into a single
 * tested module. Both workflow files will later consume this module's routing
 * table as the single source of truth.
 *
 * ADR-457 build-at-publish: source in src/verification.cts, compiled to
 * gsd-core/bin/lib/verification.cjs (gitignored).
 *
 * DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix: status extraction is scoped to
 * the leading YAML frontmatter block only. A `status:` line in the body (e.g.
 * inside a fenced code block) is ignored — this is the exact failure mode that
 * issue #586 / PR #650 identified. The shared extractFrontmatter parser anchors
 * its regex at byte 0 of the document, which provides this guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseId = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import scanPhasePlans = require('./plan-scan.cjs');

const { output, error } = io;
const { extractPhaseToken } = phaseId;
const { extractFrontmatter } = frontmatterMod;

// ─── Constants ────────────────────────────────────────────────────────────────

/** The set of status values that the gsd-verifier agent emits. */
const VERIFIER_STATUSES: ReadonlyArray<string> = ['passed', 'gaps_found', 'human_needed'];

// ─── Routing table ────────────────────────────────────────────────────────────

interface VerificationRoute {
  status: string;
  next_action: string;
  next_command: string;
}

/**
 * Canonical routing table for verification statuses.
 *
 * This is the single source of truth — ship.md and execute-phase.md will
 * later import from here instead of embedding their own message strings.
 *
 * INTERNAL SENTINELS: 'missing' and 'unknown' are operational states constructed
 * internally — the verifier (gsd-verifier.md) never emits them. The verifier only
 * emits values in VERIFIER_STATUSES (passed|gaps_found|human_needed). The guard in
 * readVerificationStatus excludes 'missing' and 'unknown' from raw-status table
 * lookup so they can only be reached via internal construction paths.
 *
 * For 'gaps_found', next_command is built at call time in readVerificationStatus
 * by substituting the phase number — it is NOT stored as a function in the table.
 */
const VERIFICATION_ROUTING_TABLE: Record<string, VerificationRoute> = {
  passed: {
    status: 'passed',
    next_action: 'Verification passed — continue.',
    next_command: '',
  },
  gaps_found: {
    status: 'gaps_found',
    next_action: 'Gaps found. Plan the fixes, then re-run execute-phase before shipping.',
    // next_command is computed at call time; this entry is never returned directly.
    next_command: '',
  },
  human_needed: {
    status: 'human_needed',
    next_action: "Human verification required. Complete the manual tests in the phase's *-UAT.md, then re-run the verify step until status is passed.",
    next_command: '',
  },
  stale: {
    status: 'stale',
    next_action: 'Verification is stale. Re-run verify-work before transition.',
    next_command: '',
  },
  // INTERNAL SENTINEL: constructed when no *-VERIFICATION.md file exists or when
  // the file has no parseable frontmatter status. Never emitted by the verifier.
  missing: {
    status: 'missing',
    next_action: 'No verification report found — the verify step never completed. Re-run execute-phase.',
    next_command: '/gsd:execute-phase',
  },
  // INTERNAL SENTINEL: constructed when the file has a status value not in
  // VERIFIER_STATUSES. Never emitted by the verifier.
  unknown: {
    status: 'unknown',
    next_action: '', // filled in dynamically with the raw value
    next_command: '/gsd:execute-phase',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FsLike {
  readdirSync(dir: string): string[];
  readFileSync(filePath: string, encoding: 'utf-8'): string;
  statSync(filePath: string): { mtimeMs: number };
}

interface StaleVerificationInfo {
  verificationFile: string;
  summaryFile: string;
}

/**
 * Build a 'missing' result from the routing table.
 * Used for two early-return paths: no *-VERIFICATION.md file found, and
 * file present but no parseable frontmatter status.
 */
function missingResult(): VerificationStatusResult {
  const route = VERIFICATION_ROUTING_TABLE['missing'];
  return {
    status: route.status,
    next_action: route.next_action,
    next_command: route.next_command,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

interface ReadVerificationStatusOptions {
  fs?: FsLike;
}

interface VerificationStatusResult {
  status: string;
  next_action: string;
  next_command: string;
}

function findStaleVerificationSummary(phaseDir: string, fsImpl: FsLike = fs): StaleVerificationInfo | null {
  // FS errors (TOCTOU: a SUMMARY listed by scanPhasePlans then removed before statSync;
  // unreadable dir; broken symlink; file->dir swap) must degrade to "not stale" rather
  // than throw uncaught into callers that are NOT under the planning lock
  // (init.manager / init.progress / uat-predicate). Mirrors readVerificationStatus's
  // no-throw contract; `fsImpl` threads the same injectable-fs seam for parity/testing.
  // (Review B1 on #1548.)
  try {
    const phaseFiles = fsImpl.readdirSync(phaseDir);
    const verificationFile = phaseFiles.filter((f) => f.endsWith('-VERIFICATION.md')).sort()[0];
    if (!verificationFile) return null;

    const verificationMtimeMs = fsImpl.statSync(path.join(phaseDir, verificationFile)).mtimeMs;
    let newestStaleSummary: { summaryFile: string; mtimeMs: number } | null = null;
    const summaryFiles = (scanPhasePlans(phaseDir) as { summaryFiles: string[] }).summaryFiles;
    for (const summaryFile of summaryFiles.sort()) {
      const summaryMtimeMs = fsImpl.statSync(path.join(phaseDir, summaryFile)).mtimeMs;
      if (summaryMtimeMs <= verificationMtimeMs) continue;
      if (!newestStaleSummary || summaryMtimeMs > newestStaleSummary.mtimeMs) {
        newestStaleSummary = { summaryFile, mtimeMs: summaryMtimeMs };
      }
    }

    if (!newestStaleSummary) return null;
    return {
      verificationFile,
      summaryFile: newestStaleSummary.summaryFile,
    };
  } catch {
    return null;
  }
}

/**
 * Read the verification status from the first `*-VERIFICATION.md` file in
 * phaseDir and return the routing result.
 *
 * Behavior:
 * 1. Find the first file matching `*-VERIFICATION.md` (sorted, take first).
 *    If none → status 'missing'.
 * 2. Extract `status` from FRONTMATTER ONLY via the shared extractFrontmatter
 *    parser (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP fix — parser anchors at byte 0).
 *    If no frontmatter block or no `status` key → status 'missing'.
 * 3. Map to routing table. Unknown non-empty value → status 'unknown'.
 *
 * @param phaseDir - Absolute path to the phase directory.
 * @param opts     - Options. `opts.fs` allows test injection (defaults to node:fs).
 */
function readVerificationStatus(
  phaseDir: string,
  opts: ReadVerificationStatusOptions = {},
): VerificationStatusResult {
  const fsImpl: FsLike = opts.fs ?? fs;

  // Phase token for the gaps_found command
  const baseName = path.basename(phaseDir);
  const phaseToken = extractPhaseToken(baseName);
  const phaseNumber = phaseToken.length > 0 ? phaseToken : baseName;

  // 1. Find *-VERIFICATION.md
  let verificationFile: string | null = null;
  try {
    const entries = fsImpl.readdirSync(phaseDir);
    const candidates = entries.filter((f) => f.endsWith('-VERIFICATION.md')).sort();
    verificationFile = candidates.length > 0 ? candidates[0] : null;
  } catch {
    // Directory unreadable → treat as missing
    verificationFile = null;
  }

  if (!verificationFile) {
    return missingResult();
  }

  // 2. Read and parse frontmatter using the shared parser.
  // extractFrontmatter anchors at byte 0, so body `status:` lines are ignored.
  const filePath = path.join(phaseDir, verificationFile);
  let rawStatus: string | null = null;
  try {
    const content = fsImpl.readFileSync(filePath, 'utf-8');
    const fm = extractFrontmatter(content);
    const statusVal = fm['status'];
    // status is always a scalar string in a well-formed VERIFICATION.md frontmatter;
    // only accept string values — arrays and objects are not valid status values.
    if (typeof statusVal === 'string') {
      const trimmed = statusVal.trim();
      rawStatus = trimmed.length > 0 ? trimmed : null;
    }
  } catch {
    rawStatus = null;
  }

  if (!rawStatus) {
    return missingResult();
  }

  // gaps_found takes priority over stale — gap closure is the correct next
  // step regardless of whether summaries are newer than the verification file.
  if (rawStatus === 'gaps_found') {
    const entry = VERIFICATION_ROUTING_TABLE['gaps_found'];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: `/gsd:plan-phase ${phaseNumber} --gaps`,
    };
  }

  const staleVerification = findStaleVerificationSummary(phaseDir, fsImpl);
  if (staleVerification) {
    const entry = VERIFICATION_ROUTING_TABLE['stale'];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: `/gsd:verify-work ${phaseNumber}`,
    };
  }

  // 3. Route — exclude internal sentinels from raw-file lookup (they are
  // constructed internally above, never written by the verifier).
  if (
    rawStatus in VERIFICATION_ROUTING_TABLE &&
    rawStatus !== 'missing' &&
    rawStatus !== 'unknown' &&
    rawStatus !== 'stale' &&
    rawStatus !== 'gaps_found'
  ) {
    const entry = VERIFICATION_ROUTING_TABLE[rawStatus];
    return {
      status: entry.status,
      next_action: entry.next_action,
      next_command: entry.next_command,
    };
  }

  // Unknown value
  const unknownRoute = VERIFICATION_ROUTING_TABLE['unknown'];
  return {
    status: unknownRoute.status,
    next_action: `Unexpected verification status '${rawStatus}'. Re-run execute-phase verification.`,
    next_command: unknownRoute.next_command,
  };
}

/**
 * CLI command handler: resolve phaseDir against cwd, call readVerificationStatus,
 * emit via io.output().
 *
 * @param cwd         - Current working directory (used to resolve phaseDirArg).
 * @param phaseDirArg - Phase directory path (absolute or relative to cwd).
 * @param raw         - Whether to emit raw (non-JSON) output.
 */
function cmdVerificationStatus(cwd: string, phaseDirArg: string | undefined, raw: boolean): void {
  if (!phaseDirArg) {
    error('phase directory required for verification.status');
    return;
  }
  const phaseDir = path.resolve(cwd, phaseDirArg);
  const result = readVerificationStatus(phaseDir);
  output(result, raw);
}

export = {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  findStaleVerificationSummary,
  readVerificationStatus,
  cmdVerificationStatus,
};
