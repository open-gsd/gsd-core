/**
 * Spec-completeness edge-probe — reference core (ADR-457 model).
 *
 * Authored as strict TypeScript (`src/edge-probe.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/edge-probe.cjs`. Do NOT hand-write the `.cjs`; it is
 * emitted, never edited. Tests `require()` the built artifact; `pretest` runs
 * `build:lib` first. Mirrors the `src/semver-compare.cts` pilot for style.
 *
 * Pure and dependency-free: it classifies each requirement's data/behavior
 * shape, filters the closed 8-category edge taxonomy to applicable categories,
 * proposes concrete candidate edges, and merges author resolutions into a
 * coverage report — with dismissal-requires-a-reason validation.
 */

/** The five data/behavior shapes a requirement can exhibit. */
export type Shape = 'numeric-range' | 'collection' | 'text' | 'stateful' | 'io';

/** A single edge taxonomy category. */
export interface TaxonomyEntry {
  id: string;
  name: string;
  shapes: Shape[];
  probe: string;
}

/**
 * Word-boundary cues mapping requirement prose -> data/behavior shape.
 * Heuristic and intentionally lossy; an authored `shapes` array overrides it.
 */
export const SHAPE_CUES: Record<Shape, RegExp> = {
  'numeric-range': /\b(round(ing|ed)?|threshold|max(imum)?|min(imum)?|limit|bound(ary)?|between|cap|percent|amount|price|count|number|score|rate|decimal)\b/i,
  'collection': /\b(lists?|arrays?|sets?|items?|collections?|each|every|all|sort(ed|ing)?|merge|dedupe|group|ranges?|intervals?|overlap(ping)?)\b/i,
  'text': /\b(string|text|names?|labels?|truncate|substring|char(acter)?s?|length|slug|message|unicode)\b/i,
  'stateful': /\b(save|persist|store|update|toggle|create|delete|remove|submit|retry|apply|register|insert)\b/i,
  'io': /\b(files?|requests?|fetch|upload|download|network|api|endpoints?|connections?|sockets?)\b/i,
};

/** The locked shape vocabulary — exactly the keys of SHAPE_CUES (single source of truth). */
export const VALID_SHAPES: ReadonlySet<string> = new Set(Object.keys(SHAPE_CUES));

/** Detect which shapes a requirement's prose matches (heuristic). */
export function classifyShape(text: string): Shape[] {
  const shapes: Shape[] = [];
  const subject = String(text == null ? '' : text);
  for (const shape of Object.keys(SHAPE_CUES) as Shape[]) {
    if (SHAPE_CUES[shape].test(subject)) shapes.push(shape);
  }
  return shapes;
}

/**
 * Closed taxonomy of 8 domain-boundary edge categories (established QA names).
 * `shapes` lists which requirement shapes make the category relevant.
 */
export const TAXONOMY: TaxonomyEntry[] = [
  { id: 'boundary', name: 'Boundary values', shapes: ['numeric-range'], probe: 'What happens exactly at each min/max/threshold — and one step either side?' },
  { id: 'adjacency', name: 'Adjacency / touching', shapes: ['collection'], probe: 'When two things are exactly equal or just touch, do they merge, collide, or separate?' },
  { id: 'empty', name: 'Empty / degenerate', shapes: ['collection', 'text'], probe: 'What is the result for empty, single-element, or null input?' },
  { id: 'encoding', name: 'Encoding / representation', shapes: ['text'], probe: 'Whose definition of length/equality applies — bytes, code points, grapheme clusters, or normalized form?' },
  { id: 'ordering', name: 'Ordering / stability', shapes: ['collection'], probe: 'When elements compare equal, is output order specified and stable?' },
  { id: 'precision', name: 'Precision / overflow', shapes: ['numeric-range'], probe: 'Where can precision loss or overflow occur, and what is the contract?' },
  { id: 'idempotency', name: 'Idempotency / repetition', shapes: ['stateful'], probe: 'What happens if this runs twice on the same input?' },
  { id: 'concurrency', name: 'Concurrency / effect ordering', shapes: ['stateful', 'io'], probe: 'If interrupted or run in parallel, what is guaranteed?' },
];

/** Return taxonomy category ids whose applicable shapes intersect the input set. */
export function applicableCategories(shapes: Shape[]): string[] {
  const set = new Set<Shape>(shapes);
  return TAXONOMY.filter((c) => c.shapes.some((s) => set.has(s))).map((c) => c.id);
}

/** The four resolution statuses an edge can carry. */
export type Status = 'unresolved' | 'covered' | 'dismissed' | 'backstop';

/** The LOCKED set of valid resolution statuses. */
export const VALID_STATUS: Status[] = ['unresolved', 'covered', 'dismissed', 'backstop'];

/** A SPEC requirement; `shapes` is an optional authored override of classification. */
export interface Requirement {
  id: string;
  text: string;
  shapes?: Shape[];
}

/** A proposed or resolved edge for a requirement/category pair. */
export interface Edge {
  requirement_id: string;
  category: string;
  status: Status;
  resolution: string | null;
  reason: string | null;
  probe: string;
}

/** An author resolution merged onto a proposed edge. */
export interface Resolution {
  requirement_id: string;
  category: string;
  status: Status;
  resolution?: string | null;
  reason?: string | null;
}

/** A coverage report: the merged edge items plus rollup counts. */
export interface CoverageReport {
  items: Edge[];
  coverage: { applicable: number; resolved: number; unresolved: number };
}

/**
 * Propose candidate edges for a requirement. Uses authored `shapes` when
 * present, else classifies from prose. Every proposed edge starts unresolved.
 */
/**
 * Validate a single requirement's structural fields — fail closed on malformed input rather
 * than coercing/ignoring it (adversarial-review hardening). Typed loosely because the CLI
 * casts arbitrary parsed JSON to `Requirement`, so these fields can violate the type at runtime.
 */
export function validateRequirement(requirement: Requirement): void {
  const r = requirement as unknown as { id?: unknown; text?: unknown; shapes?: unknown };
  if (typeof r.id !== 'string' || !r.id.trim()) {
    throw new Error(`requirement id must be a non-empty string (got ${JSON.stringify(r.id)})`);
  }
  if (r.text != null && typeof r.text !== 'string') {
    throw new Error(`requirement ${r.id} text must be a string when present`);
  }
  if (r.shapes != null && !Array.isArray(r.shapes)) {
    // A bare string like shapes:"numeric-range" would otherwise fall through to prose
    // classification, silently ignoring the authored override (Array.isArray is false for it).
    throw new Error(`requirement ${r.id} shapes must be an array when present`);
  }
}

export function proposeEdges(requirement: Requirement): Edge[] {
  validateRequirement(requirement);
  let shapes: Shape[];
  if (Array.isArray(requirement.shapes)) {
    // Fail closed: an authored array must contain only locked shape values. A non-empty
    // but invalid array (e.g. ['numeric'], a typo for 'numeric-range') would otherwise
    // intersect no category and silently suppress every probe — the gate reads green while
    // nothing was checked. An empty array stays a valid "no applicable categories" override.
    for (const s of requirement.shapes) {
      if (typeof s !== 'string' || !VALID_SHAPES.has(s)) {
        throw new Error(
          `invalid shape ${JSON.stringify(s)} for requirement ${requirement.id} — must be one of: ${[...VALID_SHAPES].join(', ')}`,
        );
      }
    }
    shapes = requirement.shapes;
  } else {
    shapes = classifyShape(requirement.text);
  }
  return applicableCategories(shapes).map((catId): Edge => {
    const cat = TAXONOMY.find((c) => c.id === catId);
    return {
      requirement_id: requirement.id,
      category: catId,
      status: 'unresolved',
      resolution: null,
      reason: null,
      probe: cat ? cat.probe : '',
    };
  });
}

/**
 * Validate a resolution: rejects an unknown status, a dismissal without a non-empty
 * reason (EP-04), and a covered/backstop without non-empty resolution text — both must
 * carry a criterion/note for plan-phase to lift. Returns true on success.
 */
export function validateResolution(r: Resolution): true {
  if (!VALID_STATUS.includes(r.status)) {
    throw new Error(`invalid status "${r.status}" for ${r.requirement_id}::${r.category}`);
  }
  if (r.status === 'dismissed' && !(r.reason && String(r.reason).trim())) {
    throw new Error(`dismissed requires a reason (${r.requirement_id}::${r.category})`);
  }
  if (r.status === 'covered' && !(r.resolution && String(r.resolution).trim())) {
    throw new Error(`covered requires a resolution (${r.requirement_id}::${r.category})`);
  }
  if (r.status === 'backstop' && !(r.resolution && String(r.resolution).trim())) {
    throw new Error(`backstop requires a resolution note (${r.requirement_id}::${r.category})`);
  }
  return true;
}

/**
 * Merge author resolutions onto proposed edges and roll up coverage counts.
 * `resolved` = covered + dismissed + backstop. Throws on any invalid resolution.
 */
export function analyzeCoverage(requirements: Requirement[], resolutions: Resolution[] = []): CoverageReport {
  if (!Array.isArray(requirements)) {
    throw new Error('requirements must be an array');
  }
  const key = (r: { requirement_id: string; category: string }): string => `${r.requirement_id}::${r.category}`;
  const resMap = new Map<string, Resolution>();
  for (const r of resolutions) {
    validateResolution(r);
    if (resMap.has(key(r))) {
      throw new Error(`duplicate resolution for ${key(r)}`);
    }
    resMap.set(key(r), r);
  }
  const items: Edge[] = [];
  const proposedKeys = new Set<string>();
  const seenReqIds = new Set<string>();
  for (const req of requirements) {
    validateRequirement(req);
    if (seenReqIds.has(req.id)) {
      throw new Error(`duplicate requirement id ${JSON.stringify(req.id)}`);
    }
    seenReqIds.add(req.id);
    for (const edge of proposeEdges(req)) {
      proposedKeys.add(key(edge));
      const o = resMap.get(key(edge));
      items.push(o
        ? { ...edge, status: o.status, resolution: o.resolution ?? null, reason: o.reason ?? null }
        : edge);
    }
  }
  // Reject orphan resolutions — a resolution whose (requirement_id, category) matches no
  // proposed edge (typo'd category or a non-applicable one) would otherwise be silently
  // dropped, leaving the author believing an edge is covered while the report shows it
  // unresolved (adversarial-review HIGH).
  for (const k of resMap.keys()) {
    if (!proposedKeys.has(k)) {
      throw new Error(`unknown resolution for ${k} — no matching proposed edge (typo'd category or non-applicable shape?)`);
    }
  }
  const isResolved = (s: Status): boolean => s === 'covered' || s === 'dismissed' || s === 'backstop';
  const resolved = items.filter((i) => isResolved(i.status)).length;
  const unresolved = items.filter((i) => i.status === 'unresolved').length;
  return { items, coverage: { applicable: items.length, resolved, unresolved } };
}

/*
 * CLI entry (EP-06 invokable surface): `edge-probe.cjs <requirements.json> [resolutions.json]`.
 *
 * The build (tsconfig.build.json) sets `"types": []` to keep this source portable and free
 * of an `@types/node` dependency, so the Node/CommonJS globals are declared locally with the
 * minimal surface this block uses. (The pure exported core above touches no Node globals.)
 */
declare const process: {
  argv: string[];
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  exit(code: number): never;
};
declare const require: ((id: string) => unknown) & { main?: unknown };
declare const module: unknown;

/**
 * Reads and parses the requirements file (and optional resolutions file), runs
 * `analyzeCoverage`, and writes the report as pretty JSON + newline to stdout. With no
 * requirements path, writes the usage line to stderr and exits 2. The `--auto` resolution
 * policy is spec-phase glue (Step 5.5, Plan 03); the script's job is the coverage compute.
 * Guarded by `require.main === module` so it runs only when the compiled `.cjs` is executed
 * directly, never on import.
 */
if (require.main === module) {
  const fs = require('node:fs') as { readFileSync(p: string, enc: 'utf8'): string };
  const reqPath: string | undefined = process.argv[2];
  const resPath: string | undefined = process.argv[3];
  if (!reqPath) {
    process.stderr.write('usage: edge-probe.cjs <requirements.json> [resolutions.json]\n');
    process.exit(2);
  }
  let requirements: Requirement[];
  try {
    requirements = JSON.parse(fs.readFileSync(reqPath, 'utf8')) as Requirement[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write('error: cannot parse JSON from ' + reqPath + ': ' + msg + '\n');
    process.exit(2);
  }
  let resolutions: Resolution[] = [];
  if (resPath) {
    try {
      resolutions = JSON.parse(fs.readFileSync(resPath, 'utf8')) as Resolution[];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write('error: cannot parse JSON from ' + resPath + ': ' + msg + '\n');
      process.exit(2);
    }
  }
  try {
    const report = analyzeCoverage(requirements, resolutions);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (e: unknown) {
    // Handled failure (e.g. an invalid authored shape or resolution) — stderr + exit 2,
    // consistent with the JSON-parse error path above, never an uncaught stack trace.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write('error: ' + msg + '\n');
    process.exit(2);
  }
}
