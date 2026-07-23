/**
 * Capability trust gate — ADR-1244 Phase 4 (Decision D5 + the compatibility half of D6).
 *
 * PURE module. It computes *what* a capability would do and *whether* policy allows it; it
 * never mutates the filesystem and never performs I/O beyond reading staged files to confirm
 * declared executable artifacts exist. The actual consent decision (yes/no) is passed in by the
 * caller — GSD has no interactive-prompt layer in lib (the runtime/CLI edge owns that), so the
 * gate stays testable and side-effect-free. See docs/explanation/capability-trust-model.md.
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
  /**
   * TRUST2-3 (#1459): the exported function the host invokes from the module — WHICH code runs. A
   * version that keeps family+module but retargets `router` to a different exported function changes
   * what executes, so it is part of the disclosed + consent-bound surface. Empty when undeclared.
   */
  router: string;
}

interface McpServerSurface {
  name: string;
  /**
   * The transport TYPE: 'stdio' (spawns command/argv), 'http', or 'sse' (connects to a URL). TRUST2-2
   * (#1459): a non-stdio server was previously invisible to the disclosure/signature — its url/headers
   * could be swapped with no re-consent. Empty when undeclared (the host default is stdio).
   */
  transport: string;
  /** The command the server spawns (the actual executable — disclosed for honest consent). stdio only. */
  command: string;
  /**
   * Arguments passed to the command. TRUST2-4 (#1459): this is a stringified view for the human
   * summary; the consent SIGNATURE encodes the RAW args array (incl non-string members) via
   * `rawArgs` so a non-string arg change still forces re-consent (the host receives the raw args).
   */
  argv: string[];
  /**
   * The RAW args array as declared (may contain non-strings). Folded — stable-encoded — into the
   * signature so a change to ANY member (incl a number/object/bool the host would still pass) forces
   * re-consent (TRUST2-4). Empty array when none declared.
   */
  rawArgs: unknown[];
  /**
   * The URL an http/sse server connects to — TRUST2-2: WHERE the server talks to. A url change is a
   * different remote endpoint and must force re-consent. Empty when undeclared (stdio servers).
   */
  url: string;
  /**
   * The HTTP headers an http/sse server is given (string→string, stable-sorted) — TRUST2-2: headers
   * carry auth/behavior and a change must force re-consent. Header VALUES are redacted in the human
   * summary but INCLUDED in the signature. Empty object when none.
   */
  headers: Record<string, string>;
  /**
   * Environment variables (string→string only) the server is spawned with — disclosed because
   * env can change WHAT a command does (e.g. NODE_OPTIONS=--require /tmp/evil.js) without touching
   * command/argv. Any add/change forces re-consent (TRUST-2, #1459). Empty object when none.
   */
  env: Record<string, string>;
  /** The working directory the server is spawned in (if declared) — also affects what runs. */
  cwd?: string;
  /**
   * Finding 5 (MEDIUM, #1459): the FULL declared server config object (prototype-pollution-safe
   * shallow-cleaned copy). The writer persists the WHOLE config ({...config}), so the signature must
   * bind the WHOLE config — not only the whitelisted fields above — or an upgrade that changes a
   * host-honored field NOT in the whitelist (a future `envFile`/`workingDir`/launch option) would be
   * written verbatim yet leave the signature constant → no re-consent prompt. This is folded into the
   * signature as STABLE (recursively key-sorted) JSON, so any add/change forces re-consent while a
   * pure key reorder does not. NOT shown in the human summary (which stays readable via the key fields).
   */
  rawConfig: Record<string, unknown>;
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
      // TRUST2-3 (#1459): capture the router (which exported fn runs) so retargeting it forces re-consent.
      const router = asString(rec['router']);
      if (moduleName) {
        commandModules.push({ family, module: moduleName, router });
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
      // TRUST2-4 (#1459): the RAW args array (incl non-string members) is what the host receives, so it
      // is folded — stable-encoded — into the signature. `argv` is the string-filtered view for the
      // human summary; `rawArgs` is the full declared array bound into the signature.
      const rawArgs = Array.isArray(cfg['args']) ? (cfg['args'] as unknown[]) : [];
      const argv = rawArgs.filter((a): a is string => typeof a === 'string');
      // TRUST2-2 (#1459): a non-stdio MCP server ({ type|transport, url, headers }) was previously
      // invisible to the disclosure/signature. Capture the transport TYPE, the URL, and the HEADERS
      // (string→string, prototype-pollution-safe) so a swapped endpoint or header forces re-consent.
      const transport = asString(cfg['type']) || asString(cfg['transport']);
      const url = asString(cfg['url']);
      const headers: Record<string, string> = {};
      const rawHeaders = cfg['headers'];
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (typeof v === 'string') headers[k] = v;
        }
      }
      // TRUST-2 (#1459): env can change WHAT a command does without touching command/argv, so it is
      // part of the disclosed (and consent-bound) surface. Filter to string→string entries only —
      // a non-string env value cannot be exported as a real environment variable, and including it
      // would make the signature depend on un-runnable junk. Prototype-pollution-safe: copy only
      // own enumerable string keys, never __proto__/constructor/prototype.
      const env: Record<string, string> = {};
      const rawEnv = cfg['env'];
      if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
        for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (typeof v === 'string') env[k] = v;
        }
      }
      const cwd = asString(cfg['cwd']);
      // Finding 5 (MEDIUM, #1459): capture the FULL config (every declared field the writer persists),
      // not just the whitelisted ones. Prototype-pollution-safe: copy only own enumerable keys and
      // never the dangerous keys. The CAP_MARKER the writer stamps on persist (`_gsdCapability`) is the
      // capability id (constant per cap), so it does not perturb the signature; we copy config as
      // DECLARED here (pre-stamp) and the writer adds the marker at write time.
      const rawConfig: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        rawConfig[k] = v;
      }
      const surface: McpServerSurface = { name, transport, command, argv, rawArgs, url, headers, env, rawConfig };
      if (cwd) surface.cwd = cwd;
      mcpServers.push(surface);
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

/**
 * Serialize a value to JSON with object keys RECURSIVELY SORTED, so the result is stable under key
 * reordering. Used to fold an MCP server's `env` map into the disclosure signature: ADDING or
 * CHANGING any env entry changes the signature (forces re-consent), but merely REORDERING the keys
 * does NOT (no false re-prompt). TRUST-2 (#1459).
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function disclosureSignature(d: Disclosure): string {
  // TRUST2-1 (#1459): build EVERY surface line via stableJson of an ARRAY of its components, so each
  // component is encoded — a `:`-delimited concatenation let a delimiter inside a component (e.g. an
  // mcp name `x:a` vs command `b`) collide with a different decomposition. JSON-encoding every
  // component makes each line an injective function of its components (no delimiter injection).
  const hooks = d.hooks.map((h) => stableJson(['hook', h.event, h.script])).sort();
  // TRUST2-3: include the router (which exported fn runs) so retargeting it forces re-consent.
  const mods = d.commandModules.map((m) => stableJson(['mod', m.family, m.module, m.router || ''])).sort();
  // Include transport + command + RAW args + url + headers + env + cwd + the FULL declared config so a
  // version that:
  //   - swaps the stdio executable it runs (command/args), OR
  //   - changes the env it runs with (e.g. NODE_OPTIONS=--require evil.js), OR
  //   - changes the cwd it runs in, OR
  //   - (TRUST2-2) swaps the transport/url/headers of a non-stdio (http/sse) server, OR
  //   - (TRUST2-4) changes a NON-STRING arg the host still receives, OR
  //   - (finding 5) changes ANY OTHER declared field the writer persists (a future envFile/workingDir/
  //     launch option NOT in the explicit whitelist above)
  // is detected as a changed surface (forces re-consent). The explicit fields are kept FIRST for
  // readability/stability; `rawConfig` is the completeness backstop. All are STABLE-encoded (recursively
  // key-sorted JSON) so any add/change forces re-consent while a pure key reorder does NOT (no false
  // re-prompt).
  const mcp = d.mcpServers
    .map((s) =>
      stableJson([
        'mcp',
        s.name,
        s.transport || '',
        s.command,
        s.rawArgs || [],
        s.url || '',
        s.headers || {},
        s.env || {},
        s.cwd || '',
        // Finding 5: the FULL declared config — completeness so any persisted field change re-consents.
        s.rawConfig || {},
      ]),
    )
    .sort();
  return JSON.stringify([hooks, mods, mcp]);
}

/**
 * Did the executable surface set change between two versions? Auto-update must re-prompt for
 * consent when it did (the user consented to one set of executable surfaces, not another).
 */
function executableSetChanged(oldD: Disclosure, newD: Disclosure): boolean {
  return disclosureSignature(oldD) !== disclosureSignature(newD);
}

/**
 * THE single source of truth for the consent-binding signature of a capability manifest: run
 * `discloseExecutableSurfaces` then `disclosureSignature`. Both the loader (which checks whether a
 * previously-consented project cap still matches) and the lifecycle (which records the consent)
 * compute the binding through THIS helper so they can never drift. `stagedDir` is forwarded for
 * artifact existence-checking; the signature itself is over the executable SET (hooks/mods/mcp incl.
 * env/cwd), not the missingArtifacts list, so it is a stable key regardless of the stagedDir.
 */
function signatureForManifest(manifest: CapabilityManifest, stagedDir?: string): string {
  return disclosureSignature(discloseExecutableSurfaces(manifest, stagedDir));
}

// ---------------------------------------------------------------------------
// Human-readable consent prompt
// ---------------------------------------------------------------------------

/** Max characters of an env VALUE shown in the human consent prompt before it is truncated. */
const ENV_VALUE_MAX = 60;

/** Truncate a long env value for the human prompt (the full value is still in the signature). */
function truncateEnvValue(v: string): string {
  if (typeof v !== 'string') return '';
  return v.length > ENV_VALUE_MAX ? `${v.slice(0, ENV_VALUE_MAX)}… (${v.length} chars)` : v;
}

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
      // TRUST2-3 (#1459): show the router (which exported fn runs) so the user consents to the exact entry point.
      const routerSuffix = m.router ? ` [router: ${m.router}]` : '';
      lines.push(`    - ${m.family || '(family?)'} -> ${m.module}${routerSuffix}`);
    }
  }
  if (disclosure.mcpServers.length > 0) {
    lines.push(`  MCP servers (${disclosure.mcpServers.length}): spawned/connected by the host runtime`);
    for (const s of disclosure.mcpServers) {
      // TRUST2-2 (#1459): a non-stdio (http/sse) server connects to a URL; disclose the endpoint, not
      // a (nonexistent) command. A stdio server discloses command + args as before.
      const isRemote = (s.transport === 'http' || s.transport === 'sse') || (!s.command && !!s.url);
      if (isRemote) {
        const t = s.transport || 'http';
        lines.push(`    - ${s.name} -> [${t}] ${s.url || '(no url declared)'}`);
        // Header VALUES are redacted in the human summary (they may carry secrets); only the KEY set
        // is shown. The full values ARE in the signature, so a value change forces re-consent.
        const hdrKeys = s.headers ? Object.keys(s.headers) : [];
        if (hdrKeys.length > 0) {
          lines.push(`        headers: ${hdrKeys.map((k) => `${k}=<redacted>`).join(', ')}`);
        }
      } else {
        const cmd = [s.command, ...s.argv].filter(Boolean).join(' ');
        lines.push(`    - ${s.name} -> ${cmd || '(no command declared)'}`);
      }
      // TRUST-2 (#1459): env can change WHAT runs without touching the command, so show each env key
      // and its (truncated) value — the user is consenting to this exact environment.
      const envKeys = s.env ? Object.keys(s.env) : [];
      if (envKeys.length > 0) {
        lines.push(`        env: ${envKeys.map((k) => `${k}=${truncateEnvValue(s.env[k])}`).join(', ')}`);
      }
      if (s.cwd) lines.push(`        cwd: ${s.cwd}`);
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
  // #1459: the consent-binding signature (single source of truth for loader + lifecycle consent).
  disclosureSignature,
  signatureForManifest,
};
