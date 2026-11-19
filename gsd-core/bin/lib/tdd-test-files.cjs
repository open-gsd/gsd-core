"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEST_FILE_PATHSPECS = void 0;
exports.isTestFilePath = isTestFilePath;
/** Git-pathspec spelling. A trailing `/` is a directory, anything else a basename glob. */
exports.TEST_FILE_PATHSPECS = [
    '*.test.*', '*.spec.*', 'tests/', '__tests__/',
    '*_test.go', 'test_*.py', '*_test.py', '*_test.exs', '*_spec.rb', '*_test.rb',
];
/** Directory names a `<files>` entry may sit under. `test/` is the singular spelling many projects use. */
const TEST_DIRECTORY_NAMES = new Set([
    ...exports.TEST_FILE_PATHSPECS.filter((spec) => spec.endsWith('/')).map((spec) => spec.slice(0, -1)),
    'test',
]);
function escapeRegex(text) {
    return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
/** A basename glob where `*` is any run of non-separator characters. */
const FILE_GLOBS = exports.TEST_FILE_PATHSPECS
    .filter((spec) => !spec.endsWith('/'))
    .map((spec) => new RegExp(`^${spec.split('*').map(escapeRegex).join('[^/]*')}$`, 'i'));
/** True when `file` (either separator) is a test file by the shared convention list. */
function isTestFilePath(file) {
    const segments = file.split(/[\\/]/).filter(Boolean);
    const base = segments[segments.length - 1] ?? '';
    if (FILE_GLOBS.some((glob) => glob.test(base)))
        return true;
    return segments.slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase()));
}
