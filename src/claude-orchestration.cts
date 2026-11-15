/**
 * Claude Orchestration Capability — Workflow-tool backend detection + emitter
 *
 * #1143 — adopts Claude Code's Workflow tool (the engine behind `/effort ultracode`)
 * as an optional, runtime-gated parallel-execution backend for the GSD loop.
 *
 * This module is the pure, testable core of the capability. It owns three seams:
 *
 *   resolveWorkflowAvailability({ env, sources })
 *     → { disabled: boolean, reason: string }
 *     Reads Claude Code's documented workflow kill switches (the
 *     CLAUDE_CODE_DISABLE_WORKFLOWS env var and the `disableWorkflows` /
 *     `enableWorkflows` settings keys) from precedence-ordered settings sources
 *     the caller has already read. Fail-closed on unreadable or malformed input.
 *
 *   detectWorkflowBackend({ runtimeId, hostIntegration, config, workflowAvailability })
 *     → { available: boolean, backend: 'workflow'|'inline', reason: string }
 *     Fail-closed: every miss degrades to `inline` (today's behaviour), so the
 *     core loop is byte-identical unless every gate opens. This is criteria 3 + 6.
 *     `workflowAvailability` is the resolveWorkflowAvailability result (#4747).
 *
 *   emitWorkflowScript({ phaseDir, waves, runId, budgetTokens? })
 *     → { ok:true, script, summary } | { ok:false, reason }
 *     Maps GSD's wave/plan model 1:1 onto Workflow primitives:
 *       wave  → sequential `parallel()` stage barriers,
 *       plan  → `agent(brief, { agentType:'gsd-executor', isolation:'worktree' })`
 *         — UNLESS the plan's `use_worktree` is explicitly `false`, in which case
 *         `isolation` is omitted entirely for that plan (#2772 / #2285 finding 1:
 *         a submodule-touching plan must never be forced into worktree isolation
 *         the inline path (execute-phase.md step 2.5) would keep it out of),
 *       files_modified overlap → forces plans into separate sequential stages
 *         (the same overlap rule execute-phase already applies inline),
 *       resumeFromRunId → wired to the phase run id,
 *       budgetTokens → a shared token pool.
 *     Runtime caps (#4747): a single parallel() call accepts at most
 *     WORKFLOW_MAX_ITEMS_PER_CALL items and a run at most
 *     WORKFLOW_MAX_AGENTS_PER_RUN agents; a manifest over either cap is rejected
 *     at emit time (`ok:false`) instead of failing inside the Workflow tool.
 *     Hand-back (#3302 / #4747): worktree plans pass a JSON `schema`
 *     (WORKTREE_METADATA_SCHEMA) to agent(), so the result is a validated object;
 *     every agent() call is wrapped so a throw becomes `{ error }` for that plan
 *     only, and each outcome entry is { plan, expects_worktree, metadata, error }.
 *     The emitted script composes the SAME gsd-executor agent the inline path
 *     uses, with per-plan worktree isolation mirroring the inline path's own
 *     per-plan decision, so it produces the same artifacts/commits (criterion 2).
 *     It is a generated string consumed by the orchestrator; this module never
 *     invokes the Workflow tool itself.
 *
 * Design laws:
 *   - Gall's Law: ship a small working slice that composes existing primitives
 *     (gsd-executor + worktree isolation) rather than reinventing them.
 *   - Greenspun's Tenth Rule (cited in #1143): adopt the Workflow tool's
 *     barrier/pipeline/budget/resume semantics instead of hand-rolling them.
 *   - Postel's Law: liberal in input (missing fields → inline), conservative in
 *     output (workflow only when every gate opens).
 *   - Fail-closed: unknown availability, a missing descriptor, or a disabled
 *     toggle all resolve to `inline`, never to `workflow`.
 *
 * Zero external dependencies. Pure functions. Never throws on bad input.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- file-overlap-partitioner.cjs is an export= CommonJS module
import fileOverlapPartitionerMod = require('./file-overlap-partitioner.cjs');
const { partitionByFileOverlap } = fileOverlapPartitionerMod;

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Documented Workflow-tool runtime caps (code.claude.com/docs/en/workflows):
 * parallel()/pipeline() reject a list longer than 4,096 items, and one run may
 * start at most 1,000 agents (#4747).
 */
const WORKFLOW_MAX_ITEMS_PER_CALL = 4096;
const WORKFLOW_MAX_AGENTS_PER_RUN = 1000;

/** Every reason code detectWorkflowBackend can return (#4747; hyrums-law). */
const DETECT_REASONS: readonly string[] = Object.freeze([
  'workflow_backend_active', 'capability_disabled', 'runtime_not_claude', 'backend_inline',
  'workflow_tool_unavailable', 'workflows_disabled_by_env', 'workflows_disabled_by_managed_settings',
  'workflows_disabled_by_settings', 'workflow_settings_unreadable', 'workflow_availability_unknown',
]);

/** The subset of DETECT_REASONS a resolveWorkflowAvailability result may carry when disabled. */
const AVAILABILITY_DISABLE_REASONS = new Set<string>([
  'workflows_disabled_by_env', 'workflows_disabled_by_managed_settings', 'workflows_disabled_by_settings',
  'workflow_settings_unreadable', 'workflow_availability_unknown',
]);

/**
 * JSON schema a worktree plan's agent() must satisfy: the four fields the
 * orchestrator records via worktree.record-agent (#3302 / #4747). Deep-frozen so
 * the exported literal cannot drift from what the emitted script declares.
 */
const WORKTREE_METADATA_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    agent_id: Object.freeze({ type: 'string', minLength: 1 }),
    worktree_path: Object.freeze({ type: 'string', minLength: 1 }),
    branch: Object.freeze({ type: 'string', minLength: 1 }),
    expected_base: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze(['agent_id', 'worktree_path', 'branch', 'expected_base']),
});

/** Closed enum for the `claude_orchestration.execution_backend` config key. */
const BACKEND_VALUES = new Set<string>(['auto', 'workflow', 'inline']);

/** Only this runtime can host the Workflow tool (Claude Code / Agent SDK). */
const WORKFLOW_RUNTIME = 'claude';

// ─── resolveWorkflowAvailability ──────────────────────────────────────────────

interface AvailabilityResult {
  disabled: boolean;
  reason: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const SETTINGS_SCOPES = new Set<string>(['managed', 'projectLocal', 'project', 'user']);
const SETTINGS_STATUSES = new Set<string>(['absent', 'ok', 'unreadable']);

/**
 * Resolve whether a Claude Code workflow kill switch is set (#4747).
 *
 * Sources: code.claude.com/docs/en/workflows (kill switches
 * `CLAUDE_CODE_DISABLE_WORKFLOWS` and `disableWorkflows`/`enableWorkflows`) and
 * code.claude.com/docs/en/settings (precedence managed > --settings >
 * project-local > project > user; the highest level that sets a key wins).
 * `--settings` is not observable and is not read.
 *
 * `input.sources` MUST be precedence-ordered, highest first (caller's
 * responsibility): managed, projectLocal, project, user. Each entry is
 * `{ scope, status: 'absent'|'ok'|'unreadable', settings? }`.
 *
 * Fail-closed: a malformed input, an unreadable source, or a non-boolean kill
 * switch value disables. A truthy env value other than `0`/`false`/empty disables.
 *
 * Never throws.
 */
function resolveWorkflowAvailability(input: unknown): AvailabilityResult {
  if (!isPlainObject(input)) {
    return { disabled: true, reason: 'workflow_availability_unknown' };
  }
  const env = isPlainObject(input['env']) ? input['env'] : {};
  const raw = env['CLAUDE_CODE_DISABLE_WORKFLOWS'];
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v !== '' && v !== '0' && v !== 'false') {
      return { disabled: true, reason: 'workflows_disabled_by_env' };
    }
  }

  const sources = input['sources'];
  if (!Array.isArray(sources)) {
    return { disabled: true, reason: 'workflow_availability_unknown' };
  }
  for (const s of sources) {
    if (!isPlainObject(s)
      || typeof s['scope'] !== 'string' || !SETTINGS_SCOPES.has(s['scope'])
      || typeof s['status'] !== 'string' || !SETTINGS_STATUSES.has(s['status'])) {
      return { disabled: true, reason: 'workflow_availability_unknown' };
    }
  }

  type OkSource = { scope: string; settings: Record<string, unknown> };
  const okSources: OkSource[] = [];
  for (const s of sources as Array<Record<string, unknown>>) {
    if (s['status'] === 'unreadable') {
      return { disabled: true, reason: 'workflow_settings_unreadable' };
    }
    if (s['status'] === 'ok') {
      if (!isPlainObject(s['settings'])) {
        return { disabled: true, reason: 'workflow_settings_unreadable' };
      }
      okSources.push({ scope: s['scope'] as string, settings: s['settings'] });
    }
  }

  const KEYS = ['disableWorkflows', 'enableWorkflows'] as const;
  for (const src of okSources) {
    for (const key of KEYS) {
      if (Object.prototype.hasOwnProperty.call(src.settings, key) && typeof src.settings[key] !== 'boolean') {
        return { disabled: true, reason: 'workflow_settings_unreadable' };
      }
    }
  }

  const winner = (key: string): { scope: string; value: boolean } | null => {
    for (const src of okSources) {
      if (Object.prototype.hasOwnProperty.call(src.settings, key)) {
        return { scope: src.scope, value: src.settings[key] as boolean };
      }
    }
    return null;
  };
  const reasonFor = (scope: string): string =>
    scope === 'managed' ? 'workflows_disabled_by_managed_settings' : 'workflows_disabled_by_settings';

  const dis = winner('disableWorkflows');
  if (dis !== null && dis.value === true) {
    return { disabled: true, reason: reasonFor(dis.scope) };
  }
  const en = winner('enableWorkflows');
  if (en !== null && en.value === false) {
    return { disabled: true, reason: reasonFor(en.scope) };
  }
  return { disabled: false, reason: 'workflows_available' };
}

// ─── detectWorkflowBackend ────────────────────────────────────────────────────

interface HostIntegration {
  dispatch?: {
    nested?: boolean;
    background?: boolean;
    backgroundDispatch?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface BackendConfig {
  'claude_orchestration.enabled'?: unknown;
  'claude_orchestration.execution_backend'?: unknown;
  [k: string]: unknown;
}

interface DetectInput {
  runtimeId?: string;
  hostIntegration?: HostIntegration | null;
  config?: BackendConfig | null;
  /** The resolveWorkflowAvailability result (#4747). Missing/malformed → fail-closed. */
  workflowAvailability?: unknown;
}

interface DetectResult {
  available: boolean;
  backend: 'workflow' | 'inline';
  reason: string;
}

/** Inline result shorthand. */
function inline(reason: string, available = false): DetectResult {
  return { available, backend: 'inline', reason };
}

/**
 * Resolve whether the Workflow-tool backend should activate.
 *
 * Gate ladder (all must pass for `workflow`; first miss wins, fail-closed):
 *   1. capability enabled (claude_orchestration.enabled truthy)
 *   2. runtime is Claude (the only runtime that exposes the Workflow tool)
 *   3. execution_backend !== 'inline'
 *   4. host descriptor signals nested+background dispatch (Workflow-tool capable)
 *   5. workflowAvailability is a well-formed resolveWorkflowAvailability result
 *      (else `workflow_availability_unknown`)
 *   6. workflowAvailability.disabled is false (else inline with its own reason:
 *      env / managed settings / settings kill switch, or unreadable settings)
 *   7. execution_backend === 'workflow' OR 'auto' (both reach here; 'inline' exited at 3)
 *
 * The `claude_orchestration.min_agent_sdk_version` config key is deprecated and
 * ignored (#4747): the Agent SDK version does not reflect whether a Claude Code
 * session has dynamic workflows.
 *
 * Never throws. Destructures defensively.
 */
function detectWorkflowBackend(input: DetectInput | null | undefined): DetectResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return inline('capability_disabled');
  }

  const cfg: BackendConfig =
    (input.config !== null && input.config !== undefined && typeof input.config === 'object')
      ? input.config
      : {};

  // 1. capability must be opted in (default-off — ships disabled).
  if (!cfg['claude_orchestration.enabled']) {
    return inline('capability_disabled');
  }

  // 2. only Claude can host the Workflow tool.
  if (input.runtimeId !== WORKFLOW_RUNTIME) {
    return inline('runtime_not_claude');
  }

  // 3. explicit inline opt-out short-circuits.
  let backendRaw = cfg['claude_orchestration.execution_backend'];
  if (typeof backendRaw !== 'string' || !BACKEND_VALUES.has(backendRaw)) {
    backendRaw = 'auto';
  }
  if (backendRaw === 'inline') {
    return inline('backend_inline');
  }

  // 4. the host dispatch descriptor must be the nesting-capable Claude-Code shape
  //    (a proxy for Workflow-tool presence). This is Claude-specific and already
  //    gated at step 2; `background:true` alone is true on several non-Claude hosts,
  //    so the proxy is only meaningful after the runtime check above. Note: this is
  //    NOT the canonical `shouldFlattenDispatch` rule (which keys on
  //    `backgroundDispatch`); the Workflow backend works precisely because a single
  //    tool-call orchestrates internally, sidestepping the backgroundDispatch:false
  //    limitation. Missing/false/foreign descriptor → fail-closed.
  const hi = input.hostIntegration;
  if (hi === null || hi === undefined || typeof hi !== 'object' || Array.isArray(hi)) {
    return inline('workflow_tool_unavailable');
  }
  const dispatch = (hi as { dispatch?: Record<string, unknown> }).dispatch;
  if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) {
    return inline('workflow_tool_unavailable');
  }
  const nested = dispatch['nested'];
  const background = dispatch['background'];
  if (nested !== true || background !== true) {
    return inline('workflow_tool_unavailable');
  }

  // 5-6. Claude Code's documented workflow kill switches (#4747).
  const av = input.workflowAvailability;
  if (av === null || typeof av !== 'object' || Array.isArray(av) || typeof (av as { disabled?: unknown }).disabled !== 'boolean') {
    return inline('workflow_availability_unknown');
  }
  if ((av as { disabled: boolean }).disabled) {
    const r = (av as { reason?: unknown }).reason;
    return inline(typeof r === 'string' && AVAILABILITY_DISABLE_REASONS.has(r) ? r : 'workflow_availability_unknown');
  }

  // 7. auto/workflow both reach the workflow backend once every gate passes.
  return { available: true, backend: 'workflow', reason: 'workflow_backend_active' };
}

// ─── emitWorkflowScript ───────────────────────────────────────────────────────

interface Plan {
  id: string;
  brief: string;
  files_modified: string[];
  /**
   * #2772 / #2285 finding 1 — mirrors execute-phase.md step 2.5's
   * `USE_WORKTREES_FOR_PLAN` (per-plan submodule-intersection + project-level
   * `workflow.use_worktrees` gate). The inline dispatch path in step 3 omits
   * `isolation="worktree"` for a plan that touches a submodule path (the
   * executor commit protocol cannot correctly handle submodule commits inside
   * an isolated worktree). The Workflow backend MUST honor the SAME per-plan
   * decision — it must never force worktree isolation on a plan the inline
   * path would keep out of worktrees.
   *
   * Optional, defaults to `true` (preserves prior behavior for callers that
   * don't populate it — e.g. a manifest with no submodule paths at all).
   * Only an explicit `false` omits `isolation: "worktree"` for that plan.
   */
  use_worktree?: boolean;
}

interface Wave {
  id: string;
  plans: Plan[];
}

interface EmitInput {
  phaseDir: string;
  waves: Wave[];
  runId: string;
  budgetTokens?: number;
  /**
   * #2686 — the resolved `gsd-executor` model, threaded so this backend honors
   * model_overrides / model_policy / model_profile exactly as the inline path
   * does. Omitted from the emitted options when it is `"inherit"`, empty, or not
   * a string (#2517: an empty model 404s on runtimes without native tier
   * aliases). When absent the emitted script is byte-identical to pre-#2686.
   */
  executorModel?: string;
}

interface EmitOk {
  ok: true;
  script: string;
  summary: {
    waves: number;
    plans: number;
    /**
     * #3302 — the number of record-agent entries the orchestrator must end up
     * with in WAVE_WORKTREE_MANIFEST after the run (plans with `use_worktree`
     * not `false`). The loud count check: fewer entries than this after the
     * Workflow run means metadata capture failed and the wave must HALT.
     */
    worktreePlans: number;
    stagesByWave: string[][][]; // wave → stage → planId[]
    resumeRunId: string;
    budgetTokens: number | null;
  };
}

interface EmitErr {
  ok: false;
  reason: string;
}

/**
 * Partition a wave's plans into a near-minimal number of sequential stages (via
 * greedy first-fit — not guaranteed optimal for arbitrary overlap graphs, but
 * correct: no two plans sharing a file ever cohabit a stage) such that no two
 * plans in the same stage share a modified file. Each plan goes into the earliest
 * stage where it does not overlap any plan already there.
 *
 * A plan with an EMPTY files_modified set declares no files; it overlaps nothing
 * and coalesces into stage 0 (same behavior as the inline path, which also cannot
 * guard against undeclared concurrent writes — declare filesModified accurately).
 *
 * This is the same overlap rule execute-phase applies inline — the only difference
 * is the execution vehicle (Workflow `parallel()` vs one-agent-per-message).
 *
 * #3674: the algorithm itself now lives in the generic, dependency-free
 * `file-overlap-partitioner.cts` module (`partitionByFileOverlap`) — this is a
 * thin adapter mapping this module's own `Plan[]` shape onto that module's
 * generic `{ id, files }[]` input and back. Behavior-preserving extraction:
 * same greedy first-fit algorithm, same output, only the implementation moved.
 */
function partitionStages(plans: Plan[]): string[][] {
  return partitionByFileOverlap(plans.map((p) => ({ id: p.id, files: p.files_modified })));
}

/**
 * Quote a free-text value for safe embedding as a JavaScript/Workflow double-quoted
 * string literal. Uses JSON.stringify so every JS-relevant escape (backslash, quote,
 * newline, tab, NUL, U+2028/U+2029, all control chars) is handled by the language
 * itself — there is no hand-rolled escape table to drift. Returns the value already
 * wrapped in its surrounding quotes.
 */
function quoteString(s: string): string {
  return JSON.stringify(s);
}

/**
 * #2686 — the single decision of whether a resolved executor model is emittable,
 * and what to emit. Shared by `agentOptions` (the emission) and the provenance
 * comment (the claim about it) so the two can never disagree — a generated
 * comment asserting something the generator does not actually do is the exact
 * failure #2686 was filed for.
 *
 * Returns the model to emit, or `undefined` for "emit nothing":
 *   - non-string        → malformed config; omit rather than throw, matching the
 *                         defensive typeof guard `mapClaudeOverrideForRuntime`
 *                         already carries in model-resolver for the same reason.
 *   - empty/whitespace  → #2517: emitting `model: ""` 404s on runtimes without
 *                         native tier aliases. Trimmed, so `" "` is also "none".
 *   - "inherit"         → same rule; matched case-insensitively after trimming,
 *                         since config is user-authored free text.
 *
 * NOTE it does NOT reject unscriptable characters — that is a hard input error,
 * not a silent omission, and is rejected up front by `emitWorkflowScript` so the
 * caller sees a reason instead of quietly losing their model routing.
 */
function emittableModel(executorModel: unknown): string | undefined {
  if (typeof executorModel !== 'string') return undefined;
  const trimmed = executorModel.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.toLowerCase() === 'inherit') return undefined;
  return trimmed;
}

/**
 * Render the `agent()` options object for a single plan — `isolation: "worktree"`
 * ONLY when the plan's `use_worktree` is not explicitly `false` (#2772 / #2285
 * finding 1). This is the single place that decides worktree isolation for the
 * Workflow backend; it must never diverge from the inline path's per-plan gate.
 */
function agentOptions(p: Plan, executorModel?: unknown): string {
  const parts = ['agentType: "gsd-executor"'];
  if (p.use_worktree !== false) parts.push('isolation: "worktree"');
  // #2686: carry the resolved executor model so this backend honors
  // model_overrides / model_policy / model_profile exactly as the inline path.
  const model = emittableModel(executorModel);
  if (model !== undefined) parts.push('model: ' + quoteString(model));
  // #4747: worktree plans must return the validated metadata object.
  if (p.use_worktree !== false) parts.push('schema: GSD_WORKTREE_METADATA_SCHEMA');
  return '{ ' + parts.join(', ') + ' }';
}

/**
 * True if `s` is a safe identifier/path token to interpolate into the generated
 * script WITHOUT requiring a string-literal context — i.e. it contains no
 * character that could terminate a comment line (`\n`/`\r`), break out of a
 * string literal (`"` / `\`), or smuggle a NUL/control sequence. Used for
 * `phaseDir`, `runId`, `wave.id`, and `plan.id`, which are identifiers/paths and
 * must never legitimately contain such characters. Rejecting them at validation
 * (rather than silently flattening) keeps the emitted script faithful to input.
 */
const UNSCRIPTABLE_CHAR_RE = /[\r\n"\\\x00-\x1f\x7f\u2028\u2029]/;
function isScriptableIdentifier(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  return !UNSCRIPTABLE_CHAR_RE.test(s);
}

/**
 * Emit a Workflow script mapping the phase's wave/plan model onto Workflow
 * primitives. Pure and deterministic: identical input yields an identical string.
 *
 * Returns ok:false (never throws) on invalid input — empty waves, missing runId,
 * a wave with no plans, etc.
 */
function emitWorkflowScript(input: EmitInput | null | undefined): EmitOk | EmitErr {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }
  const { phaseDir, waves, runId, executorModel } = input;
  // Identifiers/paths interpolated into the generated script must be free of any
  // character that could terminate a comment, break out of a string literal, or
  // smuggle control bytes — reject up front (security: #1143 review Finding 1).
  if (!isScriptableIdentifier(phaseDir)) {
    return { ok: false, reason: 'phaseDir must be a non-empty string without newlines/quotes/backslash/control chars' };
  }
  if (!isScriptableIdentifier(runId)) {
    return { ok: false, reason: 'runId must be a non-empty string without newlines/quotes/backslash/control chars' };
  }
  // #2686 security: the resolved model is interpolated into BOTH an object
  // literal (safe under quoteString) and a `//` provenance comment (NOT safe
  // under quoteString — U+2028/U+2029 are LineTerminators that end a single-line
  // comment in every engine, so a hostile model id would make the rest of the
  // line live code). Reject the whole emission rather than silently dropping the
  // model: an unscriptable id is malformed input, and `resolveWaveDispatch` maps
  // an emit failure to the inline backend WITH a reason, so the user sees it.
  // Only a STRING carrying such a character is rejected. A non-string is a
  // malformed config rather than an injection attempt, and stays on the existing
  // defensive path: `emittableModel` omits it and emission proceeds.
  if (typeof executorModel === 'string' && UNSCRIPTABLE_CHAR_RE.test(executorModel)) {
    return { ok: false, reason: 'executorModel must not contain newlines/quotes/backslash/control/line-separator chars' };
  }
  if (!Array.isArray(waves) || waves.length === 0) {
    return { ok: false, reason: 'waves must be a non-empty array' };
  }
  // Wave ids must be unique ACROSS waves, not just plan ids within one (#2590).
  // Each wave emits a `phase("Wave <id>")` call plus a matching meta.phases
  // entry, and the Workflow tool matches phase titles by exact string — two
  // waves sharing an id would collapse into one progress group and misattribute
  // every agent in the second wave to the first.
  const seenWaveIds = new Set<string>();
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    if (w === null || typeof w !== 'object' || typeof w.id !== 'string') {
      return { ok: false, reason: 'waves[' + i + '] must be { id, plans: non-empty[] }' };
    }
    if (!isScriptableIdentifier(w.id)) {
      return { ok: false, reason: 'waves[' + i + '].id must not contain newlines/quotes/backslash/control chars' };
    }
    if (seenWaveIds.has(w.id)) {
      return { ok: false, reason: 'duplicate wave id "' + w.id + '" — wave ids must be unique (phase titles must map 1:1)' };
    }
    seenWaveIds.add(w.id);
    if (!Array.isArray(w.plans) || w.plans.length === 0) {
      return { ok: false, reason: 'waves[' + i + '] must have a non-empty plans array' };
    }
    const seenIds = new Set<string>();
    for (let j = 0; j < w.plans.length; j++) {
      const p = w.plans[j];
      if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.brief !== 'string' || !Array.isArray(p.files_modified)) {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '] must be { id, brief, files_modified[] }' };
      }
      if (!isScriptableIdentifier(p.id)) {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].id must not contain newlines/quotes/backslash/control chars' };
      }
      if (p.use_worktree !== undefined && typeof p.use_worktree !== 'boolean') {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].use_worktree must be a boolean if present' };
      }
      if (seenIds.has(p.id)) {
        return { ok: false, reason: 'waves[' + i + '] has duplicate plan id "' + p.id + '"' };
      }
      seenIds.add(p.id);
      for (const f of p.files_modified) {
        if (typeof f !== 'string' || f.length === 0) {
          return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].files_modified entries must be non-empty strings' };
        }
      }
    }
  }

  const budgetTokens = (typeof input.budgetTokens === 'number' && Number.isFinite(input.budgetTokens) && input.budgetTokens > 0)
    ? Math.floor(input.budgetTokens)
    : null;

  // #4747: partition once; enforce the documented Workflow runtime caps at emit
  // time (per-call first, then per-run) instead of failing inside the tool.
  const stagesByWave: string[][][] = waves.map((w) => partitionStages(w.plans));
  for (let wi = 0; wi < waves.length; wi++) {
    const stages = stagesByWave[wi];
    for (let si = 0; si < stages.length; si++) {
      if (stages[si].length > WORKFLOW_MAX_ITEMS_PER_CALL) {
        return {
          ok: false,
          reason: 'wave "' + waves[wi].id + '" stage ' + si + ' has ' + stages[si].length
            + ' plans — exceeds the Workflow runtime cap of ' + WORKFLOW_MAX_ITEMS_PER_CALL + ' items per parallel() call',
        };
      }
    }
  }
  let totalPlans = 0;
  for (const w of waves) totalPlans += w.plans.length;
  if (totalPlans > WORKFLOW_MAX_AGENTS_PER_RUN) {
    return {
      ok: false,
      reason: 'manifest has ' + totalPlans + ' plans — exceeds the Workflow runtime cap of '
        + WORKFLOW_MAX_AGENTS_PER_RUN + ' agents per run',
    };
  }

  const lines: string[] = [];
  // `export const meta = {…}` MUST be the first statement in the script — the
  // Workflow tool rejects the whole script otherwise (#2590). Leading comments
  // are not statements, but the meta block is emitted first regardless so the
  // contract holds under the strictest reading of "first statement".
  //
  // meta.phases must be a PURE LITERAL (no variables, calls, spreads, or
  // template interpolation), and its titles are matched EXACTLY against the
  // phase() calls emitted below.
  lines.push('export const meta = {');
  lines.push('  name: ' + quoteString('gsd-execute-' + runId) + ',');
  lines.push('  description: ' + quoteString('GSD wave dispatch for ' + phaseDir) + ',');
  lines.push('  phases: [');
  for (const w of waves) {
    lines.push('    { title: ' + quoteString('Wave ' + w.id) + ', detail: '
      + quoteString(w.plans.length + ' plan(s)') + ' },');
  }
  lines.push('  ],');
  lines.push('}');
  lines.push('');
  lines.push('// GSD Workflow script — generated by the claude-orchestration capability (#1143)');
  lines.push('// phase: ' + phaseDir);
  lines.push('// BETA: preview-grade; on any failure the orchestrator falls back to inline dispatch.');
  lines.push('// Composes the SAME gsd-executor agent as the inline path, so artifacts (SUMMARY.md)');
  lines.push('// and commits are produced identically. Worktree isolation is per-plan (use_worktree)');
  lines.push('// and mirrors execute-phase.md step 2.5\'s submodule gate exactly (#2772 / #2285).');
  // #2686 / ADR-1411: state which model was applied — or that none resolved —
  // so an opted-in user can SEE the routing decision instead of having to read
  // the emitted options. A fallback must be a visible value, never silent.
  //
  // SECURITY: this is a `//` comment, and U+2028/U+2029 are ECMAScript
  // LineTerminators that END a single-line comment in every engine — the ES2019
  // change legalized them inside string LITERALS only, so `quoteString` alone is
  // NOT sufficient here even though it is sufficient in the object literal
  // above. An unscriptable model id would otherwise close the comment and make
  // the remainder live top-level code. `emitWorkflowScript` rejects such ids
  // before reaching this point (see the validation above), which is what makes
  // interpolating here safe.
  const provenanceModel = emittableModel(executorModel);
  if (provenanceModel !== undefined) {
    lines.push('// model: ' + quoteString(provenanceModel) + ' (resolved for gsd-executor, same source as the inline path)');
  } else {
    lines.push('// model: none applied — resolved to "inherit"/empty, so each agent inherits the');
    lines.push('// orchestrator model (#2517: emitting an empty model 404s on some runtimes).');
  }
  lines.push('//');
  // resumeFromRunId is a Workflow TOOL INPUT parameter, not a script function —
  // calling it threw "resumeFromRunId is not defined" (#2590). The run id is
  // carried in summary.resumeRunId for the caller to pass as that input.
  lines.push('// resume: pass ' + quoteString(runId) + ' as the Workflow tool\'s resumeFromRunId input');
  lines.push('// (it is a tool parameter, NOT a script function).');
  if (budgetTokens !== null) {
    // `budget` is a read-only object ({ total, spent(), remaining() }) supplied
    // by the caller's token directive — a script cannot SET it, and `budget(n)`
    // threw "budget is not a function" (#2590). Recorded as intent only.
    lines.push('// budget: ' + budgetTokens + ' output tokens intended for this run; `budget` is');
    lines.push('// read-only in a Workflow script — set it via the caller\'s token directive.');
  }
  lines.push('');

  // #3302 / #4747: the generated script hands the per-agent executor results
  // back to the orchestrator so it can feed the wave merge chain. Worktree plans
  // pass GSD_WORKTREE_METADATA_SCHEMA to agent(), so the result is a validated
  // object; gsdWorktreeMetadata re-checks the four fields and returns null on
  // any miss (the LOUD-failure input the orchestrator halts on for
  // expects_worktree plans — never a silent skip). gsdRunAgent catches a throw
  // (schema retries exhausted, budget hit) so one plan's failure becomes
  // { error } for that plan only and its siblings still complete.
  lines.push('// #3302 / #4747: worktree plans return schema-validated metadata (an object);');
  lines.push('// the orchestrator records it into WAVE_WORKTREE_MANIFEST after the run');
  lines.push('// (worktree.record-agent -> worktree.cleanup-wave, the same manifest-scoped');
  lines.push('// merge chain inline dispatch feeds). null = absent/invalid/interrupted.');
  lines.push('const GSD_WORKTREE_METADATA_SCHEMA = ' + JSON.stringify(WORKTREE_METADATA_SCHEMA));
  lines.push('function gsdWorktreeMetadata(agentResult) {');
  lines.push('  if (agentResult === null || typeof agentResult !== \'object\' || Array.isArray(agentResult)) return null;');
  lines.push('  const out = {};');
  lines.push('  for (const k of GSD_WORKTREE_METADATA_SCHEMA.required) {');
  lines.push('    const v = agentResult[k];');
  lines.push('    if (typeof v !== \'string\' || v.length === 0) return null;');
  lines.push('    out[k] = v;');
  lines.push('  }');
  lines.push('  return out;');
  lines.push('}');
  lines.push('function gsdAgentError(agentResult) {');
  lines.push('  return (agentResult !== null && typeof agentResult === \'object\' && typeof agentResult.gsdAgentError === \'string\') ? agentResult.gsdAgentError : null;');
  lines.push('}');
  lines.push('async function gsdRunAgent(brief, opts) {');
  lines.push('  try {');
  lines.push('    return await agent(brief, opts);');
  lines.push('  } catch (e) {');
  lines.push('    return { gsdAgentError: (e !== null && typeof e === \'object\' && typeof e.message === \'string\') ? e.message : String(e) };');
  lines.push('  }');
  lines.push('}');
  lines.push('const gsdAgentOutcomes = [];');
  lines.push('');

  let worktreePlans = 0;

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    const stages = stagesByWave[wi];
    for (const p of wave.plans) {
      if (p.use_worktree !== false) worktreePlans += 1;
    }

    lines.push('// Wave ' + wave.id);
    // Title must match this wave's meta.phases entry EXACTLY.
    lines.push('phase(' + quoteString('Wave ' + wave.id) + ')');
    for (let si = 0; si < stages.length; si++) {
      const stagePlanIds = stages[si];
      // Resolve back to plan objects for briefs (ids are unique within a wave — validated above).
      const stagePlans = stagePlanIds.map((id) => wave.plans.find((p) => p.id === id) as Plan);
      if (stages.length > 1) {
        lines.push('// Stage ' + si + (si > 0 ? ' (sequential — files_modified overlap)' : ''));
      }
      // parallel() takes an ARRAY OF THUNKS — `parallel(agent(…), agent(…))`
      // threw "parallel() expects an array of functions" (#2590). Passing
      // agent() results directly would also start every agent eagerly, before
      // parallel() could bound concurrency.
      // #3302: capture the barrier's resolved results (one per thunk, in thunk
      // order — the documented parallel() contract) so each plan's outcome can
      // be tagged and returned below. Discarding them stranded every
      // worktree-wf_* branch: the merge chain had no input (#3302).
      lines.push('const gsdStage_' + wi + '_' + si + ' = await parallel([');
      for (const p of stagePlans) {
        lines.push('  () => gsdRunAgent(' + quoteString(p.brief) + ', ' + agentOptions(p, executorModel) + '),');
      }
      lines.push('])');
      // Positional tagging is decided at EMIT time from the validated manifest,
      // so attribution survives out-of-order completion and needs no runtime
      // introspection. expects_worktree mirrors agentOptions' own per-plan
      // decision (use_worktree !== false).
      lines.push('gsdAgentOutcomes.push(');
      for (let pi = 0; pi < stagePlans.length; pi++) {
        const p = stagePlans[pi];
        const tail = pi < stagePlans.length - 1 ? ',' : '';
        const ref = 'gsdStage_' + wi + '_' + si + '[' + pi + ']';
        if (p.use_worktree !== false) {
          lines.push('  { plan: ' + quoteString(p.id) + ', expects_worktree: true, metadata: gsdWorktreeMetadata(' + ref + '), error: gsdAgentError(' + ref + ') }' + tail);
        } else {
          lines.push('  { plan: ' + quoteString(p.id) + ', expects_worktree: false, metadata: null, error: gsdAgentError(' + ref + ') }' + tail);
        }
      }
      lines.push(')');
    }
    if (wi < waves.length - 1) lines.push('');
  }

  // #3302: the script's top-level return value is what the Workflow tool hands
  // back to the orchestrator. One { plan, expects_worktree, metadata, error }
  // entry per dispatched plan; the orchestrator records every worktree entry via
  // `gsd_run query worktree.record-agent` and HALTS on a null metadata entry
  // for an expects_worktree plan (see
  // capabilities/claude-orchestration/docs/workflow-backend-dispatch.md) — a
  // silently-empty manifest is the exact #3302 failure mode.
  lines.push('return gsdAgentOutcomes');

  const script = lines.join('\n');

  return {
    ok: true,
    script,
    summary: {
      waves: waves.length,
      plans: totalPlans,
      // #3302: the number of record-agent entries the orchestrator must end up
      // with in WAVE_WORKTREE_MANIFEST after the run — the loud count check.
      worktreePlans,
      stagesByWave,
      resumeRunId: runId,
      budgetTokens,
    },
  };
}

// ─── resolveWaveDispatch ──────────────────────────────────────────────────────

interface ResolveWaveDispatchInput {
  runtimeId?: string;
  hostIntegration?: HostIntegration | null;
  config?: BackendConfig | null;
  workflowAvailability?: unknown;
  phaseDir: string;
  waves: Wave[];
  runId: string;
  budgetTokens?: number;
  /** #2686 — forwarded verbatim to `emitWorkflowScript`. */
  executorModel?: string;
}

interface ResolveWaveDispatchInline {
  backend: 'inline';
  reason: string;
}

interface ResolveWaveDispatchWorkflow {
  backend: 'workflow';
  reason: string;
  script: string;
  summary: EmitOk['summary'];
}

type ResolveWaveDispatchResult = ResolveWaveDispatchInline | ResolveWaveDispatchWorkflow;

/**
 * #2285 — single composed decision seam for a PRE-wave dispatch-backend selector
 * (e.g. the `execute:wave:pre` claude-orchestration contribution). Composes
 * `detectWorkflowBackend` (gate ladder) with `emitWorkflowScript` (wave→plan
 * mapping) into ONE call so the orchestrator (and its CLI wrapper,
 * `claude-orchestration resolve-wave-dispatch`) never has to re-implement the
 * two-step "detect, then maybe emit" sequencing.
 *
 * Fail-closed at every layer, matching the two composed functions:
 *   - `detectWorkflowBackend` resolving anything other than `'workflow'` →
 *     `inline` immediately; `emitWorkflowScript` is never invoked (no wasted
 *     work, no risk of a bad emit masking a correct inline fallback).
 *   - `detectWorkflowBackend` resolves `'workflow'` but `emitWorkflowScript`
 *     fails (`ok:false` — e.g. a malformed wave manifest) → `inline`, carrying
 *     the emit failure reason so the caller can surface it. Never a partial or
 *     broken script.
 *
 * This is the designated non-CLI-router, non-test caller of
 * `detectWorkflowBackend` and `emitWorkflowScript` — the standalone CLI
 * subcommands (`detect-backend`, `emit-workflow`) remain for inspection/
 * debugging, but the orchestrator's real per-wave dispatch decision goes
 * through this seam.
 *
 * Never throws on bad input.
 */
function resolveWaveDispatch(input: ResolveWaveDispatchInput | null | undefined): ResolveWaveDispatchResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { backend: 'inline', reason: 'invalid_input' };
  }

  const detected = detectWorkflowBackend({
    runtimeId: input.runtimeId,
    hostIntegration: input.hostIntegration,
    config: input.config,
    workflowAvailability: input.workflowAvailability,
  });

  if (detected.backend !== 'workflow') {
    return { backend: 'inline', reason: detected.reason };
  }

  const emitted = emitWorkflowScript({
    phaseDir: input.phaseDir,
    waves: input.waves,
    runId: input.runId,
    budgetTokens: input.budgetTokens,
    executorModel: input.executorModel,
  });

  if (!emitted.ok) {
    return { backend: 'inline', reason: 'emit_failed: ' + emitted.reason };
  }

  return {
    backend: 'workflow',
    reason: detected.reason,
    script: emitted.script,
    summary: emitted.summary,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export = {
  detectWorkflowBackend,
  emitWorkflowScript,
  resolveWaveDispatch,
  resolveWorkflowAvailability,
  BACKEND_VALUES,
  WORKFLOW_RUNTIME,
  DETECT_REASONS,
  WORKFLOW_MAX_ITEMS_PER_CALL,
  WORKFLOW_MAX_AGENTS_PER_RUN,
  WORKTREE_METADATA_SCHEMA,
};
