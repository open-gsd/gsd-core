/**
 * Codebase Drift Detection (#2003)
 *
 * Detects structural drift between a committed codebase and the
 * `.planning/codebase/STRUCTURE.md` map produced by `gsd-codebase-mapper`.
 *
 * Six categories of drift element:
 *   - new_dir    → a newly-added file whose directory prefix does not appear
 *                  in any generated document
 *   - barrel     → a newly-added barrel export at
 *                  (packages|apps)/<name>/src/index.(ts|tsx|js|mjs|cjs)
 *   - migration  → a newly-added migration file under one of the recognized
 *                  migration directories (supabase, prisma, drizzle, src/migrations, …)
 *   - route      → a newly-added route module under a `routes/` or `api/` dir
 *   - modified   → a modified file whose directory prefix IS mapped
 *   - deleted    → a deleted file whose directory prefix IS mapped
 *
 * Inverse-territory rule (#4886, #5134): an addition is drift OUTSIDE mapped
 * territory (the map cannot describe what did not exist); a modification or
 * deletion is drift INSIDE mapped territory (the map describes it and it
 * changed). A rename is a deletion of the old path plus an addition of the new
 * path; a copy is an addition of the new path. Mapped territory is any
 * directory prefix named in ANY provided generated document.
 *
 * Each file is counted at most once; when a file matches multiple categories
 * the most specific category wins
 * (deleted > modified > migration > route > barrel > new_dir).
 *
 * Every path that leaves this module (`affectedPaths`, the `--paths` argument,
 * message bullets) passes `sanitizePaths` (#4923); dropped paths are reported
 * as data in `withheldPaths`, never interpolated into the message.
 *
 * Design decisions (see PR for full rubber-duck):
 *   - The library is pure. It takes parsed git diff output and returns a
 *     structured result. The CLI/workflow layer is responsible for running
 *     git and for spawning mappers.
 *   - `last_mapped_commit` is stored as YAML-style frontmatter at the top of
 *     each `.planning/codebase/*.md` file. This keeps the baseline attached
 *     to the file, survives git moves, and avoids a sidecar JSON.
 *   - The detector NEVER throws on malformed input — it returns a
 *     `{ skipped: true }` result. The phase workflow depends on this
 *     non-blocking guarantee.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/drift.cjs collapsed to
 * a TypeScript source of truth. Behaviour is preserved byte-for-behaviour from
 * the prior hand-written .cjs; only types are added.
 */

'use strict';

import fs from 'node:fs';
import { platformWriteSync, posixNormalize } from './shell-command-projection.cjs';
import { formatGsdSlash } from './runtime-slash.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const DRIFT_CATEGORIES = Object.freeze(['new_dir', 'barrel', 'migration', 'route', 'modified', 'deleted']);

// Category priority when a single file matches multiple rules.
// Higher index = more specific = wins.
const CATEGORY_PRIORITY: Record<string, number> = {
  new_dir: 0, barrel: 1, route: 2, migration: 3, modified: 4, deleted: 5,
};

const BARREL_RE = /^(packages|apps)\/[^/]+\/src\/index\.(ts|tsx|js|mjs|cjs)$/;

const MIGRATION_RES = [
  /^supabase\/migrations\/.+\.sql$/,
  /^prisma\/migrations\/.+/,
  /^drizzle\/meta\/.+/,
  /^drizzle\/migrations\/.+/,
  /^src\/migrations\/.+\.(ts|js|sql)$/,
  /^db\/migrations\/.+\.(sql|ts|js)$/,
  /^migrations\/.+\.(sql|ts|js)$/,
];

const ROUTE_RES = [
  /^(apps|packages)\/[^/]+\/src\/routes\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /^src\/routes\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /^src\/api\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /^(apps|packages)\/[^/]+\/src\/api\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/,
];

// A conservative allowlist for `--paths` arguments passed to the mapper:
// repo-relative path components separated by /, containing only
// alphanumerics, dash, underscore, and dot (no `..`, no `/..`).
const SAFE_PATH_RE = /^(?!.*\.\.)(?:[A-Za-z0-9_.][A-Za-z0-9_.\-]*)(?:\/[A-Za-z0-9_.][A-Za-z0-9_.\-]*)*$/;

// ─── Classification ──────────────────────────────────────────────────────────

type DriftCategory = 'barrel' | 'migration' | 'route' | 'new_dir';

/**
 * Classify a single file path into a drift category or null.
 */
function classifyFile(file: unknown): DriftCategory | null {
  if (typeof file !== 'string' || !file) return null;
  const norm = posixNormalize(file);
  if (MIGRATION_RES.some((r) => r.test(norm))) return 'migration';
  if (ROUTE_RES.some((r) => r.test(norm))) return 'route';
  if (BARREL_RE.test(norm)) return 'barrel';
  return null;
}

/**
 * True iff any prefix of `file` (dir1, dir1/dir2, …) appears as a substring
 * of `corpus` (the provided generated documents joined). Used to decide
 * whether a file is in "mapped territory".
 *
 * Matching is deliberately substring-based — the documents are free-form
 * markdown, not a structured manifest. If the map mentions `src/lib/` the
 * check `corpus.includes('src/lib')` holds.
 */
function isPathMapped(file: string, corpus: string): boolean {
  const norm = posixNormalize(file);
  const parts = norm.split('/');
  // Check prefixes from longest to shortest; any hit means "mapped".
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/');
    if (corpus.includes(prefix)) return true;
  }
  // Finally, if even the top-level dir is mentioned, count as mapped.
  if (parts.length > 0 && corpus.includes(parts[0] + '/')) return true;
  if (parts.length > 0 && corpus.includes('`' + parts[0] + '`')) return true;
  return false;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DriftElement {
  category: string;
  path: string;
}

interface DetectDriftInput {
  addedFiles?: unknown[];
  modifiedFiles?: unknown[];
  deletedFiles?: unknown[];
  documents?: unknown;
  threshold?: number;
  action?: string;
  runtime?: string;
}

interface DetectDriftResult {
  skipped: false;
  elements: DriftElement[];
  actionRequired: boolean;
  directive: string;
  spawnMapper: boolean;
  affectedPaths: string[];
  withheldPaths: string[];
  threshold: number;
  action: string;
  message: string;
  counts: {
    added: number;
    modified: number;
    deleted: number;
  };
}

interface SkippedResult {
  skipped: true;
  reason: string;
  elements: DriftElement[];
  actionRequired: false;
  directive: string;
  spawnMapper: false;
  affectedPaths: string[];
  withheldPaths: string[];
  message: string;
}

// ─── Main detection ──────────────────────────────────────────────────────────

/**
 * Detect codebase drift.
 */
function detectDrift(input: unknown): DetectDriftResult | SkippedResult {
  try {
    if (!input || typeof input !== 'object') {
      return skipped('invalid-input');
    }
    const inp = input as DetectDriftInput;
    const {
      addedFiles,
      modifiedFiles,
      deletedFiles,
      documents,
    } = inp;
    const threshold = Number.isInteger(inp.threshold) && (inp.threshold as number) >= 1
      ? (inp.threshold as number)
      : 3;
    const action = inp.action === 'auto-remap' ? 'auto-remap' : 'warn';

    // STRUCTURE.md is the one required document; the other six only widen the
    // mapped territory and are ignored when absent or not text.
    const docs = documents !== null && typeof documents === 'object'
      ? (documents as Record<string, unknown>)
      : {};
    const structureMd = docs['STRUCTURE.md'];
    if (structureMd === null || structureMd === undefined) {
      return skipped('missing-structure-md');
    }
    if (typeof structureMd !== 'string') {
      return skipped('invalid-structure-md');
    }
    const corpus = Object.values(docs)
      .filter((doc): doc is string => typeof doc === 'string')
      .join('\n');

    const added = Array.isArray(addedFiles) ? addedFiles.filter((x): x is string => typeof x === 'string') : [];
    const modified = Array.isArray(modifiedFiles) ? modifiedFiles : [];
    const deleted = Array.isArray(deletedFiles) ? deletedFiles : [];

    // Build elements. One element per file, highest-priority category wins.
    const elements: DriftElement[] = [];
    const seen = new Map<string, string>();

    const count = (file: string, category: string): void => {
      // Dedup: if we've already counted this path at higher-or-equal priority, skip
      const prior = seen.get(file);
      if (prior && CATEGORY_PRIORITY[prior] >= CATEGORY_PRIORITY[category]) return;
      seen.set(file, category);
    };

    for (const rawFile of added) {
      const file = posixNormalize(rawFile);
      const specific = classifyFile(file);
      let category: string | null = specific;
      if (!category) {
        if (!isPathMapped(file, corpus)) {
          category = 'new_dir';
        } else {
          continue; // mapped, known, ordinary file — not drift
        }
      }
      count(file, category);
    }

    // Inverse territory: an edit is drift only where the map describes the file.
    for (const [rawFiles, category] of [[modified, 'modified'], [deleted, 'deleted']] as const) {
      for (const rawFile of rawFiles) {
        if (typeof rawFile !== 'string') continue;
        const file = posixNormalize(rawFile);
        if (file && isPathMapped(file, corpus)) count(file, category);
      }
    }

    for (const [file, category] of seen.entries()) {
      elements.push({ category, path: file });
    }

    // Sort for stable output.
    elements.sort((a, b) =>
      a.category === b.category
        ? a.path.localeCompare(b.path)
        : a.category.localeCompare(b.category),
    );

    const actionRequired = elements.length >= threshold;
    let directive = 'none';
    let spawnMapper = false;
    let affectedPaths: string[] = [];
    let withheldPaths: string[] = [];
    let message = '';

    if (actionRequired) {
      directive = action;
      // The one egress seam (#4923): `affectedPaths` is the only path list
      // that reaches the result, the auto-remap line and `--paths`.
      const elementPaths = elements.map((e) => e.path);
      const chosen = chooseAffectedPaths(elementPaths);
      affectedPaths = sanitizePaths(chosen);
      const kept = new Set([...sanitizePaths(elementPaths), ...affectedPaths]);
      withheldPaths = [...new Set([...elementPaths, ...chosen].filter((p) => !kept.has(p)))].sort();
      // An empty `--paths` would remap the whole repo (#3418).
      spawnMapper = action === 'auto-remap' && affectedPaths.length > 0;
      message = buildMessage(elements, affectedPaths, withheldPaths.length, action, inp.runtime);
    }

    return {
      skipped: false,
      elements,
      actionRequired,
      directive,
      spawnMapper,
      affectedPaths,
      withheldPaths,
      threshold,
      action,
      message,
      counts: {
        added: added.length,
        modified: modified.length,
        deleted: deleted.length,
      },
    };
  } catch (err) {
    // Non-blocking: never throw from this function.
    const errMsg = (err as Error)?.message ? (err as Error).message : String(err);
    return skipped('exception:' + errMsg);
  }
}

function skipped(reason: string): SkippedResult {
  return {
    skipped: true,
    reason,
    elements: [],
    actionRequired: false,
    directive: 'none',
    spawnMapper: false,
    affectedPaths: [],
    withheldPaths: [],
    message: '',
  };
}

function buildMessage(
  elements: DriftElement[],
  affectedPaths: string[],
  withheldCount: number,
  action: string,
  runtime: string | undefined,
): string {
  const byCat: Record<string, string[]> = {};
  const listable = new Set(sanitizePaths(elements.map((e) => e.path)));
  for (const e of elements) {
    if (!listable.has(e.path)) continue;
    if (!byCat[e.category]) byCat[e.category] = [];
    byCat[e.category].push(e.path);
  }
  const lines: string[] = [
    `Codebase drift detected: ${elements.length} structural element(s) since last mapping.`,
    '',
  ];
  const labels: Record<string, string> = {
    new_dir: 'New directories',
    barrel: 'New barrel exports',
    migration: 'New migrations',
    route: 'New route modules',
    modified: 'Modified files in mapped directories',
    deleted: 'Deleted files in mapped directories',
  };
  for (const cat of DRIFT_CATEGORIES) {
    if (byCat[cat]) {
      lines.push(`${labels[cat]}:`);
      for (const p of byCat[cat]) lines.push(`  - ${p}`);
    }
  }
  lines.push('');
  // Dropped paths are counted, never named: the names are data in `withheldPaths`.
  if (withheldCount > 0) {
    lines.push(`${withheldCount} path(s) withheld: absolute, traversal or shell-metacharacter paths`);
  }
  if (affectedPaths.length === 0) {
    // Nothing safe to scope a refresh to: an empty `--paths` would remap the whole repo (#3418).
  } else if (action === 'auto-remap') {
    lines.push(`Auto-remap scheduled for paths: ${affectedPaths.join(', ')}`);
  } else {
    // drift.cts is a pure library — it must never read env/config. The
    // caller (verify.cmdVerifyCodebaseDrift) resolves the runtime once and
    // passes it in via input.runtime so emitted commands match the project
    // the caller is targeting, not the current process directory.
    const mapCmd = formatGsdSlash('map-codebase', runtime || 'claude');
    lines.push(
      `Run ${String(mapCmd)} --paths ${affectedPaths.join(',')} to refresh planning context.`,
    );
  }
  return lines.join('\n');
}

// ─── Affected paths ──────────────────────────────────────────────────────────

/**
 * Collapse a list of drifted file paths into a sorted, deduplicated list of
 * the top-level directory prefixes (depth 2 when the repo uses an
 * `<apps|packages>/<name>/…` layout; depth 1 otherwise).
 */
function chooseAffectedPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths || []) {
    if (typeof raw !== 'string' || !raw) continue;
    const file = posixNormalize(raw);
    const parts = file.split('/');
    if (parts.length === 0) continue;
    const top = parts[0];
    if ((top === 'apps' || top === 'packages') && parts.length >= 2) {
      out.add(`${top}/${parts[1]}`);
    } else {
      out.add(top);
    }
  }
  return [...out].sort();
}

/**
 * Filter `paths` to only those that are safe to splice into a mapper prompt.
 * Any path that is absolute, contains traversal, or includes shell
 * metacharacters is dropped.
 */
function sanitizePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    if (p.startsWith('/')) continue;
    if (!SAFE_PATH_RE.test(p)) continue;
    out.push(p);
  }
  return out;
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

interface FrontmatterResult {
  data: Record<string, string>;
  body: string;
}

/**
 * The block is the one the one fence owner finds (`locateFrontmatterFence`); `body` is
 * everything after the closing fence line and its line ending.
 */
function parseFrontmatter(content: unknown): FrontmatterResult {
  if (typeof content !== 'string') return { data: {}, body: '' };
  const fence = locateFrontmatterFence(content);
  if (!fence?.closed) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of content.slice(fence.openEnd, fence.bodyEnd).split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    data[kv[1]] = kv[2];
  }
  return { data, body: content.slice(fence.closingFenceEnd).replace(/^\r?\n/, '') };
}

function serializeFrontmatter(data: Record<string, string>, body: string): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return body;
  const lines = ['---'];
  for (const k of keys) lines.push(`${k}: ${data[k]}`);
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

/**
 * Read `last_mapped_commit` from the frontmatter of a `.planning/codebase/*.md`
 * file. Returns null if the file does not exist or has no frontmatter.
 */
function readMappedCommit(filePath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(content);
  const sha = data['last_mapped_commit'];
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

/**
 * Upsert `last_mapped_commit` and `last_mapped_at` into the frontmatter of
 * the given file, preserving any other frontmatter keys and the body.
 */
function writeMappedCommit(filePath: string, commitSha: string, isoDate?: string): void {
  // Symmetric with readMappedCommit (which returns null on missing files):
  // tolerate a missing target by creating a minimal frontmatter-only file
  // rather than throwing ENOENT. This matters when a mapper produces a new
  // doc and the caller stamps it before any prior content existed.
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { data, body } = parseFrontmatter(content);
  data['last_mapped_commit'] = commitSha;
  if (isoDate) data['last_mapped_at'] = isoDate;
  platformWriteSync(filePath, serializeFrontmatter(data, body));
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export = {
  DRIFT_CATEGORIES,
  classifyFile,
  detectDrift,
  chooseAffectedPaths,
  sanitizePaths,
  readMappedCommit,
  writeMappedCommit,
  // Exposed for the CLI layer to reuse the same parser.
  parseFrontmatter,
};
