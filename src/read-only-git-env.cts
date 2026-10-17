/**
 * read-only-git-env.cts — the single owner of the read-only git env block
 * (#5048). CONTEXT.md / OS Shell Projection seam.
 *
 * By default `git status` refreshes the index and takes an *optional*
 * `.git/index.lock` to write the refreshed copy back. That is a write the caller
 * never asked for, and it turns a pure read into a contender for the lock a
 * real `git add` / `git commit` needs — so a read-only statusline render can
 * make a concurrent commit fail with
 * `Unable to create '.git/index.lock': File exists`. `GIT_OPTIONAL_LOCKS=0`
 * tells git to skip only those *optional* index operations. Nothing a read
 * needs is lost: `git status` reads the index, it just doesn't need to rewrite
 * it.
 *
 * ## Why this module exists
 *
 * The block used to be hand-written at every seam that spawns git for a read.
 * Six copies of `{ ...process.env, GIT_OPTIONAL_LOCKS: '0' }` is six places to
 * forget when a seam is added, and a probe that checks each seam for the literal
 * value passes even when a seam stopped consulting the owner. One owner makes
 * the drift structural instead: the parity test patches THIS function to a
 * sentinel and asserts every seam's spawn carries the sentinel, so a seam that
 * hand-writes the variable again fails red rather than passing quietly.
 * (tests/git-optional-locks-parity.test.cjs, "#5048 every seam reads the shared
 * owner".)
 *
 * ## Why the hook scripts require the built artifact
 *
 * `hooks/*.js` are staged as standalone files at install time, so they reach
 * compiled `src/` modules through `../gsd-core/bin/lib/*.cjs` rather than a
 * sibling hooks/-tree file — the same rule hooks/lib/git-cmd.js follows for
 * token-scanner. They call `readOnlyGitEnv()` per spawn rather than snapshotting
 * the result at module load, so a later `process.env` mutation is visible and the
 * two behave identically.
 */

/**
 * Build the env for a read-only git spawn.
 *
 * @param base Environment to spread, `process.env` by default. Callers that
 *   layer extra git variables on top (GIT_TERMINAL_PROMPT, a caller's own
 *   overrides) pass them in `base`; callers that must let a caller-supplied
 *   override win spread the result and apply their own keys afterwards.
 * @returns A fresh object each call — never the cached `process.env`.
 */
export function readOnlyGitEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // process.env carries undefined-valued keys on some platforms; spawn()
    // rejects a non-string value rather than ignoring it.
    if (value !== undefined) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}
