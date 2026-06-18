/**
 * Claude Orchestration Policy - issue #1143.
 *
 * Pure policy for selecting the Claude Code execution backend and refusing
 * known-unsafe manual dispatch modes. The module is intentionally small:
 * capability registration owns activation, and the host loop consumes the
 * blocking preflight through the generic gate contract.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { loadConfig } = configLoader as {
  loadConfig: (cwd: string) => ClaudeOrchestrationConfig;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspace;
import { resolveTeamsStatus } from './teams-status.cjs';

type ClaudeBackend = 'auto' | 'inline' | 'workflow';

export interface ClaudeOrchestrationConfig {
  'workflow.claude_orchestration'?: unknown;
  'workflow.claude_orchestration_backend'?: unknown;
  workflow?: {
    claude_orchestration?: unknown;
    claude_orchestration_backend?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ClaudeOrchestrationStatus {
  enabled: boolean;
  active: boolean;
  runtime: string;
  requested_backend: ClaudeBackend;
  selected_backend: 'inline' | 'workflow';
  workflow_available: boolean;
  workflows_disabled: boolean;
  teams_active: boolean;
  manual_dispatch_safe: boolean;
  config_error: string | null;
  block: boolean;
  passed: boolean;
  reason:
    | 'disabled'
    | 'non-claude-runtime'
    | 'inline-ready'
    | 'config-read-failed'
    | 'invalid-backend'
    | 'workflow-backend-unavailable'
    | 'manual-dispatch-unsafe-with-agent-teams';
  message: string;
}

interface BackendSelection {
  backend: ClaudeBackend;
  invalidRaw: string | null;
}

interface ConfigReadError {
  reason: 'config-read-failed' | 'invalid-backend';
  message: string;
}

interface ProjectConfigRead {
  config: ClaudeOrchestrationConfig;
  error: ConfigReadError | null;
}

const VALID_BACKENDS = new Set<ClaudeBackend>(['auto', 'inline', 'workflow']);

function strictEnvFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = (env[key] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function strictBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0' || raw === '') return false;
  }
  return fallback;
}

function configValue(config: ClaudeOrchestrationConfig | undefined, dottedKey: string): unknown {
  if (!config) return undefined;
  if (Object.prototype.hasOwnProperty.call(config, dottedKey)) return config[dottedKey];
  const parts = dottedKey.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function describeInvalidConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || typeof value === 'symbol'
  ) {
    return value.toString();
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch { /* fall through to generic tag */ }
  return Object.prototype.toString.call(value);
}

function requestedBackend(config: ClaudeOrchestrationConfig | undefined): BackendSelection {
  const raw = configValue(config, 'workflow.claude_orchestration_backend');
  if (raw === undefined || raw === null) return { backend: 'auto', invalidRaw: null };
  if (typeof raw !== 'string') return { backend: 'auto', invalidRaw: describeInvalidConfigValue(raw) };
  const normalized = raw.trim().toLowerCase();
  if (VALID_BACKENDS.has(normalized as ClaudeBackend)) {
    return { backend: normalized as ClaudeBackend, invalidRaw: null };
  }
  return { backend: 'auto', invalidRaw: raw };
}

function validateRawProjectConfig(cwd: string): ConfigReadError | null {
  const configPath = path.join(planningDir(cwd), 'config.json');
  if (!fs.existsSync(configPath)) return null;

  let parsed: ClaudeOrchestrationConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ClaudeOrchestrationConfig;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      reason: 'config-read-failed',
      message: `Claude orchestration cannot read .planning/config.json (${detail}); fix the config before executing waves.`,
    };
  }

  const backend = requestedBackend(parsed);
  if (backend.invalidRaw !== null) {
    return {
      reason: 'invalid-backend',
      message: `workflow.claude_orchestration_backend must be one of auto, inline, or workflow; got ${JSON.stringify(backend.invalidRaw)}.`,
    };
  }

  return null;
}

function readProjectConfig(cwd: string): ProjectConfigRead {
  const rawError = validateRawProjectConfig(cwd);
  if (rawError) return { config: {}, error: rawError };

  try {
    return { config: loadConfig(cwd), error: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      config: {},
      error: {
        reason: 'config-read-failed',
        message: `Claude orchestration cannot load project config (${detail}); fix the config before executing waves.`,
      },
    };
  }
}

/**
 * Resolve Claude orchestration readiness from injected runtime, env, and config.
 * This function is pure: no process.env, filesystem, or subprocess reads.
 */
export function resolveClaudeOrchestrationStatus(opts: {
  runtime: string;
  env: NodeJS.ProcessEnv;
  config?: ClaudeOrchestrationConfig;
  configError?: ConfigReadError | null;
}): ClaudeOrchestrationStatus {
  const runtime = (opts.runtime || 'claude').trim().toLowerCase();
  const enabled = strictBoolean(configValue(opts.config, 'workflow.claude_orchestration'), false);
  const backendSelection = requestedBackend(opts.config);
  const backend = backendSelection.backend;
  const workflowsDisabled = strictEnvFlag(opts.env, 'CLAUDE_CODE_DISABLE_WORKFLOWS');
  const workflowAvailable = runtime === 'claude' && !workflowsDisabled;
  const teams = resolveTeamsStatus({ runtime, env: opts.env });
  const teamsActive = teams.active;
  const manualDispatchSafe = !teamsActive;
  const selectedBackend: 'inline' | 'workflow' = 'inline';

  let block = false;
  let reason: ClaudeOrchestrationStatus['reason'] = 'disabled';
  let message = 'Claude orchestration capability is disabled.';
  let configError: string | null = opts.configError?.message ?? null;

  if (opts.configError) {
    block = true;
    reason = opts.configError.reason;
    message = opts.configError.message;
  } else if (backendSelection.invalidRaw !== null) {
    block = true;
    configError = `Invalid workflow.claude_orchestration_backend: ${JSON.stringify(backendSelection.invalidRaw)}`;
    reason = 'invalid-backend';
    message = 'workflow.claude_orchestration_backend must be one of auto, inline, or workflow.';
  } else if (!enabled) {
    reason = 'disabled';
  } else if (runtime !== 'claude') {
    reason = 'non-claude-runtime';
    message = `Claude orchestration is enabled but runtime is "${runtime}"; skipping Claude-only backend selection.`;
  } else if (backend === 'workflow') {
    block = true;
    reason = 'workflow-backend-unavailable';
    message = workflowsDisabled
      ? 'Claude orchestration workflow backend was requested, but workflows are disabled in this environment.'
      : 'Claude orchestration workflow backend is reserved until the generated Workflow executor is implemented; use auto or inline for the current preflight slice.';
  } else if (selectedBackend === 'inline' && !manualDispatchSafe) {
    block = true;
    reason = 'manual-dispatch-unsafe-with-agent-teams';
    message = 'Claude manual background-agent dispatch is unsafe while Claude Code agent teams are active; disable agent teams or disable this capability before executing waves.';
  } else {
    reason = 'inline-ready';
    message = 'Claude orchestration will use inline executor dispatch.';
  }

  return {
    enabled,
    active: enabled && runtime === 'claude',
    runtime,
    requested_backend: backend,
    selected_backend: selectedBackend,
    workflow_available: workflowAvailable,
    workflows_disabled: workflowsDisabled,
    teams_active: teamsActive,
    manual_dispatch_safe: manualDispatchSafe,
    config_error: configError,
    block,
    passed: !block,
    reason,
    message,
  };
}

function resolveFromProject(cwd: string): ClaudeOrchestrationStatus {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeSlash = require('./runtime-slash.cjs') as {
    resolveRuntime: (projectDir: string | null | undefined) => string;
  };
  const projectConfig = readProjectConfig(cwd);
  return resolveClaudeOrchestrationStatus({
    runtime: runtimeSlash.resolveRuntime(cwd),
    env: process.env,
    config: projectConfig.config,
    configError: projectConfig.error,
  });
}

export function cmdClaudeOrchestrationStatus(cwd: string, raw: boolean): void {
  output(resolveFromProject(cwd), raw, undefined);
}

export function cmdClaudeOrchestrationPreflight(cwd: string, raw: boolean): void {
  output(resolveFromProject(cwd), raw, undefined);
}
