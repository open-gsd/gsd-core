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

type ArtifactKindName = 'commands' | 'agents' | 'skills' | 'kimi-agents';
type InstallScope = 'local' | 'global';

interface ResolvedProfile {
  name?: string;
  skills?: Set<string> | '*';
  agents?: Set<string>;
}

interface ArtifactKind {
  kind: ArtifactKindName;
  destSubpath: string;
  prefix?: string;
  stage: (resolvedProfile: ResolvedProfile) => string;
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

interface RuntimeArtifactConversionExports {
  rewriteStagedSkillBodies: (stagedDir: string, opts: RewriteOpts) => string | void;
  rewriteStagedCommandBodies: (stagedDir: string, opts: RewriteOpts) => string | void;
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
  const resolved = path.resolve(configDir, destSubpath);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `destSubpath "${destSubpath}" must be a strict subpath of configHome "${configDir}" — not configHome itself or outside it (escapes configHome)`,
    );
  }
  return resolved;
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

  for (const kind of layout.kinds) {
    let stagedDir: string;
    try {
      stagedDir = kind.stage(resolvedProfile);
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
    } catch (err) {
      return { ok: false, kind: 'rewrite_failed', message: errorMessage(err), cleanupDirs, failedKind: kind.kind };
    }

    items.push({
      kind: kind.kind,
      sourceDir,
      destDir: assertDestWithinConfigHome(layout.configDir, kind.destSubpath),
    });
  }

  return { ok: true, plan: { items, cleanupDirs } };
}

function createRuntimeArtifactUninstallPlan(layout: Layout): UninstallPlan {
  return {
    items: layout.kinds.map((kind) => ({
      kind: kind.kind,
      destDir: assertDestWithinConfigHome(layout.configDir, kind.destSubpath),
    })),
  };
}

export = { assertDestWithinConfigHome, createRuntimeArtifactInstallPlan, createRuntimeArtifactUninstallPlan };
