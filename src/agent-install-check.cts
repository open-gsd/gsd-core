/**
 * Agent Install Check — moved from core.cts (ADR-857 T0 #1268 phase rehome-core-squatters).
 *
 * Owns:
 *   - getAgentsDir(runtime?): string
 *   - checkAgentsInstalled(runtime?): AgentsInstalledResult
 *
 * The core.cjs re-export spine was retired in epic #1267; callers import
 * these symbols from agent-install-check.cjs directly.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
import { getGlobalConfigDir } from './runtime-homes.cjs';
import { getDirName } from './runtime-name-policy.cjs';
const { MODEL_PROFILES } = modelProfiles;

interface AgentsInstalledResult {
  agents_installed: boolean;
  missing_agents: string[];
  installed_agents: string[];
  incomplete_agents: string[];
  agents_dir: string;
  agent_runtime: string;
}

/**
 * Resolve the agents directory for the given runtime.
 *
 * Priority:
 *   1. GSD_AGENTS_DIR env var (explicit override, any runtime)
 *   2. For claude runtime: __dirname-relative path (agents/ sibling of gsd-core/)
 *      This is correct for both repo runs and real installs (the runtime config dir's
 *      agents/ folder) because gsd-tools.cjs lives inside gsd-core/bin/ in both cases.
 *   3. For non-claude runtimes: getGlobalConfigDir(runtime)/agents
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 */
function getAgentsDir(runtime?: string, projectDir?: string): string {
  if (process.env['GSD_AGENTS_DIR']) {
    return process.env['GSD_AGENTS_DIR'];
  }
  const resolved = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  // Check local install dir first: <projectDir>/.<dirName>/agents/
  if (projectDir) {
    const dirName = getDirName(resolved);
    const localAgentsDir = path.join(projectDir, dirName, 'agents');
    if (fs.existsSync(localAgentsDir)) {
      return localAgentsDir;
    }
  }
  return path.join(getGlobalConfigDir(resolved), 'agents');
}

/**
 * Check which GSD agents are installed on disk.
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectDir - project root dir; when provided, checks local install dir first
 */
function checkAgentsInstalled(runtime?: string, projectDir?: string): AgentsInstalledResult {
  const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  // If the resolved runtime's agents dir doesn't exist locally, check the
  // .gsd-runtime install marker — config.json's runtime field can drift from
  // the actual install (e.g. config says "pi" but the install was --omp).
  let effectiveRuntime = resolvedRuntime;
  if (projectDir) {
    // Check if a local install exists for the resolved runtime.
    // If not, look for a .gsd-runtime marker — config.json's runtime field can
    // drift from the actual install (e.g. config says "pi" but the install was --omp).
    const resolvedDirName = getDirName(resolvedRuntime);
    const localAgentsDir = path.join(projectDir, resolvedDirName, 'agents');
    if (!fs.existsSync(localAgentsDir)) {
      // Scan common local install dirs for a .gsd-runtime marker
      for (const dirName of ['.omp', '.pi', '.claude', '.opencode', '.kilo', '.codex', '.copilot', '.cursor', '.windsurf', '.augment', '.trae', '.qwen', '.hermes', '.codebuddy', '.cline', '.zcode']) {
        const markerPath = path.join(projectDir, dirName, 'gsd-core', '.gsd-runtime');
        try {
          if (fs.existsSync(markerPath)) {
            const markerRuntime = fs.readFileSync(markerPath, 'utf8').trim();
            if (markerRuntime && markerRuntime !== resolvedRuntime) {
              const markerLocalDir = path.join(projectDir, getDirName(markerRuntime), 'agents');
              if (fs.existsSync(markerLocalDir)) {
                effectiveRuntime = markerRuntime;
                break;
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  }
  const agentsDir = getAgentsDir(effectiveRuntime, projectDir);
  const expectedAgents = Object.keys(MODEL_PROFILES);
  const installed: string[] = [];
  const missing: string[] = [];

  if (!fs.existsSync(agentsDir)) {
    return {
      agents_installed: false,
      missing_agents: expectedAgents,
      installed_agents: [],
      incomplete_agents: [],
      agents_dir: agentsDir,
      agent_runtime: effectiveRuntime,
    };
  }

  for (const agent of expectedAgents) {
    const agentFile = path.join(agentsDir, `${agent}.md`);
    const agentFileCopilot = path.join(agentsDir, `${agent}.agent.md`);
    const agentFileCodex = path.join(agentsDir, `${agent}.toml`);
    const agentFileKimiYaml = path.join(agentsDir, 'subagents', `${agent}.yaml`);
    const agentFileKimiPrompt = path.join(agentsDir, 'subagents', `${agent}.md`);
    const kimiAgentInstalled =
      resolvedRuntime === 'kimi' &&
      fs.existsSync(agentFileKimiYaml) &&
      fs.existsSync(agentFileKimiPrompt);
    if (
      fs.existsSync(agentFile) ||
      fs.existsSync(agentFileCopilot) ||
      fs.existsSync(agentFileCodex) ||
      kimiAgentInstalled
    ) {
      installed.push(agent);
    } else {
      missing.push(agent);
    }
  }

  // ── Manifest-backed completeness check ──────────────────────────────────────
  // If a gsd-file-manifest.json exists alongside the agents dir (parent dir),
  // verify that every manifest-tracked file for each expected agent is present
  // on disk. Missing manifest-tracked files indicate an incomplete install even
  // when the plain presence check above passed (e.g. .md present, .toml absent).
  // If no manifest is found the check is a no-op (graceful for claude/bundled).
  const incomplete: string[] = [];
  const manifestPath = path.join(path.dirname(agentsDir), 'gsd-file-manifest.json');
  let manifestFiles: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'files' in parsed &&
      typeof (parsed as Record<string, unknown>)['files'] === 'object' &&
      (parsed as Record<string, unknown>)['files'] !== null
    ) {
      manifestFiles = (parsed as Record<string, Record<string, unknown>>)['files'];
    }
  } catch {
    // No manifest or unreadable — completeness check is skipped
  }

  if (Object.keys(manifestFiles).length > 0) {
    for (const agent of expectedAgents) {
      // Find all manifest keys that belong to this agent:
      // key must be "agents/<agentName>.<ext>" with no further path segments.
      const agentPrefix = `agents/${agent}.`;
      const agentManifestKeys = Object.keys(manifestFiles).filter(key => {
        if (!key.startsWith(agentPrefix)) return false;
        const rest = key.slice(agentPrefix.length);
        // rest must be a bare extension (no slashes, non-empty)
        return rest.length > 0 && !rest.includes('/');
      });
      if (agentManifestKeys.length === 0) {
        // Agent not tracked in manifest — skip completeness check for this agent
        continue;
      }
      const allPresent = agentManifestKeys.every(key => {
        const basename = key.slice('agents/'.length);
        return fs.existsSync(path.join(agentsDir, basename));
      });
      if (!allPresent) {
        incomplete.push(agent);
      }
    }
  }

  return {
    agents_installed: installed.length > 0 && missing.length === 0 && incomplete.length === 0,
    missing_agents: missing,
    installed_agents: installed,
    incomplete_agents: incomplete,
    agents_dir: agentsDir,
    agent_runtime: effectiveRuntime,
  };
}

export = {
  getAgentsDir,
  checkAgentsInstalled,
};
