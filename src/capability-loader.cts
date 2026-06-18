/**
 * capability-loader.cts — runtime Capability Registry overlay (ADR-1244 D2).
 *
 * Promotes the registry from a frozen data file to a module with an interface:
 *
 *     loadRegistry({ includeInstalled }) -> composed registry
 *
 * It composes the **first-party frozen registry** (the committed, generated
 * `capability-registry.cjs`) with a **validated installed overlay** — third-party
 * capability manifests read at runtime from per-scope install roots:
 *   - global:  $GSD_HOME/.gsd/capabilities/<id>/capability.json  (GSD_HOME defaults to ~)
 *   - project: <projectRoot>/.gsd/capabilities/<id>/capability.json
 *
 * Invariants enforced over the merged set (first-party ∪ overlay):
 *   - First-party always wins: an overlay whose `id`, owned skill/agent stem, or
 *     federated config key collides with first-party (or uses a reserved `gsd-` /
 *     `gsd-core-` / `anthropic-` id prefix) is rejected.
 *   - Load-time re-gate (default-resilient): an overlay that fails validation or
 *     whose `engines.gsd` does not satisfy the running GSD version is SKIPPED
 *     with a warning — it never crashes the loop. EXCEPTION (per-hook-kind
 *     policy): a skipped capability that declares a `gate` is recorded in
 *     `_overlay.incompatibleGateCapIds` so the loop resolver can fail CLOSED for
 *     that gate rather than silently proceeding as if it had passed.
 *
 * The merged registry is materialized by the canonical `buildRegistry`
 * (re-exported from the generator, which ships) over a cap-map reconstructed
 * from the frozen registry's capability objects plus the accepted overlay
 * capabilities — so every derived view (bySkill, byLoopPoint, configSchema,
 * capabilityClusters, profileMembership, …) is computed by exactly one builder
 * and cannot drift from the first-party path.
 *
 * Install never executes capability code here (staging/exec belongs to ADR-1244
 * D3/D5); this module only READS and VALIDATES declarations.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Registry = Record<string, unknown>;

interface CapManifest {
  id: string;
  role?: string;
  version?: string;
  skills?: string[];
  agents?: string[];
  commands?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  gates?: unknown[];
  engines?: { gsd?: string };
}

interface ValidatorModule {
  validateCapability: (cap: unknown, id: string) => string[];
  /** Returns an error array (e.g. fragment path escapes the capability dir) — NOT a throw. */
  materializeHookFragments: (cap: unknown, capDir: string) => string[];
  validateAgainstContract: (cap: unknown, capId: string) => string[];
  validateConsumesGlobal: (capMap: Map<string, unknown>) => string[];
  validateCrossCapability: (capMap: Map<string, unknown>, centralKeys: Set<string>) => string[];
}
interface SemverModule {
  semverSatisfies: (version: unknown, range: unknown) => boolean;
}
interface ProjectRootModule {
  findProjectRoot: (startDir: string) => string | null;
}
interface GeneratorModule {
  buildRegistry: (capMap: Map<string, unknown>) => Registry;
  loadCentralConfigKeys: () => Set<string>;
}

export interface LoadRegistryOptions {
  /** When true, compose the validated installed overlay on top of first-party. */
  includeInstalled?: boolean;
  /** Working directory used to locate the project-scoped overlay root. */
  cwd?: string;
  /** Override the global overlay home (defaults to GSD_HOME env or os.homedir()). */
  gsdHome?: string;
  /** Override the running GSD version used for engines.gsd satisfaction. */
  hostVersion?: string;
}

export interface OverlaySkip {
  id: string;
  scope: 'global' | 'project';
  reason: string;
}

export interface BlockedGate {
  /** Loop extension point the skipped capability declared a gate at. */
  point: string;
  /** The skipped capability's id. */
  capId: string;
  /** Why the capability was skipped. */
  reason: string;
}

export interface OverlayMeta {
  /** Capabilities skipped at load, with the reason (surfaced to the user). */
  warnings: OverlaySkip[];
  /** Skipped capabilities that declared a gate — the loop must fail CLOSED for these. */
  incompatibleGateCapIds: string[];
  /**
   * Per-point fail-closed records: for each gate a skipped capability declared at
   * a known loop point, the loop resolver must inject a blocking gate at that
   * point rather than proceeding as if the gate had passed.
   */
  blockedGates: BlockedGate[];
}

const RESERVED_ID_PREFIX = /^(gsd-|gsd-core-|anthropic-)/;
const GSD_HOME_DIRNAME = '.gsd';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve the running GSD version; fail-closed to '0.0.0' if it cannot be read. */
function readHostVersion(): string {
  try {
    // gsd-core/bin/lib/ -> repo/package root is three levels up.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const pkg: { version?: string } = require('../../../package.json');
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The ordered overlay install roots (global first, then project), deduped by
 * resolved absolute path so a single directory is never scanned twice (which
 * would otherwise self-report a spurious id collision when the project lives
 * under the GSD home, or in tests where both resolve to the same fixture).
 */
function overlayRoots(cwd: string, gsdHome?: string): Array<{ dir: string; scope: 'global' | 'project' }> {
  const roots: Array<{ dir: string; scope: 'global' | 'project' }> = [];
  const seen = new Set<string>();
  const add = (dir: string, scope: 'global' | 'project'): void => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push({ dir: resolved, scope });
  };
  const home = gsdHome || process.env['GSD_HOME'] || os.homedir();
  add(path.join(home, GSD_HOME_DIRNAME, 'capabilities'), 'global');
  let projectRoot: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const projectRootMod: ProjectRootModule = require('./project-root.cjs');
    projectRoot = projectRootMod.findProjectRoot(cwd);
  } catch {
    projectRoot = null;
  }
  if (projectRoot) {
    add(path.join(projectRoot, GSD_HOME_DIRNAME, 'capabilities'), 'project');
  }
  return roots;
}

/** Shallow-attach overlay diagnostics WITHOUT mutating the frozen registry module. */
function withOverlayMeta(reg: Registry, meta: OverlayMeta): Registry {
  return Object.assign({}, reg, { _overlay: meta });
}

/**
 * Load the capability registry, optionally composing the installed overlay.
 *
 * @returns the registry object (same shape as `capability-registry.cjs`). When
 *   overlays are considered, an `_overlay` field carries skip warnings and the
 *   fail-closed gate list. With `includeInstalled` falsy, the frozen first-party
 *   registry is returned unchanged (identity-stable).
 */
export function loadRegistry(options: LoadRegistryOptions = {}): Registry {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const base: Registry = require('./capability-registry.cjs');
  if (!options.includeInstalled) return base;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const validator: ValidatorModule = require('./capability-validator.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const semver: SemverModule = require('./semver-compare.cjs');

  const cwd = options.cwd || process.cwd();
  const hostVersion = options.hostVersion || readHostVersion();

  const warnings: OverlaySkip[] = [];
  const incompatibleGateCapIds: string[] = [];
  const blockedGates: BlockedGate[] = [];
  const overlayCaps: CapManifest[] = [];

  // First-party reservations — first-party always wins.
  const fpCaps = (base.capabilities ?? {}) as Record<string, unknown>;
  const fpBySkill = (base.bySkill ?? {}) as Record<string, unknown>;
  const fpByAgent = (base.byAgent ?? {}) as Record<string, unknown>;
  const fpConfigKeys = (base.configKeys ?? {}) as Record<string, unknown>;
  const fpConfigSchema = (base.configSchema ?? {}) as Record<string, unknown>;

  const fpFamilies = (base.commandFamilies ?? {}) as Record<string, unknown>;
  const fpIds = new Set(Object.keys(fpCaps));
  const claimedSkills = new Set(Object.keys(fpBySkill));
  const claimedAgents = new Set(Object.keys(fpByAgent));
  const claimedConfig = new Set([...Object.keys(fpConfigKeys), ...Object.keys(fpConfigSchema)]);
  const claimedFamilies = new Set(Object.keys(fpFamilies));
  const acceptedIds = new Set<string>();

  // Running merged cap-map (first-party ∪ accepted overlays). A candidate is
  // accepted only if the FULL cross-capability suite stays clean after adding it
  // (first-party alone is clean, so any new error is the candidate's fault) — the
  // overlay can never violate the same invariants the build-time generator enforces.
  const acceptedMap = new Map<string, unknown>(Object.entries(fpCaps));

  // Generator (buildRegistry + central config keys) loaded lazily — only when at
  // least one overlay candidate exists, so the no-overlay fast path stays cheap.
  let generatorMod: GeneratorModule | null = null;
  const getGenerator = (): GeneratorModule => {
    if (generatorMod) return generatorMod;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const mod: GeneratorModule = require('../../../scripts/gen-capability-registry.cjs');
    generatorMod = mod;
    return mod;
  };
  let centralKeys: Set<string> | null = null;
  const getCentralKeys = (): Set<string> => {
    if (!centralKeys) {
      try {
        centralKeys = getGenerator().loadCentralConfigKeys();
      } catch {
        centralKeys = new Set<string>();
      }
    }
    return centralKeys;
  };

  for (const root of overlayRoots(cwd, options.gsdHome)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // no overlay dir at this scope — normal
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const capDir = path.join(root.dir, id);
      const manifestPath = path.join(capDir, 'capability.json');

      let cap: CapManifest;
      try {
        cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CapManifest;
      } catch (e) {
        warnings.push({ id, scope: root.scope, reason: 'unreadable or invalid capability.json: ' + errMessage(e) });
        continue;
      }

      // Points at which this capability declares a gate — used to fail CLOSED if
      // the capability is skipped (a skipped deploy gate must block, not pass).
      const gatePoints: string[] = Array.isArray(cap.gates)
        ? (cap.gates as Array<Record<string, unknown>>)
            .map((g) => (g && typeof g === 'object' && typeof g.point === 'string' ? g.point : null))
            .filter((p): p is string => typeof p === 'string')
        : [];
      const declaresGate = gatePoints.length > 0;
      const skip = (reason: string): void => {
        warnings.push({ id, scope: root.scope, reason });
        if (declaresGate) {
          incompatibleGateCapIds.push(id);
          for (const point of gatePoints) blockedGates.push({ point, capId: id, reason });
        }
      };

      // 1. Reserved namespace — third-party may not impersonate first-party.
      if (RESERVED_ID_PREFIX.test(id)) {
        skip('id uses a reserved first-party prefix (gsd-/gsd-core-/anthropic-)');
        continue;
      }
      // 2. Per-capability structural + version-envelope validation.
      const errs = validator.validateCapability(cap, id);
      if (errs.length) {
        skip('failed validation: ' + errs.join('; '));
        continue;
      }
      // 3. First-party wins + overlay/overlay de-dup on id, skill, agent, config key.
      if (fpIds.has(id) || acceptedIds.has(id)) {
        skip('id collides with an already-registered capability');
        continue;
      }
      const skills: string[] = Array.isArray(cap.skills) ? cap.skills : [];
      const agents: string[] = Array.isArray(cap.agents) ? cap.agents : [];
      const cfgKeys: string[] = cap.config && typeof cap.config === 'object' && !Array.isArray(cap.config)
        ? Object.keys(cap.config) : [];
      const skillClash = skills.find((s) => claimedSkills.has(s));
      if (skillClash) { skip('owns skill "' + skillClash + '" already owned by another capability'); continue; }
      const agentClash = agents.find((a) => claimedAgents.has(a));
      if (agentClash) { skip('owns agent "' + agentClash + '" already owned by another capability'); continue; }
      const cfgClash = cfgKeys.find((k) => claimedConfig.has(k));
      if (cfgClash) { skip('owns config key "' + cfgClash + '" already owned by another capability'); continue; }
      const families: string[] = Array.isArray(cap.commands)
        ? cap.commands
            .map((c) => (c && typeof c === 'object' && typeof c.family === 'string' ? c.family : null))
            .filter((f): f is string => typeof f === 'string')
        : [];
      const familyClash = families.find((f) => claimedFamilies.has(f));
      if (familyClash) { skip('owns command family "' + familyClash + '" already owned by another capability'); continue; }
      // 4. Load-time engines.gsd re-gate.
      const range = cap.engines?.gsd;
      if (typeof range === 'string' && range && !semver.semverSatisfies(hostVersion, range)) {
        skip('incompatible with GSD ' + hostVersion + ' (requires engines.gsd "' + range + '")');
        continue;
      }
      // 5. Materialize path-based hook fragments (resolved against the overlay dir).
      //    materializeHookFragments RETURNS errors (e.g. a fragment path escaping the
      //    capability dir) — capture them; an un-materializable fragment is a skip.
      let fragErrs: string[];
      try {
        fragErrs = validator.materializeHookFragments(cap, capDir) || [];
      } catch (e) {
        skip('hook fragment could not be materialized: ' + errMessage(e));
        continue;
      }
      if (fragErrs.length) {
        skip('invalid hook fragment: ' + fragErrs.join('; '));
        continue;
      }
      // 6. Full cross-capability validation over the merged set (the same invariants
      //    the build-time generator enforces): contract roles, consumes-satisfiability,
      //    owner-uniqueness, config-key exclusivity vs central schema, requires acyclicity
      //    + tier-monotone. Incremental: add the candidate, validate, drop on any error.
      acceptedMap.set(id, cap);
      const crossErrs = [
        ...validator.validateAgainstContract(cap, id),
        ...validator.validateConsumesGlobal(acceptedMap),
        ...validator.validateCrossCapability(acceptedMap, getCentralKeys()),
      ];
      if (crossErrs.length) {
        acceptedMap.delete(id);
        skip('cross-capability validation failed: ' + crossErrs.slice(0, 3).join('; '));
        continue;
      }

      // Accepted.
      overlayCaps.push(cap);
      acceptedIds.add(id);
      for (const s of skills) claimedSkills.add(s);
      for (const a of agents) claimedAgents.add(a);
      for (const k of cfgKeys) claimedConfig.add(k);
      for (const f of families) claimedFamilies.add(f);
    }
  }

  const meta: OverlayMeta = { warnings, incompatibleGateCapIds, blockedGates };

  if (overlayCaps.length === 0) {
    // Nothing to compose. Return the frozen registry unchanged when there is
    // also nothing to report (identity-stable); otherwise attach diagnostics.
    if (warnings.length === 0) return base;
    return withOverlayMeta(base, meta);
  }

  // Compose via the canonical builder so every derived view matches first-party.
  // acceptedMap already holds first-party ∪ accepted overlays (validated above).
  const merged = getGenerator().buildRegistry(acceptedMap);
  return withOverlayMeta(merged, meta);
}

module.exports = { loadRegistry };
