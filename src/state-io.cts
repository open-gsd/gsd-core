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
 * #500/#905/#1230 lost-update family). The seam normalizes the markdown it
 * writes, so those bytes are the seam's, not the caller's; every other
 * destination is still written exactly as given. `configHome`
 * write-confinement (ADR-1239 Phase B / #1679) applies to the filesystem path.
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
 * write seam, like cmdStateMilestoneSwitch (src/state.cts). Loaded lazily: the
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
  withStateLock(filePath, () => platformWriteSync(filePath, content));
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
