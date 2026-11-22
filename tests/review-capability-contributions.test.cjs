'use strict';

/**
 * #3997 — capability contributions reach external reviewer prompts through `review:pre`.
 *
 * Design:      .gsd/phase/feat-3997-review-prompt-contributions/40-design.md
 * Test matrix: .gsd/phase/feat-3997-review-prompt-contributions/50-test-matrix.md
 *
 * Vocabulary, validation, disclosure and prompt-assembly rows are RED before the design lands. The
 * lane-invocation rows (section 5) are characterization tests: the lane code is unchanged by this
 * feature, and they pin that a prompt carrying the block reaches every transport exactly once.
 *
 * Layers: (1) contract + mirrors, (2) resolver + registry validation, (3) install disclosure,
 * (4) the review.md step run for real with a stand-in `gsd_run`, (5) the lane-invocation boundary.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const generator = require('../scripts/gen-loop-host-contract.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const { resolveLoopHooks, CANONICAL_POINTS, CANONICAL_POINTS_FALLBACK } = require('../gsd-core/bin/lib/loop-resolver.cjs');
const { LOOP_POINTS } = require('../scripts/registry-schema.cjs');
const validator = require('../gsd-core/bin/lib/capability-validator.cjs');
const trust = require('../gsd-core/bin/lib/capability-trust.cjs');
const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan, refuseIfOverCap } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');

const POINT = 'review:pre';
const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');
const CONVERGENCE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-review-convergence.md');
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX bash step' : false;

// ─── 1. vocabulary ──────────────────────────────────────────────────────────

describe('#3997 loop-point vocabulary: one list, every mirror agrees', () => {
  test('the contract publishes 13 distinct points with review:pre last', () => {
    assert.equal(generator.CANONICAL_POINTS.length, 13);
    assert.equal(new Set(generator.CANONICAL_POINTS).size, 13);
    assert.equal(generator.CANONICAL_POINTS[12], POINT);
  });

  test('parity: generator, resolver, resolver fallback and registry-schema list the same ordered points', () => {
    assert.deepEqual([...CANONICAL_POINTS], [...generator.CANONICAL_POINTS]);
    assert.deepEqual([...CANONICAL_POINTS_FALLBACK], [...generator.CANONICAL_POINTS]);
    assert.deepEqual([...LOOP_POINTS], [...generator.CANONICAL_POINTS]);
    assert.deepEqual([...validator.POINT_ORDER], [...generator.CANONICAL_POINTS]);
    assert.deepEqual([...validator.VALID_LOOP_POINTS].sort(), [...generator.CANONICAL_POINTS].sort());
  });

  test('the committed registry carries a byLoopPoint slot for every canonical point', () => {
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
    assert.deepEqual(Object.keys(registry.byLoopPoint), [...generator.CANONICAL_POINTS]);
  });

  test('loop render-hooks review:pre --raw exits 0 through the real CLI', async (t) => {
    const { createTempProject, runGsdToolsAsync } = require('./helpers.cjs');
    const dir = createTempProject();
    t.after(() => cleanup(dir));
    const r = await runGsdToolsAsync(['loop', 'render-hooks', POINT, '--raw'], dir);
    assert.equal(r.success, true, `render-hooks failed: ${r.error || r.output}`);
    assert.equal(JSON.parse(r.output).point, POINT);
  });

  test('parity: the committed contract artifact covers exactly the canonical points', () => {
    const fromContract = LOOP_HOST_CONTRACT.flatMap((e) => e.points);
    assert.deepEqual([...fromContract].sort(), [...generator.CANONICAL_POINTS].sort());
  });

  test('the generated contract has a review host: step review, points [review:pre], roles [reviewer]', () => {
    const entry = LOOP_HOST_CONTRACT.find((e) => e.step === 'review');
    assert.ok(entry, 'no review step in the contract');
    assert.deepEqual(entry.points, [POINT]);
    assert.deepEqual(entry.agentRoles, ['reviewer']);
  });

  test('review.md is a registered host whose built contract equals the committed artifact', () => {
    assert.ok(generator.HOST_LOOP_FILES.includes('gsd-core/workflows/review.md'));
    const live = generator.serializeContract(generator.buildContract());
    assert.equal(generator.normalizeLineEndings(live), generator.normalizeLineEndings(
      fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'loop-host-contract.cjs'), 'utf8'),
    ));
  });

  test('reviewer belongs to its own family: only the review step accepts it', () => {
    assert.deepEqual(generator.crossCheckRoleFamilies('review', ['reviewer'], 'review.md'), []);
    for (const step of ['discuss', 'plan', 'execute', 'verify', 'ship']) {
      assert.notEqual(generator.crossCheckRoleFamilies(step, ['reviewer'], `${step}.md`).length, 0, step);
    }
  });

  test('negative: an executor role is not admissible at the review step', () => {
    assert.notEqual(generator.crossCheckRoleFamilies('review', ['executor'], 'review.md').length, 0);
    assert.notEqual(generator.crossCheckRoleFamilies('review', ['orchestrator'], 'review.md').length, 0);
  });

  test('reviewer needs no agent file, but every other unmapped role still fails closed', () => {
    assert.deepEqual(generator.crossCheckRoles('anything', ['reviewer'], 'review.md'), []);
    assert.notEqual(generator.crossCheckRoles('anything', ['no-such-role'], 'review.md').length, 0);
    assert.notEqual(generator.crossCheckRoles('anything', ['executor'], 'review.md').length, 0);
  });

  test('every canonical point is accepted by the resolver with an empty registry', () => {
    for (const point of generator.CANONICAL_POINTS) {
      assert.deepEqual(resolveLoopHooks({ point, registry: { byLoopPoint: {} }, config: {} }), { point, activeHooks: [] });
    }
  });
});

// ─── 2. resolver + registry validation ──────────────────────────────────────

function contribution(capId, extra = {}) {
  return { capId, point: POINT, into: 'reviewer', fragment: { inline: `rules from ${capId}` }, produces: [], consumes: [], ...extra };
}

function registryWith(contributions) {
  return { byLoopPoint: { [POINT]: { steps: [], contributions, gates: [] } }, configSchema: {} };
}

describe('#3997 resolveLoopHooks at review:pre', () => {
  test('active reviewer contributions render, in registry order, with capability-id tie-break upstream', () => {
    const r = resolveLoopHooks({
      point: POINT,
      registry: registryWith([contribution('b-cap'), contribution('a-cap')]),
      config: {},
    });
    assert.deepEqual(r.activeHooks.map((h) => h.capId), ['b-cap', 'a-cap']);
    assert.ok(r.activeHooks.every((h) => h.kind === 'contribution' && h.into === 'reviewer'));
  });

  test('a disabled / inactive / unknown capability is excluded', () => {
    const states = new Map([
      ['on', { active: true }],
      ['off', { active: false }],
    ]);
    const r = resolveLoopHooks({
      point: POINT,
      registry: registryWith([contribution('on'), contribution('off'), contribution('ghost')]),
      config: {},
      capabilityStatesById: states,
    });
    assert.deepEqual(r.activeHooks.map((h) => h.capId), ['on']);
  });
});

function featureCap(overrides = {}) {
  return {
    role: 'feature',
    id: 'demo',
    version: '1.0.0',
    steps: [],
    gates: [],
    contributions: [{ point: POINT, into: 'reviewer', produces: [], consumes: [], fragment: { inline: 'x' } }],
    config: {},
    engines: { gsd: '>=1.23.0' },
    ...overrides,
  };
}

describe('#3997 registry validation for review:pre', () => {
  test('into other than reviewer at review:pre is rejected by the host contract', () => {
    const errors = validator.validateAgainstContract(
      featureCap({ contributions: [{ point: POINT, into: 'planner', produces: [], consumes: [], fragment: { inline: 'x' } }] }),
      'demo',
    );
    assert.ok(errors.some((e) => e.includes('"planner"') && e.includes(POINT)), errors.join('\n'));
  });

  test('a reviewer contribution with a valid engine range raises no contract error', () => {
    assert.deepEqual(validator.validateAgainstContract(featureCap(), 'demo'), []);
  });

  test('POINT_MIN_ENGINE pins the introducing release for review:pre', () => {
    assert.equal(validator.POINT_MIN_ENGINE[POINT], '1.23.0');
  });

  const engineCases = [
    ['absent', undefined, false],
    ['wildcard', '*', false],
    ['old floor', '>=1.6.0', false],
    ['upper bound only', '<2.0.0', false],
    ['caret of an older minor', '^1.22.0', false],
    ['range that also admits an older core', '>=1.23.0 || 1.5.0', false],
    ['exact introducing release', '>=1.23.0', true],
    ['caret of the introducing release', '^1.23.0', true],
    ['a later floor', '>=1.24.0', true],
    ['tilde of the introducing release', '~1.23.0', true],
  ];
  for (const [label, range, ok] of engineCases) {
    test(`engine range ${label} (${String(range)}) is ${ok ? 'accepted' : 'rejected'}`, () => {
      const cap = featureCap({ engines: range === undefined ? undefined : { gsd: range } });
      const errors = validator.validateAgainstContract(cap, 'demo');
      assert.equal(errors.some((e) => /engines\.gsd/.test(e)), !ok, errors.join('\n'));
    });
  }

  test('the engine rule is scoped: a capability with no review:pre hook is unaffected', () => {
    const cap = featureCap({
      engines: undefined,
      contributions: [{ point: 'plan:pre', into: 'planner', produces: [], consumes: [], fragment: { inline: 'x' } }],
    });
    assert.equal(validator.validateAgainstContract(cap, 'demo').some((e) => /engines\.gsd/.test(e)), false);
  });

  test('only contributions are wired at review:pre: a step or gate there fails the wired-kind check', () => {
    const cap = featureCap({
      contributions: [],
      steps: [{ point: POINT, ref: { skill: 'x' }, produces: [], consumes: [] }],
    });
    const wired = require('../scripts/gen-loop-host-contract.cjs').getWiredKinds();
    const errors = validator.validateHooksWired(cap, wired);
    assert.notEqual(errors.length, 0, 'a step at review:pre must not be considered wired');
    const ok = validator.validateHooksWired(featureCap(), wired);
    assert.deepEqual(ok, [], ok.join('\n'));
  });
});

// ─── 3. install disclosure ──────────────────────────────────────────────────

describe('#3997 install disclosure of reviewer contributions', () => {
  const manifest = (contributions, extra = {}) => ({ id: 'demo', version: '1.0.0', contributions, ...extra });
  const reviewerC = { point: POINT, into: 'reviewer', fragment: { inline: 'x' } };

  test('a reviewer contribution at review:pre is disclosed as an instruction surface by point and target', () => {
    const s = trust.collectInstructionSurfaces(manifest([reviewerC]));
    assert.deepEqual(s, [{ kind: 'reviewer-contribution', name: 'review:pre (reviewer)' }]);
  });

  test('skills and reviewer contributions are both disclosed, skills first', () => {
    const s = trust.collectInstructionSurfaces(manifest([reviewerC], { skills: ['alpha'] }));
    assert.deepEqual(s.map((x) => x.kind), ['skill', 'reviewer-contribution']);
  });

  test('other points, other targets and malformed entries are not disclosed, and nothing throws', () => {
    const noise = [
      { point: 'plan:pre', into: 'reviewer' },
      { point: POINT, into: 'planner' },
      { point: POINT },
      null,
      'review:pre',
      [],
    ];
    assert.deepEqual(trust.collectInstructionSurfaces(manifest(noise)), []);
    for (const hostile of [undefined, null, 7, 'x', {}, { get contributions() { throw new Error('boom'); } }]) {
      assert.doesNotThrow(() => trust.discloseExecutableSurfaces(hostile));
    }
    assert.deepEqual(trust.collectInstructionSurfaces({ contributions: 'not-an-array' }), []);
  });

  test('two contributions are disclosed twice (disclosure reports what the manifest says)', () => {
    assert.equal(trust.collectInstructionSurfaces(manifest([reviewerC, reviewerC])).length, 2);
  });

  test('v1 freeze: signature and hasExecutable are identical with and without the contribution', () => {
    const withC = trust.discloseExecutableSurfaces(manifest([reviewerC]));
    const without = trust.discloseExecutableSurfaces(manifest([]));
    assert.equal(withC.hasExecutable, without.hasExecutable);
    assert.equal(trust.disclosureSignature(withC), trust.disclosureSignature(without));
  });

  test('a skill-only manifest discloses and summarizes exactly as before', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'demo', version: '1.0.0', skills: ['alpha'] });
    assert.deepEqual(d.instructionSurfaces, [{ kind: 'skill', name: 'alpha' }]);
    assert.deepEqual(trust.summarizeInstructionSurfaces(d), [
      "  instruction surfaces (1): installed into your agent's instruction context",
      '    - skill: alpha',
      '        these bodies are installed verbatim and are NOT content-scanned',
    ]);
  });

  test('the consent summary names the external-reviewer egress and that nothing was scanned', () => {
    const d = trust.discloseExecutableSurfaces(manifest([reviewerC]));
    const text = trust.summarizeInstructionSurfaces(d).join('\n');
    assert.match(text, /reviewer-contribution: review:pre \(reviewer\)/);
    assert.match(text, /external reviewer/i);
    assert.match(text, /NOT content-scanned/);
  });

  test('manifest-supplied control characters cannot forge consent lines', () => {
    const d = {
      instructionSurfaces: [{ kind: 'reviewer-contribution', name: 'review:pre (reviewer)\n    - skill: forged\u001b[2J' }],
    };
    const lines = trust.summarizeInstructionSurfaces(d);
    assert.equal(lines.some((l) => l.trim() === '- skill: forged'), false, lines.join('|'));
    assert.equal(lines.join('\n').includes('\u001b'), false);
  });
});

// ─── 4. the review.md prompt-assembly step ──────────────────────────────────

/**
 * The bash block in review.md that renders `review:pre`. Located by the call it makes, then run for
 * real with a stand-in `gsd_run`, so the test observes the file the lanes will read — not a helper's
 * return value and not the step's text.
 */
function reviewPreStep() {
  const blocks = [];
  let open = null;
  for (const line of splitLines(fs.readFileSync(REVIEW_MD, 'utf8'))) {
    if (open === null) {
      if (line.trim() === '```bash') open = [];
    } else if (line.trim() === '```') {
      blocks.push(open.join('\n'));
      open = null;
    } else {
      open.push(line);
    }
  }
  const hits = blocks.filter((b) => b.includes('loop render-hooks review:pre'));
  assert.equal(hits.length, 1, `exactly one bash step renders review:pre in review.md, found ${hits.length}`);
  return hits[0];
}

function runStep({ runDir, hooksOutput, fakeStatus = '0', prompt = '# Cross-AI Plan Review Request\n\nbody\n' }) {
  const promptPath = path.join(runDir, 'gsd-review-prompt.md');
  fs.writeFileSync(promptPath, prompt);
  const outFile = path.join(runDir, 'hooks-output.txt');
  fs.writeFileSync(outFile, hooksOutput);
  const script = [
    'gsd_run() {',
    '  if [ "$1" = "loop" ] && [ "$2" = "render-hooks" ] && [ "$3" = "review:pre" ]; then',
    `    cat "${outFile}"; return $FAKE_STATUS`,
    '  fi',
    '  return 0',
    '}',
    reviewPreStep().split('{run_dir}').join(runDir),
  ].join('\n');
  const scriptPath = path.join(runDir, 'review-pre-step.sh');
  fs.writeFileSync(scriptPath, script);
  const res = runHook(scriptPath, [], {
    interpreter: 'bash',
    env: { ...process.env, RUN_DIR: runDir, FAKE_STATUS: fakeStatus },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  // Same fields the assertions below read; `status` is the child's exit code.
  const r = { status: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  return { r, prompt: fs.readFileSync(promptPath, 'utf8'), original: prompt };
}

const hooksJson = (...inlines) =>
  JSON.stringify({
    point: POINT,
    activeHooks: inlines.map((inline, i) => ({ capId: `cap-${i}`, kind: 'contribution', into: 'reviewer', fragment: { inline } })),
  });

function withRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3997-'));
  t.after(() => cleanup(dir));
  return dir;
}

describe('#3997 review.md renders review:pre into the shared prompt', () => {
  test('no active contribution: the prompt file is byte-identical and the step is silent', { skip: POSIX_ONLY }, (t) => {
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson() });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.equal(out.prompt, out.original);
    assert.equal(out.r.stdout, '');
    assert.equal(out.r.stderr, '');
  });

  test('one contribution appears exactly once, inside a closed block', { skip: POSIX_ONLY }, (t) => {
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson('USE-RULE-ALPHA') });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.equal(out.prompt.split('USE-RULE-ALPHA').length - 1, 1);
    assert.ok(out.prompt.startsWith(out.original), 'the existing prompt is a strict prefix');
    assert.equal(out.prompt.split('<capability_reviewer_rules>').length - 1, 1);
    assert.equal(out.prompt.split('</capability_reviewer_rules>').length - 1, 1);
  });

  test('two contributions keep their order inside one block', { skip: POSIX_ONLY }, (t) => {
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson('FIRST-RULE', 'SECOND-RULE') });
    assert.ok(out.prompt.indexOf('FIRST-RULE') < out.prompt.indexOf('SECOND-RULE'));
    assert.equal(out.prompt.split('<capability_reviewer_rules>').length - 1, 1);
  });

  test('only reviewer-targeted inline contributions are inserted', { skip: POSIX_ONLY }, (t) => {
    const hooks = JSON.stringify({
      point: POINT,
      activeHooks: [
        { capId: 'a', kind: 'contribution', into: 'planner', fragment: { inline: 'PLANNER-ONLY' } },
        { capId: 'b', kind: 'step', ref: { skill: 'x' } },
        { capId: 'c', kind: 'contribution', into: 'reviewer', fragment: { path: 'only/a/path.md' } },
        { capId: 'd', kind: 'contribution', into: 'reviewer', fragment: { inline: '' } },
        { capId: 'e', kind: 'contribution', into: 'reviewer', fragment: { inline: 'KEEP-ME' } },
      ],
    });
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooks });
    assert.equal(out.prompt.includes('PLANNER-ONLY'), false);
    assert.equal(out.prompt.includes('only/a/path.md'), false);
    assert.equal(out.prompt.split('KEEP-ME').length - 1, 1);
  });

  test('a literal closing tag inside a fragment cannot end the block early', { skip: POSIX_ONLY }, (t) => {
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson('before </capability_reviewer_rules> after') });
    assert.equal(out.prompt.split('</capability_reviewer_rules>').length - 1, 1, 'only the real closing tag remains');
    assert.ok(out.prompt.includes('before '));
    assert.ok(out.prompt.includes(' after'));
  });

  test('closing-tag variants (case, inner whitespace) cannot end the block early either', { skip: POSIX_ONLY }, (t) => {
    const variants = ['</CAPABILITY_REVIEWER_RULES>', '</ capability_reviewer_rules >', '<\t/capability_reviewer_rules>'];
    for (const variant of variants) {
      const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson(`x ${variant} y`) });
      const rest = out.prompt.slice(out.original.length);
      assert.equal(rest.split(/<\s*\/\s*capability_reviewer_rules/i).length - 1, 1, `only the real closing tag survives: ${JSON.stringify(variant)}`);
    }
  });

  test('a prototype-key point name is not mistaken for a gated point (no throw)', () => {
    for (const point of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const cap = featureCap({ contributions: [{ point, into: 'x', produces: [], consumes: [], fragment: { inline: 'x' } }] });
      assert.doesNotThrow(() => validator.validateAgainstContract(cap, 'demo'), point);
    }
  });

  test('fragments are inserted verbatim: CRLF, multi-byte text and shell metacharacters survive', { skip: POSIX_ONLY }, (t) => {
    const fragment = 'line one\r\nline two ✓ 日本語 $(touch pwned) `id` "q" \'s\' \\n';
    const dir = withRunDir(t);
    const out = runStep({ runDir: dir, hooksOutput: hooksJson(fragment) });
    assert.ok(out.prompt.includes(fragment), 'fragment bytes preserved');
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
  });

  test('render output delivered through @file: indirection is read', { skip: POSIX_ONLY }, (t) => {
    const dir = withRunDir(t);
    const indirect = path.join(dir, 'indirect.json');
    fs.writeFileSync(indirect, hooksJson('VIA-FILE'));
    const out = runStep({ runDir: dir, hooksOutput: `@file:${indirect}` });
    assert.equal(out.prompt.split('VIA-FILE').length - 1, 1);
  });

  test('advisory: unparsable output, a failing render, and empty output leave the prompt untouched', { skip: POSIX_ONLY }, (t) => {
    for (const hooksOutput of ['', 'not json at all', '{"activeHooks": 7}', '[]', 'null']) {
      const out = runStep({ runDir: withRunDir(t), hooksOutput });
      assert.equal(out.r.status, 0, `${JSON.stringify(hooksOutput)}: ${out.r.stderr}`);
      assert.equal(out.prompt, out.original, JSON.stringify(hooksOutput));
    }
  });

  test('a render that exits non-zero leaves the prompt untouched even when it printed valid hooks', { skip: POSIX_ONLY }, (t) => {
    const out = runStep({ runDir: withRunDir(t), hooksOutput: hooksJson('MUST-NOT-APPEAR'), fakeStatus: '1' });
    assert.equal(out.r.status, 0, out.r.stderr);
    assert.equal(out.prompt, out.original);
  });

  test('convergence has no second injection path: it is not a host and wires no point', () => {
    assert.equal(generator.HOST_LOOP_FILES.includes('gsd-core/workflows/plan-review-convergence.md'), false);
    assert.equal(generator.scanWiredPoints(fs.readFileSync(CONVERGENCE_MD, 'utf8')).has(POINT), false);
    assert.deepEqual(
      [...generator.getWiredLoopPoints()].filter((p) => p === POINT),
      [POINT],
      'review:pre is wired by exactly the review host',
    );
  });
});

// ─── 5. the lane-invocation boundary ────────────────────────────────────────

const RUN = '/run';
const ROOT = '/repo';
const BLOCK = '<capability_reviewer_rules>\nUSE-RULE-ALPHA\n</capability_reviewer_rules>';
const PROMPT = `# Cross-AI Plan Review Request\n\nplans here\n\n${BLOCK}\n`;
const count = (hay, needle) => String(hay).split(needle).length - 1;

function spyDeps(files) {
  const spawns = [];
  const posts = [];
  const written = {};
  return {
    spawns,
    posts,
    written,
    spawn: (binary, argv, opts) => {
      spawns.push({ binary, argv, opts });
      // A capability probe (`<bin> --help`) must advertise the flags the lane needs, or the lane
      // is refused as "a different tool sharing the name" and never reaches its prompt.
      if (argv.length === 1 && argv[0] === '--help') {
        return { status: 0, stdout: '--output-format --print --model --effort --prompt', stderr: '' };
      }
      return { status: 0, stdout: 'a review body long enough to clear the empty-output guard.', stderr: '' };
    },
    httpJson: async (url, opts) => {
      if (opts.method === 'POST') {
        posts.push({ url, body: opts.body });
        return { ok: true, status: 200, body: JSON.stringify({ model: 'm', choices: [{ message: { content: 'a review body long enough to clear the guard.' } }] }) };
      }
      return { ok: true, status: 200, body: JSON.stringify({ data: [{ id: 'm' }] }) };
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    writeFile: (p, c) => { written[p] = c; files[p] = c; },
    exists: (p) => p in files,
    hasBinary: () => true,
    configGet: () => undefined,
    homeDir: '/home/u',
    warn: () => {},
  };
}

const laneOf = (slug) => REVIEWER_LANES.find((l) => l.slug === slug);

async function runThrough(lane, config = {}) {
  const r = resolveLanePlan({ lane, configGet: (k) => config[k], runDir: RUN, repoRoot: ROOT });
  assert.equal(r.ok, true, `${lane.slug} failed to resolve`);
  const files = { [r.plan.promptPath]: PROMPT };
  const deps = spyDeps(files);
  const result = await runLane(r.plan, deps, { repoRoot: ROOT });
  return { plan: r.plan, deps, result, files };
}

describe('#3997 the contribution reaches every prompt transport exactly once', () => {
  test('stdin (claude): the child receives the whole prompt, block once', async () => {
    const { deps, result } = await runThrough(laneOf('claude'));
    assert.equal(result.ok, true);
    assert.equal(deps.spawns.length, 1);
    assert.equal(deps.spawns[0].opts.input, PROMPT);
    assert.equal(count(deps.spawns[0].opts.input, 'USE-RULE-ALPHA'), 1);
  });

  test('argv-file-ref (kimi-code): argv names the prompt file once and that file carries the block once', async () => {
    const { deps, plan, files } = await runThrough(laneOf('kimi-code'));
    const argv = deps.spawns[deps.spawns.length - 1].argv; // earlier spawns are the availability probe
    assert.equal(argv.filter((a) => a.includes(plan.promptPath)).length, 1);
    assert.equal(count(files[plan.promptPath], 'USE-RULE-ALPHA'), 1);
  });

  test('argv (an overlay lane declaring promptChannel argv): argv carries the prompt path once', async () => {
    const overlay = {
      ...laneOf('claude'),
      slug: 'argvlane',
      invoke: { ...laneOf('claude').invoke, binary: 'argvbin', args: ['--p', '{{prompt}}'], promptChannel: 'argv' },
    };
    const { deps, plan, files } = await runThrough(overlay);
    assert.equal(deps.spawns[0].argv.filter((a) => a === plan.promptPath).length, 1);
    assert.equal(count(files[plan.promptPath], 'USE-RULE-ALPHA'), 1);
  });

  test('openai-http (ollama): the POST body message content carries the block once', async () => {
    const { deps } = await runThrough(laneOf('ollama'), { 'review.ollama_host': 'http://localhost:11434' });
    assert.equal(deps.posts.length, 1);
    const sent = JSON.parse(deps.posts[0].body).messages[0].content;
    assert.equal(sent, PROMPT);
    assert.equal(count(deps.posts[0].body, 'USE-RULE-ALPHA'), 1);
  });

  test('promptChannel none (coderabbit): no prompt bytes are delivered and the plan is unchanged by the block', async () => {
    const { deps, plan } = await runThrough(laneOf('coderabbit'));
    assert.equal(plan.stdin, null);
    assert.equal(deps.spawns[0].opts.input, undefined);
    assert.equal(deps.spawns[0].argv.join(' ').includes('USE-RULE-ALPHA'), false);
    assert.equal(deps.spawns[0].argv.some((a) => a.includes(plan.promptPath)), false);
  });
});

describe('#3997 contribution bytes count toward the lane cap and are refused, never trimmed', () => {
  const lane = laneOf('claude');
  const cfg = (cap) => (key) => (key === 'review.max_prompt_tokens_per_reviewer.claude' ? cap : undefined);
  const tokens = (text) => Math.ceil(text.length / 4);

  test('cap-1 and cap run; cap+1 is refused with the full refusal record', () => {
    const base = '# review\n'.padEnd(4000, 'x');
    const withBlock = `${base}\n${BLOCK}\n`;
    const est = tokens(withBlock);
    assert.equal(refuseIfOverCap({ lane, estimatedTokens: est, configGet: cfg(est + 1) }), null);
    assert.equal(refuseIfOverCap({ lane, estimatedTokens: est, configGet: cfg(est) }), null);
    const over = refuseIfOverCap({ lane, estimatedTokens: est, configGet: cfg(est - 1) });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'prompt_exceeds_context');
    assert.deepEqual(over.refusal, { estimatedTokens: est, cap: est - 1, capSource: 'lane', contextWindowTokens: null });
  });

  test('a prompt that fit before the block is refused after it, not shortened', () => {
    const base = 'x'.repeat(4000);
    const cap = tokens(base);
    assert.equal(refuseIfOverCap({ lane, estimatedTokens: tokens(base), configGet: cfg(cap) }), null);
    const grown = refuseIfOverCap({ lane, estimatedTokens: tokens(`${base}\n${BLOCK}\n`), configGet: cfg(cap) });
    assert.equal(grown.ok, false);
    assert.equal(grown.refusal.capSource, 'lane');
  });
});
