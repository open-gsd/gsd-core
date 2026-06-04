/**
 * Research Store Module
 *
 * Provides deterministic cache key generation, TTL policy, path resolution,
 * and JSON-backed put/get operations for research entries.
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResearchKeyInput {
  ecosystem?: unknown;
  library?: unknown;
  version?: unknown;
  query?: unknown;
  kind?: unknown;
}

interface ResearchEntry {
  content: unknown;
  source: string;
  provider: string;
  confidence: string;
  fetched_at: string;
  ttl: number;
  kind: string;
}

interface GetResult {
  hit: boolean;
  stale: boolean;
  entry: ResearchEntry | null;
}

interface ClockLike {
  now(): number;
}

interface PutOptions {
  clock?: ClockLike;
  homeDir?: string;
}

interface GetOptions {
  clock?: ClockLike;
  homeDir?: string;
  kind?: string;
}

// ---------------------------------------------------------------------------
// researchKey
// ---------------------------------------------------------------------------

function normalize(x: unknown): string {
  if (x === null || x === undefined) return '';
  if (typeof x === 'object') return JSON.stringify(x).trim().toLowerCase();
  // After excluding null, undefined, and object, x can only be a primitive —
  // cast through number | string | boolean to avoid no-base-to-string on unknown.
  return `${x as number | string | boolean}`.trim().toLowerCase();
}

function researchKey(input: ResearchKeyInput): string {
  const parts = {
    ecosystem: normalize(input.ecosystem),
    library: normalize(input.library),
    version: normalize(input.version),
    query: normalize(input.query),
    kind: normalize(input.kind),
  };
  const serialized = JSON.stringify(parts);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// ---------------------------------------------------------------------------
// ttlForSource
// ---------------------------------------------------------------------------

function ttlForSource(source: string, confidence: string): number {
  if (source === 'curated' && confidence === 'HIGH') return 30 * DAY_MS;
  if (source === 'curated' && confidence === 'MEDIUM') return 7 * DAY_MS;
  if (source === 'web' || confidence === 'LOW') return DAY_MS;
  return DAY_MS;
}

// ---------------------------------------------------------------------------
// resolveStorePath
// ---------------------------------------------------------------------------

const CURATED_KINDS = new Set(['docs']);

function resolveStorePath(cwd: string, kind: string, { homeDir = os.homedir() }: { homeDir?: string } = {}): string {
  if (CURATED_KINDS.has(kind)) {
    return path.join(homeDir, '.gsd', 'research-cache');
  }
  return path.join(cwd, '.planning', 'research', '.cache');
}

// ---------------------------------------------------------------------------
// putResearch
// ---------------------------------------------------------------------------

function putResearch(
  cwd: string,
  key: string,
  payload: { content: unknown; source: string; provider: string; confidence: string; kind: string },
  { clock = Date, homeDir = os.homedir() }: PutOptions = {}
): ResearchEntry {
  const { content, source, provider, confidence, kind } = payload;
  const ttl = ttlForSource(source, confidence);
  const fetched_at = new Date(clock.now()).toISOString();
  const entry: ResearchEntry = { content, source, provider, confidence, fetched_at, ttl, kind };
  const dir = resolveStorePath(cwd, kind, { homeDir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(entry));
  return entry;
}

// ---------------------------------------------------------------------------
// getResearch
// ---------------------------------------------------------------------------

function getResearch(cwd: string, key: string, { clock = Date, homeDir = os.homedir(), kind }: GetOptions = {}): GetResult {
  try {
    // If kind is provided, check only that tier; otherwise search both.
    const searchKinds: string[] = kind !== undefined ? [kind] : ['docs', 'web'];

    for (const k of searchKinds) {
      const dir = resolveStorePath(cwd, k, { homeDir });
      const filePath = path.join(dir, `${key}.json`);
      if (!fs.existsSync(filePath)) continue;

      let entry: ResearchEntry;
      try {
        entry = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ResearchEntry;
      } catch {
        return { hit: false, stale: false, entry: null };
      }

      const age = clock.now() - Date.parse(entry.fetched_at);
      const stale = age > entry.ttl;
      return { hit: true, stale, entry };
    }

    return { hit: false, stale: false, entry: null };
  } catch {
    return { hit: false, stale: false, entry: null };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = { researchKey, ttlForSource, resolveStorePath, putResearch, getResearch };
