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
 *   list-seeds [status]                List captured seeds (optional status filter)
 *   verify-path-exists <path>          Check file/directory existence
 *   quick-tasks-append --task <text>   Append a row to STATE.md's "Quick Tasks
 *                                      Completed" table (schema-backed via
 *                                      markdown-table.cjs; #2133/ADR-2143).
 *                                      Fails loud (non-zero exit) on a missing
 *                                      or unrecognized table instead of the old
 *                                      awk NF-2 silent-skip guess.
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
 *   roadmap validate                   Validate phase ID convention compliance
 *   roadmap upgrade [--apply] --convention milestone-prefixed  Migrate phase IDs to M-NN convention
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--no-archive-phases]          Skip moving phase dirs to milestones/vX.Y-phases/ (archived by default)
 *
 * User Story Validation:
 *   user-story validate --story "..."  Validate "As a / I want to / so that" format
 *                                      Returns JSON { valid, errors[], slots: {role,capability,outcome} | null }
 *                                      --pick valid  Emit bare boolean (for workflow boolean checks)
 *
 * Drift Guard (ADR-22):
 *   drift-guard authority                Resolve effective source-grounding authority
 *                                        (reads plan_review.source_grounding_authority + intel.enabled from config)
 *   drift-guard severity --status <S>    Classify a symbol verdict into { severity, hardBlock }
 *     [--authority <A>]                  Status: VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE
 *                                        Authority: grep|intel|treesitter|lsp|scip (default: config-resolved)
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
 *   uat classify-coverage --summary <path> Classify a SUMMARY coverage block into auto-passed vs human-UAT (#1602)
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
 *   intel api-surface               Render api-map.json into API-SURFACE.md
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
 * Loop Extension Point Queries (ADR-857 phase 3c):
 *   loop render-hooks <point>            Resolve + render active Capability hooks at a loop point
 *                                        [--config-dir <path>] [--runtime <r>] [--active-cap <capId>]
 *                                        Returns JSON envelope { point, activeHooks, rendered }
 *                                        Valid points: discuss:pre/post, plan:pre/post,
 *                                        execute:pre/wave:pre/wave:post/post, verify:pre/post, ship:pre/post
 *                                        --runtime: override the auto-detected runtime (#2003) so the config
 *                                                   dir resolves to that runtime's home even when
 *                                                   .planning/config.json persists a different runtime.
 *
 * Capability State (ADR-857 phase 4b):
 *   capability state [--config-dir <path>] [--runtime <r>]  Resolve per-capability install/surface/hook-activation state
 *                                           Returns JSON envelope { runtimeConfigDir, capabilities[] }
 *                                           --config-dir: runtime config dir (default: auto-detect current runtime)
 *                                           --runtime: override the auto-detected runtime (#2003); bypasses the
 *                                                      GSD_RUNTIME → config.runtime → 'claude' precedence so a
 *                                                      repo with a persisted runtime can still resolve another
 *                                                      runtime's config dir (e.g. driving Claude Code from a
 *                                                      repo that persists runtime:"codex").
 *
 * GSD-2 Migration:
 *   from-gsd2 [--path <dir>] [--force] [--dry-run]
 *             Import a GSD-2 (.gsd/) project back to GSD v1 (.planning/) format
 */

const fs = require('fs');
const path = require('path');

// #2002 — self-healing runtime build. The compiled ./lib/*.cjs modules this
// entrypoint require()s below are gitignored build artifacts (ADR-457), shipped
// prebuilt in the npm tarball. The Claude Code plugin-marketplace channel never
// runs `npm run build:lib` or bin/install.js, so on that path they can be
// absent and every command dies at module load. Compile them once (lock-guarded,
// idempotent, a no-op when already built) before the ./lib requires run.
const { ensureRuntimeBuild } = require('./ensure-runtime-build.cjs');
try {
  ensureRuntimeBuild();
} catch (bootErr) {
  process.stderr.write((bootErr && bootErr.message ? bootErr.message : String(bootErr)) + '\n');
  // Fatal bootstrap failure before the CLI's ExitError/runMain machinery (which
  // lives in ./lib) is available to load, so a direct exit is the only option.
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const io = require('./lib/io.cjs');
const { error, ERROR_REASON, setJsonErrorMode, output } = io;
const projectRoot = require('./lib/project-root.cjs');
// Resolve findProjectRoot lazily at call time rather than binding it at module
// load. It is sourced from project-root.cjs; a call-time lookup is robust
// against any require/load-ordering edge where the export isn't bound yet
// when this entrypoint is first required (#604).
const findProjectRoot = (...args) => projectRoot.findProjectRoot(...args);

// #1754: CLI skew detection — warn (stderr, non-blocking) if this gsd-tools.cjs
// is NOT the project-local install while a project-local install exists. Catches
// the shadowing scenario from #1748 (stale global canary shadowing project-local).
try {
  const _skew = require('./lib/cli-skew-check.cjs');
  const _skewRoot = findProjectRoot(process.cwd());
  if (_skewRoot) {
    const _skewLocal = path.join(_skewRoot, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs');
    const _skewWarn = _skew.checkCliSkew({
      resolvedPath: path.resolve(__filename),
      projectRoot: _skewRoot,
      projectLocalExists: fs.existsSync(_skewLocal),
    });
    if (_skewWarn) process.stderr.write(_skewWarn + '\n');
  }
} catch { /* advisory — never block */ }

const { getActiveWorkstream } = require('./lib/planning-workspace.cjs');
const { resolveActiveWorkstream, applyResolvedWorkstreamEnv } = require('./lib/active-workstream-store.cjs');
const state = require('./lib/state.cjs');
const phase = require('./lib/phase.cjs');
const roadmap = require('./lib/roadmap.cjs');
// #1561 — assumption-delta advisory checkpoint detector (pure function).
const { detectAssumptionDelta } = require('./lib/assumption-delta.cjs');
const verify = require('./lib/verify.cjs');
const config = require('./lib/config.cjs');
const template = require('./lib/template.cjs');
const milestone = require('./lib/milestone.cjs');
const commands = require('./lib/commands.cjs');
const init = require('./lib/init.cjs');
const frontmatter = require('./lib/frontmatter.cjs');
const workstream = require('./lib/workstream.cjs');
const docs = require('./lib/docs.cjs');
const learnings = require('./lib/learnings.cjs');
const gapChecker = require('./lib/gap-checker.cjs');
const { routeStateCommand } = require('./lib/state-command-router.cjs');
const { routeVerifyCommand } = require('./lib/verify-command-router.cjs');
const { routeEvalCommand } = require('./lib/eval-command-router.cjs');
const evalMod = require('./lib/eval.cjs');
const { routeVerificationCommand } = require('./lib/verification-command-router.cjs');
const verification = require('./lib/verification.cjs');
const { routeInitCommand } = require('./lib/init-command-router.cjs');
// Stale-bake guard (#1688): warns once when model config changed since agents
// were last baked on static-frontmatter runtimes (codex/opencode). Lazy-required
// here, invoked from case 'init' below.
const { warnIfStaleBake } = require('./lib/stale-bake-guard.cjs');
const loopResolver = require('./lib/loop-resolver.cjs');
const { routePhaseCommand } = require('./lib/phase-command-router.cjs');
const { routePhasesCommand } = require('./lib/phases-command-router.cjs');
const { routeValidateCommand } = require('./lib/validate-command-router.cjs');
const { routeRoadmapCommand } = require('./lib/roadmap-command-router.cjs');
const { routeCapabilityCommand } = require('./lib/capability-command-router.cjs');
const { routeAgentCommand } = require('./lib/agent-command-router.cjs');
const smartEntryMod = require('./lib/smart-entry.cjs');
const { routeCheckCommand } = require('./lib/check-command-router.cjs');
const { routeTaskCommand } = require('./lib/task-command-router.cjs');
const { parseNamedArgs, parseMultiwordArg } = require('./lib/command-arg-projection.cjs');
const { cmdGitBaseBranch } = require('./lib/git-base-branch.cjs');
const { getEffectiveAuthority, classifyDriftSeverity } = require('./lib/plan-drift-guard.cjs');

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
 * @param {Function} opts.output - output emitter (output)
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

// ─── ADR-959: Capability Command Dispatch ─────────────────────────────────────

/**
 * Dispatch a command via the capability registry's commandFamilies index.
 *
 * Consulted in the `default` case of `runCommand` BEFORE the unknown-command
 * error is emitted. Returns:
 *   true  — command was "consumed" (found in registry, or a dispatch error was
 *            emitted); "Unknown command" is suppressed in all consumed cases.
 *   false — command not found in the registry (including prototype-pollution
 *            guard hits and missing/empty commandFamilies); caller falls through
 *            to the existing unknown-command error path.
 * Behavior-preserving when commandFamilies is empty ({}).
 *
 * Injectable for tests:
 * - `registry` defaults to require('./lib/capability-registry.cjs')
 * - `requireModule` defaults to a confinement-checked loader that resolves the
 *   module path relative to bin/lib/ and asserts it stays within that directory
 *   before requiring — defense-in-depth against corrupted/hand-edited registry entries.
 *
 * @param {object}   opts
 * @param {string}   opts.command        The command name (top-level gsd-tools command)
 * @param {string[]} opts.args           Remaining args passed to the router
 * @param {string}   opts.cwd            Project working directory
 * @param {boolean}  opts.raw            Raw output mode flag
 * @param {Function} opts.error          Error reporter (io.error)
 * @param {object}   [opts.registry]     Injectable registry (for tests)
 * @param {Function} [opts.requireModule] Injectable module loader (for tests)
 * @returns {boolean} true if the command was dispatched, false otherwise
 */
function dispatchCapabilityCommand({ command, args, cwd, raw, error, registry, requireModule }) {
  // Prototype-pollution guard: reject reserved property names as command keys
  if (command === '__proto__' || command === 'constructor' || command === 'prototype') {
    return false;
  }

  // Resolve defaults (injectable for tests)
  const reg = registry !== undefined ? registry : require('./lib/capability-registry.cjs');

  // Default requireModule: confined to bin/lib/ — validate the module name is a
  // safe bare .cjs basename (no path separators, no directory traversal), then
  // resolve and assert confinement, then require the RESOLVED absolute path so
  // the checked representation and the required representation are identical.
  const libDir = path.join(__dirname, 'lib');
  const defaultRequireModule = function (m) {
    // Step 1: validate m is a bare .cjs basename — same conservative pattern the
    // generator uses. Rejects any value with path separators (/, \, ..) or
    // missing the .cjs extension before we even touch the filesystem.
    if (typeof m !== 'string' || !/^[A-Za-z0-9._-]+\.cjs$/.test(m)) {
      throw new Error('capability module must be a bare .cjs basename: ' + JSON.stringify(m));
    }
    // Step 2: confinement check — belt-and-suspenders even after the basename
    // validation above. Resolved path must be inside libDir (not equal to it,
    // and must start with libDir + sep so "libDir-suffix" can't sneak through).
    const resolved = path.resolve(libDir, m);
    if (resolved === libDir || !resolved.startsWith(libDir + path.sep)) {
      throw new Error('capability module path escapes bin/lib/: ' + JSON.stringify(m));
    }
    // Step 3: require the resolved absolute path — the SAME representation that
    // was checked above, not the concatenated './lib/' + m string.
    return require(resolved);
  };
  const loadModule = requireModule !== undefined ? requireModule : defaultRequireModule;

  // Look up the command family in the registry
  const families = reg && reg.commandFamilies;
  if (!families || typeof families !== 'object') return false;

  const entry = families[command];
  if (!entry || typeof entry !== 'object') return false;

  // Resolve and call the router
  let mod;
  try {
    mod = loadModule(entry.module);
  } catch (_) {
    // Module not found, load error, or confinement violation — surface a
    // diagnostic and return true (consumed) so "Unknown command" is suppressed.
    error('capability command "' + command + '" module "' + entry.module + '" failed to load');
    return true; // consumed — don't emit "Unknown command"
  }

  // Own-property guard: prevent invoking inherited prototype methods
  // (constructor, toString, hasOwnProperty, etc.) as a router when the registry
  // entry names one of those. Must come before the typeof check.
  if (!mod || !Object.prototype.hasOwnProperty.call(mod, entry.router)) {
    error('capability command "' + command + '" router "' + entry.router + '" is not an own export of module "' + entry.module + '"');
    return true; // consumed — don't emit "Unknown command"
  }
  const fn = mod[entry.router];
  if (typeof fn !== 'function') {
    // Router export not found — surface a diagnostic and return true (consumed)
    // so "Unknown command" is suppressed.
    error('capability command "' + command + '" router "' + entry.router + '" is not a function in module "' + entry.module + '"');
    return true; // consumed — don't emit "Unknown command"
  }

  let _result;
  try {
    _result = fn({ args, cwd, raw, error });
  } catch (e) {
    if (e instanceof ExitError) throw e; // intentional structured error from the router (honors --json-errors) — propagate untouched
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" threw: ' + (e && e.message ? e.message : String(e)),
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  if (_result && typeof _result.then === 'function') {
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" must be synchronous (returned a Promise); async capability routers are not supported.',
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  return true;
}

/**
 * Require a THIRD-PARTY capability's router module from its install root, confined to that root.
 * The module name must be a bare `.cjs` basename (same conservative pattern the generator enforces).
 * The install root is realpath-resolved (defeating symlinked path components) and the resolved
 * module must live strictly inside it; the module file is then realpath-checked so a symlinked file
 * cannot escape the root either. ADR-1244 Phase 5 (D7).
 *
 * @param {string} installRoot Absolute install-root dir of the owning capability
 * @param {string} m           Bare `.cjs` module basename from the capability manifest
 * @returns {*} the required module
 */
function defaultRequireFromInstallRoot(installRoot, m) {
  if (typeof m !== 'string' || !/^[A-Za-z0-9._-]+\.cjs$/.test(m)) {
    throw new Error('capability module must be a bare .cjs basename: ' + JSON.stringify(m));
  }
  // Realpath the root so a symlinked ancestor can't widen confinement.
  const realRoot = fs.realpathSync(installRoot);
  const resolved = path.resolve(realRoot, m);
  if (resolved === realRoot || !resolved.startsWith(realRoot + path.sep)) {
    throw new Error('capability module path escapes its install root: ' + JSON.stringify(m));
  }
  // The module file itself must not be a symlink pointing outside the root.
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    throw new Error('capability module resolves outside its install root (symlink): ' + JSON.stringify(m));
  }
  return require(realResolved);
}

/**
 * Dispatch a THIRD-PARTY (installed overlay) capability command family — ADR-1244 Phase 5 (D7).
 * This is where third-party code executes, so it is doubly gated:
 *   - CONSENT: `loadRegistry({ includeInstalled })` excludes `_pending` (unconsented) capabilities,
 *     and only third-party caps that declared `commands` appear in `_overlay.commandRoots`. A capId
 *     absent from `commandRoots` is first-party (handled by dispatchCapabilityCommand) or not an
 *     installed overlay — we fall through.
 *   - CONFINEMENT: the router module is `require()`'d FROM the capability's install root, confined to
 *     that root (basename validation + realpath containment), so a manifest can never reach code
 *     outside its own bundle.
 * Returns true when consumed (suppress "Unknown command"), false to fall through.
 *
 * @param {object} opts
 * @param {Function} [opts.loadRegistry]  Injectable overlay loader (for tests)
 * @param {Function} [opts.requireModule] Injectable (installRoot, module) loader (for tests)
 */
function dispatchOverlayCapabilityCommand({ command, args, cwd, raw, error, loadRegistry, requireModule }) {
  if (command === '__proto__' || command === 'constructor' || command === 'prototype') {
    return false;
  }

  let reg;
  try {
    const load = loadRegistry !== undefined ? loadRegistry : require('./lib/capability-loader.cjs').loadRegistry;
    reg = load({ includeInstalled: true, cwd });
  } catch (_) {
    return false; // overlay load failed — fall through to "Unknown command"
  }

  const families = reg && reg.commandFamilies;
  const commandRoots = reg && reg._overlay && reg._overlay.commandRoots;
  if (!families || typeof families !== 'object' || !commandRoots || typeof commandRoots !== 'object') {
    return false; // no installed overlay command families
  }

  const entry = families[command];
  if (!entry || typeof entry !== 'object') return false;

  // Only THIRD-PARTY overlay caps are dispatched here. A capId present in commandRoots is an
  // accepted, committed (consented) overlay cap; a capId absent is first-party or not an overlay.
  const capId = entry.capId;
  if (typeof capId !== 'string' || !Object.prototype.hasOwnProperty.call(commandRoots, capId)) {
    return false;
  }
  const installRoot = commandRoots[capId];
  if (typeof installRoot !== 'string' || !installRoot) return false;

  const loadModule = requireModule !== undefined ? requireModule : defaultRequireFromInstallRoot;
  let mod;
  try {
    mod = loadModule(installRoot, entry.module);
  } catch (_) {
    error('capability command "' + command + '" module "' + entry.module + '" failed to load from its install root');
    return true; // consumed — don't emit "Unknown command"
  }

  if (!mod || !Object.prototype.hasOwnProperty.call(mod, entry.router)) {
    error('capability command "' + command + '" router "' + entry.router + '" is not an own export of module "' + entry.module + '"');
    return true;
  }
  const fn = mod[entry.router];
  if (typeof fn !== 'function') {
    error('capability command "' + command + '" router "' + entry.router + '" is not a function in module "' + entry.module + '"');
    return true;
  }

  let _result;
  try {
    _result = fn({ args, cwd, raw, error });
  } catch (e) {
    if (e instanceof ExitError) throw e;
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" threw: ' + (e && e.message ? e.message : String(e)),
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  if (_result && typeof _result.then === 'function') {
    error(
      'capability command "' + command + '" router "' + entry.router + '" in module "' + entry.module + '" must be synchronous (returned a Promise); async capability routers are not supported.',
      ERROR_REASON.SDK_FAIL_FAST,
    );
  }
  return true;
}

// ─── ADR-2346 (epic #2345): host dispatch table ───────────────────────────────
// Layer-2 of the two-layer dispatch. Core, non-capability host commands live
// here — NOT in the capability registry (ADR-959's commandFamilies is reserved
// for toggleable feature capabilities: graphify/audit/intel). A host command
// like `state` is core, non-toggleable, carries no tier/activationKey, so it
// cannot be a capability. Each entry maps a top-level command to its standard
// `route*Command` router (the same routers the hardcoded `case` arms called).
// Consulted in runCommand's `default` case, after capability + overlay
// dispatch, before the unknown-command error. A migrated command's `case` arm
// is removed at cutover so it reaches here; an unmigrated command still hits
  // its `case` (collision structurally impossible, same property as ADR-959).

  // ─── ADR-2346 P3: resolve/git/config/research host routers ────────────────
  // Each body was relocated VERBATIM from its `case` arm (cutover: the arm is
  // removed so dispatch reaches HOST_COMMAND_ROUTERS). Closures over module-
  // scope libs (commands/config/output/error/_dispatchNonFamily) are preserved;
  // only per-dispatch values (args/cwd/raw/defaultValue/workstreamContext)
  // arrive via the destructured context.

  function routeResolveModel({ args, cwd, raw }) {
    commands.cmdResolveModel(cwd, args[1], raw);
  }

  function routeResolveGranularity({ args, cwd, raw }) {
    const granArgs = args.slice(1);
    let granOverride;
    const granPositionals = [];
    for (let i = 0; i < granArgs.length; i++) {
      const a = granArgs[i];
      if (a === '--granularity' && granArgs[i + 1] !== undefined && !granArgs[i + 1].startsWith('--')) {
        if (granOverride === undefined) { granOverride = granArgs[++i]; } else { ++i; }
      } else {
        granPositionals.push(a);
      }
    }
    commands.cmdResolveGranularity(cwd, granPositionals[0], raw, granOverride);
  }

  function routeResolveExecution({ args, cwd, raw }) {
    const execArgs = args.slice(1);
    let effortOverride;
    let fastModeOverride;
    let attempt;
    const positionals = [];
    for (let i = 0; i < execArgs.length; i++) {
      const a = execArgs[i];
      if (a.startsWith('--effort=')) {
        effortOverride = a.slice('--effort='.length);
        continue;
      }
      if (a.startsWith('--fast-mode=')) {
        const v = a.slice('--fast-mode='.length);
        fastModeOverride = v === 'true' ? true : v === 'false' ? false : undefined;
        continue;
      }
      if (a.startsWith('--attempt=')) {
        const v = a.slice('--attempt='.length);
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
        attempt = n;
        continue;
      }
      if (a === '--effort') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --effort', ERROR_REASON.USAGE);
        effortOverride = val;
        i++;
        continue;
      }
      if (a === '--fast-mode') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --fast-mode', ERROR_REASON.USAGE);
        fastModeOverride = val === 'true' ? true : val === 'false' ? false : undefined;
        i++;
        continue;
      }
      if (a === '--attempt') {
        const val = execArgs[i + 1];
        if (val === undefined || val.startsWith('--')) error('Missing value for --attempt', ERROR_REASON.USAGE);
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 0) error('--attempt requires a non-negative integer', ERROR_REASON.USAGE);
        attempt = n;
        i++;
        continue;
      }
      if (a === '--raw') continue;
      if (a.startsWith('-')) error(`Unknown flag for resolve-execution: ${a}`, ERROR_REASON.USAGE);
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
  }

  function routeGit({ args, cwd }) {
    const subcommand = args[1];
    if (subcommand !== 'base-branch') {
      error(
        `Unknown git subcommand: ${subcommand || '(none)'}. Available: base-branch`,
        ERROR_REASON.SDK_UNKNOWN_COMMAND,
      );
      return;
    }
    cmdGitBaseBranch(cwd, args.slice(2));
  }

  function routeConfigEnsureSection({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-ensure-section',
      registryArgs: args.slice(1),
      legacyCommand: 'config-ensure-section',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigEnsureSection(cwd, raw);
  }

  function routeConfigSet({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-set',
      registryArgs: args.slice(1),
      legacyCommand: 'config-set',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigSet(cwd, args[1], args[2], raw);
  }

  function routeConfigSetModelProfile({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-set-model-profile',
      registryArgs: args.slice(1),
      legacyCommand: 'config-set-model-profile',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigSetModelProfile(cwd, args[1], raw);
  }

  function routeConfigGet({ args, cwd, raw, defaultValue }) {
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
      output: output,
    });
    if (!handled) config.cmdConfigGet(cwd, args[1], raw, defaultValue);
  }

  function routeConfigNewProject({ args, cwd, raw }) {
    const handled = _dispatchNonFamily({
      registryCommand: 'config-new-project',
      registryArgs: args.slice(1),
      legacyCommand: 'config-new-project',
      legacyArgs: args.slice(1),
      cwd,
      raw,
      error,
      output: output,
    });
    if (!handled) config.cmdConfigNewProject(cwd, args[1], raw);
  }

  function routeConfigPath({ cwd, raw, workstreamContext }) {
    config.cmdConfigPath(cwd, raw, workstreamContext);
  }

  async function routeMigrateConfig({ cwd, raw }) {
    await config.cmdMigrateConfig(cwd, raw);
  }

  function routeResearchStore({ args, cwd, raw }) {
    const researchStore = require('./lib/research-store.cjs');
    const subcommand = args[1];
    const homeDir = process.env.HOME || require('os').homedir();
    if (subcommand === 'get') {
      const key = args[2];
      if (!key || key.startsWith('--')) {
        error('Usage: gsd-tools research-store get <key> [--kind <k>]', ERROR_REASON.USAGE);
      }
      if (!researchStore.isValidResearchKey(key)) {
        error('research-store: <key> must be a 64-char sha256 hex (use research-plan to obtain keys)', ERROR_REASON.USAGE);
      }
      const result = researchStore.getResearch(cwd, key, { homeDir });
      output(result, raw);
    } else if (subcommand === 'put') {
      const key = args[2];
      if (!key || key.startsWith('--')) {
        error('Usage: gsd-tools research-store put <key> --content <str> --source <s> --provider <p> --confidence <c> --kind <k>', ERROR_REASON.USAGE);
      }
      if (!researchStore.isValidResearchKey(key)) {
        error('research-store: <key> must be a 64-char sha256 hex (use research-plan to obtain keys)', ERROR_REASON.USAGE);
      }
      const contentIdx = args.indexOf('--content');
      const sourceIdx = args.indexOf('--source');
      const providerIdx = args.indexOf('--provider');
      const confidenceIdx = args.indexOf('--confidence');
      const kindIdx = args.indexOf('--kind');
      function getFlagValue(idx, flagName) {
        if (idx === -1) return null;
        const val = args[idx + 1];
        if (val === undefined || val.startsWith('--')) {
          error(`research-store put: missing value for ${flagName}`, ERROR_REASON.USAGE);
        }
        return val;
      }
      const content = getFlagValue(contentIdx, '--content');
      const source = getFlagValue(sourceIdx, '--source');
      const provider = getFlagValue(providerIdx, '--provider');
      const confidence = getFlagValue(confidenceIdx, '--confidence');
      const kind = getFlagValue(kindIdx, '--kind');
      if (!content || !source || !provider || !confidence || !kind) {
        error('Usage: gsd-tools research-store put <key> --content <str> --source <s> --provider <p> --confidence <c> --kind <k>', ERROR_REASON.USAGE);
      }
      const entry = researchStore.putResearch(cwd, key, { content, source, provider, confidence, kind }, { homeDir });
      output(entry, raw);
    } else {
      error('Unknown research-store subcommand. Available: get, put', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
  }

  function routeResearchPlan({ args, cwd, raw }) {
    const researchProvider = require('./lib/research-provider.cjs');
    const inputIdx = args.indexOf('--input');
    const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : null;
    if (!inputPath || inputPath.startsWith('--')) {
      error('Usage: gsd-tools research-plan --input <path>', ERROR_REASON.USAGE);
    }
    let planInput;
    try {
      const raw_ = fs.readFileSync(path.resolve(inputPath), 'utf8');
      planInput = JSON.parse(raw_);
    } catch (readErr) {
      error(`research-plan: cannot read/parse --input file: ${inputPath}`, ERROR_REASON.USAGE);
    }
    if (planInput === null || typeof planInput !== 'object' || Array.isArray(planInput)) {
      error('research-plan: --input must be an object with a questions array', ERROR_REASON.USAGE);
    }
    if (!Array.isArray(planInput.questions)) {
      error('research-plan: --input must be an object with a questions array', ERROR_REASON.USAGE);
    }
    const { ecosystem = '', config: planConfig = {}, questions } = planInput;
    const homeDir = process.env.HOME || require('os').homedir();
    const plan = researchProvider.planResearch({ questions, ecosystem, config: planConfig, cwd, homeDir });
    output(plan, raw);
  }

const HOST_COMMAND_ROUTERS = {
  // Each entry wraps its `route*Command` router so it receives the module-scope
  // lib the old `case` arm passed, plus the per-dispatch context
  // { args, cwd, raw, error }. Closes over module-scope libs (state/phase/…)
  // exactly as the old inline arms did — byte-identical dispatch.
  state: (ctx) => routeStateCommand({ state, ...ctx }),
  phase: (ctx) => routePhaseCommand({ phase, ...ctx }),
  roadmap: (ctx) => routeRoadmapCommand({ roadmap, ...ctx }),
  verify: (ctx) => routeVerifyCommand({ verify, ...ctx }),
  // validate additionally binds the module-scope `output` emitter.
  validate: (ctx) => routeValidateCommand({ verify, output, ...ctx }),
  // init preserves the #1688 stale-bake warning (best-effort, swallowed) that
  // ran before the router in the old `case 'init':` arm.
  init: (ctx) => {
    try { warnIfStaleBake(ctx.cwd); } catch { /* guard must never break init */ }
    routeInitCommand({ init, ...ctx });
  },
  // capability → routeCapabilityCommand (ADR-2346 P2). The router is async
  // (install/upgrade/consent ops await the lifecycle); dispatchHostCommand
  // awaits it. The router imports its own io/cli-exit/deps, so no module
  // injection needed — it receives {args,cwd,raw} (+error, ignored).
  capability: routeCapabilityCommand,
  // ADR-2346 P3: resolve/git/config/research host routers. Each body was
  // relocated verbatim from its `case` arm to a module-scope function above.
  'resolve-model': routeResolveModel,
  'resolve-granularity': routeResolveGranularity,
  'resolve-execution': routeResolveExecution,
  git: routeGit,
  'config-ensure-section': routeConfigEnsureSection,
  'config-set': routeConfigSet,
  'config-set-model-profile': routeConfigSetModelProfile,
  'config-get': routeConfigGet,
  'config-new-project': routeConfigNewProject,
  'config-path': routeConfigPath,
  'migrate-config': routeMigrateConfig,
  'research-store': routeResearchStore,
  'research-plan': routeResearchPlan,
};

// Returns true when consumed (suppress "Unknown command"), false to fall
// through. Prototype-pollution-safe: own-property lookup rejects
// `__proto__`/`constructor`/`prototype` command keys (same guard as
// dispatchCapabilityCommand).
async function dispatchHostCommand({ command, args, cwd, raw, error, defaultValue, workstreamContext }) {
  if (
    command === '__proto__' ||
    command === 'constructor' ||
    command === 'prototype'
  ) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, command)) {
    return false;
  }
  const router = HOST_COMMAND_ROUTERS[command];
  if (typeof router !== 'function') return false;
  // `await` so async host routers (e.g. capability's install/upgrade ops)
  // complete before runCommand returns; sync routers pass through unchanged.
  await router({ args, cwd, raw, error, defaultValue, workstreamContext });
  return true; // consumed — don't emit "Unknown command"
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
    setJsonErrorMode(true);
    args.splice(jsonErrorsIdx, 1);
  } else if (process.env.GSD_JSON_ERRORS === '1') {
    setJsonErrorMode(true);
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
  const { resolveWorktreeRoot } = require('./lib/worktree-safety.cjs');
  if (!fs.existsSync(path.join(cwd, '.planning'))) {
    const worktreeRoot = resolveWorktreeRoot(cwd);
    if (worktreeRoot !== cwd) {
      cwd = worktreeRoot;
    }
  }

  // Optional workstream override for parallel milestone work.
  // Priority: --ws flag > GSD_WORKSTREAM env var > session/shared pointer > null.
  let workstreamContext = null;
  try {
    workstreamContext = resolveActiveWorkstream(cwd, args, process.env, {
      getStored: getActiveWorkstream,
    });
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
    'Commands: agent, agent-skills, assumption-delta, audit-open, audit-uat, check, check-commit, commit, commit-to-subrepo, pr-subrepo, ' +
    'config-ensure-section, config-get, config-new-project, config-path, config-set, migrate-config, normalize-test-command, ' +
    'current-timestamp, detect-custom-files, docs-init, drift-guard, effort, extract-messages, find-phase, ' +
    'from-gsd2, frontmatter, gap-analysis, generate-claude-md, generate-claude-profile, ' +
    'generate-dev-preferences, generate-slug, graphify, history-digest, init, intel, ' +
    'capability, classify-confidence, git, learnings, list-seeds, list-todos, loop, milestone, package-legitimacy, phase, phase-plan-index, phases, profile-questionnaire, ' +
    'profile-sample, progress, project-instruction-file, prompt-budget, quick-tasks-append, requirements, research-plan, research-store, resolve-granularity, resolve-model, roadmap, scaffold, smart-entry, state, ' +
    'task, template, user-story, validate, verify, verify-path-exists, verify-summary, eval, workstream, worktree\n\n' +
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
  // 'loop' and 'capability' are intentionally NOT in SKIP_ROOT_RESOLUTION.
  // Both are registry/config queries that resolve activation via
  // .planning/config.json; they need the project root (cwd) for correct
  // `when` key resolution. If one is ever moved to SKIP_ROOT_RESOLUTION,
  // move the other at the same time (keep them consistent).
  const SKIP_ROOT_RESOLUTION = new Set([
    'generate-slug', 'current-timestamp', 'verify-path-exists',
    'verify-summary', 'template', 'frontmatter', 'detect-custom-files',
    'worktree', 'prompt-budget',
    'research-store', 'research-plan', 'package-legitimacy', 'classify-confidence',
    'user-story', // pure string validation — no .planning/ access needed
    // #1529: pure runtime→filename projection via getProjectInstructionFile; no
    // .planning/ access needed, and resolving project root would break workflow
    // invocations that run before .planning/ exists (new-project Step 1).
    'project-instruction-file',
    // #1579: eval.score is pure arithmetic (covered/total + infra weights); it
    // needs no .planning/ access, so skip the findProjectRoot traversal.
    'eval',
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
  // io.cjs output() writes @file:<path> when JSON > 50KB. The --pick path
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
      // The wrapped command may have written to stdout BEFORE it threw — e.g. a --raw
      // command that emits a JSON result/error envelope and THEN throws ExitError to set a
      // non-zero exit code (capability set/disable on an unknown id). Without this flush that
      // captured output is silently discarded (the success-path flush at the call site never
      // runs on a throw). Emit it now; the error still propagates so the exit code is preserved.
      if (captured) {
        try { originalWriteSync.call(fs, 1, resolveAtFileOutput(captured)); } catch { /* best-effort flush */ }
      }
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

    case 'smart-entry': {
      smartEntryMod.runSmartEntry(cwd, args, raw);
      break;
    }

    case 'check': {
      routeCheckCommand({ args, cwd, raw });
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
        output: output,
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

    case 'pr-subrepo': {
      const message = args[1];
      const { repo, branch } = parseNamedArgs(args, ['repo', 'branch']);
      commands.cmdPrSubrepo(cwd, repo, branch, message, raw);
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
          output: output,
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

    case 'eval': {
      routeEvalCommand({ evalMod, args, cwd, raw, error });
      break;
    }

    // ─── Verification Status ───────────────────────────────────────────────
    //
    // verification status <phaseDir>
    //   Read the first *-VERIFICATION.md in phaseDir and return
    //   { status, next_action, next_command } routing result.
    //
    // Note: `verification` (reads verifier-emitted status) is distinct from
    // `verify` (runs verification checks like plan-structure/artifacts).

    case 'verification': {
      routeVerificationCommand({
        verification,
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
        output: output,
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

    case 'project-instruction-file': {
      // #1529: pure runtime→filename projection. Backs the
      // `gsd_run query project-instruction-file --runtime <r>` call in
      // new-project.md so the bash workflow and profile-output.cjs share one
      // source of truth (getProjectInstructionFile in runtime-name-policy.cjs).
      // No SDK bridge — pure local lookup, runs before .planning/ exists.
      const { getProjectInstructionFile } = require('./lib/runtime-name-policy.cjs');
      // Parse --runtime <value> (space or = form); default to empty so the
      // safe AGENTS.md cross-agent default applies.
      const pifArgs = args.slice(1);
      let pifRuntime = '';
      for (let i = 0; i < pifArgs.length; i++) {
        const a = pifArgs[i];
        if (a === '--runtime' && pifArgs[i + 1] !== undefined) { pifRuntime = pifArgs[++i]; continue; }
        if (a.startsWith('--runtime=')) { pifRuntime = a.slice('--runtime='.length); continue; }
        // First positional that isn't a flag also works (lenient); otherwise ignore unknown flags.
        if (!a.startsWith('-') && !pifRuntime) { pifRuntime = a; }
      }
      const filename = getProjectInstructionFile(pifRuntime);
      process.stdout.write(filename + '\n');
      break;
    }

    case 'list-todos': {
      commands.cmdListTodos(cwd, args[1], raw);
      break;
    }

    case 'list-seeds': {
      commands.cmdListSeeds(cwd, args[1], raw);
      break;
    }

    case 'verify-path-exists': {
      commands.cmdVerifyPathExists(cwd, args[1], raw);
      break;
    }

    case 'quick-tasks-append': {
      // #2133 / ADR-2143 §3,§7: schema-backed replacement for fast.md's inline
      // `awk NF-2` Quick Tasks column arithmetic. Row construction is delegated
      // to the pure appendQuickTaskRow (markdown-table.cjs); this case only
      // handles the I/O (read STATE.md, resolve date/commit, write STATE.md).
      const qtaArgs = args.slice(1);
      const qtaTask = parseNamedArgs(qtaArgs, ['task']).task || args[1];
      if (!qtaTask) {
        error('quick-tasks-append requires --task <description> (or a positional description)', ERROR_REASON.USAGE);
      }

      const statePath = path.join(cwd, '.planning', 'STATE.md');
      if (!fs.existsSync(statePath)) {
        error(`quick-tasks-append: STATE.md not found at ${statePath}`, ERROR_REASON.USAGE);
      }

      const date = new Date().toISOString().slice(0, 10);
      const { execGit } = require('./lib/shell-command-projection.cjs');
      const hashResult = execGit(['rev-parse', '--short', 'HEAD'], { cwd });
      const commit = hashResult.exitCode === 0 && hashResult.stdout ? hashResult.stdout : '—';

      const { appendQuickTaskRow } = require('./lib/markdown-table.cjs');

      // #2242 review fix: route the read -> mutate -> write cycle through
      // state.readModifyWriteStateMd (lib/state.cjs) instead of a raw
      // fs.readFileSync + fs.writeFileSync pair, so the whole read-modify-write
      // is atomic under STATE.md's lockfile — closing the lost-update race a
      // raw read/write pair left open (cf. #500/#905/#1230). This mirrors the
      // pattern every other STATE.md-mutating case in state.cts uses (e.g.
      // cmdStateAddBlocker, cmdStateAddDecision): a mutable outer variable
      // captures the pure helper's side output, and a fail-loud reason throws
      // ExitError from INSIDE the transform (readModifyWriteStateMd's finally
      // still releases the lock before the throw propagates; the transform
      // throws before returning new content, so nothing is ever written).
      let mutation;
      state.readModifyWriteStateMd(statePath, (content) => {
        const result = appendQuickTaskRow(content, { description: qtaTask, date, commit });
        if (!result.ok) {
          // Mirrors fast.md's old "skip with a brief log" behaviour (#2133): this
          // is an expected, recoverable condition (no table / unrecognized
          // schema), not a hard crash. ExitError sets a non-zero exit code (so
          // fast.md's `|| echo ...` fallback fires) without calling
          // process.exit() directly — stdout stays flushed and untouched.
          throw new ExitError(1, `⚠ quick-tasks-append: ${result.reason}`);
        }
        mutation = result.value;
        return result.value.content;
      }, cwd);

      output({ ok: true, row: mutation.row, variant: mutation.variant }, raw, mutation.row);
      break;
    }









    case 'normalize-test-command': {
      // #1857: rewrite a resolved test command to a one-shot form so a
      // watch-mode runner (vitest/jest) cannot hang a verification gate. Shared
      // by the regression gate and the post-merge gate. args[1] is the raw
      // resolved command; --cwd (already parsed into `cwd`) locates package.json.
      const testCommandNormalizer = require('./lib/normalize-test-command.cjs');
      testCommandNormalizer.cmdNormalizeTestCommand(cwd, args[1]);
      break;
    }

    case 'dispatch-should-flatten': {
      // #1708 / #853: typed query replacing the `RUNTIME === 'codex'` prose rule.
      //
      // Resolves the current runtime (GSD_RUNTIME > config.runtime > 'claude'),
      // looks up registry.runtimes[id].runtime.hostIntegration.dispatch, and
      // calls shouldFlattenDispatch(dispatch) from host-integration.cjs.
      //
      // Fail-closed: any unknown runtime, missing dispatch, or thrown error
      // yields `true` (inline — the always-safe default).
      //
      // Output:
      //   --raw   → prints exactly `true` or `false`
      //   --json  → prints { runtime, shouldFlatten, dispatch }
      //   default → same as --raw
      try {
        // Resolve runtime using the same precedence as `config-get runtime`.
        const { resolveRuntime } = require('./lib/runtime-slash.cjs');
        const runtimeId = resolveRuntime(cwd);

        // Look up dispatch from the capability registry.
        const registry = require('./lib/capability-registry.cjs');
        const runtimeEntry = registry.runtimes != null
          ? registry.runtimes[runtimeId]
          : null;
        const dispatch = runtimeEntry?.runtime?.hostIntegration?.dispatch ?? null;

        // Call shouldFlattenDispatch from host-integration.cjs.
        const hostIntegration = require('./lib/host-integration.cjs');
        const shouldFlat = dispatch !== null
          ? hostIntegration.shouldFlattenDispatch(dispatch)
          : true; // fail-closed: unknown runtime → inline

        const jsonIdx = args.indexOf('--json');
        if (jsonIdx !== -1) {
          output({
            runtime: runtimeId,
            shouldFlatten: shouldFlat,
            dispatch: dispatch,
          }, raw);
        } else {
          // --raw or default: print exactly true or false
          process.stdout.write(shouldFlat ? 'true' : 'false');
        }
      } catch {
        // Fail-closed on any error: inline is always safe.
        process.stdout.write('true');
      }
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

    case 'assumption-delta': {
      // #1561 — advisory architecture checkpoint. `scan <phase>` reads the
      // phase section via the same resolver as roadmap.get-phase and runs the
      // deterministic detectAssumptionDelta, emitting the typed IR as JSON.
      const sub = args[1];
      if (sub === 'scan') {
        const phaseNum = args[2];
        // Reject missing or flag-shaped phase values (QA matrix: values that
        // look like flags). `scan --json` must not treat "--json" as a phase.
        if (!phaseNum || phaseNum.startsWith('-')) {
          error('Usage: assumption-delta scan <phase> [--terms <csv>]', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          break;
        }
        // Optional --terms <csv> override (replaces the pluralization cues;
        // optional/chosen keep defaults). An EMPTY value ("") or a flag-shaped
        // value restores the curated defaults (does NOT disable pluralization).
        // Terms are normalized (deduped, alphanumeric-only, capped) by
        // detectAssumptionDelta's resolveTerms.
        let termsOverride;
        const termsIdx = args.indexOf('--terms');
        const termsVal = termsIdx !== -1 ? args[termsIdx + 1] : undefined;
        if (typeof termsVal === 'string' && !termsVal.startsWith('-')) {
          const list = termsVal
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0);
          termsOverride = list.length > 0 ? { pluralization: list } : undefined;
        }
        const section = roadmap.getRoadmapPhaseWithFallback(cwd, phaseNum);
        const result = detectAssumptionDelta(section ?? '', termsOverride);
        output(result, raw);
        break;
      }
      error(`Unknown assumption-delta subcommand: ${sub}. Available: scan`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
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

    case 'milestone': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        const milestoneName = parseMultiwordArg(args, 'name');
        // #1871: archive phase dirs by default on milestone complete so the next
        // new-milestone never inherits un-archived dirs. --no-archive-phases opts out.
        const archivePhases = !args.includes('--no-archive-phases');
        const force = args.includes('--force');
        // #2118: --dry-run prints a preview plan without mutating.
        const dryRun = args.includes('--dry-run');
        milestone.cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases, force, dryRun }, raw);
      } else {
        error('Unknown milestone subcommand. Available: complete', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      commands.cmdProgressRender(cwd, subcommand, raw);
      break;
    }

    case 'uat': {
      const subcommand = args[1];
      if (subcommand === 'render-checkpoint') {
        const uat = require('./lib/uat.cjs');
        const options = parseNamedArgs(args, ['file']);
        uat.cmdRenderCheckpoint(cwd, options, raw);
      } else if (subcommand === 'classify-coverage') {
        const coverage = require('./lib/coverage.cjs');
        const options = parseNamedArgs(args, ['summary', 'file']);
        coverage.cmdClassify(cwd, options, raw);
      } else {
        error('Unknown uat subcommand. Available: render-checkpoint, classify-coverage', ERROR_REASON.SDK_UNKNOWN_COMMAND);
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

    case 'loop': {
      // loop render-hooks <point>
      const loopSubcommand = args[1];
      if (loopSubcommand === 'render-hooks') {
        let loopConfigDir = null;
        const configDirEqArg = args.find(arg => arg.startsWith('--config-dir='));
        const configDirIdx = args.indexOf('--config-dir');
        if (configDirEqArg) {
          const value = configDirEqArg.slice('--config-dir='.length).trim();
          if (!value) error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          loopConfigDir = value;
        } else if (configDirIdx !== -1) {
          const value = args[configDirIdx + 1];
          if (!value || value.startsWith('--')) {
            error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          }
          loopConfigDir = value;
        }
        // --active-cap <capId>: parse and validate before delegating
        let loopActiveCap = undefined;
        const activeCapEqArg = args.find(arg => arg.startsWith('--active-cap='));
        const activeCapIdx = args.indexOf('--active-cap');
        if (activeCapEqArg) {
          const value = activeCapEqArg.slice('--active-cap='.length).trim();
          if (!value) error('Missing value for --active-cap (e.g. --active-cap tdd)', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          loopActiveCap = value;
        } else if (activeCapIdx !== -1) {
          const value = args[activeCapIdx + 1];
          if (!value || value.startsWith('--')) {
            error('Missing value for --active-cap (e.g. --active-cap tdd)', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          }
          loopActiveCap = value;
        }
        // --runtime <r> (#2003): explicit runtime override so the config-dir
        // resolution bypasses the persisted-runtime fallback (GSD_RUNTIME →
        // config.runtime). Mirrors the --config-dir dual-form (--runtime X /
        // --runtime=X) and the capability-set --runtime precedent.
        let loopRuntime = undefined;
        const runtimeEqArg = args.find(arg => arg.startsWith('--runtime='));
        const runtimeIdx = args.indexOf('--runtime');
        if (runtimeEqArg) {
          const value = runtimeEqArg.slice('--runtime='.length).trim();
          if (!value) error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          loopRuntime = value;
        } else if (runtimeIdx !== -1) {
          const value = args[runtimeIdx + 1];
          if (!value || value.startsWith('--')) {
            error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
          }
          loopRuntime = value;
        }
        loopResolver.cmdLoopRenderHooks(cwd, args[2], raw, {
          configDir: loopConfigDir ? path.resolve(loopConfigDir) : undefined,
          activeCap: loopActiveCap,
          runtime: loopRuntime,
        });
      } else {
        error(
          `Unknown loop subcommand: ${loopSubcommand}. Available: render-hooks`,
          ERROR_REASON ? ERROR_REASON.SDK_UNKNOWN_COMMAND : undefined,
        );
      }
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
      } else if (subcommand === 'record-agent') {
        worktreeSafety.cmdWorktreeRecordAgent(cwd, args.slice(2));
      } else if (subcommand === 'reap-orphans') {
        worktreeSafety.cmdWorktreeReapOrphans(cwd);
      } else if (subcommand === 'base-check') {
        require('./lib/worktree-base-ref.cjs').cmdWorktreeBaseCheck(cwd, args.slice(2));
      } else if (subcommand === 'set-baseref') {
        require('./lib/worktree-base-ref.cjs').cmdWorktreeSetBaseRef(cwd, args.slice(2));
      } else {
        error('Unknown worktree subcommand. Available: cleanup-wave, record-agent, reap-orphans, base-check, set-baseref', ERROR_REASON.SDK_UNKNOWN_COMMAND);
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
        output: output,
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

    // ─── teams-status ──────────────────────────────────────────────────────
    // Read-only detector for claude-code's experimental agent-teams feature.
    // issue #1355: stop gsd-core hanging silently under claude-code agent-teams.
    // No capability registration needed — this is a diagnostic query command,
    // not a feature capability.
    case 'teams-status': {
      const teamsStatus = require('./lib/teams-status.cjs');
      teamsStatus.cmdTeamsStatus(cwd, { active: args.includes('--active') });
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

      // GSD-managed directories to scan for user-added files. Whole-owned
      // roots are wiped recursively; shared runtime roots are pruned by the
      // same gsd-* top-level prefix used by install.js _removeGsdEntries.
      const GSD_WHOLE_MANAGED_DIRS = [
        'gsd-core',
        path.join('commands', 'gsd'),
      ];
      const GSD_PREFIX_MANAGED_DIRS = [
        'agents',
        'hooks',
        'skills',
      ];

      function collectCustomFiles(dir, baseDir, manifestKeys, out) {
        if (!fs.existsSync(dir)) return;
        const stat = fs.statSync(dir);
        if (stat.isFile()) {
          const relPath = path.relative(baseDir, dir).replace(/\\/g, '/');
          if (!manifestKeys.has(relPath)) {
            out.push(relPath);
          }
          return;
        }
        if (!stat.isDirectory()) return;
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
      for (const managedDir of GSD_WHOLE_MANAGED_DIRS) {
        const absDir = path.join(resolvedConfigDir, managedDir);
        if (!fs.existsSync(absDir)) continue;
        collectCustomFiles(absDir, resolvedConfigDir, manifestKeys, customFiles);
      }
      for (const managedDir of GSD_PREFIX_MANAGED_DIRS) {
        const absDir = path.join(resolvedConfigDir, managedDir);
        if (!fs.existsSync(absDir)) continue;
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          if (!entry.name.startsWith('gsd-')) continue;
          collectCustomFiles(path.join(absDir, entry.name), resolvedConfigDir, manifestKeys, customFiles);
        }
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
        throw new ExitError(1, 'Error: --budget <N> is required');
      }
      const budget = parseInt(budgetStr, 10);
      if (!Number.isFinite(budget) || budget <= 0) {
        throw new ExitError(1, 'Error: --budget must be a positive integer');
      }
      if (!instructionsFile) {
        throw new ExitError(1, 'Error: --instructions-file <path> is required');
      }
      if (!roadmapFile) {
        throw new ExitError(1, 'Error: --roadmap-file <path> is required');
      }
      if (planFiles.length === 0) {
        throw new ExitError(1, 'Error: at least one --plan-file <path> is required');
      }
      if (!outputPromptFile) {
        throw new ExitError(1, 'Error: --output-prompt <path> is required');
      }
      if (!outputMetadataFile) {
        throw new ExitError(1, 'Error: --output-metadata <path> is required');
      }

      // ── Validate and read required files ──────────────────────────────
      async function readRequired(filePath, flagName) {
        const resolved = path.resolve(filePath);
        try {
          return await fs.promises.readFile(resolved, 'utf8');
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            throw new ExitError(1, `Error: file not found for ${flagName}: ${resolved}`);
          }
          throw new ExitError(1, `Error: cannot read file for ${flagName}: ${resolved}`);
        }
      }

      async function readOptional(filePath) {
        if (!filePath) return null;
        const resolved = path.resolve(filePath);
        try {
          return await fs.promises.readFile(resolved, 'utf8');
        } catch (err) {
          if (err && err.code === 'ENOENT') return null;
          throw new ExitError(1, `Error: cannot read optional file: ${resolved}`);
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
            throw new ExitError(1, `Error: plan file not found: ${resolved}`);
          }
          throw new ExitError(1, `Error: cannot read plan file: ${resolved}`);
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
        throw new ExitError(2);
      }
      break;
    }

    case 'update-context': {
      // #498: resolve the installed GSD version, scope, runtime, and config dir
      // for /gsd:update. Replaces ~280 lines of inline bash in update.md with a
      // tested projection. Emits the contract as JSON: { installedVersion,
      // scope, runtime, gsdDir }. Optional --config-dir / --runtime carry the
      // workflow's execution_context hints (the one thing only it can know).
      const { loadUpdateContext } = require('./lib/update-context.cjs');
      const ucArgs = args.slice(1);
      let preferredConfigDir = '';
      let preferredRuntime = '';
      for (let i = 0; i < ucArgs.length; i++) {
        const a = ucArgs[i];
        if (a.startsWith('--config-dir=')) { preferredConfigDir = a.slice('--config-dir='.length); continue; }
        if (a.startsWith('--runtime=')) { preferredRuntime = a.slice('--runtime='.length); continue; }
        if (a === '--config-dir') {
          const v = ucArgs[i + 1];
          if (v === undefined || v.startsWith('--')) error('Missing value for --config-dir', ERROR_REASON.USAGE);
          preferredConfigDir = v; i++; continue;
        }
        if (a === '--runtime') {
          const v = ucArgs[i + 1];
          if (v === undefined || v.startsWith('--')) error('Missing value for --runtime', ERROR_REASON.USAGE);
          preferredRuntime = v; i++; continue;
        }
        if (a === '--json') continue; // JSON is the only output; accepted for symmetry
        if (a.startsWith('-')) error(`Unknown flag for update-context: ${a}`, ERROR_REASON.USAGE);
      }
      const ctx = loadUpdateContext({ preferredConfigDir, preferredRuntime });
      process.stdout.write(JSON.stringify(ctx) + '\n');
      break;
    }

    // ─── Research Store ────────────────────────────────────────────────────
    //
    // research-store get <key> [--kind <k>]
    //   -> getResearch(cwd, key, { homeDir }); searches both tiers; output(result, raw)
    //   (--kind is accepted for backward compatibility but no longer drives tier selection)
    // research-store put <key> --content <str> --source <s> --provider <p>
    //                           --confidence <c> --kind <k>
    //   -> putResearch(cwd, key, { content, source, provider, confidence, kind })
    //
    // Tier is derived from source: 'curated' source writes to process.env.HOME/.gsd/research-cache;
    // all other sources write to cwd/.planning/research/.cache.
    // Tests may override the home directory by setting the HOME env var.



    // ─── Classify Confidence ──────────────────────────────────────────────
    //
    // classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]
    //   -> classifyConfidence({ provider, verifiedAgainstOfficial, legitimacyVerdict }); output(result, raw)
    //
    // legitimacyVerdict is CODE-COMPUTED via checkPackages — never caller-supplied — so an agent cannot self-assert OK→HIGH.

    case 'classify-confidence': {
      const researchProvider = require('./lib/research-provider.cjs');
      const providerIdx = args.indexOf('--provider');
      const provider = providerIdx !== -1 ? args[providerIdx + 1] : null;
      if (!provider || provider.startsWith('--')) {
        error('Usage: gsd-tools query classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]', ERROR_REASON.USAGE);
      }
      const verified = args.includes('--verified');
      const pkgIdx = args.indexOf('--package');
      const pkg = pkgIdx !== -1 ? args[pkgIdx + 1] : null;
      const ecoIdx = args.indexOf('--ecosystem');
      const ecosystem = ecoIdx !== -1 ? args[ecoIdx + 1] : null;
      let legitimacyVerdict = null;
      if (pkg && (!pkg.startsWith('--'))) {
        const VALID_ECOSYSTEMS = new Set(['npm', 'pypi', 'crates']);
        if (!ecosystem || ecosystem.startsWith('--') || !VALID_ECOSYSTEMS.has(ecosystem)) {
          error('Usage: gsd-tools query classify-confidence --provider <id> [--package <name> --ecosystem <npm|pypi|crates>] [--verified]', ERROR_REASON.USAGE);
        }
        const pkgLegitimacy = require('./lib/package-legitimacy.cjs');
        const results = await pkgLegitimacy.checkPackages({ ecosystem, packages: [pkg] }, {});
        legitimacyVerdict = results[0] ? results[0].verdict : null;
      }
      const confidence = researchProvider.classifyConfidence({ provider, verifiedAgainstOfficial: verified, legitimacyVerdict });
      output({ provider, package: pkg || null, ecosystem: ecosystem || null, legitimacyVerdict, verified, confidence }, raw);
      break;
    }

    // ─── Package Legitimacy ────────────────────────────────────────────────
    //
    // package-legitimacy check --ecosystem <eco> <pkg1> <pkg2> ...
    //
    // checkPackages is ASYNC. This entire runCommand function is async, so
    // we can await directly. On rejection we call error() which exits.

    case 'package-legitimacy': {
      const pkgLegitimacy = require('./lib/package-legitimacy.cjs');
      const subcommand = args[1];
      if (subcommand !== 'check') {
        error('Unknown package-legitimacy subcommand. Available: check', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      const ecoIdx = args.indexOf('--ecosystem');
      const ecosystem = ecoIdx !== -1 ? args[ecoIdx + 1] : null;
      const VALID_ECOSYSTEMS = new Set(['npm', 'pypi', 'crates']);
      if (!ecosystem || !VALID_ECOSYSTEMS.has(ecosystem)) {
        error('Usage: gsd-tools package-legitimacy check --ecosystem <npm|pypi|crates> <pkg1> ...', ERROR_REASON.USAGE);
      }
      // Collect positional package names.
      // Only --ecosystem takes a value. Every non-flag arg is a package name.
      // Any unknown --flag is a usage error (do not silently skip+consume the next arg).
      const packages = [];
      for (let i = 2; i < args.length; i++) {
        const a = args[i];
        if (a === '--ecosystem') { i++; continue; }
        if (a.startsWith('--')) {
          error(`package-legitimacy: unknown flag ${a}`, ERROR_REASON.USAGE);
        }
        packages.push(a);
      }
      if (packages.length === 0) {
        error('Usage: gsd-tools package-legitimacy check --ecosystem <eco> <pkg1> <pkg2> ...', ERROR_REASON.USAGE);
      }
      let pkgResults;
      try {
        pkgResults = await pkgLegitimacy.checkPackages({ ecosystem, packages }, {});
      } catch (pkgErr) {
        error(`package-legitimacy: ${pkgErr && pkgErr.message ? pkgErr.message : String(pkgErr)}`, ERROR_REASON.UNKNOWN);
      }
      output(pkgResults, raw);
      break;
    }

    case 'effort': {
      const subcommand = args[1];
      if (subcommand === 'sync') {
        const effortSyncArgs = args.slice(2);
        let dryRun = true;
        let effortSyncConfigDir;
        let effortSyncRuntime;
        for (let i = 0; i < effortSyncArgs.length; i++) {
          const a = effortSyncArgs[i];
          if (a === '--apply') { dryRun = false; continue; }
          if (a === '--dry-run') { dryRun = true; continue; }
          if (a.startsWith('--config-dir=')) { effortSyncConfigDir = a.slice('--config-dir='.length); continue; }
          if (a === '--config-dir') {
            const v = effortSyncArgs[i + 1];
            if (!v || v.startsWith('--')) error('Missing value for --config-dir', ERROR_REASON.USAGE);
            effortSyncConfigDir = v; i++; continue;
          }
          if (a.startsWith('--runtime=')) { effortSyncRuntime = a.slice('--runtime='.length); continue; }
          if (a === '--runtime') {
            const v = effortSyncArgs[i + 1];
            if (!v || v.startsWith('--')) error('Missing value for --runtime', ERROR_REASON.USAGE);
            effortSyncRuntime = v; i++; continue;
          }
          if (a === '--raw') continue;
          if (a.startsWith('-')) error(`Unknown flag for effort sync: ${a}`, ERROR_REASON.USAGE);
          error(`effort sync takes no positional arguments; got: ${a}`, ERROR_REASON.USAGE);
        }
        commands.cmdEffortSync(cwd, raw, { dryRun, configDir: effortSyncConfigDir, runtime: effortSyncRuntime });
      } else {
        error('Unknown effort subcommand. Available: sync', ERROR_REASON.SDK_UNKNOWN_COMMAND);
      }
      break;
    }

    // ─── User Story Validation (bug #1145) ────────────────────────────────────
    //
    // Invocation shapes (from mvp-phase.md and verify-work.md):
    //   gsd_run query user-story.validate --story "$USER_STORY"
    //   gsd_run query user-story.validate --story "$PHASE_GOAL" --pick valid
    //
    // Returns JSON: { valid: boolean, errors: string[], slots: { role, capability, outcome } | null }
    //   - valid: true only when the story fully matches the canonical format
    //   - errors: per-slot diagnostic strings (empty on success)
    //   - slots: extracted role/capability/outcome on success; null on failure
    //
    // Canonical format (user-story-template.md):
    //   "As a [user role], I want to [capability], so that [outcome]."
    //   Each slot must be non-empty and contain non-whitespace content.
    //
    // No .planning/ access needed — pure string validation.

    // #1146: single base-branch resolver for all forking workflows.
    // Workflows call `gsd_run query git.base-branch` (dotted form normalised to
    // command='git', args=['git','base-branch']).


    case 'user-story': {
      const subcommand = args[1];
      if (subcommand !== 'validate') {
        error(`Unknown user-story subcommand: ${subcommand || '(none)'}. Available: validate`, ERROR_REASON.SDK_UNKNOWN_COMMAND);
        break;
      }

      const storyIdx = args.indexOf('--story');
      const story = (storyIdx !== -1 && args[storyIdx + 1] && !args[storyIdx + 1].startsWith('--'))
        ? args[storyIdx + 1]
        : '';

      // Canonical extraction regex — requires non-whitespace content in each slot
      // (\S.*? ensures the slot isn't whitespace-only).
      // Named groups: role / capability / outcome.
      const USER_STORY_RE = /^As a (\S.*?), I want to (\S.*?), so that (\S.*?)\.$/;

      const errors = [];
      const trimmed = story.trim();
      let slots = null;

      if (!trimmed) {
        errors.push('Story is empty. Required format: "As a [role], I want to [capability], so that [outcome]."');
      } else {
        // Per-clause guards produce targeted, actionable error messages before
        // attempting the full regex. Guards are ordered: role → capability → outcome → period.
        if (!/^As a \S/i.test(trimmed)) {
          errors.push('Story must start with "As a [user role]," (role must be non-empty).');
        }
        if (!/, I want to \S/i.test(trimmed)) {
          errors.push('Story must include ", I want to [capability]," (capability must be non-empty).');
        }
        if (!/, so that \S/i.test(trimmed)) {
          errors.push('Story must include ", so that [outcome]." (outcome must be non-empty).');
        }
        if (!trimmed.endsWith('.')) {
          errors.push('Story must end with a period (.).');
        }
        // Full-regex check only when per-clause guards all passed — avoids
        // redundant "format mismatch" noise on top of specific error messages.
        if (errors.length === 0) {
          const m = USER_STORY_RE.exec(trimmed);
          if (!m) {
            errors.push('Story does not match the canonical format: "As a [role], I want to [capability], so that [outcome]."');
          } else {
            slots = { role: m[1], capability: m[2], outcome: m[3] };
          }
        }
      }

      output({ valid: errors.length === 0, errors, slots }, raw);
      break;
    }

    case 'drift-guard': {
      // ADR-22: deterministic authority resolution + severity classification.
      // Subcommands:
      //   drift-guard authority                          → effective authority string
      //   drift-guard severity --status <S> [--authority <A>]  → {severity, hardBlock}
      const subcommand = args[1];

      // Read config.json directly for both plan_review.source_grounding_authority
      // and intel.enabled. Neither key is in the config-loader.cjs whitelist that
      // config-loader.cjs's loadConfig() whitelist does not return; plan_review is only in config.cjs's private
      // buildConfig(), and intel is a federated capability config key.
      let configuredAuthority = 'grep';
      let intelEnabled = false;
      try {
        const { planningDir } = require('./lib/planning-workspace.cjs');
        const cfgPath = require('path').join(planningDir(cwd), 'config.json');
        if (require('fs').existsSync(cfgPath)) {
          const rawCfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf-8'));
          if (rawCfg && rawCfg.plan_review && rawCfg.plan_review.source_grounding_authority) {
            configuredAuthority = String(rawCfg.plan_review.source_grounding_authority);
          }
          if (rawCfg && rawCfg.intel && rawCfg.intel.enabled === true) {
            intelEnabled = true;
          }
        }
      } catch {
        // not fatal — defaults apply
      }

      const effectiveAuthority = getEffectiveAuthority(configuredAuthority, intelEnabled);

      if (subcommand === 'authority') {
        // Pass rawValue as 3rd arg so --raw returns unquoted string (not JSON)
        output(effectiveAuthority, raw, effectiveAuthority);
        break;
      }

      if (subcommand === 'severity') {
        const statusIdx = args.indexOf('--status');
        const statusVal = statusIdx !== -1 ? args[statusIdx + 1] : undefined;
        if (!statusVal || statusVal.startsWith('--')) {
          error('drift-guard severity requires --status <VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE>', ERROR_REASON.SDK_UNKNOWN_COMMAND);
          break;
        }
        const authIdx = args.indexOf('--authority');
        const authVal = authIdx !== -1 ? args[authIdx + 1] : undefined;
        const authorityForClassify = (authVal && !authVal.startsWith('--'))
          ? authVal
          : effectiveAuthority;
        const result = classifyDriftSeverity({ status: statusVal, authority: authorityForClassify });
        output(result, raw);
        break;
      }

      error(
        `Unknown drift-guard subcommand: ${subcommand || '(none)'}. Available: authority, severity`,
        ERROR_REASON.SDK_UNKNOWN_COMMAND,
      );
      break;
    }

    default: {
      // ADR-959: try capability-registry dispatch before emitting the unknown-command error.
      // An unmigrated command still hits its hardcoded `case` above — untouched.
      // A migrated command's `case` is removed at cutover, so it reaches here and
      // dispatchCapabilityCommand routes it to the capability's registered router.
      // commandFamilies now includes migrated capabilities (e.g. graphify → graphify-command-router.cjs);
      // this returns true when a registered capability owns the command, false otherwise.
      if (dispatchCapabilityCommand({ command, args, cwd, raw, error })) break;

      // ADR-1244 Phase 5 (D7): if no first-party family owns the command, try an INSTALLED
      // THIRD-PARTY (overlay) capability — dispatched only if committed/consented and only by
      // require()-ing its router FROM the capability's install root (confined to that root).
      if (dispatchOverlayCapabilityCommand({ command, args, cwd, raw, error })) break;

      // ADR-2346 (epic #2345): host dispatch table — core, non-capability
      // commands (state, …) routed via their `route*Command` router instead of
      // a hardcoded `case` arm. Tried after capability/overlay dispatch and
      // before the unknown-command error.
      if (await dispatchHostCommand({ command, args, cwd, raw, error, defaultValue, workstreamContext })) break;

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

// ─── CLI entry point ──────────────────────────────────────────────────────────
if (require.main === module) {
  runMain(main);
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────
// ADR-959: export dispatchCapabilityCommand so tests can exercise it with
// synthetic registry + requireModule injections.
// ADR-1244 Phase 5: export dispatchOverlayCapabilityCommand + defaultRequireFromInstallRoot for
// the third-party overlay dispatch + install-root confinement tests.
module.exports = { dispatchCapabilityCommand, dispatchOverlayCapabilityCommand, defaultRequireFromInstallRoot, dispatchHostCommand, HOST_COMMAND_ROUTERS };
