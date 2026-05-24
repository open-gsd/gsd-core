'use strict';

/**
 * DispatchLogger interface + default implementation — issue #177 (ADR-0174 P1.3).
 *
 * Interface:
 *   { onEvent(event: DispatchEvent): void }
 *
 * Default behaviour (createDefaultLogger):
 *   1. Silent on success — no stdout/stderr when result.kind === 'ok'.
 *   2. Structured JSON to stderr on error — one line per dispatch error.
 *   3. Opt-in audit file — when GSD_AUDIT=1 OR config.audit.enabled===true,
 *      appends every event (success + error) as one JSON line to
 *      .planning/.gsd-trace.jsonl relative to `cwd`. Creates .planning/ if absent.
 *   4. Args redaction — args omitted by default; included when GSD_AUDIT_ARGS=1.
 *
 * No-op logger (createNoOpLogger):
 *   Silent on all events. Used as the Hub default when no logger is injected.
 */

const fs = require('fs');
const path = require('path');

const { redactEvent, shouldIncludeArgs } = require('./redaction.cjs');

const AUDIT_FILE_NAME = '.gsd-trace.jsonl';
const PLANNING_DIR = '.planning';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely serialise a value to JSON, falling back to a placeholder on circular refs.
 * @param {unknown} value
 * @returns {string}
 */
function _safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _serializationError: true });
  }
}

/**
 * Determine whether the audit file should be written to.
 *
 * @param {{ audit?: { enabled?: boolean } } | undefined} config
 * @returns {boolean}
 */
function _isAuditEnabled(config) {
  if (process.env.GSD_AUDIT === '1') return true;
  if (config && config.audit && config.audit.enabled === true) return true;
  return false;
}

/**
 * Build the redacted plain object for the audit file.
 * Preserves the full DispatchEvent structure.
 *
 * @param {object} event - DispatchEvent
 * @returns {object}
 */
function _toAuditRecord(event) {
  return redactEvent(event);
}

/**
 * Build the flattened stderr error line.
 *
 * Per ADR-0174 P1.3 contract: { "kind": "<variant>", "traceId": "<uuid>", ...typedPayload }
 * The result's kind is promoted to top-level and the typed payload fields are spread in.
 * The `result` wrapper is removed.
 *
 * @param {object} event - DispatchEvent with an error result
 * @returns {object}
 */
function _toStderrRecord(event) {
  const redacted = redactEvent(event);
  const { result, ...eventWithoutResult } = redacted;
  // Flatten: top-level gets kind + typed payload fields from result
  const { kind, ...typedPayload } = result;
  return Object.assign({}, eventWithoutResult, { kind }, typedPayload);
}

/**
 * Append one JSON line to the audit file.
 * Creates .planning/ directory if it does not exist.
 *
 * Uses synchronous fs API (crash-safe for v1 — dispatch is synchronous).
 *
 * @param {string} cwd - Project root directory.
 * @param {object} event - Redacted DispatchEvent.
 */
function _appendAuditLine(cwd, event) {
  const planningDir = path.join(cwd, PLANNING_DIR);
  // Ensure the directory exists
  if (!fs.existsSync(planningDir)) {
    fs.mkdirSync(planningDir, { recursive: true });
  }
  const auditPath = path.join(planningDir, AUDIT_FILE_NAME);
  fs.appendFileSync(auditPath, _safeStringify(event) + '\n', 'utf8');
}

// ─── Public factories ─────────────────────────────────────────────────────────

/**
 * Create a no-op logger. All events are silently dropped.
 * This is the Hub's default when no logger is injected by the caller.
 *
 * @returns {{ onEvent(event: object): void }}
 */
function createNoOpLogger() {
  return {
    onEvent(_event) {
      // intentionally empty
    },
  };
}

/**
 * Create the default DispatchLogger.
 *
 * @param {object} [opts]
 * @param {string}  [opts.cwd=process.cwd()] - Project root; audit file is written relative to this.
 * @param {object}  [opts.config]             - GSD config object. config.audit.enabled triggers audit.
 * @returns {{ onEvent(event: object): void }}
 */
function createDefaultLogger({ cwd = process.cwd(), config } = {}) {
  return {
    /**
     * @param {object} event - A DispatchEvent from the Hub.
     */
    onEvent(event) {
      const isOk = event && event.result && event.result.kind === 'ok';

      // ── Audit file (both ok and error) ────────────────────────────────────
      if (_isAuditEnabled(config)) {
        try {
          const auditRecord = _toAuditRecord(event);
          _appendAuditLine(cwd, auditRecord);
        } catch (auditErr) {
          // Audit errors must not surface to callers
          process.stderr.write(
            _safeStringify({
              level: 'warn',
              source: 'DispatchLogger',
              message: 'audit file write failed: ' + String(auditErr && auditErr.message || auditErr),
            }) + '\n'
          );
        }
      }

      // ── Stderr on error ───────────────────────────────────────────────────
      if (!isOk) {
        try {
          const stderrRecord = _toStderrRecord(event);
          process.stderr.write(_safeStringify(stderrRecord) + '\n');
        } catch (stderrErr) {
          // Last-resort: we cannot throw from the logger
          process.stderr.write(
            _safeStringify({
              level: 'warn',
              source: 'DispatchLogger',
              message: 'stderr emit failed: ' + String(stderrErr && stderrErr.message || stderrErr),
            }) + '\n'
          );
        }
      }
      // ── Silent on success (no else branch needed) ─────────────────────────
    },
  };
}

module.exports = { createDefaultLogger, createNoOpLogger };
