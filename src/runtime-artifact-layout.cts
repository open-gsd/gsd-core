'use strict';

/**
 * Runtime artifact layout module — resolves the artifact directory shapes
 * (commands, agents, skills, rules) for each supported runtime.
 *
 * grok is intentionally absent: it is in runtime-homes.cjs but not wired
 * here. The TypeError on unknown runtime is the loud-fail signal that a
 * runtime was added to the homes list without a layout entry.
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

// In .cts (CommonJS output) files, `require` is available as a global.
const _require: NodeRequire = require;

// ---------------------------------------------------------------------------
// Lazy installer exports (avoids GSD_TEST_MODE env mutation at module load)
// ---------------------------------------------------------------------------

interface InstallExports {
  readGsdCommandNames: () => string[];
  computePathPrefix: (opts: { isGlobal: boolean; isOpencode: boolean; isWindowsHost: boolean; resolvedTarget: string; homeDir: string }) => string;
  applyRuntimeContentRewritesInPlace: (stagedDir: string, runtime: string, pathPrefix: string, options?: { allMarkdown?: boolean; rewriteRuntimeDir?: boolean }) => void;
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

type ArtifactKindName = 'commands' | 'agents' | 'skills' | 'rules' | 'extensions';

// Mirrors the (unexported) ResolvedProfile in install-profiles.cts.
// Must stay in sync if that shape changes.
interface ResolvedProfile {
  name: string;
  skills: Set<string> | '*';
  agents: Set<string>;
}

interface ArtifactKind {
  kind: ArtifactKindName;
  destSubpath: string;
  prefix: string;
  stage: (resolvedProfile: ResolvedProfile) => string;
  cleanup?: (stagedDir: string) => void;
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
// Allowlisted runtimes
// ---------------------------------------------------------------------------

const ALLOWED_RUNTIMES = new Set([
  'claude', 'cursor', 'gemini', 'codex', 'copilot', 'antigravity',
  'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy',
  'cline', 'opencode', 'kilo', 'omp',
]);

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


function cleanupGeneratedStageDir(stagedDir: string): void {
  if (typeof stagedDir !== 'string') return;
  try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Build a skills kind descriptor.
 *
 * @param destSubpath
 * @param prefix
 * @param converterName  name of converter function in bin/install.js exports
 * @param runtime        canonical runtime ID (gates Hermes/Qwen branding in converter)
 * @param configDir      runtime config dir (for .gsd-source marker resolution)
 * @param nested         if true, nest concrete skills under their ns-* routers (#69)
 */
function skillsKind(
  destSubpath: string,
  prefix: string,
  converterName: string,
  runtime: string,
  configDir: string,
  nested = false,
): ArtifactKind {
  return {
    kind: 'skills',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const installExports = getInstallExports();
      const realConverter = installExports[converterName] as (content: string, skillName: string, runtime: string, cmdNames: string[]) => string;
      // Compute cmdNames once per stage call for performance (#3583).
      // Extra args are ignored by converters that don't need runtime/cmdNames.
      const cmdNames = installExports.readGsdCommandNames();
      const wrappedConverter = (content: string, skillName: string): string =>
        realConverter(content, skillName, runtime, cmdNames);
      return stageSkillsForRuntimeAsSkills(findInstallSourceRoot(configDir), resolved, wrappedConverter, prefix, nested);
    },
  };
}

/**
 * Build a converted-commands kind descriptor for runtimes that use a flat
 * commands directory with per-file conversion (e.g. Cursor 1.6 slash commands).
 *
 * Unlike `commandsKind` (which passes raw source files through), this kind
 * applies `converterName` from bin/install.js exports to each file during
 * staging, writing flat `${prefix}${stem}.md` files to the staged directory.
 *
 * The staged files are then written by `_copyStaged` (commands branch) which
 * handles prefix logic via the existing layout machinery.
 *
 * @param destSubpath   destination subpath within configDir (e.g. 'commands')
 * @param prefix        filename prefix, e.g. 'gsd-'
 * @param converterName name of converter function in bin/install.js exports
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
      const installExports = getInstallExports();
      const converter = installExports[converterName] as (content: string, commandName: string) => string;
      return stageCommandsForRuntimeFlat(findInstallSourceRoot(configDir), resolved, converter, prefix);
    },
  };
}


function convertedAgentsKind(destSubpath: string, prefix: string, converterName: string, configDir: string): ArtifactKind {
  return {
    kind: 'agents',
    destSubpath,
    prefix,
    stage: (resolved) => {
      const installExports = getInstallExports();
      const converter = installExports[converterName] as (content: string, options?: { modelOverride?: string }) => string;
      const readOverrides = installExports.readGsdEffectiveModelOverrides as ((configDir: string) => Record<string, string>) | undefined;
      const modelOverrides = converterName === 'convertClaudeAgentToOmpAgent' && typeof readOverrides === 'function'
        ? readOverrides(configDir)
        : null;
      const src = stageAgentsForProfile(findAgentsSourceRoot(configDir), resolved);
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-agents-'));
      if (!fs.existsSync(src)) return dest;
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const agentName = entry.name.slice(0, -3);
        const content = fs.readFileSync(path.join(src, entry.name), 'utf8');
        const modelOverride = modelOverrides?.[agentName];
        fs.writeFileSync(path.join(dest, entry.name), converter(content, { modelOverride }));
      }
      return dest;
    },
    cleanup: cleanupGeneratedStageDir,
  };
}

function rulesKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'rules',
    destSubpath,
    prefix,
    stage: () => {
      const rulesDir = path.resolve(findInstallSourceRoot(configDir), '..', '..', 'gsd-core', 'omp', 'rules');
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-rules-'));
      if (!fs.existsSync(rulesDir)) return dest;
      for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        fs.copyFileSync(path.join(rulesDir, entry.name), path.join(dest, entry.name));
      }
      return dest;
    },
    cleanup: cleanupGeneratedStageDir,
  };
}

function extensionsKind(destSubpath: string, prefix: string, configDir: string): ArtifactKind {
  return {
    kind: 'extensions',
    destSubpath,
    prefix,
    stage: () => {
      const extensionsDir = path.resolve(findInstallSourceRoot(configDir), '..', '..', 'gsd-core', 'omp', 'extensions');
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-omp-extensions-'));
      if (!fs.existsSync(extensionsDir)) return dest;
      for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || !entry.name.startsWith(prefix)) continue;
        fs.cpSync(path.join(extensionsDir, entry.name), path.join(dest, entry.name), { recursive: true });
      }
      return dest;
    },
    cleanup: cleanupGeneratedStageDir,
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
//     claude     — https://code.claude.com/docs/en/skills + anthropics/claude-code#28266
//                  (scans one level under ~/.claude/skills; nested skills not auto-listed)
//     omp        — OMP extension filesystem discovery from .omp/agent/skills/ uses flat one-level scan
//     cline      — cline/cline skills.ts scanSkillsDirectory uses flat fs.readdir
//     qwen       — QwenLM/qwen-code skill-load.ts flat readdir ("depth 2 enough")
//     hermes     — hermes-agent.nousresearch.com/docs/user-guide/features/skills
//                  (single-level subdir probe of the tap path)
//     augment    — https://docs.augmentcode.com/cli/skills (flat single-level)
//     trae       — docs.trae.ai/ide/skills + Trae-AI/TRAE#2253 (flat; nesting errors)
//     antigravity— discuss.ai.google.dev/t/more-antigravity-issues/145875 ("will not recursive scan")
//
//   FLAT (recursive loader → nesting gives no saving):
//     cursor     — https://cursor.com/docs/skills (walks skills root recursively)
//     opencode   — sst/opencode skill/index.ts glob "skills/**/SKILL.md"
//     kilo       — Kilo-Org/kilocode (opencode fork, same ** glob)
//
//   FLAT (nested-scan behaviour unconfirmed → conservative):
//     codex      — developers.openai.com/codex/skills/
//     copilot    — docs.github.com/en/copilot/concepts/agents/about-agent-skills
//     windsurf   — docs.devin.ai/desktop/cascade/skills
//     codebuddy  — codebuddy.ai/docs/cli/skills

/**
 * Resolve the artifact layout for a given runtime and config directory.
 */
function resolveRuntimeArtifactLayout(runtime: string, configDir: string, scope: 'local' | 'global' = 'global'): Layout {
  if (typeof configDir !== 'string' || configDir === '') {
    throw new TypeError('configDir must be a non-empty string');
  }
  if (scope !== 'local' && scope !== 'global') {
    throw new TypeError('scope must be "local" or "global"');
  }
  if (!ALLOWED_RUNTIMES.has(runtime)) {
    throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  let kinds: ArtifactKind[];
  switch (runtime) {
    case 'claude':
      if (scope === 'local') {
        kinds = [
          commandsKind('commands/gsd', 'gsd-', configDir),
          agentsKind('agents', 'gsd-', configDir),
        ];
      } else {
        kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToClaudeSkill', 'claude', configDir, true /* #69 nested: non-recursive scan, see matrix above */)];
      }
      break;

    case 'cursor':
      // Cursor 1.6+ supports two artifact surfaces:
      //   1. skills/gsd-<name>/SKILL.md  — rich skills with frontmatter + adapter header
      //   2. commands/gsd-<name>.md      — plain markdown slash commands (no frontmatter)
      //      accessed via '/' in the Agent input (#785)
      kinds = [
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToCursorSkill', 'cursor', configDir),
        convertedCommandsKind('commands', 'gsd-', 'convertClaudeCommandToCursorCommand', configDir),
      ];
      break;

    case 'gemini':
      kinds = [commandsKind('commands/gsd', 'gsd-', configDir)];
      break;

    case 'codex':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCodexSkill', 'codex', configDir)];
      break;

    case 'copilot':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToCopilotSkill', 'copilot', configDir)];
      break;

    case 'antigravity':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToAntigravitySkill', 'antigravity', configDir, true /* #69 nested */)];
      break;

    case 'windsurf':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToWindsurfSkill', 'windsurf', configDir)];
      break;

    case 'augment':
      kinds = [
        commandsKind('commands', 'gsd-', configDir),
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToAugmentSkill', 'augment', configDir, true /* #69 nested */),
      ];
      break;

    case 'trae':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToTraeSkill', 'trae', configDir, true /* #69 nested */)];
      break;

    case 'qwen':
      kinds = [skillsKind('skills', 'gsd-', 'convertClaudeCommandToClaudeSkill', 'qwen', configDir, true /* #69 nested */)];
      break;

    case 'hermes':
      kinds = [skillsKind('skills/gsd', '', 'convertClaudeCommandToClaudeSkill', 'hermes', configDir, true /* #69 nested */)];
      break;

    case 'codebuddy':
      // CodeBuddy (Tencent) reads two user-level surfaces (codebuddy.ai/docs/cli):
      //   1. commands/gsd-<name>.md      — slash commands shown in the '/' menu (#789)
      //   2. skills/gsd-<name>/SKILL.md  — model-invocable skills, emitted with
      //      user-invocable:false so they stay OUT of '/' (the commands surface is
      //      the sole '/' entry point) — avoids a duplicated /gsd-* per workflow.
      // Subagents (~/.codebuddy/agents/) are already emitted by the generic agents
      // block in bin/install.js; MCP is excluded (gsd ships no MCP server).
      kinds = [
        convertedCommandsKind('commands', 'gsd-', 'convertClaudeCommandToCodebuddyCommand', configDir),
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToCodebuddySkill', 'codebuddy', configDir),
      ];
      break;

    case 'cline':
      kinds = scope === 'global' ? [skillsKind('skills', 'gsd-', 'convertClaudeCommandToClineSkill', 'cline', configDir, true /* #69 nested */)] : [];
      break;

    case 'omp':
      kinds = [
        convertedCommandsKind('commands', 'gsd-', 'convertClaudeCommandToOmpCommand', configDir),
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToOmpSkill', 'omp', configDir, true /* #69 nested */),
        convertedAgentsKind('agents', 'gsd-', 'convertClaudeAgentToOmpAgent', configDir),
        rulesKind('rules', 'gsd-', configDir),
        extensionsKind('extensions', 'gsd-', configDir),
      ];
      break;

    case 'opencode':
      // OpenCode reads flat slash commands from command/ and on-demand skills
      // from skills/<name>/SKILL.md (https://opencode.ai/docs/skills). Emit both.
      kinds = [
        commandsKind('command', 'gsd-', configDir),
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToOpencodeSkill', 'opencode', configDir),
      ];
      break;

    case 'kilo':
      // Kilo derives from OpenCode and shares the skills/<name>/SKILL.md layout
      // (https://kilo.ai/docs/customize/skills). Emit flat commands + skills.
      kinds = [
        commandsKind('command', 'gsd-', configDir),
        skillsKind('skills', 'gsd-', 'convertClaudeCommandToKiloSkill', 'kilo', configDir),
      ];
      break;

    default:
      throw new TypeError(`Unknown runtime: '${runtime}' — add to runtime-artifact-layout.cjs table`);
  }

  return { runtime, configDir, scope, kinds };
}

export = { resolveRuntimeArtifactLayout, findInstallSourceRoot, getInstallExports };
