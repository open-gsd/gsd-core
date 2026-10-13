'use strict';

/**
 * Capability contributions to the built-in code reviewer (#4790).
 *
 * A capability could not deliver review guidance to the internal `gsd-code-reviewer`:
 * install rejected `into: "code-reviewer"` at `execute:post` because the execute host
 * published only `executor` and `verifier`, and even an admitted fragment had no
 * receiving boundary (the reviewer prompt rendered no hooks).
 *
 * Covered here, end to end through the shipped CLI and the shipped workflow text:
 *   1. admission   — the generated host contract publishes `code-reviewer` for the execute step,
 *                    in the execution family only
 *   2. install     — a reviewer-targeted contribution installs; wrong targets still fail
 *   3. rendering   — it appears in `loop render-hooks execute:post` activeHooks, and only while
 *                    its capability is active
 *   4. delivery    — the shipped code-review.md assembly reads the active fragments for the
 *                    review's loop point and hands them to the reviewer exactly once, alongside
 *                    (never replacing) `AGENT_SKILLS_REVIEWER`
 *
 * Assertions read typed fields (exit status, JSON envelopes, the delivered string), never prose.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup } = require('./helpers.cjs');
const { spawnSync } = require('node:child_process');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span } = require('./helpers/doc-bash-span.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

const ROOT = path.join(__dirname, '..');
const REVIEW_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

const tmps = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
test.after(() => { for (const d of tmps) cleanup(d); });

const FRAGMENT = 'Report a missing comment on exported functions as REVIEW-CONVENTION.';

function writeCap(id, contribution, config = {}) {
  const src = tmpDir(`rev-contrib-${id}-`);
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify({
    id,
    role: 'feature',
    version: '0.1.0',
    title: id,
    description: 'Reviewer contribution probe.',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.13.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config,
    steps: [],
    contributions: [{ ...contribution, produces: [], consumes: [] }],
    gates: [],
  }, null, 2));
  return src;
}

function makeConsumer(config = { runtime: 'codex', workflow: { code_review: true } }) {
  const cwd = tmpDir('rev-contrib-consumer-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify(config));
  return cwd;
}

function install(src, cwd, home) {
  return runGsdTools(['capability', 'install', src, '--scope', 'project', '--yes', '--raw'], cwd, { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' });
}

function renderHooks(point, cwd, home, extraArgs = []) {
  const r = runGsdTools(['loop', 'render-hooks', point, '--raw', ...extraArgs], cwd, { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' });
  assert.equal(r.success, true, `render-hooks ${point} failed: ${r.error}`);
  return JSON.parse(r.output);
}

const reviewerFragments = (envelope) => envelope.activeHooks
  .filter((h) => h.kind === 'contribution' && h.into === 'code-reviewer')
  .map((h) => h.fragment.inline);

// ─── 1. admission ───────────────────────────────────────────────────────────

describe('the host contract admits the reviewer role (#4790)', () => {
  const byStep = (step) => LOOP_HOST_CONTRACT.find((e) => e.step === step);

  test('the execute step publishes code-reviewer beside executor and verifier', () => {
    assert.deepEqual(byStep('execute').agentRoles, ['executor', 'verifier', 'code-reviewer']);
  });

  test('no other step publishes it (role-family separation, #4740)', () => {
    for (const entry of LOOP_HOST_CONTRACT) {
      if (entry.step === 'execute') continue;
      assert.ok(!entry.agentRoles.includes('code-reviewer'), `${entry.step} must not admit code-reviewer`);
    }
  });
});

// ─── 2 + 3. install and render ──────────────────────────────────────────────

describe('install and render of a reviewer-targeted contribution (#4790)', () => {
  test('the reproduction from the issue installs and renders at execute:post', () => {
    const cwd = makeConsumer();
    const home = tmpDir('rev-contrib-home-');
    const r = install(writeCap('direct-reviewer-probe', { point: 'execute:post', into: 'code-reviewer', fragment: { inline: FRAGMENT } }), cwd, home);
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.equal(JSON.parse(r.output).status, 'installed');
    assert.deepEqual(reviewerFragments(renderHooks('execute:post', cwd, home)), [FRAGMENT]);
  });

  test('control: a planner contribution at plan:pre still installs', () => {
    const cwd = makeConsumer();
    const home = tmpDir('rev-contrib-home-');
    const r = install(writeCap('planner-control', { point: 'plan:pre', into: 'planner', fragment: { inline: FRAGMENT } }), cwd, home);
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
  });

  test('a reviewer contribution at a plan point is still rejected', () => {
    const cwd = makeConsumer();
    const home = tmpDir('rev-contrib-home-');
    const r = install(writeCap('reviewer-at-plan', { point: 'plan:pre', into: 'code-reviewer', fragment: { inline: FRAGMENT } }), cwd, home);
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /agentRoles/);
  });

  test('an orchestrator contribution at execute:post is still rejected (family boundary)', () => {
    const cwd = makeConsumer();
    const home = tmpDir('rev-contrib-home-');
    const r = install(writeCap('orchestrator-at-execute', { point: 'execute:post', into: 'orchestrator', fragment: { inline: FRAGMENT } }), cwd, home);
    assert.equal(r.success, false);
  });

  test('an unknown reviewer-like role is still rejected', () => {
    const cwd = makeConsumer();
    const home = tmpDir('rev-contrib-home-');
    const r = install(writeCap('wrong-target', { point: 'execute:post', into: 'reviewer', fragment: { inline: FRAGMENT } }), cwd, home);
    assert.equal(r.success, false);
  });

  test('a contribution whose activation key is off contributes nothing, and appears once it is on', () => {
    const KEY = 'workflow.reviewer_probe';
    const home = tmpDir('rev-contrib-home-');
    const cwd = makeConsumer();
    const src = writeCap(
      'reviewer-gated',
      { point: 'execute:post', into: 'code-reviewer', when: KEY, fragment: { inline: FRAGMENT } },
      { [KEY]: { type: 'boolean', default: false, description: 'Gate for the reviewer contribution probe.' } },
    );
    const r = install(src, cwd, home);
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.deepEqual(reviewerFragments(renderHooks('execute:post', cwd, home)), [], 'off by default');

    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), JSON.stringify({ runtime: 'codex', workflow: { code_review: true, reviewer_probe: true } }));
    assert.deepEqual(reviewerFragments(renderHooks('execute:post', cwd, home)), [FRAGMENT], 'on when its key is on');
  });
});

// ─── 4. delivery ────────────────────────────────────────────────────────────

/**
 * The shipped bash fence in code-review.md that gathers reviewer contributions, run for real with
 * `gsd_run` stubbed. The stub serves the config and hook envelopes a test supplies, so the fence's
 * own logic (point resolution, filtering, wrapping, overflow handling) is what is under test.
 */
function reviewWorkflowText() {
  return fs.readFileSync(REVIEW_WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

function reviewerContributionFence() {
  // Pulled by its first words (so a reflow of the prose around it does not break the test) and run as one unit.
  const lines = span('gsd-core/workflows/code-review.md', 'REVIEWER_POINT=$(', 'REVIEWER_CONTRIBUTIONS=$(');
  assert.ok(lines.length >= 5 && lines.length < 20, `the reviewer-contribution block should be a short contiguous span, got ${lines.length} lines`);
  return lines.join('\n');
}

function runFence({ configPoint = 'execute:post', configFails = false, envelopes, overflowDir }) {
  const dir = tmpDir('rev-contrib-fence-');
  const served = [];
  for (const [point, envelope] of Object.entries(envelopes)) {
    const file = path.join(dir, `${point.replace(/:/g, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(envelope));
    served.push([point, file]);
  }
  const stub = [
    'gsd_run() {',
    '  if [ "$1" = query ] && [ "$2" = config-get ]; then',
    configFails ? '    echo "config boom" >&2; return 1' : `    printf '%s' "${configPoint}"; return 0`,
    '  fi',
    '  if [ "$1" = loop ] && [ "$2" = render-hooks ]; then',
    '    case "$3" in',
    ...served.map(([point, file]) => (overflowDir
      ? `      ${point}) printf '@file:%s' "${file}";;`
      : `      ${point}) cat "${file}";;`)),
    '      *) echo "{\\"point\\":\\"$3\\",\\"activeHooks\\":[],\\"rendered\\":\\"\\"}";;',
    '    esac',
    '    return 0',
    '  fi',
    '  return 0',
    '}',
  ].join('\n');
  const script = `${stub}\n${reviewerContributionFence()}\nprintf '%s' "$REVIEWER_CONTRIBUTIONS"\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const hook = (into, inline, kind = 'contribution') => ({ kind, into, capId: 'x', fragment: { inline } });

describe('delivery of reviewer contributions inside code-review.md (#4790)', { skip: skipUnless('bash', 'node') }, () => {
  test('an active reviewer fragment is delivered once, wrapped, and nothing else is', () => {
    const r = runFence({
      envelopes: {
        'execute:post': {
          point: 'execute:post',
          activeHooks: [
            hook('code-reviewer', FRAGMENT),
            hook('executor', 'EXECUTOR ONLY'),
            hook('planner', 'PLANNER ONLY'),
            { kind: 'step', ref: { skill: 'code-review' } },
          ],
          rendered: '',
        },
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.split(FRAGMENT).length - 1, 1, 'the fragment arrives exactly once');
    assert.ok(!r.stdout.includes('EXECUTOR ONLY') && !r.stdout.includes('PLANNER ONLY'), 'other roles are not delivered');
    assert.match(r.stdout, /^<capability_review_rules>\n/);
    assert.match(r.stdout, /\n<\/capability_review_rules>$/);
  });

  test('several fragments keep the resolver order and are separated by a blank line', () => {
    const r = runFence({
      envelopes: { 'execute:post': { point: 'execute:post', activeHooks: [hook('code-reviewer', 'first'), hook('code-reviewer', 'second')], rendered: '' } },
    });
    assert.equal(r.stdout, '<capability_review_rules>\nfirst\n\nsecond\n</capability_review_rules>');
  });

  test('no reviewer contribution means nothing is added to the prompt', () => {
    const r = runFence({ envelopes: { 'execute:post': { point: 'execute:post', activeHooks: [hook('executor', 'x')], rendered: '' } } });
    assert.equal(r.stdout, '');
  });

  test('a wave-scoped review reads the contributions registered at its own loop point', () => {
    const r = runFence({
      configPoint: 'execute:wave:post',
      envelopes: {
        'execute:post': { point: 'execute:post', activeHooks: [hook('code-reviewer', 'PHASE POINT')], rendered: '' },
        'execute:wave:post': { point: 'execute:wave:post', activeHooks: [hook('code-reviewer', 'WAVE POINT')], rendered: '' },
      },
    });
    assert.ok(r.stdout.includes('WAVE POINT'));
    assert.ok(!r.stdout.includes('PHASE POINT'));
  });

  test('an unresolvable loop point falls back to execute:post', () => {
    const r = runFence({
      configFails: true,
      envelopes: { 'execute:post': { point: 'execute:post', activeHooks: [hook('code-reviewer', FRAGMENT)], rendered: '' } },
    });
    assert.ok(r.stdout.includes(FRAGMENT));
  });

  test('an envelope handed back as an @file: overflow path is read', () => {
    const r = runFence({
      overflowDir: true,
      envelopes: { 'execute:post': { point: 'execute:post', activeHooks: [hook('code-reviewer', FRAGMENT)], rendered: '' } },
    });
    assert.ok(r.stdout.includes(FRAGMENT));
  });

  test('a malformed envelope degrades to no contribution and never fails the review', () => {
    const dir = tmpDir('rev-contrib-bad-');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const script = `gsd_run() { if [ "$2" = config-get ]; then printf execute:post; else cat "${bad}"; fi; }\n${reviewerContributionFence()}\nprintf '%s' "$REVIEWER_CONTRIBUTIONS"\n`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test('the reviewer prompt carries the contributions once, after the agent skills, in one assembly', () => {
    const text = reviewWorkflowText();
    const spawn = text.slice(text.indexOf('Agent(subagent_type="gsd-code-reviewer"'));
    assert.equal(spawn.split('${REVIEWER_CONTRIBUTIONS}').length - 1, 1, 'placeholder appears exactly once in the spawn');
    assert.ok(
      spawn.indexOf('${AGENT_SKILLS_REVIEWER}') !== -1 && spawn.indexOf('${AGENT_SKILLS_REVIEWER}') < spawn.indexOf('${REVIEWER_CONTRIBUTIONS}'),
      'agent_skills guidance is preserved and comes first',
    );
  });
});
