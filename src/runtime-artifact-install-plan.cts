'use strict';

/**
 * Runtime Artifact Install Plan Module.
 *
 * Turns a pre-resolved runtime artifact layout into staged copy inputs. The
 * installer adapter still owns pruning, copying, migrations, output, and final
 * cleanup execution.
 */

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;
const path = _require('node:path') as typeof import('node:path');
const { tryWithinRootLexical } = _require('./security.cjs') as typeof import('./security.cjs');
const { hostBehaviorsFor } = _require('./runtime-name-policy.cjs') as typeof import('./runtime-name-policy.cjs');
const { isMinimalMode } = _require('./install-profiles.cjs') as { isMinimalMode: (mode: string) => boolean };

// #2870: InstallScope is owned by install-scope.cts, not re-declared here.
// `isGlobalScope` centralizes the `scope === 'global'` boolean projection
// this module needs at `_computePathPrefix`'s `isGlobal: boolean` boundary
// (see the module-level doc comment on `isGlobalScope` for why the
// projection is centralized rather than eliminated).
import { isGlobalScope, type InstallScope } from './install-scope.cjs';

type ArtifactKindName = 'commands' | 'agents' | 'skills' | 'kimi-agents';

interface ResolvedProfile {
  name?: string;
  skills?: Set<string> | '*';
  agents?: Set<string>;
}

interface AgentCtx {
  runtime: string;
  pathPrefix: string;
  attribution: string | null | undefined;
  /** #2875 Part 2 (row I1): install root, threaded through so the
   *  descriptor pipeline's frontmatter-extensions step and model-override
   *  resolution can read config exactly as the inline agent loop's own
   *  `targetDir` variable did. */
  targetDir?: string | null;
  /** Project/config discovery root, distinct from global artifact destinations. */
  projectDir?: string | null;
}

interface ArtifactKind {
  kind: ArtifactKindName;
  destSubpath: string;
  prefix?: string;
  stage: (resolvedProfile: ResolvedProfile, agentCtx?: AgentCtx) => string;
  /** Resolved absolute alternate install root for this kind, if the descriptor
   *  specifies one (e.g. codex skills → $HOME/.agents). Undefined means the
   *  kind installs under the runtime's normal configDir. */
  home?: string;
}

interface Layout {
  runtime: string;
  configDir: string;
  scope?: InstallScope;
  kinds: ArtifactKind[];
}

interface RewriteOpts {
  runtime: string;
  configDir: string;
  scope: InstallScope;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  resolveAttribution?: (runtime: string) => string | null | undefined;
}

interface Dependencies {
  rewriteStagedSkillBodies?: (stagedDir: string, opts: RewriteOpts) => string | void;
  rewriteStagedCommandBodies?: (stagedDir: string, opts: RewriteOpts) => string | void;
}

interface ComputePathPrefixOpts {
  isGlobal: boolean;
  isOpencode: boolean;
  isWindowsHost: boolean;
  resolvedTarget: string;
  homeDir: string;
  /** #4377: the runtime's `localConfigDir`, used only when the project-relative
   *  include style is opted in on a local install. Optional — an omitted value
   *  falls back to the absolute prefix, which is the pre-#4377 behavior. */
  localDirName?: string;
  /** #4377: explicit opt-in override. Defaults to `GSD_RELATIVE_INCLUDES === '1'`
   *  inside `_computePathPrefix`; present here so tests can drive both arms
   *  without mutating the environment. */
  projectRelative?: boolean;
}

interface RuntimeArtifactConversionExports {
  rewriteStagedSkillBodies: (stagedDir: string, opts: RewriteOpts) => string | void;
  rewriteStagedCommandBodies: (stagedDir: string, opts: RewriteOpts) => string | void;
  _computePathPrefix: (opts: ComputePathPrefixOpts) => string;
  _localIncludeDirName: (runtime: string) => string | undefined;
}

interface PlanItem {
  kind: ArtifactKindName;
  sourceDir: string;
  destDir: string;
}

interface InstallPlan {
  items: PlanItem[];
  cleanupDirs: string[];
}

interface UninstallPlanItem {
  kind: ArtifactKindName;
  destDir: string;
}

interface UninstallPlan {
  items: UninstallPlanItem[];
}

type InstallPlanResult =
  | { ok: true; plan: InstallPlan }
  | { ok: false; kind: 'stage_failed' | 'rewrite_failed'; message: string; cleanupDirs: string[]; failedKind?: ArtifactKindName };

interface CreateRuntimeArtifactInstallPlanArgs {
  layout: Layout;
  resolvedProfile: ResolvedProfile;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  resolveAttribution?: (runtime: string) => string | null | undefined;
  projectDir?: string | null;
  deps?: Dependencies;
}

/**
 * Asserts that `destSubpath` resolves to a path inside `configDir`.
 *
 * Rejects any path that escapes the configDir root (e.g. "../../etc") and any
 * path containing a NUL byte. This is a security gate for Phase B of
 * ADR-1239: third-party descriptors must never be able to write outside the
 * designated config home directory.
 *
 * @param configDir - The root config directory (e.g. ~/.claude).
 * @param destSubpath - The relative path declared by the runtime descriptor.
 * @returns The resolved absolute path under configDir.
 * @throws {Error} if destSubpath escapes configDir or contains a NUL byte.
 */
function assertDestWithinConfigHome(configDir: string, destSubpath: string): string {
  if (destSubpath.includes('\0')) {
    throw new Error(
      `destSubpath "${destSubpath}" contains a NUL byte and is not valid`,
    );
  }
  const root = path.resolve(configDir);
  // `resolved === root` is a DELIBERATE ADDITIONAL rejection, separate from
  // the containment decision: `tryWithinRootLexical` treats target === root
  // as CONTAINED, but a destSubpath of "" (or one that resolves to configDir
  // itself) must never be accepted here — this is the strict-subpath
  // requirement Phase B of ADR-1239 imposes on third-party descriptors, and
  // it prevents a descriptor from writing at configHome itself. Kept as its
  // own check per ADR-4650 decision 6 (a wrapper may add its own conditions
  // on top of the canonical predicate, never invert it).
  const contained = tryWithinRootLexical(destSubpath, configDir);
  if (contained === null || contained === root) {
    throw new Error(
      `destSubpath "${destSubpath}" must be a strict subpath of configHome "${configDir}" — not configHome itself or outside it (escapes configHome)`,
    );
  }
  return contained;
}

function resolveRuntimeArtifactDestination(configDir: string, kind: ArtifactKind): string {
  return assertDestWithinConfigHome(resolveRuntimeArtifactInstallRoot(configDir, kind), kind.destSubpath);
}

function resolveRuntimeArtifactInstallRoot(configDir: string, kind: ArtifactKind): string {
  return typeof kind.home === 'string' && kind.home !== '' ? kind.home : configDir;
}

function shouldInstallCombinedFamily(behaviors: { combinedFamilyInstall?: boolean }): boolean {
  return Boolean(behaviors.combinedFamilyInstall);
}

function isLegacyFlatLocalInstall(behaviors: { localInstallStyle?: string }, scope: string): boolean {
  return scope === 'local' && behaviors.localInstallStyle === 'legacy-flat';
}

function shouldInstallStandaloneAgents(pluginOnlyInstall: boolean, skillsRuntime: boolean): boolean {
  return !pluginOnlyInstall && !skillsRuntime;
}

function requiredRuntimeSurfaceSources(
  layout: { kinds: Iterable<{ kind?: string }> },
  scope: string,
): Set<'commands' | 'agents'> {
  const required = new Set<'commands' | 'agents'>();
  if (!isGlobalScope(scope as InstallScope)) return required;
  for (const kind of layout.kinds) {
    if (kind.kind === 'commands' || kind.kind === 'skills') required.add('commands');
    if (kind.kind === 'agents' || kind.kind === 'kimi-agents') required.add('agents');
  }
  return required;
}

function shouldInstallCodexAgentConfig(
  behaviors: { tomlConfigInstall?: boolean },
  installMode: string,
): boolean {
  return behaviors.tomlConfigInstall === true && !isMinimalMode(installMode);
}

function copyWithPathReplacementSymlinkRefusalMessage(destDir: string, installRoot: string): string {
  return `copyWithPathReplacement: destDir "${destDir}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function installRuntimeArtifactsSymlinkRefusalMessage(dest: string, installRoot: string): string {
  return `installRuntimeArtifacts: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to create. If this is an intentional user-owned symlink layout (e.g. externalized skills/hooks dir, multi-account configHome, or a dotfiles-managed configHome), re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function installOpencodeFamilySkillsSymlinkRefusalMessage(dest: string, installRoot: string): string {
  return `installOpencodeFamilySkills: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function installAgentsKindStandaloneSymlinkRefusalMessage(dest: string, installRoot: string): string {
  return `installAgentsKindStandalone: destDir "${dest}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function syncRuntimeSurfaceCorpusSymlinkRefusalMessage(destination: string, installRoot: string): string {
  return `syncRuntimeSurfaceCorpus: destination "${destination}" contains a symlink the install root "${installRoot}" does not trust \u2014 refusing to write.`;
}

function installCodexConfigSymlinkRefusalMessage(targetDir: string): string {
  return `installCodexConfig: a Codex config path under "${targetDir}" contains a symlink the install root does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function installCodexAgentTomlSymlinkRefusalMessage(agentTomlPath: string): string {
  return `installCodexConfig: agent toml path "${agentTomlPath}" contains a symlink the install root does not trust \u2014 refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function addCleanupDir(cleanupDirs: string[], stagedDir: string, rewrittenDir: string | void): string {
  const sourceDir = rewrittenDir ?? stagedDir;
  if (sourceDir !== stagedDir) cleanupDirs.push(sourceDir);
  return sourceDir;
}

function createRuntimeArtifactInstallPlan(args: CreateRuntimeArtifactInstallPlanArgs): InstallPlanResult {
  const {
    layout,
    resolvedProfile,
    homedir,
    platform,
    resolveAttribution,
    projectDir,
    deps = {},
  } = args;
  const conversionExports = _require('./runtime-artifact-conversion.cjs') as RuntimeArtifactConversionExports;
  const rewriteStagedSkillBodies = deps.rewriteStagedSkillBodies ?? conversionExports.rewriteStagedSkillBodies;
  const rewriteStagedCommandBodies = deps.rewriteStagedCommandBodies ?? conversionExports.rewriteStagedCommandBodies;
  const cleanupDirs: string[] = [];
  const items: PlanItem[] = [];
  const scope = layout.scope ?? 'global';
  const rewriteOpts: RewriteOpts = {
    runtime: layout.runtime,
    configDir: layout.configDir,
    scope,
    homedir,
    platform,
    resolveAttribution,
  };

  // ADR-1235 §1: build the staging context once per plan. Agent kinds apply
  // the CORRECT pre-converter cross-cutting (path rewrites → attribution →
  // converter → normalize). This
  // mirrors the exact per-file order in the former inline agent loop.
  // NO _stampNonClaudeRuntimeDefaults — agents are NOT stamped in the inline loop.
  const os = _require('node:os') as typeof import('node:os');
  const { posixNormalize } = _require('./shell-command-projection.cjs') as { posixNormalize: (p: string) => string };
  const homedirFn: () => string = homedir ?? (() => os.homedir());
  const resolvedTarget = posixNormalize(path.resolve(layout.configDir));
  const homeDir = posixNormalize(homedirFn());
  // #2870: `scope` above is already the module-owned `InstallScope` value
  // (`layout.scope ?? 'global'`, defaulted before this point, so it is never
  // `undefined` here) — `isGlobalScope` projects it to the boolean
  // `_computePathPrefix`'s existing `isGlobal: boolean` API requires.
  const isGlobal = isGlobalScope(scope);
  const isOpencode = hostBehaviorsFor(layout.runtime).opencodePathPrefix === true;
  const isWindowsHost = (platform ?? process.platform) === 'win32';
  // #4377: descriptor-derived local dir name, so an opted-in local install
  // emits a project-relative prefix instead of this checkout's absolute path.
  const pathPrefix = conversionExports._computePathPrefix({ isGlobal, isOpencode, isWindowsHost, resolvedTarget, homeDir, localDirName: conversionExports._localIncludeDirName(layout.runtime) });
  const attribution = resolveAttribution ? resolveAttribution(layout.runtime) : undefined;
  // #2875 Part 2 (row I1): layout.configDir IS the install root the inline
  // agent loop called `targetDir` — same value, same resolution.
  const agentCtx: AgentCtx = {
    runtime: layout.runtime,
    pathPrefix,
    attribution,
    targetDir: layout.configDir,
    projectDir: projectDir ?? layout.configDir,
  };
  for (const kind of layout.kinds) {
    let stagedDir: string;
    try {
      // Agent kinds use the context for their pre-converter cross-cutting
      // sequence; other kinds ignore it.
      stagedDir = kind.stage(resolvedProfile, agentCtx);
    } catch (err) {
      return { ok: false, kind: 'stage_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
    }

    let sourceDir = stagedDir;
    try {
      if (kind.kind === 'commands') {
        const rewrittenDir = rewriteStagedCommandBodies(stagedDir, rewriteOpts);
        sourceDir = addCleanupDir(cleanupDirs, stagedDir, rewrittenDir);
      } else if (kind.kind === 'skills' || kind.kind === 'kimi-agents') {
        const rewrittenDir = rewriteStagedSkillBodies(stagedDir, rewriteOpts);
        sourceDir = addCleanupDir(cleanupDirs, stagedDir, rewrittenDir);
      }
      // Agent kinds: cross-cutting already applied INSIDE kind.stage() via agentCtx.
      // No POST-step needed. sourceDir stays as stagedDir.
    } catch (err) {
      return { ok: false, kind: 'rewrite_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
    }

    items.push({
      kind: kind.kind,
      sourceDir,
      destDir: resolveRuntimeArtifactDestination(layout.configDir, kind),
    });
  }

  return { ok: true, plan: { items, cleanupDirs } };
}

function createRuntimeArtifactUninstallPlan(layout: Layout): UninstallPlan {
  return {
    items: layout.kinds.map((kind) => ({
      kind: kind.kind,
      destDir: resolveRuntimeArtifactDestination(layout.configDir, kind),
    })),
  };
}

export = {
  assertDestWithinConfigHome,
  resolveRuntimeArtifactDestination,
  resolveRuntimeArtifactInstallRoot,
  shouldInstallCombinedFamily,
  isLegacyFlatLocalInstall,
  shouldInstallStandaloneAgents,
  requiredRuntimeSurfaceSources,
  shouldInstallCodexAgentConfig,
  copyWithPathReplacementSymlinkRefusalMessage,
  installRuntimeArtifactsSymlinkRefusalMessage,
  installOpencodeFamilySkillsSymlinkRefusalMessage,
  installAgentsKindStandaloneSymlinkRefusalMessage,
  syncRuntimeSurfaceCorpusSymlinkRefusalMessage,
  installCodexConfigSymlinkRefusalMessage,
  installCodexAgentTomlSymlinkRefusalMessage,
  createRuntimeArtifactInstallPlan,
  createRuntimeArtifactUninstallPlan,
};
