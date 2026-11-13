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
 * abstraction a non-filesystem host swaps in), with one exception (#5120,
 * ADR-4629 guard roster "No raw STATE.md write outside the seam"): a write
 * whose destination is named `STATE.md` holds the STATE.md lock and goes
 * through the STATE.md write seam (`platformWriteSync`), the
 * cmdStateMilestoneSwitch shape, so a host writing through MCP
 * `gsd_write_state` cannot interleave with another STATE.md writer (the
 * #500/#905/#1230 lost-update family). The seam writes LF line endings and
 * one trailing newline, and normalizes spacing where the write changed the
 * document (#5165; a new file is normalized whole), so those bytes are the
 * seam's, not the caller's. An existing STATE.md that is not a regular file
 * (a symlink, live or dangling, a FIFO or a device) is refused with an ENXIO
 * error under the lock and nothing is written (refuseNonRegularStateMd). A
 * path whose directory is missing or is not a directory fails at once with
 * ENOENT or ENOTDIR, and a path ending in a separator with EISDIR, before any
 * lock is attempted (refuseUnwritableStateMdPath).
 * It is an exact-content write under the lock: it runs no sync or
 * preservation pipeline, so it sits outside ADR-3408 section 8.3's closed
 * exception list (the maintainer's call, recorded in the #5120 PR). The
 * first such write also loads state.cjs, which registers its process exit
 * handler for held locks. Every other destination is still written exactly
 * as given. `configHome` write-confinement (ADR-1239 Phase B / #1679)
 * applies to the filesystem path.
 *
 * Minimal seam: the host-backend protocol is fixed when a real non-filesystem
 * host lands (Phase 5 / #1682).
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

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
}

/**
 * #5120: a STATE.md destination is written under the STATE.md lock, through the
 * write seam, the lock-then-platformWriteSync shape of cmdStateMilestoneSwitch
 * (src/state.cts) without its transition: the host's content is written as
 * given, so no sync or preservation pipeline runs (outside ADR-3408 section
 * 8.3's closed exception list; see the module header). Loaded lazily: the
 * lock lives in state.cts, which pulls in most of the engine, and this module
 * is also the SDK's `createStateIO` surface (host-integration-sdk.cts), whose
 * other callers never write STATE.md. The lock wait is acquireStateLock's: a
 * STATE.md held by another live writer makes this write wait, and a lock that
 * cannot be taken throws, so the write never lands.
 */
function writeStateMdThroughSeam(filePath: string, content: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withStateLock } = require('./state.cjs') as { withStateLock: <T>(statePath: string, fn: () => T) => T };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { platformWriteSync } = require('./shell-command-projection.cjs') as { platformWriteSync: (filePath: string, content: string) => void };
  refuseUnwritableStateMdPath(filePath);
  withStateLock(filePath, () => {
    refuseNonRegularStateMd(filePath);
    platformWriteSync(filePath, content);
  });
}

/**
 * #5120 review (M1): an existing STATE.md that is not a regular file (a symlink, live or
 * dangling, a FIFO, a device, a socket, a directory) is refused with an ENXIO error and
 * nothing is written. The seam alone would not refuse it: its atomic path replaces whatever
 * sits at the target by rename (platformWriteSync's docblock), so a symlinked STATE.md came
 * back as a private regular file while the link's real target kept its old bytes. lstat
 * opens nothing, so a FIFO is classified without blocking.
 *
 * Checked under the STATE.md lock, right before the write: every lock-respecting writer is
 * serialized out of the window between this check and the write, which a check before the
 * lock would leave open for the whole lock wait. A process that ignores the lock and swaps a
 * link or FIFO in after the check still meets the seam's rename, which replaces it and never
 * writes through it, so that residual race gives the pre-check behavior, never a write
 * through a link and never a block on a FIFO.
 */
function refuseNonRegularStateMd(filePath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // a new STATE.md: the seam creates it
    throw err;
  }
  // A hard link is refused too (#5120 re-review): the rename would replace this name
  // and detach it from the others, so a shared file silently stops being shared. The
  // seam's direct-write fallback refuses a multiply-linked target for the same reason.
  if (st.isFile() && st.nlink <= 1) return;
  const kind = st.isFile() ? `a hard link with ${st.nlink} names`
    : st.isSymbolicLink() ? 'a symlink'
      : st.isFIFO() ? 'a FIFO'
        : st.isCharacterDevice() || st.isBlockDevice() ? 'a device'
          : st.isSocket() ? 'a socket'
            : st.isDirectory() ? 'a directory'
              : 'a special file';
  throw Object.assign(
    new Error(`ENXIO: cannot write ${filePath}: STATE.md is not a regular file (it is ${kind}); refusing, so nothing is written through or over it`),
    { code: 'ENXIO' },
  );
}

/**
 * #5120 re-review (Major-2): a STATE.md path that no file can be created at fails
 * at once, before the lock. The lock file sits beside STATE.md, so a missing parent
 * directory made acquireStateLock retry ENOENT for its whole 30-second budget, and
 * the MCP server, which handles each tool call synchronously, answered nothing for
 * that time. The errors are the ones a raw write gave: ENOENT or ENOTDIR from the
 * parent directory's stat, and EISDIR for a path ending in a separator (it names a
 * directory, never a file). Nothing is created.
 */
function refuseUnwritableStateMdPath(filePath: string): void {
  if (/[\\/]$/.test(filePath)) {
    throw Object.assign(
      new Error(`EISDIR: cannot write ${filePath}: a path ending in a separator names a directory, not STATE.md`),
      { code: 'EISDIR' },
    );
  }
  const dir = path.dirname(filePath);
  const st = fs.statSync(dir); // ENOENT / ENOTDIR propagate as they are
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: cannot write ${filePath}: ${dir} is not a directory`), { code: 'ENOTDIR' });
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
    // Today's behavior — straight fs. planning-workspace.cts keeps its routing;
    // this is the swap-point a non-filesystem host replaces.
    return Object.freeze({
      io: 'filesystem',
      read(filePath: string) { return fs.readFileSync(filePath, 'utf-8'); },
      write(filePath: string, content: string) {
        // Case-sensitive, like the rest of the STATE.md write path: the engine
        // only ever names it path.join(planningDir, 'STATE.md'), the drift lint
        // matches /STATE\.md/ (targetsStatePath, scripts/lint-state-write-path-drift.cjs)
        // and the test-time guard matches the basename exactly
        // (scripts/raw-state-write-guard.cjs). On a case-insensitive filesystem
        // a host spelling it `state.md` reaches the same file without the lock.
        if (path.basename(filePath) === 'STATE.md') {
          writeStateMdThroughSeam(filePath, content);
          return;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
      },
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
