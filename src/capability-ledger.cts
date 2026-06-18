/**
 * Capability ledger module — ADR-1244 Phase 3 (Decision D4).
 *
 * Manages a per-runtime install manifest (`.gsd-capabilities.json`) that records
 * what each capability install wrote. Serves as the atomic commit point and
 * reconciliation basis for Phase 4 upgrade/remove operations.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, node:os, and
 * ./shell-command-projection.cjs (for platformWriteSync). No other src/ imports.
 *
 * Exports:
 *   readLedger(runtimeDir)        — structural-validated read, never throws
 *   writeLedger(runtimeDir, ledger) — atomic write via platformWriteSync
 *   recordInstall(runtimeDir, entry) — idempotent upsert of a ledger entry
 *   removeEntry(runtimeDir, capId)   — remove a single entry by id
 *   reconcile(runtimeDir)            — report orphans / stale entries (read-only)
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { platformWriteSync } = require('./shell-command-projection.cjs') as {
  platformWriteSync: (filePath: string, content: string) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEDGER_FILE_NAME = '.gsd-capabilities.json';
const LEDGER_SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LedgerEntry {
  id: string;
  version: string;
  source: string;
  integrity: string;
  files: string[];
  sharedEdits: Array<{ file: string; marker: string }>;
}

interface LedgerFile {
  /** Ledger schema version — currently '1'. */
  version: string;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
  /** Map of capability id → LedgerEntry. */
  entries: Record<string, LedgerEntry>;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

/**
 * Read and structurally validate the ledger file.
 *
 * Returns null if the file is missing, unreadable, or structurally invalid.
 * Never throws.
 */
function readLedger(runtimeDir: string): LedgerFile | null {
  const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p['version'] !== 'string') return null;
    if (typeof p['updatedAt'] !== 'string') return null;
    if (typeof p['entries'] !== 'object' || p['entries'] === null || Array.isArray(p['entries'])) return null;
    // Shallow-validate each entry
    const entries = p['entries'] as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      const e = entries[key];
      if (typeof e !== 'object' || e === null) return null;
      const entry = e as Record<string, unknown>;
      if (typeof entry['id'] !== 'string') return null;
      if (typeof entry['version'] !== 'string') return null;
      if (typeof entry['source'] !== 'string') return null;
      if (typeof entry['integrity'] !== 'string') return null;
      if (!Array.isArray(entry['files'])) return null;
      if (!Array.isArray(entry['sharedEdits'])) return null;
    }
    return {
      version: p['version'],
      updatedAt: p['updatedAt'],
      entries: entries as Record<string, LedgerEntry>,
    };
  } catch {
    return null;
  }
}

/**
 * Write the ledger atomically via platformWriteSync (mkdirSync + tmp+rename).
 */
function writeLedger(runtimeDir: string, ledger: LedgerFile): void {
  platformWriteSync(
    path.join(runtimeDir, LEDGER_FILE_NAME),
    JSON.stringify(ledger, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Mutation operations
// ---------------------------------------------------------------------------

/**
 * Record a capability installation in the ledger (idempotent).
 *
 * If an entry with the same id already exists it is replaced. The `updatedAt`
 * timestamp is refreshed on every call. Rejects ids that would cause prototype
 * pollution (__proto__, constructor, prototype).
 */
function recordInstall(runtimeDir: string, entry: LedgerEntry): void {
  // Prototype-pollution guard — inline literal checks (CodeQL-safe pattern).
  if (entry.id === '__proto__' || entry.id === 'constructor' || entry.id === 'prototype') {
    // Silently ignore — the id is invalid and must never reach the ledger.
    return;
  }

  const existing = readLedger(runtimeDir);
  const ledger: LedgerFile = existing ?? {
    version: LEDGER_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };

  ledger.entries[entry.id] = entry;
  ledger.updatedAt = new Date().toISOString();

  writeLedger(runtimeDir, ledger);
}

/**
 * Remove a single capability entry from the ledger by id.
 *
 * Returns true if the entry was present and removed, false if not found.
 */
function removeEntry(runtimeDir: string, capId: string): boolean {
  const ledger = readLedger(runtimeDir);
  if (ledger === null) return false;
  if (!Object.prototype.hasOwnProperty.call(ledger.entries, capId)) return false;
  delete ledger.entries[capId];
  ledger.updatedAt = new Date().toISOString();
  writeLedger(runtimeDir, ledger);
  return true;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

interface ReconcileResult {
  /** Entries whose recorded files are partially or fully missing on disk. */
  orphans: Array<{ id: string; missing: string[] }>;
  /** Reserved for future use — capabilities whose source has been superseded. */
  stale: string[];
  /** Non-fatal warnings (e.g. unreadable ledger). */
  warnings: string[];
}

/**
 * Check ledger consistency against the filesystem.
 *
 * Read-only — never mutates the ledger or the filesystem. Reports:
 *   - orphans: entries with one or more recorded files missing on disk.
 *   - stale:   (reserved, always empty in Phase 3).
 *   - warnings: problems encountered while reading the ledger.
 */
function reconcile(runtimeDir: string): ReconcileResult {
  const result: ReconcileResult = { orphans: [], stale: [], warnings: [] };

  const ledger = readLedger(runtimeDir);
  if (ledger === null) {
    const filePath = path.join(runtimeDir, LEDGER_FILE_NAME);
    if (fs.existsSync(filePath)) {
      result.warnings.push(`Ledger file exists but could not be parsed: ${filePath}`);
    }
    // Missing ledger is not a warning — it simply means nothing has been installed.
    return result;
  }

  for (const id of Object.keys(ledger.entries)) {
    const entry = ledger.entries[id];
    const missing: string[] = [];
    for (const file of entry.files) {
      // Harden against hostile ledger JSON: a non-string member, or one that is
      // absolute or escapes runtimeDir via "..", must not crash reconcile or become
      // an existence oracle for files outside the runtime config dir.
      if (typeof file !== 'string' || file === '' || path.isAbsolute(file) || file.split(/[/\\]/).includes('..')) {
        // Note: do NOT String(file) — a hostile value like { toString: null } would throw.
        const shown = typeof file === 'string' ? file : `<${typeof file}>`;
        result.warnings.push(`Ledger entry "${id}" has an invalid file path; skipped: ${shown}`);
        continue;
      }
      const resolved = path.join(runtimeDir, file);
      if (!fs.existsSync(resolved)) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      result.orphans.push({ id, missing });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  readLedger,
  writeLedger,
  recordInstall,
  removeEntry,
  reconcile,
  // Exported for testing / introspection
  LEDGER_FILE_NAME,
};
