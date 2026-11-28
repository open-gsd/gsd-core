/**
 * Executor guards and the plan commit ledger as single commands (#6216, ADR-6216):
 * `query executor.guard` and `query executor.ledger record|read`.
 *
 * `executor.guard` is VERIFY-ONLY and fails closed (#48): it reads HEAD, the branch and the
 * worktree the command runs in, never moves a ref or writes, prints a `FATAL:` line per failed
 * check and exits 42, the `worktree_branch_check` contract's code. `executor.ledger` records the
 * plan's base once, in that worktree's `.gsd/executor-ledger/` (never under `.git/`), and reads it
 * back at SUMMARY time (#3968). Git and filesystem I/O is injectable via `deps`.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6216 CJS interop import, as in the sibling modules
import io = require('./io.cjs');
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6216 CJS interop import, as in adr-parser.cts
import cliExitModule = require('./cli-exit.cjs');
import { resolveProtectedBranchStatus } from './git-base-branch.cjs';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import { tryWithinRootLexical } from './security.cjs';

const { output, error, ERROR_REASON } = io;
const { ExitError } = cliExitModule;

/** Exit code of every failed guard check: the `worktree_branch_check` contract (#2924, #48). */
export const GUARD_EXIT_CODE = 42;

/** Per-agent branch namespaces an isolated worktree must sit on (#2924, #1995). */
export const AGENT_BRANCH_RE = /^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$/;

/** The spawn-time block's protected names (#2924), checked without the base-branch resolver. */
export const SPAWN_PROTECTED_RE = /^(main|master|develop|trunk|release\/.*)$/;

/** Phase and plan ids: a letter or digit, then letters, digits, `.`, `_`, `-`. */
const LEDGER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const LEDGER_DIR = 'executor-ledger';

const RECORD_MAX_BYTES = 4096;

type GitResult = { exitCode: number; stdout: string; stderr?: string };
type ExecGitFn = (args: string[], opts?: { cwd?: string }) => GitResult;

export interface ExecutorGuardDeps {
  execGit?: ExecGitFn;
  protectedStatus?: (cwd: string, branch: string) => { isProtected: boolean; verified: boolean };
  realpath?: (p: string) => string;
  writeDiagnostic?: (s: string) => void;
  now?: () => Date;
}

/** The slice of the dispatcher's ProjectContext these commands read. */
export interface ExecutorGuardContext {
  /** Directory holding `.planning` — where project config is read. */
  projectRoot: string;
}

export interface GuardOptions {
  expectedBase?: string | null;
  expectedBaseAlternate?: string | null;
  toplevel?: string | null;
  path?: string | null;
  sequential?: boolean;
  /** The directory the command ran in: the worktree is read from it, relative paths resolve from it. */
  invokedFrom: string;
}

export interface GuardCheck {
  name: 'head-attached' | 'not-protected' | 'agent-namespace' | 'base' | 'toplevel' | 'path';
  ok: boolean;
  detail: string;
}

/**
 * `--path` given alone (no `--toplevel`, `--expected-base` or `--expected-base-alternate`) asks
 * where a write would land (step 0b), which no branch decides, so the branch checks do not run.
 */
export function isPathOnly(opts: GuardOptions): boolean {
  const given = (v: string | null | undefined): boolean => v !== undefined && v !== null;
  return given(opts.path) && !given(opts.toplevel) && !given(opts.expectedBase) && !given(opts.expectedBaseAlternate);
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
    const r = exec(args, { cwd });
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

function errCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

/** Windows names a place whatever the letter case; POSIX paths are compared as written. */
function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve a path one segment at a time, following each link where the filesystem would and
 * never folding `..` before a link is resolved. A missing tail is kept as written. Fails on a
 * link that cannot be resolved, on a non-directory with segments after it, and on `..` after a
 * missing segment, so the result is where a write would land, or nothing.
 */
export function resolveLanding(
  target: string,
  deps?: ExecutorGuardDeps,
): { landing: string } | { reason: string } {
  const parsed = path.parse(target);
  const root = realpathOr(deps, parsed.root);
  if (root === null) return { reason: `cannot resolve ${parsed.root}` };
  const sep = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
  const rest = target.slice(parsed.root.length);
  // A trailing separator, like a `.` segment, says the entry before it is a directory.
  const segments = rest.split(sep).filter((s) => s !== '');
  if (segments.length > 0 && sep.test(rest.slice(-1))) segments.push('.');
  let cur = root;
  const tail: string[] = [];
  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (tail.length > 0) {
      if (seg === '..') return { reason: `'..' follows a segment that does not exist (${tail.join('/')})` };
      if (seg !== '.') tail.push(seg);
      continue;
    }
    if (seg === '.') {
      if (!isDir(cur)) return { reason: `${cur} is not a directory` };
      continue;
    }
    if (seg === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        tail.push(seg);
        continue;
      }
      return { reason: `cannot read ${next}: ${errCode(err) ?? (err as Error).message}` };
    }
    if (st.isSymbolicLink()) {
      const real = realpathOr(deps, next);
      if (real === null) return { reason: `${next} is a link that does not resolve` };
      cur = real;
    } else {
      cur = next;
    }
    if (i < segments.length - 1 && !isDir(cur)) return { reason: `${cur} is not a directory` };
  }
  return { landing: tail.length > 0 ? path.join(cur, ...tail) : cur };
}

interface WorktreeFacts {
  /** Top level of the worktree, or null when the directory is not in one. */
  root: string | null;
  /** The git layout could be read: `.git` entry and git dir vs common dir. */
  layoutKnown: boolean;
  /** `.git` is a file, or the git dir is not the common dir: a linked worktree, a submodule, a separate git dir. */
  isolatedLayout: boolean;
}

function readWorktree(deps: ExecutorGuardDeps | undefined, from: string): WorktreeFacts {
  const top = git(deps, from, ['rev-parse', '--show-toplevel']);
  if (top.exitCode !== 0 || top.stdout === '') return { root: null, layoutKnown: false, isolatedLayout: false };
  // Native form: git prints `C:/…` on Windows.
  const root = path.resolve(top.stdout);
  let dotGitFile = false;
  try {
    // Followed, as the shell's `[ -f .git ]` follows a link.
    dotGitFile = fs.statSync(path.join(root, '.git')).isFile();
  } catch { /* no .git file at the top level */ }
  const dirs = git(deps, from, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  const lines = dirs.stdout.split(/\r?\n/).filter((l) => l !== '');
  if (dirs.exitCode !== 0 || lines.length !== 2) return { root, layoutKnown: false, isolatedLayout: dotGitFile };
  const gitDir = realpathOr(deps, path.resolve(from, lines[0]));
  const commonDir = realpathOr(deps, path.resolve(from, lines[1]));
  if (gitDir === null || commonDir === null) return { root, layoutKnown: false, isolatedLayout: dotGitFile };
  return { root, layoutKnown: true, isolatedLayout: dotGitFile || gitDir !== commonDir };
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
  const checks: GuardCheck[] = [];
  const facts = readWorktree(deps, opts.invokedFrom);
  // Every git call runs where the command ran, so git reads the repository it discovered there.
  const cwd = opts.invokedFrom;

  const symbolic = facts.root === null ? null : git(deps, cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  const attached = symbolic !== null && symbolic.exitCode === 0 && symbolic.stdout.startsWith('refs/heads/');
  const branch = attached && symbolic ? symbolic.stdout.slice('refs/heads/'.length) : '';
  const headResult = facts.root === null ? null : git(deps, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headResult && headResult.exitCode === 0 ? headResult.stdout : '';

  const expectedBase = opts.expectedBase ?? null;
  // The branch checks run on the spawn-time and pre-commit calls, never on `--path` alone.
  const branchChecks = !isPathOnly(opts);

  if (branchChecks) {
    checks.push({
      name: 'head-attached',
      ok: attached && head !== '',
      detail: facts.root === null
        ? `${opts.invokedFrom} is not inside a git worktree`
        : attached && head !== '' ? `HEAD is on '${branch}'` : 'HEAD is detached or unreadable',
    });
  }

  // Spawn-time (an expected base was passed): the block's own protected names, no resolver call.
  // Pre-commit: the git.base-branch --is-protected rule, an unverifiable base branch counting as
  // protected (#3057, #3819).
  if (branchChecks) {
    let protectedOk = false;
    let protectedDetail = 'no branch to test';
    if (attached && expectedBase !== null) {
      protectedOk = !SPAWN_PROTECTED_RE.test(branch);
      protectedDetail = protectedOk
        ? `'${branch}' is not main, master, develop, trunk or release/*`
        : `'${branch}' is a protected branch; refusing to commit or self-recover via 'git update-ref' (#2924)`;
    } else if (attached) {
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
  }

  // The namespace is required at spawn time, and before a commit in any worktree whose `.git` is
  // a file or whose git dir is not the common dir, unless the executor was dispatched onto the
  // orchestrator's tree (#4799). A layout that cannot be read requires it.
  const namespaceRequired = branchChecks && (expectedBase !== null ||
    (!opts.sequential && (!facts.layoutKnown || facts.isolatedLayout)));
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

  if (expectedBase === null && opts.expectedBaseAlternate !== undefined && opts.expectedBaseAlternate !== null) {
    checks.push({ name: 'base', ok: false, detail: '--expected-base-alternate needs --expected-base' });
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

  const realRoot = facts.root === null ? null : realpathOr(deps, facts.root);

  if (opts.toplevel !== undefined && opts.toplevel !== null) {
    const want = realpathOr(deps, path.resolve(opts.invokedFrom, opts.toplevel));
    const ok = want !== null && realRoot !== null && comparable(want) === comparable(realRoot);
    checks.push({
      name: 'toplevel',
      ok,
      detail: ok
        ? `worktree root is ${realRoot}`
        : `worktree root is ${realRoot ?? '(none)'}, expected ${opts.toplevel}; cd back to the expected root (#3097)`,
    });
  }

  if (opts.path !== undefined && opts.path !== null) {
    let ok = false;
    let detail: string;
    if (realRoot === null) {
      detail = 'the worktree root does not resolve';
    } else {
      const target = path.isAbsolute(opts.path) ? opts.path : `${opts.invokedFrom}${path.sep}${opts.path}`;
      const resolved = resolveLanding(target, deps);
      if ('reason' in resolved) {
        detail = `${opts.path}: ${resolved.reason}`;
      } else {
        // Both sides are already resolved, so the shared lexical predicate decides (ADR-4650).
        ok = tryWithinRootLexical(comparable(resolved.landing), comparable(realRoot)) !== null;
        detail = ok
          ? `${opts.path} lands inside the worktree`
          : `${opts.path} lands at ${resolved.landing}, outside the worktree (${realRoot}); use a path inside it (#3099)`;
      }
    }
    checks.push({ name: 'path', ok, detail });
  }

  return { ok: checks.every((c) => c.ok), branch, head, worktree_root: facts.root ?? '', checks };
}

/** CLI: `gsd-tools query executor.guard …`. Prints the result as JSON; exits 42 on any failed check. */
export function cmdExecutorGuard(
  ctx: ExecutorGuardContext,
  opts: GuardOptions,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): GuardResult {
  const writeDiagnostic = deps?.writeDiagnostic ?? ((s: string) => process.stderr.write(s));
  // A flag that changes nothing on a path-only call is refused, so a command that means to run the
  // branch checks cannot lose them without an error.
  if (isPathOnly(opts) && opts.sequential) {
    error(
      'executor.guard: --sequential has no effect on --path alone, which runs only the path check; ' +
        'give --toplevel <worktree root> to run the pre-commit checks with it',
      ERROR_REASON.USAGE,
    );
  }
  let result: GuardResult;
  try {
    result = evaluateGuard(ctx, opts, deps);
  } catch (err) {
    writeDiagnostic(`FATAL: executor.guard: the checks could not run: ${(err as Error).message}\n`);
    writeDiagnostic('Refusing to continue: halt, do not self-recover, do not commit (#48).\n');
    throw new ExitError(GUARD_EXIT_CODE);
  }
  for (const check of result.checks) {
    if (!check.ok) writeDiagnostic(`FATAL: executor.guard ${check.name}: ${check.detail}\n`);
  }
  if (!result.ok) {
    writeDiagnostic('Refusing to continue: halt, do not self-recover, do not commit (#48).\n');
    try {
      output(result, raw, String(result.ok));
    } catch { /* the verdict below stands even when the JSON cannot be written */ }
    throw new ExitError(GUARD_EXIT_CODE);
  }
  output(result, raw, String(result.ok));
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

function requireToken(name: string, value: string | null | undefined): string {
  if (value === undefined || value === null || !LEDGER_TOKEN_RE.test(value)) {
    error(
      `executor.ledger: --${name} must be a plain id (a letter or digit, then letters, digits, '.', '_', '-'); got '${value ?? ''}'`,
      ERROR_REASON.USAGE,
    );
  }
  return value as string;
}

function fail(message: string): never {
  throw new ExitError(1, `Error: executor.ledger: ${message}`);
}

/** `+` is outside the id alphabet, so two different phase/plan pairs never share a file. */
export function ledgerFileName(phase: string, plan: string): string {
  return `${phase}+${plan}.json`;
}

function worktreeRootOrFail(deps: ExecutorGuardDeps | undefined, from: string): string {
  const facts = readWorktree(deps, from);
  if (facts.root === null) return fail(`${from} is not inside a git worktree`);
  const real = realpathOr(deps, facts.root);
  if (real === null) return fail(`cannot resolve the worktree root ${facts.root}`);
  return real;
}

/** A real directory at exactly `want`: not a link, not resolving anywhere else. */
function ensureRealDir(dir: string, want: string, create: boolean): void {
  if (create) {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (errCode(err) !== 'EEXIST') fail(`cannot create ${dir}: ${(err as Error).message}`);
    }
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    return fail(`cannot read ${dir}: ${(err as Error).message}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail(`${dir} must be a real directory, not a link or a file`);
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch (err) {
    return fail(`cannot resolve ${dir}: ${(err as Error).message}`);
  }
  if (real !== want) fail(`${dir} resolves to ${real}, outside the worktree`);
}

/** The ledger directory, confined to `<root>/.gsd/executor-ledger` and ignored by its own `.gitignore`. */
function ledgerDir(root: string, create: boolean): string {
  const gsd = path.join(root, '.gsd');
  const dir = path.join(gsd, LEDGER_DIR);
  if (!create) {
    try {
      fs.lstatSync(dir);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return dir;
    }
  }
  ensureRealDir(gsd, gsd, create);
  ensureRealDir(dir, dir, create);
  if (create) {
    const ignore = path.join(dir, '.gitignore');
    try {
      fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
    } catch (err) {
      if (errCode(err) !== 'EEXIST') fail(`cannot write ${ignore}: ${(err as Error).message}`);
      let content: string | null = null;
      try {
        if (fs.lstatSync(ignore).isFile()) content = fs.readFileSync(ignore, 'utf8');
      } catch { /* checked below */ }
      if (content === null || !/^\*\r?$/m.test(content)) fail(`${ignore} must be a regular file that ignores '*'`);
    }
  }
  return dir;
}

function readRecord(file: string, phase: string, plan: string): LedgerRecord | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    return fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (!st.isFile()) fail(`${file} must be a regular file, not a link`);
  let text: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > RECORD_MAX_BYTES) return fail(`${file} is not a ledger record`);
    text = fs.readFileSync(fd, 'utf8');
  } catch (err) {
    if (err instanceof ExitError) throw err;
    return fail(`cannot read ${file}: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    const parsed = JSON.parse(text) as LedgerRecord;
    if (parsed && parsed.schema === 1 && parsed.phase === phase && parsed.plan === plan &&
        typeof parsed.plan_head_before === 'string' && SHA_RE.test(parsed.plan_head_before)) {
      return parsed;
    }
  } catch { /* fall through */ }
  return fail(`${file} is not this plan's ledger record`);
}

/**
 * Record HEAD as the plan's base, once. A second call keeps the first record (the executor
 * may run this before every commit), which is what makes the count measured, not narrated.
 */
export function cmdExecutorLedgerRecord(
  ctx: ExecutorGuardContext,
  invokedFrom: string,
  phaseArg: string | null | undefined,
  planArg: string | null | undefined,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): { recorded: boolean; path: string; plan_head_before: string } {
  const phase = requireToken('phase', phaseArg);
  const plan = requireToken('plan', planArg);
  const root = worktreeRootOrFail(deps, invokedFrom);
  const dir = ledgerDir(root, true);
  const file = path.join(dir, ledgerFileName(phase, plan));
  const keep = (rec: LedgerRecord) => {
    const result = { recorded: false, path: file, plan_head_before: rec.plan_head_before };
    output(result, raw, rec.plan_head_before);
    return result;
  };
  const existing = readRecord(file, phase, plan);
  if (existing) return keep(existing);

  const head = git(deps, invokedFrom, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.exitCode !== 0 || !SHA_RE.test(head.stdout)) fail('HEAD does not resolve to a commit; nothing to record');
  const symbolic = git(deps, invokedFrom, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const record: LedgerRecord = {
    schema: 1,
    phase,
    plan,
    plan_head_before: head.stdout,
    branch: symbolic.exitCode === 0 ? symbolic.stdout : '',
    recorded_at: (deps?.now ?? (() => new Date()))().toISOString(),
  };
  // Written whole to a temp name, then linked into place: the link fails if the record exists,
  // and a reader never sees a partly written record.
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    fs.linkSync(tmp, file);
  } catch (err) {
    if (errCode(err) === 'EEXIST') {
      const raced = readRecord(file, phase, plan);
      if (raced) return keep(raced);
    }
    fail(`cannot write ${file}: ${(err as Error).message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
  const result = { recorded: true, path: file, plan_head_before: record.plan_head_before };
  output(result, raw, record.plan_head_before);
  return result;
}

/** Read the plan's base back and measure the plan's commits against the current HEAD. */
export function cmdExecutorLedgerRead(
  ctx: ExecutorGuardContext,
  invokedFrom: string,
  phaseArg: string | null | undefined,
  planArg: string | null | undefined,
  raw: boolean,
  deps?: ExecutorGuardDeps,
): { plan_head_before: string; plan_head_after: string; commits: number; path: string } {
  const phase = requireToken('phase', phaseArg);
  const plan = requireToken('plan', planArg);
  const root = worktreeRootOrFail(deps, invokedFrom);
  const file = path.join(ledgerDir(root, false), ledgerFileName(phase, plan));
  const record = readRecord(file, phase, plan);
  if (!record) {
    return fail(`no ledger record for ${phase} ${plan} at ${file}; it is written by 'executor.ledger record' before the plan's first commit`);
  }
  const base = record.plan_head_before;
  const commit = git(deps, invokedFrom, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (commit.exitCode !== 0 || commit.stdout !== base) fail(`recorded base ${base} is not a commit in this repository`);
  const head = git(deps, invokedFrom, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.exitCode !== 0 || head.stdout === '') fail('HEAD does not resolve');
  const ancestor = git(deps, invokedFrom, ['merge-base', '--is-ancestor', base, head.stdout]);
  if (ancestor.exitCode !== 0) {
    fail(`recorded base ${base} is not an ancestor of HEAD ${head.stdout}; the count cannot be measured from it`);
  }
  const count = git(deps, invokedFrom, ['rev-list', '--count', `${base}..${head.stdout}`]);
  const commits = Number.parseInt(count.stdout, 10);
  if (count.exitCode !== 0 || !Number.isInteger(commits)) fail('git rev-list --count failed');
  const result = { plan_head_before: base, plan_head_after: head.stdout, commits, path: file };
  output(result, raw, String(commits));
  return result;
}
