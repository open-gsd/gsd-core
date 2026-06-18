/**
 * Capability trust gate — ADR-1244 Phase 4 (Decision D5 + the compatibility half of D6).
 *
 * PURE module. It computes *what* a capability would do and *whether* policy allows it; it
 * never mutates the filesystem and never performs I/O beyond reading staged files to confirm
 * declared executable artifacts exist. The actual consent decision (yes/no) is passed in by the
 * caller — GSD has no interactive-prompt layer in lib (the runtime/CLI edge owns that), so the
 * gate stays testable and side-effect-free. See docs/explanation/the-capability-trust-model.md.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, and ./semver-compare.cjs.
 *
 * Exports:
 *   RESERVED_NAMESPACES               — id prefixes third parties may not claim
 *   discloseExecutableSurfaces(...)   — enumerate hooks / command modules / mcpServers
 *   checkReservedNamespace(id)        — is this id in a reserved namespace?
 *   evaluateSourceAllowed(parsed,...) — strictKnownRegistries enforcement
 *   checkEngines(manifest, host)      — engines.gsd hard gate + compatVersions downgrade
 *   evaluateInstallTrust(args)        — compose: source + namespace + engines + disclosure
 *   executableSetChanged(old, new)    — did the executable surface set change between versions?
 *   summarizeDisclosure(disclosure)   — human-readable consent-prompt lines
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs') as {
  semverSatisfies: (version: string, range: string) => boolean;
  isSemverNewer: (a: string, b: string) => boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Id prefixes reserved for first-party / vendor capabilities. A third-party capability whose
 * id begins with any of these is rejected at install so it cannot impersonate a first-party
 * one. Match is case-insensitive on the normalized id.
 */
const RESERVED_NAMESPACES = ['gsd-', 'gsd-core-', 'anthropic-'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CapabilityManifest {
  id?: unknown;
  version?: unknown;
  engines?: unknown;
  compatVersions?: unknown;
  hooks?: unknown;
  commands?: unknown;
  mcpServers?: unknown;
  [k: string]: unknown;
}

interface HookSurface {
  event: string;
  script: string;
}

interface CommandModuleSurface {
  family: string;
  module: string;
}

interface McpServerSurface {
  name: string;
  /** The command the server spawns (the actual executable — disclosed for honest consent). */
  command: string;
  /** Arguments passed to the command. */
  argv: string[];
}

interface Disclosure {
  /** Hook scripts the capability registers (each runs as a runtime hook command). */
  hooks: HookSurface[];
  /** Command modules the capability ships (each is require()'d into the GSD CLI process). */
  commandModules: CommandModuleSurface[];
  /** MCP servers the capability declares (each spawned by the host runtime) — name AND command. */
  mcpServers: McpServerSurface[];
  /** True when the capability ships ANY executable surface (=> consent required). */
  hasExecutable: boolean;
  /**
   * Declared module/script files that were NOT found under the staged dir (defensive — a
   * manifest referencing a missing artifact is suspicious; surfaced, not silently dropped).
   * Empty when no stagedDir was supplied.
   */
  missingArtifacts: string[];
}

type StrictKnownRegistries = string[] | null | undefined;

interface ParsedSpec {
  kind: 'registry' | 'git' | 'npm' | 'tarball' | 'local';
  raw: string;
  target: string;
  ref?: string;
}

interface SourceVerdict {
  allowed: boolean;
  reason: string | null;
}

interface EnginesVerdict {
  /** Does the capability's *current* version run on this host? */
  compatible: boolean;
  /** The declared engines.gsd range, or null if unconstrained. */
  range: string | null;
  satisfiedBy: 'engines' | 'compatVersions' | 'unconstrained' | null;
  /** When the current version is incompatible but compatVersions names one that works. */
  downgradeTo?: string;
}

interface InstallTrustArgs {
  parsed: ParsedSpec;
  manifest: CapabilityManifest;
  /** Optional staged dir — when given, declared artifacts are existence-checked. */
  stagedDir?: string;
  strictKnownRegistries?: StrictKnownRegistries;
  hostVersion: string;
}

interface InstallTrustVerdict {
  /** True when no policy gate blocks the install. */
  allowed: boolean;
  /** True when the install is allowed BUT ships executable surfaces => needs consent. */
  requiresConsent: boolean;
  disclosure: Disclosure;
  engines: EnginesVerdict;
  /** Non-empty when allowed === false; each string is a human-readable block reason. */
  blockReasons: string[];
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Enumerate every executable surface a capability manifest declares.
 *
 * Recognizes the three executable surface kinds a capability can ship:
 *   - `hooks`:   [{ event, script }]              — scripts run as runtime hook commands
 *   - `commands`:[{ family, module, router? }]    — modules require()'d into the CLI process
 *   - `mcpServers`: { <name>: {...} } | [{ name }] — servers spawned by the host runtime
 *
 * `mcpServers` is not a first-party capability.json field today, but a third-party manifest may
 * declare it, so the trust gate discloses it whenever present (honest disclosure over the
 * narrower first-party schema). Pure: when `stagedDir` is provided, declared script/module
 * files are existence-checked and any missing ones reported, but nothing is mutated.
 */
function discloseExecutableSurfaces(manifest: CapabilityManifest, stagedDir?: string): Disclosure {
  const hooks: HookSurface[] = [];
  const commandModules: CommandModuleSurface[] = [];
  const mcpServers: McpServerSurface[] = [];
  const missingArtifacts: string[] = [];

  // hooks: [{ event, script }]
  if (Array.isArray(manifest.hooks)) {
    for (const h of manifest.hooks) {
      if (typeof h !== 'object' || h === null) continue;
      const rec = h as Record<string, unknown>;
      const script = asString(rec['script']);
      const event = asString(rec['event']);
      if (script) {
        hooks.push({ event, script });
        if (stagedDir && !artifactExists(stagedDir, script)) {
          missingArtifacts.push(script);
        }
      }
    }
  }

  // commands: [{ family, module, router? }]
  if (Array.isArray(manifest.commands)) {
    for (const c of manifest.commands) {
      if (typeof c !== 'object' || c === null) continue;
      const rec = c as Record<string, unknown>;
      const moduleName = asString(rec['module']);
      const family = asString(rec['family']);
      if (moduleName) {
        commandModules.push({ family, module: moduleName });
        if (stagedDir && !artifactExists(stagedDir, moduleName)) {
          missingArtifacts.push(moduleName);
        }
      }
    }
  }

  // mcpServers: object map { name: { command, args } } OR array [{ name, command, args }]
  // (or array [{ name, config: { command, args } }]). Capture the COMMAND, not just the name —
  // the command is the executable that actually runs, and consent must disclose it (Codex R1 H1).
  if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
    const pushServer = (name: string, config: unknown): void => {
      if (!name) return;
      const cfg = (typeof config === 'object' && config !== null) ? (config as Record<string, unknown>) : {};
      const command = asString(cfg['command']);
      const argv = Array.isArray(cfg['args']) ? cfg['args'].filter((a): a is string => typeof a === 'string') : [];
      mcpServers.push({ name, command, argv });
    };
    if (Array.isArray(manifest.mcpServers)) {
      for (const s of manifest.mcpServers) {
        if (typeof s === 'object' && s !== null) {
          const rec = s as Record<string, unknown>;
          pushServer(asString(rec['name']), rec['config'] ?? rec);
        }
      }
    } else {
      for (const [name, config] of Object.entries(manifest.mcpServers as Record<string, unknown>)) {
        pushServer(name, config);
      }
    }
  }

  const hasExecutable = hooks.length > 0 || commandModules.length > 0 || mcpServers.length > 0;
  return { hooks, commandModules, mcpServers, hasExecutable, missingArtifacts };
}

/**
 * Existence-check a manifest-declared artifact path under stagedDir, refusing to follow it
 * outside the staged root (defense against `../` traversal in a hostile manifest).
 */
function artifactExists(stagedDir: string, relPath: string): boolean {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[/\\]/).includes('..')) {
    // A traversal/absolute artifact path is treated as "not present" (and is independently
    // rejected by the validator / lifecycle); never resolve it.
    return false;
  }
  try {
    return fs.existsSync(path.join(stagedDir, relPath));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Namespace reservation
// ---------------------------------------------------------------------------

/**
 * Is `id` in a reserved namespace? Reserved prefixes are first-party/vendor-only so a
 * third-party capability cannot impersonate a first-party one.
 */
function checkReservedNamespace(id: unknown): { reserved: boolean; namespace: string | null } {
  if (typeof id !== 'string' || !id) return { reserved: false, namespace: null };
  const lower = id.toLowerCase();
  for (const ns of RESERVED_NAMESPACES) {
    if (lower.startsWith(ns)) return { reserved: true, namespace: ns };
  }
  return { reserved: false, namespace: null };
}

// ---------------------------------------------------------------------------
// strictKnownRegistries enforcement
// ---------------------------------------------------------------------------

/**
 * Extract the host of a URL-bearing spec for host-based allowlist matching. Returns '' when no
 * host can be parsed (caller treats '' as non-matching).
 */
function specHost(parsed: ParsedSpec): string {
  // git specs may be scp-style (git@host:path) or URL-style; tarball/registry are URLs.
  const raw = parsed.target || parsed.raw || '';
  const scp = /^[^@/]+@([^:]+):/.exec(raw);
  if (scp) return scp[1].toLowerCase();
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True if `host` equals an allowlist entry or is a subdomain of it. Host-based, NOT substring:
 * `github.com` matches `github.com` and `api.github.com`, never `evilgithub.com`.
 */
function hostMatchesAllowlist(host: string, list: string[]): boolean {
  if (!host) return false;
  for (const entryRaw of list) {
    const entry = typeof entryRaw === 'string' ? entryRaw.trim().toLowerCase() : '';
    if (!entry) continue;
    if (host === entry || host.endsWith('.' + entry)) return true;
  }
  return false;
}

/**
 * True for a Windows/UNC network path. Matches any two leading slash-or-backslash characters
 * (`\\`, `//`, and the mixed `\/` / `/\` forms Windows also treats as UNC-absolute).
 */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Extract the server host of a UNC path (`\\server\share` -> `server`). */
function uncHost(p: string): string {
  const m = /^[\\/]{2}([^\\/]+)/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Apply the `capabilities.strict_known_registries` policy to a parsed spec.
 *
 *   undefined/null  -> permissive: external installs allowed (consent gate still applies).
 *   []              -> lockdown:   all EXTERNAL installs blocked (local-only).
 *   non-empty list  -> allowlist:  only sources whose host matches an entry are allowed.
 *   anything else   -> FAIL CLOSED: a malformed policy value blocks the install.
 *
 * Local (filesystem) sources are never "external" and are always allowed — EXCEPT a UNC network
 * path (`\\server\share`), which is remote despite parsing as an "absolute"/local-kind spec and is
 * therefore subject to the policy.
 */
function evaluateSourceAllowed(parsed: ParsedSpec, strict: StrictKnownRegistries): SourceVerdict {
  const target = parsed.target || parsed.raw || '';
  const unc = parsed.kind === 'local' && isUncPath(target);
  if (parsed.kind === 'local' && !unc) return { allowed: true, reason: null };

  if (strict === undefined || strict === null) return { allowed: true, reason: null };
  if (!Array.isArray(strict)) {
    // A security policy must never be silently ignored when it is the wrong type (e.g. a
    // string `"[]"` from a hand-edited config). Fail closed.
    return {
      allowed: false,
      reason:
        'capabilities.strict_known_registries must be an array (or null/unset); refusing the install on a malformed policy value',
    };
  }

  if (strict.length === 0) {
    return {
      allowed: false,
      reason:
        'capabilities.strict_known_registries is [] — all external capability installs are disabled. ' +
        'Install from a local path, or add an allowed host to the list.',
    };
  }

  // npm specs carry no host; the "registry" is npm itself. Treat the allowlist token "npm" as
  // permitting the npm source kind.
  if (parsed.kind === 'npm') {
    if (strict.some((e) => typeof e === 'string' && e.trim().toLowerCase() === 'npm')) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason: `npm source is not in capabilities.strict_known_registries (add "npm" to allow it)`,
    };
  }

  const host = unc ? uncHost(target) : specHost(parsed);
  if (hostMatchesAllowlist(host, strict)) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `source host "${host || '(unparseable)'}" is not in capabilities.strict_known_registries`,
  };
}

// ---------------------------------------------------------------------------
// engines.gsd hard gate + compatVersions downgrade
// ---------------------------------------------------------------------------

/**
 * Hard-gate a manifest against the running host version via engines.gsd, consulting
 * compatVersions for a graceful-downgrade target when the current version is incompatible.
 */
function checkEngines(manifest: CapabilityManifest, hostVersion: string): EnginesVerdict {
  const engines = manifest.engines;
  let range: string | null = null;
  if (engines && typeof engines === 'object' && !Array.isArray(engines)) {
    const g = (engines as Record<string, unknown>)['gsd'];
    if (typeof g === 'string' && g) range = g;
  }

  if (!range) return { compatible: true, range: null, satisfiedBy: 'unconstrained' };

  if (semverMod.semverSatisfies(hostVersion, range)) {
    return { compatible: true, range, satisfiedBy: 'engines' };
  }

  // Current version is incompatible — look for a compatVersions entry that works, picking the
  // newest such capability version (best graceful downgrade).
  const compat = manifest.compatVersions;
  let best: string | undefined;
  if (compat && typeof compat === 'object' && !Array.isArray(compat)) {
    for (const [capVer, gsdRange] of Object.entries(compat as Record<string, unknown>)) {
      if (typeof gsdRange !== 'string' || !gsdRange) continue;
      if (!semverMod.semverSatisfies(hostVersion, gsdRange)) continue;
      if (best === undefined || semverMod.isSemverNewer(capVer, best)) best = capVer;
    }
  }

  if (best !== undefined) {
    return { compatible: false, range, satisfiedBy: 'compatVersions', downgradeTo: best };
  }
  return { compatible: false, range, satisfiedBy: null };
}

// ---------------------------------------------------------------------------
// Composite install verdict
// ---------------------------------------------------------------------------

/**
 * Compose the full install trust verdict: source policy + reserved-namespace + engines gate +
 * executable-surface disclosure. `allowed` is true only when no gate blocks; `requiresConsent`
 * is true when allowed AND the capability ships any executable surface.
 *
 * engines.gsd is also enforced inside resolveCapabilitySource at resolve time; re-checking here
 * is defense-in-depth and lets callers surface a compatVersions downgrade hint.
 */
function evaluateInstallTrust(args: InstallTrustArgs): InstallTrustVerdict {
  const { parsed, manifest, stagedDir, strictKnownRegistries, hostVersion } = args;
  const blockReasons: string[] = [];

  const src = evaluateSourceAllowed(parsed, strictKnownRegistries);
  if (!src.allowed && src.reason) blockReasons.push(src.reason);

  const ns = checkReservedNamespace(manifest.id);
  if (ns.reserved) {
    blockReasons.push(
      `capability id "${asString(manifest.id)}" uses the reserved namespace "${ns.namespace}" — ` +
        'reserved for first-party capabilities',
    );
  }

  const engines = checkEngines(manifest, hostVersion);
  if (!engines.compatible) {
    const hint = engines.downgradeTo
      ? ` (compatVersions offers ${engines.downgradeTo} for this host)`
      : '';
    blockReasons.push(
      `capability requires engines.gsd "${engines.range}" but host is ${hostVersion}${hint}`,
    );
  }

  const disclosure = discloseExecutableSurfaces(manifest, stagedDir);

  // A manifest that declares a hook script or command module NOT present in the staged bundle
  // (missing, or escaping the bundle via an absolute/`..` path) is rejected: such an artifact
  // would run from outside the integrity-pinned, reversible install root. Only enforced when a
  // stagedDir was provided to existence-check against.
  if (stagedDir && disclosure.missingArtifacts.length > 0) {
    blockReasons.push(
      `capability declares executable artifacts not present in the staged bundle (or escaping it): ${disclosure.missingArtifacts.join(', ')}`,
    );
  }

  const allowed = blockReasons.length === 0;
  const requiresConsent = allowed && disclosure.hasExecutable;
  return { allowed, requiresConsent, disclosure, engines, blockReasons };
}

// ---------------------------------------------------------------------------
// Executable-set change detection (auto-update re-prompt trigger)
// ---------------------------------------------------------------------------

function disclosureSignature(d: Disclosure): string {
  const hooks = d.hooks.map((h) => `hook:${h.event}:${h.script}`).sort();
  const mods = d.commandModules.map((m) => `mod:${m.family}:${m.module}`).sort();
  // Include the command + argv so a version that keeps the server NAME but swaps the executable
  // it runs is detected as a changed surface (forces re-consent). argv is JSON-encoded (not
  // space-joined) so an argument-boundary change (['a b'] vs ['a','b']) is still a change.
  const mcp = d.mcpServers.map((s) => `mcp:${s.name}:${s.command}:${JSON.stringify(s.argv)}`).sort();
  return JSON.stringify([hooks, mods, mcp]);
}

/**
 * Did the executable surface set change between two versions? Auto-update must re-prompt for
 * consent when it did (the user consented to one set of executable surfaces, not another).
 */
function executableSetChanged(oldD: Disclosure, newD: Disclosure): boolean {
  return disclosureSignature(oldD) !== disclosureSignature(newD);
}

// ---------------------------------------------------------------------------
// Human-readable consent prompt
// ---------------------------------------------------------------------------

/**
 * Render a disclosure as consent-prompt lines. Returned as an array so the CLI/runtime edge can
 * format it; the lib never writes to stdout.
 */
function summarizeDisclosure(disclosure: Disclosure): string[] {
  const lines: string[] = [];
  if (!disclosure.hasExecutable) {
    lines.push('This capability ships no executable surfaces (declarative only).');
    return lines;
  }
  lines.push('This capability ships executable surfaces that will run in your agent runtime:');
  if (disclosure.hooks.length > 0) {
    lines.push(`  hooks (${disclosure.hooks.length}): run as runtime hook commands`);
    for (const h of disclosure.hooks) {
      lines.push(`    - ${h.event || '(event?)'} -> ${h.script}`);
    }
  }
  if (disclosure.commandModules.length > 0) {
    lines.push(
      `  command modules (${disclosure.commandModules.length}): require()'d into the GSD CLI process`,
    );
    for (const m of disclosure.commandModules) {
      lines.push(`    - ${m.family || '(family?)'} -> ${m.module}`);
    }
  }
  if (disclosure.mcpServers.length > 0) {
    lines.push(`  MCP servers (${disclosure.mcpServers.length}): spawned by the host runtime`);
    for (const s of disclosure.mcpServers) {
      const cmd = [s.command, ...s.argv].filter(Boolean).join(' ');
      lines.push(`    - ${s.name} -> ${cmd || '(no command declared)'}`);
    }
  }
  if (disclosure.missingArtifacts.length > 0) {
    lines.push('  WARNING — declared artifacts not found in the staged bundle:');
    for (const a of disclosure.missingArtifacts) {
      lines.push(`    - ${a}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  RESERVED_NAMESPACES,
  discloseExecutableSurfaces,
  checkReservedNamespace,
  evaluateSourceAllowed,
  checkEngines,
  evaluateInstallTrust,
  executableSetChanged,
  summarizeDisclosure,
};
