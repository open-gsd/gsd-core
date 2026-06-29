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
 */
'use strict';

import fs from 'node:fs';

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
      read(path: string) { return fs.readFileSync(path, 'utf-8'); },
      write(path: string, content: string) { fs.writeFileSync(path, content, 'utf-8'); },
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
