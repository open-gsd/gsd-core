/**
 * The single definition of "a test file" for the TDD gate (#5106).
 *
 * Two places decide what a test file is: the behavior-adding check (`task-command-router.cts`) and
 * the RED-commit pathspec in `workflows/execute-phase.md`. They were separate lists, so the pathspec
 * learned the Go / Elixir / RSpec / pytest names in #4715 while the router never did, and a task
 * listing only `placement_test.go` was classified behavior-adding — the gate then asked for a RED
 * commit for the task that IS the RED commit.
 *
 * `TEST_FILE_GLOBS` is the list; `TEST_FILE_PATHSPECS` is its git-pathspec spelling, which is what
 * the workflow passes to `evaluation-scope --pathspec`. `isTestFilePath` evaluates the same list for
 * a task's `<files>`. A test pins the workflow's pathspec flags to the derived array, so the two
 * cannot drift apart again.
 */

/**
 * The bare names of the shared list. Each is the `<name>` of a git pathspec spelled
 * `:(glob,icase)**\/<name>`: `**\/` matches at any depth (root included), `*` stays inside one
 * path segment, and `icase` matches case-insensitively, so git reads each entry the way
 * `isTestFilePath` does. A `/**` tail names a directory; any other entry is a file glob matched
 * against the basename.
 */
export const TEST_FILE_GLOBS = [
  '*.test.*', '*.spec.*', 'tests/**', 'test/**', '__tests__/**',
  '*_test.go', 'test_*.py', '*_test.py', '*_test.exs', '*_spec.rb', '*_test.rb',
] as const;

const GLOB_DEPTH_PREFIX = ':(glob,icase)**/';
const DIRECTORY_TAIL = '/**';

/** Git-pathspec spelling of {@link TEST_FILE_GLOBS}, as the workflow passes it. */
export const TEST_FILE_PATHSPECS: readonly string[] =
  TEST_FILE_GLOBS.map((glob) => `${GLOB_DEPTH_PREFIX}${glob}`);

/** Directory names a `<files>` entry may sit under, from the directory globs above. */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set(
  TEST_FILE_GLOBS.filter((glob) => glob.endsWith(DIRECTORY_TAIL)).map(
    (glob) => glob.slice(0, -DIRECTORY_TAIL.length),
  ),
);

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** A basename glob where `*` is any run of non-separator characters. */
const FILE_GLOBS: readonly RegExp[] = TEST_FILE_GLOBS
  .filter((glob) => !glob.endsWith(DIRECTORY_TAIL))
  .map((glob) => glob.split('*').map(escapeRegex).join('[^/]*'))
  .map((source) => new RegExp(`^${source}$`, 'i'));

/** True when `file` (either separator) is a test file by the shared convention list. */
export function isTestFilePath(file: string): boolean {
  const segments = file.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (FILE_GLOBS.some((glob) => glob.test(base))) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
