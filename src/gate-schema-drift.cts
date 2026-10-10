/**
 * `check verify-schema-drift` as a gate module (#5219, epic #5056, ADR-5057 §4 closing arm C): it
 * returns a `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * The `drift` capability's blocking gate at `execute:wave:post`. It reports schema-relevant files the
 * phase's plans declare in `files_modified` for which no database push is evidenced in the phase's
 * summaries or its own commit subjects (`checkSchemaDrift`, `schema-detect.cjs`).
 *
 * Dispatched gate, payload exit mode: the verdict is read from stdout (`.block`) and a non-zero exit
 * is "the check command failed" (gsd-core/workflows/execute-phase/steps/wave-post-gate-hooks.md step
 * 1; gsd-core/references/loop-hook-dispatch.md "a gate verb never exits non-zero to say blocked";
 * capabilities/drift declares schema-drift `blocking: true, onError: skip`). A blocking verdict is
 * therefore exit 0 and "could not look" is exit 69 (#5170); the router declares both.
 *
 * Non-blocking contract: a throw anywhere yields a non-blocking `unreadable` verdict, never a crash.
 *
 * Argv after the verb: `<phase>`. The bypass (`GSD_SKIP_SCHEMA_CHECK=true`) arrives as `env`, read by
 * the router from the process environment; the gate reads no ambient state for it.
 */

import path from 'node:path';
import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { readTextEvidence, readPlanScanEvidence, statEvidence } from './gate-evidence.cjs';
import { resolveEvaluationScope } from './gate-evaluation-scope.cjs';
import { checkSchemaDrift } from './schema-detect.cjs';
import { resolvePhaseDirByToken } from './gate-phase-context.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-document.cjs is an export= CommonJS module
import planDocumentMod = require('./plan-document.cjs');

const { planningDir } = planningWorkspace;
const { parsePlanDocument } = planDocumentMod;

/**
 * The schema-drift verdict for "drift was not evaluated" (#5170): non-blocking payload (the
 * gate's non-blocking contract), outcome `unreadable` so the exit status says "could not look".
 */
function schemaDriftUnreadable(message: string, detail?: { file: string; reason: string }): GateVerdict {
  return gateUnreadable(false, {
    block: false,
    drift_detected: false,
    blocking: false,
    ...(detail === undefined ? {} : { unreadable: true, unreadable_file: detail.file, read_error: detail.reason }),
    message,
  });
}

function runSchemaDriftGate(cwd: string, phaseArg: string, skipFlag: boolean): GateVerdict {
  const pDir = planningDir(cwd);
  const phasesDir = path.join(pDir, 'phases');
  // An ABSENT phases directory is the documented "nothing to check" (`none`); one that cannot be
  // examined (an EACCES on a parent — `fs.existsSync` said `false` for it) is `unreadable`.
  const phasesRoot = statEvidence(phasesDir);
  if (phasesRoot.kind === 'unreadable') {
    return schemaDriftUnreadable(
      `schema-drift could not examine ${phasesDir} (${phasesRoot.reason}); drift was not evaluated`,
      { file: phasesDir, reason: phasesRoot.reason },
    );
  }
  if (phasesRoot.kind === 'none') {
    return gateVerdict('skip', false, { block: false, drift_detected: false, blocking: false, message: 'No phases directory' });
  }

  // Resolve the phase directory with the canonical phase-directory matcher
  // (phase-id.cjs::matchPhaseDirs), not a naive substring test. A bare
  // `.includes(phaseArg)` lets a non-existent phase silently match a different
  // phase whose directory name merely contains the requested token (e.g. "1"
  // matching "11-expansion"), making the drift gate inspect the wrong phase.
  // This shares the one selection rule with find-phase / verify
  // phase-completeness rather than restating it. (#1571, #2528)
  const phaseDir = resolvePhaseDirByToken(cwd, phasesDir, phaseArg);

  if (!phaseDir) {
    // An unresolvable phase is "could not look" (#5170): there is no phase directory to evaluate.
    return schemaDriftUnreadable(`Phase directory not found: ${phaseArg}`);
  }

  // #3183: canonical LIVE plan/summary sets (root+nested,
  // status: superseded EXCLUDED) from the single owner, rather than a
  // root-only readdirSync filter — a superseded plan's claimed
  // files_modified is no longer treated as an expected drift target, and
  // nested (#3139 layout) plans/summaries are no longer invisible to the
  // drift check.
  // A scan that did not see every plan (an existing nested plans/ that could not be read) is
  // `unreadable`, never a short plan set: the files_modified of the plans it missed are drift targets.
  const planScan = readPlanScanEvidence(phaseDir);
  if (planScan.kind === 'unreadable' && !skipFlag) {
    return schemaDriftUnreadable(
      `schema-drift could not scan the plans of ${phaseDir} (${planScan.reason}); drift was not evaluated`,
      { file: phaseDir, reason: planScan.reason },
    );
  }
  const { planFiles, summaryFiles } = planScan.kind === 'found' ? planScan.value : { planFiles: [], summaryFiles: [] };

  // #5170 (ADR-5057 §4): every read here is typed evidence. A file that cannot be read is
  // `unreadable` and is reported as such — it is never "no files, so no drift". A file that
  // vanished since the scan (`none`) contributes nothing.
  let unreadableRead: { file: string; reason: string } | null = null;
  const allFiles: string[] = [];
  for (const pf of planFiles) {
    const read = readTextEvidence(path.join(phaseDir, pf));
    if (read.kind === 'unreadable') {
      unreadableRead = unreadableRead ?? { file: pf, reason: read.reason };
      continue;
    }
    if (read.kind === 'none') continue;
    // `files_modified` through the Frontmatter Module (the read phase-plan-index uses via
    // RawPlan.filesModified): block sequences, inline arrays and CRLF all yield their files.
    for (const file of parsePlanDocument(read.value).filesModified) {
      const trimmed = file.trim();
      if (trimmed) allFiles.push(trimmed);
    }
  }

  let executionLog = '';
  for (const sf of summaryFiles) {
    const read = readTextEvidence(path.join(phaseDir, sf));
    if (read.kind === 'unreadable') {
      unreadableRead = unreadableRead ?? { file: sf, reason: read.reason };
      continue;
    }
    if (read.kind === 'found') executionLog += read.value + '\n';
  }

  // `--skip` (GSD_SKIP_SCHEMA_CHECK) bypasses the gate, so what could not be read is moot then.
  if (unreadableRead !== null && !skipFlag) {
    return schemaDriftUnreadable(
      `schema-drift could not read ${unreadableRead.file} (${unreadableRead.reason}); drift was not evaluated`,
      { file: unreadableRead.file, reason: unreadableRead.reason },
    );
  }

  // #5164: the phase's own commits from the evaluation-scope resolver (ADR-5057 §4) — the former
  // `git log --all -50` let a commit on ANY branch, from ANY phase, put a schema push in the log.
  const phaseScope = resolveEvaluationScope(cwd, { kind: 'phase', phase: phaseArg, phaseDir }, { includeFiles: false });
  if (phaseScope.commits.length > 0) {
    // Subjects only, as the `git log --oneline` it replaces: a quoted push command in a commit BODY must not change the verdict.
    executionLog += '\n' + phaseScope.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n');
  }

  const result = checkSchemaDrift(allFiles, executionLog, { skipCheck: skipFlag }) as unknown as Record<string, unknown>;

  const isSkipped = !!result['skipped'];
  // Uniform gate contract: `block` = true means "this gate's bad condition is met".
  // When skipCheck is true (GSD_SKIP_SCHEMA_CHECK=true), the gate is bypassed —
  // block must be false regardless of whether drift was detected.
  // drift_detected and blocking are kept for compatibility.
  const block = isSkipped ? false : !!result['driftDetected'];
  return gateVerdict(isSkipped ? 'skip' : (block ? 'block' : 'pass'), block, {
    block,
    drift_detected: result['driftDetected'],
    blocking: result['blocking'],
    schema_files: result['schemaFiles'],
    orms: result['orms'],
    unpushed_orms: result['unpushedOrms'],
    message: result['message'],
    skipped: isSkipped,
  });
}

export function evaluateSchemaDriftGate(input: {
  projectDir: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}): GateResult {
  const phaseArg = input.args[0] || '';
  if (!phaseArg) {
    // UNKNOWN: the pre-move `error('Usage…')` named no reason, and the reason is observable (#5219).
    return gateUsageFailure(GATE_FAILURE_CODE.UNKNOWN, 'Usage: verify schema-drift <phase> [--skip]');
  }
  const skipFlag = input.env?.['GSD_SKIP_SCHEMA_CHECK'] === 'true';

  // Non-blocking contract: a throw anywhere yields a non-blocking payload, never a crash.
  try {
    return runSchemaDriftGate(input.projectDir, phaseArg, skipFlag);
  } catch (err) {
    // #5170: a gate that threw did not evaluate drift. The payload stays non-blocking (the contract
    // above), but the exit status says "could not look" (UNAVAILABLE) instead of a clean exit 0.
    return schemaDriftUnreadable('exception: ' + (err instanceof Error ? err.message : String(err)));
  }
}
