/**
 * Resolution Convention — canonical shape for config-interpreting read verbs.
 *
 * Extracted as the anchor for ADR-1411 P3 (Resolution Provenance, #1416).
 * Exports the `Resolution<T>` envelope used when a verb reads and interprets
 * configuration (e.g. agent-skills). Not used by mutation verbs (see
 * capability-writer's `SetCapabilityStateResult` for the mutation shape) or
 * plain read verbs (see capability-state's `ResolveCapabilityRuntimeStateResult`).
 *
 * This is a pure types+builder leaf — no other src/ imports.
 */

// ─── Resolution envelope ──────────────────────────────────────────────────────

/**
 * Canonical output envelope for **config-interpreting read verbs**.
 *
 * - `value`      — the resolved domain value (T)
 * - `configured` — true when the caller's agent/key was found in config
 * - `reason`     — machine-readable resolution outcome (e.g. 'resolved',
 *                  'not_configured', 'configured_empty', 'configured_unresolved')
 * - `warnings`   — diagnostic messages (empty on nominal path)
 *
 * The shared contract across all diagnostic shapes is `warnings: string[]`.
 * `configured`/`reason` appear only on config-interpreting read verbs;
 * mutation verbs add `errors[]` (operation-not-applied) instead.
 */
export interface Resolution<T> {
  value: T;
  configured: boolean;
  reason: string;
  warnings: string[];
}

// ─── agent-skills value type ──────────────────────────────────────────────────

/**
 * The domain value for the agent-skills config-interpreting read verb.
 * Used as the `T` in `Resolution<AgentSkillsValue>`.
 *
 * - `block`        — the formatted XML skills block (empty string when no skills)
 * - `skills_count` — number of resolved skill paths (0 when not configured or empty)
 */
export interface AgentSkillsValue {
  block: string;
  skills_count: number;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Construct a `Resolution<T>` envelope from a value and its provenance fields.
 */
export function makeResolution<T>(
  value: T,
  opts: { configured: boolean; reason: string; warnings: string[] },
): Resolution<T> {
  return {
    value,
    configured: opts.configured,
    reason: opts.reason,
    warnings: opts.warnings,
  };
}
