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
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * The nonce a previous install left in `configDir`, read from the first installed workflow that
 * carries one; null when there is none or the directory cannot be read.
 */
export function readInstalledNonce(configDir: string): string | null {
  try {
    const dir = join(configDir, 'gsd-core', 'workflows');
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const match = INSTALLED_NONCE_RE.exec(readFileSync(join(dir, name), 'utf8'));
      if (match) return match[1];
    }
  } catch {
    // No previous install to read; the caller mints a fresh nonce.
  }
  return null;
}

/**
 * Arm stamping for the install into `configDir`, before it writes anything. A reinstall into the
 * same directory keeps that directory's nonce, so reinstalling changes nothing; a new directory
 * gets a fresh one. Generators and tests never arm it, so the committed generated skills stay
 * canonical and deterministic.
 */
export function armArgsNonce(configDir?: string): string {
  const prior = configDir === undefined ? null : readInstalledNonce(configDir);
  armedNonce = prior ?? generateArgsNonce();
  return armedNonce;
}

/** `content` stamped with the armed nonce, or untouched when this process is not an installer. */
export function stampInstalledContent(content: string): string {
  return armedNonce === null ? content : stampArgsTerminator(content, armedNonce);
}
