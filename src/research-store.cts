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
import { platformWriteSync } from './shell-command-projection.cjs';

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
}

interface PutPayload {
  content: unknown;
  source: string;
  provider: string;
  confidence: string;
  kind: string;
  version?: string;
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
  return DAY_MS;
}

// ---------------------------------------------------------------------------
// tierForSource / resolveStorePath
// ---------------------------------------------------------------------------

const CURATED_SOURCES = new Set(['curated']);

function tierForSource(source: string): 'user' | 'project' {
  return CURATED_SOURCES.has(source) ? 'user' : 'project';
}

function resolveStorePath(cwd: string, source: string, { homeDir = os.homedir() }: { homeDir?: string } = {}): string {
  if (tierForSource(source) === 'user') {
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
  payload: PutPayload,
  { clock = Date, homeDir = os.homedir() }: PutOptions = {}
): ResearchEntry {
  const { content, source, provider, confidence, kind, version } = payload;
  let ttl = ttlForSource(source, confidence);
  // Cap TTL when version is blank/missing — a versionless curated entry must not
  // get the long 30-day window since we can't know if it's still current.
  if (!version) {
    ttl = Math.min(ttl, DAY_MS);
  }
  const fetched_at = new Date(clock.now()).toISOString();
  const entry: ResearchEntry = { content, source, provider, confidence, fetched_at, ttl, kind };
  const dir = resolveStorePath(cwd, source, { homeDir });
  fs.mkdirSync(dir, { recursive: true });
  platformWriteSync(path.join(dir, `${key}.json`), JSON.stringify(entry));
  return entry;
}

// ---------------------------------------------------------------------------
// getResearch
// ---------------------------------------------------------------------------

function getResearch(cwd: string, key: string, { clock = Date, homeDir = os.homedir() }: GetOptions = {}): GetResult {
  try {
    // Search both physical tiers: user (curated) and project (web/etc.)
    const userDir = path.join(homeDir, '.gsd', 'research-cache');
    const projectDir = path.join(cwd, '.planning', 'research', '.cache');
    const tierDirs = [userDir, projectDir];

    interface Candidate {
      entry: ResearchEntry;
      stale: boolean;
      age: number;
    }

    const candidates: Candidate[] = [];

    for (const dir of tierDirs) {
      const filePath = path.join(dir, `${key}.json`);
      if (!fs.existsSync(filePath)) continue;

      let entry: ResearchEntry;
      try {
        entry = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ResearchEntry;
      } catch {
        // Corrupt file in this tier — skip it
        continue;
      }

      const age = clock.now() - Date.parse(entry.fetched_at);
      const stale = age > entry.ttl;
      candidates.push({ entry, stale, age });
    }

    if (candidates.length === 0) {
      return { hit: false, stale: false, entry: null };
    }

    // Prefer: non-stale over stale; among same-staleness, lowest age (most recent)
    candidates.sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? 1 : -1; // non-stale first
      return a.age - b.age; // lower age (more recent) first
    });

    const best = candidates[0];
    return { hit: true, stale: best.stale, entry: best.entry };
  } catch {
    return { hit: false, stale: false, entry: null };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = { researchKey, ttlForSource, tierForSource, resolveStorePath, putResearch, getResearch };
