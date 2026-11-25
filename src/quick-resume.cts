/**
 * Quick-task resume lookup (#6530, part 1: the `init.quick --resume` id and
 * slug fix, split from the `TASK.json` schema-2 / `executed_head` re-entry).
 * `/gsd-quick resume <slug>` used to glob `*-<slug>` (first listed wins) and
 * ran `init.quick` with no slug, minting a fresh clock id. `resolveQuickResume`
 * finds the one directory named `<quick_id>-<slug>` (or legacy
 * `YYYYMMDD-<slug>`) and returns that task's own ids; it never allocates an id
 * and never writes. Not here yet (they need `TASK.json`, #6533 / ADR-6178):
 * `task_json`, `task_json_error`, `executed_head_reachable`, `modes`, and the
 * mode-flag check against the recorded modes.
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/quick-resume.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isFlagToken } from './command-arg-projection.cjs';
import { collectSections } from './markdown-sectionizer.cjs';
import type { HeadingToken } from './markdown-sectionizer.cjs';
import { parseMarkdownTable, matchTableSchema } from './markdown-table.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6530 CJS interop import, as in the sibling modules
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6530 CJS interop import, as in the sibling modules
import coreUtils = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6530 CJS interop import, as in the sibling modules
import quickBatch = require('./quick-batch.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6530 CJS interop import, as in the sibling modules
import auditMod = require('./audit.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6530 CJS interop import, as in the sibling modules
import io = require('./io.cjs');

const { planningDir, quickDirFrom } = planningWorkspace;
const { resolveQuickTaskSummaryFile } = auditMod;
const { error, ERROR_REASON } = io;
const { toPosixPath } = coreUtils;
const { hasQuickTaskRow } = quickBatch;

// The quick-id grammar `cmdInitQuick` (src/init.cts) allocates, replicated the
// way src/quick-batch.cts replicates it: YYMMDD, a dash, three base-36 chars.
const QUICK_ID_RE = /^\d{6}-[0-9a-z]{3}$/;
// The legacy directory form `YYYYMMDD-<slug>` that commands/gsd/quick.md once
// documented.
const LEGACY_PREFIX_RE = /^\d{8}$/;
// The slug rule commands/gsd/quick.md applies before any lookup: only
// [a-z0-9-], at most 60 characters. `..` and `/` cannot pass it.
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

const RESUME_FAILURE = Object.freeze({
  INVALID_SLUG: 'invalid_slug',
  NOT_FOUND: 'not_found',
  AMBIGUOUS: 'ambiguous',
  UNREADABLE: 'unreadable',
});

type ResumeFailureReason = (typeof RESUME_FAILURE)[keyof typeof RESUME_FAILURE];

interface QuickResumeMatch {
  ok: true;
  /** The task's quick id, or null for a legacy `YYYYMMDD-<slug>` directory. */
  quick_id: string | null;
  slug: string;
  /** The directory name's id prefix: the quick id, or the 8-digit date for a legacy directory. */
  id_prefix: string;
  dir_name: string;
  /** Absolute, POSIX separators (same form as `cmdInitQuick`'s `task_dir`). */
  task_dir: string;
  legacy: boolean;
  resume: {
    has_plan: boolean;
    has_summary: boolean;
    state_row: boolean;
  };
}

interface QuickResumeFailure {
  ok: false;
  reason: ResumeFailureReason;
  /** Sorted candidate directory names when `reason` is `ambiguous`. */
  matches?: string[];
  /** The filesystem error code when `reason` is `unreadable`. */
  code?: string;
}

type QuickResumeResult = QuickResumeMatch | QuickResumeFailure;

/** The id prefix a directory name carries for `slug`, or null when it is not that task's directory. */
function idPrefixFor(dirName: string, slug: string): { prefix: string; legacy: boolean } | null {
  const suffix = '-' + slug;
  if (!dirName.endsWith(suffix)) return null;
  const prefix = dirName.slice(0, dirName.length - suffix.length);
  if (QUICK_ID_RE.test(prefix)) return { prefix, legacy: false };
  if (LEGACY_PREFIX_RE.test(prefix)) return { prefix, legacy: true };
  return null;
}

// A plan file under the same rule `resolveQuickTaskSummaryFile` (src/audit.cts)
// applies to summaries: `PLAN.md`, or any `*-PLAN.md`.
function hasPlanFile(taskDir: string): boolean {
  try {
    return fs.readdirSync(taskDir, { withFileTypes: true })
      .some((e) => e.isFile() && (e.name === 'PLAN.md' || e.name.endsWith('-PLAN.md')));
  } catch {
    return false;
  }
}

const QUICK_TASKS_HEADING_RE = /^quick tasks completed\b/i;

/**
 * `hasQuickTaskRow` (src/quick-batch.cts) for a legacy directory: the same
 * section and table resolution, and the row must also name `dirName` in its
 * `Directory` cell, as a whole `[0-9a-z-]` run (so `x-fix` never matches
 * `x-fix-login`). A legacy row's `#` is only its date, which two tasks from
 * the same day share. A `—` or empty cell is no answer, so false.
 */
function hasLegacyQuickTaskRow(stateContent: string, datePrefix: string, dirName: string): boolean {
  if (!stateContent) return false;
  const sections = collectSections(stateContent, (h: HeadingToken) => QUICK_TASKS_HEADING_RE.test(h.text.trim()));
  for (const section of sections) {
    const parsed = parseMarkdownTable(section.body);
    if (!parsed.ok) continue;
    const schema = matchTableSchema(parsed.value.columns);
    if (!schema || schema.id !== 'QuickTasks') continue;
    for (const row of parsed.value.rows) {
      if (row['#'] !== datePrefix) continue;
      if (String(row['Directory'] ?? '').split(/[^0-9a-z-]+/).includes(dirName)) return true;
    }
  }
  return false;
}

function readStateContent(cwd: string): string {
  try {
    return fs.readFileSync(path.join(planningDir(cwd), 'STATE.md'), 'utf-8');
  } catch {
    return '';
  }
}

function resolveQuickResume(cwd: string, slug: string): QuickResumeResult {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return { ok: false, reason: RESUME_FAILURE.INVALID_SLUG };
  }

  const quickDir = quickDirFrom(planningDir(cwd));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(quickDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: RESUME_FAILURE.NOT_FOUND };
    }
    return { ok: false, reason: RESUME_FAILURE.UNREADABLE, code: code || 'UNKNOWN' };
  }

  // Real directories only: a file, or a symlink, named like a task is not a task.
  const matches: Array<{ name: string; prefix: string; legacy: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = idPrefixFor(entry.name, slug);
    if (id) matches.push({ name: entry.name, ...id });
  }

  if (matches.length === 0) return { ok: false, reason: RESUME_FAILURE.NOT_FOUND };
  if (matches.length > 1) {
    return { ok: false, reason: RESUME_FAILURE.AMBIGUOUS, matches: matches.map((m) => m.name).sort() };
  }

  const match = matches[0];
  const taskDir = path.join(quickDir, match.name);
  const quickId = match.legacy ? null : match.prefix;
  return {
    ok: true,
    quick_id: quickId,
    slug,
    id_prefix: match.prefix,
    dir_name: match.name,
    task_dir: toPosixPath(taskDir),
    legacy: match.legacy,
    resume: {
      has_plan: hasPlanFile(taskDir),
      has_summary: resolveQuickTaskSummaryFile(taskDir, match.name) !== null,
      // The STATE.md row is keyed by the id prefix: the quick id, or a legacy
      // directory's date prefix (gsd-core/workflows/quick.md Step 2). Two
      // legacy tasks of one day share that date, so a legacy row must also
      // name this directory.
      state_row: match.legacy
        ? hasLegacyQuickTaskRow(readStateContent(cwd), match.prefix, match.name)
        : hasQuickTaskRow(readStateContent(cwd), match.prefix),
    },
  };
}

/**
 * `resolveQuickResume` for the `init.quick --resume` call site: a failure ends
 * the command with a typed reason, and the plain-text message names every
 * candidate itself, since the shipped `/gsd-quick resume` call does not ask
 * for `--json-errors`.
 */
function resolveQuickResumeOrExit(cwd: string, slug: string): QuickResumeMatch {
  const result = resolveQuickResume(cwd, slug);
  if (result.ok) return result;
  switch (result.reason) {
    case RESUME_FAILURE.INVALID_SLUG:
      return error(
        `init.quick --resume: invalid slug ${JSON.stringify(slug)}; a slug is 1-60 characters of a-z, 0-9 and "-"`,
        ERROR_REASON.USAGE,
      );
    case RESUME_FAILURE.NOT_FOUND:
      return error(`No quick task found with slug: ${slug}`, ERROR_REASON.QUICK_RESUME_NOT_FOUND, { slug });
    case RESUME_FAILURE.AMBIGUOUS: {
      const matches = result.matches ?? [];
      return error(
        `Quick task slug "${slug}" matches ${matches.length} task directories: ${matches.join(', ')}. ` +
          'Rename or archive all but one, then resume again.',
        ERROR_REASON.QUICK_RESUME_AMBIGUOUS,
        { slug, matches },
      );
    }
    default:
      return error(
        `init.quick --resume: cannot read the quick task directory (${result.code ?? 'unknown error'})`,
        ERROR_REASON.UNKNOWN,
        { code: result.code ?? null },
      );
  }
}

/**
 * Splits `init quick` argv (after `init quick`) into the `--resume` occurrences
 * and the remaining description tokens. `parseNamedArgsOrExit` reads only the
 * first occurrence of a flag, so the count is what lets the router refuse a
 * second `--resume` (in either form) instead of silently taking the first.
 * A bare `--resume` consumes the next token as its value unless that token is
 * flag-shaped, matching the parser seam.
 */
function splitQuickResumeArgs(tokens: string[]): { resumeCount: number; descriptionTokens: string[] } {
  let resumeCount = 0;
  const descriptionTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--resume') {
      resumeCount++;
      const next = tokens[i + 1];
      if (next !== undefined && !isFlagToken(next)) i++;
      continue;
    }
    if (tok.startsWith('--resume=')) {
      resumeCount++;
      continue;
    }
    descriptionTokens.push(tok);
  }
  return { resumeCount, descriptionTokens };
}

/**
 * The `init quick` argv rules `parseNamedArgsOrExit` cannot state: one
 * `--resume` at most, and no description beside it.
 */
function assertQuickResumeArgs(resumeCount: number, description: string): void {
  if (resumeCount > 1) error('init quick: --resume given more than once', ERROR_REASON.USAGE);
  if (resumeCount > 0 && description !== '') {
    error('init quick: --resume takes no description; the task is named by its slug', ERROR_REASON.USAGE);
  }
}

export = {
  assertQuickResumeArgs,
  RESUME_FAILURE,
  resolveQuickResume,
  resolveQuickResumeOrExit,
  splitQuickResumeArgs,
};
