/**
 * The TDD review seal and the SUMMARY squash heuristic (#5354), split out of `gate-tdd-review-checkpoint`
 * so that gate module stays a pure evaluation (it imports no io module).
 *
 * The seal is `TDD-REVIEW-SEAL.json` in the phase directory: per plan, the RED and GREEN hashes recorded
 * before a squash merge. Repo content is hostile: every read is bounded (a symlink, a non-regular file or
 * one over `REPO_TEXT_MAX_BYTES` is `unreadable`) and the write goes through a temp file and a rename.
 */

import path from 'node:path';
import { evidenceFound, evidenceFromError, evidenceUnreadable, isPlainObject, lstatEvidence, readBoundedTextEvidence, type Evidence } from './gate-evidence.cjs';
import { extractTaskCommitRefs, commitIsAncestor, isSafeRefArgument } from './gate-evaluation-scope.cjs';
import { execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { summaryCandidates } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime-hooks-surface.cjs is an export= CommonJS module
import hooksSurfaceMod = require('./runtime-hooks-surface.cjs');
const { atomicWriteFileSync } = hooksSurfaceMod;

export const SEAL_FILE = 'TDD-REVIEW-SEAL.json';
export type SealEntry = { red: string; green: string };
export type SealPlans = Record<string, Partial<SealEntry>>;

// Cap for repo-controlled text the gate reads (the seal and SUMMARY.md); a real one is a few KiB at most; anything bigger is not read (repo content, so hostile).
const REPO_TEXT_MAX_BYTES = 64 * 1024;
/** #5354: most distinct SUMMARY task commits probed per plan; each costs one `git merge-base` spawn and, when git does not know it, one `git rev-parse --verify` (the loop stops at the first id that is not gone), so at most 2 * SUMMARY_REFS_MAX spawns; plus one `git rev-parse --is-shallow-repository` per call; plus, when every id exists, one `git rev-list` per call and one `git show` per id. */
const SUMMARY_REFS_MAX = 64;

function parseSeal(text: string): Evidence<SealPlans> {
  try {
    const top: unknown = JSON.parse(text);
    if (!isPlainObject(top)) return evidenceUnreadable(`${SEAL_FILE} is not a JSON object`, SEAL_FILE);
    if (top.plans === undefined) return evidenceUnreadable(`${SEAL_FILE} has no "plans" object`, SEAL_FILE);
    if (!isPlainObject(top.plans)) return evidenceUnreadable(`${SEAL_FILE} "plans" is not an object`, SEAL_FILE);
    for (const e of Object.values(top.plans)) {
      if (!isPlainObject(e) || (e.red !== undefined && typeof e.red !== 'string') || (e.green !== undefined && typeof e.green !== 'string')) {
        return evidenceUnreadable(`${SEAL_FILE} has a malformed plan entry`, SEAL_FILE);
      }
    }
    return evidenceFound(top.plans as SealPlans);
  } catch (err) {
    return evidenceFromError<SealPlans>(err, SEAL_FILE);
  }
}

const readBoundedText = (file: string): Evidence<string> => readBoundedTextEvidence(file, REPO_TEXT_MAX_BYTES);

/** #5354: per-plan RED/GREEN hashes recorded pre-squash. Absent is `none`; a malformed, oversize, non-regular or unreadable seal is `unreadable`. */
export function readSeal(phaseDir: string): Evidence<SealPlans> {
  const text = readBoundedText(path.join(phaseDir, SEAL_FILE));
  return text.kind === 'found' ? parseSeal(text.value) : text;
}

/** Merge `evidence` into the phase's seal via temp file + rename, refusing an existing non-regular target (a symlink would redirect the write). `prior` is never `unreadable`: the caller returns early on that, so no earlier plan's credit is dropped. */
export function writeSeal(phaseDir: string, evidence: Record<string, SealEntry>, prior: Evidence<SealPlans>): void {
  const file = path.join(phaseDir, SEAL_FILE);
  const content = `${JSON.stringify({ plans: { ...(prior.kind === 'found' ? prior.value : {}), ...evidence } }, null, 2)}\n`;
  const st = lstatEvidence(file);
  if (st.kind === 'unreadable') throw new Error(`${SEAL_FILE} cannot be examined: ${st.reason}`);
  if (st.kind === 'found' && !st.value.isFile()) throw new Error(`${SEAL_FILE} exists and is not a regular file`);
  atomicWriteFileSync(file, content, 'utf8');
}

/**
 * Whether `projectDir` has a complete (non-shallow) history. Exit 128 on a commit means "object not found" only
 * then: in a shallow clone or outside a repo it says nothing about squashing, so it must not turn an un-squashed
 * skipper into `NotEvaluable` or a reachable seal into a squashed one.
 */
export function historyIsComplete(projectDir: string): boolean {
  const shallow = execGit(['rev-parse', '--is-shallow-repository'], { cwd: projectDir });
  return !shallow.timedOut && shallow.exitCode === 0 && shallow.stdout === 'false';
}

export type CommitReachability = 'reachable' | 'unreachable' | 'missing';

/**
 * Where commit `sha` stands against `of`: `reachable` or `unreachable` as the scope owner's `commitIsAncestor`
 * answers it, and `missing` when that answer is `null` and git does not know the object. `null` means git could
 * not answer (a timeout, no git, an unsafe argument): not a "no".
 */
export function commitReachability(projectDir: string, sha: string, of: string): CommitReachability | null {
  const ancestor = commitIsAncestor(projectDir, sha, of);
  if (ancestor !== null) return ancestor ? 'reachable' : 'unreachable';
  if (!isSafeRefArgument(sha)) return null;
  const known = execGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: projectDir });
  return !known.timedOut && known.exitCode === 1 ? 'missing' : null;
}

/**
 * Whether a commit is gone (squashed away): git says it is not an ancestor of HEAD, or does not know it, in a
 * complete history. A shallow clone cuts reachable commits off too, so there it is never gone. `null` (git could
 * not answer) and `reachable` are not gone. The one place that reads a `commitReachability` answer as "squashed",
 * for the seal and for the SUMMARY task commits.
 */
export function commitIsGone(reach: CommitReachability | null, historyComplete: () => boolean): boolean {
  return (reach === 'unreachable' || reach === 'missing') && historyComplete();
}

/**
 * #5354: a plan was squashed away when it has no live plan commit and no seal entry, and its SUMMARY
 * names task commits none of which is reachable from HEAD (a missing object counts as unreachable only
 * in a complete history). A never-existing id looks the same as a squashed commit that was garbage-collected
 * or never fetched, so it is `NotEvaluable` by rule: the gate stays advisory and the row shows the
 * maintainer the unverifiable ids. No SUMMARY, no listed hash, more than SUMMARY_REFS_MAX distinct
 * hashes, or any reachable hash is an ordinary failure. When every ref exists and its subject still
 * occurs on a commit reachable from HEAD but not from the refs, the plan was rewritten (rebase/amend),
 * not squashed, so it is not unreachable. Squash evidence for a plan whose task subjects survive is the
 * seal (`--record` before the squash), which `planRow` reads first.
 */
export function summaryCommitsAllUnreachable(projectDir: string, phaseDir: string, planPath: string): boolean {
  const subjectOf = (id: string): string => {
    const s = execGit(['show', '-s', '--format=%s', id], { cwd: projectDir });
    return !s.timedOut && s.exitCode === 0 ? s.stdout.trim() : '';
  };
  const rel = path.relative(phaseDir, planPath).split(path.sep).join('/');
  let complete: boolean | undefined;
  const historyComplete = (): boolean => complete ??= historyIsComplete(projectDir);
  for (const candidate of summaryCandidates(rel)) {
    const summary = readBoundedText(path.join(phaseDir, candidate));
    if (summary.kind !== 'found') continue;
    const refs = [...new Set(extractTaskCommitRefs(summary.value))];
    // More refs than the cap is an ordinary failure: SUMMARY.md is repo content and must not buy unbounded git spawns.
    if (refs.length === 0 || refs.length > SUMMARY_REFS_MAX) return false;
    // Stop at the first ref that is not gone (reachable, or git could not answer): the plan is then an ordinary failure.
    const existing: string[] = [];
    for (const id of refs) {
      const r = commitReachability(projectDir, id, 'HEAD');
      if (!commitIsGone(r, historyComplete)) return false;
      if (r === 'unreachable') existing.push(id);
    }
    // A ref that no longer exists was squashed away, so not every ref was rewritten.
    if (existing.length < refs.length) return true;
    // Subjects of commits reachable from HEAD but not from the refs; a failed log leans to FAIL (rewritten).
    const log = execGit(['rev-list', '--format=%s', 'HEAD', '--not', ...existing], { cwd: projectDir });
    if (log.timedOut || log.exitCode !== 0) return false;
    // rev-list prints a `commit <sha>` header line before each subject line.
    const onHead = new Set(log.stdout.split('\n').filter((_, i) => i % 2 === 1));
    return !existing.every((id) => onHead.has(subjectOf(id)));
  }
  return false;
}
