/**
 * Fallow binary resolution and report normalisation.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/fallow-runner.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
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

interface FallowUnusedExport {
  symbol?: string;
  file?: string;
  line?: number | null;
}

interface FallowDuplicateItem {
  file?: string;
  start?: number | null;
}

interface FallowDuplicate {
  similarity?: number;
  left?: FallowDuplicateItem;
  right?: FallowDuplicateItem;
}

interface FallowCircular {
  cycle?: string[];
}

interface FallowReport {
  unusedExports?: unknown[];
  duplicates?: unknown[];
  circularDependencies?: unknown[];
}

export interface FallowFinding {
  type: 'unused_export' | 'duplicate_block' | 'circular_dependency';
  message: string;
  file: string;
  line: number | null;
  related_file?: string;
}

export interface NormalizedFallowReport {
  summary: {
    unused_exports: number;
    duplicates: number;
    circular_dependencies: number;
    total: number;
  };
  findings: FallowFinding[];
}

export function normalizeFallowReport(report: FallowReport | null | undefined): NormalizedFallowReport {
  const unused: FallowUnusedExport[] = Array.isArray(report?.unusedExports)
    ? (report.unusedExports as FallowUnusedExport[])
    : [];
  const duplicates: FallowDuplicate[] = Array.isArray(report?.duplicates)
    ? (report.duplicates as FallowDuplicate[])
    : [];
  const circular: FallowCircular[] = Array.isArray(report?.circularDependencies)
    ? (report.circularDependencies as FallowCircular[])
    : [];

  const findings: FallowFinding[] = [];

  for (const item of unused) {
    findings.push({
      type: 'unused_export',
      message: `Unused export ${item.symbol ?? '<unknown>'}`,
      file: item.file ?? '',
      line: item.line ?? null,
    });
  }

  for (const item of duplicates) {
    findings.push({
      type: 'duplicate_block',
      message: `Duplicate block (${Math.round((item.similarity ?? 0) * 100)}% similarity)`,
      file: item.left?.file ?? '',
      line: item.left?.start ?? null,
      related_file: item.right?.file ?? '',
    });
  }

  for (const item of circular) {
    findings.push({
      type: 'circular_dependency',
      message: `Circular dependency: ${(item.cycle ?? []).join(' -> ')}`,
      file: Array.isArray(item.cycle) && item.cycle.length > 0 ? item.cycle[0] : '',
      line: null,
    });
  }

  return {
    summary: {
      unused_exports: unused.length,
      duplicates: duplicates.length,
      circular_dependencies: circular.length,
      total: findings.length,
    },
    findings,
  };
}
