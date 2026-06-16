/**
 * lib/intel.cts -- Intel storage and query operations for GSD.
 *
 * Provides a persistent, queryable intelligence system for project metadata.
 * Intel files live in .planning/intel/ and store structured data about
 * the project's files, APIs, dependencies, architecture, and tech stack.
 *
 * All public functions gate on isCapabilityActive('intel', cwd) — the shared
 * tri-state resolver (installed + surfaced + intel.enabled config key).
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/intel.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { platformWriteSync, platformReadSync, platformEnsureDir } from './shell-command-projection.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
const { isCapabilityActive } = capabilityStateMod;

// ─── Constants ───────────────────────────────────────────────────────────────

const INTEL_DIR = '.planning/intel';

const INTEL_FILES: Record<string, string> = {
  files: 'file-roles.json',
  apis: 'api-map.json',
  deps: 'dependency-graph.json',
  arch: 'arch-decisions.json',
  stack: 'stack.json',
};

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Ensure the intel directory exists under the given planning dir.
 */
function ensureIntelDir(planningDir: string): string {
  const intelPath = path.join(planningDir, 'intel');
  platformEnsureDir(intelPath);
  return intelPath;
}

/**
 * Check whether intel is active (installed, surfaced, and config-enabled) for the project at cwd.
 * Delegates to the shared tri-state capability resolver (isCapabilityActive) which honours the
 * install profile, runtime surface, and activationKey (intel.enabled config gate).
 *
 * NOTE: planningDir is the legacy entry-point; cwd is derived as path.dirname(planningDir).
 * Callers that have cwd directly may call isCapabilityActive('intel', cwd) themselves.
 *
 * INVARIANT: planningDir is always `<cwd>/.planning` (i.e. path.join(cwd, '.planning')).
 * The intel-command-router always constructs planningDir as path.join(cwd, '.planning'),
 * so path.dirname(planningDir) === cwd is guaranteed. If a workstream-aware planningDir
 * were ever passed here, the dirname would be wrong — but no caller does that.
 */
function isIntelCapabilityActive(planningDir: string): boolean {
  return isCapabilityActive('intel', path.dirname(planningDir));
}

interface DisabledResponse {
  disabled: true;
  message: string;
}

/**
 * Return the standard disabled response object.
 */
function disabledResponse(): DisabledResponse {
  return { disabled: true, message: 'Intel system disabled. Set intel.enabled=true in config.json to activate.' };
}

/**
 * Resolve full path to an intel file.
 */
function intelFilePath(planningDir: string, filename: string): string {
  return path.join(planningDir, 'intel', filename);
}

interface IntelData {
  _meta?: {
    updated_at?: string;
    version?: number;
    [key: string]: unknown;
  };
  entries?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Safely read and parse a JSON intel file.
 * Returns null if file doesn't exist or can't be parsed.
 */
function safeReadJson(filePath: string): IntelData | null {
  try {
    const raw = platformReadSync(filePath);
    if (raw === null) return null;
    return JSON.parse(raw) as IntelData;
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 hash of a file's contents.
 * Returns null if the file doesn't exist.
 */
function hashFile(filePath: string): string | null {
  try {
    const content = platformReadSync(filePath);
    if (content === null) return null;
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

interface SearchMatch {
  key: string;
  value: unknown;
}

/**
 * Search for a term (case-insensitive) in a JSON object's keys and string values.
 * Returns an array of matching entries.
 */
function searchJsonEntries(data: IntelData, term: string): SearchMatch[] {
  if (!data || typeof data !== 'object') return [];

  const entries = data.entries || data;
  if (!entries || typeof entries !== 'object') return [];

  const lowerTerm = term.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const [key, value] of Object.entries(entries)) {
    if (key === '_meta') continue;

    // Check key match
    if (key.toLowerCase().includes(lowerTerm)) {
      matches.push({ key, value });
      continue;
    }

    // Check string value match (recursive for objects)
    if (matchesInValue(value, lowerTerm)) {
      matches.push({ key, value });
    }
  }

  return matches;
}

/**
 * Recursively check if a term appears in any string value.
 */
function matchesInValue(value: unknown, lowerTerm: string): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase().includes(lowerTerm);
  }
  if (Array.isArray(value)) {
    return value.some(v => matchesInValue(v, lowerTerm));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(v => matchesInValue(v, lowerTerm));
  }
  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

interface IntelQueryResult {
  matches: Array<{ source: string; entries: SearchMatch[] }>;
  term: string;
  total: number;
}

/**
 * Query intel files for a search term.
 * Searches across all JSON intel files in INTEL_FILES (keys and values), including arch-decisions.json (parsed as JSON, not as text).
 */
function intelQuery(term: string, planningDir: string): IntelQueryResult | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  const matches: Array<{ source: string; entries: SearchMatch[] }> = [];
  let total = 0;

  // Search all JSON intel files
  for (const [_key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = intelFilePath(planningDir, filename);
    const data = safeReadJson(filePath);
    if (!data) continue;

    const found = searchJsonEntries(data, term);
    if (found.length > 0) {
      matches.push({ source: filename, entries: found });
      total += found.length;
    }
  }

  return { matches, term, total };
}

interface IntelStatusFileEntry {
  exists: boolean;
  updated_at: string | null;
  stale: boolean;
}

interface IntelStatusResult {
  files: Record<string, IntelStatusFileEntry>;
  overall_stale: boolean;
}

/**
 * Report status and staleness of each intel file.
 * A file is considered stale if its updated_at is older than 24 hours.
 */
function intelStatus(planningDir: string): IntelStatusResult | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  const files: Record<string, IntelStatusFileEntry> = {};
  let overallStale = false;

  for (const [_key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = intelFilePath(planningDir, filename);
    const exists = fs.existsSync(filePath);

    if (!exists) {
      files[filename] = { exists: false, updated_at: null, stale: true };
      overallStale = true;
      continue;
    }

    let updatedAt: string | null = null;

    // All intel files are JSON — read _meta.updated_at
    const data = safeReadJson(filePath);
    if (data && data._meta && data._meta.updated_at) {
      updatedAt = data._meta.updated_at;
    }

    let stale = true;
    if (updatedAt) {
      const age = now - new Date(updatedAt).getTime();
      stale = age > STALE_MS;
    }

    if (stale) overallStale = true;
    files[filename] = { exists: true, updated_at: updatedAt, stale };
  }

  return { files, overall_stale: overallStale };
}

interface IntelDiffResult {
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * Show changes since the last full refresh by comparing file hashes.
 */
function intelDiff(planningDir: string): IntelDiffResult | { no_baseline: true } | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  const snapshotPath = intelFilePath(planningDir, '.last-refresh.json');
  const snapshot = safeReadJson(snapshotPath);

  if (!snapshot) {
    return { no_baseline: true };
  }

  const prevHashes = (snapshot.hashes as Record<string, string> | undefined) || {};
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Check current files against snapshot
  for (const [_key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = intelFilePath(planningDir, filename);
    const currentHash = hashFile(filePath);

    if (currentHash && !prevHashes[filename]) {
      added.push(filename);
    } else if (currentHash && prevHashes[filename] && currentHash !== prevHashes[filename]) {
      changed.push(filename);
    } else if (!currentHash && prevHashes[filename]) {
      removed.push(filename);
    }
  }

  return { changed, added, removed };
}

/**
 * Stub for triggering an intel update.
 * The actual update is performed by the intel-updater agent (PLAN-02).
 */
function intelUpdate(planningDir: string): { action: string; message: string } | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  return {
    action: 'spawn_agent',
    message: 'Run gsd-tools intel update or spawn gsd-intel-updater agent for full refresh',
  };
}

interface SaveRefreshResult {
  saved: boolean;
  timestamp: string;
  files: number;
}

/**
 * Save a refresh snapshot with hashes of all current intel files.
 * Called by the intel-updater agent after completing a refresh.
 */
function saveRefreshSnapshot(planningDir: string): SaveRefreshResult {
  const intelPath = ensureIntelDir(planningDir);
  const hashes: Record<string, string> = {};
  let fileCount = 0;

  for (const [_key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = path.join(intelPath, filename);
    const hash = hashFile(filePath);
    if (hash) {
      hashes[filename] = hash;
      fileCount++;
    }
  }

  const timestamp = new Date().toISOString();
  const snapshotPath = path.join(intelPath, '.last-refresh.json');
  platformWriteSync(snapshotPath, JSON.stringify({
    hashes,
    timestamp,
    version: 1,
  }, null, 2));

  return { saved: true, timestamp, files: fileCount };
}

// ─── CLI Subcommands ─────────────────────────────────────────────────────────

/**
 * Thin wrapper around saveRefreshSnapshot for CLI dispatch.
 * Writes .last-refresh.json with accurate timestamps and hashes.
 */
function intelSnapshot(planningDir: string): SaveRefreshResult | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();
  return saveRefreshSnapshot(planningDir);
}

interface IntelValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate all intel files for correctness and freshness.
 */
function intelValidate(planningDir: string): IntelValidateResult | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  const errors: string[] = [];
  const warnings: string[] = [];
  const STALE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [key, filename] of Object.entries(INTEL_FILES)) {
    const filePath = intelFilePath(planningDir, filename);

    // Check existence
    if (!fs.existsSync(filePath)) {
      errors.push(`${filename}: file does not exist`);
      continue;
    }

    // All intel files are JSON — validate _meta and entries structure

    // Parse JSON
    const raw = platformReadSync(filePath);
    if (raw === null) {
      errors.push(`${filename}: file missing`);
      continue;
    }
    let data: IntelData;
    try {
      data = JSON.parse(raw) as IntelData;
    } catch (e) {
      errors.push(`${filename}: invalid JSON — ${(e as Error).message}`);
      continue;
    }

    // Check _meta.updated_at recency
    if (data._meta && data._meta.updated_at) {
      const age = now - new Date(data._meta.updated_at).getTime();
      if (age > STALE_MS) {
        warnings.push(`${filename}: _meta.updated_at is ${Math.round(age / 3600000)} hours old (>24 hr)`);
      }
    } else {
      warnings.push(`${filename}: missing _meta.updated_at`);
    }

    // Validate entries are objects with expected fields
    if (data.entries && typeof data.entries === 'object') {
      // file-roles.json (INTEL_FILES key 'files'): check exports are actual symbol names (no spaces)
      if (key === 'files') {
        for (const [entryPath, entry] of Object.entries(data.entries)) {
          const entryObj = entry as Record<string, unknown>;
          if (entryObj.exports && Array.isArray(entryObj.exports)) {
            for (const exp of entryObj.exports as unknown[]) {
              if (typeof exp === 'string' && exp.includes(' ')) {
                warnings.push(`${filename}: "${entryPath}" export "${exp}" looks like a description (contains space)`);
              }
            }
          }
        }
        // Spot-check first 5 file paths exist on disk
        const entryPaths = Object.keys(data.entries).slice(0, 5);
        for (const ep of entryPaths) {
          if (!fs.existsSync(ep)) {
            warnings.push(`${filename}: entry path "${ep}" does not exist on disk`);
          }
        }
      }

      // dependency-graph.json (INTEL_FILES key 'deps'): check entries have version, type, used_by
      if (key === 'deps') {
        for (const [depName, entry] of Object.entries(data.entries)) {
          const entryObj = entry as Record<string, unknown>;
          const missing: string[] = [];
          if (!entryObj.version) missing.push('version');
          if (!entryObj.type) missing.push('type');
          if (!entryObj.used_by) missing.push('used_by');
          if (missing.length > 0) {
            warnings.push(`${filename}: "${depName}" missing fields: ${missing.join(', ')}`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

interface IntelApiSurfaceResult {
  written: string;
  symbolCount: number;
  stale: boolean;
}

/**
 * Render .planning/intel/api-map.json into a human-readable API-SURFACE.md.
 * Always writes the file — even when api-map.json is absent or empty, the
 * surface will contain an explicit "incomplete" banner so consumers never
 * mistake silence for "nothing exists".
 */
function intelApiSurface(planningDir: string): IntelApiSurfaceResult | DisabledResponse {
  if (!isIntelCapabilityActive(planningDir)) return disabledResponse();

  const intelPath = ensureIntelDir(planningDir);
  const apiMapPath = path.join(intelPath, INTEL_FILES.apis);
  const outputPath = path.join(intelPath, 'API-SURFACE.md');

  const data = safeReadJson(apiMapPath);
  const entries = (data && data.entries && typeof data.entries === 'object')
    ? Object.entries(data.entries)
    : [];
  const symbolCount = entries.length;

  // Staleness: reuse the _meta.updated_at field if present
  const STALE_MS = 24 * 60 * 60 * 1000;
  let stale = true;
  if (data && data._meta && data._meta.updated_at) {
    const age = Date.now() - new Date(data._meta.updated_at).getTime();
    stale = age > STALE_MS;
  }

  const lines: string[] = [];
  lines.push('# API Surface');
  lines.push('');
  lines.push('> Generated from `.planning/intel/api-map.json`. Do not edit by hand.');
  lines.push('');

  if (symbolCount === 0) {
    lines.push('> **Incomplete:** api-map.json has no entries (intel extraction is regex/JS-only or not yet populated).');
    lines.push('> Treat absence here as "unknown", not "does not exist".');
    lines.push('');
  } else {
    if (stale) {
      lines.push('> **Warning:** api-map.json is stale (>24 hours old). Data below may be out of date.');
      lines.push('');
    }

    for (const [symbol, info] of entries) {
      lines.push(`## \`${symbol}\``);
      lines.push('');
      if (info && typeof info === 'object') {
        for (const [field, val] of Object.entries(info as Record<string, unknown>)) {
          const display = Array.isArray(val) ? val.join(', ') : String(val);
          lines.push(`- **${field}:** ${display}`);
        }
      }
      lines.push('');
    }
  }

  platformWriteSync(outputPath, lines.join('\n'));

  return { written: outputPath, symbolCount, stale };
}

interface IntelPatchMetaResult {
  patched: boolean;
  file?: string;
  timestamp?: string;
  error?: string;
}

/**
 * Patch _meta.updated_at in a JSON intel file to the current timestamp.
 * Reads the file, updates _meta.updated_at, increments version, writes back.
 *
 * NOTE: Does not gate on isCapabilityActive — operates on arbitrary file paths
 * for use by agents patching individual files outside the intel store.
 */
function intelPatchMeta(filePath: string): IntelPatchMetaResult {
  try {
    const content = platformReadSync(filePath);
    if (content === null) {
      return { patched: false, error: `File not found: ${filePath}` };
    }
    let data: IntelData;
    try {
      data = JSON.parse(content) as IntelData;
    } catch (e) {
      return { patched: false, error: `Invalid JSON: ${(e as Error).message}` };
    }

    if (!data._meta) {
      data._meta = {};
    }

    const timestamp = new Date().toISOString();
    data._meta.updated_at = timestamp;
    data._meta.version = (data._meta.version || 0) + 1;

    platformWriteSync(filePath, JSON.stringify(data, null, 2) + '\n');

    return { patched: true, file: filePath, timestamp };
  } catch (e) {
    return { patched: false, error: (e as Error).message };
  }
}

interface IntelExtractExportsResult {
  file: string;
  exports: string[];
  method: string;
}

/**
 * Extract exports from a JS/CJS file by parsing module.exports or exports.X patterns.
 *
 * NOTE: Does not gate on isCapabilityActive — operates on arbitrary source files
 * for use by agents building intel data from project files.
 */
function intelExtractExports(filePath: string): IntelExtractExportsResult {
  const content = platformReadSync(filePath);
  if (content === null) {
    return { file: filePath, exports: [], method: 'none' };
  }
  const exports = new Set<string>();
  let method = 'none';

  // Try module.exports = { ... } pattern (handle multi-line)
  // Find the LAST module.exports assignment (the actual one, not references in code)
  const allMatches = [...content.matchAll(/module\.exports\s*=\s*\{/g)];
  if (allMatches.length > 0) {
    const lastMatch = allMatches[allMatches.length - 1];
    const startIdx = lastMatch.index + lastMatch[0].length;
    // Find matching closing brace by counting braces
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < content.length && depth > 0) {
      if (content[endIdx] === '{') depth++;
      else if (content[endIdx] === '}') depth--;
      if (depth > 0) endIdx++;
    }
    const block = content.substring(startIdx, endIdx);
    method = 'module.exports';
    // Extract key names from lines like "  keyName," or "  keyName: value,"
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      // Match identifier at start of line (before comma, colon, end of line)
      const keyMatch = trimmed.match(/^(\w+)\s*[,}:]/) || trimmed.match(/^(\w+)$/);
      if (keyMatch) {
        exports.add(keyMatch[1]);
      }
    }
  }

  // Also try individual exports.X = patterns (only at start of line, not inside strings/regex)
  const individualPattern = /^exports\.(\w+)\s*=/gm;
  let im: RegExpExecArray | null;
  while ((im = individualPattern.exec(content)) !== null) {
    if (!exports.has(im[1])) {
      exports.add(im[1]);
      if (method === 'none') method = 'exports.X';
    }
  }

  const hadCjs = exports.size > 0;

  // ESM patterns
  const esmExports = new Set<string>();

  // export default function X / export default class X
  const defaultNamedPattern = /^export\s+default\s+(?:function|class)\s+(\w+)/gm;
  let em: RegExpExecArray | null;
  while ((em = defaultNamedPattern.exec(content)) !== null) {
    esmExports.add(em[1]);
  }

  // export default (without named function/class)
  const defaultAnonPattern = /^export\s+default\s+(?!function\s|class\s)/gm;
  if (defaultAnonPattern.test(content) && esmExports.size === 0) {
    esmExports.add('default');
  }

  // export function X( / export async function X(
  const exportFnPattern = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm;
  while ((em = exportFnPattern.exec(content)) !== null) {
    esmExports.add(em[1]);
  }

  // export const X = / export let X = / export var X =
  const exportVarPattern = /^export\s+(?:const|let|var)\s+(\w+)\s*=/gm;
  while ((em = exportVarPattern.exec(content)) !== null) {
    esmExports.add(em[1]);
  }

  // export class X
  const exportClassPattern = /^export\s+class\s+(\w+)/gm;
  while ((em = exportClassPattern.exec(content)) !== null) {
    esmExports.add(em[1]);
  }

  // export { X, Y, Z } — strip "as alias" parts
  const exportBlockPattern = /^export\s*\{([^}]+)\}/gm;
  while ((em = exportBlockPattern.exec(content)) !== null) {
    const items = em[1].split(',');
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // "foo as bar" -> extract "foo"
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (name) esmExports.add(name);
    }
  }

  // Merge ESM exports into the result
  for (const e of esmExports) {
    exports.add(e);
  }

  // Determine method
  const hadEsm = esmExports.size > 0;
  if (hadCjs && hadEsm) {
    method = 'mixed';
  } else if (hadEsm && !hadCjs) {
    method = 'esm';
  }

  return { file: filePath, exports: [...exports], method };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export = {
  // Public API
  intelQuery,
  intelUpdate,
  intelStatus,
  intelDiff,
  saveRefreshSnapshot,

  // CLI subcommands
  intelSnapshot,
  intelValidate,
  intelExtractExports,
  intelPatchMeta,
  intelApiSurface,

  // Utilities
  ensureIntelDir,
  isIntelCapabilityActive,

  // Constants
  INTEL_FILES,
  INTEL_DIR,
};
