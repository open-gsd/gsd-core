'use strict';

/**
 * #4100 — the Necessity review dimension.
 *
 * The reviewer and fixer are agent `.md` files: their text IS what the runtime loads, so these
 * assertions read shipped prose (CONTRIBUTING.md "source-text-is-the-product"). Where a rule has
 * an executable form — the present_results frontmatter parse — the shipped fence is RUN instead.
 *
 * The necessity marker is produced by one agent and consumed by another (and mirrored into both
 * compact variants and the reference). That is the generative-fix-divergence shape, so the marker
 * is pinned as ONE literal across all five files rather than asserted per file in isolation.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HAS_BASH = process.platform !== 'win32';
const ROOT = path.resolve(__dirname, '..');
const AGENTS = path.join(ROOT, 'agents');
const REFERENCE = path.join(ROOT, 'gsd-core', 'references', 'necessity-review.md');
const REVIEW_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

const REVIEWERS = ['gsd-code-reviewer.md', 'gsd-code-reviewer.compact.md'];
const FIXERS = ['gsd-code-fixer.md', 'gsd-code-fixer.compact.md'];
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const agent = (name) => read(path.join(AGENTS, name));

const MARKER = '**Category:** necessity';
const SUBTYPES = [
  'Impossible-state guard',
  'Already-defended-elsewhere',
  'Cargo-culted pattern',
  'Phantom requirement',
  'Generality without instantiation',
];
const LAZY_READ = 'Read `~/.claude/gsd-core/references/necessity-review.md`';
const EAGER_IMPORT = '@~/.claude/gsd-core/references/necessity-review.md';

function presentResultsFence() {
  const src = read(REVIEW_WORKFLOW);
  const open = src.indexOf('<step name="present_results">');
  assert.notStrictEqual(open, -1, 'present_results step must exist');
  const lines = src.slice(open, src.indexOf('</step>', open)).split('\n');
  const start = lines.findIndex((l) => /^```bash\s*$/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^```\s*$/.test(l));
  return lines.slice(start + 1, end).join('\n');
}

function runPresentResults(frontmatterLines) {
  const dir = createTempDir('gsd-4100-present-');
  try {
    const review = path.join(dir, '01-REVIEW.md');
    fs.writeFileSync(review, ['---', ...frontmatterLines, '---', '', 'body info: 99 necessity: 98'].join('\n'));
    const script = [presentResultsFence(), 'printf "%s|%s|%s\\n" "$INFO" "$NECESSITY" "$TOTAL"'].join('\n');
    const res = runHook('-c', [script], {
      interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, env: { ...process.env, REVIEW_PATH: review },
    });
    assert.strictEqual(res.exitCode, 0, res.stderr);
    return res.stdout.trim().split('\n').pop();
  } finally { cleanup(dir); }
}

describe('#4100 reviewer rubric', () => {
  for (const name of REVIEWERS) {
    test(`${name} declares category 4 Necessity`, () => {
      assert.ok(agent(name).includes('**4. Necessity**'), `${name} must declare category 4`);
    });

    test(`${name} reads the reference lazily, never eagerly (ADR-1610 D4)`, () => {
      const src = agent(name);
      assert.ok(src.includes(LAZY_READ), `${name} must Read the reference at the step that needs it`);
      assert.ok(!src.includes(EAGER_IMPORT), `${name} must not @-import the reference`);
      assert.ok(src.includes('`quick` does not assess necessity'), `${name} must exclude quick depth`);
    });

    test(`${name} caps necessity below Critical and requires evidence`, () => {
      const src = agent(name);
      const rubric = src.slice(src.indexOf('**4. Necessity**'));
      assert.ok(rubric.includes('Never Critical'), `${name} must cap necessity severity`);
      assert.ok(/evidence/i.test(rubric), `${name} must require evidence`);
    });

    test(`${name} specifies the necessity: frontmatter sub-count`, () => {
      assert.ok(/^\s+necessity: N/m.test(agent(name)), `${name} frontmatter spec must carry necessity: N`);
    });
  }
});

describe('#4100 necessity-review reference', () => {
  test('carries all five subtypes and the trust-boundary exclusion', () => {
    const src = read(REFERENCE);
    for (const s of SUBTYPES) assert.ok(src.includes(s), `reference must name "${s}"`);
    assert.ok(/trust boundary/i.test(src), 'reference must exclude trust-boundary guards');
  });
});

describe('#4100 marker parity (producer and consumers)', () => {
  test('one necessity marker literal across reviewer, fixer, both compacts and the reference', () => {
    const files = [...REVIEWERS, ...FIXERS].map((n) => path.join(AGENTS, n)).concat(REFERENCE);
    for (const f of files) {
      assert.ok(read(f).includes(MARKER), `${path.basename(f)} must carry the literal ${MARKER}`);
    }
  });
});

describe('#4100 fixer scope', () => {
  for (const name of FIXERS) {
    test(`${name}: critical_warning skips necessity, all includes it last`, () => {
      const src = agent(name);
      assert.ok(src.includes('`critical_warning` excludes necessity findings'), `${name} default scope must exclude necessity`);
      assert.ok(src.includes('`all` includes necessity findings, ordered last'), `${name} all scope must include necessity last`);
    });

    test(`${name}: zero in-scope findings apply nothing`, () => {
      assert.ok(agent(name).includes('If `findings_in_scope` is 0'), `${name} must define the zero-scope case`);
    });
  }
});

describe('#4100 code-review present_results', () => {
  test('displays the necessity sub-count', () => {
    assert.ok(/Necessity:\s+\$\{NECESSITY/.test(read(REVIEW_WORKFLOW)), 'present_results must display the necessity count');
  });

  test('INFO and NECESSITY parse independently from the frontmatter', { skip: !HAS_BASH }, () => {
    const out = runPresentResults([
      'status: issues_found', 'files_reviewed: 2', 'findings:', '  critical: 1',
      '  warning: 2', '  info: 3', '  total: 6', '  necessity: 4',
    ]);
    assert.strictEqual(out, '3|4|6');
  });

  test('an absent necessity key reads as empty, not as another count', { skip: !HAS_BASH }, () => {
    const out = runPresentResults([
      'status: issues_found', 'files_reviewed: 1', 'findings:', '  critical: 0',
      '  warning: 0', '  info: 2', '  total: 2',
    ]);
    assert.strictEqual(out, '2||2');
  });
});
