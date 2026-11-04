/**
 * The single definition of "a test file" for the TDD gate (#5106).
 *
 * Two places decide what a test file is: the behavior-adding check (`task-command-router.cts`) and
 * the RED-commit pathspec in `workflows/execute-phase.md`. They were separate lists, so the pathspec
 * learned the Go / Elixir / RSpec / pytest names in #4715 while the router never did, and a task
 * listing only `placement_test.go` was classified behavior-adding — the gate then asked for a RED
 * commit for the task that IS the RED commit.
 *
 * `TEST_FILE_PATHSPECS` is the list in git-pathspec spelling, which is what the workflow passes to
 * `evaluation-scope --pathspec`; `isTestFilePath` evaluates the same list for a task's `<files>`.
 * A test pins the workflow's pathspec flags to this array, so the two cannot drift apart again.
 *
 * #5766: the router and the gate disagreed about CASE. `isTestFilePath` builds its basename globs
 * with the `i` regex flag and lowercases every directory segment, so `Tests/foo.rs`,
 * `__TESTS__/a.js` and `Foo.TEST.js` are test files to the router. Git pathspecs are case-SENSITIVE
 * unless they carry the `:(icase)` magic prefix, so the same paths were invisible to the gate and a
 * RED commit touching only `Tests/foo.rs` looked like no RED commit at all. The two consumers must
 * answer ONE question, and the router's case-insensitive answer is the one the shared-list header
 * already promised — so the GATE side is what moves: `TEST_FILE_GIT_PATHSPECS` is the same list
 * with git's `:(icase)` magic prefix on every entry, and the workflow passes exactly those. The
 * contract test now pins the workflow to THAT list, so neither the patterns nor their case
 * sensitivity can drift apart again.
 */

/** Git-pathspec spelling. A trailing `/` is a directory, anything else a basename glob. */
export const TEST_FILE_PATHSPECS = [
  '*.test.*', '*.spec.*', 'tests/', '__tests__/',
  '*_test.go', 'test_*.py', '*_test.py', '*_test.exs', '*_spec.rb', '*_test.rb',
] as const;

/**
 * Git's case-insensitive pathspec magic prefix (#5766).
 *
 * Git pathspecs match paths byte-for-byte by default, so `tests/` never matched a `Tests/` directory
 * and `*.test.*` never matched `Foo.TEST.js`. `:(icase)` is git's own long-form magic prefix for
 * "match this pathspec without regard to case"; it composes with the default glob magic, so
 * `:(icase)*.test.*` and `:(icase)tests/` are both valid and both case-insensitive.
 */
export const GIT_PATHSPEC_ICASE_PREFIX = ':(icase)';

/**
 * The git pathspec for one entry of `TEST_FILE_PATHSPECS`, case-insensitively.
 *
 * The mapping is the identity plus the magic prefix: every convention entry is already a git
 * pathspec (a basename glob, or a directory spelled with a trailing `/`), and `:(icase)` is a
 * prefix git accepts on both shapes. Keeping the mapping in one exported function — rather than
 * hand-writing the prefixed list — is what stops the prefixed list from drifting away from the
 * canonical one.
 *
 * @param spec - one entry of `TEST_FILE_PATHSPECS`.
 * @returns the git pathspec string that matches the same paths case-insensitively.
 */
export function toCaseInsensitiveGitPathspec(spec: string): string {
  return `${GIT_PATHSPEC_ICASE_PREFIX}${spec}`;
}

/**
 * The RED-commit gate's pathspecs: `TEST_FILE_PATHSPECS`, each with git's `:(icase)` magic prefix.
 *
 * This is what `workflows/execute-phase.md` passes as `--pathspec` to `check evaluation-scope`, and
 * it is what makes the gate agree with `isTestFilePath` about case: a commit touching only
 * `Tests/foo.rs` or `Foo.TEST.js` is a RED commit to the router AND to the gate.
 */
export const TEST_FILE_GIT_PATHSPECS: readonly string[] =
  TEST_FILE_PATHSPECS.map((spec) => toCaseInsensitiveGitPathspec(spec));

/** Directory names a `<files>` entry may sit under. `test/` is the singular spelling many projects use. */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ...TEST_FILE_PATHSPECS.filter((spec) => spec.endsWith('/')).map((spec) => spec.slice(0, -1)),
  'test',
]);

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** A basename glob where `*` is any run of non-separator characters. */
const FILE_GLOBS: readonly RegExp[] = TEST_FILE_PATHSPECS
  .filter((spec) => !spec.endsWith('/'))
  .map((spec) => new RegExp(`^${spec.split('*').map(escapeRegex).join('[^/]*')}$`, 'i'));

/** True when `file` (either separator) is a test file by the shared convention list. */
export function isTestFilePath(file: string): boolean {
  const segments = file.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (FILE_GLOBS.some((glob) => glob.test(base))) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
