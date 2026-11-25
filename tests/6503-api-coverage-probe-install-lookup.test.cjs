'use strict';

/**
 * 6503-api-coverage-probe-install-lookup.test.cjs — the plan:pre API-coverage
 * probe must run on a global install, and say so when it cannot.
 *
 * #6503: the contribution's detector call was cwd-relative
 * (`node gsd-core/bin/lib/api-coverage.cjs`), so in a project without a local
 * gsd-core/ folder node failed, `2>/dev/null` swallowed the error, and the
 * fragment skipped the checkpoint as probe_unavailable. These rows run the
 * shipped snippet itself from an empty cwd against a fake global install, pin
 * the visible error when the install is missing, pin exit-1-as-verdict, the
 * 200-character reason limit, the post-write verify-pre instruction, and the
 * generated copies.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FRAGMENT = path.join(ROOT, 'capabilities', 'ai-integration', 'fragments', 'api-coverage-plan-pre.md');
const REFERENCES = path.join(ROOT, 'gsd-core', 'references', 'api-coverage.md');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');

// The shipped detector plus its require closure — what a global install has.
const DETECTOR_CLOSURE = [
  'api-coverage.cjs',
  'markdown-sectionizer.cjs',
  'pattern.cjs',
  'cli-exit.cjs',
  'exit-code-registry.cjs',
  path.join('vendor', 're2js.cjs'),
];

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

// A fake global install: <home>/gsd-core/bin/gsd-tools.cjs + lib/<closure>.
function makeFakeInstall(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), '6503-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'gsd-core', 'bin');
  for (const rel of DETECTOR_CLOSURE) {
    const dest = path.join(bin, 'lib', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(LIB, rel), dest);
  }
  // The snippet only resolves this path's directory; the shim itself is not run.
  fs.writeFileSync(path.join(bin, 'gsd-tools.cjs'), '');
  return path.join(bin, 'gsd-tools.cjs');
}

// Run the shipped snippet with the preamble variables the planner shell
// provides. cwd holds no gsd-core/ folder — the global-install layout.
function runSnippet(t, { gsdTools, planBody }) {
  const phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), '6503-phase-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), '6503-proj-'));
  t.after(() => fs.rmSync(phaseDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), planBody);
  const script = ['gsd_run() { :; }', detectSnippet(), "printf '%s' \"$API_COVERAGE_JSON\""].join('\n');
  const res = spawnSync('/bin/sh', ['-c', script], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, GSD_TOOLS: gsdTools, PHASE: '01', PHASE_DIR: phaseDir },
  });
  let payload = null;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    payload = null;
  }
  return { res, payload };
}

test('global install: API-integrating scope yields detected:true, not probe_unavailable (AC1)', (t) => {
  const gsdTools = makeFakeInstall(t);
  const { res, payload } = runSnippet(t, {
    gsdTools,
    planBody: '# Plan\n\nIntegrate the Stripe API for card payments.\n',
  });
  assert.ok(payload, `expected a JSON payload, stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  assert.notEqual(payload.reason, 'probe_unavailable', 'the probe must run from a global install');
  assert.equal(payload.detected, true);
});

test('missing install: the snippet prints a visible error, not a silent skip (AC2)', (t) => {
  const { res, payload } = runSnippet(t, {
    gsdTools: path.join(os.tmpdir(), '6503-absent-install', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    planBody: '# Plan\n\nIntegrate the Stripe API for card payments.\n',
  });
  assert.match(res.stderr, /api-coverage detector did not run/);
  assert.equal(payload ? payload.reason : null, 'probe_unavailable');
});

test('no-signal scope: the detector exit 1 is still a verdict — detected:false (AC3)', (t) => {
  const gsdTools = makeFakeInstall(t);
  const { payload } = runSnippet(t, {
    gsdTools,
    planBody: '# Plan\n\nRefactor the internal settings module; no external surface.\n',
  });
  assert.ok(payload, "the payload must survive the detector's exit 1");
  assert.notEqual(payload.skipped, true);
  assert.equal(payload.detected, false);
});

test('the call site resolves through $GSD_TOOLS, never a cwd-relative path', () => {
  const snippet = detectSnippet();
  assert.match(snippet, /\$\{GSD_TOOLS%\/\*\}\/lib\/api-coverage\.cjs/);
  assert.ok(!snippet.includes('node gsd-core/bin/lib'), 'the snippet must not call the detector cwd-relative');
});

test('contribution states the 200-character limit for both reason kinds (AC4)', () => {
  const text = fragmentText();
  assert.match(text, /one-line reason of at most 200 characters/);
  assert.match(text, /rejects reasons over 200 characters/);
  assert.match(text, /reason is required, exactly like an `OPT-OUT` reason, and at most 200 characters/);
});

test('probe_unavailable is reported to the user; verify-pre runs after writing COVERAGE.md (AC4)', () => {
  const text = fragmentText();
  const skipped = text.slice(text.indexOf('**If `skipped` is `true`:**'));
  assert.match(skipped.slice(0, 1200), /probe_unavailable[\s\S]{0,400}report this to the user/i);
  assert.match(skipped.slice(0, 1200), /do not raise those with the user/);
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
  assert.ok(refs.includes('"${GSD_TOOLS%/*}/lib/api-coverage.cjs"'), 'references must show the resolved call');
  assert.ok(!refs.includes('node gsd-core/bin/lib/api-coverage.cjs'), 'references must not keep the cwd-relative call');
  assert.match(refs, /at most 200 characters/);
});
