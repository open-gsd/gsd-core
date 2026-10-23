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
 * The write stays in this gate (ADR-5057 §4 keeps gates read-only otherwise) because the seal is
 * derived from the very evaluation this gate performs; a separate verb would have to repeat it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gateVerdict, gateUnreadable, gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolvePhaseDir } from './gate-phase-context.cjs';
import { readDirEvidence, readPlanSetEvidence, readTextEvidence, evidenceFromError, evidenceFound, evidenceNone, evidenceUnreadable, type Evidence } from './gate-evidence.cjs';
import { resolveEvaluationScope, extractTaskCommitRefs } from './gate-evaluation-scope.cjs';
import { execGit, retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtilsMod = require('./core-utils.cjs');
const { summaryCandidates } = coreUtilsMod;
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
  /** Plans whose `feat(...)` commit supplied this plan's GREEN through `depends_on` (#4867). */
  greenFrom?: string[];
}

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

/**
 * The plan's own commits — those that touched at least one path (`pathspecs: ['.']`, as the old
 * `git log -- .` lookup did). An unresolvable scope (git unavailable, an id that is not
 * `<phase>-<plan>`) is "no commits".
 */
function planCommits(projectDir: string, planId: string): readonly { sha: string; subject: string }[] {
  return resolveEvaluationScope(projectDir, { kind: 'plan', planId }, { pathspecs: ['.'], commitsOnly: true }).commits;
}

/** The commit types (`test`, `feat`, `refactor`, …) among `commits`, each mapped to its first sha. */
function commitKinds(commits: readonly { sha: string; subject: string }[]): ReadonlyMap<string, string> {
  const kinds = new Map<string, string>();
  for (const commit of commits) {
    const kind = /^([a-z]+)\(/.exec(commit.subject)?.[1];
    if (kind && !kinds.has(kind)) kinds.set(kind, commit.sha);
  }
  return kinds;
}

const SEAL_FILE = 'TDD-REVIEW-SEAL.json';
type SealEntry = { red: string; green: string };

const isSha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

// A real seal is a few hundred bytes per plan; anything bigger is not read (the file is repo content, so hostile).
const SEAL_MAX_BYTES = 64 * 1024;
/** #5354: most distinct SUMMARY task commits probed per plan; each costs one `git merge-base` spawn plus one `git show` (about 2x64 spawns) and the scope resolver. */
const SUMMARY_REFS_MAX = 64;

/** lstat, so a symlink is seen as a symlink. Never throws. */
function sealStat(file: string): Evidence<fs.Stats> {
  try {
    return evidenceFound(fs.lstatSync(file));
  } catch (err) {
    return evidenceFromError<fs.Stats>(err, file);
  }
}

type SealPlans = Record<string, Partial<SealEntry>>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

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

/** Bounded, non-blocking read of repo-controlled text: a symlink, non-regular file or one over SEAL_MAX_BYTES is `unreadable`; absent is `none`. */
function readBoundedText(file: string): Evidence<string> {
  // lstat rejects a symlink on every OS (O_NOFOLLOW is 0 on Windows); O_NOFOLLOW + fstat on the fd is the race backstop.
  const st = sealStat(file);
  if (st.kind !== 'found') return st;
  const notRegular = (): Evidence<string> => evidenceUnreadable(`${path.basename(file)} is not a regular file or exceeds ${SEAL_MAX_BYTES} bytes`, file);
  if (!st.value.isFile() || st.value.size > SEAL_MAX_BYTES) return notRegular();
  let fd: number | undefined;
  let result: Evidence<string>;
  try {
    // O_NONBLOCK: a FIFO swapped in after lstat must not hang open(); fstat isFile() then rejects it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const fst = fs.fstatSync(fd);
    result = !fst.isFile() || fst.size > SEAL_MAX_BYTES ? notRegular() : evidenceFound(fs.readFileSync(fd, 'utf8'));
  } catch (err) {
    result = evidenceFromError<string>(err, file);
  }
  // Closed outside a finally so a close() failure cannot mask (by throwing over) the read's result: it is reported as unreadable.
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch (err) {
      return evidenceFromError<string>(err, file);
    }
  }
  return result;
}

/** #5354: per-plan RED/GREEN hashes recorded pre-squash. Absent is `none`; a malformed, oversize, non-regular or unreadable seal is `unreadable`. */
function readSeal(phaseDir: string): Evidence<SealPlans> {
  const text = readBoundedText(path.join(phaseDir, SEAL_FILE));
  return text.kind === 'found' ? parseSeal(text.value) : text;
}

/** Merge `evidence` into the phase's seal via temp file + rename, refusing an existing non-regular target (a symlink would redirect the write). `prior` is never `unreadable`: the caller returns early on that, so no earlier plan's credit is dropped. */
function writeSeal(phaseDir: string, evidence: Record<string, SealEntry>, prior: Evidence<SealPlans>): void {
  const file = path.join(phaseDir, SEAL_FILE);
  const content = `${JSON.stringify({ plans: { ...(prior.kind === 'found' ? prior.value : {}), ...evidence } }, null, 2)}\n`;
  const st = sealStat(file);
  if (st.kind === 'unreadable') throw new Error(`${SEAL_FILE} cannot be examined: ${st.reason}`);
  if (st.kind === 'found' && !st.value.isFile()) throw new Error(`${SEAL_FILE} exists and is not a regular file`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    retryRenameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * #5354: a plan was squashed away when its SUMMARY names task commits and none is reachable from
 * HEAD (a missing object counts as unreachable only in a complete history). A fabricated or foreign
 * id is indistinguishable from a squashed commit that was garbage-collected or never fetched, so it
 * is also `NotEvaluable`: the gate stays advisory and the row is visible to the maintainer rather
 * than escalating on unverifiable ids. No SUMMARY, no listed hash, more than SUMMARY_REFS_MAX
 * distinct hashes, or any reachable hash is an ordinary failure. When every ref's subject still
 * appears on a reachable plan commit the plan was rewritten (rebase/amend), not squashed, so it is
 * not unreachable. A squash that repeats a single task subject therefore stays `NotEvaluable`; a
 * single-task plan squashed under its own subject is indistinguishable from a rewrite and FAILs.
 */
function summaryCommitsAllUnreachable(projectDir: string, phaseDir: string, planPath: string, reachableSubjects: ReadonlySet<string>): boolean {
  const subjectOf = (id: string): string => {
    const s = execGit(['show', '-s', '--format=%s', id], { cwd: projectDir });
    return !s.timedOut && s.exitCode === 0 ? s.stdout.trim() : '';
  };
  const rel = path.relative(phaseDir, planPath).split(path.sep).join('/');
  // Exit 128 means "object not found" only in a complete history: in a shallow clone or outside a repo it
  // says nothing about squashing, so it must not turn an un-squashed skipper into NotEvaluable.
  let complete: boolean | undefined;
  const historyComplete = (): boolean => complete ??= (() => {
    const shallow = execGit(['rev-parse', '--is-shallow-repository'], { cwd: projectDir });
    return !shallow.timedOut && shallow.exitCode === 0 && shallow.stdout === 'false';
  })();
  for (const candidate of summaryCandidates(rel)) {
    const summary = readBoundedText(path.join(phaseDir, candidate));
    if (summary.kind !== 'found') continue;
    const refs = [...new Set(extractTaskCommitRefs(summary.value))];
    // More refs than the cap is an ordinary failure: SUMMARY.md is repo content and must not buy unbounded git spawns.
    if (refs.length === 0 || refs.length > SUMMARY_REFS_MAX) return false;
    const probes = refs.map((id) => {
      const r = execGit(['merge-base', '--is-ancestor', id, 'HEAD'], { cwd: projectDir });
      const unreachable = !r.timedOut && (r.exitCode === 1 || (r.exitCode === 128 && historyComplete()));
      return { unreachable, rewritten: r.exitCode === 1 && reachableSubjects.has(subjectOf(id)) };
    });
    return probes.every((p) => p.unreachable) && !probes.every((p) => p.rewritten);
  }
  return false;
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

export function evaluateTddReviewCheckpoint(input: { projectDir: string; args: readonly string[] }): GateResult {
  const { projectDir } = input;
  const phase = input.args[0] || '';
  if (!phase) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'tdd.review-checkpoint requires a phase argument: check tdd.review-checkpoint <phase>',
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
    const planId = path.basename(planPath, '-PLAN.md');
    const commits = planCommits(projectDir, planId);
    const kinds = commitKinds(commits);
    const sealed = Object.hasOwn(seal, planId) && seal[planId]?.red !== seal[planId]?.green ? seal[planId] : {};
    const redSha = kinds.get('test') ?? (isSha(sealed.red) ? sealed.red : undefined);
    const red = redSha !== undefined;
    const refactor = kinds.has('refactor');

    // #4867: a RED-only probe plan is satisfied by the GREEN of a plan that (transitively) declares
    // `depends_on` it. Only a real `feat(...)` commit under such a plan counts; the plan's own RED is
    // still required, and a plan nothing depends on is scored on its own commits alone.
    const ownGreen = kinds.has('feat');
    let greenSha = kinds.get('feat');
    const greenFrom: string[] = [];
    if (!ownGreen) {
      for (const dependentId of transitiveDependents(planId, dependents)) {
        const sha = commitKinds(planCommits(projectDir, dependentId)).get('feat');
        if (sha === undefined) continue;
        greenSha ??= sha;
        greenFrom.push(dependentId);
      }
    }
    greenSha ??= isSha(sealed.green) ? sealed.green : undefined;
    const green = greenSha !== undefined;

    const missing: string[] = [];
    if (!red) missing.push('RED');
    if (!green) missing.push('GREEN');
    // #5354: credit incomplete, nothing sealed, and the SUMMARY's task commits are all gone = squashed away.
    const notEvaluable = missing.length > 0 && !(isSha(sealed.red) || isSha(sealed.green)) && summaryCommitsAllUnreachable(projectDir, phaseDir, planPath, new Set(commits.map((commit) => commit.subject)));
    const status: TddPlanRow['status'] = notEvaluable ? 'NotEvaluable' : missing.length === 0 ? 'Pass' : 'FAIL';
    if (redSha !== undefined && greenSha !== undefined) evidence[planId] = { red: redSha, green: greenSha };

    rows.push(greenFrom.length > 0
      ? { planId, red, green, refactor, status, missing, greenFrom }
      : { planId, red, green, refactor, status, missing });
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
      table += `\n  Plan ${r.planId} missing: ${r.missing.join(', ')} gate commit(s).`;
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
