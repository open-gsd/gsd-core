'use strict';
// Nothing here reads a source module of the kinds no-source-grep tracks
// (.cjs/.cts/.js/.mjs/.mts/.ts), so there is no site to suppress and the file
// carries no allow-test-rule marker.

/**
 * workflow.ui_interaction_capture — #4223
 *
 * Enhancement shape approved at triage: a new default-off key on the EXISTING
 * `ui` capability (ADR-894's one-owner invariant — `ui` already owns
 * gsd-ui-auditor, so no new capability directory may claim it), with the
 * auditor's <screenshot_approach> branching on it and falling back to today's
 * Playwright-only path when the key is off or no Chrome binary resolves.
 *
 * Risk zone under test (in order):
 *   1. Containment — with the key off, or no Chrome, or no dev server, the
 *      driver is never invoked and the static path is untouched.
 *   2. The key must not parse-and-do-nothing: the orchestrator reads it and
 *      hands it down; the registry, schema and config layers all know it.
 *   3. Lifecycle honesty — the daemon is stopped whenever it was started (trapped,
 *      not merely placed last), a failed capture is never counted, and the status
 *      line says what happened.
 *   4. Bounded and confined — every driver call runs under a ceiling (a hung
 *      npx fetch or Chrome launch cannot wedge the audit), and the driver may
 *      write only under the capture directory (--workspace, never
 *      --allowUnrestrictedPaths).
 *   5. The gitignore gate covers the capture directory as a whole, and an
 *      existing .gitignore is upgraded rather than left as written.
 *
 * The auditor carries no gsd_run resolver, so the key travels through the
 * <config> block /gsd-ui-review builds; the fence under test consumes the
 * INTERACTION_CAPTURE, SCREENSHOT_DIR and DEV_URL variables the surrounding
 * prose defines and is executed here under bash with a stub driver on PATH.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// The stub driver never blocks, so one fence run is a handful of sh spawns; distinct
// from PROBE (a single probe) and BUILD (a compiler) — its own class, bounded generously.
const FENCE_RUN_TIMEOUT_MS = 30000;

const realRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CAP_ID = 'ui';
const KEY = 'workflow.ui_interaction_capture';
const AGENT = 'gsd-ui-auditor';

const AUDITOR_PATH = path.join(REPO_ROOT, 'agents', `${AGENT}.md`);
const UI_REVIEW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'ui-review.md');
const MANIFEST_PATH = path.join(REPO_ROOT, 'capabilities', CAP_ID, 'capability.json');
const DOCS_CONFIG_PATH = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');
const HOWTO_PATH = path.join(REPO_ROOT, 'docs', 'how-to', 'enable-ui-interaction-capture.md');

const OPEN_ANCHOR = '<!-- gsd:ui-interaction-capture -->';
const CLOSE_ANCHOR = '<!-- /gsd:ui-interaction-capture -->';
const FENCE = '`'.repeat(3);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * The bash fences inside <screenshot_approach>, split into the static block
 * (before the interaction anchor) and the interaction block (inside it).
 * Line-based on purpose: no unbounded regex over file content, no ad-hoc
 * markdown parsing, and splitLines() handles CRLF checkouts.
 */
function screenshotApproachFences() {
  const lines = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf8'));
  const out = { static: [], interaction: [] };
  let inSection = false;
  let inInteraction = false;
  let inFence = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.includes('<screenshot_approach>')) inSection = true;
      continue;
    }
    if (line.includes('</screenshot_approach>')) break;
    if (line.includes(OPEN_ANCHOR)) { inInteraction = true; continue; }
    if (line.includes(CLOSE_ANCHOR)) { inInteraction = false; continue; }
    if (!inFence) {
      if (line.trim() === `${FENCE}bash`) inFence = true;
      continue;
    }
    if (line.trim() === FENCE) { inFence = false; continue; }
    (inInteraction ? out.interaction : out.static).push(line);
  }
  assert.ok(out.static.length > 0, '<screenshot_approach> must keep its static bash fence');
  assert.ok(out.interaction.length > 0, `${OPEN_ANCHOR} must wrap a bash fence`);
  return out;
}

describe('ui capability owns workflow.ui_interaction_capture', () => {
  test('manifestDeclaresTheKeyAsADefaultOffBoolean', () => {
    const cap = readManifest();
    const slice = cap.config[KEY];
    assert.ok(slice, `${MANIFEST_PATH} must declare ${KEY}`);
    assert.equal(slice.type, 'boolean');
    assert.equal(slice.default, false, 'the approved shape is default-off');
    assert.ok(typeof slice.description === 'string' && slice.description.length > 0);
  });

  test('theKeyLivesOnTheCapabilityThatAlreadyOwnsTheAuditor', () => {
    // ADR-894 one-owner invariant: a NEW capability directory could not also
    // claim gsd-ui-auditor, which is why triage required the existing manifest.
    const cap = readManifest();
    assert.ok(cap.agents.includes(AGENT), `${CAP_ID} must own ${AGENT}`);
    assert.equal(realRegistry.byAgent[AGENT], CAP_ID, 'the generated registry must agree on the owner');
    assert.equal(cap.activationKey, undefined,
      'the key gates one section of one agent, never the whole ui capability');
  });

  test('generatedRegistryCarriesTheSliceUnderTheUiOwner', () => {
    const entry = realRegistry.configSchema[KEY];
    assert.ok(entry, 'capability-registry.cjs must be regenerated after the manifest change');
    assert.equal(entry.owner, CAP_ID);
    assert.equal(entry.type, 'boolean');
    assert.equal(entry.default, false);
    assert.deepEqual(realRegistry.capabilities[CAP_ID].config[KEY], readManifest().config[KEY]);
  });

  test('configSchemaAcceptsTheKey', () => {
    assert.equal(isValidConfigKey(KEY), true);
  });
});

describe('config layer round-trips the key', () => {
  test('configSetAcceptsAndPersistsTrue', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(`config-set ${KEY} true`, tmpDir);
    assert.ok(result.success, `config-set must accept ${KEY}: ${result.error}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf8'));
    assert.equal(cfg.workflow?.ui_interaction_capture, true);
  });

  test('configSetRejectsANonBoolean', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const result = runGsdTools(`config-set ${KEY} banana`, tmpDir);
    assert.ok(!result.success, 'a boolean slice must reject a non-boolean');
  });

  test('absentKeyResolvesToFalse', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    assert.equal(loadConfig(tmpDir).workflow?.ui_interaction_capture, false);
  });

  for (const [label, value] of [['stringTrue', '"true"'], ['numberOne', '1'], ['nullValue', 'null']]) {
    test(`handWrittenNonBooleanResolvesToFalse_${label}`, (t) => {
      const tmpDir = createTempProject();
      t.after(() => cleanup(tmpDir));
      fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'),
        `{"workflow":{"ui_interaction_capture":${value}}}`);
      assert.equal(loadConfig(tmpDir).workflow?.ui_interaction_capture, false,
        `${label} must fall to the slice default, not survive as truthy`);
    });
  }
});

describe('/gsd-ui-review hands the key to the auditor', () => {
  test('orchestratorReadsTheKeyAndPassesItInTheConfigBlock', () => {
    const src = fs.readFileSync(UI_REVIEW_PATH, 'utf8');
    assert.ok(src.includes(`config-get ${KEY}`), 'ui-review.md must read the key through gsd_run');
    // Lowercase placeholder, like the block's `{phase_dir}` / `{padded_phase}` siblings —
    // the block is a prompt template the orchestrator fills, not a bash heredoc.
    assert.ok(src.includes('interaction_capture: {interaction_capture}'),
      'the spawn prompt <config> block must carry interaction_capture');
    // Normalised to a literal true/false before it is handed down, so the
    // auditor's fence only ever compares against "true".
    assert.ok(src.includes('[ "$INTERACTION_CAPTURE" = "true" ] || INTERACTION_CAPTURE="false"'));
  });

  test('auditorNeverReadsConfigItself', () => {
    // The auditor carries no gsd_run resolver; the key must arrive by value.
    const src = fs.readFileSync(AUDITOR_PATH, 'utf8');
    // Prose may NAME gsd_run (this section explains why it is absent); an invocation
    // or a resolver definition is what must not appear.
    assert.ok(!/gsd_run (query|runtime-identity)|gsd_run\(\)/.test(src),
      'gsd-ui-auditor.md must not grow a gsd_run dependency for this');
    assert.ok(src.includes('interaction_capture'), 'the auditor must name the <config> field it consumes');
  });
});

describe('<screenshot_approach> keeps the two paths apart', () => {
  test('staticFenceIsPlaywrightOnlyAndInteractionFenceIsChromeDevtoolsOnly', () => {
    const { static: staticFence, interaction } = screenshotApproachFences();
    const staticText = staticFence.join('\n');
    const interactionText = interaction.join('\n');
    assert.ok(staticText.includes('npx playwright screenshot'), 'the static path stays on Playwright');
    assert.ok(!staticText.includes('chrome-devtools'),
      'the static fence must not reference the driver — key off means today\'s path, byte for byte');
    assert.ok(interactionText.includes('chrome-devtools'));
    assert.ok(!interactionText.includes('playwright'),
      'the interaction fence adds captures; it never replaces the Playwright ones');
  });

  test('interactionFenceGatesOnTheHandedDownValueAndAChromeBinary', () => {
    const text = screenshotApproachFences().interaction.join('\n');
    assert.ok(text.includes('if [ "$INTERACTION_CAPTURE" != "true" ]'));
    assert.ok(text.includes('elif [ -z "$CHROME_BIN" ]'));
    assert.ok(text.includes('--isolated'), 'a throwaway profile, never the shared chrome-devtools-mcp one');
    assert.ok(text.includes('--workspace "$INTERACTION_DIR"'), 'the driver is confined to the capture directory');
    const code = screenshotApproachFences().interaction.filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!code.includes('--allowUnrestrictedPaths'), 'deprecated in 1.9.0, and it lifts every path restriction');
    assert.ok(text.includes('--usageStatistics=false'));
    assert.ok(text.includes('--sessionId $CDT_SESSION'), 'a per-run daemon session, so audits never stop each other');
  });
});

// ---------------------------------------------------------------------------
// Behavioural: run the interaction fence under bash with a stub driver on PATH.
// ---------------------------------------------------------------------------

const HAS_BASH = (() => {
  const r = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return !r.error && r.status === 0;
})();

/** Absolute paths of the coreutils the fence needs, so PATH can hold only the stubs. */
function coreutilPaths() {
  const r = spawnSync('bash', ['-c', 'for c in sed head mkdir rm tr date sleep; do command -v "$c" || exit 1; done'],
    { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  assert.equal(r.status, 0, `coreutils must resolve: ${r.stderr}`);
  const [sed, head, mkdir, rm, tr, date, sleep] = r.stdout.trim().split(/\r?\n/);
  return { sed, head, mkdir, rm, tr, date, sleep };
}

const STUB_NPX = `#!/bin/sh
# argv: -y -p chrome-devtools-mcp@<range> chrome-devtools --sessionId <hex-id> <cmd> [args...]
printf '%s\\n' "$*" >> "$STUB_LOG"
[ "$1" = "-y" ] && [ "$2" = "-p" ] && [ "$4" = "chrome-devtools" ] && [ "$5" = "--sessionId" ] || { echo "stub npx: unexpected argv: $*" >&2; exit 66; }
case "$6" in *[!0-9a-fA-F-]*|"") echo "stub npx: sessionId not hex/dashes: $6" >&2; exit 68 ;; esac
cmd="$7"
shift 7
# STUB_HANG=<verb>: that verb never returns — the fence's ceiling is what ends it. Deliberately a
# CHILD holding stdout under this sh (the npx -> sh -> client shape), never an exec: a kill that
# reaches only this pid leaves the child blocking the fence's $(...) capture.
[ "\${STUB_HANG:-}" = "$cmd" ] && { "$STUB_SLEEP" 300; exit 0; }
[ "\${STUB_ORPHAN:-}" = "$cmd" ] && { "$STUB_SLEEP" 300 & exit 0; }
[ -n "\${STUB_DELAY:-}" ] && "$STUB_SLEEP" "$STUB_DELAY"
case "$cmd" in
  resize_page)
    [ "\${STUB_FAIL_RESIZE:-0}" = 1 ] && exit 1
    exit 0 ;;
  start)
    [ "\${STUB_FAIL_START:-0}" = 1 ] && exit 1
    exit 0 ;;
  new_page)
    if [ "\${STUB_FAIL_NEWPAGE:-0}" = 1 ]; then printf '## Pages\\n1: about:blank\\n'; exit 0; fi
    nl='\\n'; [ "\${STUB_CRLF:-0}" = 1 ] && nl='\\r\\n'
    printf "## Pages\${nl}1: about:blank\${nl}2: %s [selected]\${nl}" "$1"
    exit "\${STUB_NEWPAGE_RC:-0}" ;;
  press_key)
    [ "\${STUB_FAIL_PRESS:-0}" = 1 ] && exit 1
    exit 0 ;;
  take_screenshot|take_snapshot)
    f=""
    while [ $# -gt 0 ]; do [ "$1" = "--filePath" ] && f="$2"; shift; done
    [ -n "$f" ] || { echo "stub: $cmd without --filePath" >&2; exit 67; }
    if [ "$cmd" = take_screenshot ] && [ "\${STUB_FAIL_SCREENSHOT:-0}" = 1 ]; then : > "$f"; exit 1; fi
    if [ "$cmd" = take_snapshot ] && [ "\${STUB_FAIL_SNAPSHOT:-0}" = 1 ]; then exit 1; fi
    printf 'STUB' > "$f"; exit 0 ;;
  *) exit 0 ;;
esac
`;

/**
 * Run the interaction fence. `opts.chrome` puts a stub google-chrome on PATH;
 * `opts.env` is merged over the minimal environment. Returns stdout, the
 * driver invocation log (one argv line per call) and the final status value.
 */
function runInteractionFence(t, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-interaction-'));
  t.after(() => cleanup(tmp));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), STUB_NPX, { mode: 0o755 });
  if (opts.chrome) fs.writeFileSync(path.join(bin, 'google-chrome'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const log = path.join(tmp, 'driver.log');
  fs.writeFileSync(log, '');
  const cu = coreutilPaths();
  // The fence's watchdog is an exec'd bash that resolves `sleep` through the EXPORTED PATH, where a
  // shell function is invisible — so PATH is exported below, and the stub dir carries `sleep` as a
  // portable exec-wrapper script (an exec keeps the pid, so a kill aimed at it reaches the real sleep).
  // `opts.brokenSleep`: that clock cannot launch (stands in for an msys fork failure under load).
  fs.writeFileSync(path.join(bin, 'sleep'),
    opts.brokenSleep ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nexec ${JSON.stringify(cu.sleep)} "$@"\n`, { mode: 0o755 });
  // Functions are looked up before PATH on every platform, so the fence sees
  // real coreutils while PATH holds nothing but the stubs (#4176's harness note).
  const script = [
    '#!/bin/bash',
    `export PATH=${JSON.stringify(bin)}`,
    `sed() { ${JSON.stringify(cu.sed)} "$@"; }`,
    `head() { ${JSON.stringify(cu.head)} "$@"; }`,
    `mkdir() { ${JSON.stringify(cu.mkdir)} "$@"; }`,
    `rm() { ${JSON.stringify(cu.rm)} "$@"; }`,
    `tr() { ${JSON.stringify(cu.tr)} "$@"; }`,
    `date() { ${JSON.stringify(cu.date)} "$@"; }`,
    // Opt-in strict mode: an agent runner MAY execute the fence under errexit + pipefail,
    // and the unconditional stop must still be reached on a failed navigation.
    ...(opts.strict ? ['set -e -o pipefail'] : []),
    // `opts.failAfter`: a bare failing command right after the first fence line containing
    // it — the future edit the EXIT trap exists for, since no shipped line fails bare today.
    // `opts.injectAfter`: {marker, line} — an arbitrary line after the first fence line
    // containing the marker (the subshell-copy control below).
    ...screenshotApproachFences().interaction.flatMap((line) =>
      (opts.failAfter && line.includes(opts.failAfter)) ? [line, 'false']
        : (opts.injectAfter && line.includes(opts.injectAfter.marker)) ? [line, opts.injectAfter.line]
          : [line]),
    'printf "FINAL_STATUS=%s\\n" "$INTERACTION_STATUS"',
    '',
  ].join('\n');
  const scriptPath = path.join(tmp, 'fence.sh');
  fs.writeFileSync(scriptPath, script);
  const env = {
    STUB_LOG: log,
    STUB_SLEEP: cu.sleep,
    HOME: tmp,
    TMPDIR: tmp,
    ...(opts.env || {}),
  };
  const r = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: FENCE_RUN_TIMEOUT_MS, env, cwd: tmp });
  const calls = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
  const status = (r.stdout.match(/^FINAL_STATUS=(.*)$/m) || [])[1];
  return { tmp, r, calls, status, stdout: r.stdout };
}

function shotsDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-'));
  t.after(() => cleanup(d));
  return d;
}

describe('interaction fence (bash, stub driver)', { skip: HAS_BASH ? false : 'bash not on PATH' }, () => {
  test('keyOffInvokesNothingAndSaysSo', (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, { chrome: true, env: { INTERACTION_CAPTURE: 'false', SCREENSHOT_DIR: dir } });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.deepEqual(out.calls, [], 'the driver must never run with the key off');
    assert.match(out.stdout, /Interaction capture: off/);
    assert.equal(out.status, 'off');
    assert.ok(!fs.existsSync(path.join(dir, 'interaction')), 'no directory is created with the key off');
  });

  test('absentValueMeansOff', (t) => {
    const out = runInteractionFence(t, { chrome: true, env: { SCREENSHOT_DIR: shotsDir(t) } });
    assert.deepEqual(out.calls, []);
    assert.equal(out.status, 'off');
  });

  test('noDevServerSkipsBeforeTouchingTheDriver', (t) => {
    // The static block sets SCREENSHOT_DIR only when it reached a dev server.
    const out = runInteractionFence(t, { chrome: true, env: { INTERACTION_CAPTURE: 'true' } });
    assert.deepEqual(out.calls, []);
    assert.equal(out.status, 'skipped (no dev server reached)');
    assert.match(out.stdout, /reached no dev server/);
  });

  const HOST_HAS_FIXED_PATH_CHROME =
    fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ||
    (process.env.PROGRAMFILES && fs.existsSync(path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')));

  test('noChromeSkipsWithTheRemedyAndInvokesNothing', {
    skip: HOST_HAS_FIXED_PATH_CHROME ? 'host has Chrome at a fixed install path the fence probes' : false,
  }, (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, { chrome: false, env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir } });
    assert.deepEqual(out.calls, [], 'no Chrome means the driver is never fetched or started');
    assert.equal(out.status, 'skipped (no Chrome binary resolved)');
    assert.match(out.stdout, /set CHROME_BIN/);
  });

  test('chromeBinOverrideWinsOverDiscovery', (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, {
      chrome: false,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, CHROME_BIN: '/opt/custom/chrome', DEV_URL: 'http://localhost:5173' },
    });
    const start = out.calls.find((c) => c.includes(' start '));
    assert.ok(start, `start must run: ${out.calls.join(' | ')}`);
    assert.ok(start.includes('-e /opt/custom/chrome'), start);
  });

  test('happyPathDrivesTheLifecycleAndCountsOnlyRealFiles', (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, DEV_URL: 'http://localhost:3999/' },
    });
    assert.equal(out.r.status, 0, out.r.stderr);
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.equal(verbs[0], 'start', 'the daemon starts first');
    assert.equal(verbs[verbs.length - 1], 'stop', 'and is stopped last — it does not self-reap');
    // The workspace and every --filePath are the same path the fence joins with a literal `/`
    // (relative when SCREENSHOT_DIR is — dialect-free on Git Bash, where an absolute msys path
    // would mean nothing to a Windows-native daemon).
    assert.ok(out.calls[0].includes(`--isolated --workspace ${dir}/interaction --usageStatistics=false`), out.calls[0]);
    assert.ok(!out.calls[0].includes('--allowUnrestrictedPaths'), out.calls[0]);
    assert.ok(out.calls[0].includes('-p chrome-devtools-mcp@^1.9.0 '), 'documented floor by default — --workspace needs 1.9.0');
    // Every file the driver is asked to write lies inside the workspace it was confined to.
    for (const c of out.calls.filter((x) => x.includes('--filePath '))) {
      const target = c.split('--filePath ')[1].split(' ')[0];
      assert.ok(target.startsWith(`${dir}/interaction/`), `write outside the workspace: ${c}`);
    }
    assert.equal(verbs.filter((v) => v === 'stop').length, 1, 'stop is issued exactly once — never from a subshell copy');
    assert.ok(out.calls.some((c) => c.includes(' new_page http://localhost:3999/ --timeout 30000')), 'navigates to the resolved dev URL, time-bounded');
    const sessions = new Set(out.calls.map((c) => c.split(' ')[5]));
    assert.equal(sessions.size, 1, `every call must address one daemon session: ${[...sessions].join(',')}`);
    assert.match([...sessions][0], /^[0-9]+-[0-9]+-[0-9]+$/,
      'epoch-BASHPID-RANDOM, every part present — the CLI accepts hex and dashes only');
    // Every later command addresses the page new_page marked [selected].
    for (const c of out.calls.filter((x) => / (resize_page|take_snapshot|take_screenshot|press_key|list_console_messages) /.test(x))) {
      assert.ok(/ (resize_page|take_snapshot|take_screenshot|press_key|list_console_messages) 2( |$)/.test(c), `pageId 2 expected: ${c}`);
    }
    assert.ok(out.calls.some((c) => c.includes(' resize_page 2 1440 900')));
    assert.ok(out.calls.some((c) => c.includes(' press_key 2 Tab')), 'the focus-ring interaction always runs');
    const idir = path.join(dir, 'interaction');
    for (const f of ['baseline.png', 'focus-first.png', 'snapshot.txt', 'console.txt']) {
      assert.ok(fs.existsSync(path.join(idir, f)), `${f} must exist`);
    }
    // The fence joins with a literal `/` ("$SCREENSHOT_DIR/interaction"); path.join would
    // put a backslash there on Windows and the strings would differ by separator alone.
    assert.equal(out.status, `captured (2 state(s), 0 failed) in ${dir}/interaction`);
  });

  test('versionOverrideFlowsIntoTheNpxSpec', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), CHROME_DEVTOOLS_MCP_VERSION: '9.9.9' },
    });
    assert.ok(out.calls[0].includes('-p chrome-devtools-mcp@9.9.9 '), out.calls[0]);
  });

  test('devUrlDefaultsToTheStaticBlocksPort', (t) => {
    const out = runInteractionFence(t, { chrome: true, env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t) } });
    assert.ok(out.calls.some((c) => c.includes(' new_page http://localhost:3000')), out.calls.join(' | '));
  });

  test('failedCaptureIsNotCountedLeavesNoFileAndStillStops', (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, STUB_FAIL_SCREENSHOT: '1' },
    });
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.equal(verbs[verbs.length - 1], 'stop');
    assert.equal(out.status, 'not captured (driver or capture failure)');
    assert.ok(!fs.existsSync(path.join(dir, 'interaction', 'baseline.png')), 'a zero-byte capture is removed, not counted');
    assert.match(out.stdout, /interaction capture FAILED: baseline/);
  });

  test('snapshotFailureCountsAsAFailedStepAndRemovesAStaleSnapshot', (t) => {
    const dir = shotsDir(t);
    // A reused directory can hold a snapshot from an earlier run; its uids belong to a
    // page this run never saw.
    fs.mkdirSync(path.join(dir, 'interaction'));
    fs.writeFileSync(path.join(dir, 'interaction', 'snapshot.txt'), 'uid=9_9 stale');
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, STUB_FAIL_SNAPSHOT: '1' },
    });
    assert.match(out.stdout, /interaction step FAILED: take_snapshot/);
    assert.ok(!fs.existsSync(path.join(dir, 'interaction', 'snapshot.txt')), 'stale uids must not survive a failed snapshot');
    assert.match(out.status, /^captured \(2 state\(s\), 1 failed\)/, 'two clean screenshots must not read as 0 failed');
  });

  test('crlfDriverOutputStillYieldsThePageId', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_CRLF: '1' },
    });
    assert.ok(out.calls.some((c) => c.includes(' resize_page 2 1440 900')), `page id must parse from CRLF output: ${out.calls.join(' | ')}`);
    assert.match(out.status, /^captured \(2 state\(s\), 0 failed\)/);
  });

  test('newPageThatPrintsAPageLineButExitsNonZeroIsAFailedNavigation', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_NEWPAGE_RC: '7' },
    });
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.deepEqual(verbs, ['start', 'new_page', 'stop'], 'partial output must not be mistaken for a page id');
    assert.match(out.stdout, /new_page FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('underErrexitAndPipefailAFailedNewPageStillReachesStop', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      strict: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_NEWPAGE_RC: '7' },
    });
    assert.equal(out.r.status, 0, `the block must not abort: ${out.r.stderr}`);
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.deepEqual(verbs, ['start', 'new_page', 'stop']);
  });

  test('underErrexitAndPipefailTheHappyPathIsUnchanged', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      strict: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t) },
    });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.match(out.status, /^captured \(2 state\(s\), 0 failed\)/);
  });

  test('pressKeyFailureCountsAndSkipsTheFocusCapture', (t) => {
    const dir = shotsDir(t);
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, STUB_FAIL_PRESS: '1' },
    });
    assert.match(out.stdout, /interaction step FAILED: press_key Tab/);
    assert.ok(!fs.existsSync(path.join(dir, 'interaction', 'focus-first.png')));
    assert.match(out.status, /^captured \(1 state\(s\), 1 failed\)/);
  });

  test('newPageWithoutASelectedPageStopsTheDaemonAndCapturesNothing', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_FAIL_NEWPAGE: '1' },
    });
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.deepEqual(verbs, ['start', 'new_page', 'stop'], verbs.join(','));
    assert.match(out.stdout, /new_page FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('failedStartNeverIssuesStop', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_FAIL_START: '1' },
    });
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.deepEqual(verbs, ['start'], 'stop only follows a start that succeeded');
    assert.match(out.stdout, /start FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('everyDriverInvocationGoesThroughTheBoundedWrapper', () => {
    // Static: the only bare `$CDT` is the wrapper's own spawn; every call site names a ceiling.
    const lines = screenshotApproachFences().interaction;
    const bare = lines.filter((l) => /\$CDT /.test(l) && !/\$CDT "\$@" &/.test(l) && !/^\s*#/.test(l));
    assert.deepEqual(bare, [], `unbounded driver call(s): ${bare.join(' | ')}`);
    const calls = lines.filter((l) => /(^|[\s(!])cdt /.test(l) && !/^\s*#/.test(l) && !/^\s*cdt\(\)/.test(l));
    assert.ok(calls.length >= 7, `expected the seven driver verbs plus stop through the wrapper, saw ${calls.length}`);
    for (const c of calls) assert.match(c, /cdt "\$CDT_T_(START|STEP)" /, `call without a ceiling: ${c}`);
  });

  test('aHungStartIsKilledAtItsCeilingAndReportedAsAFailedStart', (t) => {
    const started = Date.now();
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_HANG: 'start', CHROME_DEVTOOLS_START_TIMEOUT: '1' },
    });
    // 1 s ceiling + 2 s KILL grace, with slack — never the stub's 300 s or the harness's 30 s cap.
    assert.ok(Date.now() - started < 8000, `the ceiling, not the stub, ended the call (${Date.now() - started} ms)`);
    assert.deepEqual(out.calls.map((c) => c.split(' ')[6]), ['start'], 'a start that never returned is a failed start: no stop');
    assert.match(out.stdout, /start FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('aHungCaptureIsKilledAtItsCeilingAndStopIsStillReached', (t) => {
    const dir = shotsDir(t);
    const started = Date.now();
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: dir, STUB_HANG: 'take_screenshot', CHROME_DEVTOOLS_STEP_TIMEOUT: '1' },
    });
    // two hung captures: 2 x (1 s ceiling + 2 s KILL grace), with slack
    assert.ok(Date.now() - started < 12000, `two hung captures at a 1 s ceiling (${Date.now() - started} ms)`);
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.equal(verbs[verbs.length - 1], 'stop', 'a timed-out step still reaches the stop');
    assert.match(out.stdout, /interaction capture FAILED: baseline/);
    assert.ok(!fs.existsSync(path.join(dir, 'interaction', 'baseline.png')));
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('aHungNewPageWhoseChildHoldsStdoutIsStillCutOffAtTheCeiling', (t) => {
    // new_page is the one verb whose output the fence captures with $(...): the substitution ends
    // only when every writer closes stdout, so killing the driver's parent alone would block here
    // for the stub's full 300 s (measured on the pre-fix wrapper against a real npx tree).
    const started = Date.now();
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_HANG: 'new_page', CHROME_DEVTOOLS_STEP_TIMEOUT: '1' },
    });
    assert.ok(Date.now() - started < 8000, `the process-group kill must release the capture (${Date.now() - started} ms)`);
    assert.deepEqual(out.calls.map((c) => c.split(' ')[6]), ['start', 'new_page', 'stop'], out.calls.join(' | '));
    assert.match(out.stdout, /new_page FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('aNewPageWhoseLeaderExitsWhileAChildHoldsStdoutIsStillCutOffAtTheCeiling', (t) => {
    // The driver's leader exits at once but leaves a child holding the $(...) pipe: the
    // substitution stays open-ended unless the watchdog keeps watching the process GROUP
    // rather than the leader pid it was handed. Negative-controlled: a leader-pid poll stands
    // down the moment the leader is gone and this blocks for the stub's full 300 s.
    const started = Date.now();
    const out = runInteractionFence(t, {
      chrome: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_ORPHAN: 'new_page', CHROME_DEVTOOLS_STEP_TIMEOUT: '1' },
    });
    assert.ok(Date.now() - started < 8000, `the group must be watched, not the leader (${Date.now() - started} ms)`);
    assert.deepEqual(out.calls.map((c) => c.split(' ')[6]), ['start', 'new_page', 'stop'], out.calls.join(' | '));
    assert.match(out.stdout, /new_page FAILED/);
    assert.equal(out.status, 'not captured (driver or capture failure)');
  });

  test('aWatchdogWhoseClockCannotLaunchStandsDownInsteadOfKillingTheStep', (t) => {
    // The watchdog's clock is `sleep`. If it cannot launch (an msys fork failure under load, an
    // absent binary), the watchdog must stand down — never fire at once and kill a healthy driver
    // call. The stub takes a real driver call's shape (a few hundred ms, not the instant exit a
    // premature kill would miss). Negative-controlled: a `sleep & wait $!` watchdog (the trap form
    // this replaced) fires at once here and `start` reads as failed.
    const out = runInteractionFence(t, {
      chrome: true,
      brokenSleep: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_DELAY: '0.3' },
    });
    assert.equal(out.r.status, 0, out.r.stderr);
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.deepEqual([verbs[0], verbs[verbs.length - 1]], ['start', 'stop'], verbs.join(','));
    assert.match(out.status, /^captured \(2 state\(s\), 0 failed\)/, 'a watchdog without a clock must not kill the step');
  });

  test('underErrexitAnAbortAfterStartStillReachesStopThroughTheTrap', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      strict: true,
      failAfter: 'ishot baseline',
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t) },
    });
    assert.notEqual(out.r.status, 0, 'the injected bare failure must abort the block under errexit');
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.equal(verbs[verbs.length - 1], 'stop', `the EXIT trap owes the stop: ${verbs.join(',')}`);
    assert.equal(verbs.filter((v) => v === 'stop').length, 1, 'once — the flag makes the trap a no-op after an in-order stop');
  });

  test('aSubshellCopyOfTheFenceStateNeverIssuesAStop', (t) => {
    // A driver call can run in a subshell that inherits CDT_STARTED=1 (a $(...) capture).
    // A cdt_stop reached in one of them — CI's ubuntu job hit that through a timing race — must be
    // inert: only the shell that installed the EXIT trap may issue the stop. Deterministic stand-in
    // for the race: call cdt_stop from a subshell right after the trap is installed.
    const out = runInteractionFence(t, {
      chrome: true,
      injectAfter: { marker: 'trap cdt_stop EXIT', line: '( cdt_stop )' },
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t) },
    });
    assert.equal(out.r.status, 0, out.r.stderr);
    const verbs = out.calls.map((c) => c.split(' ')[6]);
    assert.equal(verbs.filter((v) => v === 'stop').length, 1, `one stop, from the installing shell only: ${verbs.join(',')}`);
    assert.equal(verbs[1], 'new_page', 'the subshell call must not have stopped the daemon before the capture ran');
    assert.match(out.status, /^captured \(2 state\(s\), 0 failed\)/);
  });

  test('aFailedResizeIsCountedAndTheCapturesStillRun', (t) => {
    const out = runInteractionFence(t, {
      chrome: true,
      strict: true,
      env: { INTERACTION_CAPTURE: 'true', SCREENSHOT_DIR: shotsDir(t), STUB_FAIL_RESIZE: '1' },
    });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.match(out.stdout, /interaction step FAILED: resize_page/);
    assert.match(out.status, /^captured \(2 state\(s\), 1 failed\)/, 'the resize is a step, not the audit');
  });
});

// ---------------------------------------------------------------------------
// The gitignore gate: run it under bash against a fresh and a pre-existing file.
// ---------------------------------------------------------------------------

function gitignoreGateFence() {
  const lines = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf8'));
  const out = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (!inSection) { if (line.includes('<gitignore_gate>')) inSection = true; continue; }
    if (line.includes('</gitignore_gate>')) break;
    if (!inFence) { if (line.trim() === `${FENCE}bash`) inFence = true; continue; }
    if (line.trim() === FENCE) break;
    out.push(line);
  }
  assert.ok(out.length > 0, '<gitignore_gate> must carry a bash fence');
  return out;
}

function runGitignoreGate(t, seed) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-gitignore-'));
  t.after(() => cleanup(tmp));
  if (seed !== undefined) {
    fs.mkdirSync(path.join(tmp, '.planning', 'ui-reviews'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'ui-reviews', '.gitignore'), seed);
  }
  const script = path.join(tmp, 'gate.sh');
  fs.writeFileSync(script, ['#!/bin/bash', 'set -e', ...gitignoreGateFence(), ''].join('\n'));
  const run = () => spawnSync('bash', [script], { encoding: 'utf8', timeout: FENCE_RUN_TIMEOUT_MS, cwd: tmp });
  const read = () => splitLines(fs.readFileSync(path.join(tmp, '.planning', 'ui-reviews', '.gitignore'), 'utf8')).filter(Boolean);
  return { tmp, run, read };
}

describe('gitignore gate (bash)', { skip: HAS_BASH ? false : 'bash not on PATH' }, () => {
  const REQUIRED = ['*.png', '*.webp', '*.jpg', '*.jpeg', '*.gif', '*.bmp', '*.tiff', 'interaction/'];

  test('aFreshFileCoversTheImagesAndTheCaptureDirectory', (t) => {
    const g = runGitignoreGate(t);
    const r = g.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Created \.planning\/ui-reviews\/\.gitignore/);
    const lines = g.read();
    for (const p of REQUIRED) assert.ok(lines.includes(p), `${p} must be ignored`);
    assert.ok(lines.includes('interaction/'), 'snapshot.txt and console.txt are covered by the directory, not by an extension');
  });

  test('anExistingImageOnlyFileGainsTheCaptureDirectoryAndKeepsItsOwnLines', (t) => {
    // The shape every project that ran an audit before interaction capture existed has on disk.
    const seed = '# Screenshot files — never commit binary assets\n*.png\n*.webp\n*.jpg\n*.jpeg\n*.gif\n*.bmp\n*.tiff\n';
    const g = runGitignoreGate(t, seed);
    const r = g.run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Created/, 'an existing file is upgraded in place, never recreated');
    const lines = g.read();
    assert.equal(lines[0], '# Screenshot files — never commit binary assets', 'the user\'s file keeps its own header');
    assert.ok(lines.includes('interaction/'), 'a pre-existing file must not stay image-only');
    assert.equal(lines.filter((l) => l === '*.png').length, 1, 'present patterns are not duplicated');
  });

  test('theGateIsIdempotent', (t) => {
    const g = runGitignoreGate(t);
    assert.equal(g.run().status, 0);
    const once = g.read();
    assert.equal(g.run().status, 0);
    assert.deepEqual(g.read(), once, 'a second run appends nothing');
  });
});

describe('documentation', () => {
  test('configurationMdDocumentsTheKeyAsDefaultOff', () => {
    const row = splitLines(fs.readFileSync(DOCS_CONFIG_PATH, 'utf8'))
      .find((l) => l.startsWith(`| \`${KEY}\``));
    assert.ok(row, `docs/CONFIGURATION.md must carry a row for ${KEY}`);
    assert.ok(row.includes('| boolean |'), row);
    assert.ok(row.includes('| `false` |'), row);
    assert.ok(row.includes('enable-ui-interaction-capture.md'), 'the row must link the how-to');
  });

  test('howToExistsAndNamesBothOffSwitches', () => {
    const src = fs.readFileSync(HOWTO_PATH, 'utf8');
    assert.ok(src.includes(`config-set ${KEY} true`));
    assert.ok(src.includes(`config-set ${KEY} false`));
    assert.ok(src.includes('CHROME_BIN'));
  });

  test('howToNamesTheFloorTheCeilingsAndTheGitignoreCoverage', () => {
    const src = fs.readFileSync(HOWTO_PATH, 'utf8');
    assert.ok(src.includes('`^1.9.0`'), 'the floor the fence resolves by default');
    assert.ok(!src.includes('^1.8.0'), 'no stale floor');
    assert.ok(src.includes('CHROME_DEVTOOLS_START_TIMEOUT'));
    assert.ok(src.includes('CHROME_DEVTOOLS_STEP_TIMEOUT'));
    assert.ok(src.includes('`interaction/`'), 'the directory the gitignore gate covers');
  });
});
