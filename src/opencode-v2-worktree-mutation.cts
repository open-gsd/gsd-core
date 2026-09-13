/**
 * OpenCode V2 durable worktree Git mutations.
 *
 * This module intentionally depends only on injected generic worktree primitives,
 * so it cannot form an import cycle with its generic wrapper.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tryWithinRoot, tryWithinRootLexical, PathAcceptance } from './security.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';

type GitResult = SpawnResultOutput;
type ExecGitFn = (args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeout?: number; rawStdout?: boolean }) => GitResult;

interface CleanupManifestEntry {
  agent_id: string | null;
  worktree_path: string;
  branch: string;
  expected_base: string;
  allowed_bases?: string[];
  files_modified?: string[];
  declared_deletions?: string[];
}

interface WorktreeEntry { path: string; branch: string | null; }
interface WorktreeMutationDeps {
  execGit?: ExecGitFn;
  existsSync?: (p: string) => boolean;
  nowMs?: number;
  now?: () => number;
  beforeMerge?: () => void;
  afterMergeCas?: () => void;
  beforeWorktreeRemove?: () => void;
  beforeBranchDelete?: () => void;
}

interface DurableWorktreeInput {
  targetRoot?: string; projectRoot?: string; repoRoot?: string; worktreeRoot: string;
  actualManifestAgentId?: string; manifestAgentId?: string; agentId?: string;
  worktreePath?: string; canonicalWorktreePath?: string; branch: string;
  manifest: string | { worktrees?: unknown[] } | unknown[]; prepare?: boolean;
  expectedChildTip?: string; expectedTargetTip?: string; mergedChildTip?: string; childTip?: string;
  authorizationDeadlineMs?: number; authorizeBeforeTargetCas?: () => boolean;
}

interface OpenCodeV2WorktreeMutationPrimitives {
  execGitDefault: ExecGitFn;
  readWorktreeList: (repoRoot: string, deps?: { execGit?: ExecGitFn }) => { ok: boolean; reason: string; entries: WorktreeEntry[] };
  normalizeCleanupManifestEntry: (entry: unknown) => CleanupManifestEntry | null;
  repoRootStillMidMerge: (execGit: ExecGitFn, repoRoot: string) => boolean;
  planWaveScopeConformance: (changedPaths: unknown, declaredFiles: unknown, branch: string) => Array<{ path: string | null }>;
  partitionDeclaredDeletions: (deletedPaths: unknown, declared: unknown) => string[];
  gitResultOk: (result: GitResult | null | undefined) => boolean;
  worktreeAgentBranchRe: RegExp;
}

function createOpenCodeV2WorktreeMutation(primitives: OpenCodeV2WorktreeMutationPrimitives) {
  const { execGitDefault, readWorktreeList, normalizeCleanupManifestEntry, repoRootStillMidMerge, planWaveScopeConformance, partitionDeclaredDeletions, gitResultOk, worktreeAgentBranchRe: WORKTREE_AGENT_BRANCH_RE } = primitives;
type DurableBindingResult =
  | { ok: true; targetRoot: string; worktreeRoot: string; worktreePath: string; branch: string; entry: CleanupManifestEntry }
  | { ok: false; reason: string };

/** Resolve one exact, manifest-bound worktree identity before mutation. */
function validateDurableWorktreeBinding(input: DurableWorktreeInput | null | undefined): DurableBindingResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  const targetRootValue = input.targetRoot ?? input.projectRoot ?? input.repoRoot;
  const agentId = input.actualManifestAgentId ?? input.manifestAgentId ?? input.agentId;
  const suppliedPath = input.canonicalWorktreePath ?? input.worktreePath;
  if (
    typeof targetRootValue !== 'string' || !targetRootValue.trim() ||
    typeof input.worktreeRoot !== 'string' || !input.worktreeRoot.trim() ||
    typeof agentId !== 'string' || !agentId.trim() ||
    typeof suppliedPath !== 'string' || !suppliedPath.trim() ||
    typeof input.branch !== 'string' || !input.branch.trim()
  ) return { ok: false, reason: 'invalid_input' };
  if (!WORKTREE_AGENT_BRANCH_RE.test(input.branch)) return { ok: false, reason: 'branch_not_allowed' };

  const targetRoot = path.resolve(targetRootValue);
  const worktreeRoot = path.resolve(targetRoot, input.worktreeRoot);
  const worktreePath = path.resolve(targetRoot, suppliedPath);
  if (!path.isAbsolute(suppliedPath) || suppliedPath !== worktreePath) {
    return { ok: false, reason: 'worktree_path_not_canonical' };
  }
  const canonicalWorktreeRoot = tryWithinRoot(worktreeRoot, worktreeRoot, PathAcceptance.AbsoluteInsideRoot);
  const containedWorktreePath = tryWithinRoot(worktreePath, worktreeRoot, PathAcceptance.AbsoluteInsideRoot);
  if (canonicalWorktreeRoot === null || containedWorktreePath === null || containedWorktreePath === canonicalWorktreeRoot) {
    return { ok: false, reason: 'path_outside_worktree_root' };
  }
  if (canonicalWorktreeRoot !== worktreeRoot || containedWorktreePath !== worktreePath) {
    return { ok: false, reason: 'worktree_path_not_canonical' };
  }

  let parsed: unknown;
  try { parsed = typeof input.manifest === 'string' ? JSON.parse(input.manifest) : input.manifest; }
  catch { return { ok: false, reason: 'invalid_manifest_json' }; }
  const rawEntries = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { worktrees?: unknown[] }).worktrees)
      ? (parsed as { worktrees: unknown[] }).worktrees
      : null);
  if (!rawEntries) return { ok: false, reason: 'manifest_shape_invalid' };

  const matching: CleanupManifestEntry[] = [];
  let conflictingIdentity = false;
  for (const raw of rawEntries) {
    const entry = normalizeCleanupManifestEntry(raw);
    if (!entry) continue;
    const entryPath = path.resolve(targetRoot, entry.worktree_path);
    if (entryPath !== worktreePath || entry.branch !== input.branch) continue;
    if (entry.agent_id === agentId) matching.push(entry);
    else conflictingIdentity = true;
  }
  if (matching.length !== 1 || conflictingIdentity) {
    return { ok: false, reason: conflictingIdentity ? 'manifest_identity_mismatch' : 'manifest_entry_ambiguous' };
  }
  return { ok: true, targetRoot, worktreeRoot, worktreePath, branch: input.branch, entry: matching[0] };
}

const UNSUPPORTED_PLUMBING_HOOKS = Object.freeze([
  // These are the hooks invoked by a successful non-fast-forward `git merge`.
  // commit-tree cannot run them faithfully against the eventual target index.
  'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge',
]);

function unsupportedPlumbingPolicy(execGit: ExecGitFn, targetRoot: string): { unsupported: boolean; detail: string } {
  const hooksPath = execGit(['rev-parse', '--git-path', 'hooks'], { cwd: targetRoot });
  if (!gitResultOk(hooksPath) || !hooksPath.stdout.trim()) return { unsupported: true, detail: 'cannot resolve effective Git hooks path' };
  const effectiveHooksPath = path.resolve(targetRoot, hooksPath.stdout.trim());
  for (const hook of UNSUPPORTED_PLUMBING_HOOKS) {
    const hookPath = path.join(effectiveHooksPath, hook);
    try {
      // access(X_OK) models whether Git will attempt execve. Do not open or
      // read the path: it may be a FIFO or another blocking special object.
      fs.statSync(hookPath);
      fs.accessSync(hookPath, fs.constants.X_OK);
      return { unsupported: true, detail: `active ${hook} hook at ${hookPath}` };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES') return { unsupported: true, detail: `cannot inspect ${hook} hook policy` };
    }
  }
  return { unsupported: false, detail: '' };
}

interface MergeSigningPolicy {
  ok: boolean;
  required: boolean;
  detail: string;
}

function effectiveSigningPolicy(execGit: ExecGitFn, targetRoot: string, targetBranch: string): MergeSigningPolicy {
  const configured = execGit(['config', '--bool', '--get', 'commit.gpgSign'], { cwd: targetRoot });
  if (configured.timedOut) return { ok: false, required: false, detail: 'commit.gpgSign lookup timed out' };
  let required = false;
  if (configured.exitCode !== 1) {
    const value = configured.stdout.trim();
    if (!gitResultOk(configured) || (value !== 'true' && value !== 'false')) {
      return { ok: false, required: false, detail: 'cannot interpret effective commit.gpgSign' };
    }
    required = value === 'true';
  }

  // Git stores branch.<name>.mergeOptions as command-line text. Parse only the
  // exact shell-free subset whose effect can be projected onto commit-tree.
  const optionsResult = execGit(['config', '--get-all', `branch.${targetBranch}.mergeOptions`], { cwd: targetRoot, rawStdout: true });
  if (optionsResult.timedOut) return { ok: false, required: false, detail: 'branch mergeOptions lookup timed out' };
  if (optionsResult.exitCode !== 0 && optionsResult.exitCode !== 1) {
    return { ok: false, required: false, detail: 'cannot read effective branch mergeOptions' };
  }
  if (optionsResult.exitCode === 0) {
    const raw = optionsResult.stdoutRaw?.toString('utf8') ?? optionsResult.stdout;
    // Quotes, escapes, and embedded controls require Git's internal split_cmdline
    // grammar. Reject them rather than approximating it or invoking a shell.
    if (/['"\\\0\r]/.test(raw)) return { ok: false, required: false, detail: 'unsupported branch mergeOptions quoting or escaping' };
    const tokens = raw.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token === '--no-ff') continue;
      if (token === '--no-gpg-sign') {
        required = false;
      } else if (token === '--gpg-sign' || token === '-S') {
        required = true;
      } else if (token.startsWith('--gpg-sign=') && token.length > '--gpg-sign='.length) {
        required = true;
      } else if (token.startsWith('-S') && token.length > 2) {
        required = true;
      } else {
        return { ok: false, required: false, detail: `unsupported branch mergeOptions token: ${token}` };
      }
    }
  }
  return { ok: true, required, detail: '' };
}

function nulPaths(result: GitResult): string[] {
  const raw = result.stdoutRaw ?? Buffer.from(result.stdout, 'utf8');
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index > start) paths.push(raw.subarray(start, index).toString('utf8'));
    start = index + 1;
  }
  if (start < raw.length) paths.push(raw.subarray(start).toString('utf8'));
  return paths;
}

function sameStringPaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function localUntrackedInventory(execGit: ExecGitFn, targetRoot: string): { ok: boolean; paths: string[]; stderr: string; timedOut: boolean } {
  const ordinary = execGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: targetRoot, rawStdout: true });
  const ignored = execGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: targetRoot, rawStdout: true });
  if (!gitResultOk(ordinary) || !gitResultOk(ignored)) {
    return { ok: false, paths: [], stderr: ordinary.stderr || ignored.stderr || '', timedOut: Boolean(ordinary.timedOut || ignored.timedOut) };
  }
  return { ok: true, paths: Array.from(new Set([...nulPaths(ordinary), ...nulPaths(ignored)])).sort(), stderr: '', timedOut: false };
}

function inventoryCollidesWithUpdates(targetRoot: string, inventory: string[], updates: string[]): string | null {
  for (const local of inventory) {
    for (const update of updates) {
      // These Git-reported paths are lexical: either side may name a merge
      // result that does not exist yet, so resolving filesystem links is wrong.
      const localPath = path.resolve(targetRoot, local);
      const updatePath = path.resolve(targetRoot, update);
      if (
        tryWithinRootLexical(localPath, updatePath) !== null ||
        tryWithinRootLexical(updatePath, localPath) !== null
      ) return local;
    }
  }
  return null;
}

/**
 * Merge one exact manifest-bound executor branch while preserving its
 * worktree and branch. `prepare:true` performs the same preflight without the
 * merge so callers can journal immutable tips, refresh native status, and
 * then pass `expectedChildTip` and `expectedTargetTip` immediately before
 * mutation.
 */
function mergePreparedWorktree(input: DurableWorktreeInput, deps: WorktreeMutationDeps = {}): Record<string, unknown> {
  const execGit = deps.execGit || execGitDefault;
  const fail = (reason: string, stderr = '', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ok: false, status: 'blocked', reason, stderr, ...extra,
  });
  const binding = validateDurableWorktreeBinding(input);
  if (!binding.ok) return fail(binding.reason);
  const { targetRoot, worktreePath, branch, entry } = binding;
  const prepare = input.prepare === true;
  if (!prepare && (
    typeof input.expectedChildTip !== 'string' || !input.expectedChildTip.trim() ||
    typeof input.expectedTargetTip !== 'string' || !input.expectedTargetTip.trim()
  )) {
    return fail('invalid_input');
  }
  if (!prepare && input.authorizationDeadlineMs !== undefined &&
      (!Number.isSafeInteger(input.authorizationDeadlineMs) || typeof input.authorizeBeforeTargetCas !== 'function')) {
    return fail('invalid_native_authorization');
  }
  const policy = unsupportedPlumbingPolicy(execGit, targetRoot);
  if (policy.unsupported) return fail('unsupported_policy', policy.detail, { recoverable: true });

  const listed = readWorktreeList(targetRoot, { execGit });
  if (!listed.ok) return fail(listed.reason);
  let canonicalWorktreePath: string;
  try { canonicalWorktreePath = fs.realpathSync.native(worktreePath); }
  catch (err) { return fail('worktree_identity_unverified', (err as Error).message); }
  const listedMatches = listed.entries.filter((candidate: WorktreeEntry) => {
    try { return fs.realpathSync.native(candidate.path) === canonicalWorktreePath; }
    catch { return false; }
  });
  if (listedMatches.length !== 1) return fail('worktree_identity_unverified');
  if (listedMatches[0].branch !== branch) return fail('worktree_branch_mismatch');

  const worktreeBranch = execGit(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
  if (!gitResultOk(worktreeBranch) || worktreeBranch.stdout.trim() !== branch) {
    return fail(worktreeBranch.timedOut ? 'git_timed_out' : 'worktree_branch_mismatch', worktreeBranch.stderr || '');
  }
  const branchTip = execGit(['rev-parse', `refs/heads/${branch}`], { cwd: targetRoot });
  if (!gitResultOk(branchTip)) return fail(branchTip.timedOut ? 'git_timed_out' : 'child_tip_unverified', branchTip.stderr || '');
  const childTip = branchTip.stdout.trim();
  const worktreeTip = execGit(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: targetRoot });
  if (!gitResultOk(worktreeTip) || worktreeTip.stdout.trim() !== childTip) {
    return fail(worktreeTip.timedOut ? 'git_timed_out' : 'worktree_tip_mismatch', worktreeTip.stderr || '', { child_tip: childTip });
  }
  if (input.expectedChildTip !== undefined && childTip !== input.expectedChildTip.trim()) {
    return fail('child_tip_mismatch', '', { child_tip: childTip, expected_child_tip: input.expectedChildTip.trim() });
  }
  const targetTipResult = execGit(['rev-parse', 'HEAD'], { cwd: targetRoot });
  if (!gitResultOk(targetTipResult)) return fail(targetTipResult.timedOut ? 'git_timed_out' : 'target_tip_unverified', targetTipResult.stderr || '', { child_tip: childTip });
  const targetTip = targetTipResult.stdout.trim();
  if (repoRootStillMidMerge(execGit, targetRoot)) return fail('target_mid_merge', '', { child_tip: childTip, target_tip: targetTip });
  const targetBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
  const targetBranchName = targetBranch.stdout.trim();
  if (!gitResultOk(targetBranch) || targetBranchName === 'HEAD' || targetBranchName === branch) {
    return fail(targetBranch.timedOut ? 'git_timed_out' : 'branch_is_target_head', targetBranch.stderr || '', { child_tip: childTip, target_tip: targetTip });
  }
  const signing = effectiveSigningPolicy(execGit, targetRoot, targetBranchName);
  if (!signing.ok) return fail('unsupported_policy', signing.detail, { recoverable: true });
  if (signing.required) {
    return fail('unsupported_policy', 'signed merge commits are not supported by the deterministic CAS merge primitive', { recoverable: true });
  }
  const immutableChild = prepare ? childTip : input.expectedChildTip!.trim();
  const ancestry = execGit(['merge-base', '--is-ancestor', immutableChild, 'HEAD'], { cwd: targetRoot });
  if (ancestry.timedOut) return fail('git_timed_out', ancestry.stderr || '', { child_tip: childTip, target_tip: targetTip });
  if (prepare && ancestry.exitCode === 0) {
    return { ok: true, status: 'already_merged', reason: 'already_merged', child_tip: childTip, target_tip: targetTip, merge_tip: targetTip, worktree: 'preserved', branch: 'preserved' };
  }
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) return fail('ancestry_check_failed', ancestry.stderr || '', { child_tip: childTip, target_tip: targetTip });
  const expectedTarget = prepare ? targetTip : input.expectedTargetTip!.trim();
  if (repoRootStillMidMerge(execGit, worktreePath)) return fail('worktree_mid_merge', '', { child_tip: childTip, target_tip: targetTip });
  if (prepare) {
    const mergeBase = execGit(['merge-base', expectedTarget, immutableChild], { cwd: targetRoot });
    const allowedBases = Array.isArray(entry.allowed_bases) && entry.allowed_bases.length > 0 ? entry.allowed_bases : [entry.expected_base];
    if (!gitResultOk(mergeBase) || !allowedBases.includes(mergeBase.stdout.trim())) return fail('base_mismatch', mergeBase.stderr || '', { child_tip: childTip, target_tip: targetTip });
    const deletions = execGit(['diff', '--diff-filter=D', '--name-only', `${expectedTarget}...${immutableChild}`], { cwd: targetRoot });
    if (!gitResultOk(deletions)) return fail('deletion_check_failed', deletions.stderr || '', { child_tip: childTip, target_tip: targetTip });
    const undeclaredDeletions = partitionDeclaredDeletions((deletions.stdout || '').split('\n'), entry.declared_deletions);
    if (undeclaredDeletions.length > 0) return fail('branch_contains_deletions', undeclaredDeletions.join('\n'), { child_tip: childTip, target_tip: targetTip });
    const declaredFiles = Array.isArray(entry.files_modified) ? entry.files_modified : [];
    if (declaredFiles.length > 0) {
      const scopeDiff = execGit(['diff', '--name-only', `${expectedTarget}...${immutableChild}`], { cwd: targetRoot });
      if (!gitResultOk(scopeDiff)) return fail('scope_check_failed', scopeDiff.stderr || '', { child_tip: childTip, target_tip: targetTip });
      const violations = planWaveScopeConformance((scopeDiff.stdout || '').split('\n'), declaredFiles, branch)
        .filter((warning: { path: string | null }) => warning.path === null || partitionDeclaredDeletions([warning.path], entry.declared_deletions).length > 0);
      if (violations.length > 0) return fail('scope_out_of_declared', violations.map((warning: { path: string | null }) => warning.path).filter(Boolean).join('\n'), { child_tip: childTip, target_tip: targetTip });
    }
  }
  const status = execGit(['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'], { cwd: targetRoot });
  if (!gitResultOk(status) || status.stdout.trim()) return fail(status.timedOut ? 'git_timed_out' : 'worktree_dirty', status.stderr || status.stdout || '', { child_tip: childTip, target_tip: targetTip });
  if (prepare) {
    const capability = execGit(['merge-tree', '--write-tree', targetTip, targetTip], { cwd: targetRoot });
    if (!gitResultOk(capability)) {
      return fail('unsupported_git_capability', capability.stderr || capability.stdout || '', { child_tip: childTip, target_tip: targetTip });
    }
    return { ok: true, status: 'prepared', reason: 'prepared', child_tip: childTip, target_tip: targetTip, worktree: 'preserved', branch: 'preserved' };
  }

  // `merge-tree --write-tree` is object-only: it neither reads nor mutates the
  // moving checkout/index. Its exact result anchors both publication and retry.
  const mergedTree = execGit(['merge-tree', '--write-tree', expectedTarget, immutableChild], { cwd: targetRoot });
  if (!gitResultOk(mergedTree)) {
    return fail(mergedTree.timedOut ? 'git_timed_out' : 'merge_failed', mergedTree.stderr || mergedTree.stdout || '', { child_tip: childTip, target_tip: expectedTarget });
  }
  const treeOid = mergedTree.stdout.split('\n', 1)[0].trim();
  const [identityName, identityEmail, targetTime, childTime] = [
    execGit(['show', '-s', '--format=%cn', expectedTarget], { cwd: targetRoot }),
    execGit(['show', '-s', '--format=%ce', expectedTarget], { cwd: targetRoot }),
    execGit(['show', '-s', '--format=%ct', expectedTarget], { cwd: targetRoot }),
    execGit(['show', '-s', '--format=%ct', immutableChild], { cwd: targetRoot }),
  ];
  if (![identityName, identityEmail, targetTime, childTime].every(gitResultOk)) {
    return fail('merge_metadata_unverified', [identityName, identityEmail, targetTime, childTime].map((result) => result.stderr).filter(Boolean).join('\n'), { child_tip: childTip, target_tip: expectedTarget });
  }
  if (!Number.isSafeInteger(Number(targetTime.stdout)) || !Number.isSafeInteger(Number(childTime.stdout))) {
    return fail('merge_metadata_unverified', '', { child_tip: childTip, target_tip: expectedTarget });
  }
  const deterministicTimestamp = `${Math.max(Number(targetTime.stdout), Number(childTime.stdout)) + 1} +0000`;
  const message = `chore: merge executor worktree (${branch})`;
  const mergeCommit = execGit(
    ['commit-tree', treeOid, '-p', expectedTarget, '-p', immutableChild, '-m', message],
    {
      cwd: targetRoot,
      env: {
        GIT_AUTHOR_NAME: identityName.stdout.trim(),
        GIT_AUTHOR_EMAIL: identityEmail.stdout.trim(),
        GIT_AUTHOR_DATE: deterministicTimestamp,
        GIT_COMMITTER_NAME: identityName.stdout.trim(),
        GIT_COMMITTER_EMAIL: identityEmail.stdout.trim(),
        GIT_COMMITTER_DATE: deterministicTimestamp,
      },
    },
  );
  if (!gitResultOk(mergeCommit)) return fail(mergeCommit.timedOut ? 'git_timed_out' : 'merge_commit_failed', mergeCommit.stderr || '', { child_tip: childTip, target_tip: expectedTarget });
  const mergeTip = mergeCommit.stdout.trim();
  let landed = false;
  if (targetTip !== expectedTarget) {
    if (targetTip !== mergeTip) return fail('target_tip_mismatch', '', { child_tip: childTip, target_tip: targetTip, expected_target_tip: expectedTarget });
    landed = true;
  }

  if (!landed) {
    const mergeBase = execGit(['merge-base', expectedTarget, immutableChild], { cwd: targetRoot });
    const allowedBases = Array.isArray(entry.allowed_bases) && entry.allowed_bases.length > 0 ? entry.allowed_bases : [entry.expected_base];
    if (!gitResultOk(mergeBase) || !allowedBases.includes(mergeBase.stdout.trim())) return fail('base_mismatch', mergeBase.stderr || '', { child_tip: childTip, target_tip: targetTip });
    const deletions = execGit(['diff', '--diff-filter=D', '--name-only', `${expectedTarget}...${immutableChild}`], { cwd: targetRoot });
    if (!gitResultOk(deletions)) return fail('deletion_check_failed', deletions.stderr || '', { child_tip: childTip, target_tip: targetTip });
    const undeclaredDeletions = partitionDeclaredDeletions((deletions.stdout || '').split('\n'), entry.declared_deletions);
    if (undeclaredDeletions.length > 0) return fail('branch_contains_deletions', undeclaredDeletions.join('\n'), { child_tip: childTip, target_tip: targetTip });
    const declaredFiles = Array.isArray(entry.files_modified) ? entry.files_modified : [];
    if (declaredFiles.length > 0) {
      const scopeDiff = execGit(['diff', '--name-only', `${expectedTarget}...${immutableChild}`], { cwd: targetRoot });
      if (!gitResultOk(scopeDiff)) return fail('scope_check_failed', scopeDiff.stderr || '', { child_tip: childTip, target_tip: targetTip });
      const violations = planWaveScopeConformance((scopeDiff.stdout || '').split('\n'), declaredFiles, branch)
        .filter((warning: { path: string | null }) => warning.path === null || partitionDeclaredDeletions([warning.path], entry.declared_deletions).length > 0);
      if (violations.length > 0) return fail('scope_out_of_declared', violations.map((warning: { path: string | null }) => warning.path).filter(Boolean).join('\n'), { child_tip: childTip, target_tip: targetTip });
    }
  }

  const immediateTargetBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
  const immediateTargetHead = execGit(['rev-parse', 'HEAD'], { cwd: targetRoot });
  const immediateTargetRef = execGit(['rev-parse', `refs/heads/${targetBranchName}`], { cwd: targetRoot });
  const targetUnstaged = execGit(['diff-files', '--quiet'], { cwd: targetRoot });
  const targetStaged = execGit(['diff-index', '--cached', '--quiet', expectedTarget], { cwd: targetRoot });
  const baselineInventory = localUntrackedInventory(execGit, targetRoot);
  const expectedCurrentTarget = landed ? targetTip : expectedTarget;
  if (!gitResultOk(immediateTargetBranch) || immediateTargetBranch.stdout.trim() !== targetBranchName ||
      !gitResultOk(immediateTargetHead) || immediateTargetHead.stdout.trim() !== expectedCurrentTarget ||
      !gitResultOk(immediateTargetRef) || immediateTargetRef.stdout.trim() !== expectedCurrentTarget ||
      (!landed && (!gitResultOk(targetUnstaged) || !gitResultOk(targetStaged))) || !baselineInventory.ok) {
    const timedOut = immediateTargetBranch.timedOut || immediateTargetHead.timedOut || immediateTargetRef.timedOut;
    const identityMismatch = !gitResultOk(immediateTargetBranch) || immediateTargetBranch.stdout.trim() !== targetBranchName ||
      !gitResultOk(immediateTargetHead) || immediateTargetHead.stdout.trim() !== expectedCurrentTarget ||
      !gitResultOk(immediateTargetRef) || immediateTargetRef.stdout.trim() !== expectedCurrentTarget;
    const targetDirty = (!landed && (!gitResultOk(targetUnstaged) || !gitResultOk(targetStaged))) || !baselineInventory.ok;
    return fail(timedOut || targetUnstaged.timedOut || targetStaged.timedOut || baselineInventory.timedOut ? 'git_timed_out' : (identityMismatch ? 'target_tip_mismatch' : (targetDirty ? 'target_dirty' : 'target_tip_mismatch')),
      immediateTargetBranch.stderr || immediateTargetHead.stderr || immediateTargetRef.stderr || targetUnstaged.stderr || targetStaged.stderr || baselineInventory.stderr || '',
      { child_tip: childTip, target_tip: immediateTargetHead.stdout.trim(), expected_target_tip: expectedTarget });
  }

  const updatePathsResult = execGit(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', expectedTarget, treeOid], { cwd: targetRoot, rawStdout: true });
  if (!gitResultOk(updatePathsResult)) return fail(updatePathsResult.timedOut ? 'git_timed_out' : 'merge_update_inventory_failed', updatePathsResult.stderr || '', { child_tip: childTip, target_tip: expectedTarget });
  const updatePaths = nulPaths(updatePathsResult);
  const preCasCollision = inventoryCollidesWithUpdates(targetRoot, baselineInventory.paths, updatePaths);
  if (preCasCollision !== null) {
    if (!landed) {
      return fail('target_local_collision', preCasCollision, { child_tip: childTip, target_tip: expectedTarget, collision_path: preCasCollision });
    }
    return { ok: false, status: 'merged_sync_pending', reason: 'target_worktree_sync_pending', recoverable: true, stderr: preCasCollision, collision_path: preCasCollision, child_tip: childTip, target_tip: expectedTarget, worktree: 'preserved', branch: 'preserved' };
  }
  if (!landed) {
    deps.beforeMerge?.();
    if (input.authorizationDeadlineMs !== undefined) {
      if (input.authorizeBeforeTargetCas?.() !== true) {
        return fail('authorization_expired', '', { recoverable: true, child_tip: childTip, target_tip: expectedTarget });
      }
      const now = deps.now ? deps.now() : (deps.nowMs ?? Date.now());
      if (now > input.authorizationDeadlineMs) return fail('authorization_expired', '', { recoverable: true, child_tip: childTip, target_tip: expectedTarget });
    }
    const publish = execGit(['update-ref', `refs/heads/${targetBranchName}`, mergeTip, expectedTarget], { cwd: targetRoot });
    if (!gitResultOk(publish)) {
      const current = execGit(['rev-parse', `refs/heads/${targetBranchName}`], { cwd: targetRoot });
      const currentTip = current.stdout.trim();
      if (!gitResultOk(current) || currentTip !== mergeTip) {
        const reason = current.timedOut ? 'git_timed_out' : 'target_tip_mismatch';
        return fail(reason, publish.stderr || current.stderr || '', { child_tip: childTip, target_tip: currentTip, expected_target_tip: expectedTarget });
      }
      // Lost update-ref response: only the exact regenerated deterministic OID
      // is accepted. Alternate headers, signatures, or merely equivalent trees
      // necessarily produce a different OID and remain preserved as a mismatch.
      landed = true;
    }
  } else if (gitResultOk(execGit(['diff-index', '--quiet', mergeTip], { cwd: targetRoot }))) {
    return { ok: true, status: 'already_merged', reason: 'already_merged', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
  }

  deps.afterMergeCas?.();
  const postCasBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
  const postCasHead = execGit(['rev-parse', 'HEAD'], { cwd: targetRoot });
  const postCasRef = execGit(['rev-parse', `refs/heads/${targetBranchName}`], { cwd: targetRoot });
  if (!gitResultOk(postCasBranch) || postCasBranch.stdout.trim() !== targetBranchName ||
      !gitResultOk(postCasHead) || postCasHead.stdout.trim() !== mergeTip ||
      !gitResultOk(postCasRef) || postCasRef.stdout.trim() !== mergeTip) {
    return { ok: false, status: 'merged_sync_pending', reason: 'target_worktree_sync_pending', recoverable: true, stderr: postCasBranch.stderr || postCasHead.stderr || postCasRef.stderr || '', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
  }
  const unstaged = execGit(['diff-files', '--quiet'], { cwd: targetRoot });
  const staged = execGit(['diff-index', '--cached', '--quiet', expectedTarget], { cwd: targetRoot });
  const currentInventory = localUntrackedInventory(execGit, targetRoot);
  const concurrentCollision = currentInventory.ok
    ? inventoryCollidesWithUpdates(targetRoot, currentInventory.paths, updatePaths)
    : null;
  const concurrentDirt = !gitResultOk(unstaged) || !gitResultOk(staged) || !currentInventory.ok ||
    !sameStringPaths(currentInventory.paths, baselineInventory.paths) || concurrentCollision !== preCasCollision;
  if (concurrentDirt) {
    return { ok: false, status: 'merged_sync_pending', reason: 'target_worktree_sync_pending', recoverable: true, stderr: unstaged.stderr || staged.stderr || currentInventory.stderr || concurrentCollision || '', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
  }
  // Pure Git/Node offers no inode-conditional whole-tree update: a hostile
  // same-user writer can still create an ignored path in the micro-window
  // between this inventory and read-tree. The final inventory detects drift
  // but cannot restore bytes already overwritten; such direct same-user writes
  // remain outside the supported threat model. This primitive does not hold a
  // common checkout-mutation lock; callers must not imply that journal locking
  // fences arbitrary Git commands or direct filesystem writes. read-tree itself
  // still protects ordinary tracked dirt.
  const sync = execGit(['read-tree', '-u', '-m', expectedTarget, mergeTip], { cwd: targetRoot });
  if (!gitResultOk(sync)) {
    return { ok: false, status: 'merged_sync_pending', reason: 'target_worktree_sync_pending', recoverable: true, stderr: sync.stderr || '', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
  }
  const finalUnstaged = execGit(['diff-files', '--quiet'], { cwd: targetRoot });
  const finalStaged = execGit(['diff-index', '--cached', '--quiet', mergeTip], { cwd: targetRoot });
  const finalInventory = localUntrackedInventory(execGit, targetRoot);
  if (!gitResultOk(finalUnstaged) || !gitResultOk(finalStaged) || !finalInventory.ok ||
      !sameStringPaths(finalInventory.paths, baselineInventory.paths)) {
    return { ok: false, status: 'merged_sync_pending', reason: 'target_worktree_sync_pending', recoverable: true, stderr: finalUnstaged.stderr || finalStaged.stderr || finalInventory.stderr || '', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
  }
  return { ok: true, status: landed ? 'already_merged' : 'merged', reason: landed ? 'already_merged' : 'merged', child_tip: childTip, target_tip: expectedTarget, merge_tip: mergeTip, worktree: 'preserved', branch: 'preserved' };
}

/** Remove one exact already-merged worktree and branch using child-tip ancestry as the sole merge proof. */
function teardownMergedWorktree(input: DurableWorktreeInput, deps: WorktreeMutationDeps = {}): Record<string, unknown> {
  const execGit = deps.execGit || execGitDefault;
  const existsSync = deps.existsSync || fs.existsSync;
  const fail = (reason: string, stderr = ''): Record<string, unknown> => ({ ok: false, status: 'blocked', reason, stderr });
  const binding = validateDurableWorktreeBinding(input);
  if (!binding.ok) return fail(binding.reason);
  const mergedChildTip = input.mergedChildTip ?? input.childTip;
  if (typeof mergedChildTip !== 'string' || !mergedChildTip.trim()) return fail('invalid_input');
  const { targetRoot, worktreePath, branch } = binding;

  const ancestry = execGit(['merge-base', '--is-ancestor', mergedChildTip, 'HEAD'], { cwd: targetRoot });
  if (ancestry.timedOut) return fail('git_timed_out', ancestry.stderr || '');
  if (ancestry.exitCode === 1) return fail('merge_not_landed', ancestry.stderr || '');
  if (ancestry.exitCode !== 0) return fail('merged_tip_unverified', ancestry.stderr || '');
  if (repoRootStillMidMerge(execGit, targetRoot)) return fail('target_mid_merge');
  const targetBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
  if (!gitResultOk(targetBranch) || targetBranch.stdout.trim() === branch) {
    return fail(targetBranch.timedOut ? 'git_timed_out' : 'branch_is_target_head', targetBranch.stderr || '');
  }

  const worktreePresent = existsSync(worktreePath);
  if (!worktreePresent) {
    const listed = readWorktreeList(targetRoot, { execGit });
    if (!listed.ok) return fail(listed.reason);
    const stillRegistered = listed.entries.some((candidate: WorktreeEntry) => path.resolve(candidate.path) === worktreePath);
    if (stillRegistered) return fail('worktree_identity_unverified');
  }
  if (worktreePresent) {
    const listed = readWorktreeList(targetRoot, { execGit });
    if (!listed.ok) return fail(listed.reason);
    let canonicalWorktreePath: string;
    try { canonicalWorktreePath = fs.realpathSync.native(worktreePath); }
    catch (err) { return fail('worktree_identity_unverified', (err as Error).message); }
    const listedMatches = listed.entries.filter((candidate: WorktreeEntry) => {
      try { return fs.realpathSync.native(candidate.path) === canonicalWorktreePath; }
      catch { return false; }
    });
    if (listedMatches.length !== 1) return fail('worktree_identity_unverified');
    if (listedMatches[0].branch !== branch) return fail('worktree_branch_mismatch');
    const worktreeBranch = execGit(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
    if (!gitResultOk(worktreeBranch) || worktreeBranch.stdout.trim() !== branch) return fail('worktree_branch_mismatch', worktreeBranch.stderr || '');
    const worktreeTip = execGit(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: targetRoot });
    if (!gitResultOk(worktreeTip) || worktreeTip.stdout.trim() !== mergedChildTip.trim()) {
      return fail(worktreeTip.timedOut ? 'git_timed_out' : 'child_tip_mismatch', worktreeTip.stderr || '');
    }
    const branchTip = execGit(['rev-parse', `refs/heads/${branch}`], { cwd: targetRoot });
    if (!gitResultOk(branchTip) || branchTip.stdout.trim() !== mergedChildTip.trim()) {
      return fail(branchTip.timedOut ? 'git_timed_out' : 'child_tip_mismatch', branchTip.stderr || '');
    }
    if (repoRootStillMidMerge(execGit, worktreePath)) return fail('worktree_mid_merge');
    const status = execGit(['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'], { cwd: targetRoot });
    if (!gitResultOk(status) || status.stdout.trim()) return fail(status.timedOut ? 'git_timed_out' : 'worktree_dirty', status.stderr || status.stdout || '');
    deps.beforeWorktreeRemove?.();
    const immediateListed = readWorktreeList(targetRoot, { execGit });
    if (!immediateListed.ok) return fail(immediateListed.reason);
    const immediateMatches = immediateListed.entries.filter((candidate: WorktreeEntry) => {
      try { return fs.realpathSync.native(candidate.path) === canonicalWorktreePath; }
      catch { return false; }
    });
    if (immediateMatches.length !== 1) return fail('worktree_identity_unverified');
    if (immediateMatches[0].branch !== branch) return fail('worktree_branch_mismatch');
    const immediateWorktreeBranch = execGit(['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetRoot });
    const immediateWorktreeTip = execGit(['-C', worktreePath, 'rev-parse', 'HEAD'], { cwd: targetRoot });
    const immediateBranchTip = execGit(['rev-parse', `refs/heads/${branch}`], { cwd: targetRoot });
    const immediateStatus = execGit(['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'], { cwd: targetRoot });
    if (!gitResultOk(immediateWorktreeBranch) || immediateWorktreeBranch.stdout.trim() !== branch) return fail('worktree_branch_mismatch', immediateWorktreeBranch.stderr || '');
    if (!gitResultOk(immediateWorktreeTip) || !gitResultOk(immediateBranchTip) ||
        immediateWorktreeTip.stdout.trim() !== mergedChildTip.trim() || immediateBranchTip.stdout.trim() !== mergedChildTip.trim()) {
      return fail(immediateWorktreeTip.timedOut || immediateBranchTip.timedOut ? 'git_timed_out' : 'child_tip_mismatch', immediateWorktreeTip.stderr || immediateBranchTip.stderr || '');
    }
    if (!gitResultOk(immediateStatus) || immediateStatus.stdout.trim()) return fail(immediateStatus.timedOut ? 'git_timed_out' : 'worktree_dirty', immediateStatus.stderr || immediateStatus.stdout || '');
    const remove = execGit(['worktree', 'remove', worktreePath], { cwd: targetRoot });
    if (!gitResultOk(remove)) return fail(remove.timedOut ? 'git_timed_out' : 'worktree_remove_failed', remove.stderr || '');
  }
  const branchExists = execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: targetRoot });
  if (branchExists.timedOut) return fail('git_timed_out', branchExists.stderr || '');
  if (branchExists.exitCode !== 0 && branchExists.exitCode !== 1) return fail('branch_presence_unverified', branchExists.stderr || '');
  if (branchExists.exitCode === 0) {
    // Revalidate the surviving ref after worktree removal and immediately
    // before destructive branch deletion. A moved branch may contain work not
    // covered by the recorded merge proof and must be preserved.
    const branchTip = execGit(['rev-parse', `refs/heads/${branch}`], { cwd: targetRoot });
    if (!gitResultOk(branchTip) || branchTip.stdout.trim() !== mergedChildTip.trim()) {
      return fail(branchTip.timedOut ? 'git_timed_out' : 'child_tip_mismatch', branchTip.stderr || '');
    }
    deps.beforeBranchDelete?.();
    const beforeDeleteList = readWorktreeList(targetRoot, { execGit });
    if (!beforeDeleteList.ok) return fail(beforeDeleteList.reason);
    if (beforeDeleteList.entries.some((candidate: WorktreeEntry) => candidate.branch === branch)) {
      return fail('worktree_branch_still_checked_out');
    }
    const deleted = execGit(['update-ref', '-d', `refs/heads/${branch}`, mergedChildTip.trim()], { cwd: targetRoot });
    if (!gitResultOk(deleted)) {
      const presence = execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: targetRoot });
      if (!presence.timedOut && presence.exitCode === 1) {
        return { ok: true, status: worktreePresent ? 'removed' : 'already_removed', reason: worktreePresent ? 'removed' : 'already_removed', worktree: worktreePresent ? 'removed' : 'already_removed', branch: 'already_removed' };
      }
      const currentTip = execGit(['rev-parse', `refs/heads/${branch}`], { cwd: targetRoot });
      const moved = gitResultOk(currentTip) && currentTip.stdout.trim() !== mergedChildTip.trim();
      if (moved) return fail('child_tip_mismatch', currentTip.stderr || '');
      return { ok: false, status: 'branch_delete_warning', reason: 'branch_delete_warning', stderr: deleted.stderr || '', worktree: worktreePresent ? 'removed' : 'already_removed' };
    }
  }
  const changed = worktreePresent || branchExists.exitCode === 0;
  return { ok: true, status: changed ? 'removed' : 'already_removed', reason: changed ? 'removed' : 'already_removed', worktree: worktreePresent ? 'removed' : 'already_removed', branch: branchExists.exitCode === 0 ? 'removed' : 'already_removed' };
}


  return { mergePreparedWorktree, teardownMergedWorktree };
}

export = { createOpenCodeV2WorktreeMutation };
