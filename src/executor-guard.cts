/**
 * Executor guards and the plan commit ledger as single commands (#6216, ADR-6216):
 * `query executor.guard` and `query executor.ledger record|read`.
 *
 * `executor.guard` is VERIFY-ONLY and fails closed (#48): it reads HEAD, the branch and the
 * worktree root, never moves a ref or writes, prints a `FATAL:` line per failed check and exits
 * 42, the `worktree_branch_check` contract's code. `executor.ledger` records the plan's base once,
 * in the worktree's tool-owned `.gsd/executor-ledger/` (never under `.git/worktrees/<name>/`),
 * and reads it back at SUMMARY time (#3968). Git and filesystem I/O is injectable via `deps`.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6216 CJS interop import, as in the sibling modules
import io = require('./io.cjs');
import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6216 CJS interop import, as in adr-parser.cts
import cliExitModule = require('./cli-exit.cjs');
import { resolveProtectedBranchStatus } from './git-base-branch.cjs';
import { ensureToolOwnedGsdDir } from './gsd-tool-dir.cjs';
import { execGit as execGitSeam } from './shell-command-projection.cjs';

const { output, error, ERROR_REASON } = io;
const { ExitError } = cliExitModule;

/** Exit code of every failed guard check: the `worktree_branch_check` contract (#2924, #48). */
export const GUARD_EXIT_CODE = 42;

/** Per-agent branch namespaces an isolated worktree must sit on (#2924, #1995). */
export const AGENT_BRANCH_RE = /^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$/;

/** Phase and plan tokens become one file name, so they are held to a plain-name alphabet. */
const LEDGER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const LEDGER_DIR = 'executor-ledger';

const LEDGER_IGNORE = Object.freeze({
  marker: '# gsd-core executor ledger',
  rules: Object.freeze([`/${LEDGER_DIR}/`, '/.gitignore']),
});

type GitResult = { exitCode: number; stdout: string; stderr?: string };
type ExecGitFn = (args: string[], opts?: { cwd?: string; timeout?: number }) => GitResult;

export interface ExecutorGuardDeps {
  execGit?: ExecGitFn;
  protectedStatus?: (cwd: string, branch: string) => { isProtected: boolean; verified: boolean };
  realpath?: (p: string) => string;
  writeDiagnostic?: (s: string) => void;
  now?: () => Date;
}

/** The slice of the dispatcher's ProjectContext these commands read. */
export interface ExecutorGuardContext {
  /** Top level of the checkout the process runs in. */
  worktreeRoot: string;
  /** Directory holding `.planning` — where project config is read. */
  projectRoot: string;
  isLinkedWorktree: boolean;
}

export interface GuardOptions {
  expectedBase?: string | null;
  expectedBaseAlternate?: string | null;
  toplevel?: string | null;
  path?: string | null;
  sequential?: boolean;
  /** The directory the command was invoked from; a relative `--path` resolves against it. */
  invokedFrom: string;
}

export interface GuardCheck {
  name: 'head-attached' | 'not-protected' | 'agent-namespace' | 'base' | 'toplevel' | 'path';
  ok: boolean;
  detail: string;
}

export interface GuardResult {
  ok: boolean;
  branch: string;
  head: string;
  worktree_root: string;
  checks: GuardCheck[];
}

function git(deps: ExecutorGuardDeps | undefined, cwd: string, args: string[]): GitResult {
  const exec: ExecGitFn = deps?.execGit ?? execGitSeam;
  try {
    const r = exec(args, { cwd, timeout: 15_000 });
    return { exitCode: r.exitCode, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '') };
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: (err as Error).message };
  }
}

function realpathOr(deps: ExecutorGuardDeps | undefined, p: string): string | null {
  try {
    return (deps?.realpath ?? fs.realpathSync)(p);
  } catch {
    return null;
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Run every requested check and return them all; the caller decides the exit. Checks never
 * short-circuit, so one call reports every reason the executor must halt.
 */
export function evaluateGuard(
  ctx: ExecutorGuardContext,
  opts: GuardOptions,
  deps?: ExecutorGuardDeps,
): GuardResult {
  const cwd = ctx.worktreeRoot;
  const checks: GuardCheck[] = [];

  const symbolic = git(deps, cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  const attached = symbolic.exitCode === 0 && symbolic.stdout.startsWith('refs/heads/');
  const branch = attached ? symbolic.stdout.slice('refs/heads/'.length) : '';
  const headResult = git(deps, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headResult.exitCode === 0 ? headResult.stdout : '';

  checks.push({
    name: 'head-attached',
    ok: attached && head !== '',
    detail: attached && head !== '' ? `HEAD is on '${branch}'` : 'HEAD is detached or unreadable',
  });

  // Fail closed: an unverifiable base branch counts as protected (#3057, the git.base-branch rule).
  let protectedOk = false;
  let protectedDetail = 'no branch to test';
  if (attached) {
    try {
      const status = (deps?.protectedStatus ?? resolveProtectedBranchStatus)(ctx.projectRoot, branch);
      protectedOk = status.verified && !status.isProtected;
      protectedDetail = !status.verified
        ? 'could not verify the repository\'s branch metadata; treated as protected (#3057)'
        : status.isProtected
          ? `'${branch}' is a protected/default branch (#2924, #3819)`
          : `'${branch}' is not protected`;
    } catch (err) {
      protectedDetail = `protected-branch check failed: ${(err as Error).message}`;
    }
  }
  checks.push({ name: 'not-protected', ok: protectedOk, detail: protectedDetail });

  // The spawn-time check (an expected base was passed) always requires the namespace, as the
  // worktree_branch_check block does; the pre-commit check requires it in an agent-isolated
  // worktree unless the executor was dispatched onto the orchestrator's tree (#4799).
  const expectedBase = opts.expectedBase ?? null;
  const namespaceRequired = expectedBase !== null || (ctx.isLinkedWorktree && !opts.sequential);
  if (namespaceRequired) {
    const ok = attached && AGENT_BRANCH_RE.test(branch);
    checks.push({
      name: 'agent-namespace',
      ok,
      detail: ok
        ? `'${branch}' is in the agent-* / worktree-agent-* / worktree-wf_* namespace`
        : `'${branch || 'DETACHED'}' is not in the agent-* / worktree-agent-* / worktree-wf_* namespace (#2924)`,
    });
  }

  if (expectedBase !== null) {
    const alternate = opts.expectedBaseAlternate ?? '';
    const accepted = [expectedBase, alternate].filter((s) => s !== '');
    const ok = head !== '' && accepted.includes(head);
    checks.push({
      name: 'base',
      ok,
      detail: ok
        ? `HEAD ${head} matches the expected base`
        : `HEAD is ${head || '(unreadable)'}, expected ${accepted.join(' or ') || '(none given)'}; ` +
          'the orchestrator owns recovery (#48)',
    });
  }

  if (opts.toplevel !== undefined && opts.toplevel !== null) {
    const want = realpathOr(deps, opts.toplevel);
    const have = realpathOr(deps, cwd);
    const ok = want !== null && have !== null && want === have;
    checks.push({
      name: 'toplevel',
      ok,
      detail: ok
        ? `worktree root is ${have}`
        : `worktree root is ${have ?? cwd}, expected ${opts.toplevel}; cd back to the expected root (#3097)`,
    });
  }

  if (opts.path !== undefined && opts.path !== null) {
    const root = realpathOr(deps, cwd) ?? cwd;
    const target = path.resolve(opts.invokedFrom, opts.path);
    // Resolve the deepest existing ancestor, so a not-yet-created file is judged by where it would land.
    let probe = target;
    let resolved: string | null = null;
    const tail: string[] = [];
    for (;;) {
      resolved = realpathOr(deps, probe);
      if (resolved !== null) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
    const landing = resolved === null ? target : path.join(resolved, ...tail);
    const ok = opts.path !== '' && isContained(root, landing);
    checks.push({
      name: 'path',
      ok,
      detail: ok
        ? `${opts.path} is inside the worktree`
        : `${opts.path || '(empty)'} resolves outside the worktree (${root}); use a path inside it (#3099)`,
    });
  }

  return { ok: checks.every((c) => c.ok), branch, head, worktree_root: cwd, checks };
}

/** CLI: `gsd-tools query executor.guard …`. Prints the result as JSON; exits 42 on any failed check. */
export function cmdExecutorGuard(
  ctx: ExecutorGuardContext,
  opts: GuardOptions,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): GuardResult {
  const result = evaluateGuard(ctx, opts, deps);
  const writeDiagnostic = deps?.writeDiagnostic ?? ((s: string) => process.stderr.write(s));
  for (const check of result.checks) {
    if (!check.ok) writeDiagnostic(`FATAL: executor.guard ${check.name}: ${check.detail}\n`);
  }
  output(result, raw, String(result.ok));
  if (!result.ok) {
    writeDiagnostic('Refusing to continue: halt, do not self-recover, do not commit (#48).\n');
    throw new ExitError(GUARD_EXIT_CODE);
  }
  return result;
}

export interface LedgerRecord {
  schema: 1;
  phase: string;
  plan: string;
  plan_head_before: string;
  branch: string;
  recorded_at: string;
}

function ledgerPath(worktreeRoot: string, phase: string, plan: string): string {
  return path.join(worktreeRoot, '.gsd', LEDGER_DIR, `${phase}-${plan}.json`);
}

function requireToken(name: string, value: string | null | undefined): string {
  if (value === undefined || value === null || !LEDGER_TOKEN_RE.test(value)) {
    error(
      `executor.ledger: --${name} must be a plain phase/plan id (letters, digits, '.', '_', '-'); got '${value ?? ''}'`,
      ERROR_REASON.USAGE,
    );
  }
  return value as string;
}

function fail(message: string): never {
  throw new ExitError(1, `Error: executor.ledger: ${message}`);
}

function readRecord(file: string): LedgerRecord | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    return fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as LedgerRecord;
    if (parsed && parsed.schema === 1 && typeof parsed.plan_head_before === 'string' &&
        /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(parsed.plan_head_before)) {
      return parsed;
    }
  } catch { /* fall through */ }
  return fail(`${file} is not a ledger record; remove it only if this plan has not committed yet`);
}

/**
 * Record HEAD as the plan's base, once. A second call keeps the first record (the executor
 * may run this before every commit), which is what makes the count measured, not narrated.
 */
export function cmdExecutorLedgerRecord(
  ctx: ExecutorGuardContext,
  phaseArg: string | null | undefined,
  planArg: string | null | undefined,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): { recorded: boolean; path: string; plan_head_before: string } {
  const phase = requireToken('phase', phaseArg);
  const plan = requireToken('plan', planArg);
  const file = ledgerPath(ctx.worktreeRoot, phase, plan);
  const existing = readRecord(file);
  if (existing) {
    const result = { recorded: false, path: file, plan_head_before: existing.plan_head_before };
    output(result, raw, existing.plan_head_before);
    return result;
  }
  const head = git(deps, ctx.worktreeRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.exitCode !== 0 || head.stdout === '') fail('HEAD does not resolve; nothing to record');
  const symbolic = git(deps, ctx.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const record: LedgerRecord = {
    schema: 1,
    phase,
    plan,
    plan_head_before: head.stdout,
    branch: symbolic.exitCode === 0 ? symbolic.stdout : '',
    recorded_at: (deps?.now ?? (() => new Date()))().toISOString(),
  };
  try {
    const dir = ensureToolOwnedGsdDir(ctx.worktreeRoot, LEDGER_IGNORE);
    fs.mkdirSync(path.join(dir, LEDGER_DIR), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') {
      const raced = readRecord(file);
      if (raced) {
        const result = { recorded: false, path: file, plan_head_before: raced.plan_head_before };
        output(result, raw, raced.plan_head_before);
        return result;
      }
    }
    fail(`cannot write ${file}: ${(err as Error).message}`);
  }
  const result = { recorded: true, path: file, plan_head_before: record.plan_head_before };
  output(result, raw, record.plan_head_before);
  return result;
}

/** Read the plan's base back and measure the plan's commits against the current HEAD. */
export function cmdExecutorLedgerRead(
  ctx: ExecutorGuardContext,
  phaseArg: string | null | undefined,
  planArg: string | null | undefined,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): { plan_head_before: string; plan_head_after: string; commits: number; path: string } {
  const phase = requireToken('phase', phaseArg);
  const plan = requireToken('plan', planArg);
  const file = ledgerPath(ctx.worktreeRoot, phase, plan);
  const record = readRecord(file);
  if (!record) fail(`no ledger record for ${phase}-${plan} at ${file}; it is written by 'executor.ledger record' before the plan's first commit`);
  const base = record.plan_head_before;
  const head = git(deps, ctx.worktreeRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.exitCode !== 0 || head.stdout === '') fail('HEAD does not resolve');
  const ancestor = git(deps, ctx.worktreeRoot, ['merge-base', '--is-ancestor', base, head.stdout]);
  if (ancestor.exitCode !== 0) {
    fail(`recorded base ${base} is not an ancestor of HEAD ${head.stdout}; the count cannot be measured from it`);
  }
  const count = git(deps, ctx.worktreeRoot, ['rev-list', '--count', `${base}..${head.stdout}`]);
  const commits = Number.parseInt(count.stdout, 10);
  if (count.exitCode !== 0 || !Number.isInteger(commits)) fail('git rev-list --count failed');
  const result = { plan_head_before: base, plan_head_after: head.stdout, commits, path: file };
  output(result, raw, String(commits));
  return result;
}
