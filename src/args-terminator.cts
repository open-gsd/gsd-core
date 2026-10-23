/**
 * Per-install terminators for the typed-text capture heredocs (#5637).
 *
 * Every workflow that reads the typed text opens with
 *
 *   IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
 *   $ARGUMENTS
 *   GSD_ARGS_END
 *
 * and `/gsd-quick-batch` feeds `parse-args` through the same shape with `GSD_QUICK_BATCH_ARGS_END`.
 * The harness replaces `$ARGUMENTS` with the typed text before the shell parses the fence, so typed
 * text with a terminator line of its own closes the heredoc early and the lines after it run as
 * shell. A literal in a shipped file cannot be made unforgeable, so each install replaces it with
 * `<TERMINATOR>_<nonce>`, a nonce the typed text has no way to know. The shipped source keeps the
 * canonical tokens; only the files an install writes carry the nonce.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The canonical terminators the shipped workflows and commands carry. */
export const ARGS_TERMINATORS: readonly string[] = Object.freeze(['GSD_ARGS_END', 'GSD_QUICK_BATCH_ARGS_END']);

/** The terminator every workflow carries. */
export const ARGS_TERMINATOR = 'GSD_ARGS_END';

/** A nonce is 128 random bits as 32 lowercase hex characters. */
export const ARGS_NONCE_RE = /^[0-9a-f]{32}$/;

const OPENER_RE = new RegExp(`<<'(${ARGS_TERMINATORS.join('|')})'`, 'g');
const CLOSER_RE = new RegExp(`^(${ARGS_TERMINATORS.join('|')})(?=\\r?$)`, 'gm');

/** A fresh nonce. `randomBytes` is a seam for tests. */
export function generateArgsNonce(randomBytes: (size: number) => Buffer = nodeRandomBytes): string {
  return randomBytes(16).toString('hex');
}

/**
 * `content` with each canonical terminator replaced by the stamped one: the heredoc opener tag and
 * the closing line. A terminator that is already stamped does not match and is left alone, and so
 * is prose that names a token inside a line.
 *
 * @throws {TypeError} when `nonce` is not 32 lowercase hex characters
 */
export function stampArgsTerminator(content: string, nonce: string): string {
  if (typeof nonce !== 'string' || !ARGS_NONCE_RE.test(nonce)) {
    throw new TypeError('stampArgsTerminator: nonce must be 32 lowercase hex characters');
  }
  return content
    .replace(OPENER_RE, (_m: string, token: string) => `<<'${token}_${nonce}'`)
    .replace(CLOSER_RE, (_m: string, token: string) => `${token}_${nonce}`);
}

let armedNonce: string | null = null;

const INSTALLED_NONCE_RE = /^GSD_ARGS_END_([0-9a-f]{32})\r?$/m;

/** A workflow is tens of KiB; anything near this is not one, and is not read. */
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;

/**
 * The nonce a previous install left in `configDir`, read from the first installed workflow that
 * carries one; null when there is none. Entries that are not regular files (a directory, a FIFO,
 * a symlink) and files over MAX_WORKFLOW_BYTES are skipped, and one unreadable entry does not end
 * the scan.
 */
export function readInstalledNonce(configDir: string): string | null {
  let dir: string;
  let names: string[];
  try {
    dir = join(configDir, 'gsd-core', 'workflows');
    names = readdirSync(dir).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (!stat.isFile() || stat.size > MAX_WORKFLOW_BYTES) continue;
      const match = INSTALLED_NONCE_RE.exec(readFileSync(full, 'utf8'));
      if (match) return match[1];
    } catch {
      // This entry is unreadable; the next one may still carry the nonce.
    }
  }
  return null;
}

/**
 * Arm stamping for the install into `configDir`, before it writes anything. When `reuse` is true
 * the directory's installed nonce is kept, so a reinstall changes nothing; otherwise, or when
 * there is none, a fresh one is minted. Only a global install (a directory under the user's home,
 * which a cloned repository cannot seed) may reuse: a project-local directory is often committed,
 * and a nonce planted there would be adopted. Generators never arm it, so the committed generated
 * skills stay canonical and deterministic.
 */
export function armArgsNonce(configDir?: string, reuse = false): string {
  const prior = reuse && configDir !== undefined ? readInstalledNonce(configDir) : null;
  armedNonce = prior ?? generateArgsNonce();
  return armedNonce;
}

/** Stop stamping: the process is no longer writing for an install that has a nonce. */
export function disarmArgsNonce(): void {
  armedNonce = null;
}

/** `content` stamped with the armed nonce, or untouched when this process is not an installer. */
export function stampInstalledContent(content: string): string {
  return armedNonce === null ? content : stampArgsTerminator(content, armedNonce);
}
