'use strict';

/**
 * 6503-api-coverage-probe-install-lookup.test.cjs — the plan:pre API-coverage
 * probe must run on a global install, and say so when it cannot.
 *
 * #6503: the contribution's detector call was cwd-relative
 * (`node gsd-core/bin/lib/api-coverage.cjs`), so in a project without a local
 * gsd-core/ folder node failed, `2>/dev/null` swallowed the error, and the
 * fragment skipped the checkpoint as probe_unavailable. These rows run the
 * shipped snippet — which now resolves the detector the way the gsd_run
 * launcher itself does — from an empty cwd against every install layout:
 * same-shell $GSD_TOOLS, a PATH-inherited gsd_run, an npm-style symlinked
 * global bin, and no install at all (the visible error). PATH holds ONLY the
 * fixture bin plus a symlink to this very node: a runner-installed gsd_run
 * must never turn a failing case green.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { runHook, OUTCOME, DEFAULT_TIMEOUT_MS } = require('./helpers/process-seam.cjs');

const ROOT = path.join(__dirname, '..');
const FRAGMENT = path.join(ROOT, 'capabilities', 'ai-integration', 'fragments', 'api-coverage-plan-pre.md');
const REFERENCES = path.join(ROOT, 'gsd-core', 'references', 'api-coverage.md');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const GSD_RUN = path.join(ROOT, 'gsd-core', 'bin', 'gsd_run');

function fragmentText() {
  return fs.readFileSync(FRAGMENT, 'utf8');
}

// The first ```bash block under "## Detect whether" — the shipped call site.
function detectSnippet() {
  const text = fragmentText();
  const heading = text.indexOf('## Detect whether');
  assert.notEqual(heading, -1, 'fragment must keep its "## Detect whether" section');
  const open = text.indexOf('```bash', heading);
  assert.notEqual(open, -1, 'the section must carry a bash block');
  const bodyStart = text.indexOf('\n', open) + 1;
  const close = text.indexOf('```', bodyStart);
  assert.notEqual(close, -1, 'the bash block must be closed');
  return text.slice(bodyStart, close);
}

const skipOnWindows = (t) => {
  if (process.platform !== 'win32') return false;
  t.skip('the snippet is executed through POSIX sh; the Windows install layouts are pinned by the conformance tiers, not executed here');
  return true;
};

// A fake global install: <home>/gsd-core/bin/{gsd_run, gsd-tools.cjs, lib/**}.
// The whole lib/ ships in a real install and the detector's require closure
// stays intact however it grows, so the fixture copies it wholesale.
function makeFakeInstall(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '6503-home-'));
  t.after(() => cleanup(home));
  const bin = path.join(home, 'gsd-core', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.cpSync(LIB, path.join(bin, 'lib'), { recursive: true });
  fs.copyFileSync(GSD_RUN, path.join(bin, 'gsd_run'));
  // The snippet never executes the shim's logic; an empty gsd-tools.cjs keeps
  // the snippet's `gsd_run query …` sub-call silent (exit 0, no output).
  fs.writeFileSync(path.join(bin, 'gsd-tools.cjs'), '');
  return bin;
}

// Run the shipped snippet in a POSIX sh whose PATH holds ONLY `pathDirs`, a
// directory containing just a symlink to this very node, and the system bins.
function runSnippet(t, { gsdTools, pathDirs, planBody }) {
  const phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), '6503-phase-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '6503-proj-'));
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), '6503-node-'));
  t.after(() => cleanup(phaseDir));
  t.after(() => cleanup(projectDir));
  t.after(() => cleanup(nodeDir));
  fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), planBody);
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  const scriptFile = path.join(nodeDir, 'snippet.sh');
  fs.writeFileSync(scriptFile, `${detectSnippet()}\nprintf '%s' "$API_COVERAGE_JSON"\n`);
  const res = runHook(scriptFile, [], {
    interpreter: 'sh',
    cwd: projectDir,
    env: {
      PATH: [...pathDirs, nodeDir, '/bin', '/usr/bin'].join(path.delimiter),
      PHASE: '01',
      PHASE_DIR: phaseDir,
      ...(gsdTools === undefined ? {} : { GSD_TOOLS: gsdTools }),
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  assert.strictEqual(res.outcome, OUTCOME.EXITED, `snippet runner outcome: ${res.outcome}`);
  let payload = null;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    payload = null;
  }
  return { res, payload };
}

const API_PLAN = '# Plan\n\nIntegrate the Stripe API for card payments.\n';

test('same-shell install ($GSD_TOOLS): API-integrating scope yields detected:true (AC1)', (t) => {
  if (skipOnWindows(t)) return;
  const bin = makeFakeInstall(t);
  const { res, payload } = runSnippet(t, {
    gsdTools: path.join(bin, 'gsd-tools.cjs'),
    pathDirs: [],
    planBody: API_PLAN,
  });
  assert.ok(payload, `expected a JSON payload, stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  assert.notEqual(payload.reason, 'probe_unavailable', 'the probe must run from a global install');
  assert.equal(payload.detected, true);
});

test('later shell (PATH-inherited gsd_run): API-integrating scope yields detected:true (AC1)', (t) => {
  if (skipOnWindows(t)) return;
  // The workflow preamble exports only PATH (the gsd_run launcher's dir), not
  // GSD_TOOLS — this is the layout a real later bash block sees.
  const bin = makeFakeInstall(t);
  const { payload } = runSnippet(t, { gsdTools: '', pathDirs: [bin], planBody: API_PLAN });
  assert.equal(payload ? payload.detected : null, true);
});

test('npm-style global install (symlinked gsd_run on PATH): detected:true (AC1)', (t) => {
  if (skipOnWindows(t)) return;
  const bin = makeFakeInstall(t);
  const globalBin = fs.mkdtempSync(path.join(os.tmpdir(), '6503-global-'));
  t.after(() => cleanup(globalBin));
  fs.symlinkSync(path.join(bin, 'gsd_run'), path.join(globalBin, 'gsd_run'));
  const { payload } = runSnippet(t, { gsdTools: '', pathDirs: [globalBin], planBody: API_PLAN });
  assert.equal(payload ? payload.detected : null, true);
});

test('missing install: the snippet prints a visible error, not a silent skip (AC2)', (t) => {
  if (skipOnWindows(t)) return;
  const { res, payload } = runSnippet(t, { gsdTools: '', pathDirs: [], planBody: API_PLAN });
  assert.match(res.stderr, /api-coverage detector did not run/);
  assert.equal(payload ? payload.reason : null, 'probe_unavailable');
});

test('no-signal scope: the detector exit 1 is still a verdict — detected:false (AC3)', (t) => {
  if (skipOnWindows(t)) return;
  const bin = makeFakeInstall(t);
  const { payload } = runSnippet(t, {
    gsdTools: path.join(bin, 'gsd-tools.cjs'),
    pathDirs: [],
    planBody: '# Plan\n\nRefactor the internal settings module; no external surface.\n',
  });
  assert.ok(payload, "the payload must survive the detector's exit 1");
  assert.notEqual(payload.skipped, true);
  assert.equal(payload.detected, false);
});

test('the call site resolves through the gsd_run launcher, never a cwd-relative path', () => {
  const snippet = detectSnippet();
  assert.match(snippet, /command -v gsd_run/);
  assert.match(snippet, /lib\/api-coverage\.cjs/);
  assert.ok(!snippet.includes('node gsd-core/bin/lib'), 'the snippet must not call the detector cwd-relative');
});

test('contribution states the 200-character limit for both reason kinds (AC4)', () => {
  const text = fragmentText();
  assert.match(text, /one-line reason of at most 200\s+characters/);
  assert.match(text, /rejects reasons over 200\s+characters/);
  assert.match(text, /reason is required, exactly like an `OPT-OUT` reason, and at most 200\s+characters/);
});

test('probe_unavailable is reported to the user; verify-pre runs after writing COVERAGE.md (AC4)', () => {
  const text = fragmentText();
  const skipped = text.slice(text.indexOf('**If `skipped` is `true`:**'));
  assert.match(skipped.slice(0, 1200), /probe_unavailable[\s\S]{0,400}report this to the\s+user/i);
  assert.match(skipped.slice(0, 1200), /do not raise those with the\s+user/);
  assert.match(text, /gsd_run check api-coverage\.verify-pre "\$\{PHASE_DIR\}"/);
});

test('generated copies stay in sync with the fragment (AC5)', () => {
  const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') {
      strings.push(value);
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(registry);
  const inlines = strings.filter((s) => s.includes('API_COVERAGE_JSON'));
  assert.ok(inlines.length >= 1, 'the registry must carry the inline copy of the contribution');
  for (const one of inlines) {
    assert.equal(one.trimEnd(), fragmentText().trimEnd(), 'registry inline copy diverged from the fragment');
  }
  const refs = fs.readFileSync(REFERENCES, 'utf8');
  assert.ok(!refs.includes('node gsd-core/bin/lib/api-coverage.cjs'), 'references must not keep the cwd-relative call');
  assert.ok(refs.includes('lib/api-coverage.cjs'), 'references must document the resolved call');
  assert.match(refs, /gsd_run launcher/);
  assert.match(refs, /at most 200\s+characters/);
});
