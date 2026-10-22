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

/**
 * Arm stamping for this process: an installer calls this once before it writes anything, so every
 * file the install writes carries the same nonce and two installs carry different ones. Generators
 * and tests never arm it, so the committed generated skills stay canonical and deterministic.
 */
export function armArgsNonce(): string {
  if (armedNonce === null) armedNonce = generateArgsNonce();
  return armedNonce;
}

/** `content` stamped with the armed nonce, or untouched when this process is not an installer. */
export function stampInstalledContent(content: string): string {
  return armedNonce === null ? content : stampArgsTerminator(content, armedNonce);
}
