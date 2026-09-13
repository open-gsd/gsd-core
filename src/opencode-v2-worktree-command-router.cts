/** Strict CLI routing for OpenCode V2 durable worktree mutations. */

import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- quick-batch-v2.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
import quickBatchV2Module = require('./quick-batch-v2.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- worktree-safety.cjs is a CommonJS module compiled from a sibling .cts source; `import x = require()` reads its module.exports namespace directly.
import worktreeSafetyModule = require('./worktree-safety.cjs');

type FlagValues = Record<string, string>;

interface CommandRouterOptions {
  args: string[];
  cwd: string;
  raw?: boolean;
  error(this: void, message: string, reason?: string): void;
  output(value: unknown, raw?: boolean): void;
  formatDiagnosticToken(value: string): string;
}

const quickBatchV2 = quickBatchV2Module as {
  requiresNativeAuthorization(cwd: string, request: Record<string, string>): boolean;
};
const worktreeSafety = worktreeSafetyModule as {
  mergePreparedWorktree(input: Record<string, unknown>): Record<string, unknown>;
  teardownMergedWorktree(input: Record<string, unknown>): Record<string, unknown>;
};

function parseExactFlags(
  tokens: string[],
  allowed: readonly string[],
  required: readonly string[],
  error: CommandRouterOptions['error'],
  label: string,
  allowPrepare = false,
): { values: FlagValues; prepare: boolean } | null {
  const values: FlagValues = {};
  let prepare = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (allowPrepare && flag === '--prepare') {
      if (prepare) error(`Duplicate argument for worktree ${label}: --prepare`, 'usage');
      prepare = true;
      continue;
    }
    if (!allowed.includes(flag)) error(`Unknown argument for worktree ${label}: ${flag}`, 'usage');
    if (Object.hasOwn(values, flag)) error(`Duplicate argument for worktree ${label}: ${flag}`, 'usage');
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) error(`Missing value for ${flag}`, 'usage');
    values[flag] = value;
    index += 1;
  }
  for (const flag of required) {
    if (!Object.hasOwn(values, flag)) error(`Missing required argument for worktree ${label}: ${flag}`, 'usage');
  }
  return { values, prepare };
}

function readManifest(pathname: string, options: CommandRouterOptions): string | null {
  try {
    return fs.readFileSync(pathname, 'utf8');
  } catch {
    options.error(`Cannot read manifest at ${options.formatDiagnosticToken(pathname)}`, 'usage');
    return null;
  }
}

/** Returns true only when it handled an OpenCode V2 mutation verb. */
function tryRouteOpenCodeV2WorktreeCommand(options: CommandRouterOptions): boolean {
  const subcommand = options.args[1];
  if (subcommand !== 'merge-one' && subcommand !== 'teardown-one') return false;

  if (subcommand === 'merge-one') {
    const required = [
      '--manifest-path', '--actual-manifest-agent-id', '--canonical-worktree-path',
      '--branch', '--target-root', '--worktree-root',
    ];
    const parsed = parseExactFlags(
      options.args.slice(2),
      [...required, '--expected-child-tip', '--expected-target-tip'],
      required,
      options.error,
      'merge-one',
      true,
    );
    if (!parsed) return true;
    const { values, prepare } = parsed;
    for (const flag of ['--expected-child-tip', '--expected-target-tip']) {
      if (!prepare && !Object.hasOwn(values, flag)) {
        options.error(`Missing required argument for worktree merge-one: ${flag}`, 'usage');
      }
    }
    const manifest = readManifest(values['--manifest-path'], options);
    if (manifest === null) return true;
    if (!prepare && quickBatchV2.requiresNativeAuthorization(options.cwd, {
      manifest_path: values['--manifest-path'],
      worktree_path: values['--canonical-worktree-path'],
      branch: values['--branch'],
    })) {
      options.error('Native OpenCode worktree merge requires quick-batch v2-merge journal authorization', 'usage');
    }
    options.output(worktreeSafety.mergePreparedWorktree({
      manifest,
      actualManifestAgentId: values['--actual-manifest-agent-id'],
      canonicalWorktreePath: values['--canonical-worktree-path'],
      branch: values['--branch'],
      expectedChildTip: values['--expected-child-tip'],
      expectedTargetTip: values['--expected-target-tip'],
      targetRoot: values['--target-root'],
      worktreeRoot: values['--worktree-root'],
      prepare,
    }), options.raw);
    return true;
  }

  const required = [
    '--manifest-path', '--actual-manifest-agent-id', '--canonical-worktree-path',
    '--branch', '--merged-child-tip', '--target-root', '--worktree-root',
  ];
  const parsed = parseExactFlags(options.args.slice(2), required, required, options.error, 'teardown-one');
  if (!parsed) return true;
  const { values } = parsed;
  const manifest = readManifest(values['--manifest-path'], options);
  if (manifest === null) return true;
  if (quickBatchV2.requiresNativeAuthorization(options.cwd, {
    manifest_path: values['--manifest-path'],
    worktree_path: values['--canonical-worktree-path'],
    branch: values['--branch'],
  })) {
    options.error('Native OpenCode worktree teardown requires quick-batch v2-teardown journal authorization', 'usage');
  }
  options.output(worktreeSafety.teardownMergedWorktree({
    manifest,
    actualManifestAgentId: values['--actual-manifest-agent-id'],
    canonicalWorktreePath: values['--canonical-worktree-path'],
    branch: values['--branch'],
    mergedChildTip: values['--merged-child-tip'],
    targetRoot: values['--target-root'],
    worktreeRoot: values['--worktree-root'],
  }), options.raw);
  return true;
}

export = { tryRouteOpenCodeV2WorktreeCommand };
