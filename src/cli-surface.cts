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
  // The phase-type positional may sit before or after --granularity, so words past the boundary are free.
  'resolve-granularity': { positionals: 1, freePositionals: true, valueFlags: ['granularity'] },
  // Positional agent type may interleave with the hand-parsed flags. A flag without a next token (or with a
  // flag-shaped one) is `Missing value`; a literal empty value (`--effort ''`, `--effort=`) was always a value,
  // and the handler judges it (`--attempt ''` is "requires a non-negative integer").
  'resolve-execution': {
    positionals: 1,
    freePositionals: true,
    valueFlags: ['attempt', 'effort', 'failure-class', 'fast-mode', 'host'],
    eqFlags: ['attempt', 'effort', 'failure-class', 'fast-mode'],
    nonEmptyFlags: ['attempt', 'effort', 'failure-class', 'fast-mode', 'host'],
    emptyValueFlags: ['attempt', 'effort', 'failure-class', 'fast-mode', 'host'],
    emptyEqFlags: ['attempt', 'effort', 'failure-class', 'fast-mode'],
    // Any dash-led token that is not a declared flag was `Unknown flag for resolve-execution`.
    rejectShortFlags: true,
    unknownFlagMessage: 'Unknown flag for resolve-execution: {flag}',
  },
  'config-set': { positionals: 3, booleanFlags: DRY_RUN },
  // The choices JSON is the one positional, wherever --dry-run sits; the handler refuses a second one.
  // A dash+letter token is a flag, not choices JSON (`-1` and `-` stay choices); the shipped wording is kept (#5268).
  'config-new-project': {
    positionals: 1,
    freePositionals: true,
    booleanFlags: DRY_RUN,
    rejectShortFlags: true,
    unknownFlagMessage: 'Unknown flag for config-new-project: {flag}',
  },
  'config-path': { positionals: 1 },
  'migrate-config': { positionals: 1 },

  // ─── research ──────────────────────────────────────────────────────────────
  // The usage line names `[--kind <k>]` for get; the handler never reads it but callers pass it (research-cli tests).
  'research-store.get': { positionals: 3, valueFlags: ['kind'] },
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
  // Message tokens are variadic and precede the first list flag, so words past the verb are free.
  commit: {
    positionals: 1,
    freePositionals: true,
    booleanFlags: ['amend', 'no-verify'],
    listFlags: ['files', 'files-removed'],
  },
  'check-commit': { positionals: 1 },
  // #6043: prints the ProjectContext main() resolved; it reads no flags of its own.
  'project-context': { positionals: 1 },
  'commit-docs-guard.disable': { positionals: 2 },
  'commit-docs-guard.enable': { positionals: 2 },
  'commit-to-subrepo': { positionals: 2, listFlags: ['files'] },
  // The message slot is optional, so the boundary moves (routePrSubrepo: messagePresent ? 2 : 1).
  'pr-subrepo': { positionals: 1, freePositionals: true, valueFlags: ['branch', 'repo'] },
  'verify-summary': { positionals: 2, valueFlags: ['check-count'] },

  // ─── template / frontmatter ────────────────────────────────────────────────
  'template.select': { positionals: 3 },
  'template.fill': {
    positionals: 3,
    valueFlags: ['fields', 'name', 'phase', 'plan', 'type', 'wave'],
  },
  // The field is `--field <k>` or one free word after the file (`frontmatter.get <file> <field>` is the shipped form).
  'frontmatter.get': { positionals: 3, freePositionals: true, valueFlags: ['field'] },
  'frontmatter.set': { positionals: 3, valueFlags: ['field', 'value'] },
  'frontmatter.merge': { positionals: 3, valueFlags: ['data'] },
  'frontmatter.validate': { positionals: 3, valueFlags: ['schema'] },

  // ─── small readers ─────────────────────────────────────────────────────────
  'current-timestamp': { positionals: 2 },
  'runtime-identity': { positionals: 1 },
  // The runtime is a bare token OR a flag, in either order, so the bare token is a free word.
  'project-instruction-file': { positionals: 1, freePositionals: true, valueFlags: ['runtime'], eqFlags: ['runtime'] },
  'list-todos': { positionals: 2 },
  'list-seeds': { positionals: 2 },
  'verify-path-exists': { positionals: 2 },
  // `--task` falls back to a bare positional, so it is not unconditionally required.
  'quick-tasks-append': {
    positionals: 1,
    freePositionals: true,
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
  // --force-isolation, --phase and --plan are read by the router only to refuse them with the
  // "recording-only" message, so they are declared to reach it; bareEmptyFlags makes a bare flag read as '' (present).
  'inspect-dispatch-isolation': {
    positionals: 1,
    valueFlags: ['cwd-target', 'force-isolation', 'phase', 'plan', 'prompt'],
    bareEmptyFlags: ['force-isolation', 'phase', 'plan'],
    booleanFlags: JSON_FLAG,
  },
  // A missing or invalid --isolation prints the verb's usage line, so it is not a requiredFlag.
  // `--json` is accepted and ignored. `--worktree` is Cursor's bare harness flag: the legacy space
  // form `--harness-flag --worktree` reads no value and the stray `--worktree` is tolerated.
  'record-dispatch-isolation': {
    positionals: 1,
    valueFlags: ['harness-flag', 'isolation', 'phase', 'plan'],
    eqFlags: ['harness-flag'],
    booleanFlags: ['json', 'worktree'],
  },
  'resolve-dispatch-type': { positionals: 1, valueFlags: ['requested'], booleanFlags: JSON_FLAG },
  'resolve-agent': { positionals: 1, valueFlags: ['name'], booleanFlags: JSON_FLAG },
  // The agent type is a free word: `agent-skills --json <type>` and `agent-skills <type> --json` both work.
  'agent-skills': {
    positionals: 1,
    freePositionals: true,
    booleanFlags: ['json', 'skills-only'],
    workstreamScoped: true,
  },
  'history-digest': { positionals: 1 },

  // ─── milestone / progress / uat / todo ─────────────────────────────────────
  // `scan --terms a,b <phase>` exits sdk_unknown_command from the handler's phase check today; free words keep that reason.
  // `--json` is passed by the shipped plan-pre probe (capabilities/assumption-delta/fragments/plan-pre.md); the output is JSON either way.
  'assumption-delta.scan': { positionals: 2, freePositionals: true, valueFlags: ['terms'], booleanFlags: JSON_FLAG },
  'milestone.archive-quick': { positionals: 3, booleanFlags: DRY_RUN },
  'milestone.complete': {
    positionals: 3,
    // `--archive-phases` is the documented default spelled out; nothing reads it, callers pass it (milestone tests).
    booleanFlags: ['archive-phases', 'archive-quick', 'confirm', 'dry-run', 'force', 'no-archive-phases'],
    // A bare --release-map reads as '' (not null) so the handler can refuse it with today's exit reason.
    valueFlags: ['release-map'],
    bareEmptyFlags: ['release-map'],
    multiwordFlags: ['name'],
  },
  'progress.bar': { positionals: 2 },
  'stats.json': { positionals: 2 },
  'uat.classify-coverage': { positionals: 2, valueFlags: ['file', 'summary'] },
  'uat.complete-session': { positionals: 3, valueFlags: ['message'] },
  'uat.render-checkpoint': { positionals: 2, valueFlags: ['file'] },
  // The router refuses any dash-led token other than --dry-run itself (#4096); extra bare words were always ignored.
  // #4096: an accepted-but-ignored short flag (`-n`) would turn a preview into the mutation, so short flags are refused too.
  'todo.complete': {
    positionals: 3,
    freePositionals: true,
    booleanFlags: DRY_RUN,
    rejectShortFlags: true,
    unknownFlagMessage: 'Unknown flag for todo complete: {flag}',
  },
  'todo.match-phase': { positionals: 3 },
  // `--phase` is value; `--name` swallows the words up to the next flag.
  scaffold: { positionals: 2, valueFlags: ['phase'], multiwordFlags: ['name'] },
  'loop.render-hooks': {
    positionals: 3,
    valueFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
    eqFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
    nonEmptyFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
    // Only the `=` form was ever trimmed; a space-form value reaches the handler as typed.
    trimEqFlags: ['active-cap', 'after-fingerprint', 'config-dir', 'runtime'],
  },
  // `--json` is accepted and ignored: the index is JSON either way and callers pass it.
  'phase-plan-index': { positionals: 2, booleanFlags: JSON_FLAG },
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
  // Last --config-dir wins today; repeatable keeps every occurrence so the handler takes the last, and
  // nonEmptyFlags checks that last occurrence (a trailing `--config-dir` with no value is a usage error).
  'restore-custom-files': {
    positionals: 1,
    valueFlags: ['config-dir'],
    repeatableFlags: ['config-dir'],
    nonEmptyFlags: ['config-dir'],
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
    // An empty --plan-file list counts as missing; --budget's value validation stays in the handler.
    // Declaration order is the order a run missing several reports them; it mirrors the handler's old checks.
    requiredFlags: [
      'budget',
      'instructions-file',
      'roadmap-file',
      'plan-file',
      'output-prompt',
      'output-metadata',
    ],
  },

  // ─── context / confidence / legitimacy / effort / stories / drift ──────────
  // "At least one of class/prefix/contains" is conditional and stays in the handler.
  'context-predicates': {
    positionals: 1,
    valueFlags: ['class', 'contains', 'prefix'],
    eqFlags: ['class', 'contains', 'prefix'],
    nonEmptyFlags: ['class', 'contains', 'prefix'],
    // A whitespace-only value (`--class '  '`) is as missing as `--class=`.
    blankIsMissingFlags: ['class', 'contains', 'prefix'],
    // `--class==A` is a typo shape, never the literal `=A`; the space form `--class =A` is a value.
    eqRejectPrefix: { class: '=', contains: '=', prefix: '=' },
    missingValueMessage: 'context-predicates: {flag} requires a non-empty value',
  },
  'update-context': {
    positionals: 1,
    valueFlags: ['config-dir', 'runtime'],
    eqFlags: ['config-dir', 'runtime'],
    // The workflow passes empty hints (`--runtime ""`, `--config-dir=`) when it has none; only a flag with
    // no value token at all is refused.
    nonEmptyFlags: ['config-dir', 'runtime'],
    emptyValueFlags: ['config-dir', 'runtime'],
    emptyEqFlags: ['config-dir', 'runtime'],
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
    positionals: 2,
    freePositionals: true,
    valueFlags: ['ecosystem'],
    requiredFlags: ['ecosystem'],
  },
  'effort.sync': {
    positionals: 2,
    booleanFlags: ['apply', 'dry-run'],
    valueFlags: ['config-dir', 'runtime'],
    eqFlags: ['config-dir', 'runtime'],
    // `--config-dir ''` is refused but `--config-dir=` was accepted (and means "no override").
    nonEmptyFlags: ['config-dir', 'runtime'],
    emptyEqFlags: ['config-dir', 'runtime'],
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
    // `--json` is documented for this verb (docs/how-to/fix-a-refused-reviewer-lane.md) and always passed by callers; the result is JSON either way.
    booleanFlags: ['explicit', 'json'],
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
