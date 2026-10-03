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
 *
 * Live-seam gate (resolveDispatchLogger, #4975):
 *   The one opt-in decision both live createHub() seams share. Resolves
 *   `audit.enabled` for the seam's cwd and returns the default logger, or
 *   undefined (inject nothing) when observability is off.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/observability/logger.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';

import { redactEvent } from './redaction.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('../planning-workspace.cjs');
const { readScopedConfigValue } = planningWorkspace;

const AUDIT_FILE_NAME = '.gsd-trace.jsonl';
const PLANNING_DIR = '.planning';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Safely serialise a value to JSON, falling back to a placeholder on circular refs.
 */
function _safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _serializationError: true });
  }
}

/**
 * Determine whether observability is opt-in enabled — via the GSD_AUDIT env var
 * or config.audit.enabled. Exported (#2620) so the live dispatch seam can decide
 * whether to inject the reference logger at all: when observability is off we
 * inject nothing (the Hub stays byte-for-byte silent, preserving the default
 * dispatch output contract, incl. --json-errors); when on, the caller injects
 * createDefaultLogger and gets the stderr-on-error line + opt-in file audit.
 * The live seams reach it through resolveDispatchLogger, which supplies the
 * project config — called bare, only the env var is seen (#4975).
 */
function _isAuditEnabled(config?: { audit?: { enabled?: boolean } }): boolean {
  if (process.env['GSD_AUDIT'] === '1') return true;
  if (config && config.audit && config.audit.enabled === true) return true;
  return false;
}

/**
 * Build the redacted plain object for the audit file.
 * Preserves the full DispatchEvent structure.
 */
function _toAuditRecord(event: Record<string, unknown>): Record<string, unknown> {
  return redactEvent(event);
}

/**
 * Build the flattened stderr error line.
 *
 * Per ADR-0174 P1.3 contract: { "kind": "<variant>", "traceId": "<uuid>", ...typedPayload }
 * The result's kind is promoted to top-level and the typed payload fields are spread in.
 * The `result` wrapper is removed.
 */
function _toStderrRecord(event: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactEvent(event);
  const { result, ...eventWithoutResult } = redacted;
  // Flatten: top-level gets kind + typed payload fields from result
  const resultObj = result as Record<string, unknown>;
  const { kind, ...typedPayload } = resultObj;
  return Object.assign({}, eventWithoutResult, { kind }, typedPayload);
}

/**
 * Append one JSON line to the audit file.
 * Creates .planning/ directory if it does not exist.
 *
 * Uses synchronous fs API (crash-safe for v1 — dispatch is synchronous).
 */
function _appendAuditLine(cwd: string, event: Record<string, unknown>): void {
  const planningDir = path.join(cwd, PLANNING_DIR);
  // Ensure the directory exists
  if (!fs.existsSync(planningDir)) {
    fs.mkdirSync(planningDir, { recursive: true });
  }
  const auditPath = path.join(planningDir, AUDIT_FILE_NAME);
  fs.appendFileSync(auditPath, _safeStringify(event) + '\n', 'utf8');
}

// ─── Public factories ─────────────────────────────────────────────────────────

interface DispatchLogger {
  onEvent(event: Record<string, unknown>): void;
}

/**
 * Create a no-op logger. All events are silently dropped.
 * This is the Hub's default when no logger is injected by the caller.
 */
function createNoOpLogger(): DispatchLogger {
  return {
    onEvent(_event: Record<string, unknown>): void {
      // intentionally empty
    },
  };
}

interface DefaultLoggerOptions {
  cwd?: string;
  config?: { audit?: { enabled?: boolean } };
}

/**
 * Create the default DispatchLogger.
 */
function createDefaultLogger({ cwd = process.cwd(), config }: DefaultLoggerOptions = {}): DispatchLogger {
  return {
    /**
     * @param event - A DispatchEvent from the Hub.
     */
    onEvent(event: Record<string, unknown>): void {
      const resultObj = event && (event['result'] as Record<string, unknown> | undefined);
      const isOk = resultObj && resultObj['kind'] === 'ok';

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
              message: 'audit file write failed: ' + String((auditErr as Error | null)?.message ?? auditErr),
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
              message: 'stderr emit failed: ' + String((stderrErr as Error | null)?.message ?? stderrErr),
            }) + '\n'
          );
        }
      }
      // ── Silent on success (no else branch needed) ─────────────────────────
    },
  };
}

// ─── Live-seam opt-in gate (#4975) ───────────────────────────────────────────

type AuditConfig = { audit: { enabled: boolean } };

/**
 * Resolve `audit.enabled` for `cwd` as the value `config-get audit.enabled`
 * reports, through planning-workspace's readScopedConfigValue — the one
 * scope-aware ladder worktreesOptedOut (#3972) reads too, so the two gates
 * can never resolve the same config differently. Strict `=== true`, never
 * coerced.
 *
 * Direct file reads, deliberately NOT loadConfig: this runs on every live
 * dispatch, and loadConfig can rewrite config.json, spawn git, scan the
 * capability registry, and print warnings — none of which a dispatch that
 * never opted in may do (the default dispatch output is a stable contract,
 * ADR-2619). Never throws. An unreadable or unparseable config file sets
 * nothing, so the ladder moves on: under GSD_WORKSTREAM a broken workstream
 * config inherits the root's `audit.enabled` (where config-get fails with
 * CONFIG_PARSE_FAILED); otherwise the GSD_AUDIT env var alone decides.
 */
function _readAuditConfig(cwd: string): AuditConfig {
  const { present, value } = readScopedConfigValue(cwd, ['audit', 'enabled']);
  return { audit: { enabled: present && value === true } };
}

/**
 * The DispatchLogger a live createHub() seam injects (#4975). Either
 * GSD_AUDIT=1 or `audit.enabled: true` in the project config turns the opt-in
 * audit trail (and the structured stderr line on error) on; neither turns the
 * other off. When observability is off this returns undefined so the Hub keeps
 * its no-op fallback and the default dispatch output — including the
 * --json-errors envelope — stays byte-for-byte unchanged (#2620).
 *
 * `cwd` defaults exactly as createDefaultLogger's does, so the config that
 * decides and the directory that receives the trail are always the same.
 */
function resolveDispatchLogger(cwd: string = process.cwd()): DispatchLogger | undefined {
  const config = _readAuditConfig(cwd);
  return _isAuditEnabled(config) ? createDefaultLogger({ cwd, config }) : undefined;
}

export = { createDefaultLogger, createNoOpLogger, isAuditEnabled: _isAuditEnabled, resolveDispatchLogger };
