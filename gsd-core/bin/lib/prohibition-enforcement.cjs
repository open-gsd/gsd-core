"use strict";
/**
 * prohibition-enforcement — the deterministic PRODUCER for test-tier prohibition verification
 * (#1259, ADR-550 Decision 5d "heavy half"; the D1 seam — a NEW deterministic gsd-tools
 * sub-command, NOT free-form workflow prose).
 *
 * Today `dispositionForProhibition()` (src/probe-core.cts) already carries the POLICY seam: with
 * non-empty `enforcementEvidence` AND `tier === 'test'` it returns `{ status: 'green' }` (the
 * branch at probe-core 420-427); with empty evidence it fails closed to flagged-unverified. But
 * NOTHING in the live pipeline ever produced `enforcementEvidence`, so the green branch was
 * unreachable. This module is the missing producer: it LOCATES the wired mechanical check from a
 * check descriptor, RUNS it and requires a genuine NON-VACUOUS pass, builds a typed
 * `enforcementEvidence` array on PASS, and emits the `dispositionForProhibition` verdict as JSON.
 * The green/fail-closed policy itself is untouched (no src/probe-core.cts edit).
 *
 * Accepts BOTH wired-check kinds (ADR-550 D2): a `node --test` negative test OR a lint/AST rule
 * (e.g. the in-tree `local/no-source-grep` rule — the D4 dogfood anchor, run via the project flat
 * config so the plugin loads). A missing, non-attested, or genuinely-non-passing check hard-gates
 * (flagged, non-green) in BOTH interactive and autonomous modes (ADR-550 D4 / D3) — never a silent
 * green.
 *
 * FAIL-FIRST IS MACHINE-PROVEN (#1279): the producer no longer greens on caller attestation. The
 * green verdict requires the injectable prover (`proveFailFirst`, default `defaultProveFailFirst`) to
 * INDEPENDENTLY run the check against a known violation fixture and observe it go red, AND the runner
 * to observe a real non-vacuous pass: `passed = proof.provenFailFirst === true && run.passed === true`.
 * Caller attestation (`CheckDescriptor.failFirst`) is demoted to a non-authoritative hint kept only
 * for backward route-JSON shape — no path greens on it alone (FF-08). The proof method is recorded in
 * the evidence (`failFirstProof`, FF-07). This replaces the #1259 caller-attested red-first property
 * with machine proof, closing the gap the ADR-550 D5d note tracked as a follow-up.
 *
 * Authored as strict TypeScript (`src/prohibition-enforcement.cts`) and compiled by
 * `tsc -p tsconfig.build.json` (`npm run build:lib`) to the gitignored runtime artifact
 * `gsd-core/bin/lib/prohibition-enforcement.cjs`. Do NOT hand-write the `.cjs`; it is emitted.
 *
 * DETERMINISM SCOPE: the DECISION layer is pure/deterministic and no-LLM — given a `runCheck` result
 * the disposition is same-input-same-output and mutation-survivable, and the parse/filter helpers
 * (`parseNodeTestSummary`, `tapTestNames`, `eslintJsonHasRule`, `eslintHasFatalError`, …) are pure.
 * The DEFAULT REAL runner is NOT pure — it spawns `node --test` / eslint, so its result depends on the
 * environment (eslint version + flat config, node version, the target file). That is why the runner is
 * an injectable seam (`runCheck`): the contract is unit-tested against injected results, mirroring the
 * injectable I/O pattern in `runProbeCli` / `ProbeCliOptions`.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.descriptorFromProjection = descriptorFromProjection;
exports.buildNodeTestArgs = buildNodeTestArgs;
exports.buildLintArgs = buildLintArgs;
exports.parseNodeTestSummary = parseNodeTestSummary;
exports.isNodeTestRed = isNodeTestRed;
exports.tapTestNames = tapTestNames;
exports.isNonVacuousNodeTestPass = isNonVacuousNodeTestPass;
exports.tapFailedTestNames = tapFailedTestNames;
exports.isNonVacuousNodeTestRed = isNonVacuousNodeTestRed;
exports.eslintFileResultCount = eslintFileResultCount;
exports.eslintHasFatalError = eslintHasFatalError;
exports.eslintJsonHasRule = eslintJsonHasRule;
exports.defaultProveFailFirst = defaultProveFailFirst;
exports.runProhibitionEnforcement = runProhibitionEnforcement;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const probe_core_cjs_1 = require("./probe-core.cjs");
/**
 * READ-BACK ADAPTER (#1278, plan 01-03): reconstruct a `CheckDescriptor` from the flat scalar keys
 * `projectProhibitions` emits onto a prohibition item (`check_kind` / `check_target` / `check_rule`,
 * src/probe-core.cts). This is the deterministic bridge from the projected descriptor back into the
 * merged #1259 producer request — the verify-phase caller reads the projected scalars, this rebuilds
 * the `{ kind, target, rule? }` request, and `runProhibitionEnforcement`'s EXISTING fail-closed LOCATE
 * guard (validKind/validTarget/validRule, below) is the single source of fail-closed truth.
 *
 * Contract:
 *   - `null`/`undefined`/non-object input -> `null`.
 *   - `check_kind` ABSENT -> `null` (no descriptor -> producer locates nothing -> fail-closed).
 *   - `check_kind` present -> `{ kind: check_kind, target: check_target }`, adding `rule: check_rule`
 *     ONLY when `check_rule` is a non-empty string, `violationFixture: check_violation_fixture`
 *     ONLY when that scalar is a non-empty string (composes #1278 locate with #1279 proof), and
 *     `cleanFixture: check_clean_fixture` ONLY when that scalar is non-empty (#1346 causation control).
 *   - `failFirst` is NEVER sourced from the projection — it stays a verify-time caller attestation
 *     (#1279 machine-proves it; out of scope here). The returned descriptor carries no `failFirst`.
 *   - The adapter does NOT strictly validate kind/target/rule: it faithfully reconstructs whatever
 *     scalars are present (e.g. `{check_kind:'lint-rule', check_target:'src/'}` with no `check_rule`
 *     reconstructs to `{kind:'lint-rule', target:'src/'}`), letting the existing LOCATE guard reject
 *     an under-specified descriptor (located:false, never green). It does NOT re-implement that guard.
 *   - Pure, deterministic, no-throw.
 */
function descriptorFromProjection(projected) {
    if (!projected || typeof projected !== 'object')
        return null;
    if (!('check_kind' in projected))
        return null;
    // The shared `parseMustHavesBlock` (src/frontmatter.cts) coerces /^\d+$/ scalar values to NUMBERS on
    // round-trip, so a numeric-looking check_kind/check_target/check_rule arrives here as a number. Normalize
    // ONLY string|number scalars back to string — a non-scalar (object/array/bool) or absent value yields ''
    // (never an `[object Object]` stringification, no `as string` lie over a number). This keeps the
    // descriptor honestly typed and the round-trip lossless across the full string domain; an under-specified
    // '' target/kind is rejected by the producer's locate guard (fail-closed; never green).
    const scalar = (v) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    const kind = scalar(projected.check_kind);
    const target = scalar(projected.check_target);
    const descriptor = { kind, target };
    // `rule` belongs only to the lint-rule kind; a stray check_rule on a node-test descriptor is dropped
    // (the projector never emits one there — defense in depth). failFirst is NOT sourced here (#1279).
    if (kind === 'lint-rule') {
        const rule = scalar(projected.check_rule);
        if (rule.trim().length > 0)
            descriptor.rule = rule;
    }
    // `violationFixture` (#1346) rides BOTH kinds — reconstruct it from `check_violation_fixture` so the
    // deterministic #1278 locate path and the #1279 machine-proof COMPOSE: a projected fixture lets the
    // default prover green end-to-end with zero hand-authoring. Absent/blank -> no fixture -> the prover
    // hard-gates (fail-closed; green requires a fixture), never fabricated.
    const fixture = scalar(projected.check_violation_fixture);
    if (fixture.trim().length > 0)
        descriptor.violationFixture = fixture;
    // `cleanFixture` (#1346) rides BOTH kinds — reconstruct it from `check_clean_fixture` so the
    // causation control runs end-to-end: when present the prover also requires the check to stay GREEN
    // against this known-clean subject (proving the violation RED is content-dependent). Absent/blank ->
    // no control (the documented residual remains; backward-compatible with the #1314 compose path).
    const clean = scalar(projected.check_clean_fixture);
    if (clean.trim().length > 0)
        descriptor.cleanFixture = clean;
    return descriptor;
}
/** node --test argv. Forces the TAP reporter so the summary counts are parseable + version-stable;
 * `--` before the target so a target starting with `-` is not parsed as a flag (option-injection). */
function buildNodeTestArgs(check) {
    return ['--test', '--test-reporter=tap', '--', check.target];
}
/** eslint argv (the args AFTER the eslint CLI path). Runs the project flat config so plugin rules
 * (e.g. `local/*`) load — `--rule` CANNOT load a plugin, so we lint the TARGET path as JSON and
 * filter by rule id. `--no-warn-ignored` makes an eslint-IGNORED target return `[]` (not a length-1
 * "File ignored" result) so an ignored path fails closed via the vacuity guard, not a false green.
 * `--` before the target so a target starting with `-` is not parsed as a flag (option-injection). */
function buildLintArgs(check) {
    return ['--no-warn-ignored', '--format', 'json', '--', check.target];
}
/**
 * Resolve the project's eslint CLI entry portably (no `npx` — not spawnable via `execFileSync` on
 * Windows). Resolves eslint's package.json from the target project's `node_modules` and derives
 * `bin/eslint.js`, so it is run as `node <cli>` (portable). Returns null if eslint is not installed
 * (→ the lint-rule check fails closed, never throws).
 */
function resolveEslintCli(cwd) {
    try {
        const pkg = require.resolve('eslint/package.json', { paths: [cwd] });
        const cli = node_path_1.default.join(node_path_1.default.dirname(pkg), 'bin', 'eslint.js');
        return node_fs_1.default.existsSync(cli) ? cli : null;
    }
    catch {
        return null;
    }
}
/** Basename of a path, separator-agnostic (handles `\` and `/` so node-test names compare stably
 * across OSes / node versions that report the file-test by differing path forms). */
function baseOf(p) {
    return typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '';
}
/**
 * Pure parser for the `node --test` TAP summary. A genuine pass is NON-VACUOUS: exit 0 is NOT enough
 * (an empty / all-skipped / deleted-negative-test file exits 0 with `# tests 0`). Mutation-pinned by
 * unit tests so a threshold flip is caught.
 */
function parseNodeTestSummary(out) {
    const num = (re) => {
        const m = typeof out === 'string' ? out.match(re) : null;
        return m ? Number(m[1]) : 0;
    };
    return {
        tests: num(/^# tests (\d+)/m),
        pass: num(/^# pass (\d+)/m),
        fail: num(/^# fail (\d+)/m),
        cancelled: num(/^# cancelled (\d+)/m),
    };
}
/**
 * Pure: did a `node --test` run go RED on the violation fixture? True iff the TAP summary reports at
 * least one failure (`# fail >= 1`). The default node-test prover requires this — a negative test
 * that does NOT go red against a known-bad subject is toothless and must not prove fail-first.
 * Mutation-pinned (`>= 1` boundary): a mutant flipping `>=`→`>` (or the threshold) is caught by the
 * `# fail 1` unit case. An unparseable summary yields `fail: 0` → false (fail-closed for the prover).
 */
function isNodeTestRed(out) {
    return parseNodeTestSummary(out).fail >= 1;
}
/** The names of REAL (run) tests from TAP `ok N - <name>` / `not ok N - <name>` lines. A line with a
 * `# SKIP` / `# TODO` directive is EXCLUDED — a skipped/todo negative test never executed, so it must
 * not count toward non-vacuity (#1259 m1). */
function tapTestNames(out) {
    if (typeof out !== 'string')
        return [];
    const names = [];
    const re = /^(?:not )?ok \d+ - (.+)$/gm;
    let m;
    while ((m = re.exec(out)) !== null) {
        const rest = m[1];
        if (/\s#\s*(?:SKIP|TODO)\b/i.test(rest))
            continue; // skipped/todo did not run
        names.push(rest.replace(/\s+#\s.*$/, '').trim());
    }
    return names;
}
/**
 * A non-vacuous node-test pass: at least one test, at least one pass, zero failures — AND at least
 * one reported test whose name is NOT merely the target file. `node --test <file>` counts a file
 * with ZERO `test()` calls as one passing "test" named after the file, so the counts alone cannot
 * tell an empty/deleted negative test from a real one (the #1259 BL-01 false-green). Requiring a
 * named test distinct from the file closes that hole.
 *
 * KNOWN CONSTRAINT (fail-closed, not a hole): a real test whose `test('...')` name is EXACTLY the
 * target file's basename emits TAP indistinguishable from an empty file and is conservatively
 * rejected (non-green). A wired negative test must carry a descriptive name, not be named after its
 * own file — a benign authoring constraint, and the safe direction if violated.
 */
function isNonVacuousNodeTestPass(out, target) {
    const s = parseNodeTestSummary(out);
    // >=1 test, >=1 pass, ZERO failures AND ZERO cancelled (a cancelled run is not a clean pass, m1).
    if (!(s.tests >= 1 && s.pass >= 1 && s.fail === 0 && s.cancelled === 0))
        return false;
    // Compare BASENAMES: node reports the file-test by varying path forms across OS / node version
    // (absolute, relative, normalized), so an exact-string compare misfires. A real test name (e.g.
    // "guards the must-NOT") has no separators, so its basename never equals the target file's.
    const tgtBase = baseOf(target);
    return tapTestNames(out).some((n) => baseOf(n) !== tgtBase);
}
/** The names of FAILING (run) tests from TAP `not ok N - <name>` lines, excluding `# SKIP`/`# TODO`
 * directives (a skipped/todo line never ran). The fail-first analog of `tapTestNames`. */
function tapFailedTestNames(out) {
    if (typeof out !== 'string')
        return [];
    const names = [];
    const re = /^not ok \d+ - (.+)$/gm;
    let m;
    while ((m = re.exec(out)) !== null) {
        const rest = m[1];
        if (/\s#\s*(?:SKIP|TODO)\b/i.test(rest))
            continue; // skipped/todo did not run
        names.push(rest.replace(/\s+#\s.*$/, '').trim());
    }
    return names;
}
/**
 * A NON-VACUOUS node-test RED — the fail-first proof analog of `isNonVacuousNodeTestPass`. True iff
 * the run reports `# fail >= 1` AND at least one FAILING test is named DISTINCTLY from the target file.
 *
 * Why the distinct-name guard: a violation fixture that makes the negative test CRASH at load
 * (ENOENT / throw-on-require / syntax error) emits a FILE-NAMED `not ok 1 - <file>` with `# fail 1`.
 * That is a crash, NOT the negative assertion firing red — so it must not "prove" the test is a
 * regression guard (the RED-side mirror of the BL-01 vacuity hole on the pass side). Requiring a
 * failing test named distinctly from the file closes that hole, symmetric with the clean-pass guard.
 *
 * KNOWN CONSTRAINT (fail-closed, not a hole): a negative test whose `test('...')` name is EXACTLY its
 * own file basename is conservatively rejected — same benign authoring constraint, same safe direction.
 */
function isNonVacuousNodeTestRed(out, target) {
    if (!isNodeTestRed(out))
        return false; // no `# fail >= 1` summary -> not red (fail-closed)
    const tgtBase = baseOf(target);
    return tapFailedTestNames(out).some((n) => baseOf(n) !== tgtBase);
}
/** Number of file results in an eslint `--format json` report (0 if unparseable / not an array). */
function eslintFileResultCount(jsonText) {
    try {
        const parsed = JSON.parse(jsonText);
        return Array.isArray(parsed) ? parsed.length : 0;
    }
    catch {
        return 0;
    }
}
/** Messages array of a single eslint file-result (empty if absent / wrong shape). */
function eslintMessages(file, key) {
    return file && typeof file === 'object' && Array.isArray(file[key])
        ? file[key]
        : [];
}
/**
 * True if the eslint `--format json` report has a FATAL / parse error — meaning the rule never got
 * to run on the target. A prohibition gate must fail closed on "the rule didn't execute" (#1259 B1),
 * NOT treat a length-1 fatal result as "clean". Unparseable report -> true (fail-closed).
 */
function eslintHasFatalError(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        return true;
    }
    if (!Array.isArray(parsed))
        return true;
    for (const file of parsed) {
        const fec = file && typeof file === 'object' ? file.fatalErrorCount : undefined;
        if (typeof fec === 'number' && fec > 0)
            return true;
        if (eslintMessages(file, 'messages').some((m) => m && m.fatal === true))
            return true;
    }
    return false;
}
/** True if the eslint `--format json` report has ANY message for `rule` — in EITHER `messages` or
 * `suppressedMessages` (an inline `// eslint-disable` of the rule is still a violation, #1259 B1).
 * Unparseable -> true (fail-closed: treat an unreadable report as a violation, not a silent pass). */
function eslintJsonHasRule(jsonText, rule) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        return true;
    }
    if (!Array.isArray(parsed))
        return true;
    for (const file of parsed) {
        for (const key of ['messages', 'suppressedMessages']) {
            for (const msg of eslintMessages(file, key)) {
                if (msg && typeof msg === 'object' && msg.ruleId === rule)
                    return true;
            }
        }
    }
    return false;
}
/**
 * The default REAL check runner (used when no `runCheck` is injected). Reports only an OBSERVED,
 * genuinely-non-vacuous pass; guarded so a missing tool / non-zero exit yields a non-passing result,
 * NEVER an uncaught throw (the no-throw contract). It does NOT determine fail-first — that is the
 * separate `proveFailFirst` seam's job (machine-proven against the violation fixture, #1279).
 *   - node-test: runs `node --test` (TAP) and requires a NON-VACUOUS pass (>=1 test, >=1 pass, 0 fail
 *     AND a reported test named distinctly from the file). A bare exit 0 for an empty/zero-test file
 *     — which `node --test` counts as one passing "test" named after the file — is NOT a pass (the
 *     #1259 BL-01 false-green fix).
 *   - lint-rule: runs the project eslint as `node <eslint-cli> --format json <target>` (flat config
 *     loads `local/*` plugins) and requires the target to actually lint (>=1 file result) AND ZERO
 *     messages for the specific rule id. `--rule` cannot load a plugin rule, so we filter the
 *     structured report by `ruleId` instead (the #1259 SF-01 fix).
 *
 * Both kinds spawn via `process.execPath` (never bare `node`/`npx` — not portably spawnable via
 * `execFileSync` on Windows) with arg arrays (no shell → no injection from a caller-supplied target).
 */
/**
 * Env for spawned checks: strip `NODE_TEST_CONTEXT` and `NODE_OPTIONS` so an AMBIENT test-runner
 * context (e.g. running verify under `node --test`, which sets `NODE_TEST_CONTEXT=child-v8`) cannot
 * turn the child `node --test` into a silent v8-reporter worker that emits no parseable TAP — which
 * would otherwise corrupt the verdict. Deterministic, environment-independent execution.
 */
function childEnv() {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    return env;
}
// Bounded subprocess limits (DEFECT.UNBOUNDED-SUBPROCESS): a stuck wired test / eslint must not hang
// verify forever. On timeout `execFileSync` throws -> caught -> fail-closed (degraded, non-passing).
// `maxBuffer` caps output so a runaway producer throws (safe direction) rather than OOMs the verifier.
const NODE_TEST_TIMEOUT_MS = 30_000;
const ESLINT_TIMEOUT_MS = 60_000;
const CHECK_MAX_BUFFER = 16 * 1024 * 1024;
/** Windows `taskkill` resolved by ABSOLUTE path — never a bare PATH-resolved name. A project
 * directory used as the child's `cwd` could otherwise contain a planted `taskkill.exe`/`.bat`
 * that Windows executable resolution picks up ahead of the real one (#3660 review, minor-9).
 * Returns null (never a hardcoded fallback, per tests/hardcoded-paths.test.cjs) when neither env
 * var is set -- not expected on a real Windows host (both are set by the OS itself), but a
 * hostile/stripped env should degrade to "skip the reap" rather than guess a system path. */
function taskkillPath() {
    const root = process.env.SystemRoot || process.env.windir;
    return root ? node_path_1.default.join(root, 'System32', 'taskkill.exe') : null;
}
/**
 * Reap the process TREE rooted at `pid` after THIS call's own bound killed it (#3660: `node --test`
 * forks a per-file WORKER by default since Node 22 — `execFileSync`'s `timeout` signals only the
 * direct child/runner, never the worker, which is reparented to PID 1 and can busy-loop forever).
 *
 * POSIX: the child was spawned `detached` (its own process group, pgid === pid), so `-pid` addresses
 * the whole group. ESRCH (group already gone) is swallowed — the subject may have exited on its own
 * between the timeout firing and this call.
 *
 * Windows has no process-group equivalent; `taskkill /PID <pid> /T /F` walks the live process tree by
 * parent-PID instead, which does not require the parent PID to still be alive. A non-zero exit means
 * "nothing left to kill" (already gone, or never had descendants) — not a failure, so it is never
 * escalated; there is no portable stronger primitive to escalate TO.
 *
 * Never throws — this runs from a `catch`/`finally` path and must not itself become the error.
 */
function reapDescendants(pid) {
    if (typeof pid !== 'number' || pid <= 0)
        return; // defensive: never signal pid 0 (self) or negative
    if (process.platform === 'win32') {
        const exe = taskkillPath();
        if (!exe)
            return; // no safe absolute path available -- best-effort, skip rather than guess
        try {
            // 5s bound (DEFECT.UNBOUNDED-SUBPROCESS): a local OS command, not a network call -- if
            // taskkill itself hangs, this function's own "never throws" contract already treats that
            // identically to any other failure (swallowed below), so a bounded timeout costs nothing
            // and just prevents a stuck taskkill from blocking the caller forever.
            (0, node_child_process_1.spawnSync)(exe, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        }
        catch {
            // best-effort: a missing taskkill.exe (or a timeout) is not this call's problem to escalate
        }
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch {
        // Swallows ESRCH (group already gone -- nothing to reap) and any other errno (e.g. EPERM) --
        // this helper never throws regardless of cause; see the function's own doc comment above.
    }
}
/**
 * `execFileSync`, with descendant reaping layered on top. Same contract (same return value, throws
 * the identical error) EXCEPT that when — and ONLY when — this call's OWN timeout killed the child,
 * any descendants the child forked are also reaped.
 *
 * Gated on `error.code === 'ETIMEDOUT'`, NOT `error.signal`. `signal` is the field Node's own docs
 * describe for this purpose, but it is not reliably populated across platforms/Node versions: on one
 * real Linux CI run (Node 24) a genuine timeout-kill threw `{ signal: null, code: 'ETIMEDOUT',
 * status: 7 }` — `signal` was simply absent, `code` was the only reliable marker (confirmed empirically
 * before landing this; a macOS/Node run separately showed `signal: 'SIGTERM'` for the identical
 * scenario, so neither field alone is safe to rely on everywhere — `code` was the one constant).
 * Gating strictly on the timeout code (rather than reaping on every throw) matters: an ordinary
 * non-zero exit (a real test/lint failure) has no `ETIMEDOUT` code — the child exited on its own, so a
 * reap there would fire on every red run for no reason and, on POSIX, risks signalling a process group
 * whose pgid was *already* recycled by something unrelated in the time since (the #3660 review's
 * Blocker-3 defect in the prior attempt at this fix, PR #3681). Only the timeout-kill path is targeted.
 *
 * Spawns `detached` on POSIX so the reap above can address the whole process group; omitted on
 * Windows (no such flag there — `@types/node`'s `ExecFileSyncOptions` doesn't declare `detached`
 * either, hence the cast below, though libuv honors it identically to `spawnSync`).
 */
function execFileSyncReaping(file, args, options) {
    const spawnOptions = process.platform === 'win32' ? options : { ...options, detached: true };
    try {
        return (0, node_child_process_1.execFileSync)(file, args, spawnOptions);
    }
    catch (e) {
        const err = e;
        if (typeof err.pid === 'number' && err.code === 'ETIMEDOUT') {
            reapDescendants(err.pid);
        }
        throw e;
    }
}
/** Resolve the effective timeout: only a POSITIVE override is honored — `0` (which Node treats as
 * "no timeout") or a negative value falls back to the bounded default, so the subprocess is ALWAYS
 * bounded (a `timeoutMs: 0` injection can never disable the bound). */
function posTimeout(timeoutMs, def) {
    return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : def;
}
/**
 * Spawn the negative `node --test` against a single subject (set via the `GSD_PROHIB_SUBJECT`
 * convention, #1279) and return its TAP output. Reuses the bounded-subprocess machinery
 * (`process.execPath`, arg arrays → no shell, `childEnv`, bounded `timeout`/`maxBuffer`) and NEVER
 * throws — a RED run exits non-zero, so the partial TAP (with the `# fail` summary) is recovered from
 * the thrown error's `stdout`. The prover calls this once per subject: the KNOWN-BAD violation fixture
 * (expect RED) and, for the #1346 causation control, the KNOWN-CLEAN control subject (expect GREEN).
 */
function runNodeTestWithSubject(check, cwd, subject, timeoutMs) {
    try {
        return execFileSyncReaping(process.execPath, buildNodeTestArgs(check), {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...childEnv(), GSD_PROHIB_SUBJECT: subject },
            timeout: posTimeout(timeoutMs, NODE_TEST_TIMEOUT_MS),
            maxBuffer: CHECK_MAX_BUFFER,
        });
    }
    catch (e) {
        const stdout = e && typeof e === 'object' && 'stdout' in e ? e.stdout : '';
        return typeof stdout === 'string' ? stdout : '';
    }
}
function defaultRunCheck(check, cwd, timeoutMs) {
    try {
        if (check.kind === 'node-test') {
            let out = '';
            try {
                out = execFileSyncReaping(process.execPath, buildNodeTestArgs(check), {
                    cwd,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: childEnv(),
                    timeout: posTimeout(timeoutMs, NODE_TEST_TIMEOUT_MS),
                    maxBuffer: CHECK_MAX_BUFFER,
                });
            }
            catch (e) {
                // A failing/timed-out run exits non-zero or is killed (partial TAP on stdout, no `# pass`
                // summary). Parse what we have: a real failure or timeout -> not a non-vacuous pass -> false.
                const stdout = e && typeof e === 'object' && 'stdout' in e ? e.stdout : '';
                out = typeof stdout === 'string' ? stdout : '';
            }
            return { passed: isNonVacuousNodeTestPass(out, check.target) };
        }
        if (check.kind === 'lint-rule') {
            const eslintCli = resolveEslintCli(cwd);
            if (!eslintCli)
                return { passed: false }; // eslint not installed -> fail closed, never throw
            let json = '';
            try {
                json = execFileSyncReaping(process.execPath, [eslintCli, ...buildLintArgs(check)], {
                    cwd,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: childEnv(),
                    timeout: posTimeout(timeoutMs, ESLINT_TIMEOUT_MS),
                    maxBuffer: CHECK_MAX_BUFFER,
                });
            }
            catch (e) {
                // eslint exits non-zero when ANY error is present; the JSON report is still on stdout.
                // A timeout/kill leaves no parseable JSON -> eslintHasFatalError(unparseable) -> fail-closed.
                const stdout = e && typeof e === 'object' && 'stdout' in e ? e.stdout : '';
                json = typeof stdout === 'string' ? stdout : '';
            }
            // PASS requires: the target actually linted (>=1 file result), NO fatal/parse error (the rule
            // must have RUN — #1259 B1), and ZERO messages for the rule (in messages OR suppressedMessages).
            const lintedSomething = eslintFileResultCount(json) >= 1;
            return {
                passed: lintedSomething && !eslintHasFatalError(json) && !eslintJsonHasRule(json, check.rule),
            };
        }
        // Unknown kind — defensive; the LOCATE guard already rejects it.
        return { passed: false };
    }
    catch {
        return { passed: false };
    }
}
/**
 * The default REAL fail-first prover (#1279; used when no `proveFailFirst` is injected). It runs the
 * wired check against the descriptor's `violationFixture` (a KNOWN-BAD subject) and requires it to go
 * RED — the machine proof that replaces caller attestation. Like `defaultRunCheck`, it is the
 * impure/injectable seam (spawns eslint / `node --test`), reuses the identical bounded-subprocess
 * machinery (`childEnv`/`posTimeout`/`CHECK_MAX_BUFFER`, `execFileSync(process.execPath, …)`, arg
 * arrays → no shell), and NEVER throws — every un-provable path returns `{ provenFailFirst: false }`.
 *
 *   - lint-rule: lint the `violationFixture` via the project flat config (so `local/*` plugins load)
 *     and require the target to actually lint (>=1 file result) AND no fatal/parse error AND the rule
 *     id to appear in the report (messages OR suppressedMessages — an inline-disabled violation still
 *     proves the rule has teeth, #1259 B1). Absent fixture / unresolvable eslint → not proven.
 *   - node-test: spawn the negative test (TAP) with `GSD_PROHIB_SUBJECT` set to the `violationFixture`
 *     — the CONVENTION (#1279) by which a negative test reads its subject-under-test — and require a
 *     NON-VACUOUS red (`isNonVacuousNodeTestRed`: `# fail >= 1` AND a failing test named distinctly
 *     from the file, so a load-CRASH on the bad subject is not mistaken for the assertion firing red).
 *     A toothless test that passes anyway → not proven. Absent fixture → not proven (fail-closed;
 *     NEVER falls back to attestation).
 */
function defaultProveFailFirst(check, cwd, timeoutMs) {
    try {
        if (check.kind === 'lint-rule') {
            const fixture = check.violationFixture;
            if (!fixture)
                return { provenFailFirst: false }; // can't prove without a known violation -> hard-gate
            const eslintCli = resolveEslintCli(cwd);
            if (!eslintCli)
                return { provenFailFirst: false }; // eslint not installed -> fail closed, never throw
            let json = '';
            try {
                json = execFileSyncReaping(process.execPath, [eslintCli, ...buildLintArgs({ ...check, target: fixture })], {
                    cwd,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: childEnv(),
                    timeout: posTimeout(timeoutMs, ESLINT_TIMEOUT_MS),
                    maxBuffer: CHECK_MAX_BUFFER,
                });
            }
            catch (e) {
                // eslint exits non-zero on any error; the JSON report is still on stdout. A timeout/kill
                // leaves no parseable JSON -> eslintHasFatalError(unparseable) -> not proven (fail-closed).
                const stdout = e && typeof e === 'object' && 'stdout' in e ? e.stdout : '';
                json = typeof stdout === 'string' ? stdout : '';
            }
            // Proven iff: the fixture actually linted (>=1 file result), the rule RAN (no fatal/parse
            // error), and the rule id appears (the violation was flagged -> the rule has teeth).
            const proven = eslintFileResultCount(json) >= 1
                && !eslintHasFatalError(json)
                && eslintJsonHasRule(json, check.rule);
            return { provenFailFirst: proven, method: 'violation-fixture' };
        }
        if (check.kind === 'node-test') {
            const fixture = check.violationFixture;
            // Fail-CLOSED on a missing/typo'd/stale fixture path, SYMMETRIC with the lint-rule path's
            // `eslintFileResultCount >= 1` guard. Without the existence check, a non-existent fixture makes
            // `GSD_PROHIB_SUBJECT` point at a missing file; an honest negative test reading that subject
            // throws ENOENT *inside its callback* — a failing test named DISTINCTLY from the file, which
            // `isNonVacuousNodeTestRed` would accept as proof. That is fail-OPEN: a typo forges a green from
            // a setup crash, not from the prohibition firing. Requiring the fixture to exist before spawning
            // closes the realistic typo/stale-path case (#1279 review, Major 1).
            //
            // CAUSATION (#1346; MANDATORY as of #1906): existence + a non-vacuous red is necessary but not
            // sufficient — a deceptive negative test that reds merely BECAUSE `GSD_PROHIB_SUBJECT` is set
            // (rather than because the subject's CONTENT violates the must-NOT) would otherwise be accepted.
            // The `cleanFixture` control below proves content-dependence (red on bad AND green on clean) and is
            // now REQUIRED for the node-test kind: absent it, the check is un-provable (fail-closed), not
            // accepted under the weaker violation-only proof (#1906 supersedes #1346's opt-in; ADR-1606 D4).
            // Resolve the fixture against `cwd` (NOT the verify process's cwd): the spawned test reads
            // `GSD_PROHIB_SUBJECT` and resolves a relative subject against `cwd`, so the existence check must
            // use the SAME base or it could pass here yet ENOENT in the child (re-opening the fail-open hole).
            if (!fixture || !node_fs_1.default.existsSync(node_path_1.default.resolve(cwd, fixture)))
                return { provenFailFirst: false };
            // Run the negative test against the KNOWN-BAD subject and require a NON-VACUOUS red.
            const redOut = runNodeTestWithSubject(check, cwd, fixture, timeoutMs);
            if (!isNonVacuousNodeTestRed(redOut, check.target))
                return { provenFailFirst: false, method: 'violation-fixture' };
            // #1906 CAUSATION CONTROL (MANDATORY for node-test — supersedes #1346's opt-in, ADR-1606 D4): the
            // clean control subject is REQUIRED. Run the SAME test against it and require it to stay GREEN,
            // proving the red above was caused by the subject's CONTENT — a deceptive test that reds merely
            // because GSD_PROHIB_SUBJECT is SET reds here too → not content-dependent → not proven. ABSENT →
            // the control cannot run → un-provable → fail-closed (NOT accepted under the weaker violation-only
            // proof). This is the one behavior change vs #1346: absent `cleanFixture` was previously proven.
            const clean = check.cleanFixture;
            if (!clean)
                return { provenFailFirst: false, method: 'violation-fixture' };
            // A supplied-but-missing/typo'd control path can't run the control → fail-closed, symmetric
            // with the violation-fixture existence guard (resolve against the SAME `cwd` as the child).
            if (!node_fs_1.default.existsSync(node_path_1.default.resolve(cwd, clean)))
                return { provenFailFirst: false, method: 'violation-fixture' };
            const cleanOut = runNodeTestWithSubject(check, cwd, clean, timeoutMs);
            if (!isNonVacuousNodeTestPass(cleanOut, check.target))
                return { provenFailFirst: false, method: 'violation-fixture' };
            return { provenFailFirst: true, method: 'violation-fixture' };
        }
        // Unknown kind — defensive; the LOCATE guard already rejects it.
        return { provenFailFirst: false };
    }
    catch {
        return { provenFailFirst: false };
    }
}
/**
 * LOCATE -> PROVE fail-first -> RUN -> build enforcementEvidence -> dispositionForProhibition.
 *
 * (1) LOCATE: if no well-formed check descriptor is locatable -> fail-closed
 *     (`dispositionForProhibition` with empty evidence) plus `{ located: false, kind: null, evidence: [] }`.
 * (2) PROVE + RUN: machine-prove fail-first via `proveFailFirst` (default `defaultProveFailFirst`) AND
 *     run the check via `runCheck`. The green AND is `proof.provenFailFirst === true && run.passed ===
 *     true` — caller attestation is NOT consulted (FF-08). A check that cannot be proven fail-first, or
 *     that does not genuinely (non-vacuously) PASS -> fail-closed disposition with `located: true` (a
 *     real located miss, non-green, flagged) in BOTH modes.
 * (3) PASS: build a typed `enforcementEvidence` array (recording the proof method) and call
 *     `dispositionForProhibition` — the non-empty array flips a test-tier item to green.
 *
 * Pure/deterministic DECISION layer: the only impure seams are the injectable `runCheck`/`proveFailFirst`;
 * given their results the disposition is same-input-same-output and mutation-survivable.
 */
function runProhibitionEnforcement(prohibition, check, options = {}) {
    const mode = options.mode;
    // (1) LOCATE — no locatable, well-formed wired check -> fail-closed, located: false. The kind must
    // be one of the two known kinds; the target must be a non-empty string; a lint-rule descriptor MUST
    // also carry a non-empty `rule` id (its target is the lint PATH, not the rule). An under-specified
    // descriptor is not a valid wired check, so it is not locatable (does not rely on the runner failing).
    const c = check && typeof check === 'object' ? check : null;
    const validKind = !!c && (c.kind === 'node-test' || c.kind === 'lint-rule');
    const validTarget = !!c && typeof c.target === 'string' && c.target.trim().length > 0;
    const validRule = !!c && (c.kind !== 'lint-rule' || (typeof c.rule === 'string' && c.rule.trim().length > 0));
    if (!c || !validKind || !validTarget || !validRule) {
        const disposition = (0, probe_core_cjs_1.dispositionForProhibition)(prohibition, { enforcementEvidence: [] });
        return { ...disposition, located: false, kind: null, evidence: [], ...(mode ? { mode } : {}) };
    }
    const runCheck = options.runCheck ?? ((toRun) => defaultRunCheck(toRun, options.cwd ?? process.cwd(), options.timeoutMs));
    const proveFailFirst = options.proveFailFirst ?? ((toProve) => defaultProveFailFirst(toProve, options.cwd ?? process.cwd(), options.timeoutMs));
    // (2) PROVE fail-first (MACHINE) + RUN. The prover must INDEPENDENTLY run the check against the
    // descriptor's violation fixture and observe it go red (`proof.provenFailFirst`), AND the runner
    // must observe a genuine NON-VACUOUS pass. Caller attestation (`c.failFirst`) is NOT consulted for
    // the green verdict (FF-08) — a check that cannot be machine-proven fail-first hard-gates (never
    // green) in BOTH modes, even if attested.
    // No-throw contract end-to-end: even a (test-injected) prover/runner that throws must fail closed,
    // never propagate. The default real prover/runner already never throw.
    let proof;
    try {
        proof = proveFailFirst(c);
    }
    catch {
        proof = { provenFailFirst: false };
    }
    let run;
    try {
        run = runCheck(c);
    }
    catch {
        run = { passed: false };
    }
    // The `&&` and `=== true` are mutation-load-bearing — both directions (proven-red AND clean-pass)
    // must hold for green; Plan 01/02 guards pin them.
    const passed = proof.provenFailFirst === true && run.passed === true;
    if (!passed) {
        // NOT machine-proven fail-first OR did not genuinely pass -> fail-closed, located: true (an actual
        // located miss/fail). Hard-gate applies in BOTH modes; the disposition stays non-green / flagged.
        const disposition = (0, probe_core_cjs_1.dispositionForProhibition)(prohibition, { enforcementEvidence: [] });
        return {
            ...disposition,
            located: true,
            kind: c.kind,
            evidence: [],
            ...(mode ? { mode } : {}),
        };
    }
    // (3) PASS -> build typed enforcementEvidence and let the policy flip a test-tier item green.
    // `failFirst: true` here means MACHINE-PROVEN (the green AND required `proof.provenFailFirst`),
    // and `failFirstProof` records HOW it was proven (FF-07).
    const evidence = [{
            kind: c.kind,
            target: c.target,
            ...(typeof c.rule === 'string' ? { rule: c.rule } : {}),
            failFirst: true,
            passed: true,
            ...(proof.method ? { failFirstProof: proof.method } : {}),
        }];
    const disposition = (0, probe_core_cjs_1.dispositionForProhibition)(prohibition, { enforcementEvidence: evidence });
    return {
        ...disposition,
        located: true,
        kind: c.kind,
        evidence,
        ...(mode ? { mode } : {}),
    };
}
