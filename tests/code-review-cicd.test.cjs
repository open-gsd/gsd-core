'use strict';

/**
 * #4101 — CI/CD pipeline reliability rubric for gsd-code-reviewer.
 *
 * The reviewer is an agent `.md` file: its text IS what the runtime loads (CONTRIBUTING.md
 * "source-text-is-the-product"), so the standard-mode rubric is asserted as shipped prose. The
 * quick-mode checks have an executable form — the bash fence in `review_by_depth` — so that fence
 * is RUN against fixture workflow files instead of being read.
 *
 * Quick mode declares its checks in `<depth_levels>` and executes them in `review_by_depth`. Those
 * two lists drifted apart once (the secrets regex, `passthru` and the commented-out-code grep), which
 * is the generative-fix-divergence shape, so the declared names and the executed paragraphs are
 * pinned as one ordered set, and the full and compact variants as one fence.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HAS_BASH = process.platform !== 'win32';
const ROOT = path.resolve(__dirname, '..');
const AGENTS = path.join(ROOT, 'agents');
const REFERENCE = path.join(ROOT, 'gsd-core', 'references', 'cicd-review-patterns.md');
const REVIEWERS = ['gsd-code-reviewer.md', 'gsd-code-reviewer.compact.md'];

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const agent = (name) => read(path.join(AGENTS, name));

const QUICK_CHECKS = [
  'Hardcoded secrets',
  'Dangerous functions',
  'Debug artifacts',
  'Empty catch blocks',
  'Commented-out code',
  'Unpinned actions',
  'Non-idempotent install',
  'Missing job timeout',
];
const LAZY_READ = 'Read `~/.claude/gsd-core/references/cicd-review-patterns.md`';
const EAGER_IMPORT = '@~/.claude/gsd-core/references/cicd-review-patterns.md';
// One term per standard-mode check, in the order the issue lists them.
const STANDARD_CHECK_TERMS = [
  'npm ci', 'timeout-minutes', 'cancel-in-progress', 'build-once',
  'health check', 'rollback', 'continue-on-error', 'OIDC', 'unpinned',
];

function step(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step ${name} must exist`);
  return src.slice(open, src.indexOf('</step>', open));
}

function quickFence(name) {
  const lines = step(agent(name), 'review_by_depth').split('\n');
  const start = lines.findIndex((l) => /^```bash\s*$/.test(l));
  assert.notStrictEqual(start, -1, `${name}: review_by_depth must carry a bash fence`);
  const end = lines.findIndex((l, i) => i > start && /^```\s*$/.test(l));
  return lines.slice(start + 1, end).join('\n');
}

/** Labeled paragraphs of the quick fence: `# Label` then command lines. Comment-only paragraphs are preamble. */
function quickChecks(name) {
  const checks = new Map();
  for (const para of quickFence(name).split(/\n[ \t]*\n/)) {
    const lines = para.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2 || !lines[0].startsWith('# ')) continue;
    checks.set(lines[0].slice(2).trim(), lines.slice(1).join('\n'));
  }
  return checks;
}

/** The quick-mode check names declared in `<depth_levels>`: an inline `a; b; c.` list or `- a` bullets. */
function declaredChecks(name) {
  const src = agent(name);
  const depth = src.slice(src.indexOf('<depth_levels>'), src.indexOf('</depth_levels>'));
  const lines = depth.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Checks (commands in `review_by_depth`):'));
  assert.notStrictEqual(at, -1, `${name}: quick mode must declare its checks`);
  const inline = lines[at].slice(lines[at].indexOf('):') + 2).trim();
  if (inline) return inline.replace(/\.$/, '').split(';').map((s) => s.trim());
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('- ')) break;
    out.push(l.slice(2).trim());
  }
  return out;
}

/** Run one shipped quick check against a fixture; return the flagged line numbers. */
function runCheck(name, label, contentLines, { eol = '\n', file = '.github/workflows/ci.yml' } = {}) {
  const command = quickChecks(name).get(label);
  assert.ok(command, `${name}: quick fence must carry a "${label}" check`);
  const dir = createTempDir('gsd-4101-quick-');
  try {
    const target = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contentLines.join(eol) + eol);
    const r = runHook('-c', [command], {
      interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, FILE: target },
    });
    assert.strictEqual(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.ok(r.exitCode === 0 || r.exitCode === 1, `${label} must exit 0 or 1, got ${r.exitCode}: ${r.stderr}`);
    return r.stdout.split('\n').filter(Boolean).map((l) => Number(l.match(/^(\d+):/)?.[1]));
  } finally { cleanup(dir); }
}

describe('#4101 quick-mode parity', () => {
  for (const name of REVIEWERS) {
    test(`${name}: declared quick checks are exactly the executed paragraphs, in order`, () => {
      assert.deepStrictEqual(declaredChecks(name), QUICK_CHECKS);
      assert.deepStrictEqual([...quickChecks(name).keys()], QUICK_CHECKS);
    });
  }

  test('both variants execute the same quick fence', () => {
    assert.strictEqual(quickFence(REVIEWERS[1]), quickFence(REVIEWERS[0]));
  });
});

describe('#4101 quick-mode drift fix (executed fence matches the declared rubric)', () => {
  for (const name of REVIEWERS) {
    test(`${name}: the secrets check catches a non-word secret value`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(runCheck(name, 'Hardcoded secrets', ['const a = 1;', 'token = "sk-live.x/y"'], { file: 'src/a.js' }), [2]);
    });

    test(`${name}: passthru and commented-out code are grepped`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(runCheck(name, 'Dangerous functions', ['ok();', 'passthru($cmd);'], { file: 'src/a.php' }), [2]);
      assert.deepStrictEqual(runCheck(name, 'Commented-out code', ['ok();', '// legacy();'], { file: 'src/a.js' }), [2]);
    });
  }
});

describe('#4101 quick check: unpinned actions', () => {
  const steps = (uses) => ['jobs:', '  build:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', ...uses.map((u) => `      - uses: ${u}`)];

  for (const name of REVIEWERS) {
    test(`${name}: mutable refs are flagged`, { skip: !HAS_BASH }, () => {
      const lines = steps(['a/b@main', 'a/b@master', 'a/b@latest', '"a/b@main"', "'a/b/sub@master'", 'a/b@main # comment']);
      assert.deepStrictEqual(runCheck(name, 'Unpinned actions', lines), [6, 7, 8, 9, 10, 11]);
      assert.deepStrictEqual(runCheck(name, 'Unpinned actions', lines, { eol: '\r\n' }), [6, 7, 8, 9, 10, 11]);
    });

    test(`${name}: pins and look-alikes are not flagged`, { skip: !HAS_BASH }, () => {
      const lines = steps(['actions/checkout@v4', `a/b@${'a'.repeat(40)}`, './local-action', 'a/b@main-v2', 'a/b@mainline', 'docker://alpine:latest']);
      assert.deepStrictEqual(runCheck(name, 'Unpinned actions', lines), []);
    });
  }
});

describe('#4101 quick check: non-idempotent install', () => {
  const job = (runs) => ['jobs:', '  build:', '    runs-on: ubuntu-latest', '    timeout-minutes: 5', '    steps:', ...runs];

  for (const name of REVIEWERS) {
    test(`${name}: npm install / npm i are flagged, including in block scalars`, { skip: !HAS_BASH }, () => {
      const lines = job(['      - run: npm install', '      - run: npm i', '      - run: |', '          echo hi', '          npm install --save-dev x']);
      assert.deepStrictEqual(runCheck(name, 'Non-idempotent install', lines), [6, 7, 10]);
      assert.deepStrictEqual(runCheck(name, 'Non-idempotent install', lines, { eol: '\r\n' }), [6, 7, 10]);
    });

    test(`${name}: ci, global installs, comments and look-alikes are not flagged`, { skip: !HAS_BASH }, () => {
      const lines = job([
        '      - run: npm ci', '      - run: npm install -g typescript', '      - run: npm install --global x',
        '      # - run: npm install', '      - run: pnpm install', '      - run: npm install-test', '      - run: npm i18n',
      ]);
      assert.deepStrictEqual(runCheck(name, 'Non-idempotent install', lines), []);
    });
  }
});

describe('#4101 quick check: missing job timeout', () => {
  for (const name of REVIEWERS) {
    const check = (lines, opts) => runCheck(name, 'Missing job timeout', lines, opts);

    test(`${name}: no jobs, no findings (limit-1)`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(check(['on: push', 'env:', '  A: 1']), []);
      assert.deepStrictEqual(check(['on: push', 'jobs: {}']), []);
    });

    test(`${name}: one unbounded job is named by its key line (limit)`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(check(['on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: make']), [3]);
    });

    test(`${name}: only the offending job is named (limit+1)`, { skip: !HAS_BASH }, () => {
      const lines = ['jobs:', '  a:', '    runs-on: x', '    timeout-minutes: 5', '  b:', '    runs-on: x', '    steps: []'];
      assert.deepStrictEqual(check(lines), [5]);
    });

    test(`${name}: key order does not matter`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(check(['jobs:', '  a:', '    timeout-minutes: 5', '    runs-on: x']), []);
      assert.deepStrictEqual(check(['jobs:', '  a:', '    runs-on: x', '    timeout-minutes: 5']), []);
    });

    test(`${name}: a step timeout does not bound the job`, { skip: !HAS_BASH }, () => {
      const lines = ['jobs:', '  a:', '    runs-on: x', '    steps:', '      - run: make', '        timeout-minutes: 5'];
      assert.deepStrictEqual(check(lines), [2]);
    });

    test(`${name}: reusable-workflow calls are exempt`, { skip: !HAS_BASH }, () => {
      assert.deepStrictEqual(check(['jobs:', '  call:', '    uses: org/repo/.github/workflows/x.yml@v1', '    with:', '      a: 1']), []);
    });

    test(`${name}: block scalars, comments and later top-level keys do not leak`, { skip: !HAS_BASH }, () => {
      const lines = [
        'jobs:', '  # runs-on: commented', '  a:', '    runs-on: x', '    timeout-minutes: 5', '    steps:',
        '      - run: |', '          runs-on: not-a-key', '          timeout-minutes: not-a-key',
        'env:', '  runs-on: x', 'on: push',
      ];
      assert.deepStrictEqual(check(lines), []);
    });

    test(`${name}: CRLF gives the LF verdict`, { skip: !HAS_BASH }, () => {
      const lines = ['jobs:', '  a:', '    runs-on: x', '  b:', '    runs-on: x', '    timeout-minutes: 5'];
      assert.deepStrictEqual(check(lines, { eol: '\r\n' }), [2]);
    });
  }

  test('property: flagged jobs are exactly those with runs-on and no job-level timeout', { skip: !HAS_BASH }, () => {
    const jobArb = fc.record({
      kind: fc.constantFrom('runner', 'reusable'),
      timeout: fc.constantFrom('none', 'job', 'step'),
      timeoutFirst: fc.boolean(),
      extra: fc.boolean(),
    });
    fc.assert(fc.property(fc.array(jobArb, { minLength: 0, maxLength: 5 }), (jobs) => {
      const lines = ['name: ci', 'on: push', 'jobs:'];
      const expected = [];
      jobs.forEach((j, i) => {
        const keyLine = lines.length + 1;
        lines.push(`  job-${i}:`);
        const props = [];
        if (j.kind === 'runner') props.push('    runs-on: ubuntu-latest');
        else props.push('    uses: org/repo/.github/workflows/x.yml@v1');
        if (j.extra) props.push('    env:', '      A: "1"');
        if (j.timeout === 'job') props[j.timeoutFirst ? 'unshift' : 'push']('    timeout-minutes: 10');
        if (j.kind === 'runner') {
          props.push('    steps:', '      - run: make');
          if (j.timeout === 'step') props.push('        timeout-minutes: 3');
        }
        lines.push(...props);
        if (j.kind === 'runner' && j.timeout !== 'job') expected.push(keyLine);
      });
      assert.deepStrictEqual(runCheck(REVIEWERS[0], 'Missing job timeout', lines), expected);
    }), { seed: 4101, numRuns: 60 });
  });
});

describe('#4101 standard-mode rubric', () => {
  for (const name of REVIEWERS) {
    test(`${name}: CI/CD bullet is path-keyed, names every check and Reads the reference lazily`, () => {
      const src = agent(name);
      const at = src.indexOf('**CI/CD pipelines**');
      assert.notStrictEqual(at, -1, `${name} must carry the CI/CD pipelines entry`);
      const bullet = src.slice(at, src.indexOf('\n', at));
      for (const key of ['.github/workflows/', 'Dockerfile', 'docker-compose', 'deploy']) {
        assert.ok(bullet.includes(key), `${name} CI/CD entry must key on ${key}`);
      }
      for (const term of STANDARD_CHECK_TERMS) assert.ok(bullet.includes(term), `${name} CI/CD entry must name ${term}`);
      assert.ok(bullet.includes(LAZY_READ), `${name} must Read the reference where it is used`);
      assert.ok(bullet.includes('if it cannot be read'), `${name} must define the unreadable-reference fallback`);
      assert.ok(!src.includes(EAGER_IMPORT), `${name} must not @-import the reference (ADR-1610 D4)`);
    });

    test(`${name}: scope_files groups CI/CD pipeline files by path`, () => {
      const scope = step(agent(name), 'scope_files');
      const at = scope.indexOf('CI/CD');
      assert.notStrictEqual(at, -1, `${name} scope_files must define a CI/CD group`);
      const group = scope.slice(at, scope.indexOf('\n', at));
      for (const key of ['.github/workflows/', 'Dockerfile', 'docker-compose', 'deploy']) {
        assert.ok(group.includes(key), `${name} CI/CD group must name ${key}`);
      }
    });

    test(`${name}: pipeline findings are Warning and secrets stay Critical`, () => {
      const cls = step(agent(name), 'classify_findings');
      const critical = cls.slice(cls.indexOf('**Critical**'), cls.indexOf('**Warning**'));
      const warning = cls.slice(cls.indexOf('**Warning**'), cls.indexOf('**Info**'));
      assert.ok(/hardcoded secrets/i.test(critical), `${name} must keep secrets Critical`);
      for (const term of ['pipeline', 'timeout', 'unpinned', 'rollback', 'concurrency']) {
        assert.ok(warning.toLowerCase().includes(term), `${name} Warning tier must name ${term}`);
      }
    });
  }
});

describe('#4101 cicd-review-patterns reference', () => {
  test('carries every check and the negative space', () => {
    const src = read(REFERENCE);
    for (const term of STANDARD_CHECK_TERMS) assert.ok(src.includes(term), `reference must cover ${term}`);
    for (const exempt of ['npm install -g', 'reusable workflow', 'full commit SHA', 'does not support OIDC']) {
      assert.ok(src.includes(exempt), `reference negative space must name "${exempt}"`);
    }
    assert.ok(/stays Critical/i.test(src), 'reference must state that hardcoded secrets stay Critical');
  });
});
