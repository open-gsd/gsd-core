/**
 * Tool-owned `.gsd/` directory owner (#5757).
 *
 * gsd-core keeps small tool state under `<project>/.gsd/` (the dispatch
 * isolation sentinel, the harness fork-probe cache). A user project does not
 * inherit gsd-core's own root `.gitignore`, and the project may contain a
 * `.gsd` symlink, so every writer needs the same two guarantees before it
 * writes anything there:
 *
 *   1. the directory is a real directory that resolves inside the project
 *      (never write through a project-supplied symlink or ancestor redirect);
 *   2. the directory is ignored by git (`.gsd/.gitignore`), without clobbering
 *      rules a user already put there.
 *
 * This module is the single owner of both. Callers pass their own ignore-file
 * `marker` comment and the `rules` they need; the owner appends only the rules
 * that are missing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { retryRenameSync } from './shell-command-projection.cjs';

export interface ToolOwnedGsdDirOptions {
  /** Comment line that introduces the caller's block in `.gsd/.gitignore`. */
  marker: string;
  /** Ignore-file lines the caller needs (whole-line, anchored patterns). */
  rules: readonly string[];
}

const SYMLINK_IGNORE_MESSAGE = '.gsd/.gitignore is a symlink';

/** Stable `code` values on the refusal errors; callers translate by code, never by message. */
export const GSD_DIR_UNSAFE = 'GSD_DIR_UNSAFE';
export const GSD_IGNORE_SYMLINK = 'GSD_IGNORE_SYMLINK';

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasLine(text: string, line: string): boolean {
  return text.split('\n').some((l) => l.replace(/\r$/, '') === line);
}

/**
 * Pure merge: the text to append to an existing ignore file so that `marker`
 * and every rule are present, or '' when nothing is missing. A file that
 * already ignores everything (`*` line) needs nothing.
 */
export function ignoreAdditions(current: string, { marker, rules }: ToolOwnedGsdDirOptions): string {
  if (hasLine(current, '*')) return '';
  const missing = rules.filter((rule) => !hasLine(current, rule));
  if (missing.length === 0) return '';
  const lead = current === '' || current.endsWith('\n') ? '' : '\n';
  const markerLine = current.includes(marker) ? '' : `${marker}\n`;
  return `${lead}${markerLine}${missing.join('\n')}\n`;
}

function isLinkError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return !!e && (e.code === 'ELOOP' || e.message === SYMLINK_IGNORE_MESSAGE);
}

function mergeExistingIgnore(ignorePath: string, options: ToolOwnedGsdDirOptions): void {
  let fd: number | undefined;
  let tmpPath: string | null = null;
  try {
    if (fs.lstatSync(ignorePath).isSymbolicLink()) throw new Error(SYMLINK_IGNORE_MESSAGE);
    // Read through an fd opened without following links where supported
    // (O_NOFOLLOW is absent on Windows, hence `|| 0`), then replace by rename
    // rather than append through the path, so a link swapped in after the
    // check cannot redirect a write elsewhere.
    fd = fs.openSync(ignorePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) throw new Error('.gsd/.gitignore is not a regular file');
    const current = fs.readFileSync(fd, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
    const additions = ignoreAdditions(current, options);
    if (additions === '') return;
    // `tmpPath` is assigned only once the exclusive create succeeded, so an
    // EEXIST never unlinks an entry this process did not create.
    const candidateTmp = `${ignorePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const tmpFd = fs.openSync(candidateTmp, 'wx');
    tmpPath = candidateTmp;
    try {
      fs.writeFileSync(tmpFd, current + additions);
    } finally {
      fs.closeSync(tmpFd);
    }
    if (fs.lstatSync(ignorePath).isSymbolicLink()) throw new Error(SYMLINK_IGNORE_MESSAGE);
    retryRenameSync(tmpPath, ignorePath);
    tmpPath = null;
  } catch (err) {
    if (isLinkError(err)) throw codedError(SYMLINK_IGNORE_MESSAGE, GSD_IGNORE_SYMLINK);
    // Ignore seeding is best-effort; the caller's state is still useful if
    // this path cannot be read or updated.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Ensure `<cwd>/.gsd` exists as a real, project-contained, git-ignored
 * directory and return its path. Throws when `.gsd` is a symlink, resolves
 * outside the project, or `.gsd/.gitignore` is a symlink.
 */
export function ensureToolOwnedGsdDir(cwd: string, options: ToolOwnedGsdDirOptions): string {
  const dir = path.join(cwd, '.gsd');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink() ||
      path.relative(fs.realpathSync(cwd), fs.realpathSync(dir)) !== '.gsd') {
    throw codedError('.gsd directory is a symlink or resolves outside the project', GSD_DIR_UNSAFE);
  }
  const ignorePath = path.join(dir, '.gitignore');
  try {
    fs.writeFileSync(ignorePath, '*\n', { flag: 'wx' });
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') mergeExistingIgnore(ignorePath, options);
    // Any other ignore-file IO failure must not prevent the caller's write.
  }
  return dir;
}
