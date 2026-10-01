/**
 * Gate evidence — what a gate found when it looked (#5170, epic #5056, ADR-5057 §4 third bullet).
 *
 * A gate that reads a file or directory has THREE answers, not two:
 *
 *   - `found`       the evidence is there; `value` is what was read (an empty file is `found ''`).
 *   - `none`        the evidence authoritatively does not exist (`ENOENT`, or `ENOTDIR` because a
 *                   parent component is not a directory, so the path cannot exist). Each gate keeps
 *                   its own documented policy for `none`.
 *   - `unreadable`  the evidence may exist but could not be read (`EISDIR`, `EACCES`, `EIO`, an
 *                   encoding failure ...). `reason` carries the errno code (or the message when
 *                   the failure had none); `span` names what was being read.
 *
 * `unreadable` is never `''`, `false` or an empty list: a tolerant reader that collapses it into
 * "nothing there" lets a gate pass over content it never saw. `verdictFromEvidence` is the one way
 * a gate maps evidence to a verdict, and its `unreadable` arm is typed to return an
 * `UnreadableVerdict`, so a passing verdict from that arm does not type-check.
 *
 * `fs` is reached as a namespace object at call time, never destructured at load, so a test can
 * inject a read failure by replacing the method.
 */
import fs from 'node:fs';
import type { GateVerdict, UnreadableVerdict } from './gate-verdict.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningScopeMod = require('./planning-scope.cjs');
const { SCOPE } = planningScopeMod;

/** The evidence is there; `value` is what was read. */
export type Found<T> = { readonly kind: 'found'; readonly value: T };

export type Evidence<T> =
  | Found<T>
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly reason: string; readonly span?: string };

/**
 * Evidence whose absence has already been decided by the caller (an absent directory is "no
 * entries", an absent summary contributes nothing): only `found` and `unreadable` remain, and a
 * consumer that handles `unreadable` is total.
 */
export type Observed<T> = Exclude<Evidence<T>, { readonly kind: 'none' }>;

export function evidenceFound<T>(value: T): Found<T> {
  return { kind: 'found', value };
}

export function evidenceNone<T = never>(): Evidence<T> {
  return { kind: 'none' };
}

export function evidenceUnreadable<T = never>(reason: string, span?: string): Evidence<T> {
  return span === undefined ? { kind: 'unreadable', reason } : { kind: 'unreadable', reason, span };
}

/** Errno codes meaning "the path cannot hold evidence": absent, or a parent is not a directory. */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Classify a thrown read failure as evidence: absent (`ENOENT`/`ENOTDIR`) is `none`, anything else
 * is `unreadable` carrying the errno code (or the message when there was none). A gate that wraps a
 * lookup it does not own (a locator, a roadmap reader) in `try` uses this instead of a bare `catch`.
 */
export function evidenceFromError<T>(err: unknown, span: string): Evidence<T> {
  return classifyFailure<T>(err, span);
}

function classifyFailure<T>(err: unknown, span: string): Evidence<T> {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === 'string' && ABSENT_CODES.has(code)) return evidenceNone<T>();
  if (typeof code === 'string' && code.length > 0) return evidenceUnreadable<T>(code, span);
  const message = err instanceof Error ? err.message : String(err);
  return evidenceUnreadable<T>(message.length > 0 ? message : 'unknown read failure', span);
}

/** Read a UTF-8 file as evidence. Never throws. */
export function readTextEvidence(filePath: string): Evidence<string> {
  try {
    return evidenceFound(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return classifyFailure<string>(err, filePath);
  }
}

/** Read a directory's entry names as evidence. Never throws. */
export function readDirEvidence(dirPath: string): Evidence<string[]> {
  try {
    return evidenceFound(fs.readdirSync(dirPath));
  } catch (err) {
    return classifyFailure<string[]>(err, dirPath);
  }
}

/** Read a directory's entries (with types) as evidence. Never throws. */
export function readDirEntriesEvidence(dirPath: string): Evidence<fs.Dirent[]> {
  try {
    return evidenceFound(fs.readdirSync(dirPath, { withFileTypes: true }));
  } catch (err) {
    return classifyFailure<fs.Dirent[]>(err, dirPath);
  }
}

/** Stat a path (following symlinks) as evidence. Never throws. */
export function statEvidence(targetPath: string): Evidence<fs.Stats> {
  try {
    return evidenceFound(fs.statSync(targetPath));
  } catch (err) {
    return classifyFailure<fs.Stats>(err, targetPath);
  }
}

/**
 * The canonical plan set of a phase directory that is known to exist, as evidence (#5170). Only the
 * scan's `SCOPE.COMPLETE` is a real answer: `TRUNCATED` (an existing nested `plans/` that could not be
 * read), `UNREADABLE` and `UNSCOPED` mean the scan did not see every plan, so a short or empty list is
 * `unreadable` and never "no plans". Every gate that gets its plans from `scanPhasePlans` goes through
 * this one reader.
 */
export function readPlanScanEvidence(phaseDir: string): Observed<{ planFiles: string[]; summaryFiles: string[] }> {
  const scan = scanPhasePlans(phaseDir);
  if (scan.scope !== SCOPE.COMPLETE) {
    return { kind: 'unreadable', reason: `plan scan ${scan.scope}`, span: phaseDir };
  }
  return evidenceFound({ planFiles: [...scan.planFiles], summaryFiles: [...scan.summaryFiles] });
}

/** The plan half of {@link readPlanScanEvidence}. */
export function readPlanSetEvidence(phaseDir: string): Observed<string[]> {
  const scan = readPlanScanEvidence(phaseDir);
  return scan.kind === 'unreadable' ? scan : evidenceFound(scan.value.planFiles);
}

/** The three arms a gate supplies; `unreadable` must produce an `UnreadableVerdict`. */
export interface EvidenceArms<T> {
  found: (value: T) => GateVerdict;
  none: () => GateVerdict;
  unreadable: (reason: string, span?: string) => UnreadableVerdict;
}

/** Map evidence to a verdict. Total over the three kinds. */
export function verdictFromEvidence<T>(evidence: Evidence<T>, arms: EvidenceArms<T>): GateVerdict {
  switch (evidence.kind) {
    case 'found':
      return arms.found(evidence.value);
    case 'none':
      return arms.none();
    case 'unreadable':
      return arms.unreadable(evidence.reason, evidence.span);
  }
}
