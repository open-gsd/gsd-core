/**
 * probe-core — generic spec-phase probe resolution model (ADR-550 Decision 7).
 *
 * Extracted from the edge-probe (the first adapter) once the prohibition probe (#644)
 * proved it the *second* adapter of the same model: one adapter is a hypothetical seam,
 * two is a real one. This module owns everything generic — the resolution lifecycle,
 * the status×verification re-cut, `validateResolution`/`validateRequirement`, the
 * `analyzeCoverage(items, resolutions?, validators)` merge/rollup/orphan-reject engine,
 * the `byVerification` rollup, and the `runProbeCli` I/O scaffold. Each probe is a thin
 * adapter: it supplies the proposal logic (deterministic for edge, LLM-recall for
 * prohibition) and its closed vocabularies via injected validators.
 *
 * Authored as strict TypeScript (`src/probe-core.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/probe-core.cjs`. Do NOT hand-write the `.cjs`; it is emitted.
 *
 * Two orthogonal axes (the re-cut):
 *   - status: resolved | dismissed | unresolved   — the resolution LIFECYCLE (shared)
 *   - verification: <probe-defined> | null          — HOW a resolved item is verified
 * The edge adapter declares `verification: explicit | backstop`; the prohibition adapter
 * (#644) will declare `test | judgment`. Splitting the axes keeps the lifecycle enum free
 * of a verification fact and lets a sibling probe add its own tiers without a parallel enum.
 *
 * Typing is hybrid (ADR-550 #5): generic type params for adapter DX, but enforcement runs
 * through injected runtime validators, because the CLI executes over JSON where TS types are
 * erased. The contract test pins the validators, not the types.
 */

import fs from 'node:fs';

/** Resolution lifecycle — shared across every probe adapter. */
export type Status = 'resolved' | 'dismissed' | 'unresolved';

/** The LOCKED set of valid lifecycle statuses (the re-cut: no covered/backstop). */
export const VALID_STATUS: Status[] = ['resolved', 'dismissed', 'unresolved'];

/**
 * A proposed or resolved item for a requirement/category pair. Generic over the probe's
 * verification-tier vocabulary `V` (edge: `'explicit' | 'backstop'`). A freshly proposed
 * item is `{ status: 'unresolved', verification: null, resolution: null, reason: null }`.
 */
export interface Item<V extends string = string> {
  requirement_id: string;
  category: string;
  status: Status;
  verification: V | null;
  resolution: string | null;
  reason: string | null;
  probe: string;
}

/** An author resolution merged onto a proposed item. */
export interface Resolution<V extends string = string> {
  requirement_id: string;
  category: string;
  status: Status;
  verification?: V | null;
  resolution?: string | null;
  reason?: string | null;
}

/** A coverage report: the merged items plus rollup counts (incl. the per-tier breakdown). */
export interface CoverageReport<V extends string = string> {
  items: Item<V>[];
  coverage: {
    applicable: number;
    resolved: number;
    unresolved: number;
    byVerification: Record<string, number>;
  };
}

/**
 * The injected runtime enforcement contract (ADR-550 #5). The probe declares its closed
 * vocabularies so `analyzeCoverage`/`validateResolution` can enforce them at the JSON
 * boundary where TS types no longer exist.
 *   - `categories` — the probe's valid category ids (a proposed item outside this set is an
 *     adapter bug, caught rather than silently rolled up).
 *   - `verification` — the valid verification tiers for a `resolved` item.
 *   - `requiredFieldsByVerification` — for each tier, which resolution fields MUST be a
 *     non-empty string (edge: every tier needs `resolution` text for plan-phase to lift).
 */
export interface Validators {
  categories: string[];
  verification: string[];
  requiredFieldsByVerification: Record<string, Array<'resolution' | 'reason'>>;
}

/** A generic requirement — every probe ingests at least `{ id, text }`. */
export interface Requirement {
  id: string;
  text?: string;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Structural guard for the report an adapter's `analyze` returns. The scaffold types `analyze`
 * loosely (it runs over JSON-parsed input the adapter `as`-casts), so a future adapter (#644)
 * that forgets to validate inside its closure could hand back a malformed object. Rather than
 * stringify garbage as green output, `runProbeCli` checks the report shape and fails closed.
 */
function isValidReport(report: unknown): report is CoverageReport {
  if (report == null || typeof report !== 'object') return false;
  const r = report as { items?: unknown; coverage?: unknown };
  if (!Array.isArray(r.items)) return false;
  const c = r.coverage as
    | { applicable?: unknown; resolved?: unknown; unresolved?: unknown; byVerification?: unknown }
    | undefined;
  if (c == null || typeof c !== 'object') return false;
  if (typeof c.applicable !== 'number' || typeof c.resolved !== 'number' || typeof c.unresolved !== 'number') {
    return false;
  }
  if (c.byVerification == null || typeof c.byVerification !== 'object') return false;
  return true;
}

/**
 * Validate a requirement's generic structural fields — fail closed on malformed input rather
 * than coercing it. Probe-specific fields (e.g. the edge adapter's `shapes`) are validated by
 * the adapter. Typed loosely because the CLI casts arbitrary parsed JSON to `Requirement`.
 */
export function validateRequirement(requirement: Requirement): void {
  const r = requirement as unknown as { id?: unknown; text?: unknown };
  if (typeof r.id !== 'string' || !r.id.trim()) {
    throw new Error(`requirement id must be a non-empty string (got ${JSON.stringify(r.id)})`);
  }
  if (r.text != null && typeof r.text !== 'string') {
    throw new Error(`requirement ${r.id} text must be a string when present`);
  }
}

/**
 * Validate a resolution against the probe's injected validators. Rejects an unknown status,
 * a dismissal without a non-empty reason, a `resolved` item with a missing/unknown
 * verification tier, and a `resolved` item missing any field its tier requires (per
 * `requiredFieldsByVerification`). Returns true on success.
 */
export function validateResolution<V extends string>(r: Resolution<V>, validators: Validators): true {
  const key = `${r.requirement_id}::${r.category}`;
  if (!VALID_STATUS.includes(r.status)) {
    throw new Error(`invalid status "${r.status}" for ${key}`);
  }
  // Invariant (this module's header): `verification` is null unless `status` is `resolved`.
  // Enforce it for EVERY status — a dismissed/unresolved resolution carrying a verification
  // tier would otherwise merge verbatim (`analyzeCoverage` below) and silently break the
  // model for the second adapter (#644) that inherits this seam. Fail closed across the full
  // status×verification space, not just `resolved`.
  if (r.status !== 'resolved' && r.verification != null) {
    throw new Error(`verification must be null unless status is "resolved" (got "${r.verification}") for ${key}`);
  }
  // An `unresolved` resolution is an UNACTED item: it must carry no resolution/reason payload.
  // A populated payload is an authoring mistake (the author meant resolved/dismissed) that
  // would otherwise be silently dropped into the unresolved count with no error pointing at
  // it. Reject it so the mistake surfaces.
  if (r.status === 'unresolved') {
    if (r.resolution != null && String(r.resolution).trim()) {
      throw new Error(`unresolved must not carry a resolution (${key})`);
    }
    if (r.reason != null && String(r.reason).trim()) {
      throw new Error(`unresolved must not carry a reason (${key})`);
    }
  }
  if (r.status === 'dismissed' && !(r.reason && String(r.reason).trim())) {
    throw new Error(`dismissed requires a reason (${key})`);
  }
  if (r.status === 'resolved') {
    const tier = r.verification;
    if (tier == null) {
      throw new Error(`resolved requires a verification tier (one of: ${validators.verification.join(', ')}) for ${key}`);
    }
    if (!validators.verification.includes(tier)) {
      throw new Error(`invalid verification "${tier}" for ${key} — must be one of: ${validators.verification.join(', ')}`);
    }
    const required = validators.requiredFieldsByVerification[tier] ?? [];
    for (const field of required) {
      // field is 'resolution' | 'reason'; both are `string | null | undefined` on Resolution,
      // so the indexed access is string-typed (no unknown-to-string coercion).
      const value = r[field];
      if (!(value != null && String(value).trim())) {
        throw new Error(`${tier} requires a ${field} (${key})`);
      }
    }
  }
  return true;
}

/**
 * Merge author resolutions onto ALREADY-PROPOSED items and roll up coverage counts.
 *
 * Core operates on `items[]`, never a `proposeFn`: probes have different deterministic
 * surfaces (edge = deterministic propose + LLM resolve; prohibition = LLM propose + deterministic
 * validate/merge), so proposal stays in each adapter and core must not assume it is deterministic.
 *
 * `coverage.resolved` is the COUNT of CLOSED items (`resolved` + `dismissed` status) =
 * `applicable - unresolved` — the pre-re-cut "covered + dismissed + backstop" set,
 * count-preserved. `byVerification` breaks the `resolved`-status items down by tier (each tier
 * initialized to 0). Throws on any invalid resolution, a duplicate, an orphan (a resolution
 * matching no proposed item), or a proposed item whose category is outside `validators.categories`.
 */
export function analyzeCoverage<V extends string>(
  items: Item<V>[],
  resolutions: Resolution<V>[] = [],
  validators: Validators,
): CoverageReport<V> {
  if (!Array.isArray(items)) {
    throw new Error('items must be an array');
  }
  const key = (r: { requirement_id: string; category: string }): string => `${r.requirement_id}::${r.category}`;
  const resMap = new Map<string, Resolution<V>>();
  for (const r of resolutions) {
    validateResolution(r, validators);
    if (resMap.has(key(r))) {
      throw new Error(`duplicate resolution for ${key(r)}`);
    }
    resMap.set(key(r), r);
  }
  const validCategories = new Set(validators.categories);
  const merged: Item<V>[] = [];
  const itemKeys = new Set<string>();
  for (const item of items) {
    if (!validCategories.has(item.category)) {
      throw new Error(`item ${key(item)} has unknown category "${item.category}" — not one of: ${validators.categories.join(', ')}`);
    }
    itemKeys.add(key(item));
    const o = resMap.get(key(item));
    if (o) {
      merged.push({ ...item, status: o.status, verification: o.verification ?? null, resolution: o.resolution ?? null, reason: o.reason ?? null });
    } else {
      // No author resolution: the item is rolled up VERBATIM, so its own status/fields must be
      // valid too. The edge adapter only proposes `unresolved` items, but the prohibition adapter
      // (#644) proposes LLM-generated items that arrive already populated — one carrying an
      // out-of-enum status (e.g. the dropped "covered") or `dismissed` with no reason would
      // otherwise be counted closed without validation. An Item is structurally a superset of a
      // Resolution, so the same fail-closed check guards both. (ADR-550 Decision 5 hardens this
      // shared seam for the second adapter; m1.)
      validateResolution(item as unknown as Resolution<V>, validators);
      merged.push(item);
    }
  }
  // Reject orphan resolutions — a resolution whose (requirement_id, category) matches no
  // proposed item (typo'd category or a non-applicable one) would otherwise be silently
  // dropped, leaving the author believing an item is resolved while the report shows it
  // unresolved (adversarial-review HIGH; preserved from the edge-probe's original engine).
  for (const k of resMap.keys()) {
    if (!itemKeys.has(k)) {
      throw new Error(`unknown resolution for ${k} — no matching proposed item (typo'd category or non-applicable shape?)`);
    }
  }
  const unresolved = merged.filter((i) => i.status === 'unresolved').length;
  const applicable = merged.length;
  const resolved = applicable - unresolved; // closed set: resolved-status + dismissed
  const byVerification: Record<string, number> = {};
  for (const tier of validators.verification) byVerification[tier] = 0;
  for (const i of merged) {
    if (i.status === 'resolved' && i.verification != null) {
      byVerification[i.verification] = (byVerification[i.verification] ?? 0) + 1;
    }
  }
  return { items: merged, coverage: { applicable, resolved, unresolved, byVerification } };
}

/*
 * CLI scaffold (the EP-06 invokable surface, generalized). Each probe ships one bin that
 * calls `runProbeCli` with its own `analyze` (closing over the adapter's propose + validators)
 * and usage string; a single dispatcher CLI is a deferred follow-on. The I/O dependencies are
 * injectable so the generic plumbing is unit-testable without spawning a process.
 *
 * `tsconfig.build.json` sets `"types": ["node"]`, so `process` and `node:fs` are typed.
 */

/** Injectable I/O for `runProbeCli` (defaults wire to the real process). */
export interface ProbeCliOptions {
  usage: string;
  argv?: string[];
  readFile?: (path: string) => string;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
  exit?: (code: number) => void;
}

/**
 * Read the requirements file (and optional resolutions file), run the adapter's `analyze`,
 * and write the report as pretty JSON + newline. With no requirements path, writes the usage
 * line to stderr and exits 2. A JSON-parse failure or any `analyze` throw is a handled error:
 * stderr + exit 2, never an uncaught stack trace — so the engine's fail-closed validation
 * surfaces at the workflow boundary rather than failing open.
 */
export function runProbeCli(
  analyze: (requirements: unknown, resolutions: unknown) => CoverageReport,
  options: ProbeCliOptions,
): void {
  const argv = options.argv ?? process.argv;
  const readFile = options.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const write = options.write ?? ((s: string) => { process.stdout.write(s); });
  const writeErr = options.writeErr ?? ((s: string) => { process.stderr.write(s); });
  const exit = options.exit ?? ((code: number) => { process.exit(code); });

  const reqPath: string | undefined = argv[2];
  const resPath: string | undefined = argv[3];
  if (!reqPath) {
    writeErr(`usage: ${options.usage}\n`);
    exit(2);
    return;
  }
  let requirements: unknown;
  try {
    requirements = JSON.parse(readFile(reqPath));
  } catch (e: unknown) {
    writeErr(`error: cannot parse JSON from ${reqPath}: ${errMessage(e)}\n`);
    exit(2);
    return;
  }
  let resolutions: unknown = [];
  if (resPath) {
    try {
      resolutions = JSON.parse(readFile(resPath));
    } catch (e: unknown) {
      writeErr(`error: cannot parse JSON from ${resPath}: ${errMessage(e)}\n`);
      exit(2);
      return;
    }
  }
  try {
    const report = analyze(requirements, resolutions);
    if (!isValidReport(report)) {
      throw new Error('adapter returned a structurally-invalid coverage report (expected { items[], coverage{ applicable, resolved, unresolved, byVerification } })');
    }
    write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (e: unknown) {
    writeErr(`error: ${errMessage(e)}\n`);
    exit(2);
  }
}
