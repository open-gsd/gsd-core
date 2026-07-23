/**
 * Cline SDK binding — AgentPlugin + createAgentModel adapters
 * (ADR-1239 Phase D / #2090).
 *
 * Two Context7-verified UPGRADES the file-convention projection ignored, now
 * delivered through the negotiated `hookBus: host` + `modelMode: active`
 * interface points:
 *
 *   UPGRADE 1 — `AgentPlugin.hooks.beforeTool` planning-artifact guard.
 *     Re-implements the `.clinerules/hooks/PreToolUse` file-convention hook
 *     (issue #787) as a real Cline SDK AgentPlugin. Guard semantics are
 *     preserved EXACTLY: fail-open, cancel (skip) write-class calls targeting
 *     `.planning/`, pass through everything else. The SDK maps the file hook's
 *     `{cancel:true, errorMessage}` to `{skip:true, reason}` (beforeTool
 *     contract).
 *     Cite: https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx
 *           https://github.com/cline/cline/blob/main/sdk/packages/agents/README.md
 *
 *   UPGRADE 2 — `DefaultGateway.createAgentModel({providerId, modelId})`.
 *     Resolves GSD's per-subagent `model_overrides` / `model_profile_overrides`
 *     (already used for OpenCode/Codex passive hosts) into the createAgentModel
 *     call params for cline's active model mode. The host gateway owns the
 *     actual model instantiation; this binding resolves WHICH model an
 *     overridden subagent should use.
 *     Cite: https://github.com/cline/cline/blob/main/docs/sdk/reference/gateway.mdx
 *           https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md
 *
 * This module is PURE (no I/O, no SDK import): the real `@cline/sdk` is a
 * fast-moving package set not linked at build/test time, so the binding exposes
 * the decision functions a host plugin/gateway would call. Tests drive payloads
 * through them directly (same mock-the-SDK pattern as the VS Code reference
 * binding, tests/fixtures/vscode-host-binding.cjs).
 */
'use strict';

// ---------------------------------------------------------------------------
// UPGRADE 1 — beforeTool planning-artifact guard
// ---------------------------------------------------------------------------

/**
 * Write-class tool-verb detector. Matches the SAME regex as the #787
 * PreToolUse file-convention hook so the guard behaves identically.
 * Case-insensitive (the SDK delivers tool names in varying case).
 */
export const WRITE_TOOL_PATTERN = /write|edit|replace|create|delete|remove|append|apply|patch|insert|mkdir/i;

/**
 * `.planning/` path detector. Matches `.planning` preceded by start-of-string
 * or a path separator (posix `/` or windows `\`) and followed by a separator or
 * end-of-string — so `.planning-readme.txt` is NOT falsely matched. Mirrors the
 * PreToolUse hook's `(^|[\\/])\.planning([\\/]|$)` exactly.
 */
export const PLANNING_PATH_PATTERN = /(^|[\\/])\.planning([\\/]|$)/;

/**
 * The user-visible reason returned when a `.planning/` write is blocked.
 * Preserves the PreToolUse hook's errorMessage text so the guard behaves
 * identically to the user (cancel→skip, errorMessage→reason).
 */
export const PLANNING_GUARD_REASON: string = Object.freeze(
  'GSD: .planning/ artifacts are managed by GSD workflows. Edit them only through a /gsd-* command, not directly.',
);

/**
 * Path-bearing field-name detector. Only PATH-keyed field values are inspected,
 * so a document that merely mentions ".planning/" in its body content is never
 * falsely blocked. Mirrors the PreToolUse hook's PATH_KEY regex exactly.
 */
const PATH_KEY_PATTERN = /^(path|file|file_?path|filepath|target_?path|target|dir|directory|uri|filename)$/i;

type BeforeToolPayload = {
  tool?: { name?: unknown } | string | null | undefined;
  input?: unknown;
};

type BeforeToolDecision = { decision: 'skip'; reason: string } | { decision: 'allow'; reason?: undefined };

/**
 * Collect PATH-bearing string field values from an object tree, mirroring the
 * PreToolUse hook's bounded walk. Pure; never throws.
 */
function collectPathValues(root: unknown): string[] {
  const paths: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || paths.length > 64) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const val = obj[k];
        if (typeof val === 'string' && PATH_KEY_PATTERN.test(k)) {
          paths.push(val);
        } else {
          walk(val, depth + 1);
        }
      }
    }
  };
  walk(root, 0);
  return paths;
}

/**
 * Resolve a tool name from a beforeTool payload's `tool` field, which may be a
 * string or an object with a `name` property. Returns '' when absent (treated
 * as non-write-class → allow, fail-open).
 */
function resolveToolName(tool: BeforeToolPayload['tool']): string {
  if (!tool) return '';
  if (typeof tool === 'string') return tool;
  const name = tool.name;
  return typeof name === 'string' ? name : '';
}

/**
 * The pure guard decision: given a beforeTool payload, decide skip (cancel) or
 * allow. Fail-OPEN — any malformed input, missing tool, or thrown error returns
 * 'allow' (the guard never blocks on a defect, mirroring the PreToolUse hook).
 *
 * @returns `{decision:'skip', reason}` for a write-class call targeting
 *          `.planning/`; `{decision:'allow'}` for everything else.
 */
export function evaluateBeforeTool(payload: BeforeToolPayload | null | undefined): BeforeToolDecision {
  try {
    if (!payload) return { decision: 'allow' };
    const toolName = resolveToolName(payload.tool);
    if (!toolName) return { decision: 'allow' };
    const isWrite = WRITE_TOOL_PATTERN.test(toolName);
    if (!isWrite) return { decision: 'allow' };
    const paths = collectPathValues(payload.input);
    const isPlanningPath = (s: string): boolean => PLANNING_PATH_PATTERN.test(s);
    if (paths.some(isPlanningPath)) {
      return { decision: 'skip', reason: PLANNING_GUARD_REASON };
    }
    return { decision: 'allow' };
  } catch {
    // Fail-open: a defect in the guard never blocks the user's operation.
    return { decision: 'allow' };
  }
}

/**
 * The Cline `AgentPlugin` shape (Context7 /cline/cline). A plugin implements
 * `setup({agentId})` returning `{hooks, tools}`. The `beforeTool` hook returns
 * `{skip:true, reason}` to block or `undefined` to allow.
 *
 * This object is the portable plugin a host loads from `~/.cline/plugins/`
 * (analogous to `.opencode/plugins/gsd-core.js`). Its `beforeTool` delegates to
 * the pure `evaluateBeforeTool` so the decision logic is testable without the
 * SDK linked.
 */
export const clineGsdPlugin: {
  name: string;
  setup: (ctx: { agentId?: string }) => {
    hooks: {
      beforeTool: (payload: BeforeToolPayload) => { skip: true; reason: string } | undefined;
    };
  };
} = Object.freeze({
  name: 'gsd-planning-guard',
  setup(_ctx: { agentId?: string }) {
    return {
      hooks: {
        beforeTool(payload: BeforeToolPayload): { skip: true; reason: string } | undefined {
          const decision = evaluateBeforeTool(payload);
          return decision.decision === 'skip' ? { skip: true, reason: decision.reason } : undefined;
        },
      },
    };
  },
});

// ---------------------------------------------------------------------------
// UPGRADE 2 — createAgentModel model-override resolution
// ---------------------------------------------------------------------------

/**
 * The fallback provider id when a model id does not match a known provider
 * family. Anthropic is cline's most common default; the host gateway retains
 * the final say over provider resolution.
 */
export const DEFAULT_CLINE_PROVIDER_ID: string = 'anthropic';

/**
 * Infer a `providerId` (the createAgentModel first arg) from a model id by
 * matching known provider families. Returns DEFAULT_CLINE_PROVIDER_ID for an
 * unrecognized or empty id (fail-safe — the gateway applies its own default).
 *
 * Pure string-prefix classification; does not validate the id is a real model.
 */
export function inferProviderId(modelId: string): string {
  if (typeof modelId !== 'string' || modelId.length === 0) return DEFAULT_CLINE_PROVIDER_ID;
  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude')) return 'anthropic';
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
  if (lower.startsWith('gemini')) return 'google';
  if (lower.startsWith('deepseek')) return 'deepseek';
  return DEFAULT_CLINE_PROVIDER_ID;
}

type ModelOverrideMap = Record<string, string> | null | undefined;
type ProfileOverrideMap = Record<string, Record<string, string>> | null | undefined;

type AgentModelParams = { providerId: string; modelId: string };

/**
 * Resolve the createAgentModel call params for a cline subagent from GSD's model
 * override config. Mirrors the precedence OpenCode/Codex use (passive hosts
 * embed the resolved model into agent frontmatter); for cline's active model
 * mode the same resolution flows to `gateway.createAgentModel(params)`.
 *
 * Precedence (matches GSD's model_overrides > model_profile_overrides contract):
 *   1. `modelOverrides[agentType]` — direct per-agent override
 *   2. `modelProfileOverrides[profile][agentType]` — profile-scoped override
 *   3. null — no override; the host gateway applies its own default
 *
 * Pure; never throws. Non-string / empty override values are ignored (fail-safe).
 *
 * @returns the `{providerId, modelId}` for createAgentModel, or null when no
 *          override is configured (the gateway default applies — GSD does NOT
 *          call createAgentModel in that case).
 */
export function resolveClineAgentModelParams(args: {
  agentType: string;
  modelOverrides?: ModelOverrideMap;
  modelProfileOverrides?: ProfileOverrideMap;
  profile?: string;
}): AgentModelParams | null {
  const { agentType, modelOverrides, modelProfileOverrides, profile } = args;
  if (!agentType || typeof agentType !== 'string') return null;

  // 1. Direct per-agent override wins.
  if (modelOverrides && typeof modelOverrides === 'object') {
    const direct = modelOverrides[agentType];
    if (typeof direct === 'string' && direct.length > 0) {
      return { providerId: inferProviderId(direct), modelId: direct };
    }
  }

  // 2. Profile-scoped override.
  if (modelProfileOverrides && typeof modelProfileOverrides === 'object' && profile) {
    const profileEntry = modelProfileOverrides[profile];
    if (profileEntry && typeof profileEntry === 'object') {
      const profileModel = profileEntry[agentType];
      if (typeof profileModel === 'string' && profileModel.length > 0) {
        return { providerId: inferProviderId(profileModel), modelId: profileModel };
      }
    }
  }

  // 3. No override — gateway default applies.
  return null;
}
