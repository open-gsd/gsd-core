/**
 * Config File Read — the single bounded reader for a project or workstream config.json (#5759)
 *
 * A config.json can be planted as a FIFO or device: a plain readFileSync opens it
 * blocking and waits forever for a writer. Every read of a config.json in src/ goes through
 * `readConfigFileBounded`, so the loader, the resolve-model omit check, and the many
 * direct "read one key" helpers cannot diverge on how a non-regular or oversized file is treated.
 *
 * Leaf module: it imports only ./capability-ledger.cjs (itself a node-builtins-only leaf), so
 * planning-workspace, config-loader and every other reader can import it without a require cycle.
 *
 * Dependencies (leaf modules only):
 *   - ./capability-ledger.cjs (readSmallRegularFile — non-blocking open, fstat regular-file check, size cap)
 */

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

export = {
  CONFIG_MAX_BYTES,
  readConfigFileBounded,
};
