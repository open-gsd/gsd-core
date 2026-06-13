'use strict';

/**
 * Runtime artifact layout module — resolves the artifact directory shapes
 * (commands, agents, skills) for each supported runtime.
 *
 * grok is intentionally absent: it is in runtime-homes.cjs but has no runtime
 * capability descriptor. The TypeError on unknown runtime is the loud-fail
 * signal that a runtime was added without an artifact layout descriptor.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/runtime-artifact-layout.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import installProfiles = require('./install-profiles.cjs');
const {
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageSkillsForRuntimeAsSkills,
  stageCommandsForRuntimeFlat,
} = installProfiles;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import runtimeArtifactConversion = require('./runtime-artifact-conversion.cjs');
const conversionExports = runtimeArtifactConversion as Record<string, unknown> & {
  readGsdCommandNames?: () => string[];
};

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ---------------------------------------------------------------------------
// Lazy installer exports (avoids GSD_TEST_MODE env mutation at module load)
// ---------------------------------------------------------------------------

interface InstallExports {
  computePathPrefix: (opts: { isGlobal: boolean; isOpencode: boolean; isWindowsHost: boolean; resolvedTarget: string; homeDir: string }) => string;
  applyRuntimeContentRewritesInPlace: (stagedDir: string, runtime: string, pathPrefix: string) => void;
  [converterName: string]: unknown;
}

/**
 * Load bin/install.js exports in a test-safe way.
 * Sets GSD_TEST_MODE only for the duration of the require() call and only if
 * it was not already set, restoring the original value in a finally block so
 * the module-level environment is never permanently mutated.
 */
function loadInstallExports(): InstallExports {
  const savedTestMode = process.env['GSD_TEST_MODE'];
  if (savedTestMode === undefined) process.env['GSD_TEST_MODE'] = '1';
  try {
    return _require('../../../bin/install.js') as InstallExports;
  } finally {
    if (savedTestMode === undefined) delete process.env['GSD_TEST_MODE'];
    else process.env['GSD_TEST_MODE'] = savedTestMode;
  }
}

/** Cache after first successful load. */
let _installExports: InstallExports | null = null;
function getInstallExports(): InstallExports {
  if (!_installExports) _installExports = loadInstallExports();
  return _installExports;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArtifactKindName = 'commands' | 'agents' | 'skills';
type KimiArtifactKindName = ArtifactKindName | 'kimi-agents';

// Mirrors the (unexported) ResolvedProfile in install-profiles.cts.
// Must stay in sync if that shape changes.
interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

interface ArtifactKind {
  kind: KimiArtifactKindName;
  destSubpath: string;
  prefix: string;
  stage: (resolvedProfile: ResolvedProfile) => string;
}

interface Layout {
  runtime: string;
  configDir: string;
  scope?: 'local' | 'global';
  kinds: ArtifactKind[];
}

// ---------------------------------------------------------------------------
// Source root finders
// ---------------------------------------------------------------------------

/**
 * Locate the GSD commands/gsd source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findInstallSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) return src;
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'commands', 'gsd');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findInstallSourceRoot: could not locate commands/gsd from ${__dirname}`);
}

/**
 * Locate the GSD agents source directory.
 *
 * Resolution order:
 * 1. If runtimeConfigDir provided, check <runtimeConfigDir>/.gsd-source marker.
 * 2. Walk up from __dirname using path.dirname (no literal .. segments).
 * 3. Throw a descriptive error if neither succeeds.
 */
function findAgentsSourceRoot(runtimeConfigDir?: string): string {
  // Step 1: marker check
  if (runtimeConfigDir) {
    const markerPath = path.join(runtimeConfigDir, '.gsd-source');
    if (fs.existsSync(markerPath)) {
      try {
        const src = fs.readFileSync(markerPath, 'utf8').trim();
        if (src && fs.existsSync(src)) {
          // Marker points to commands/gsd; agents/ is a sibling of commands/
          const agentsCandidate = path.resolve(path.dirname(src), '..', 'agents');
          if (fs.existsSync(agentsCandidate)) return agentsCandidate;
        }
      } catch { /* fall through */ }
    }
  }

  // Step 2: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'agents');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`findAgentsSourceRoot: could not locate agents/ from ${__dirname}`);
}

// ---------------------------------------------------------------------------
// Layout table builders
// ---------------------------------------------------------------------------

function commandsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'commands',
    destSubpath,
    prefix,
    stage: (resolved) => stageSkillsForProfile(findInstallSourceRoot(configDir), resolved),
  };
}

function agentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'agents',
    destSubpath,
    prefix,
    stage: (resolved) => stageAgentsForProfile(findAgentsSourceRoot(configDir), resolved),
  };
}

function kimiAgentsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'kimi-agents',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const buildKimiAgentArtifacts = conversionExports['buildKimiAgentArtifacts'] as (opts: {
        rootAgent?: string;
        subagents?: Array<{ path: string; content: string }>;
      }) => {
        root: { yaml: string; prompt: string };
        subagents: Array<{ name: string; yaml: string; prompt: string }>;
      };
      const stagedAgents = stageAgentsForProfile(findAgentsSourceRoot(configDir), resolved);
      const subagents: Array<{ path: string; content: string }> = [];
      if (fs.existsSync(stagedAgents)) {
        for (const entry of fs.readdirSync(stagedAgents, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          const agentPath = path.join(stagedAgents, entry.name);
          subagents.push({
            path: path.join('agents', entry.name).replace(/\\/g, '/'),
            content: fs.readFileSync(agentPath, 'utf8'),
          });
        }
      }

      const rootAgent = `---\nname: gsd\ndescription: Run GSD workflows in Kimi CLI.\ntools: Agent\n---\n\n# GSD for Kimi CLI\n\nCoordinate installed /skill:gsd-* workflows and route work to generated GSD subagents when a workflow requires an agent handoff.\n`;
      const artifacts = buildKimiAgentArtifacts({ rootAgent, subagents });
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-agents-'));
      installProfiles.STAGED_DIRS.add(stageDir);
      fs.writeFileSync(path.join(stageDir, 'gsd.yaml'), artifacts.root.yaml);
      fs.writeFileSync(path.join(stageDir, 'gsd.md'), artifacts.root.prompt);
      const subagentsDir = path.join(stageDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      for (const artifact of artifacts.subagents) {
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.yaml`), artifact.yaml);
        fs.writeFileSync(path.join(subagentsDir, `${artifact.name}.md`), artifact.prompt);
      }
      return stageDir;
    },
  };
}

/**
 * Build a skills kind descriptor.
 *
 * @param destSubpath
 * @param prefix
 * @param converterName  name of converter function in Runtime Artifact Conversion exports
 * @param runtime        canonical runtime ID (gates Hermes/Qwen branding in converter)
 * @param configDir      runtime config dir (for .gsd-source marker resolution)
 * @param nested         if true, nest concrete skills under their ns-* routers (#69)
 * @param scope          install scope; converted to isGlobal and passed as 5th positional
 *                       arg so scope-aware converters (antigravity, copilot) can choose
 *                       between global home paths and workspace-relative paths without
 *                       colliding with the `runtime` string at position 3.
 */
function skillsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  runtime: string,
  configDir: string,
  nested = false,
  scope: 'local' | 'global' = 'global',
): ArtifactKind {
  return {
    kind: 'skills',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const realConverter = conversionExports[converterName] as (content: string, skillName: string, runtime: string, cmdNames: string[], isGlobal: boolean) => string;
      // Compute cmdNames once per stage call for performance (#3583).
      // Extra trailing args are ignored by converters that don't need them. The
      // isGlobal flag is the 5th positional (NOT the 3rd): the 3rd positional is
      // `runtime` for the claude/kimi/cline converters, so the scope-aware
      // converters (antigravity, copilot) read isGlobal from position 5 to avoid
      // colliding with `runtime` and always taking the global branch.
      const cmdNames = conversionExports.readGsdCommandNames
        ? conversionExports.readGsdCommandNames()
        : [];
      const isGlobal = scope === 'global';
      const wrappedConverter = (content: string, skillName: string): string =>
        realConverter(content, skillName, runtime, cmdNames, isGlobal);
      return stageSkillsForRuntimeAsSkills(findInstallSourceRoot(configDir), resolved, wrappedConverter, prefix, nested);
    },
  };
}

/**
 * Build a converted-commands kind descriptor for runtimes that use a flat
 * commands directory with per-file conversion (e.g. Cursor 1.6 slash commands).
 *
 * Unlike `commandsKind` (which passes raw source files through), this kind
 * applies `converterName` from Runtime Artifact Conversion exports to each file during
 * staging, writing flat `${prefix}${stem}.md` files to the staged directory.
 *
 * The staged files are then written by `_copyStaged` (commands branch) which
 * handles prefix logic via the existing layout machinery.
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'commands')
 * @param prefix        filename prefix, e.g. 'gsd-'
 * @param converterName name of converter function in Runtime Artifact Conversion exports
 * @param configDir     runtime config dir (for .gsd-source marker resolution)
 */
function convertedCommandsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  configDir: string,
): ArtifactKind {
  return {
    kind: 'commands',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const converter = conversionExports[converterName] as (content: string, commandName: string) => string;
      return stageCommandsForRuntimeFlat(findInstallSourceRoot(configDir), resolved, converter, prefix);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Nested skill-bundle support matrix (#69)
// ---------------------------------------------------------------------------
//
// When a runtime's skill loader scans only one level deep (non-recursive), a
// concrete skill nested at `<router>/skills/<name>/SKILL.md` drops out of the
// eager top-level listing yet stays readable by file path — which is exactly
// what namespace routing needs. Recursive loaders surface every nested SKILL.md
// as a peer (zero token saving), so they stay flat. Unconfirmed loaders stay
// flat conservatively. Verified June 2026:
//
//   NEST (confirmed non-recursive / one-level scan):
//     cline      — cline/cline skills.ts scanSkillsDirectory uses flat fs.readdir
//     qwen       — QwenLM/qwen-code skill-load.ts flat readdir ("depth 2 enough")
//     hermes     — hermes-agent.nousresearch.com/docs/user-guide/features/skills
//                  (single-level subdir probe of the tap path)
//     augment    — https://docs.augmentcode.com/cli/skills (flat single-level)
//     trae       — docs.trae.ai/ide/skills + Trae-AI/TRAE#2253 (flat; nesting errors)
//                  Trae IDE (trae.ai), not trae-agent — see runtime-homes.cts header note
//     antigravity— discuss.ai.google.dev/t/more-antigravity-issues/145875 ("will not recursive scan")
//
//   FLAT (recursive loader → nesting gives no saving):
//     cursor     — https://cursor.com/docs/skills (walks skills root recursively)
//     opencode   — sst/opencode skill/index.ts glob "skills/**/SKILL.md"
//     kilo       — Kilo-Org/kilocode (opencode fork, same ** glob)
//
//   FLAT (reverted from nested — nested skills not discoverable by Skill tool, #924):
//     claude     — https://code.claude.com/docs/en/skills + anthropics/claude-code#28266
//                  (one-level scan under ~/.claude/skills — but Skill-tool errors on unknown
//                   names rather than re-routing via the router; concrete skills must be
//                   at the top level so Skill(skill="gsd-plan-phase") succeeds)
//
//   FLAT (nested-scan behaviour unconfirmed → conservative):
//     codex      — developers.openai.com/codex/skills/
//     copilot    — docs.github.com/en/copilot/concepts/agents/about-agent-skills
//     windsurf   — docs.devin.ai/desktop/cascade/skills
//     codebuddy  — codebuddy.ai/docs/cli/skills

// ---------------------------------------------------------------------------
// Descriptor-driven dispatch helpers (ADR-857 phase 5d)
// ---------------------------------------------------------------------------

interface ArtifactKindDescriptor {
  kind: string;
  destSubpath: string;
  prefix: string;
  nesting: 'flat' | 'nested';
  recursive: boolean;
  converter: string | null;
}

interface ArtifactLayoutDescriptor {
  global: ArtifactKindDescriptor[];
  local: ArtifactKindDescriptor[];
}

/** Lazy registry accessor — mirrors pattern from 5b/5c (runtime-homes.cts). */
interface RegistryLike {
  runtimes: Record<string, { runtime?: { artifactLayout?: ArtifactLayoutDescriptor } }>;
}

function getRegistry(): RegistryLike {
  return _require('./capability-registry.cjs') as {
    runtimes: Record<string, { runtime?: { artifactLayout?: ArtifactLayoutDescriptor } }>;
  };
}

/**
 * Map a single ArtifactKindDescriptor entry to an ArtifactKind using the
 * matching builder function. Mirrors the hand-built calls in the old switch.
 */
function dispatchKindEntry(entry: ArtifactKindDescriptor, runtime: string, configDir: string, scope: 'local' | 'global'): ArtifactKind {
  const { kind, destSubpath, prefix, nesting, converter } = entry;
  const nested = nesting === 'nested';

  switch (kind) {
    case 'commands':
      if (converter == null) {
        return commandsKind(destSubpath, prefix, configDir);
      }
      return convertedCommandsKind(destSubpath, prefix, converter, configDir);

    case 'agents':
      return agentsKind(destSubpath, prefix, configDir);

    case 'skills':
      if (converter == null) {
        throw new TypeError(
          `resolveRuntimeArtifactLayout: skills entry for '${runtime}' has converter=null (converter is required for skills)`,
        );
      }
      return skillsKind(destSubpath, prefix, converter, runtime, configDir, nested, scope);

    case 'kimi-agents':
      return kimiAgentsKind(destSubpath, prefix, configDir);

    default:
      throw new TypeError(
        `resolveRuntimeArtifactLayout: unknown kind '${kind}' in descriptor for runtime '${runtime}'`,
      );
  }
}

/**
 * Resolve the artifact layout for a given runtime and config directory.
 *
 * ADR-857 phase 5d: driven by the capability-registry artifactLayout descriptor
 * instead of a hardcoded switch statement.
 */
function resolveRuntimeArtifactLayout(runtime: string, configDir: string, scope: 'local' | 'global' = 'global'): Layout {
  return resolveRuntimeArtifactLayoutFromRegistry(getRegistry(), runtime, configDir, scope);
}

function resolveRuntimeArtifactLayoutFromRegistry(
  registry: RegistryLike,
  runtime: string,
  configDir: string,
  scope: 'local' | 'global' = 'global',
): Layout {
  if (typeof configDir !== 'string' || configDir === '') {
    throw new TypeError('configDir must be a non-empty string');
  }
  if (scope !== 'local' && scope !== 'global') {
    throw new TypeError('scope must be "local" or "global"');
  }

  const desc = registry.runtimes[runtime]?.runtime?.artifactLayout;
  if (!desc) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  const entries: ArtifactKindDescriptor[] = desc[scope] ?? [];
  const kinds: ArtifactKind[] = entries.map((entry) => dispatchKindEntry(entry, runtime, configDir, scope));

  return { runtime, configDir, scope, kinds };
}

export = { resolveRuntimeArtifactLayout, resolveRuntimeArtifactLayoutFromRegistry, findInstallSourceRoot, getInstallExports };
