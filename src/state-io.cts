/**
 * State IO seam (ADR-1239 Phase C-1, AC4 / #1680).
 *
 * Abstracts `.planning/` + config IO behind the negotiated `stateIO` axis
 * (host-integration.cts):
 *
 *   - `filesystem`           — most hosts: reads/writes under `.planning/` +
 *                              `configHome`. TODAY's behavior. Delegates to fs.
 *   - `sandboxed-storage`    — VS Code web (no arbitrary FS). Seam: a
 *                              host-supplied backend; fail-closed until Phase 5.
 *   - `session-log-append`   — pi (JSONL session log). Seam: host-supplied
 *                              backend; fail-closed until Phase 5.
 *
 * `filesystem` is the default and reproduces today's IO byte-for-behavior
 * (planning-workspace.cts keeps routing its fs ops; this seam is the
 * abstraction a non-filesystem host swaps in). `configHome` write-confinement
 * (ADR-1239 Phase B / #1679) applies to the filesystem path.
 *
 * Minimal seam: the host-backend protocol is fixed when a real non-filesystem
 * host lands (Phase 5 / #1682).
 *
 * #6146: the `filesystem` adapter is confined to a `.planning/` root the caller
 * binds with `{ root }`. Every read and write goes through `confineStatePath`
 * (the same predicate the MCP dispatch calls first), then opens the confined
 * path with `O_NOFOLLOW` and re-checks the opened file descriptor, so neither
 * the dispatch nor the adapter can drift from the other. An adapter built with
 * no `root` fails closed, like an unbound non-filesystem backend.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { PathAcceptance, tryWithinRoot, tryWithinRootLexical, type ContainedPath } from './security.cjs';

export type StateIOMode = 'filesystem' | 'sandboxed-storage' | 'session-log-append';

export interface StateIOAdapter {
  readonly io: StateIOMode;
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface StateIOBackend {
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface CreateStateIOOptions {
  /** Required for non-filesystem modes: the host's storage backend. */
  backend?: StateIOBackend;
  /**
   * Required for `filesystem` mode (#6146): the project's `.planning/`
   * directory. Every read and write must resolve inside it.
   */
  root?: string;
}

/** The boundary every refusal names (#6146 "isError naming the boundary"). */
export const STATE_ROOT_BOUNDARY = 'the project .planning/ root';

function refuse(label: string, reason: string): never {
  // Fixed texts only: no absolute path of the root or of the target is echoed,
  // so an existing and an absent outside target produce the same message.
  throw new Error(`${label} refused: ${reason}; state paths must resolve inside ${STATE_ROOT_BOUNDARY}`);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Confine one state path to `root` (the project `.planning/` directory) — #6146.
 *
 * Rejection, never normalization: the candidate must already be an absolute
 * path inside `root`; it is never rewritten into the root. Checks, in order:
 *
 *   1. a non-empty string with no NUL byte, absolute (relative paths are refused);
 *   2. LEXICAL containment (`tryWithinRootLexical`) — `..`, a sibling sharing the
 *      root's name prefix, the bare parent, and an outside alias that symlinks
 *      INTO the root are refused; the root itself is refused (not a state file);
 *   3. the root exists, is a directory, and is NOT itself a symbolic link (a
 *      symlinked `.planning` would redirect the whole confinement);
 *   4. every existing component below the root: a dangling symbolic link is
 *      refused (a write would follow it out of the root);
 *   5. REALPATH containment of the deepest existing ancestor (`tryWithinRoot`) —
 *      a symlinked file, directory or chain that leaves the root is refused;
 *   6. the parent directory exists (the adapter never creates directories);
 *   7. an existing target is a regular file with exactly one link (a hard link
 *      to an outside inode is refused).
 *
 * Returns the realpath-resolved target. Throws an Error whose text names the
 * boundary and carries no absolute path.
 */
export function confineStatePath(candidate: unknown, root: unknown, label = 'state path'): ContainedPath {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) {
    refuse(label, 'no absolute .planning/ root is bound');
  }
  if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\0')) {
    refuse(label, 'the path must be a non-empty string with no NUL byte');
  }
  if (!path.isAbsolute(candidate)) {
    refuse(label, 'the path must be absolute (relative paths are not resolved)');
  }
  if (/[\\/]$/.test(candidate)) refuse(label, 'the path names a directory');
  const rootResolved = path.resolve(root);
  const lexical = tryWithinRootLexical(candidate, rootResolved);
  if (lexical === null) refuse(label, 'the path is outside the root');
  if (lexical === rootResolved) refuse(label, 'the path names the root directory itself');

  const rootStat = lstatOrNull(rootResolved);
  if (rootStat === null) refuse(label, 'the .planning/ root does not exist');
  if (rootStat.isSymbolicLink()) refuse(label, 'the .planning/ root is a symbolic link');
  if (!rootStat.isDirectory()) refuse(label, 'the .planning/ root is not a directory');

  // Walk the components below the root (lexically). Stop at the first absent one.
  const rel = path.relative(rootResolved, lexical).split(path.sep);
  let cursor = rootResolved;
  let parentExists = true;
  for (let i = 0; i < rel.length; i++) {
    cursor = path.join(cursor, rel[i]);
    const st = lstatOrNull(cursor);
    if (st === null) {
      if (i < rel.length - 1) parentExists = false;
      break;
    }
    if (st.isSymbolicLink()) {
      try {
        fs.realpathSync(cursor);
      } catch {
        refuse(label, 'the path goes through a dangling symbolic link');
      }
    }
  }

  const real = tryWithinRoot(lexical, rootResolved, PathAcceptance.AbsoluteInsideRoot);
  if (real === null) refuse(label, 'the path resolves outside the root');
  if (!parentExists) refuse(label, 'the parent directory does not exist');

  const targetStat = lstatOrNull(real);
  if (targetStat !== null) {
    if (!targetStat.isFile()) refuse(label, 'the path is not a regular file');
    if (targetStat.nlink > 1) refuse(label, 'the file has more than one hard link');
  }
  return real;
}

// O_NOFOLLOW is undefined on Windows; there the lstat checks above stand alone.
const O_NOFOLLOW: number = fs.constants.O_NOFOLLOW ?? 0;

/** Re-check the opened descriptor against the confined path (narrows check-then-open). */
function verifyOpened(fd: number, real: string, label: string): void {
  const st = fs.fstatSync(fd);
  if (!st.isFile()) refuse(label, 'the opened path is not a regular file');
  if (st.nlink > 1) refuse(label, 'the opened file has more than one hard link');
  let again: string;
  try {
    again = fs.realpathSync(real);
  } catch {
    refuse(label, 'the path changed while it was being opened');
  }
  const lst = lstatOrNull(again);
  if (again !== real || lst === null || lst.ino !== st.ino || lst.dev !== st.dev) {
    refuse(label, 'the path changed while it was being opened');
  }
}

function fsError(label: string, e: unknown): never {
  if (e instanceof Error && /refused: /.test(e.message)) throw e;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  // Errno text from fs embeds the absolute path; report only the code.
  throw new Error(`${label} failed: ${code || 'I/O error'}`);
}

function confinedRead(root: string, p: string): string {
  const label = 'filesystem stateIO read';
  const real = confineStatePath(p, root, label);
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    fsError(label, e);
  }
  try {
    verifyOpened(fd, real, label);
    return fs.readFileSync(fd, 'utf-8');
  } catch (e) {
    fsError(label, e);
  } finally {
    fs.closeSync(fd);
  }
}

function confinedWrite(root: string, p: string, content: string): void {
  const label = 'filesystem stateIO write';
  const real = confineStatePath(p, root, label);
  const existed = lstatOrNull(real) !== null;
  // A new file is created exclusively (never through a link swapped in later);
  // an existing one is opened without O_TRUNC and truncated only after the
  // descriptor is re-verified.
  const flags = fs.constants.O_WRONLY | O_NOFOLLOW | (existed ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  let fd: number;
  try {
    fd = fs.openSync(real, flags, 0o666);
  } catch (e) {
    fsError(label, e);
  }
  try {
    verifyOpened(fd, real, label);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf-8');
  } catch (e) {
    fsError(label, e);
  } finally {
    fs.closeSync(fd);
  }
}

export function createStateIO(
  { io }: { io: StateIOMode },
  options: CreateStateIOOptions = {},
): StateIOAdapter {
  if (io !== 'filesystem' && io !== 'sandboxed-storage' && io !== 'session-log-append') {
    throw new TypeError(`createStateIO: io must be 'filesystem' | 'sandboxed-storage' | 'session-log-append' (got ${JSON.stringify(io)})`);
  }
  if (io === 'filesystem') {
    // planning-workspace.cts keeps its own routing; this is the swap-point a
    // non-filesystem host replaces. #6146: confined to the bound `.planning/`
    // root; with no root bound, every call fails closed.
    const root = options.root;
    return Object.freeze({
      io: 'filesystem',
      read(p: string) { return confinedRead(root as string, p); },
      write(p: string, content: string) { confinedWrite(root as string, p, content); },
    });
  }
  // sandboxed-storage / session-log-append: host backend, fail-closed until bound.
  const backend = options.backend;
  const unbound = (): never => {
    throw new Error(
      `${io} stateIO: no host backend bound — non-filesystem state requires a backend (Phase 5 wires the concrete host).`,
    );
  };
  if (!backend || typeof backend.read !== 'function' || typeof backend.write !== 'function') {
    return Object.freeze({ io, read: unbound, write: unbound });
  }
  return Object.freeze({
    io,
    read(path: string) { return backend.read(path); },
    write(path: string, content: string) { backend.write(path, content); },
  });
}
