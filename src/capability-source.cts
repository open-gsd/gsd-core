/**
 * capability-source.cts — Capability source resolver (ADR-1244 Phase 3, Decision D3).
 *
 * One seam `resolveCapabilitySource(spec, opts)` with an adapter per source kind.
 * Each adapter: fetch → verify integrity/SHA → check engines.gsd → return a STAGED,
 * VALIDATED bundle.
 *
 * SECURITY CONTRACT:
 *   - Install NEVER executes capability code. Copy/extract only.
 *   - All subprocesses routed through shell-command-projection.cjs seam (windowsHide,
 *     argv arrays, no shell string interpolation).
 *   - Integrity verified BEFORE extraction when provided.
 *   - engines.gsd pre-checked before staging.
 *   - Full validator suite run on manifest before finalizing.
 *   - Staging atomicity: stage under .staging/<id>-<pid>-<ts>/, renameSync on success,
 *     rmSync on any failure.
 *   - No raw spawnSync / execSync / shell strings.
 *
 * ADR-457 build-at-publish: authored as TypeScript .cts → emits .cjs via tsc.
 *
 * Exports: resolveCapabilitySource, parseSpec, _setCapabilitySourceHttpGet
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellSeam = require('./shell-command-projection.cjs') as {
  execGit: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execNpm: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
  execTool: (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const capValidator = require('./capability-validator.cjs') as ValidatorModule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs') as {
  semverSatisfies: (version: unknown, range: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

interface ValidatorModule {
  validateCapability: (cap: unknown, id: string) => string[];
  materializeHookFragments: (cap: unknown, capDir: string) => string[];
  validateAgainstContract: (cap: unknown, capId: string) => string[];
  validateConsumesGlobal: (capMap: Map<string, unknown>) => string[];
  validateCrossCapability: (capMap: Map<string, unknown>, centralKeys: Set<string>) => string[];
}

/** Parsed spec discriminant. */
type SpecKind = 'registry' | 'git' | 'npm' | 'tarball' | 'local';

interface ParsedSpec {
  kind: SpecKind;
  /** The original raw spec string. */
  raw: string;
  /** Resolved URL / path / package-spec, depending on kind. */
  target: string;
  /** Optional ref (git only). */
  ref?: string;
}

/** Tar-only exec signature (program is always 'tar', injected for testability). */
type TarExecFn = (program: string, args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;

/** Options accepted by resolveCapabilitySource. */
interface ResolveOptions {
  /** Running GSD version. Defaults to package.json version, fail-closed to '0.0.0'. */
  hostVersion?: string;
  /** Override the GSD home directory (where .gsd/capabilities/ lives). */
  gsdHome?: string;
  /** Expected integrity string (`sha512-<base64>`). When provided, integrity is verified
   *  before any bytes are committed to the final location. */
  integrity?: string;
  /**
   * When false, stop after validation and return the staging dir WITHOUT promoting it to the
   * final capabilities location. The caller then owns the atomic stage-then-swap + ledger
   * commit ordering (ADR-1244 Phase 4 / D6 upgrade path). Defaults to true (promote in place),
   * preserving the original install behavior.
   */
  promote?: boolean;
  /**
   * When true, SKIP the resolver's `engines.gsd` hard-throw during staging. The caller becomes
   * responsible for the engines gate. Used by capability-lifecycle so its own `checkEngines` can
   * gate the install AND surface a `compatVersions` downgrade hint (the resolver throw would
   * pre-empt that). Staging remains copy-only and is never promoted by the lifecycle when the
   * engines check fails, so nothing incompatible is ever activated. Defaults to false (throw).
   */
  skipEnginesGate?: boolean;
  /** Injectable exec overrides for tests — keys match the shell-seam functions. */
  execOverrides?: {
    git?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    npm?: (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResult;
    tar?: TarExecFn;
  };
}

/** Resolved + staged bundle descriptor. */
interface ResolveResult {
  id: string;
  version: string;
  stagedDir: string;
  /** sha512-<base64> digest of the staged capability.json, or null for local/git sources. */
  integrity: string | null;
  /** The original spec string. */
  source: string;
}

/** Injectable HTTP response shape. */
interface HttpResponse {
  statusCode: number;
  body: Buffer;
}

type HttpGetFn = (url: string) => Promise<HttpResponse>;

// ---------------------------------------------------------------------------
// Injectable HTTP transport (test seam)
// ---------------------------------------------------------------------------

function realHttpsGet(url: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'gsd-core-capability-source/1.0' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? 0} fetching ${url}`));
            return;
          }
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`timeout after 30000ms fetching ${url}`));
    });
    req.on('error', reject);
  });
}

let _httpGet: HttpGetFn = realHttpsGet;

/**
 * Test seam: replace the HTTP transport. Pass null to restore the real transport.
 */
function _setCapabilitySourceHttpGet(fn: HttpGetFn | null): void {
  _httpGet = fn ?? realHttpsGet;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the running GSD version; fail-closed to '0.0.0'. */
function readHostVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json') as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Compute sha512-<base64> integrity over a buffer. */
function computeIntegrity(buf: Buffer): string {
  const digest = crypto.createHash('sha512').update(buf).digest('base64');
  return `sha512-${digest}`;
}

/** Verify buf against an `sha512-<base64>` integrity string. Throws on mismatch. */
function verifyIntegrity(buf: Buffer, expected: string): void {
  const prefix = 'sha512-';
  if (!expected.startsWith(prefix)) {
    throw new Error(`Unsupported integrity algorithm (expected sha512-<base64>): ${expected}`);
  }
  const expectedBase64 = expected.slice(prefix.length);
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== expectedBase64) {
    throw new Error(
      `Integrity mismatch: expected sha512-${expectedBase64} but got sha512-${actual}`
    );
  }
}

/**
 * Reject spec/id values containing path separators or `..`.
 * Throws if the id is unsafe.
 */
function assertSafeId(id: string): void {
  if (!id || /[/\\]/.test(id) || id.includes('..')) {
    throw new Error(
      `Capability id "${id}" is invalid: must be kebab-case with no path separators or ".."`
    );
  }
}

// Shell-injection metacharacters + whitespace/control. execNpm runs under a shell
// on Windows (the npm shim), so an npm: spec must not carry any of these — they are
// never valid in a real npm package spec (scope/name@version|tag|^range|~range).
const SHELL_METACHAR_RE = /[;&|$`()<>!"'\\%\s]/;

/** Reject an npm package spec that could break out of the (Windows) shell. */
function assertSafeNpmSpec(pkgSpec: string): void {
  if (SHELL_METACHAR_RE.test(pkgSpec)) {
    throw new Error(`Unsafe npm package spec (shell metacharacters not allowed): "${pkgSpec}"`);
  }
}

/**
 * Allowlist git transports. Git's `ext::`/`fd::` remote helpers are external-command
 * bridges (arbitrary code execution if protocol.*.allow is permissive), and `file://`
 * enables local-path tricks — only network transports are permitted.
 */
function assertSafeGitUrl(url: string): void {
  if (!/^(https?|ssh|git):\/\//i.test(url)) {
    throw new Error(
      `Unsupported git transport for "${url}": only https://, ssh://, and git:// are allowed`
    );
  }
}

/**
 * Copy a directory tree recursively into destDir.
 *
 * SECURITY: symlinks are REJECTED (fail closed). A fetched bundle could otherwise
 * smuggle a symlink (e.g. `id_rsa -> ~/.ssh/id_rsa`) that fs.copyFileSync would
 * FOLLOW, copying an arbitrary host file's bytes into the staged capability dir.
 * Dirent.isSymbolicLink() reflects the entry itself (lstat semantics), so this
 * catches both file and directory symlinks before any copy.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to stage symlink in capability bundle: ${entry.name}`);
    } else if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
    // Non-regular entries (sockets, fifos, devices) are silently skipped.
  }
}

/**
 * Defense-in-depth against tar-slip: list the archive members and reject any with
 * an absolute path or a `..` segment BEFORE extraction (system tar mostly guards
 * this, but the hard contract is "traversal rejected", so we verify explicitly).
 * Symlink members that survive extraction are caught later by copyDirRecursive.
 */
function assertSafeTarMembers(execTar: TarExecFn, tgzPath: string): void {
  // (1) Member NAMES — reject path traversal (absolute / "..").
  const listing = execTar('tar', ['-tzf', tgzPath], { timeout: 60_000 });
  if (listing.exitCode !== 0) {
    throw new Error(`tar listing failed (exit ${listing.exitCode}): ${listing.stderr}`);
  }
  for (const line of listing.stdout.split('\n')) {
    const member = line.trim();
    if (!member) continue;
    if (member.startsWith('/') || path.isAbsolute(member) || member.split(/[/\\]/).includes('..')) {
      throw new Error(`Refusing to extract tarball with unsafe member path: "${member}"`);
    }
  }
  // (2) Member TYPES — reject symlink/hardlink members BEFORE extraction. A symlink
  // member with a safe name is created during `tar -x` and a later member can be
  // written THROUGH it to escape the extract dir (the post-extraction copy guard is
  // too late). The verbose listing marks links: leading 'l'/'h' in the mode column
  // and a " -> " / " link to " suffix (GNU + bsd tar).
  const verbose = execTar('tar', ['-tvzf', tgzPath], { timeout: 60_000 });
  if (verbose.exitCode !== 0) {
    throw new Error(`tar verbose listing failed (exit ${verbose.exitCode}): ${verbose.stderr}`);
  }
  for (const line of verbose.stdout.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes(' -> ') || line.includes(' link to ') || /^\s*[lh]/.test(line)) {
      throw new Error('Refusing to extract tarball containing a symlink or hardlink member');
    }
  }
}

/**
 * Validate the fetched capability manifest and stage it atomically.
 *
 * Runs the full validation suite (validateCapability → materializeHookFragments →
 * validateAgainstContract → validateConsumesGlobal → validateCrossCapability).
 * On success, renames the staging dir to the final dir and returns the result.
 * On any failure, removes the staging dir and throws.
 */
function stageValidated(opts: {
  sourceDir: string;
  id: string;
  gsdHome: string;
  hostVersion: string;
  source: string;
  integrity: string | null;
  promote?: boolean;
  skipEnginesGate?: boolean;
}): ResolveResult {
  const { sourceDir, id, gsdHome, hostVersion, source, integrity } = opts;
  const promote = opts.promote !== false;

  // Safety: validate id before using it in a path.
  assertSafeId(id);

  const capabilitiesRoot = path.join(gsdHome, '.gsd', 'capabilities');
  const stagingRoot = path.join(capabilitiesRoot, '.staging');
  const stagingDir = path.join(stagingRoot, `${id}-${process.pid}-${Date.now()}`);
  const finalDir = path.join(capabilitiesRoot, id);

  // Reject a source-ROOT that is itself a symlink (copyDirRecursive guards interior
  // entries, but readdirSync would follow a symlinked root).
  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    throw new Error(`Refusing to stage a symlinked source directory: ${sourceDir}`);
  }

  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // Copy source into staging.
    copyDirRecursive(sourceDir, stagingDir);

    // Read and parse the capability manifest.
    const manifestPath = path.join(stagingDir, 'capability.json');
    let rawManifest: string;
    try {
      rawManifest = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      throw new Error(`capability.json not found in staged directory: ${stagingDir}`);
    }
    let cap: Record<string, unknown>;
    try {
      cap = JSON.parse(rawManifest) as Record<string, unknown>;
    } catch {
      throw new Error('capability.json is not valid JSON');
    }
    if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
      throw new Error('capability.json must be a JSON object');
    }

    // engines.gsd pre-check — reject before staging finalizes (unless the caller owns the gate).
    const engines = cap['engines'];
    if (!opts.skipEnginesGate && engines && typeof engines === 'object' && !Array.isArray(engines)) {
      const gsdRange = (engines as Record<string, unknown>)['gsd'];
      if (typeof gsdRange === 'string' && gsdRange) {
        if (!semverMod.semverSatisfies(hostVersion, gsdRange)) {
          throw new Error(
            `Capability requires engines.gsd "${gsdRange}" but running GSD is ${hostVersion}`
          );
        }
      }
    }

    // Structural validation (validateCapability enforces id===folderId).
    const validationErrs = capValidator.validateCapability(cap, id);
    if (validationErrs.length > 0) {
      throw new Error(`Capability validation failed: ${validationErrs.join('; ')}`);
    }

    // Materialize hook fragments (returns errors, does not throw).
    const fragErrs = capValidator.materializeHookFragments(structuredClone(cap), stagingDir);
    if (fragErrs.length > 0) {
      throw new Error(`Hook fragment validation failed: ${fragErrs.join('; ')}`);
    }

    // Cross-capability validations (contract, consumes, cross-capability).
    const capMap = new Map<string, unknown>([[id, cap]]);
    const centralKeys = new Set<string>();
    const crossErrs = [
      ...capValidator.validateAgainstContract(cap, id),
      ...capValidator.validateConsumesGlobal(capMap),
      ...capValidator.validateCrossCapability(capMap, centralKeys),
    ];
    if (crossErrs.length > 0) {
      throw new Error(`Cross-capability validation failed: ${crossErrs.join('; ')}`);
    }

    // When promote === false the caller owns the swap (ADR-1244 Phase 4 upgrade path):
    // return the validated staging dir as-is, leaving it on disk for the caller to rename.
    if (!promote) {
      const version = typeof cap['version'] === 'string' ? cap['version'] : '';
      return { id, version, stagedDir: stagingDir, integrity, source };
    }

    // All validation passed — promote staging to final.
    // Replacement is move-aside-then-rename (not rm-then-rename): rename the old
    // bundle aside (atomic), move the new one in, restore the old one if the second
    // rename fails. This avoids leaving the capability missing on a failed swap.
    // (The fully-atomic stage-then-swap with the ledger as commit point — for upgrades —
    // lives in capability-lifecycle.cjs and uses promote:false above.)
    if (fs.existsSync(finalDir)) {
      const backupDir = `${finalDir}.old-${process.pid}-${Date.now()}`;
      fs.renameSync(finalDir, backupDir);
      try {
        fs.renameSync(stagingDir, finalDir);
      } catch (err) {
        try { fs.renameSync(backupDir, finalDir); } catch { /* best-effort restore */ }
        throw err;
      }
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    } else {
      fs.renameSync(stagingDir, finalDir);
    }

    const version = typeof cap['version'] === 'string' ? cap['version'] : '';

    return { id, version, stagedDir: finalDir, integrity, source };
  } catch (err) {
    // Atomicity: always clean up the staging dir on failure.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/**
 * Detect the source kind from a raw spec string.
 *
 * Kind detection rules (first match wins):
 *   local:    starts with `./ | ../ | /` (absolute path)
 *   npm:      starts with `npm:` prefix
 *   tarball:  `https://…` ending in `.tgz` or `.tar.gz`
 *   git:      `https://…git`, URL with `#<ref>`, or starts with `git+`
 *   registry: `<name>@<registry>` form (no URL scheme)
 */
function parseSpec(spec: string): ParsedSpec {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('Capability spec must be a non-empty string');
  }
  const s = spec.trim();

  // local: relative or absolute path
  if (s.startsWith('./') || s.startsWith('../') || path.isAbsolute(s)) {
    return { kind: 'local', raw: spec, target: s };
  }

  // npm: explicit `npm:` prefix
  if (s.startsWith('npm:')) {
    const pkgSpec = s.slice('npm:'.length);
    if (!pkgSpec) throw new Error(`Invalid npm spec: "${spec}" — package spec is empty after "npm:"`);
    assertSafeNpmSpec(pkgSpec);
    return { kind: 'npm', raw: spec, target: pkgSpec };
  }

  // tarball: https URL ending in .tgz or .tar.gz
  if (/^https?:\/\/.+\.t(gz|ar\.gz)$/i.test(s)) {
    return { kind: 'tarball', raw: spec, target: s };
  }

  // git: git+ prefix, https URL ending in .git, or URL with #<ref>
  if (
    s.startsWith('git+') ||
    /^https?:\/\/.+\.git$/i.test(s) ||
    (/^https?:\/\//.test(s) && s.includes('#'))
  ) {
    let url = s.startsWith('git+') ? s.slice('git+'.length) : s;
    let ref: string | undefined;
    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1) {
      ref = url.slice(hashIdx + 1);
      url = url.slice(0, hashIdx);
    }
    assertSafeGitUrl(url);
    if (ref !== undefined && (SHELL_METACHAR_RE.test(ref) || ref.startsWith('-'))) {
      // Leading '-' would be parsed as a git option, not a ref.
      throw new Error(`Unsafe git ref (shell metacharacters or leading dash not allowed): "${ref}"`);
    }
    return { kind: 'git', raw: spec, target: url, ...(ref !== undefined ? { ref } : {}) };
  }

  // registry: <name>@<version-or-registry> — no URL scheme
  if (/^[a-zA-Z0-9@/_-]/.test(s) && !s.startsWith('http')) {
    return { kind: 'registry', raw: spec, target: s };
  }

  throw new Error(`Cannot determine source kind for capability spec: "${spec}"`);
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------

function resolveLocal(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const absPath = path.resolve(parsed.target);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Local capability path does not exist: ${absPath}`);
  }
  // Read id from capability.json to know the staging dest.
  const manifestPath = path.join(absPath, 'capability.json');
  let cap: Record<string, unknown>;
  try {
    cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot read capability.json from local path: ${manifestPath}`);
  }
  const id = typeof cap['id'] === 'string' ? cap['id'] : '';
  if (!id) throw new Error('capability.json missing "id" field');

  return stageValidated({ sourceDir: absPath, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
}

function resolveGit(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execGit = opts.execOverrides?.git ?? shellSeam.execGit;

  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-git-'));
  try {
    // Clone (copy only — no hooks execute on clone, no npm install).
    const cloneResult = execGit(['clone', '--depth', '1', '--', parsed.target, cloneDir], { timeout: 60_000 });
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`);
    }

    // Optional ref checkout. The ref is a commit-ish (tag/branch/sha), NOT a path,
    // so it goes BEFORE the `--` pathspec terminator (a leading-dash ref is rejected
    // at parse time, so it cannot be misread as an option here).
    if (parsed.ref) {
      const checkoutResult = execGit(['-C', cloneDir, 'checkout', parsed.ref, '--'], { timeout: 60_000 });
      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `git checkout "${parsed.ref}" failed (exit ${checkoutResult.exitCode}): ${checkoutResult.stderr}`
        );
      }
    }

    // Read id from capability.json.
    const manifestPath = path.join(cloneDir, 'capability.json');
    let cap: Record<string, unknown>;
    try {
      cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`capability.json not found in cloned repo: ${parsed.target}`);
    }
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir: cloneDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function resolveNpm(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): ResolveResult {
  const execNpm = opts.execOverrides?.npm ?? shellSeam.execNpm;
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  const tmpPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-pack-'));
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-npm-ext-'));

  try {
    // npm pack — creates a tarball. CRITICAL: `npm pack` runs prepack/prepare
    // lifecycle scripts by default, which would EXECUTE fetched code — so we pass
    // --ignore-scripts to guarantee copy-only. NEVER npm install.
    const packResult = execNpm(
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', tmpPackDir, '--', parsed.target],
      { timeout: 60_000 }
    );
    if (packResult.exitCode !== 0) {
      throw new Error(`npm pack failed (exit ${packResult.exitCode}): ${packResult.stderr}`);
    }

    // Locate the produced .tgz.
    const tarballs = fs.readdirSync(tmpPackDir).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      throw new Error(`npm pack produced no .tgz in ${tmpPackDir}`);
    }
    const tgzPath = path.join(tmpPackDir, tarballs[0]);

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    // Extract — copy only, no scripts. npm tarballs nest under package/.
    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // npm tarballs nest under package/; fall back to root.
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json.
    const manifestPath = path.join(sourceDir, 'capability.json');
    let cap: Record<string, unknown>;
    try {
      cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`capability.json not found after npm pack extraction from: ${parsed.target}`);
    }
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: null, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(tmpPackDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

async function resolveTarball(
  parsed: ParsedSpec,
  opts: ResolveOptions,
  gsdHome: string,
  hostVersion: string
): Promise<ResolveResult> {
  // tar override: injected for tests; default delegates to shell seam execTool.
  const execTar: TarExecFn = opts.execOverrides?.tar ?? shellSeam.execTool;

  // Fetch buffer — always reject non-200 (realHttpsGet enforces this).
  const resp = await _httpGet(parsed.target);

  // Integrity check BEFORE any bytes touch disk (if provided).
  const computedIntegrity = computeIntegrity(resp.body);
  if (opts.integrity) {
    verifyIntegrity(resp.body, opts.integrity);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-tar-'));
  const tgzPath = path.join(extractDir, '_download.tgz');

  try {
    fs.writeFileSync(tgzPath, resp.body);

    // Reject tar-slip member paths before extracting.
    assertSafeTarMembers(execTar, tgzPath);

    const tarResult = execTar('tar', ['-xzf', tgzPath, '-C', extractDir], { timeout: 60_000 });
    if (tarResult.exitCode !== 0) {
      throw new Error(`tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr}`);
    }

    // Locate capability.json — root or package/ (npm tarball shape).
    const packageDir = path.join(extractDir, 'package');
    const sourceDir = fs.existsSync(path.join(packageDir, 'capability.json')) ? packageDir : extractDir;

    // Read id from capability.json.
    const manifestPath = path.join(sourceDir, 'capability.json');
    let cap: Record<string, unknown>;
    try {
      cap = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`capability.json not found in tarball from: ${parsed.target}`);
    }
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    if (!id) throw new Error('capability.json missing "id" field');

    return stageValidated({ sourceDir, id, gsdHome, hostVersion, source: parsed.raw, integrity: computedIntegrity, promote: opts.promote, skipEnginesGate: opts.skipEnginesGate });
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a capability spec, validate it, and stage it into the GSD capabilities dir.
 *
 * @param spec  - Source spec string. Kind auto-detected via parseSpec.
 * @param opts  - Optional overrides for hostVersion, gsdHome, integrity, exec/http seams.
 * @returns     - Resolved bundle descriptor with stagedDir path.
 */
async function resolveCapabilitySource(spec: string, opts: ResolveOptions = {}): Promise<ResolveResult> {
  const parsed = parseSpec(spec);

  const hostVersion = opts.hostVersion ?? readHostVersion();
  const gsdHome = opts.gsdHome ?? process.env['GSD_HOME'] ?? os.homedir();

  switch (parsed.kind) {
    case 'local':
      return resolveLocal(parsed, opts, gsdHome, hostVersion);
    case 'git':
      return resolveGit(parsed, opts, gsdHome, hostVersion);
    case 'npm':
      return resolveNpm(parsed, opts, gsdHome, hostVersion);
    case 'tarball':
      return resolveTarball(parsed, opts, gsdHome, hostVersion);
    case 'registry':
      throw new Error(
        'registry source kind is not yet implemented (no first-party registry endpoint)'
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = parsed.kind;
      throw new Error(`Unknown source kind: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  resolveCapabilitySource,
  parseSpec,
  _setCapabilitySourceHttpGet,
};
