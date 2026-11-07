/**
 * `check tdd-review-checkpoint` as a gate module (#5139, epic #5056, ADR-5057 §4 first bullet): it
 * returns a `GateResult`; the command router formats it. Imports no io module and performs no
 * direct console/stdout/stderr write (ESLint-enforced).
 *
 * End-of-phase advisory check: scans `type: tdd` plans for RED/GREEN/REFACTOR gate-sequence
 * compliance (`test(<plan>):` / `feat(<plan>):` / `refactor(<plan>):` commits) and builds a review
 * table. `passed` is always true (advisory — never truly blocks); `block` is `violations > 0` so
 * the host loop can read one uniform field.
 *
 * `type: tdd` is detected by the Frontmatter Module's `frontmatterKeyHasValue` (the old
 * `^type:\s*tdd\s*$` multiline test over the fence owner's block, key and value escaped).
 *
 * A plan's commits come from the evaluation-scope resolver (#5164, ADR-5057 §4): the commits
 * reachable from HEAD whose SUBJECT is `<type>(<phase>-<plan>):`, anchored and zero-padding
 * tolerant. A plan id that is not `<phase>-<plan>` (a plan named `.*-PLAN.md`) matches nothing,
 * and a git failure is "no commits" exactly as before.
 *
 * Cross-plan GREEN (#4867): a gap closure is planned as a RED-only probe plan plus the plan that
 * `depends_on` it and carries the fix. A `type: tdd` plan with its own RED but no GREEN is credited
 * with a `feat(...)` commit under any plan that lists it in `depends_on`, directly or through a
 * chain; the row carries `greenFrom` and the report names the supplier. Its own RED is still
 * required, and a plan nothing depends on is scored on its own commits alone.
 *
 * Argv after the verb: `<phase>` (a number; an unresolvable phase reports zero plans) and an optional
 * `--record` (#5354), which also WRITES `TDD-REVIEW-SEAL.json` in the phase directory: one entry per
 * plan that passes, so a failing sibling plan does not cost the others their credit after a squash.
 * ADR-5057 §4 says a gate returns a verdict and never calls `output()`; it says nothing on writes, so this
 * write is a disclosed exception. The seal file I/O lives in `gate-tdd-review-seal` (this module imports no io
 * module); the write is requested here because the seal is derived from the very evaluation this gate
 * performs, and a separate verb would have to repeat it.
 */

import path from 'node:path';
import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolvePhaseDir } from './gate-phase-context.cjs';
import { readDirEvidence, readPlanSetEvidence, readTextEvidence, evidenceFromError, evidenceNone } from './gate-evidence.cjs';
import { resolveEvaluationScope, commitIsAncestor, isFullSha } from './gate-evaluation-scope.cjs';
import { SEAL_FILE, readSeal, writeSeal, summaryCommitsAllUnreachable, historyIsComplete, commitIsGone, commitReachability, type SealEntry, type SealPlans } from './gate-tdd-review-seal.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { frontmatterKeyHasValue, extractFrontmatter } = frontmatterMod;

interface TddPlanRow {
  planId: string;
  red: boolean;
  green: boolean;
  refactor: boolean;
  status: 'Pass' | 'FAIL' | 'NotEvaluable';
  missing: string[];
  /** Set only on an order violation (#5275): both commit kinds exist but no GREEN follows a RED. A missing commit is told by `missing`. */
  reason?: TddRowReason;
  /** Plans whose `feat(...)` commit supplied this plan's GREEN through `depends_on` (#4867). */
  greenFrom?: string[];
}

export const TDD_ROW_REASON = {
  GREEN_BEFORE_RED: 'green_before_red',
} as const;
type TddRowReason = (typeof TDD_ROW_REASON)[keyof typeof TDD_ROW_REASON];

/**
 * True when the plan's frontmatter declares `type: tdd` (CRLF included, #2449). The block is the
 * one fence owner's, read as RAW text — not through the YAML parser — so a block the parser refuses
 * (a `--- x` line before `type:`) still classifies, exactly as under the old `^type:\s*tdd\s*$`
 * multiline regex, whose edge behaviour (a duplicate `type:` key, a value on the next line,
 * `type : tdd` NOT matching, `type: "tdd"` / `type: tdd # note` NOT matching) is preserved.
 */
function isTddPlan(content: string): boolean {
  return frontmatterKeyHasValue(content, 'type', 'tdd');
}

/** A `depends_on` token as a plan id: `01.1-20`, `01.1-20-PLAN` and `01.1-20-PLAN.md` all name plan `01.1-20`. */
function toPlanId(token: string): string {
  return token.trim().replace(/-PLAN(?:\.md)?$/i, '');
}

/**
 * The plan ids a plan lists in `depends_on` (#4867). A plan whose frontmatter does not parse, or has
 * no `depends_on`, depends on nothing: the pairing below only ever ADDS credit, so an unreadable
 * link can never turn a failing plan into a passing one.
 */
function dependsOnOf(content: string): string[] {
  // `extractFrontmatter` does not throw: an unparseable block is an empty result, so `depends_on` is absent.
  const value: unknown = extractFrontmatter(content)['depends_on'];
  const tokens = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(',') : [];
  return tokens.map(toPlanId).filter((id) => id !== '');
}

/** Every plan that depends on `planId`, directly or through a chain (#4867); a cycle is walked once. */
function transitiveDependents(planId: string, dependents: ReadonlyMap<string, readonly string[]>): string[] {
  const seen = new Set<string>();
  const queue = [planId];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.shift() as string) ?? []) {
      if (next !== planId && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].sort();
}

interface PlanCommit {
  sha: string;
  kind: string;
}

/**
 * The plan's own commits (`test`, `feat`, `refactor`, …) — those that touched at least one path
 * (`pathspecs: ['.']`, as the old `git log -- .` lookup did) — with the sha the ordering check needs.
 * An unresolvable scope (git unavailable, an id that is not `<phase>-<plan>`) is "no commits".
 */
function planCommits(projectDir: string, planId: string): PlanCommit[] {
  const scope = resolveEvaluationScope(projectDir, { kind: 'plan', planId }, { pathspecs: ['.'], commitsOnly: true });
  const commits: PlanCommit[] = [];
  for (const commit of scope.commits) {
    const kind = /^([a-z]+)\(/.exec(commit.subject)?.[1];
    if (kind) commits.push({ sha: commit.sha, kind });
  }
  return commits;
}

const shasOfKind = (commits: readonly PlanCommit[], kind: string): string[] =>
  commits.filter((c) => c.kind === kind).map((c) => c.sha);

/**
 * Whether some GREEN descends from some RED (#5275). Decided by ancestry only — never log position or
 * commit date — so a history merged from worktree branches is judged by what each commit descends from.
 * `true` as soon as one pair is in order; `null` when git could not answer for a pair and none was
 * in order (an environment fault is not a violation, so the caller keeps the credit); else `false`.
 */
function greenFollowsRed(projectDir: string, reds: readonly string[], greens: readonly string[]): boolean | null {
  let unanswered = false;
  for (const red of reds) {
    for (const green of greens) {
      const redIsAncestor = commitIsAncestor(projectDir, red, green);
      if (redIsAncestor === true) return true;
      if (redIsAncestor === null) unanswered = true;
    }
  }
  return unanswered ? null : false;
}

interface UnreadableSource {
  source: string;
  reason: string;
}

/**
 * The verdict when the review could not read a plan or the phase directory. Advisory policy is
 * unchanged (`block: false`); the outcome is `unreadable` (exit UNAVAILABLE) and `passed` is false
 * because nothing was certified.
 */
function unreadableReview(phase: string, tddPlans: number, unreadable: UnreadableSource[]): GateResult {
  const names = unreadable.map((u) => `${u.source} (${u.reason})`).join(', ');
  return gateUnreadable(false, {
    block: false,
    passed: false,
    tddPlans,
    violations: 0,
    table: '',
    rows: [] as TddPlanRow[],
    unreadable,
    message: `TDD review could not read: ${names}. Phase ${phase} was not reviewed.`,
  });
}

/** One TDD plan's row, plus the evidence `--record` seals when it passes (live hashes stay preferred over the seal's). */
function planRow(
  projectDir: string,
  phaseDir: string,
  planPath: string,
  seal: SealPlans,
  dependents: ReadonlyMap<string, string[]>,
): { row: TddPlanRow; evidence?: SealEntry } {
  const planId = path.basename(planPath, '-PLAN.md');
  const commits = planCommits(projectDir, planId);
  const reds = shasOfKind(commits, 'test');
  // #5354: the seal stands in once the plan was squashed away, and the seal tells it: its RED (else its GREEN) is gone,
  // that is no longer reachable from HEAD (an absent object counts only in a complete history). A live `test(<plan>):`
  // commit proves nothing, since a squash may carry that title or be followed by one. A seal whose RED is still reachable
  // was not squashed, so it credits nothing. It credits each kind no live commit credits; live hashes stay preferred for
  // the evidence.
  const entry = Object.hasOwn(seal, planId) ? seal[planId] : undefined;
  const probe = isFullSha(entry?.red) ? entry.red : entry?.green;
  let complete: boolean | undefined;
  const historyComplete = (): boolean => complete ??= historyIsComplete(projectDir);
  const squashed = isFullSha(probe) && commitIsGone(commitReachability(projectDir, probe, 'HEAD'), historyComplete);
  const sealed = squashed && entry !== undefined && entry.red !== entry.green ? entry : {};
  const sealedRed = isFullSha(sealed.red);
  const sealedGreen = isFullSha(sealed.green);
  const red = reds.length > 0 || sealedRed;
  const refactor = commits.some((c) => c.kind === 'refactor');

  // #5275: with a RED present, a GREEN counts only when it descends from a RED. Without one there is
  // nothing to order against and the plan is already missing RED, so a GREEN commit stays credited.
  const inOrder = (greens: readonly string[]): boolean =>
    greens.length > 0 && (reds.length === 0 || greenFollowsRed(projectDir, reds, greens) !== false);

  const ownGreens = shasOfKind(commits, 'feat');
  const ownOk = inOrder(ownGreens);

  // #4867: a RED-only probe plan is satisfied by the GREEN of a plan that (transitively) declares
  // `depends_on` it. Only a real `feat(...)` commit under such a plan counts, and it must follow the
  // RED too (#5275); the plan's own RED is still required, and a plan nothing depends on is scored
  // on its own commits alone.
  const dependentGreens = ownOk
    ? []
    : transitiveDependents(planId, dependents).map((id) => ({ id, greens: shasOfKind(planCommits(projectDir, id), 'feat') }));
  const greenFrom = dependentGreens.filter((d) => inOrder(d.greens)).map((d) => d.id);
  const green = ownOk || greenFrom.length > 0 || sealedGreen;
  const anyGreenCommit = ownGreens.length > 0 || dependentGreens.some((d) => d.greens.length > 0) || sealedGreen;

  const missing: string[] = [];
  if (!red) missing.push('RED');
  if (!anyGreenCommit) missing.push('GREEN');
  // #5354: credit incomplete and no live plan commit: a plan squashed away. With nothing sealed, its SUMMARY's task commits
  // are all gone. With a complete-looking seal that did not apply, a shallow clone cannot tell (it lacks the sealed commits).
  const sealedPair = entry !== undefined && isFullSha(entry.red) && isFullSha(entry.green) && entry.red !== entry.green;
  const notEvaluable = missing.length > 0 && commits.length === 0 && (Object.hasOwn(seal, planId)
    ? sealedPair && !squashed && !historyComplete()
    : summaryCommitsAllUnreachable(projectDir, phaseDir, planPath));
  const status: TddPlanRow['status'] = notEvaluable ? 'NotEvaluable' : missing.length === 0 && green ? 'Pass' : 'FAIL';
  // Both commit kinds exist but no GREEN follows a RED: its own reason. A row that fails for a
  // missing commit keeps the exact shape it always had (`missing` already says why).
  const reason: TddRowReason | undefined = status === 'FAIL' && missing.length === 0
    ? TDD_ROW_REASON.GREEN_BEFORE_RED
    : undefined;
  // A credit the seal supplied is written back as the seal has it: a live `test(<plan>):` commit left by the squash is
  // reachable, and sealing it would make the next run read the plan as not squashed and drop the seal's GREEN.
  const redSha = sealedRed ? sealed.red : reds[0];
  const greenSha = (ownOk ? ownGreens[0] : dependentGreens.find((d) => inOrder(d.greens))?.greens[0]) ?? sealed.green;
  const sealEvidence = status === 'Pass' && isFullSha(redSha) && isFullSha(greenSha) ? { red: redSha, green: greenSha } : undefined;

  return {
    row: {
      planId, red, green, refactor, status, missing,
      ...(reason ? { reason } : {}),
      ...(greenFrom.length > 0 ? { greenFrom } : {}),
    },
    ...(sealEvidence ? { evidence: sealEvidence } : {}),
  };
}

export function evaluateTddReviewCheckpoint(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir } = input;
  const phase = input.args[0] || '';
  if (!phase) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'tdd.review-checkpoint requires a phase argument: check tdd.review-checkpoint <phase> [--record]',
    );
  }

  // #5170 (ADR-5057 §4): an ABSENT phase directory is `none` (no plans, the skip below); anything
  // that exists but cannot be read is `unreadable` and the verdict says so — an unreadable plan is
  // never "not a TDD plan".
  const located = resolvePhaseDir(projectDir, phase);
  if (located.kind === 'unreadable') {
    return unreadableReview(phase, 0, [{ source: `phase ${phase}`, reason: located.reason }]);
  }
  const phaseDir = located.kind === 'found' ? located.value : '';

  // Find all PLAN.md files with type: tdd in frontmatter
  const tddPlanFiles: string[] = [];
  // #4867: plan id -> the plans that list it in `depends_on`, over EVERY plan of the phase (a
  // dependent GREEN plan is usually `type: execute`, not `tdd`).
  const dependents = new Map<string, string[]>();
  const unreadable: UnreadableSource[] = [];
  if (phaseDir) {
    const entries = readDirEvidence(phaseDir);
    if (entries.kind === 'unreadable') {
      unreadable.push({ source: phaseDir, reason: entries.reason });
    } else if (entries.kind === 'found') {
      // #3183: canonical plan set (root+nested, superseded-excluded) from the single owner. A scan
      // that did not see every plan (an unreadable nested plans/) is `unreadable`, never a short list.
      const planSet = readPlanSetEvidence(phaseDir);
      if (planSet.kind === 'unreadable') {
        unreadable.push({ source: planSet.span ?? phaseDir, reason: planSet.reason });
      } else {
        for (const file of planSet.value) {
          const planPath = path.join(phaseDir, file);
          const plan = readTextEvidence(planPath);
          if (plan.kind === 'unreadable') unreadable.push({ source: planPath, reason: plan.reason });
          else if (plan.kind === 'found') {
            if (isTddPlan(plan.value)) tddPlanFiles.push(planPath);
            const planId = path.basename(planPath, '-PLAN.md');
            for (const dep of dependsOnOf(plan.value)) dependents.set(dep, [...(dependents.get(dep) ?? []), planId]);
          }
        }
      }
    }
  }
  if (unreadable.length > 0) return unreadableReview(phase, tddPlanFiles.length, unreadable);

  if (tddPlanFiles.length === 0) {
    return gateVerdict('skip', false, {
      // Uniform gate contract: block = violations > 0 (advisory; never truly blocks).
      block: false,
      passed: true,
      tddPlans: 0,
      violations: 0,
      table: '',
      rows: [] as TddPlanRow[],
      message: `No type:tdd plans found in phase ${phase}. TDD review skipped.`,
    });
  }

  // For each TDD plan, extract the plan ID (e.g. "01-02-PLAN.md" → "01-02") and check git log
  const rows: TddPlanRow[] = [];
  // ADR-5057 §4: an unreadable seal is not an absent one; never fold it into "no entry".
  const sealRead = phaseDir ? readSeal(phaseDir) : evidenceNone<SealPlans>();
  if (sealRead.kind === 'unreadable') return unreadableReview(phase, tddPlanFiles.length, [{ source: sealRead.span ?? SEAL_FILE, reason: sealRead.reason }]);
  const seal: SealPlans = sealRead.kind === 'found' ? sealRead.value : {};
  const evidence: Record<string, SealEntry> = {};
  for (const planPath of tddPlanFiles) {
    const { row, evidence: sealEvidence } = planRow(projectDir, phaseDir, planPath, seal, dependents);
    rows.push(row);
    if (sealEvidence) evidence[row.planId] = sealEvidence;
  }

  const violations = rows.filter(r => r.status === 'FAIL').length;

  // Build review table
  const statusWidth = Math.max(6, ...rows.map(r => r.status.length));
  const tableHeader = `| Plan | RED | GREEN | REFACTOR | ${'Status'.padEnd(statusWidth)} |`;
  const tableDivider = `|------|-----|-------|----------|${'-'.repeat(statusWidth + 2)}|`;
  const tableRows = rows.map(r =>
    `| ${r.planId.padEnd(4)} | ${r.red ? ' ✓ ' : ' ✗ '} | ${r.green ? '  ✓  ' : '  ✗  '} | ${r.refactor ? '   ✓    ' : '   —    '} | ${r.status.padEnd(statusWidth)} |`,
  );

  let table = [
    `### TDD REVIEW — Phase ${phase}`,
    '',
    `TDD Plans: ${tddPlanFiles.length} | Gate violations: ${violations}`,
    '',
    tableHeader,
    tableDivider,
    ...tableRows,
  ].join('\n');

  for (const r of rows.filter(row => row.greenFrom)) {
    table += `\n\nPlan ${r.planId} GREEN is supplied by dependent plan ${(r.greenFrom ?? []).join(', ')}.`;
  }

  const notEvaluableRows = rows.filter(r => r.status === 'NotEvaluable');
  for (const r of notEvaluableRows) {
    table += `\n\nPlan ${r.planId} not evaluable: its SUMMARY task commits are unreachable and no ${SEAL_FILE} entry exists (squashed?); not counted as a violation.`;
  }

  if (violations > 0) {
    table += '\n\n⚠ Gate violations are advisory — review before advancing.';
    for (const r of rows.filter(row => row.status === 'FAIL')) {
      table += r.reason === TDD_ROW_REASON.GREEN_BEFORE_RED
        ? `\n  Plan ${r.planId} GREEN precedes RED: no feat(...) commit descends from a test(...) commit.`
        : `\n  Plan ${r.planId} missing: ${r.missing.join(', ')} gate commit(s).`;
      table += `\n  Expected commit pattern: test(${r.planId}): ... → feat(${r.planId}): ...`;
    }
  }

  // #5354: --record seals every passing plan's evidence so it survives a squash merge.
  if (phaseDir && Object.keys(evidence).length > 0 && input.args.includes('--record')) {
    try {
      writeSeal(phaseDir, evidence, sealRead);
    } catch (err) {
      const e = evidenceFromError(err, SEAL_FILE);
      return unreadableReview(phase, tddPlanFiles.length, [{ source: SEAL_FILE, reason: e.kind === 'unreadable' ? e.reason : String(err) }]);
    }
  }

  // Uniform gate contract: block = violations > 0. The gate is advisory (blocking:false in
  // capability.json), so block:true only surfaces as a warning, never halts. The human-readable
  // report is carried in `message` (and `table`) for the dispatch's advisory branch.
  return gateVerdict(violations > 0 || notEvaluableRows.length > 0 ? 'advisory' : 'pass', violations > 0, {
    block: violations > 0,
    passed: true,
    tddPlans: tddPlanFiles.length,
    violations,
    table,
    rows,
    message: table,
  });
}
