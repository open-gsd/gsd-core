/**
 * OpenCode V2 worktree provisioning.
 *
 * The entire local `.opencode` directory is copied after Git creates a linked
 * worktree. Its absence is deliberately a successful no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

interface ProvisionWorktreeContext {
  repoRoot: string;
  worktreePath: string;
}

function provisionOpenCodeV2Worktree({ repoRoot, worktreePath }: ProvisionWorktreeContext): void {
  const source = path.resolve(repoRoot, '.opencode');
  if (!fs.existsSync(source)) return;
  let canonicalSource: string;
  let canonicalWorktreePath: string;
  try {
    canonicalSource = fs.realpathSync.native(source);
    canonicalWorktreePath = fs.realpathSync.native(worktreePath);
    if (!fs.statSync(canonicalSource).isDirectory() || !fs.statSync(canonicalWorktreePath).isDirectory()) {
      throw new Error('source and worktree must be directories');
    }
  } catch (error) {
    throw new Error(`OpenCode V2 provisioning requires usable existing source and worktree directories: ${(error as Error).message}`);
  }
  const relativeToSource = path.relative(canonicalSource, canonicalWorktreePath);
  if (relativeToSource === '' || (!relativeToSource.startsWith(`..${path.sep}`) && relativeToSource !== '..' && !path.isAbsolute(relativeToSource))) {
    throw new Error(`OpenCode V2 provisioning refuses a worktree inside source .opencode: ${canonicalWorktreePath}`);
  }
  fs.cpSync(canonicalSource, path.join(canonicalWorktreePath, '.opencode'), { recursive: true, force: true });
}

export = { provisionOpenCodeV2Worktree };
