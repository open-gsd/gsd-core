/**
 * CLI surface registry (ADR-4909 D1, #6087, P1a of #6051).
 *
 * One declaration of every flag a `gsd-tools` verb accepts. Routers read their
 * spec through `specFor(verb)`; `scripts/gen-cli-surface-manifest.cjs` emits
 * `docs/CLI-SURFACE-MANIFEST.json` from this module (ADR-4909 D2).
 *
 * Hyrum's Law: each spec states the flags the router reads TODAY (the declared
 * surface equals the observed surface) and `requiredFlags` only where the
 * handler already fails without the flag. Conditional requirements (one-of,
 * required-when-another-is-present) stay in the handler.
 *
 * Keys are the canonical verb: the `command-aliases` canonical where one
 * exists, else the `HOST_COMMAND_ROUTERS` key, else `<host>.<sub>` for a router
 * that switches on a subcommand. `positionals` counts the leading argv slots
 * the router owns, INCLUDING the verb tokens (`frontmatter get <file>` is 3).
 * Global flags (`GLOBAL_FLAGS`) are stripped by `main()` before dispatch and are
 * never redeclared by a verb (`--raw` is therefore absent from every spec).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import projection = require('./command-arg-projection.cjs');

type NamedArgSpec = projection.NamedArgSpec;

export interface VerbSpec extends NamedArgSpec {
  /** The verb's result depends on the active workstream (#4772). */
  workstreamScoped?: boolean;
  /** Flags belong to a third party the owner does not control (overlay path). */
  thirdParty?: boolean;
}

export interface GlobalFlags {
  readonly valueFlags: readonly string[];
  readonly booleanFlags: readonly string[];
  readonly eqFlags: readonly string[];
  readonly helpTokens: readonly string[];
  readonly rejectedTokens: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * What `main()` consumes before dispatch (gsd-tools.cjs 5459-5680): `--cwd`,
 * `--project-dir` (also `=`-form), `--ws`, `--pick`, `--default`, `--raw`,
 * `--json-errors`, and the `=`-form-only `--exit-contract`. Help tokens are
 * honored at any position; `--version`/`-v` are always rejected.
 */
export const GLOBAL_FLAGS: GlobalFlags = deepFreeze({
  valueFlags: ['cwd', 'default', 'pick', 'project-dir', 'ws'],
  booleanFlags: ['json-errors', 'raw'],
  eqFlags: ['cwd', 'exit-contract', 'project-dir'],
  helpTokens: ['-h', '--help', '-?', '--h', '--usage'],
  rejectedTokens: ['--version', '-v'],
});

const DRY_RUN = ['dry-run'];
const JSON_FLAG = ['json'];
const RUN_LANE_COMMON = ['run-dir', 'repo-root', 'selected'];

export const CLI_SURFACE: Readonly<Record<string, VerbSpec>> = deepFreeze({
  // ─── resolve / config ──────────────────────────────────────────────────────
  'resolve-model': { positionals: 2 },
  // Positional may sit before or after --granularity (hand loop), so no boundary walk.
  'resolve-granularity': { positionals: 'rest', valueFlags: ['granularity'] },
  // Positional agent type may interleave with the hand-parsed flags.
  'resolve-execution': {
    positionals: 'rest',
    valueFlags: ['attempt', 'effort', 'failure-class', 'fast-mode', 'host'],
    eqFlags: ['attempt', 'effort', 'failure-class', 'fast-mode'],
    nonEmptyFlags: ['attempt', 'effort', 'failure-class', 'fast-mode', 'host'],
  },
  'config-set': { positionals: 3, booleanFlags: DRY_RUN },
  'config-new-project': { positionals: 2, booleanFlags: DRY_RUN },
  'config-path': { positionals: 1 },
  'migrate-config': { positionals: 1 },

  // ─── research ──────────────────────────────────────────────────────────────
  'research-store.get': { positionals: 3 },
  'research-store.put': {
    positionals: 3,
    valueFlags: ['confidence', 'content', 'kind', 'provider', 'source'],
    requiredFlags: ['confidence', 'content', 'kind', 'provider', 'source'],
  },
  'research-plan': { positionals: 1, valueFlags: ['input'], requiredFlags: ['input'] },

  // ─── codebase map / revert / commit ────────────────────────────────────────
  'stamp-codebase-map': { positionals: 1, valueFlags: ['files'], bareEmptyFlags: ['files'] },
  // phase xor plan is conditional and stays in the handler.
  'select-revert-commits': {
    positionals: 1,
    valueFlags: ['phase', 'plan', 'range'],
    requiredFlags: ['range'],
  },
  // Message tokens are variadic and precede the first list flag.
  commit: {
    positionals: 'rest',
    booleanFlags: ['amend', 'no-verify'],
    listFlags: ['files', 'files-removed'],
  },
  'check-commit': { positionals: 1 },
  'commit-docs-guard.disable': { positionals: 2 },
  'commit-docs-guard.enable': { positionals: 2 },
  'commit-to-subrepo': { positionals: 2, listFlags: ['files'] },
  // The message slot is optional, so the boundary moves (routePrSubrepo: messagePresent ? 2 : 1).
  'pr-subrepo': { positionals: 'rest', valueFlags: ['branch', 'repo'] },
  'verify-summary': { positionals: 2, valueFlags: ['check-count'] },

  // ─── template / frontmatter ────────────────────────────────────────────────
  'template.select': { positionals: 3 },
  'template.fill': {
    positionals: 3,
    valueFlags: ['fields', 'name', 'phase', 'plan', 'type', 'wave'],
  },
  'frontmatter.get': { positionals: 3, valueFlags: ['field'] },
  'frontmatter.set': { positionals: 3, valueFlags: ['field', 'value'] },
  'frontmatter.merge': { positionals: 3, valueFlags: ['data'] },
  'frontmatter.validate': { positionals: 3, valueFlags: ['schema'] },

  // ─── small readers ─────────────────────────────────────────────────────────
  'current-timestamp': { positionals: 2 },
  'runtime-identity': { positionals: 1 },
  // The runtime is a bare token OR a flag, in either order.
  'project-instruction-file': { positionals: 'rest', valueFlags: ['runtime'], eqFlags: ['runtime'] },
  'list-todos': { positionals: 2 },
  'list-seeds': { positionals: 2 },
  'verify-path-exists': { positionals: 2 },
  // `--task` falls back to a bare positional, so it is not unconditionally required.
  'quick-tasks-append': {
    positionals: 'rest',
    valueFlags: ['directory', 'quick-id', 'slug', 'status', 'task'],
  },
  'quick-tasks-migrate': { positionals: 1 },
  'normalize-test-command': { positionals: 2 },
  'resolve-package-manager': { positionals: 2 },

  // ─── dispatch ──────────────────────────────────────────────────────────────
  'dispatch-should-flatten': { positionals: 1, booleanFlags: JSON_FLAG },
  'dispatch-isolation': {
    positionals: 1,
    valueFlags: ['cwd-target', 'force-isolation', 'phase', 'plan', 'prompt'],
    booleanFlags: JSON_FLAG,
  },
  'dispatch-capacity': { positionals: 1, booleanFlags: JSON_FLAG },
  // --force-isolation, --phase and --plan are explicitly refused by this verb (RECORDING_ONLY_ARGS).
  'inspect-dispatch-isolation': {
    positionals: 1,
    valueFlags: ['cwd-target', 'prompt'],
    booleanFlags: JSON_FLAG,
  },
  'record-dispatch-isolation': {
    positionals: 1,
    valueFlags: ['harness-flag', 'isolation', 'phase', 'plan'],
    eqFlags: ['harness-flag'],
    requiredFlags: ['isolation'],
  },
  'resolve-dispatch-type': { positionals: 1, valueFlags: ['requested'], booleanFlags: JSON_FLAG },
  'resolve-agent': { positionals: 1, valueFlags: ['name'], booleanFlags: JSON_FLAG },
  'agent-skills': {
    positionals: 2,
    booleanFlags: ['json', 'skills-only'],
    workstreamScoped: true,
  },
  'history-digest': { positionals: 1 },

  // ─── milestone / progress / uat / todo ─────────────────────────────────────
  'assumption-delta.scan': { positionals: 3, valueFlags: ['terms'] },
  'milestone.archive-quick': { positionals: 3, booleanFlags: DRY_RUN },
  'milestone.complete': {
    positionals: 3,
    booleanFlags: ['archive-quick', 'confirm', 'dry-run', 'force', 'no-archive-phases'],
    valueFlags: ['release-map'],
    nonEmptyFlags: ['release-map'],
    multiwordFlags: ['name'],
  },
  'progress.bar': { positionals: 2 },
  'stats.json': { positionals: 2 },
  'uat.classify-coverage': { positionals: 2, valueFlags: ['file', 'summary'] },
  'uat.complete-session': { positionals: 3, valueFlags: ['message'] },
  'uat.render-checkpoint': { positionals: 2, valueFlags: ['file'] },
  'todo.complete': { positionals: 3, booleanFlags: DRY_RUN },
  'todo.match-phase': { positionals: 3 },
  // `--phase` is value; `--name` swallows several tokens, so no boundary walk.
  scaffold: { positionals: 'rest', valueFlags: ['phase'], multiwordFlags: ['name'] },
  'loop.render-hooks': {
    positionals: 3,
    valueFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
    eqFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
    nonEmptyFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
  },
  'phase-plan-index': { positionals: 2 },
  'state-snapshot': { positionals: 1 },
  'summary-extract': { positionals: 2, valueFlags: ['fields'] },
  websearch: { positionals: 2, valueFlags: ['freshness', 'limit'] },

  // ─── workstream / learnings ────────────────────────────────────────────────
  'workstream.complete': { positionals: 3 },
  'workstream.create': { positionals: 3, valueFlags: ['migrate-name'], booleanFlags: ['no-migrate'] },
  'workstream.get': { positionals: 2 },
  'workstream.list': { positionals: 2 },
  'workstream.progress': { positionals: 2 },
  'workstream.set': { positionals: 3 },
  'workstream.status': { positionals: 3 },
  'learnings.copy': { positionals: 2 },
  'learnings.delete': { positionals: 3 },
  'learnings.list': { positionals: 2 },
  'learnings.prune': { positionals: 2, valueFlags: ['older-than'], requiredFlags: ['older-than'] },
  'learnings.query': { positionals: 2, valueFlags: ['tag'], requiredFlags: ['tag'] },
  'teams-status': { positionals: 1, booleanFlags: ['active'] },

  // ─── custom files / prompt budget ──────────────────────────────────────────
  'detect-custom-files': {
    positionals: 1,
    valueFlags: ['config-dir'],
    requiredFlags: ['config-dir'],
  },
  // Last --config-dir wins today; repeatable keeps every occurrence so the handler takes the last.
  'restore-custom-files': {
    positionals: 1,
    valueFlags: ['config-dir'],
    repeatableFlags: ['config-dir'],
    requiredFlags: ['config-dir'],
    booleanFlags: ['apply'],
  },
  'prompt-budget': {
    positionals: 1,
    valueFlags: [
      'budget',
      'context-file',
      'instructions-file',
      'output-metadata',
      'output-prompt',
      'plan-file',
      'project-file',
      'project-md-head-lines',
      'requirements-file',
      'research-file',
      'roadmap-file',
      'safety-margin-pct',
    ],
    repeatableFlags: ['plan-file'],
    requiredFlags: [
      'budget',
      'instructions-file',
      'output-metadata',
      'output-prompt',
      'plan-file',
      'roadmap-file',
    ],
  },

  // ─── context / confidence / legitimacy / effort / stories / drift ──────────
  // "At least one of class/prefix/contains" is conditional and stays in the handler.
  'context-predicates': {
    positionals: 1,
    valueFlags: ['class', 'contains', 'prefix'],
    eqFlags: ['class', 'contains', 'prefix'],
    nonEmptyFlags: ['class', 'contains', 'prefix'],
  },
  'update-context': {
    positionals: 1,
    valueFlags: ['config-dir', 'runtime'],
    eqFlags: ['config-dir', 'runtime'],
    nonEmptyFlags: ['config-dir', 'runtime'],
    booleanFlags: JSON_FLAG,
  },
  // `--ecosystem` is required only when `--package` is given and stays in the handler.
  'classify-confidence': {
    positionals: 1,
    valueFlags: ['ecosystem', 'package', 'provider'],
    requiredFlags: ['provider'],
    booleanFlags: ['verified'],
  },
  // Package names are the variadic positionals.
  'package-legitimacy.check': {
    positionals: 'rest',
    valueFlags: ['ecosystem'],
    requiredFlags: ['ecosystem'],
  },
  'effort.sync': {
    positionals: 2,
    booleanFlags: ['apply', 'dry-run'],
    valueFlags: ['config-dir', 'runtime'],
    eqFlags: ['config-dir', 'runtime'],
    nonEmptyFlags: ['config-dir', 'runtime'],
  },
  'user-story.validate': { positionals: 2, valueFlags: ['story'] },
  'drift-guard.authority': { positionals: 2 },
  'drift-guard.phase-status': { positionals: 2, valueFlags: ['phase'] },
  'drift-guard.severity': {
    positionals: 2,
    valueFlags: ['authority', 'status'],
    requiredFlags: ['status'],
  },
  'skills-root': { positionals: 2 },

  // ─── review-lane ───────────────────────────────────────────────────────────
  // Every sub reads --run-dir, --repo-root and --selected before branching (gsd-tools.cjs 1673-1799).
  'review-lane.availability': { positionals: 2, valueFlags: RUN_LANE_COMMON },
  'review-lane.dispatch-step': {
    positionals: 2,
    valueFlags: [...RUN_LANE_COMMON, 'base-sha', 'cap-id', 'depth', 'explicit', 'point'],
  },
  // Tokens after a literal `--` are candidate flags, matched against lane descriptors.
  'review-lane.explicit-from-argv': {
    positionals: 2,
    valueFlags: RUN_LANE_COMMON,
    passthroughAfter: '--',
  },
  'review-lane.flags': { positionals: 2, valueFlags: RUN_LANE_COMMON },
  'review-lane.invoke': {
    positionals: 2,
    valueFlags: [...RUN_LANE_COMMON, 'agent', 'as', 'model', 'prompt-file', 'slug'],
    booleanFlags: ['explicit'],
    requiredFlags: ['slug'],
  },
  'review-lane.plan': { positionals: 2, valueFlags: RUN_LANE_COMMON },
  'review-lane.sections': { positionals: 2, valueFlags: RUN_LANE_COMMON },
});

/**
 * Every dispatchable verb whose flags are still parsed outside this registry
 * (forwarders to `src/` routers, `_dispatchNonFamily` verbs, capability
 * families, alias canonicals). Sorted. Shrinks to `[]` across #6088-#6090; the
 * parity test (T-C3) fails if it grows.
 */
export const UNDECLARED_VERBS: readonly string[] = deepFreeze([
  'agent',
  'agent.classify-failure',
  'audit-open',
  'audit-uat',
  'capability',
  'check',
  'check.decision-coverage-plan',
  'check.decision-coverage-verify',
  'claude-orchestration',
  'config-ensure-section',
  'config-get',
  'config-set-model-profile',
  'docs-init',
  'estimate-calibrate',
  'estimate-calibration',
  'estimate-check',
  'eval',
  'eval.score',
  'extract-messages',
  'find-phase',
  'from-gsd2',
  'gap-analysis',
  'generate-claude-md',
  'generate-claude-profile',
  'generate-dev-preferences',
  'generate-slug',
  'git',
  'graphify',
  'init',
  'init.autonomous',
  'init.code-review',
  'init.complete-milestone',
  'init.debug',
  'init.discuss-phase-assumptions',
  'init.docs-update',
  'init.execute-phase',
  'init.ingest-docs',
  'init.list-workspaces',
  'init.manager',
  'init.map-codebase',
  'init.milestone-op',
  'init.new-milestone',
  'init.new-project',
  'init.new-workspace',
  'init.onboard',
  'init.phase-op',
  'init.plan-phase',
  'init.progress',
  'init.quick',
  'init.quick-batch',
  'init.remove-workspace',
  'init.resume',
  'init.review',
  'init.todos',
  'init.transition',
  'init.update',
  'init.verify-work',
  'intel',
  'milestone.release-tags',
  'phase',
  'phase.add',
  'phase.add-batch',
  'phase.complete',
  'phase.insert',
  'phase.list-plans',
  'phase.mvp-mode',
  'phase.next-decimal',
  'phase.remove',
  'phase.scaffold',
  'phase.uat-passed',
  'phases',
  'phases.archive',
  'phases.clear',
  'phases.list',
  'planning',
  'profile-questionnaire',
  'profile-sample',
  'quick-batch',
  'refactor',
  'requirements',
  'requirements.mark-complete',
  'requirements.ready-ids',
  'requirements.revert-phase',
  'roadmap',
  'roadmap.analyze',
  'roadmap.annotate-dependencies',
  'roadmap.get-phase',
  'roadmap.milestone-scope',
  'roadmap.update-plan-progress',
  'roadmap.upgrade',
  'roadmap.validate',
  'scan-sessions',
  'skill-manifest',
  'smart-entry',
  'state',
  'state.add-blocker',
  'state.add-decision',
  'state.add-roadmap-evolution',
  'state.advance-plan',
  'state.begin-phase',
  'state.get',
  'state.json',
  'state.load',
  'state.milestone-switch',
  'state.patch',
  'state.planned-phase',
  'state.prune',
  'state.rebuild',
  'state.record-metric',
  'state.record-session',
  'state.resolve-blocker',
  'state.signal-resume',
  'state.signal-waiting',
  'state.sync',
  'state.update',
  'state.update-progress',
  'state.validate',
  'task',
  'task.is-behavior-adding',
  'validate',
  'validate.agents',
  'validate.consistency',
  'validate.context',
  'validate.health',
  'verification',
  'verify',
  'verify.artifacts',
  'verify.codebase-drift',
  'verify.commits',
  'verify.context-drift',
  'verify.key-links',
  'verify.phase-completeness',
  'verify.plan-structure',
  'verify.references',
  'verify.schema-drift',
  'windows',
  'worktree',
  'write-profile',
] as string[]);

export function specFor(verb: string): VerbSpec {
  const spec = Object.prototype.hasOwnProperty.call(CLI_SURFACE, verb) ? CLI_SURFACE[verb] : undefined;
  if (spec === undefined) {
    throw new Error(
      `cli-surface: verb "${verb}" has no declared flag spec. Declare it in src/cli-surface.cts ` +
        '(CLI_SURFACE) before reading it through specFor().',
    );
  }
  return spec;
}

/** True when `verb` is declared or undeclared, or a declared/undeclared key is one of its sub-verbs (`verb.<sub>`). */
export function isCovered(verb: string): boolean {
  const prefix = `${verb}.`;
  const keys = [...Object.keys(CLI_SURFACE), ...UNDECLARED_VERBS];
  return keys.some((k) => k === verb || k.startsWith(prefix));
}

/**
 * The dispatchable verb universe: gsd-tools `HOST_COMMAND_ROUTERS` keys, the
 * capability-registry `commandFamilies` keys, and the command-aliases
 * canonicals. `gsd-tools.cjs` is required lazily, from the compiled location
 * (`gsd-core/bin/lib/`), because it is the CLI entry module.
 */
export function verbUniverse(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const gsdTools = require('../gsd-tools.cjs') as { hostCommandNames: () => string[] };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const capabilityRegistry = require('./capability-registry.cjs') as { commandFamilies: Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aliases = require('./command-aliases.cjs') as Record<string, unknown>;
  const universe = new Set<string>(gsdTools.hostCommandNames());
  for (const family of Object.keys(capabilityRegistry.commandFamilies)) universe.add(family);
  for (const [name, list] of Object.entries(aliases)) {
    if (!name.endsWith('_COMMAND_ALIASES') || !Array.isArray(list)) continue;
    for (const entry of list as Array<{ canonical?: unknown }>) {
      if (typeof entry.canonical === 'string') universe.add(entry.canonical);
    }
  }
  return [...universe].sort();
}
