/**
 * `check predicate` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): generic
 * evaluator for capability gate `check.predicate` blocks (#2008). It returns a `GateResult`; the
 * command router formats it. Imports no io module and performs no direct console/stdout/stderr
 * write (ESLint-enforced).
 *
 * The workflow gate-dispatch invokes this for any gate whose `check` carries a `predicate` (instead
 * of a `query`); the predicate object is passed as `--predicate '<json>'`. The standard `{ block,
 * message, details? }` gate contract is the payload. A malformed predicate / unknown kind THROWS
 * inside the evaluator and is mapped here to a `usage` failure (non-zero exit at the router), which
 * the workflow's two-step gate contract treats as a step-1 command failure routed per the gate's
 * `onError`.
 *
 * Invocation (argv after the verb):
 *   --predicate '<json>' [--phase-dir <dir>] [--phase-number <n>] [--phase-req-ids <ids>]
 *
 * The subprocess runs at the runtime project root (`projectDir`), inheriting the process env.
 * Phase flags are passed as GSD_GATE_PHASE_NUMBER / GSD_GATE_PHASE_DIR / GSD_GATE_PHASE_REQ_IDS
 * environment data, overriding inherited values; command text is never rewritten.
 */

import path from 'node:path';
import { gateVerdict, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { readDirEvidence, statEvidence } from './gate-evidence.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { parsePredicateFlags } from './gate-args.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
import { tryWithinRoot } from './security.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gatePredicateEval = require('./gate-predicate-evaluator.cjs');
const { evaluatePredicate } = gatePredicateEval;
import { execTool, platformReadSync } from './shell-command-projection.cjs';

/**
 * Production subprocess binding for the gate-predicate evaluator. Wraps the
 * bounded `execTool` seam (shell-command-projection) as a `runBoundedShell`
 * the pure evaluator consumes. `sh -c` receives the capability-authored command
 * unchanged. `execTool` merges the evaluator's context env over the inherited
 * process env and kills the direct subprocess (SIGTERM) on timeout.
 *
 * `timedOut` comes from execTool's ETIMEDOUT classification, not from a signal:
 * a command that self-terminates with SIGTERM blocks as a non-zero result but is
 * not misreported as a timeout. See ADR-2008 and the Shell Command Projection Module.
 */
export function buildPredicateDeps() {
  return {
    runBoundedShell(opts: { command: string; cwd: string; timeoutMs: number; env: Record<string, string> }): {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
    } {
      const r = execTool('sh', ['-c', opts.command], { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env });
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        signal: r.signal,
        timedOut: r.timedOut,
      };
    },
    findPhaseArtifact(phaseDir: string, artifactSuffix: string): string[] {
      // #5170 (ADR-5057 §4): an ABSENT directory or artifact is `none` (the artifact is not there);
      // one that exists but cannot be examined is `unreadable` and THROWS — `evaluateCheckPredicate`
      // maps a throw to the usage failure the dispatch contract routes by `onError`. It is never
      // folded into "artifact not found", which a predicate may read as a clean answer.
      const unreadable = (target: string, reason: string): never => {
        throw new Error(`predicate artifact could not be examined: ${target} (${reason})`);
      };
      const regularFileOrNull = (candidate: string): string | null => {
        const st = statEvidence(candidate);
        if (st.kind === 'unreadable') return unreadable(candidate, st.reason);
        return st.kind === 'found' && st.value.isFile() ? candidate : null;
      };
      const phaseDirStat = statEvidence(phaseDir);
      if (phaseDirStat.kind === 'unreadable') return unreadable(phaseDir, phaseDirStat.reason);
      if (phaseDirStat.kind === 'none') return [];
      if (
        artifactSuffix === '.' ||
        artifactSuffix === '..' ||
        artifactSuffix.includes('\0') ||
        path.basename(artifactSuffix) !== artifactSuffix ||
        path.win32.basename(artifactSuffix) !== artifactSuffix
      ) {
        return [];
      }
      // #5313: collect EVERY distinct match; the evaluator fails closed on >1 instead of trusting listing order.
      const found: string[] = [];
      const planningContained = tryWithinRoot(path.join('.planning', artifactSuffix), phaseDir);
      if (planningContained !== null) {
        const planning = regularFileOrNull(planningContained);
        if (planning !== null) found.push(planning);
      }
      const listing = readDirEvidence(phaseDir);
      if (listing.kind === 'unreadable') return unreadable(phaseDir, listing.reason);
      if (listing.kind === 'none') return [];
      for (const f of listing.value) {
        if (f.endsWith('-' + artifactSuffix) || f === artifactSuffix) {
          const candidateContained = tryWithinRoot(f, phaseDir);
          if (candidateContained === null) continue;
          const candidate = regularFileOrNull(candidateContained);
          if (candidate !== null) found.push(candidate);
        }
      }
      return found;
    },
    readFrontmatter(filePath: string): Record<string, unknown> {
      const content = platformReadSync(filePath);
      if (content === null) throw new Error(`predicate artifact disappeared before it could be read: ${filePath}`);
      const parsed = extractFrontmatter(content, filePath) as Record<string, unknown>;
      return parsed;
    },
  };
}

export function evaluateCheckPredicate(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir } = input;
  const flags = parsePredicateFlags(input.args);
  const predicateJson = flags['predicate'];
  if (!predicateJson) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'predicate requires --predicate <json> (the gate hook check.predicate object)',
    );
  }
  let predicate: unknown;
  try {
    predicate = JSON.parse(predicateJson);
  } catch {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, 'predicate --predicate value must be valid JSON');
  }
  const rawPhaseDir = flags['phase-dir'];
  let resolvedPhaseDir: string | undefined = rawPhaseDir;
  if (typeof rawPhaseDir === 'string' && rawPhaseDir !== '') {
    const resolved = resolveContainedPath(rawPhaseDir, projectDir);
    if (isGateUsageFailure(resolved)) return resolved;
    resolvedPhaseDir = resolved;
  }
  const ctx = {
    cwd: projectDir,
    phaseNumber: flags['phase-number'],
    phaseDir: resolvedPhaseDir,
    phaseReqIds: flags['phase-req-ids'],
  };
  let result;
  try {
    result = evaluatePredicate(predicate, ctx, buildPredicateDeps());
  } catch (e) {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `gate predicate evaluation failed: ${(e as Error).message}`);
  }
  return gateVerdict(result.block ? 'block' : 'pass', result.block === true, { ...result });
}
