#!/usr/bin/env node

/**
 * GSD Tools — CLI utility for GSD workflow operations.
 *
 * Replaces repetitive inline bash patterns across ~50 GSD command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node gsd-tools.cjs <command> [args] [--raw] [--pick <field>]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state json                         Output STATE.md frontmatter as JSON
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   state begin-phase --phase N --name S --plans C  Update STATE.md for new phase start
 *   state signal-waiting --type T --question Q --options "A|B" --phase P  Write WAITING.json signal
 *   state signal-resume                Remove WAITING.json signal
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2] [--no-verify]   Commit planning docs
 *   commit-to-subrepo <msg> --files f1 f2  Route commits to sub-repos
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   verify-path-exists <path>          Check file/directory existence
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description> [--id ID]   Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *   roadmap annotate-dependencies <N>  Add wave dependency notes + cross-cutting constraints to ROADMAP.md
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--archive-phases]               Move phase dirs to milestones/vX.Y-phases/
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *   validate agents                    Check GSD agent installation status
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * UAT Audit:
 *   audit-uat                           Scan all phases for unresolved UAT/verification items
 *   uat render-checkpoint --file <path> Render the current UAT checkpoint block
 *
 * Open Artifact Audit:
 *   audit-open [--json]                 Scan all .planning/ artifact types for unresolved items
 *
 * Intel:
 *   intel query <term>             Query intel files for a term
 *   intel status                   Show intel file freshness
 *   intel update                   Trigger intel refresh (returns agent spawn hint)
 *   intel diff                     Show changed intel entries since last snapshot
 *   intel snapshot                 Save current intel state as diff baseline
 *   intel patch-meta <file>        Update _meta.updated_at in an intel file
 *   intel validate                 Validate intel file structure
 *   intel extract-exports <file>   Extract exported symbols from a source file
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *   verify schema-drift <phase> [--skip]  Detect schema file changes without push
 *   verify codebase-drift                Detect structural drift since last codebase map (#2003)
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *     [--summary-file path] [--rationale-file path]
 *   state add-blocker --text "..."     Add blocker
 *     [--text-file path]
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick <description>           All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 *
 * Documentation:
 *   docs-init                            Project context for docs-update workflow
 *
 * Learnings:
 *   learnings list                       List all global learnings (JSON)
 *   learnings query --tag <tag>          Query learnings by tag
 *   learnings copy                       Copy from current project's LEARNINGS.md
 *   learnings prune --older-than <dur>   Remove entries older than duration (e.g. 90d)
 *   learnings delete <id>                Delete a learning by ID
 *
 * GSD-2 Migration:
 *   from-gsd2 [--path <dir>] [--force] [--dry-run]
 *             Import a GSD-2 (.gsd/) project back to GSD v1 (.planning/) format
 */

const fs = require('fs');
const path = require('path');
const core = require('./lib/core.cjs');
const { error, findProjectRoot, ERROR_REASON } = core;
const { getActiveWorkstream } = require('./lib/planning-workspace.cjs');
const { resolveActiveWorkstream, applyResolvedWorkstreamEnv } = require('./lib/active-workstream-store.cjs');
const state = require('./lib/state.cjs');
const phase = require('./lib/phase.cjs');
const roadmap = require('./lib/roadmap.cjs');
const verify = require('./lib/verify.cjs');
const config = require('./lib/config.cjs');
const template = require('./lib/template.cjs');
const milestone = require('./lib/milestone.cjs');
const commands = require('./lib/commands.cjs');
const init = require('./lib/init.cjs');
const frontmatter = require('./lib/frontmatter.cjs');
const profilePipeline = require('./lib/profile-pipeline.cjs');
const profileOutput = require('./lib/profile-output.cjs');
const workstream = require('./lib/workstream.cjs');
const docs = require('./lib/docs.cjs');
const learnings = require('./lib/learnings.cjs');
const gapChecker = require('./lib/gap-checker.cjs');
const { routeStateCommand } = require('./lib/state-command-router.cjs');
const { routeVerifyCommand } = require('./lib/verify-command-router.cjs');
const { routeInitCommand } = require('./lib/init-command-router.cjs');
const { routePhaseCommand } = require('./lib/phase-command-router.cjs');
const { routePhasesCommand } = require('./lib/phases-command-router.cjs');
const { routeValidateCommand } = require('./lib/validate-command-router.cjs');
const { routeRoadmapCommand } = require('./lib/roadmap-command-router.cjs');
const { routeAgentCommand } = require('./lib/agent-command-router.cjs');
const { routeCheckCommand } = require('./lib/check-command-router.cjs');
const { routeTaskCommand } = require('./lib/task-command-router.cjs');
const { parseNamedArgs, parseMultiwordArg } = require('./lib/command-arg-projection.cjs');

// ─── Bridge collapsed (Phase 4) ────────────────────────────────────────────────
// Non-family commands now run through their CJS handlers directly. Keep the
// helper contract so existing call sites remain unchanged during the phase
// sequence; it always returns false so callers fall through to CJS.

/**
 * Retired bridge-era shim for non-family dispatch.
 *
 * Always returns false so command handlers continue down the CJS path.
 * Kept only to avoid churn while legacy call sites are being deleted.
 *
 * @param {object} opts
 * @param {string} opts.registryCommand - legacy bridge placeholder
 * @param {string[]} opts.registryArgs - legacy bridge placeholder
 * @param {string} opts.legacyCommand - original gsd-tools command name
 * @param {string[]} opts.legacyArgs - original args
 * @param {string} opts.cwd - project dir
 * @param {boolean} opts.raw - raw output mode
 * @param {Function} opts.error - error reporter
 * @param {Function} opts.output - output emitter (core.output)
 */
function _dispatchNonFamily({ registryCommand, registryArgs, legacyCommand, legacyArgs, cwd, raw, error, output }) {
  void registryCommand;
  void registryArgs;
  void legacyCommand;
  void legacyArgs;
  void cwd;
  void raw;
  void error;
  void output;
  return false;
}

// ─── Arg parsing helpers ──────────────────────────────────────────────────────

// ─── CLI Router ───────────────────────────────────────────────────────────────

async function main() {
  let args = process.argv.slice(2);

  // --json-errors / GSD_JSON_ERRORS=1: when active, error() emits structured
  // JSON ({ ok: false, reason: <ERROR_REASON code>, message }) to stderr
  // instead of "Error: <text>". Lets test suites assert on typed reason codes
  // per CONTRIBUTING.md "Prohibited: Raw Text Matching" (#2974).
  //
  // Detect early — before any flag parsing that can fire error() — so even
  // --cwd and workstream-resolution failures emit structured stderr (#3310).
  // The argv splice must happen here too, otherwise the dispatcher below sees
  // "--json-errors" as an unknown command. Default off — human operators keep
  // their plain-text diagnostic.
  const jsonErrorsIdx = args.indexOf('--json-errors');
  if (jsonErrorsIdx !== -1) {
    core.setJsonErrorMode(true);
    args.splice(jsonErrorsIdx, 1);
  } else if (process.env.GSD_JSON_ERRORS === '1') {
    core.setJsonErrorMode(true);
  }

  // Optional cwd override for sandboxed subagents running outside project root.
  let cwd = process.cwd();
  const cwdEqArg = args.find(arg => arg.startsWith('--cwd='));
  const cwdIdx = args.indexOf('--cwd');
  if (cwdEqArg) {
    const value = cwdEqArg.slice('--cwd='.length).trim();
    if (!value) error('Missing value for --cwd', ERROR_REASON.USAGE);
    args.splice(args.indexOf(cwdEqArg), 1);
    cwd = path.resolve(value);
  } else if (cwdIdx !== -1) {
    const value = args[cwdIdx + 1];
    if (!value || value.startsWith('--')) error('Missing value for --cwd', ERROR_REASON.USAGE);
    args.splice(cwdIdx, 2);
    cwd = path.resolve(value);
  }

  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    error(`Invalid --cwd: ${cwd}`, ERROR_REASON.USAGE);
  }

  // Resolve worktree root: in a linked worktree, .planning/ lives in the main worktree.
  // However, in monorepo worktrees where the subdirectory itself owns .planning/,
  // skip worktree resolution — the CWD is already the correct project root.
  const { resolveWorktreeRoot } = require('./lib/core.cjs');
  if (!fs.existsSync(path.join(cwd, '.planning'))) {
    const worktreeRoot = resolveWorktreeRoot(cwd);
    if (worktreeRoot !== cwd) {
      cwd = worktreeRoot;
    }
  }

  // Optional workstream override for parallel milestone work.
  // Priority: --ws flag > GSD_WORKSTREAM env var > session/shared pointer > null.
  let ws = null;
  let workstreamContext = null;
  try {
    workstreamContext = resolveActiveWorkstream(cwd, args, process.env, {
      getStored: getActiveWorkstream,
    });
    ws = workstreamContext.ws;
    args = workstreamContext.args;
    // Set env var so all modules (planningDir, planningPaths) auto-resolve workstream paths.
    applyResolvedWorkstreamEnv(workstreamContext, process.env);
  } catch (err) {
    error(err.message || String(err));
  }

  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  if (rawIndex !== -1) args.splice(rawIndex, 1);

  // --pick <name>: extract a single field from JSON output (replaces jq dependency).
  // Supports dot-notation (e.g., --pick workflow.research) and bracket notation
  // for arrays (e.g., --pick directories[-1]).
  const pickIdx = args.indexOf('--pick');
  let pickField = null;
  if (pickIdx !== -1) {
    pickField = args[pickIdx + 1];
    if (!pickField || pickField.startsWith('--')) error('Missing value for --pick', ERROR_REASON.USAGE);
    args.splice(pickIdx, 2);
  }

  // --default <value>: for config-get, return this value instead of erroring
  // when the key is absent. Allows workflows to express optional config reads
  // without defensive `2>/dev/null || true` boilerplate (#1893).
  const defaultIdx = args.indexOf('--default');
  let defaultValue = undefined;
  if (defaultIdx !== -1) {
    defaultValue = args[defaultIdx + 1];
    if (defaultValue === undefined) defaultValue = '';
    args.splice(defaultIdx, 2);
  }

  let command = args[0];

  // Accept `query` as a meta-prefix for canonical dotted/spaced commands.
  // Workflows may call `node gsd-tools.cjs query <command>` directly.
  if (command === 'query') {
    args.shift();
    command = args[0];
  }

  // #3243: accept dotted canonical form (e.g. `state.update`) as well as the
  // spaced form (`state update`). Some workflow callers pass the dotted
  // canonical form directly; this normalization keeps both forms valid.
  //
  // Split on the FIRST dot only — `check.decision-coverage-plan` becomes
  // command='check', args=['check','decision-coverage-plan',...rest].
  // Guard: head and rest must both be non-empty (rejects leading-dot args like
  // ".hidden" and bare-dot ".").
  const originalCommand = command; // preserved for "Unknown command" suggestion
  if (typeof command === 'string' && command.includes('.')) {
    const dotIdx = command.indexOf('.');
    const head = command.slice(0, dotIdx);
    const rest = command.slice(dotIdx + 1);
    if (head && rest) {
      command = head;
      args = [head, rest, ...args.slice(1)];
    }
  }

  // Top-level usage string — emitted by `gsd-tools` (no args) and by
  // `gsd-tools --help` / any `--help` request below.
  // CR feedback: the command list must enumerate every top-level command
  // supported by the dispatcher so `--help` is actually useful for
  // discovery; previously it was a partial subset that didn't include
  // phase / roadmap / milestone / progress / etc.
  const TOP_LEVEL_USAGE = 'Usage: gsd-tools <command> [args] [--raw] [--pick <field>] [--cwd <path>] [--ws <name>] [--json-errors]\n' +
    'Commands: agent, agent-skills, audit-open, audit-uat, check, check-commit, commit, commit-to-subrepo, ' +
    'config-ensure-section, config-get, config-new-project, config-path, config-set, migrate-config, ' +
    'current-timestamp, detect-custom-files, docs-init, extract-messages, find-phase, ' +
    'from-gsd2, frontmatter, gap-analysis, generate-claude-md, generate-claude-profile, ' +
    'generate-dev-preferences, generate-slug, graphify, history-digest, init, intel, ' +
    'learnings, list-todos, milestone, phase, phase-plan-index, phases, profile-questionnaire, ' +
    'profile-sample, progress, prompt-budget, requirements, resolve-model, roadmap, scaffold, state, ' +
    'task, template, validate, verify, verify-path-exists, verify-summary, workstream, worktree\n\n' +
    'Global flags:\n' +
    '  --raw              Emit raw output without post-processing\n' +
    '  --pick <field>     Extract a single field from JSON output (dot/bracket notation)\n' +
    '  --cwd <path>       Override working directory for project-root resolution\n' +
    '  --ws <name>        Override active workstream (or set GSD_WORKSTREAM)\n' +
    '  --json-errors      Emit structured JSON error objects on stderr (or set GSD_JSON_ERRORS=1)\n\n' +
    'For command-specific argument requirements, invoke the command without args ' +
    '(e.g. `gsd-tools phase add`) — the resulting error lists what is required.';

  if (!command) {
    error(TOP_LEVEL_USAGE);
  }

  // #3019: a `--help` / `-h` flag in argv must render the top-level usage
  // and exit 0 — not error out with "Unknown flag". The previous shape
  // erred on agent-hallucinated flags, but it also blocked humans from
  // discovering the command surface via subcommand help requests routed
  // through this dispatcher. Rendering top-level usage on --help is strictly
  // better UX than the old short-circuit that printed unrelated usage text.
  const HELP_FLAGS = new Set(['-h', '--help', '-?', '--h', '--usage']);
  if (args.some((a) => HELP_FLAGS.has(a))) {
    process.stdout.write(TOP_LEVEL_USAGE + '\n');
    return;
  }

  // Reject version flags. AI agents sometimes hallucinate --version on tool
  // invocations; silently ignoring it can cause destructive operations to
  // proceed unchecked. (Help flags are handled above.)
  const NEVER_VALID_FLAGS = new Set(['--version', '-v']);
  for (const arg of args) {
    if (NEVER_VALID_FLAGS.has(arg)) {
      error(`Unknown flag: ${arg}\ngsd-tools does not accept version flags. Run "gsd-tools" with no arguments for usage.`, ERROR_REASON.USAGE);
    }
  }

  // Multi-repo guard: resolve project root for commands that read/write .planning/.
  // Skip for pure-utility commands that don't touch .planning/ to avoid unnecessary
  // filesystem traversal on every invocation.
  const SKIP_ROOT_RESOLUTION = new Set([
    'generate-slug', 'current-timestamp', 'verify-path-exists',
    'verify-summary', 'template', 'frontmatter', 'detect-custom-files',
    'worktree', 'prompt-budget',
  ]);
  if (!SKIP_ROOT_RESOLUTION.has(command)) {
    cwd = findProjectRoot(cwd);
  }

  // When --pick is active, capture stdout and extract the requested field.
  if (pickField) {
    const captured = await captureStdoutSyncWrites(async () => {
      await runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext);
    });
    const resolved = resolveAtFileOutput(captured);
    try {
      const obj = JSON.parse(resolved);
      const value = extractField(obj, pickField);
      const result = value === null || value === undefined ? '' : String(value);
      fs.writeSync(1, result);
    } catch {
      fs.writeSync(1, captured);
    }
    return;
  }

  // Intercept stdout to transparently resolve @file: references (#1891).
  // core.cjs output() writes @file:<path> when JSON > 50KB. The --pick path
  // already resolves this, but the normal path wrote @file: to stdout, forcing
  // every workflow to have a bash-specific `if [[ "$INIT" == @file:* ]]` check
  // that breaks on PowerShell and other non-bash shells.
  const captured = await captureStdoutSyncWrites(async () => {
    await runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext);
  });
  fs.writeSync(1, resolveAtFileOutput(captured));
}

function captureStdoutSyncWrites(run) {
  const originalWriteSync = fs.writeSync;
  let captured = '';

  fs.writeSync = function patchedWriteSync(fd, data, ...rest) {
    if (fd === 1) {
      if (Buffer.isBuffer(data)) {
        captured += data.toString('utf-8');
        return data.length;
      }
      const text = String(data);
      captured += text;
      let encoding = 'utf-8';
      if (typeof rest[1] === 'string') encoding = rest[1];
      return Buffer.byteLength(text, encoding);
    }
    return originalWriteSync.call(fs, fd, data, ...rest);
  };

  const restore = () => {
    fs.writeSync = originalWriteSync;
  };

  return Promise.resolve()
    .then(() => run())
    .then(() => {
      restore();
      return captured;
    }, (err) => {
      restore();
      throw err;
    });
}

function resolveAtFileOutput(captured) {
  if (!captured.startsWith('@file:')) return captured;
  return fs.readFileSync(captured.slice(6), 'utf-8');
}

/**
 * Extract a field from an object using dot-notation and bracket syntax.
 * Supports: 'field', 'parent.child', 'arr[-1]', 'arr[0]'
 */
function extractField(obj, fieldPath) {
  const parts = fieldPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const bracketMatch = part.match(/^(.+?)\[(-?\d+)]$/);
    if (bracketMatch) {
      const key = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      current = current[key];
      if (!Array.isArray(current)) return undefined;
      current = index < 0 ? current[current.length + index] : current[index];
    } else {
      current = current[part];
    }
  }
  return current;
}

async function runCommand(command, args, cwd, raw, defaultValue, originalCommand, workstreamContext = null) {
  switch (command) {
    case 'agent': {
      routeAgentCommand({ args, raw });
      break;
    }

    case 'check': {
      routeCheckCommand({ args, cwd, raw });
      break;
    }

    case 'state': {
      routeStateCommand({
        state,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'resolve-model': {
      commands.cmdResolveModel(cwd, args[1], raw);
      break;
    }

    case 'resolve-execution': {
      // Deterministic flag parsing: consume --flag <value> pairs first,
      // then the AGENT is the single remaining positional.
      // Supports both orderings: <agent> --flag val  AND  --flag val <agent>.
      // Also supports --flag=value form (same convention as --cwd= above).
      const execArgs = args.slice(1);
      let effortOverride;
      let fastModeOverride;
      let attempt;
      const positionals = [];
      for (let i = 0; i < execArgs.length; i++) {
        const a = execArgs[i];
        // --effort=<val> form
        if (a.startsWith('--effort=')) {
          effortOverride = a.slice('--effort='.length);
          continue;
        }
        // --fast-mode=<val> form
        if (a.startsWith('--fast-mode=')) {
          const v = a.slice('--fast-mode='.length);
          fastModeOverride = v === 'true' ? true : v === 'false' ? false : undefined;
          continue;
        }
        // --attempt=<val> form
        if (a.startsWith('--attempt=')) {
          const v = a.slice('--attempt='.length);
          const n = parseInt(v, 10);
          if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
          attempt = n;
          continue;
        }
        // --effort <val>
        if (a === '--effort') {
          const val = execArgs[i + 1];
          if (val === undefined || val.startsWith('--')) error('Missing value for --effort', ERROR_REASON.USAGE);
          effortOverride = val;
          i++;
          continue;
        }
        // --fast-mode <val>
        if (a === '--fast-mode') {
          const val = execArgs[i + 1];
          if (val === undefined || val.startsWith('--')) error('Missing value for --fast-mode', ERROR_REASON.USAGE);
          fastModeOverride = val === 'true' ? true : val === 'false' ? false : undefined;
          i++;
          continue;
        }
        // --attempt <val>
        if (a === '--attempt') {
          const val = execArgs[i + 1];
          if (val === undefined || val.startsWith('--')) error('Missing value for --attempt', ERROR_REASON.USAGE);
          const n = parseInt(val, 10);
          if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
          attempt = n;
          i++;
          continue;
        }
        // --raw is handled by top-level arg processing; skip it here
        if (a === '--raw') continue;
        // Unknown flag
        if (a.startsWith('-')) error(`Unknown flag for resolve-execution: ${a}`, ERROR_REASON.USAGE);
        // Positional
        positionals.push(a);
      }
      if (positionals.length === 0) error('agent-type required', ERROR_REASON.USAGE);
      if (positionals.length > 1) error(`resolve-execution requires exactly one agent-type argument; got: ${positionals.join(', ')}`, ERROR_REASON.USAGE);
      const agentTypeArg = positionals[0];
      commands.cmdResolveExecution(cwd, agentTypeArg, raw, {
        effortOverride,
        fastModeOverride,
        attempt,
      });
      break;
    }

    case 'find-phase': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      // SDK handler: findPhase in sdk/src/query/phase.ts.
      const handled = _dispatchNonFamily({
        registryCommand: 'find-phase',
        registryArgs: args.slice(1),
        legacyCommand: 'find-phase',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) phase.cmdFindPhase(cwd, args[1], raw);
      break;
    }

    case 'commit': {
      const amend = args.includes('--amend');
      const noVerify = args.includes('--no-verify');
      const filesIndex = args.indexOf('--files');
      // Collect all positional args between command name and first flag,
      // then join them — handles both quoted ("multi word msg") and
      // unquoted (multi word msg) invocations from different shells
      const endIndex = filesIndex !== -1 ? filesIndex : args.length;
      const messageArgs = args.slice(1, endIndex).filter(a => !a.startsWith('--'));
      const message = messageArgs.join(' ') || undefined;
      const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
      commands.cmdCommit(cwd, message, files, raw, amend, noVerify);
      break;
    }

    case 'check-commit': {
      commands.cmdCheckCommit(cwd, raw);
      break;
    }

    case 'commit-to-subrepo': {
      const message = args[1];
      const filesIndex = args.indexOf('--files');
      const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
      commands.cmdCommitToSubrepo(cwd, message, files, raw);
      break;
    }

    case 'verify-summary': {
      const summaryPath = args[1];
      const countIndex = args.indexOf('--check-count');
      const checkCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
      verify.cmdVerifySummary(cwd, summaryPath, checkCount, raw);
      break;
    }

    case 'template': {
      const subcommand = args[1];
      if (subcommand === 'select') {
        template.cmdTemplateSelect(cwd, args[2], raw);
      } else if (subcommand === 'fill') {
        const templateType = args[2];
        const { phase, plan, name, type, wave, fields: fieldsRaw } = parseNamedArgs(args, ['phase', 'plan', 'name', 'type', 'wave', 'fields']);
        let fields = {};
        if (fieldsRaw) {
          const { safeJsonParse } = require('./lib/security.cjs');
          const result = safeJsonParse(fieldsRaw, { label: '--fields' });
          if (!result.ok) error(result.error);
          fields = result.value;
        }
        template.cmdTemplateFill(cwd, templateType, {
          phase, plan, name, fields,
          type: type || 'execute',
          wave: wave || '1',
        }, raw);
      } else {
        error('Unknown template subcommand. Available: select, fill', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'task': {
      routeTaskCommand({ args, cwd, raw });
      break;
    }

    case 'frontmatter': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      // SDK handler: sdk/src/query/frontmatter.ts + frontmatter-mutation.ts.
      // CJS fallback: frontmatter.cjs (cooperating sibling).
      const subcommand = args[1];
      const file = args[2];
      const FRONTMATTER_SDK_MAP = {
        get: 'frontmatter.get',
        set: 'frontmatter.set',
        merge: 'frontmatter.merge',
        validate: 'frontmatter.validate',
      };
      if (subcommand in FRONTMATTER_SDK_MAP) {
        const handled = _dispatchNonFamily({
          registryCommand: FRONTMATTER_SDK_MAP[subcommand],
          registryArgs: args.slice(2),
          legacyCommand: 'frontmatter',
          legacyArgs: args.slice(1),
          cwd,
          raw,
          error,
          output: core.output,
        });
        if (handled) break;
      }
      // CJS fallback (SDK unavailable or unknown subcommand)
      if (subcommand === 'get') {
        frontmatter.cmdFrontmatterGet(cwd, file, parseNamedArgs(args, ['field']).field, raw);
      } else if (subcommand === 'set') {
        const { field, value } = parseNamedArgs(args, ['field', 'value']);
        frontmatter.cmdFrontmatterSet(cwd, file, field, value !== null ? value : undefined, raw);
      } else if (subcommand === 'merge') {
        frontmatter.cmdFrontmatterMerge(cwd, file, parseNamedArgs(args, ['data']).data, raw);
      } else if (subcommand === 'validate') {
        frontmatter.cmdFrontmatterValidate(cwd, file, parseNamedArgs(args, ['schema']).schema, raw);
      } else {
        error('Unknown frontmatter subcommand. Available: get, set, merge, validate', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'verify': {
      routeVerifyCommand({
        verify,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'generate-slug': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      // SDK handler: generateSlug in sdk/src/query/utils.ts.
      const handled = _dispatchNonFamily({
        registryCommand: 'generate-slug',
        registryArgs: args.slice(1),
        legacyCommand: 'generate-slug',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) commands.cmdGenerateSlug(args[1], raw);
      break;
    }

    case 'current-timestamp': {
      // Keep this command on the CJS fast path.
      // Rationale: it is a pure local formatter and avoids SDK bridge startup
      // in tight subprocess loops where Windows CI has shown intermittent
      // native crashes (0xC0000005 / 3221225477).
      commands.cmdCurrentTimestamp(args[1] || 'full', raw);
      break;
    }

    case 'list-todos': {
      commands.cmdListTodos(cwd, args[1], raw);
      break;
    }

    case 'verify-path-exists': {
      commands.cmdVerifyPathExists(cwd, args[1], raw);
      break;
    }

    case 'config-ensure-section': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs. The catalog rebinds
      // 'config-ensure-section' to configNewProject in
      // sdk/src/query/command-static-catalog-foundation.ts, restoring the
      // legacy "no-arg full default init" contract on the SDK path
      // (configEnsureSection itself stays available as an unbound single-
      // section helper for future SDK callers).
      const handled = _dispatchNonFamily({
        registryCommand: 'config-ensure-section',
        registryArgs: args.slice(1),
        legacyCommand: 'config-ensure-section',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) config.cmdConfigEnsureSection(cwd, raw);
      break;
    }

    case 'config-set': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      const handled = _dispatchNonFamily({
        registryCommand: 'config-set',
        registryArgs: args.slice(1),
        legacyCommand: 'config-set',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) config.cmdConfigSet(cwd, args[1], args[2], raw);
      break;
    }

    case "config-set-model-profile": {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      const handled = _dispatchNonFamily({
        registryCommand: 'config-set-model-profile',
        registryArgs: args.slice(1),
        legacyCommand: 'config-set-model-profile',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) config.cmdConfigSetModelProfile(cwd, args[1], raw);
      break;
    }

    case 'config-get': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      // The SDK handler supports --default via the registry args (args.slice(1)
      // contains the key; defaultValue is handled by the SDK via the --default
      // flag which was already stripped from args and held in defaultValue).
      // Pass the full original args.slice(1) so the SDK sees the key; the
      // defaultValue from the flag is in the global defaultValue variable above.
      // Since the SDK handler reads --default from registryArgs, re-inject it.
      const configGetSdkArgs = defaultValue !== undefined
        ? [args[1], '--default', defaultValue]
        : args.slice(1);
      const handled = _dispatchNonFamily({
        registryCommand: 'config-get',
        registryArgs: configGetSdkArgs,
        legacyCommand: 'config-get',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) config.cmdConfigGet(cwd, args[1], raw, defaultValue);
      break;
    }

    case 'config-new-project': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      const handled = _dispatchNonFamily({
        registryCommand: 'config-new-project',
        registryArgs: args.slice(1),
        legacyCommand: 'config-new-project',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) config.cmdConfigNewProject(cwd, args[1], raw);
      break;
    }

    case 'config-path': {
      // CJS-native: config-path returns the filesystem path to config.json.
      // The SDK handler (configPath) also exists but requires a projectDir that
      // is already resolved. Both produce identical output; keeping CJS here is
      // simpler and avoids sync-bridge overhead for a trivial path lookup.
      config.cmdConfigPath(cwd, raw, workstreamContext);
      break;
    }

    case 'migrate-config': {
      // CJS-native: migrate-config wraps the Configuration Module migrateOnDisk()
      // which is async and mutates the filesystem. No SDK counterpart exists in
      // the command registry (it's a one-shot migration utility). Must await.
      await config.cmdMigrateConfig(cwd, raw);
      break;
    }

    case 'agent-skills': {
      // --json emits typed IR { agent_type, block, skills_count } for test assertions
      // (#455). Default (no flag) outputs raw XML so workflow shell expansions work.
      const jsonIdx = args.indexOf('--json');
      const agentSkillsJsonMode = jsonIdx !== -1;
      if (agentSkillsJsonMode) args.splice(jsonIdx, 1);
      init.cmdAgentSkills(cwd, args[1], raw, agentSkillsJsonMode);
      break;
    }

    case 'skill-manifest': {
      init.cmdSkillManifest(cwd, args, raw);
      break;
    }

    case 'history-digest': {
      commands.cmdHistoryDigest(cwd, raw);
      break;
    }

    case 'phases': {
      routePhasesCommand({
        phase,
        milestone,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'roadmap': {
      routeRoadmapCommand({
        roadmap,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'requirements': {
      const subcommand = args[1];
      if (subcommand === 'mark-complete') {
        milestone.cmdRequirementsMarkComplete(cwd, args.slice(2), raw);
      } else {
        error('Unknown requirements subcommand. Available: mark-complete', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'gap-analysis': {
      // Post-planning gap checker (#2493) — unified REQUIREMENTS.md +
      // CONTEXT.md <decisions> coverage report against PLAN.md files.
      gapChecker.cmdGapAnalysis(cwd, args.slice(1), raw);
      break;
    }

    case 'phase': {
      routePhaseCommand({
        phase,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'milestone': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        const milestoneName = parseMultiwordArg(args, 'name');
        const archivePhases = args.includes('--archive-phases');
        milestone.cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases }, raw);
      } else {
        error('Unknown milestone subcommand. Available: complete', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'validate': {
      routeValidateCommand({
        verify,
        args,
        cwd,
        raw,
        output: core.output,
        error,
      });
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      commands.cmdProgressRender(cwd, subcommand, raw);
      break;
    }

    case 'audit-uat': {
      const uat = require('./lib/uat.cjs');
      uat.cmdAuditUat(cwd, raw);
      break;
    }

    case 'audit-open': {
      const { auditOpenArtifacts, formatAuditReport } = require('./lib/audit.cjs');
      const wantJson = args.includes('--json');
      const result = auditOpenArtifacts(cwd);
      if (wantJson) {
        // core.output JSON-stringifies its first arg; pass the object directly.
        core.output(result, raw);
      } else {
        // Human-readable report must bypass JSON encoding — use the rawValue
        // form (third arg) which core.output emits verbatim.
        core.output(null, true, formatAuditReport(result));
      }
      break;
    }

    case 'uat': {
      const subcommand = args[1];
      const uat = require('./lib/uat.cjs');
      if (subcommand === 'render-checkpoint') {
        const options = parseNamedArgs(args, ['file']);
        uat.cmdRenderCheckpoint(cwd, options, raw);
      } else {
        error('Unknown uat subcommand. Available: render-checkpoint', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'stats': {
      const subcommand = args[1] || 'json';
      commands.cmdStats(cwd, subcommand, raw);
      break;
    }

    case 'todo': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        commands.cmdTodoComplete(cwd, args[2], raw);
      } else if (subcommand === 'match-phase') {
        commands.cmdTodoMatchPhase(cwd, args[2], raw);
      } else {
        error('Unknown todo subcommand. Available: complete, match-phase', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'scaffold': {
      const scaffoldType = args[1];
      const scaffoldOptions = {
        phase: parseNamedArgs(args, ['phase']).phase,
        name: parseMultiwordArg(args, 'name'),
      };
      commands.cmdScaffold(cwd, scaffoldType, scaffoldOptions, raw);
      break;
    }

    case 'init': {
      routeInitCommand({
        init,
        args,
        cwd,
        raw,
        error,
      });
      break;
    }

    case 'phase-plan-index': {
      phase.cmdPhasePlanIndex(cwd, args[1], raw);
      break;
    }

    case 'state-snapshot': {
      state.cmdStateSnapshot(cwd, raw);
      break;
    }

    case 'summary-extract': {
      const summaryPath = args[1];
      const fieldsIndex = args.indexOf('--fields');
      const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
      commands.cmdSummaryExtract(cwd, summaryPath, fields, raw);
      break;
    }

    case 'websearch': {
      const query = args[1];
      const limitIdx = args.indexOf('--limit');
      const freshnessIdx = args.indexOf('--freshness');
      await commands.cmdWebsearch(query, {
        limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
        freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
      }, raw);
      break;
    }

    // ─── Profiling Pipeline ────────────────────────────────────────────────

    case 'scan-sessions': {
      const pathIdx = args.indexOf('--path');
      const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
      const verboseFlag = args.includes('--verbose');
      const jsonFlag = args.includes('--json');
      await profilePipeline.cmdScanSessions(sessionsPath, { verbose: verboseFlag, json: jsonFlag }, raw);
      break;
    }

    case 'extract-messages': {
      const sessionIdx = args.indexOf('--session');
      const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : null;
      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
      const pathIdx = args.indexOf('--path');
      const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
      const projectArg = args[1];
      if (!projectArg || projectArg.startsWith('--')) {
        error('Usage: gsd-tools extract-messages <project> [--session <id>] [--limit N] [--path <dir>]\nRun scan-sessions first to see available projects.', ERROR_REASON.USAGE);
      }
      await profilePipeline.cmdExtractMessages(projectArg, { sessionId, limit }, raw, sessionsPath);
      break;
    }

    case 'profile-sample': {
      const pathIdx = args.indexOf('--path');
      const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 150;
      const maxPerIdx = args.indexOf('--max-per-project');
      const maxPerProject = maxPerIdx !== -1 ? parseInt(args[maxPerIdx + 1], 10) : null;
      const maxCharsIdx = args.indexOf('--max-chars');
      const maxChars = maxCharsIdx !== -1 ? parseInt(args[maxCharsIdx + 1], 10) : 500;
      await profilePipeline.cmdProfileSample(sessionsPath, { limit, maxPerProject, maxChars }, raw);
      break;
    }

    // ─── Profile Output ──────────────────────────────────────────────────

    case 'write-profile': {
      const inputIdx = args.indexOf('--input');
      const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : null;
      if (!inputPath) error('--input <analysis-json-path> is required', ERROR_REASON.USAGE);
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
      profileOutput.cmdWriteProfile(cwd, { input: inputPath, output: outputPath }, raw);
      break;
    }

    case 'profile-questionnaire': {
      const answersIdx = args.indexOf('--answers');
      const answers = answersIdx !== -1 ? args[answersIdx + 1] : null;
      profileOutput.cmdProfileQuestionnaire({ answers }, raw);
      break;
    }

    case 'generate-dev-preferences': {
      const analysisIdx = args.indexOf('--analysis');
      const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
      const stackIdx = args.indexOf('--stack');
      const stack = stackIdx !== -1 ? args[stackIdx + 1] : null;
      profileOutput.cmdGenerateDevPreferences(cwd, { analysis: analysisPath, output: outputPath, stack }, raw);
      break;
    }

    case 'generate-claude-profile': {
      const analysisIdx = args.indexOf('--analysis');
      const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
      const globalFlag = args.includes('--global');
      profileOutput.cmdGenerateClaudeProfile(cwd, { analysis: analysisPath, output: outputPath, global: globalFlag }, raw);
      break;
    }

    case 'generate-claude-md': {
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
      const autoFlag = args.includes('--auto');
      const forceFlag = args.includes('--force');
      profileOutput.cmdGenerateClaudeMd(cwd, { output: outputPath, auto: autoFlag, force: forceFlag }, raw);
      break;
    }

    case 'workstream': {
      const subcommand = args[1];
      if (subcommand === 'create') {
        const migrateNameIdx = args.indexOf('--migrate-name');
        const noMigrate = args.includes('--no-migrate');
        workstream.cmdWorkstreamCreate(cwd, args[2], {
          migrate: !noMigrate,
          migrateName: migrateNameIdx !== -1 ? args[migrateNameIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'list') {
        workstream.cmdWorkstreamList(cwd, raw);
      } else if (subcommand === 'status') {
        workstream.cmdWorkstreamStatus(cwd, args[2], raw);
      } else if (subcommand === 'complete') {
        workstream.cmdWorkstreamComplete(cwd, args[2], {}, raw);
      } else if (subcommand === 'set') {
        workstream.cmdWorkstreamSet(cwd, args[2], raw);
      } else if (subcommand === 'get') {
        workstream.cmdWorkstreamGet(cwd, raw);
      } else if (subcommand === 'progress') {
        workstream.cmdWorkstreamProgress(cwd, raw);
      } else {
        error('Unknown workstream subcommand. Available: create, list, status, complete, set, get, progress', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'worktree': {
      const subcommand = args[1];
      const worktreeSafety = require('./lib/worktree-safety.cjs');
      if (subcommand === 'cleanup-wave') {
        worktreeSafety.cmdWorktreeCleanupWave(cwd, args.slice(2));
      } else if (subcommand === 'reap-orphans') {
        worktreeSafety.cmdWorktreeReapOrphans(cwd);
      } else {
        error('Unknown worktree subcommand. Available: cleanup-wave, reap-orphans', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    // ─── Intel ────────────────────────────────────────────────────────────

    case 'intel': {
      const intel = require('./lib/intel.cjs');
      const subcommand = args[1];
      if (subcommand === 'query') {
        const term = args[2];
        if (!term) error('Usage: gsd-tools intel query <term>', ERROR_REASON.USAGE);
        const planningDir = path.join(cwd, '.planning');
        core.output(intel.intelQuery(term, planningDir), raw);
      } else if (subcommand === 'status') {
        const planningDir = path.join(cwd, '.planning');
        const status = intel.intelStatus(planningDir);
        if (!raw && status.files) {
          for (const file of Object.values(status.files)) {
            if (file.updated_at) {
              file.updated_at = core.timeAgo(new Date(file.updated_at));
            }
          }
        }
        core.output(status, raw);
      } else if (subcommand === 'diff') {
        const planningDir = path.join(cwd, '.planning');
        core.output(intel.intelDiff(planningDir), raw);
      } else if (subcommand === 'snapshot') {
        const planningDir = path.join(cwd, '.planning');
        core.output(intel.intelSnapshot(planningDir), raw);
      } else if (subcommand === 'patch-meta') {
        const filePath = args[2];
        if (!filePath) error('Usage: gsd-tools intel patch-meta <file-path>', ERROR_REASON.USAGE);
        core.output(intel.intelPatchMeta(path.resolve(cwd, filePath)), raw);
      } else if (subcommand === 'validate') {
        const planningDir = path.join(cwd, '.planning');
        core.output(intel.intelValidate(planningDir), raw);
      } else if (subcommand === 'extract-exports') {
        const filePath = args[2];
        if (!filePath) error('Usage: gsd-tools intel extract-exports <file-path>', ERROR_REASON.USAGE);
        core.output(intel.intelExtractExports(path.resolve(cwd, filePath)), raw);
      } else if (subcommand === 'update') {
        const planningDir = path.join(cwd, '.planning');
        core.output(intel.intelUpdate(planningDir), raw);
      } else {
        error('Unknown intel subcommand. Available: query, status, update, diff, snapshot, patch-meta, validate, extract-exports', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    // ─── Graphify ──────────────────────────────────────────────────────────

    case 'graphify': {
      const graphify = require('./lib/graphify.cjs');
      const subcommand = args[1];
      if (subcommand === 'query') {
        const term = args[2];
        if (!term) error('Usage: gsd-tools graphify query <term>', ERROR_REASON.USAGE);
        const budgetIdx = args.indexOf('--budget');
        const budget = budgetIdx !== -1 ? parseInt(args[budgetIdx + 1], 10) : null;
        core.output(graphify.graphifyQuery(cwd, term, { budget }), raw);
      } else if (subcommand === 'status') {
        core.output(graphify.graphifyStatus(cwd), raw);
      } else if (subcommand === 'diff') {
        core.output(graphify.graphifyDiff(cwd), raw);
      } else if (subcommand === 'build') {
        if (args[2] === 'snapshot') {
          core.output(graphify.writeSnapshot(cwd), raw);
        } else {
          core.output(graphify.graphifyBuild(cwd), raw);
        }
      } else {
        error('Unknown graphify subcommand. Available: build, query, status, diff', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    // ─── Documentation ────────────────────────────────────────────────────

    case 'docs-init': {
      // Phase 6 (#3575): dispatch via SDK executeForCjs when available.
      // SDK handler: docsInit in sdk/src/query/docs-init.ts.
      const handled = _dispatchNonFamily({
        registryCommand: 'docs-init',
        registryArgs: args.slice(1),
        legacyCommand: 'docs-init',
        legacyArgs: args.slice(1),
        cwd,
        raw,
        error,
        output: core.output,
      });
      if (!handled) docs.cmdDocsInit(cwd, raw);
      break;
    }

    // ─── Learnings ─────────────────────────────────────────────────────────

    case 'learnings': {
      const subcommand = args[1];
      if (subcommand === 'list') {
        learnings.cmdLearningsList(raw);
      } else if (subcommand === 'query') {
        const tagIdx = args.indexOf('--tag');
        const tag = tagIdx !== -1 ? args[tagIdx + 1] : null;
        if (!tag) error('Usage: gsd-tools learnings query --tag <tag>', ERROR_REASON.USAGE);
        learnings.cmdLearningsQuery(tag, raw);
      } else if (subcommand === 'copy') {
        learnings.cmdLearningsCopy(cwd, raw);
      } else if (subcommand === 'prune') {
        const olderIdx = args.indexOf('--older-than');
        const olderThan = olderIdx !== -1 ? args[olderIdx + 1] : null;
        if (!olderThan) error('Usage: gsd-tools learnings prune --older-than <duration>', ERROR_REASON.USAGE);
        learnings.cmdLearningsPrune(olderThan, raw);
      } else if (subcommand === 'delete') {
        const id = args[2];
        if (!id) error('Usage: gsd-tools learnings delete <id>', ERROR_REASON.USAGE);
        learnings.cmdLearningsDelete(id, raw);
      } else {
        error('Unknown learnings subcommand. Available: list, query, copy, prune, delete', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    // ─── detect-custom-files ───────────────────────────────────────────────
    // CJS-native: no SDK counterpart exists in the command registry.
    // detect-custom-files reads a gsd-file-manifest.json against the
    // live filesystem to identify user-added files. It is installer-specific
    // logic that has no async query equivalent in the SDK.
    //
    // Detect user-added files inside GSD-managed directories that are not
    // tracked in gsd-file-manifest.json. Used by the update workflow to back
    // up custom files before the installer wipes those directories.
    //
    // This replaces the fragile bash pattern:
    //   MANIFEST_FILES=$(node -e "require('$RUNTIME_DIR/...')" 2>/dev/null)
    //   ${filepath#$RUNTIME_DIR/}   # unreliable path stripping
    // which silently returns CUSTOM_COUNT=0 when $RUNTIME_DIR is unset or
    // when the stripped path does not match the manifest key format (#1997).

    case 'detect-custom-files': {
      const configDirIdx = args.indexOf('--config-dir');
      const configDir = configDirIdx !== -1 ? args[configDirIdx + 1] : null;
      if (!configDir) {
        error('Usage: gsd-tools detect-custom-files --config-dir <path>', ERROR_REASON.USAGE);
      }
      const resolvedConfigDir = path.resolve(configDir);
      if (!fs.existsSync(resolvedConfigDir)) {
        error(`Config directory not found: ${resolvedConfigDir}`, ERROR_REASON.USAGE);
      }

      const manifestPath = path.join(resolvedConfigDir, 'gsd-file-manifest.json');
      if (!fs.existsSync(manifestPath)) {
        // No manifest — cannot determine what is custom. Return empty list
        // (same behaviour as saveLocalPatches in install.js when no manifest).
        const out = { custom_files: [], custom_count: 0, manifest_found: false };
        process.stdout.write(JSON.stringify(out, null, 2));
        break;
      }

      let manifest;
      try {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      } catch {
        const out = { custom_files: [], custom_count: 0, manifest_found: false, error: 'manifest parse error' };
        process.stdout.write(JSON.stringify(out, null, 2));
        break;
      }

      const manifestKeys = new Set(Object.keys(manifest.files || {}));

      // GSD-managed directories to scan for user-added files.
      // These are the directories the installer wipes on update.
      const GSD_MANAGED_DIRS = [
        'get-shit-done',
        'agents',
        path.join('commands', 'gsd'),
        'hooks',
        'skills',
      ];

      function collectCustomFiles(dir, baseDir, manifestKeys, out) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectCustomFiles(fullPath, baseDir, manifestKeys, out);
            continue;
          }
          // Use forward slashes for cross-platform manifest key compatibility
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          if (!manifestKeys.has(relPath)) {
            out.push(relPath);
          }
        }
      }

      const customFiles = [];
      for (const managedDir of GSD_MANAGED_DIRS) {
        const absDir = path.join(resolvedConfigDir, managedDir);
        if (!fs.existsSync(absDir)) continue;
        collectCustomFiles(absDir, resolvedConfigDir, manifestKeys, customFiles);
      }

      const out = {
        custom_files: customFiles,
        custom_count: customFiles.length,
        manifest_found: true,
        manifest_version: manifest.version || null,
      };
      process.stdout.write(JSON.stringify(out, null, 2));
      break;
    }

    // ─── GSD-2 Reverse Migration ───────────────────────────────────────────

    case 'from-gsd2': {
      const gsd2Import = require('./lib/gsd2-import.cjs');
      gsd2Import.cmdFromGsd2(args.slice(1), cwd, raw);
      break;
    }

    // ─── Prompt Budget ────────────────────────────────────────────────────
    //
    // Assemble and deterministically trim review prompt sections to fit a
    // token budget. Used by the /gsd-review workflow before dispatching to
    // small-context local model servers (Ollama, llama.cpp, LM Studio).
    //
    // Required flags:
    //   --budget <N>            Token budget (integer > 0)
    //   --instructions-file <path>  Review instructions
    //   --roadmap-file <path>   Roadmap section
    //   --plan-file <path>      Plan file (may be repeated)
    //   --output-prompt <path>  Write trimmed prompt here
    //   --output-metadata <path> Write metadata JSON here
    //
    // Optional flags:
    //   --safety-margin-pct <N>     Default 10
    //   --project-md-head-lines <N> Default 40
    //   --project-file <path>
    //   --context-file <path>
    //   --research-file <path>
    //   --requirements-file <path>
    //
    // Exit codes:
    //   0  success (trim or no-trim)
    //   1  invocation error (missing required arg, missing file, invalid budget)
    //   2  hardFailed: prompt cannot fit effective budget after trim policy

    case 'prompt-budget': {
      const promptBudget = require('./lib/prompt-budget.cjs');

      // ── Collect multi-value --plan-file flags ──────────────────────────
      const planFiles = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--plan-file' && args[i + 1] && !args[i + 1].startsWith('--')) {
          planFiles.push(args[i + 1]);
          i++;
        }
      }

      // ── Parse single-value flags ───────────────────────────────────────
      const flagMap = new Map();
      for (let i = 1; i < args.length; i++) {
        const current = args[i];
        const next = args[i + 1];
        if (!current.startsWith('--')) continue;
        if (!next || next.startsWith('--')) {
          if (!flagMap.has(current)) flagMap.set(current, null);
          continue;
        }
        if (!flagMap.has(current)) flagMap.set(current, next);
        i++;
      }
      const getFlag = (flag) => flagMap.get(flag) ?? null;

      const budgetStr = getFlag('--budget');
      const instructionsFile = getFlag('--instructions-file');
      const roadmapFile = getFlag('--roadmap-file');
      const outputPromptFile = getFlag('--output-prompt');
      const outputMetadataFile = getFlag('--output-metadata');
      const safetyMarginStr = getFlag('--safety-margin-pct');
      const projectMdHeadLinesStr = getFlag('--project-md-head-lines');
      const projectFile = getFlag('--project-file');
      const contextFile = getFlag('--context-file');
      const researchFile = getFlag('--research-file');
      const requirementsFile = getFlag('--requirements-file');

      // ── Validate required args ─────────────────────────────────────────
      if (!budgetStr) {
        process.stderr.write('Error: --budget <N> is required\n');
        process.exit(1);
      }
      const budget = parseInt(budgetStr, 10);
      if (!Number.isFinite(budget) || budget <= 0) {
        process.stderr.write('Error: --budget must be a positive integer\n');
        process.exit(1);
      }
      if (!instructionsFile) {
        process.stderr.write('Error: --instructions-file <path> is required\n');
        process.exit(1);
      }
      if (!roadmapFile) {
        process.stderr.write('Error: --roadmap-file <path> is required\n');
        process.exit(1);
      }
      if (planFiles.length === 0) {
        process.stderr.write('Error: at least one --plan-file <path> is required\n');
        process.exit(1);
      }
      if (!outputPromptFile) {
        process.stderr.write('Error: --output-prompt <path> is required\n');
        process.exit(1);
      }
      if (!outputMetadataFile) {
        process.stderr.write('Error: --output-metadata <path> is required\n');
        process.exit(1);
      }

      // ── Validate and read required files ──────────────────────────────
      async function readRequired(filePath, flagName) {
        const resolved = path.resolve(filePath);
        try {
          return await fs.promises.readFile(resolved, 'utf8');
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            process.stderr.write(`Error: file not found for ${flagName}: ${resolved}\n`);
            process.exit(1);
          }
          process.stderr.write(`Error: cannot read file for ${flagName}: ${resolved}\n`);
          process.exit(1);
        }
      }

      async function readOptional(filePath) {
        if (!filePath) return null;
        const resolved = path.resolve(filePath);
        try {
          return await fs.promises.readFile(resolved, 'utf8');
        } catch (err) {
          if (err && err.code === 'ENOENT') return null;
          process.stderr.write(`Error: cannot read optional file: ${resolved}\n`);
          process.exit(1);
        }
      }

      const instructions = await readRequired(instructionsFile, '--instructions-file');
      const roadmap = await readRequired(roadmapFile, '--roadmap-file');
      const plans = await Promise.all(planFiles.map(async (p) => {
        const resolved = path.resolve(p);
        try {
          const content = await fs.promises.readFile(resolved, 'utf8');
          return { file: path.basename(p), content };
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            process.stderr.write(`Error: plan file not found: ${resolved}\n`);
            process.exit(1);
          }
          process.stderr.write(`Error: cannot read plan file: ${resolved}\n`);
          process.exit(1);
        }
      }));

      const projectMd = await readOptional(projectFile);
      const context = await readOptional(contextFile);
      const research = await readOptional(researchFile);
      const requirements = await readOptional(requirementsFile);

      // ── Build options ─────────────────────────────────────────────────
      const options = {};
      if (safetyMarginStr !== null) {
        const pct = parseInt(safetyMarginStr, 10);
        if (Number.isFinite(pct)) options.safetyMarginPct = pct;
      }
      if (projectMdHeadLinesStr !== null) {
        const lines = parseInt(projectMdHeadLinesStr, 10);
        if (Number.isFinite(lines)) options.projectMdHeadLines = lines;
      }

      // ── Call applyBudget ──────────────────────────────────────────────
      const sections = { instructions, roadmap, plans, projectMd, context, research, requirements };
      const { prompt, metadata } = promptBudget.applyBudget({ sections, budget, options });

      // ── Write outputs ─────────────────────────────────────────────────
      await fs.promises.writeFile(path.resolve(outputMetadataFile), JSON.stringify(metadata, null, 2));
      await fs.promises.writeFile(path.resolve(outputPromptFile), prompt);

      if (metadata.hardFailed) {
        process.exit(2);
      }
      break;
    }

    default: {
      // #3243: if the caller passed a dotted form (e.g. "foo.bar"), the shim
      // above split it so `command` here is the head ("foo"). Use
      // originalCommand to reconstruct the original dotted form and suggest
      // the spaced equivalent — surfacing a useful diagnostic instead of just
      // "Unknown command: foo".
      const wasDotted =
        typeof originalCommand === 'string' &&
        originalCommand !== command &&
        originalCommand.includes('.');
      let suggestion = '';
      if (wasDotted) {
        const dotIdx = originalCommand.indexOf('.');
        const head = originalCommand.slice(0, dotIdx);
        const rest = originalCommand.slice(dotIdx + 1);
        suggestion = ` — did you mean: "${head} ${rest}"?`;
      }
      error(`Unknown command: ${command}${suggestion}`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
  }
}

main();
