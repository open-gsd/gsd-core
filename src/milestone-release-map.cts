/**
 * Milestone Release Map — validation, rendering and archive read-back for the
 * per-repository release record `milestone complete --release-map` persists
 * (#5706, phase 2 of epic #3628, docs/adr/3628-milestone-release-mapping.md).
 *
 * A release map is the caller-supplied record of what each repository shipped
 * for a milestone. It is data: this module never resolves a repository to a
 * directory, never consults `planning.sub_repos`, and never creates a tag. The
 * map is archived by recorded value, so a repository that later leaves
 * `planning.sub_repos` does not change an already-archived map.
 */

import fs from 'node:fs';
import path from 'node:path';
import { safeJsonParse } from './security.cjs';

/** Maximum number of entries a single release map may carry. */
export const MAX_RELEASE_MAP_ENTRIES = 256;

/** Maximum length (UTF-16 code units) of any single string field in an entry. */
export const MAX_RELEASE_MAP_FIELD_LENGTH = 200;

/** Maximum size in bytes of a `--release-map` input file. */
export const MAX_RELEASE_MAP_FILE_BYTES = 1048576;

/** Allowed values of an entry's `status`. */
export const RELEASE_MAP_STATUSES: readonly string[] = Object.freeze(['released', 'deployed', 'unreleased']);

/** Allowed values of an entry's `tag`. */
export const RELEASE_MAP_TAG_STATES: readonly string[] = Object.freeze(['created', 'already_tagged', 'skipped', 'none']);

const OPTIONAL_STRING_FIELDS = ['release', 'reference', 'environment'] as const;
const ENTRY_FIELDS: readonly string[] = Object.freeze(['repo', ...OPTIONAL_STRING_FIELDS, 'status', 'tag']);

export interface ReleaseMapEntry {
  repo: string;
  release: string | null;
  reference: string | null;
  environment: string | null;
  status: string;
  tag: string;
}

export type ReleaseMapValidation =
  | { ok: true; map: ReleaseMapEntry[] }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a release map (an array of entries) and return the normalized
 * entries. Every problem is reported in one pass so a caller fixes the file
 * once. Strict on shape: unknown fields are an error, not silently dropped.
 */
export function validateReleaseMap(input: unknown): ReleaseMapValidation {
  if (!Array.isArray(input)) {
    return { ok: false, errors: [`release map must be an array of entries (got ${describeType(input)})`] };
  }
  const errors: string[] = [];
  if (input.length > MAX_RELEASE_MAP_ENTRIES) {
    errors.push(`release map has ${input.length} entries; the maximum is ${MAX_RELEASE_MAP_ENTRIES}`);
  }
  const map: ReleaseMapEntry[] = [];
  const seenRepos = new Set<string>();
  const limit = Math.min(input.length, MAX_RELEASE_MAP_ENTRIES);
  for (let i = 0; i < limit; i++) {
    const raw: unknown = input[i];
    const label = `entries[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${label} must be an object (got ${describeType(raw)})`);
      continue;
    }
    let entryOk = true;
    for (const key of Object.keys(raw)) {
      if (!ENTRY_FIELDS.includes(key)) {
        errors.push(`${label} has unknown field "${key.slice(0, MAX_RELEASE_MAP_FIELD_LENGTH)}"`);
        entryOk = false;
      }
    }

    const repo = raw['repo'];
    if (typeof repo !== 'string' || repo.trim() === '') {
      errors.push(`${label}.repo must be a non-blank string`);
      entryOk = false;
    } else if (repo.length > MAX_RELEASE_MAP_FIELD_LENGTH) {
      errors.push(`${label}.repo exceeds ${MAX_RELEASE_MAP_FIELD_LENGTH} characters`);
      entryOk = false;
    } else if (seenRepos.has(repo)) {
      errors.push(`${label}.repo is a duplicate of an earlier entry`);
      entryOk = false;
    } else {
      seenRepos.add(repo);
    }

    const optional: Record<string, string | null> = {};
    for (const field of OPTIONAL_STRING_FIELDS) {
      const value = raw[field];
      if (value === undefined || value === null) {
        optional[field] = null;
      } else if (typeof value !== 'string') {
        errors.push(`${label}.${field} must be a string or null (got ${describeType(value)})`);
        entryOk = false;
      } else if (value.length > MAX_RELEASE_MAP_FIELD_LENGTH) {
        errors.push(`${label}.${field} exceeds ${MAX_RELEASE_MAP_FIELD_LENGTH} characters`);
        entryOk = false;
      } else {
        optional[field] = value;
      }
    }

    const status = raw['status'];
    if (typeof status !== 'string' || !RELEASE_MAP_STATUSES.includes(status)) {
      errors.push(`${label}.status must be one of: ${RELEASE_MAP_STATUSES.join(', ')}`);
      entryOk = false;
    }
    const tag = raw['tag'];
    if (typeof tag !== 'string' || !RELEASE_MAP_TAG_STATES.includes(tag)) {
      errors.push(`${label}.tag must be one of: ${RELEASE_MAP_TAG_STATES.join(', ')}`);
      entryOk = false;
    }

    if (entryOk) {
      map.push({
        repo: repo as string,
        release: optional['release'] ?? null,
        reference: optional['reference'] ?? null,
        environment: optional['environment'] ?? null,
        status: status as string,
        tag: tag as string,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map };
}

/**
 * Escape one value for a GFM table cell: a pipe, newline, backtick, angle
 * bracket or other markdown control character in recorded data can neither
 * end the cell, start a new row, nor inject structure (headings, HTML).
 */
function escapeCell(value: string | null): string {
  if (value === null) return '-';
  const flattened = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  if (flattened === '') return '-';
  const escaped = flattened.replace(/[\\|`*_[\]<>&~#!]/g, (ch) => {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '&') return '&amp;';
    return `\\${ch}`;
  });
  return escaped;
}

/**
 * Render a validated release map as the `**Release mapping:**` markdown block
 * appended to a MILESTONES.md entry. One table row per entry, always six cells.
 */
export function renderReleaseMapMarkdown(map: readonly ReleaseMapEntry[]): string {
  const lines = [
    '**Release mapping:**',
    '',
    '| Repository | Release | Reference | Environment | Status | Tag |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of map) {
    lines.push(
      `| ${escapeCell(entry.repo)} | ${escapeCell(entry.release)} | ${escapeCell(entry.reference)} | ${escapeCell(entry.environment)} | ${escapeCell(entry.status)} | ${escapeCell(entry.tag)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Path of the archived release map for a milestone version. */
export function releaseMapArchivePath(milestonesDir: string, version: string): string {
  return path.join(milestonesDir, `${version}-RELEASE-MAP.json`);
}

/** Serialize the archive document `{ version, entries }`. */
export function serializeReleaseMapArchive(version: string, map: readonly ReleaseMapEntry[]): string {
  return `${JSON.stringify({ version, entries: map }, null, 2)}\n`;
}

/**
 * Read and validate a caller-supplied `--release-map` file. Refuses anything
 * that is not a regular file (directory, FIFO, device), anything over 1 MiB and
 * anything unreadable or unparseable, without ever opening a non-regular file.
 */
export function loadReleaseMapFile(filePath: string): ReleaseMapValidation {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    return { ok: false, errors: [`release map file cannot be read (${code}): ${path.basename(filePath)}`] };
  }
  if (!stat.isFile()) {
    return { ok: false, errors: [`release map path is not a regular file: ${path.basename(filePath)}`] };
  }
  if (stat.size > MAX_RELEASE_MAP_FILE_BYTES) {
    return { ok: false, errors: [`release map file is ${stat.size} bytes; the maximum is ${MAX_RELEASE_MAP_FILE_BYTES}`] };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    return { ok: false, errors: [`release map file cannot be read (${code}): ${path.basename(filePath)}`] };
  }
  const parsed = safeJsonParse(text, { maxLength: MAX_RELEASE_MAP_FILE_BYTES, label: 'release map' });
  if (!parsed.ok) {
    return { ok: false, errors: [parsed.error ?? 'release map: invalid JSON'] };
  }
  return validateReleaseMap(parsed.value);
}

export type ArchivedReleaseMap =
  | { ok: true; map: ReleaseMapEntry[] | null }
  | { ok: false; error: string };

/**
 * Read a milestone's archived release map back by recorded value. A milestone
 * archived without a map yields `{ ok: true, map: null }` ("no map"), never an
 * error; a present-but-corrupt archive is reported, not guessed at.
 */
export function readArchivedReleaseMap(milestonesDir: string, version: string): ArchivedReleaseMap {
  const file = releaseMapArchivePath(milestonesDir, version);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, map: null };
    return { ok: false, error: `release map archive cannot be read: ${path.basename(file)}` };
  }
  const parsed = safeJsonParse(text, { maxLength: MAX_RELEASE_MAP_FILE_BYTES, label: 'release map archive' });
  if (!parsed.ok) return { ok: false, error: parsed.error ?? 'release map archive: invalid JSON' };
  const doc = parsed.value;
  if (!isPlainObject(doc)) return { ok: false, error: 'release map archive: expected an object' };
  const validated = validateReleaseMap(doc['entries']);
  if (!validated.ok) return { ok: false, error: validated.errors.join('; ') };
  return { ok: true, map: validated.map };
}
