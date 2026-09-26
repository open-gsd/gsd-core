/**
 * Codebase Drift Detection (#2003)
 *
 * Detects structural drift between a committed codebase and the
 * `.planning/codebase/STRUCTURE.md` map produced by `gsd-codebase-mapper`.
 *
 * Six categories of drift element:
 *   - new_dir    → a newly-added file whose directory prefix does not appear
 *                  in STRUCTURE.md
 *   - barrel     → a newly-added barrel export at
 *                  (packages|apps)/<name>/src/index.(ts|tsx|js|mjs|cjs)
 *   - migration  → a newly-added migration file under one of the recognized
 *                  migration directories (supabase, prisma, drizzle, src/migrations, …)
 *   - route      → a newly-added route module under a `routes/` or `api/` dir
 *   - modified   → a modified file whose directory prefix DOES appear in
 *                  STRUCTURE.md — the map describes it, and what it describes
 *                  has changed (#4886)
 *   - deleted    → a deleted file whose directory prefix appears in
 *                  STRUCTURE.md — the map describes something that is gone (#4886)
 *
 * Each file is counted at most once; when a file matches multiple categories
 * the most specific category wins (migration > route > barrel > new_dir >
 * modified = deleted). The added-file categories and the modified/deleted
 * categories are mirror images of one rule: drift is divergence between the
 * map and the tree. An ordinary added file diverges when the map does NOT
 * know its directory (a barrel, migration or route addition is drift wherever
 * it lands); a modified or deleted file diverges when the map DOES. An edit
 * in territory the map never described was never covered, so it is not drift.
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

// ─── Constants ───────────────────────────────────────────────────────────────

const DRIFT_CATEGORIES: readonly DriftCategory[] = Object.freeze(
  ['new_dir', 'barrel', 'migration', 'route', 'modified', 'deleted'] as const,
);

// Category priority when a single file matches multiple rules.
// Higher index = more specific = wins.
const CATEGORY_PRIORITY: Record<DriftCategory, number> = { modified: 0, deleted: 0, new_dir: 1, barrel: 2, route: 3, migration: 4 };

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

// The category set is mirrored at four sites in this file — DRIFT_CATEGORIES,
// CATEGORY_PRIORITY, the `labels` map, and this union. #4886 added `modified`
// and `deleted` to three of them and missed this one, which compiled because
// `DriftElement.category` was `string` and the two maps were `Record<string, _>`
// — the union documented the set without governing it. Keying both maps by this
// union makes a seventh category a compile error at every mirror rather than a
// silent omission at one.
type DriftCategory =
  | 'new_dir'
  | 'barrel'
  | 'migration'
  | 'route'
  | 'modified'
  | 'deleted';

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
 * of `structureMd`. Used to decide whether a file is in "mapped territory".
 *
 * Matching is deliberately substring-based — STRUCTURE.md is free-form
 * markdown, not a structured manifest. If the map mentions `src/lib/` the
 * check `structureMd.includes('src/lib')` holds.
 */
function isPathMapped(file: string, structureMd: string): boolean {
  const norm = posixNormalize(file);
  const parts = norm.split('/');
  // Check prefixes from longest to shortest; any hit means "mapped".
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/');
    if (structureMd.includes(prefix)) return true;
  }
  // Finally, if even the top-level dir is mentioned, count as mapped.
  if (parts.length > 0 && structureMd.includes(parts[0] + '/')) return true;
  if (parts.length > 0 && structureMd.includes('`' + parts[0] + '`')) return true;
  return false;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DriftElement {
  category: DriftCategory;
  path: string;
}

interface DetectDriftInput {
  addedFiles?: unknown[];
  modifiedFiles?: unknown[];
  deletedFiles?: unknown[];
  structureMd?: string | null;
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
  // Derived prefixes the path allowlist withheld from `affectedPaths` (#4923).
  droppedPaths: string[];
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
  droppedPaths: string[];
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
      structureMd,
    } = inp;
    const threshold = Number.isInteger(inp.threshold) && (inp.threshold as number) >= 1
      ? (inp.threshold as number)
      : 3;
    const action = inp.action === 'auto-remap' ? 'auto-remap' : 'warn';

    if (structureMd === null || structureMd === undefined) {
      return skipped('missing-structure-md');
    }
    if (typeof structureMd !== 'string') {
      return skipped('invalid-structure-md');
    }

    const added = Array.isArray(addedFiles) ? addedFiles.filter((x): x is string => typeof x === 'string') : [];
    const modified = Array.isArray(modifiedFiles) ? modifiedFiles.filter((x): x is string => typeof x === 'string') : [];
    const deleted = Array.isArray(deletedFiles) ? deletedFiles.filter((x): x is string => typeof x === 'string') : [];

    // Build elements. One element per file, highest-priority category wins.
    const elements: DriftElement[] = [];
    const seen = new Map<string, DriftCategory>();

    for (const rawFile of added) {
      const file = posixNormalize(rawFile);
      const specific = classifyFile(file);
      let category: DriftCategory | null = specific;
      if (!category) {
        if (!isPathMapped(file, structureMd)) {
          category = 'new_dir';
        } else {
          continue; // mapped, known, ordinary file — not drift
        }
      }
      // Dedup: if we've already counted this path at higher-or-equal priority, skip
      const prior = seen.get(file);
      if (prior && CATEGORY_PRIORITY[prior] >= CATEGORY_PRIORITY[category]) continue;
      seen.set(file, category);
    }

    // #4886: until this loop existed, `modified` and `deleted` reached only
    // `counts`, so a map could go arbitrarily stale through edits — the common
    // change class on a mature repo — and never be flagged at any threshold.
    // The qualifying predicate is the inverse of the added-file rule above:
    // an ordinary added file is drift when the map does NOT know its directory
    // (barrel / migration / route additions count wherever they land); a
    // modified or deleted file is drift when the map DOES, because the map's
    // description of it is now unverified. A change in territory the map
    // never described is not divergence from the map and stays out, as before.
    for (const [list, category] of [[modified, 'modified'], [deleted, 'deleted']] as const) {
      for (const rawFile of list) {
        const file = posixNormalize(rawFile);
        if (!isPathMapped(file, structureMd)) continue;
        const prior = seen.get(file);
        if (prior && CATEGORY_PRIORITY[prior] >= CATEGORY_PRIORITY[category]) continue;
        seen.set(file, category);
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
    let droppedPaths: string[] = [];
    let message = '';

    if (actionRequired) {
      directive = action;
      // #4922 review (Major): `sanitizePaths` shipped with zero production callers, so every
      // consumer of `affectedPaths` received unfiltered repo paths — this result field, which
      // `cmdVerifyCodebaseDrift` emits as `affected_paths`, AND the `--paths` argument
      // `buildMessage` splices below. This PR widened the reachable input set for that gap: a
      // mapped directory whose name carries a shell metacharacter previously reached `--paths`
      // only via an added file, and now reaches it via an edit or deletion inside it too.
      // Filtering at this single producer covers both consumers with one call. An unsafe prefix
      // is dropped from the remediation command only; `elements` still reports every drifted
      // path (posix-normalized, as it always has been), so the operator is told what drifted
      // even when it cannot be auto-remapped.
      const derivedPaths = chooseAffectedPaths(elements.map((e) => e.path));
      affectedPaths = sanitizePaths(derivedPaths);
      // #4923: a withheld prefix must be NAMED, not silently subtracted. `elements` lists
      // the drifted files, but nothing there says which directories were left out of the
      // remediation command, so a shorter `--paths` list reads as the whole of it.
      droppedPaths = derivedPaths.filter((p) => !affectedPaths.includes(p));
      // An EMPTY `affectedPaths` alongside `actionRequired: true` has TWO causes, and
      // they are not interchangeable. Filtering is the new one. The other predates it:
      // `chooseAffectedPaths` skips a falsy path, so an empty-string entry CAN yield an
      // element with no derivable prefix — only where the map does not already count it
      // as mapped, since `isPathMapped('', md)` is true for any `md` containing a slash
      // — unreachable from `cmdVerifyCodebaseDrift`,
      // which drops blank `git diff --name-status` lines, but reachable through this
      // exported function. Either way there is nothing to scope a remap to, so the
      // degrade keys on the RESULT being empty rather than on the reason.
      //
      // The degrade is on `directive`, not on `spawnMapper`, because that is what the
      // consumer reads: the execute-phase gate branches on `directive` being
      // `auto-remap` and then splices `affected_paths` into the mapper's `--paths`
      // argument. Withholding only `spawnMapper` would leave it spawning a mapper with
      // an EMPTY `--paths` — an unscoped remap of the whole tree, which is not what the
      // directive asked for. Drift is still detected and still reported; only the
      // automation is withheld, and `action` still records what was requested.
      //
      // #4923: the degrade fires on ANY withheld prefix, not only when none survives. A
      // partial remap is not a smaller correct remap: on success the gate stamps
      // STRUCTURE.md and ARCHITECTURE.md at HEAD, and the next drift check diffs from
      // that stamp, so a withheld directory's drift would be recorded as mapped without
      // ever being remapped, and never reported again.
      if (action === 'auto-remap' && (affectedPaths.length === 0 || droppedPaths.length > 0)) {
        directive = 'warn';
      }
      if (directive === 'auto-remap') {
        spawnMapper = true;
      }
      // The RESOLVED directive decides the remediation line — otherwise a degraded
      // auto-remap would still render "Auto-remap scheduled for paths:". The requested
      // action is passed too, so a degrade can say that it happened.
      message = buildMessage(elements, affectedPaths, droppedPaths, directive, action, inp.runtime);
    }

    return {
      skipped: false,
      elements,
      actionRequired,
      directive,
      spawnMapper,
      affectedPaths,
      droppedPaths,
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
    droppedPaths: [],
    message: '',
  };
}

function buildMessage(
  elements: DriftElement[],
  affectedPaths: string[],
  // Prefixes the allowlist withheld. On the empty-`affectedPaths` branch it is also what
  // separates "derived, then all withheld" from "none derivable at all".
  droppedPaths: string[],
  // The RESOLVED directive. `requestedAction` is what the config asked for; they differ
  // exactly when a requested auto-remap was degraded.
  action: string,
  requestedAction: string,
  runtime: string | undefined,
): string {
  const byCat: Record<string, string[]> = {};
  for (const e of elements) {
    if (!byCat[e.category]) byCat[e.category] = [];
    byCat[e.category].push(e.path);
  }
  const lines: string[] = [
    `Codebase drift detected: ${elements.length} structural element(s) since last mapping.`,
    '',
  ];
  const labels: Record<DriftCategory, string> = {
    new_dir: 'New directories',
    barrel: 'New barrel exports',
    migration: 'New migrations',
    route: 'New route modules',
    modified: 'Modified mapped files',
    deleted: 'Deleted mapped files',
  };
  for (const cat of DRIFT_CATEGORIES) {
    if (byCat[cat]) {
      lines.push(`${labels[cat]}:`);
      for (const p of byCat[cat]) lines.push(`  - ${renderPathForMessage(p)}`);
    }
  }
  lines.push('');
  if (affectedPaths.length > 0) {
    if (action === 'auto-remap') {
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
  } else if (droppedPaths.length === 0) {
    // Nothing was withheld, so the cause is that no prefix could be derived at all.
    // Saying "unsafe" here would send the operator looking for a hostile directory
    // name that is not there.
    lines.push(
      'No affected path could be derived for the mapper from the elements above. '
        + 'Refresh planning context by hand.',
    );
  }
  if (droppedPaths.length > 0) {
    // #4923: name every withheld prefix, whether or not any other survived. Each is
    // quoted by `quoteForMessage` so a space, a control character or a Unicode line
    // separator is visible and cannot break the line. The line carries no `--paths`
    // token: it is a report, not a command.
    lines.push(
      `Withheld from the mapper as unsafe to pass: ${droppedPaths.map(quoteForMessage).join(', ')}. `
        + `Refresh planning context for ${droppedPaths.length === 1 ? 'it' : 'them'} by hand.`,
    );
  }
  if (requestedAction === 'auto-remap' && action !== 'auto-remap') {
    // An operator who configured auto-remap and got a warn needs to know the automation
    // was withheld on purpose, and why — otherwise it reads as auto-remap being broken.
    lines.push(
      affectedPaths.length > 0
        ? 'Auto-remap was not run: remapping only the other paths would record the map as '
          + 'current past the withheld ones.'
        : 'Auto-remap was not run: no affected path can be passed to the mapper.',
    );
  }
  return lines.join('\n');
}

// JSON.stringify escapes only the C0 controls, `"`, `\` and lone surrogates. It leaves
// U+2028 and U+2029 literal, and many renderers break a line on them. It also leaves every
// other invisible or look-alike character literal: the C1 controls (U+0085 is NEL),
// zero-width and soft-hyphen break opportunities, the bidirectional marks and overrides,
// the BOM, and the non-ASCII spaces (U+00A0, U+3000, ...) that render as a space while
// being a different character. An enumerated escape list misses members, so escape by
// general category instead: every control (Cc), format (Cf) and separator (Z*) code point
// except the ASCII space is escaped. JSON.stringify has already escaped the C0 controls,
// a few in short forms such as `\n`; every other match becomes `\uXXXX`. So a withheld
// prefix renders as one token that cannot break or reorder the line. An astral code point
// is written as its UTF-16 surrogate pair, so every token stays valid JSON and reads back
// exactly. Combining marks (Mn/Me) are left alone on purpose. Some are invisible (U+034F,
// the variation selectors), but none breaks or reorders the line, and escaping marks would
// mangle a decomposed accented name.
const INVISIBLE_IN_MESSAGE_RE = /(?! )[\p{Cc}\p{Cf}\p{Z}]/gu;

// Non-global twin of INVISIBLE_IN_MESSAGE_RE for a presence test: `.test()` on a /g regex
// carries `lastIndex` between calls and would skip matches on alternate paths.
const HAS_INVISIBLE_IN_MESSAGE_RE = /(?! )[\p{Cc}\p{Cf}\p{Z}]/u;

// The element list prints drifted paths as they are, which is what an operator wants to
// read. A path carrying a newline, another control or format character, or a non-ASCII
// space would then inject lines into, reorder, or disguise the message the gate prints
// verbatim. That was reachable through an added file before #4886, and the modified/deleted
// categories widen it to any edit or deletion in mapped territory. So a path carrying a
// Cc, Cf or Z* code point other than the ASCII space is quoted and escaped by
// `quoteForMessage`; every other path, combining marks included, prints byte-identical to
// before.
function renderPathForMessage(p: string): string {
  return HAS_INVISIBLE_IN_MESSAGE_RE.test(p) ? quoteForMessage(p) : p;
}

function quoteForMessage(p: string): string {
  return JSON.stringify(p).replace(INVISIBLE_IN_MESSAGE_RE, (c) => {
    let out = '';
    for (let i = 0; i < c.length; i++) {
      out += '\\u' + c.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return out;
  });
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
    // A path made only of `.` components clears SAFE_PATH_RE — each is shell-safe and
    // none is traversal — but it denotes the whole repository, so splicing it into
    // `--paths` produces exactly the unscoped remap this filter and the auto-remap
    // degrade exist to prevent. It is reachable: `chooseAffectedPaths` takes the first
    // component, so any `./x` path derives the prefix `.`. Tested component-wise rather
    // than against the literal `.`, because `./.` and `././.` are the same request
    // spelled differently and an exact compare admits both. Dropping them here lets the
    // empty-list degrade take over. `./src` is unaffected — not every component is `.`.
    if (p.split('/').every((seg) => seg === '.')) continue;
    if (!SAFE_PATH_RE.test(p)) continue;
    out.push(p);
  }
  return out;
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface FrontmatterResult {
  data: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: unknown): FrontmatterResult {
  if (typeof content !== 'string') return { data: {}, body: '' };
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    data[kv[1]] = kv[2];
  }
  return { data, body: content.slice(m[0].length) };
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
