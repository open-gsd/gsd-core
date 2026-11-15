/**
 * Config File Read — the single bounded reader for a project or workstream config.json (#5759)
 *
 * A config.json can be planted as a FIFO or device: a plain readFileSync opens it
 * blocking and waits forever for a writer. Every read of a config.json in src/ goes through
 * `readConfigFileBounded`, so the loader, the resolve-model omit check, and the many
 * direct "read one key" helpers cannot diverge on how a non-regular or oversized file is treated.
 *
 * Leaf module: it imports only node:fs and ./capability-ledger.cjs (itself a node-builtins-only leaf), so
 * planning-workspace, config-loader and every other reader can import it without a require cycle.
 *
 * Dependencies (leaf modules only):
 *   - ./capability-ledger.cjs (readSmallRegularFile — non-blocking open, fstat regular-file check, size cap)
 */

import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLedgerMod = require('./capability-ledger.cjs');
const { readSmallRegularFile } = capabilityLedgerMod;

/**
 * Largest config.json any reader will read (#5759). Real configs are a few KB; 1 MiB
 * is generous enough that no legitimate config is refused. A larger file is reported
 * unusable (EFBIG) rather than read whole.
 */
const CONFIG_MAX_BYTES = 1024 * 1024;

/**
 * Read a config.json as a bounded regular file (#5759). Opens non-blocking and fstats the
 * fd, so a FIFO or device with no writer is refused instead of blocking open(2) forever.
 * Returns the UTF-8 text, or null when the file is absent (ENOENT); throws a LedgerIOError
 * carrying `.code` (ENXIO FIFO/device, EISDIR directory, EFBIG over CONFIG_MAX_BYTES, or the
 * errno) for every other condition.
 */
function readConfigFileBounded(filePath: string): string | null {
  return readSmallRegularFile(filePath, CONFIG_MAX_BYTES);
}

/**
 * Why `absPath` — looked up on the REAL file system — must not be read blindly: it exists but is
 * not a regular file (FIFO, device, socket, directory) or is larger than CONFIG_MAX_BYTES.
 * Returns null when it is a regular file within the cap, and also when it cannot be stat'ed
 * (absent, or not on the real file system at all, as with an installer fake-fs adapter), so the
 * caller's own read decides. stat(2) follows links and never opens, so it cannot block. This is
 * the guard for readers that must go through an injected fs seam and so cannot use
 * `readConfigFileBounded`; it is a check-then-read, not the descriptor-bound read. Residual
 * race: the install-fs adapter exposes `openSync`/`readSync` with string flags (no O_NONBLOCK)
 * and no `fstatSync`, so the check cannot be bound to the descriptor that is read; a path
 * swapped for a FIFO between this stat and the adapter's read can still block. Closing that
 * needs `fstatSync` and numeric open flags on the adapter.
 */
function unboundedConfigFileReason(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return 'not a regular file';
    if (st.size > CONFIG_MAX_BYTES) return `larger than ${CONFIG_MAX_BYTES} bytes`;
  } catch { /* absent or not on the real fs — the caller's read decides */ }
  return null;
}

/**
 * A path as printed to a terminal: C0 controls, DEL and C1 controls (general category Cc) become
 * `\xNN`; every other format (Cf), line/paragraph separator (Zl, Zp) and lone-surrogate (Cs)
 * character — zero-width and bidirectional controls, soft hyphen, tag characters — becomes
 * `\uNNNN` (`\u{N...}` above the BMP). A directory
 * name can carry ESC (or a C1 CSI), and a path written to stderr verbatim is a terminal-escape
 * injection through that name.
 */
function printablePath(p: string): string {
  return p.replace(
    new RegExp('[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]', 'gu'),
    (c) => {
      const code = c.codePointAt(0) as number;
      const hex = code.toString(16).padStart(4, '0');
      if (/\p{Cc}/u.test(c)) return `\\x${hex.slice(-2)}`; // C0, DEL, C1 (all <= 0xff)
      return code > 0xffff ? `\\u{${hex}}` : `\\u${hex}`; // format, separator, lone surrogate
    },
  );
}

export = {
  CONFIG_MAX_BYTES,
  readConfigFileBounded,
  unboundedConfigFileReason,
  printablePath,
};
