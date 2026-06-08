/**
 * CLI I/O primitives — output(), error(), ERROR_REASON, JSON-error mode,
 * and the temp-file helpers that output() depends on.
 *
 * Extracted from core.cts (ADR-857 rollout phase 1 / issue #859).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. core.cts re-exports every symbol here under its own
 * `export =` object so existing consumers are unaffected.
 *
 * New imports should pull I/O primitives from io.cjs directly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformWriteSync, platformEnsureDir } from './shell-command-projection.cjs';

// ─── Temp-file helpers (needed by output()) ──────────────────────────────────

/**
 * Dedicated GSD temp directory: path.join(os.tmpdir(), 'gsd').
 * Created on first use. Keeps GSD temp files isolated from the system
 * temp directory so reap scans only GSD files (#1975).
 */
const GSD_TEMP_DIR = path.join(os.tmpdir(), 'gsd');

function ensureGsdTempDir(): void {
  platformEnsureDir(GSD_TEMP_DIR);
}

interface ReapOptions {
  maxAgeMs?: number;
  dirsOnly?: boolean;
}

/**
 * Remove stale gsd-* temp files/dirs older than maxAgeMs (default: 5 minutes).
 * Runs opportunistically before each new temp file write to prevent unbounded accumulation.
 * @param prefix - filename prefix to match (e.g., 'gsd-')
 * @param opts
 * @param opts.maxAgeMs - max age in ms before removal (default: 5 min)
 * @param opts.dirsOnly - if true, only remove directories (default: false)
 */
function reapStaleTempFiles(prefix = 'gsd-', { maxAgeMs = 5 * 60 * 1000, dirsOnly = false }: ReapOptions = {}): void {
  try {
    ensureGsdTempDir();
    const now = Date.now();
    const entries = fs.readdirSync(GSD_TEMP_DIR);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = path.join(GSD_TEMP_DIR, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else if (!dirsOnly) {
            fs.unlinkSync(fullPath);
          }
        }
      } catch {
        // File may have been removed between readdir and stat — ignore
      }
    }
  } catch {
    // Non-critical — don't let cleanup failures break output
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function output(result: unknown, raw: boolean, rawValue?: unknown): void {
  let data: string;
  if (raw && rawValue !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    data = String(rawValue);
  } else {
    const json = JSON.stringify(result, null, 2);
    // Large payloads exceed Claude Code's Bash tool buffer (~50KB).
    // Write to tmpfile and output the path prefixed with @file: so callers can detect it.
    if (json.length > 50000) {
      reapStaleTempFiles();
      ensureGsdTempDir();
      const tmpPath = path.join(GSD_TEMP_DIR, `gsd-${Date.now()}.json`);
      platformWriteSync(tmpPath, json);
      data = '@file:' + tmpPath;
    } else {
      data = json;
    }
  }
  // process.stdout.write() is async when stdout is a pipe — process.exit()
  // can tear down the process before the reader consumes the buffer.
  // fs.writeSync(1, ...) blocks until the kernel accepts the bytes, and
  // skipping process.exit() lets the event loop drain naturally.
  fs.writeSync(1, data);
}

/**
 * Frozen enum of typed reason codes used by error() for structured errors.
 * Each subcommand contributes its own codes; the enum exists so tests can
 * assert against typed values instead of grepping stderr (#2974).
 *
 * Adding a new code:
 *   - Pick a snake_case lowercase value (the JSON wire form)
 *   - Group by subsystem prefix (CONFIG_*, SDK_*, etc)
 *   - Pass it to error(msg, ERROR_REASON.NEW_CODE) at the call site
 */
const ERROR_REASON = Object.freeze({
  // config-get / config-set
  CONFIG_KEY_NOT_FOUND: 'config_key_not_found',
  CONFIG_NO_FILE: 'config_no_file',
  CONFIG_PARSE_FAILED: 'config_parse_failed',
  CONFIG_INVALID_KEY: 'config_invalid_key',
  // SDK / gsd-tools dispatch
  SDK_FAIL_FAST: 'sdk_fail_fast',
  SDK_UNKNOWN_COMMAND: 'sdk_unknown_command',
  SDK_MISSING_ARG: 'sdk_missing_arg',
  // workflow / phase
  PHASE_NOT_FOUND: 'phase_not_found',
  SUMMARY_NO_PLANNING: 'summary_no_planning',
  // graphify
  GRAPHIFY_NO_GRAPH: 'graphify_no_graph',
  GRAPHIFY_INVALID_QUERY: 'graphify_invalid_query',
  // hooks
  HOOKS_OPT_OUT: 'hooks_opt_out',
  // security-scan
  SECURITY_SCAN_FAILED: 'security_scan_failed',
  // generic
  USAGE: 'usage',
  UNKNOWN: 'unknown',
});

type ErrorReasonValue = typeof ERROR_REASON[keyof typeof ERROR_REASON];

/**
 * Process-level flag: when true, error() emits structured JSON to stderr
 * instead of plain "Error: <message>" text. Set by gsd-tools.cjs when the
 * CLI is invoked with `--json-errors`. Tests opt in to typed-IR error
 * assertions by passing that flag and parsing the JSON.
 *
 * Default off so existing callers and human operators keep their plain-text
 * diagnostics. The structured form is opt-in for tooling and tests (#2974).
 */
let _jsonErrorMode = false;
function setJsonErrorMode(v: unknown): void { _jsonErrorMode = !!v; }
function getJsonErrorMode(): boolean { return _jsonErrorMode; }

/**
 * Emit an error and exit. When the second argument is provided it must be
 * a value from ERROR_REASON; tests can assert on `result.reason`. When the
 * process is in JSON-error mode, stderr receives `{ ok: false, reason,
 * message }` so callers can parse it; otherwise stderr keeps the plain
 * text form for human operators.
 */
function error(message: string, reason: ErrorReasonValue = ERROR_REASON.UNKNOWN): never {
  if (_jsonErrorMode) {
    const payload = JSON.stringify({ ok: false, reason, message }) + '\n';
    fs.writeSync(2, payload);
  } else {
    fs.writeSync(2, 'Error: ' + message + '\n');
  }
  process.exit(1);
}

export = {
  GSD_TEMP_DIR,
  ensureGsdTempDir,
  reapStaleTempFiles,
  output,
  ERROR_REASON,
  setJsonErrorMode,
  getJsonErrorMode,
  error,
};
