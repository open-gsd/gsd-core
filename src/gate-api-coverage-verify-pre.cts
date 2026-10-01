/**
 * `check api-coverage.verify-pre` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet):
 * it returns a `GateResult`; the command router formats it. Imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced).
 *
 * BLOCKING seal-time gate for the ai-integration capability (#1562). Enforces "Full API Coverage by
 * Default — Opt Out, Never Opt In." A phase that integrates an external API/SDK/service may not seal
 * until a COVERAGE.md matrix enumerates the surface and every non-integrated capability is an
 * explicit, reasoned opt-out.
 *
 * Contract (two touch points composed into one check):
 *   1. If COVERAGE.md exists in the phase dir → validate it (acceptance #2).
 *      Block on any validation error (empty matrix, OPT-OUT without reason,
 *      duplicate/empty capability).
 *   2. If COVERAGE.md is absent → run detectApiIntegration over the phase scope
 *      (PLAN.md body, then ROADMAP phase section as fallback). If a strong
 *      external-API-integration signal is detected → BLOCK ("integration
 *      detected without coverage matrix"). If no signal → PASS (treat as a
 *      non-API phase; acceptance #4 — low false positives).
 *
 * The detector is the FALLBACK for the "nobody decided / forgot the matrix" case; the primary path
 * is the plan:pre contribution prompting COVERAGE.md.
 *
 * Argv after the verb: `<phase-dir-or-token>`. Payload: the uniform gate contract
 * `{ block, passed, message, ...details }`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { readDirEntriesEvidence, readTextEvidence } from './gate-evidence.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocatorMod;
import { tryWithinRootLexical } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import roadmapModule = require('./roadmap.cjs');
const { getRoadmapPhaseWithFallback } = roadmapModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import apiCoverageMod = require('./api-coverage.cjs');
const { detectApiIntegration, validateCoverageMatrix } = apiCoverageMod;
import { posixNormalize } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;

/**
 * The phase-scope text used for API-integration detection. Uses the resolved plan files (PLAN.md
 * bodies — the planner's own words about what the phase does) and, as a fallback, ONLY THIS
 * PHASE'S ROADMAP section (not the whole roadmap, which would cross-contaminate sibling phases).
 * Strips nothing here — detectApiIntegration strips fenced code itself.
 */
export interface PhaseScopeRead {
  text: string;
  /** Non-null when a plan file EXISTED but could not be read. The gate must not
   *  conclude "no external API integration" from provably incomplete scope — an
   *  unreadable plan could be the one describing the integration (#2365 review:
   *  the blocking consumer silently passed partially-read scope). A missing plan
   *  directory is NOT a read error (a phase may legitimately have no plans yet). */
  readError: string | null;
}

/** A filesystem error that is NOT "does not exist" — i.e. a real read failure
 *  (EACCES/EIO/…) the gate must not swallow. `ENOENT` is a legitimate "not
 *  there yet" and is treated as absence, not error. */
function isRealReadFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return err != null && code !== 'ENOENT';
}

// NOTE: `fs` is used as a namespace object at call time (never destructured at load) so tests can
// monkeypatch its methods for failure injection.
export function readPhaseScope(projectDir: string, phaseDir: string, phaseNumber: string): PhaseScopeRead {
  const chunks: string[] = [];
  let readError: string | null = null;
  // A MISSING phase directory is fine (no plans yet → fall through to the
  // roadmap). Checked up front (rather than via a readdirSync catch) because
  // #3183 (lint-plan-count-drift) now sources the plan-file list from the
  // single owner (scanPhasePlans) instead of a local `-PLAN\.md$` readdirSync
  // filter — picks up bare PLAN.md and nested plans/, and excludes
  // superseded plans, none of which the prior root-only exact-suffix filter
  // did.
  if (fs.existsSync(phaseDir)) {
    const scan = scanPhasePlans(phaseDir);
    if (scan.scope === SCOPE.UNREADABLE) {
      // Directory exists but scanPhasePlans's own readdirSync(phaseDir) call
      // failed (EACCES/EIO race) — a real read failure the gate must not
      // silently pass (#2365 review), mirroring the prior isRealReadFailure
      // branch below for the readdirSync-throws case.
      return {
        text: '',
        readError: 'could not read the phase directory: scanPhasePlans reported scope UNREADABLE',
      };
    }
    const plans = [...scan.planFiles].sort();
    for (const p of plans) {
      try {
        chunks.push(fs.readFileSync(path.join(phaseDir, p), 'utf8'));
      } catch (err) {
        // A plan file that exists but cannot be read — record it and keep
        // reading the rest so the message names the first failure.
        if (!readError) {
          readError = `could not read ${p}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  if (readError) return { text: chunks.join('\n\n'), readError };
  if (chunks.join('').trim().length > 0) return { text: chunks.join('\n\n'), readError: null };

  // Fallback: ONLY this phase's ROADMAP section (not the whole file, which
  // would pollute detection with sibling-phase prose). A MISSING roadmap/section
  // is non-fatal; a roadmap that exists but cannot be read is a real failure.
  if (phaseNumber) {
    try {
      const section = getRoadmapPhaseWithFallback(projectDir, phaseNumber);
      if (section) return { text: section, readError: null };
    } catch (err) {
      if (isRealReadFailure(err)) {
        return {
          text: '',
          readError: `could not read the roadmap fallback: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
  return { text: '', readError: null };
}

export function evaluateApiCoverageVerifyPre(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir, args } = input;
  const phaseArg = typeof args[0] === 'string' ? args[0] : '';
  if (!phaseArg) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'api-coverage.verify-pre requires a phase argument: check api-coverage.verify-pre <phase-dir-or-token>',
    );
  }

  const pDir = planningDir(projectDir);
  const phasesRoot = path.join(pDir, 'phases');

  // SECURITY (path traversal): the phase argument is taken ONLY as a phase
  // token — its basename — and resolved by findPhaseInternal strictly under
  // .planning/phases/ (or a milestone archive). The raw arg is never used as a
  // path, so `..`, absolute paths, and arbitrary directories cannot reach a
  // file read. Mirrors cmdVerifySchemaDrift's token-match approach.
  let token = posixNormalize(phaseArg).split('/').filter(Boolean).pop() || '';
  // A token like ".." or "." carries no phase identity → unresolvable.
  if (token === '.' || token === '..') token = '';

  // Not a GSD project (no phases tree at all) → fail-open: nothing to gate.
  if (!fs.existsSync(phasesRoot)) {
    return gateVerdict('pass', false, {
      block: false,
      passed: true,
      coverage_present: false,
      detected: false,
      message: 'api-coverage: no .planning/phases directory; gate skipped (not a GSD project layout)',
    });
  }

  // Resolve the phase dir under the contained phases root.
  let resolvedDir: string | null = null;
  let phaseNumber = '';
  if (token) {
    const found = findPhaseInternal(projectDir, token);
    if (found && found.directory) {
      // findPhaseInternal's `directory` is relative to the project root; anchor it to `projectDir`
      // (not the process cwd) so the gate reads the same files in-process as it does from the CLI.
      resolvedDir = path.resolve(projectDir, found.directory);
      phaseNumber = found.phase_number || '';
    }
  }

  if (!resolvedDir) {
    // The phases tree EXISTS but THIS phase could not be resolved. For a
    // BLOCKING gate, fail-closed: a missing phase dir must not silently bypass
    // the coverage requirement. (Distinguished from "no .planning at all"
    // above, which is a genuine non-GSD-project → pass.)
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: false,
      phase_lookup_failed: true,
      message:
        `api-coverage: could not resolve phase "${phaseArg}" under .planning/phases/. ` +
        'Resolve the phase directory (or produce COVERAGE.md) before sealing.',
    });
  }

  // Defense-in-depth: the resolved dir must be inside the phases root (or a
  // milestone archive under .planning/milestones).
  const milestonesRoot = path.join(pDir, 'milestones');
  // Lexical containment (ADR-4650): resolvedDir is a directory path, not read
  // through here — mirrors the prior path.resolve(root, candidate)-based check
  // without introducing a filesystem/realpath dependency this defense-in-depth
  // recheck never had.
  if (
    tryWithinRootLexical(resolvedDir, phasesRoot) === null &&
    tryWithinRootLexical(resolvedDir, milestonesRoot) === null
  ) {
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: false,
      message: 'api-coverage: resolved phase dir escapes .planning/ — refusing to evaluate',
    });
  }

  // (1) locate COVERAGE.md — prefer the exact name, then a single *-COVERAGE.md.
  let coverageFile = '';
  let suffixed: string[] = [];
  // #5170 (ADR-5057 §4): a phase directory that EXISTS but cannot be listed is `unreadable` —
  // a COVERAGE.md may be in it — and never falls through to the detector, whose pass would be
  // certified from a directory the gate never saw. An ABSENT directory (`none`) has no matrix and
  // proceeds to detection, as before. The blocking policy is unchanged (fail-closed).
  const listing = readDirEntriesEvidence(resolvedDir);
  if (listing.kind === 'unreadable') {
    return gateUnreadable(true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: false,
      read_error: listing.reason,
      message:
        `api-coverage: could not read the phase directory (${listing.reason}) — ` +
        'refusing to certify the coverage matrix from a directory that could not be listed. ' +
        'Fix the directory permissions before sealing.',
    });
  }
  if (listing.kind === 'found') {
    const files = listing.value.filter((e) => e.isFile()).map((e) => e.name);
    const exact = files.find((f) => /^COVERAGE\.md$/i.test(f));
    if (exact) {
      coverageFile = exact;
    } else {
      suffixed = files.filter((f) => /-COVERAGE\.md$/i.test(f)).sort();
      if (suffixed.length === 1) coverageFile = suffixed[0];
    }
  }

  if (coverageFile) {
    const matrix = readTextEvidence(path.join(resolvedDir, coverageFile));
    if (matrix.kind !== 'found') {
      // COVERAGE.md exists but is unreadable (EACCES/EIO/encoding), or vanished between the
      // listing and the read. Fail-closed (policy unchanged) and `unreadable` (outcome).
      return gateUnreadable(true, {
        block: true,
        passed: false,
        coverage_present: true,
        message: `api-coverage: COVERAGE.md exists but is unreadable — fix file permissions/encoding before sealing`,
      });
    }
    const matrixText = matrix.value;
    const v = validateCoverageMatrix(matrixText);
    if (v.valid) {
      if (v.none_declared) {
        // The declaration is the human override for the detector — it PASSES
        // even when detection fires (that is acceptance #5's point: the
        // detector is fallible and the declaration is the reasoned overrule).
        // But a contradiction must be VISIBLE, not silent: re-run detection
        // over the phase scope and surface any signals it still finds
        // (#2365 review S-1).
        const declScope = readPhaseScope(projectDir, resolvedDir, phaseNumber);
        const declDetection = detectApiIntegration(declScope.text);
        const declSignals = declDetection.signals.map((s) => ({ verb: s.verb, noun: s.noun }));
        // The declaration legitimately wins even over a read error (it is the
        // human overrule), but if scope was incomplete we say so — the contract
        // is that contradictions stay visible, not silent (#2365 review).
        const baseMsg = declDetection.detected
          ? `api-coverage: COVERAGE.md declares no external API integration, overriding ${declSignals.length} detected signal(s) — confirm the declaration is accurate`
          : 'api-coverage: COVERAGE.md declares no external API integration — matrix not required';
        return gateVerdict('pass', false, {
          block: false,
          passed: true,
          coverage_present: true,
          matrix: coverageFile,
          counts: v.counts,
          none_declared: true,
          detected: declDetection.detected,
          ...(declDetection.detected ? { signals: declSignals } : {}),
          ...(declScope.readError ? { scope_read_error: declScope.readError } : {}),
          message: declScope.readError
            ? `${baseMsg} (note: phase scope was incompletely read — ${declScope.readError})`
            : baseMsg,
        });
      }
      return gateVerdict('pass', false, {
        block: false,
        passed: true,
        coverage_present: true,
        matrix: coverageFile,
        counts: v.counts,
        message: `api-coverage: matrix present (${v.counts.surface} capabilities, ${v.counts.optout} opt-out)`,
      });
    }
    // Fixed-template message (no raw cell content echoed into the LLM-facing
    // message). The structured `errors` array is safe (row-indexed, no cell
    // values) and travels as data for tooling that wants detail.
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: true,
      matrix: coverageFile,
      error_count: v.errors.length,
      errors: v.errors,
      message: `api-coverage: COVERAGE.md has ${v.errors.length} problem(s) — fix the matrix (every capability INTEGRATE or OPT-OUT with a reason) before sealing`,
    });
  }
  if (suffixed.length > 1) {
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: false,
      message: `api-coverage: multiple *-COVERAGE.md files found (${suffixed.length}) — consolidate into one COVERAGE.md before sealing`,
    });
  }

  // (2) no matrix — detect whether this phase integrates an external API.
  const scope = readPhaseScope(projectDir, resolvedDir, phaseNumber);
  if (scope.readError) {
    // Fail-closed: an unreadable plan could be the one describing the
    // integration, so we cannot certify "no integration" — block and surface it. The blocking
    // policy is unchanged; the outcome is `unreadable` (exit UNAVAILABLE, #5170).
    return gateUnreadable(true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: false,
      message:
        `api-coverage: could not read the phase scope (${scope.readError}); ` +
        'refusing to certify no external-API integration from incomplete scope. ' +
        'Fix the unreadable plan file, or add a COVERAGE.md declaration.',
    });
  }
  // An EMPTY scope is not a negative verdict. This gate's neighbouring arms
  // already fail closed (unresolvable phase → block; unreadable plan → block),
  // but a phase with no plan body AND no roadmap section fell through to
  // detection over zero bytes and CERTIFIED "no external-API integration" —
  // clearing a blocking seal gate on a probe that examined nothing
  // (ADR-3889 failure class (c), #3909). The discriminator is BYTES EXAMINED,
  // never SIGNALS FOUND: a phase with real plans and no API vocabulary still
  // reaches the pass below unchanged.
  if (scope.text.trim() === '') {
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: false,
      scope_unavailable: true,
      message:
        'api-coverage: the phase scope is empty — no plan body and no roadmap section were ' +
        'found, so nothing was examined. Refusing to certify no external-API integration ' +
        'from an unestablished scope. Add the phase plan, or add a COVERAGE.md declaration.',
    });
  }

  const detection = detectApiIntegration(scope.text);
  if (detection.detected) {
    // Surface only verb/noun (typed, bounded) — NOT raw prose snippets — so the
    // gate output cannot relay injected PLAN.md instructions to the orchestrator.
    const signals = detection.signals.map((s) => ({ verb: s.verb, noun: s.noun }));
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      coverage_present: false,
      detected: true,
      signals,
      message:
        'api-coverage: external-API integration detected without a coverage matrix. ' +
        'Produce COVERAGE.md enumerating the API surface (every capability INTEGRATE or ' +
        'OPT-OUT with a reason) before sealing. Full coverage is the default.',
    });
  }

  return gateVerdict('pass', false, {
    block: false,
    passed: true,
    coverage_present: false,
    detected: false,
    message: 'api-coverage: no external-API integration detected; coverage matrix not required',
  });
}
