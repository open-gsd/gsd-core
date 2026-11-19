"use strict";
/**
 * Keep a machine-local file out of `git status` without touching any tracked
 * file: append an anchored entry to the enclosing repo's `info/exclude` (#5551).
 *
 * Used for files GSD writes under `.planning/` that are per-machine state, not
 * project content (the milestone claim). A copy that is already tracked is left
 * alone — an exclude entry never untracks, and migrating it is the user's call.
 *
 * Best-effort by contract: never throws. Ignoring is optional, so no failure
 * here (no git, read-only `.git`, odd path) may perturb the caller.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.excludeFromGit = excludeFromGit;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const text_lines_cjs_1 = require("./text-lines.cjs");
/** Escape gitignore metacharacters so a directory or file name matches literally. */
function escapeGitignore(s) {
    return s.replace(/[\\*?[]/g, '\\$&');
}
/**
 * Exclude `<dir>/<filename>` from git via the repo-local `info/exclude`.
 * `dir` must already exist (it is the spawn cwd).
 */
function excludeFromGit(dir, filename) {
    try {
        // gitignore cannot express a newline in a pattern, and git's line output could not be split.
        if (/[\r\n]/.test(dir))
            return;
        // The prefix goes last: stdout is trimmed, and a non-empty prefix ends in `/`, so only an
        // empty prefix (dir is the git root) loses its line; a leading space survives.
        const revParse = (0, shell_command_projection_cjs_1.execGit)(['rev-parse', '--git-path', 'info/exclude', '--show-prefix'], { cwd: dir });
        const [excludeRel, prefix = ''] = (0, text_lines_cjs_1.splitLines)(String(revParse.stdout));
        if (revParse.exitCode !== 0 || !excludeRel)
            return;
        const exclude = node_path_1.default.resolve(dir, excludeRel);
        const entry = `/${escapeGitignore(prefix)}${escapeGitignore(filename)}`;
        const existing = node_fs_1.default.existsSync(exclude) ? node_fs_1.default.readFileSync(exclude, 'utf8') : '';
        if ((0, text_lines_cjs_1.splitLines)(existing).includes(entry))
            return;
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(exclude), { recursive: true });
        node_fs_1.default.appendFileSync(exclude, (existing && !existing.endsWith('\n') ? '\n' : '') + entry + '\n');
    }
    catch {
        // advisory: see the module header.
    }
}
