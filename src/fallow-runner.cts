/**
 * Fallow binary resolution and report normalisation.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/fallow-runner.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * Parses the real fallow `audit --format json` schema (schema_version 3
 * envelope, nested dead_code/duplication sections). See fallow 2.70.0+.
 */

import fs from 'node:fs';
import path from 'node:path';

function candidateNames(): string[] {
  return process.platform === 'win32'
    ? ['fallow.exe', 'fallow.cmd', 'fallow.bat', 'fallow']
    : ['fallow'];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(envPath: string | undefined): string | null {
  if (!envPath) return null;
  const names = candidateNames();
  const segments = envPath.split(path.delimiter).filter(Boolean);
  for (const segment of segments) {
    for (const name of names) {
      const candidate = path.join(segment, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function findInNodeModules(cwd: string): string | null {
  const names = candidateNames();
  const binDir = path.join(cwd, 'node_modules', '.bin');
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export interface ResolveFallowOpts {
  cwd: string;
  envPath?: string;
}

export function resolveFallowBinary({ cwd, envPath = process.env['PATH'] ?? '' }: ResolveFallowOpts): string | null {
  return findInNodeModules(cwd) || findInPath(envPath) || null;
}

export function requireFallowBinary({ cwd, envPath = process.env['PATH'] ?? '' }: ResolveFallowOpts): string {
  const binary = resolveFallowBinary({ cwd, envPath });
  if (binary) return binary;
  throw new Error(
    'Fallow is enabled but no binary was found. Please install fallow via `npm install -D fallow` or `cargo install fallow`.',
  );
}

// --- Real fallow audit --format json schema (schema_version 3) interfaces ---

interface FallowUnusedExport {
  path?: string;
  export_name?: string;
  is_type_only?: boolean;
  line?: number | null;
  col?: number | null;
  span_start?: number | null;
  is_re_export?: boolean;
  actions?: unknown[];
  introduced?: boolean;
}

interface FallowUnusedFile {
  path?: string;
  actions?: unknown[];
  introduced?: boolean;
}

interface FallowCircularDependency {
  files?: string[];
  length?: number;
  line?: number | null;
  col?: number | null;
  actions?: unknown[];
  introduced?: boolean;
}

interface FallowCloneInstance {
  file?: string;
  start_line?: number | null;
  end_line?: number | null;
  start_col?: number | null;
  end_col?: number | null;
  fragment?: string;
}

interface FallowCloneGroup {
  instances?: FallowCloneInstance[];
}

interface FallowDeadCode {
  unused_exports?: FallowUnusedExport[];
  unused_files?: FallowUnusedFile[];
  circular_dependencies?: FallowCircularDependency[];
  summary?: unknown;
  schema_version?: number;
}

interface FallowDuplication {
  clone_groups?: FallowCloneGroup[];
  stats?: unknown;
}

interface FallowReport {
  schema_version?: number;
  version?: string;
  command?: string;
  verdict?: string;
  changed_files_count?: number;
  base_ref?: string;
  head_sha?: string;
  elapsed_ms?: number;
  summary?: unknown;
  attribution?: unknown;
  dead_code?: FallowDeadCode;
  duplication?: FallowDuplication;
  complexity?: unknown;
}

export interface FallowFinding {
  type: 'unused_export' | 'unused_file' | 'duplicate_block' | 'circular_dependency';
  message: string;
  file: string;
  line: number | null;
  related_file?: string;
}

export interface NormalizedFallowReport {
  summary: {
    unused_exports: number;
    unused_files: number;
    duplicates: number;
    circular_dependencies: number;
    total: number;
  };
  findings: FallowFinding[];
}

export function normalizeFallowReport(report: FallowReport | null | undefined): NormalizedFallowReport {
  const deadCodeRaw = report?.dead_code;
  const duplicationRaw = report?.duplication;
  const unusedExports: FallowUnusedExport[] = (Array.isArray(deadCodeRaw?.unused_exports)
    ? (deadCodeRaw?.unused_exports ?? [])
    : []).filter((x): x is FallowUnusedExport => x !== null && typeof x === 'object');
  const unusedFiles: FallowUnusedFile[] = (Array.isArray(deadCodeRaw?.unused_files)
    ? (deadCodeRaw?.unused_files ?? [])
    : []).filter((x): x is FallowUnusedFile => x !== null && typeof x === 'object');
  const circularDeps: FallowCircularDependency[] = (Array.isArray(deadCodeRaw?.circular_dependencies)
    ? (deadCodeRaw?.circular_dependencies ?? [])
    : []).filter((x): x is FallowCircularDependency => x !== null && typeof x === 'object');
  const cloneGroups: FallowCloneGroup[] = (Array.isArray(duplicationRaw?.clone_groups)
    ? (duplicationRaw?.clone_groups ?? [])
    : []).filter((x): x is FallowCloneGroup => x !== null && typeof x === 'object');

  const findings: FallowFinding[] = [];

  for (const item of unusedExports) {
    if (!item || typeof item !== 'object') continue;
    findings.push({
      type: 'unused_export',
      message: `Unused export ${item.export_name ?? '<unknown>'}`,
      file: item.path ?? '',
      line: item.line ?? null,
    });
  }

  for (const item of unusedFiles) {
    if (!item || typeof item !== 'object') continue;
    findings.push({
      type: 'unused_file',
      message: `Unused file ${item.path ?? '<unknown>'}`,
      file: item.path ?? '',
      line: null,
    });
  }

  for (const item of circularDeps) {
    if (!item || typeof item !== 'object') continue;
    const files = Array.isArray(item.files) ? item.files : [];
    findings.push({
      type: 'circular_dependency',
      message: `Circular dependency: ${files.join(' -> ')}`,
      file: files.length > 0 ? files[0] : '',
      line: item.line ?? null,
    });
  }

  for (const group of cloneGroups) {
    if (!group || typeof group !== 'object') continue;
    const instances = Array.isArray(group.instances) ? group.instances : [];
    findings.push({
      type: 'duplicate_block',
      message: `Duplicate block (${instances.length} instances)`,
      file: instances[0]?.file ?? '',
      line: instances[0]?.start_line ?? null,
      related_file: instances[1]?.file ?? '',
    });
  }

  return {
    summary: {
      unused_exports: unusedExports.length,
      unused_files: unusedFiles.length,
      duplicates: cloneGroups.length,
      circular_dependencies: circularDeps.length,
      total: findings.length,
    },
    findings,
  };
}

export function normalizeFallowReportFile(filePath: string): NormalizedFallowReport {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as FallowReport;
    return normalizeFallowReport(parsed);
  } catch {
    return normalizeFallowReport(null);
  }
}
