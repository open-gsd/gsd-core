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
 */

/**
 * Git-pathspec spelling. A `/**` tail (behind `:(glob)**\/`) names a directory at any depth.
 * Any other entry is a file glob: the router reads it against the basename with `*` as a
 * non-separator run, while git matches a bare entry against the whole path with `*` crossing
 * `/`, so git is the wider reader. `:(glob)**\/test_*.py` is basename-only in both.
 */
export const TEST_FILE_PATHSPECS = [
  '*.test.*', '*.spec.*', ':(glob)**/tests/**', ':(glob)**/__tests__/**',
  '*_test.go', ':(glob)**/test_*.py', '*_test.py', '*_test.exs', '*_spec.rb', '*_test.rb',
] as const;

// The `:(glob)` double-star prefix matches at any depth, root included; the matchers below
// read the bare form.
const GLOB_DEPTH_PREFIX = ':(glob)**/';
const DIRECTORY_TAIL = '/**';
const stripGlobDepthPrefix = (spec: string): string =>
  (spec.startsWith(GLOB_DEPTH_PREFIX) ? spec.slice(GLOB_DEPTH_PREFIX.length) : spec);
const isDirectorySpec = (spec: string): boolean =>
  stripGlobDepthPrefix(spec).endsWith(DIRECTORY_TAIL);

/**
 * Directory names a `<files>` entry may sit under. `test/` is the singular spelling many
 * projects use.
 */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ...TEST_FILE_PATHSPECS.filter(isDirectorySpec).map(
    (spec) => stripGlobDepthPrefix(spec).slice(0, -DIRECTORY_TAIL.length),
  ),
  'test',
]);

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** A basename glob where `*` is any run of non-separator characters. */
const FILE_GLOBS: readonly RegExp[] = TEST_FILE_PATHSPECS
  .filter((spec) => !isDirectorySpec(spec))
  .map((spec) => stripGlobDepthPrefix(spec).split('*').map(escapeRegex).join('[^/]*'))
  .map((source) => new RegExp(`^${source}$`, 'i'));

/** True when `file` (either separator) is a test file by the shared convention list. */
export function isTestFilePath(file: string): boolean {
  const segments = file.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (FILE_GLOBS.some((glob) => glob.test(base))) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
