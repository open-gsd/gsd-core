'use strict';

// #4990 round-5 review fix (BLOCKER, code#1): a `steps.<id>.` reference to a
// step id that does not exist in the SAME job silently resolves to an empty
// string in GitHub Actions expressions — no error, no warning, just a
// condition/env value that is always falsy/empty. That exact shape shipped
// in backmerge-merge-when-green.yml's `evaluate` job (referencing
// `steps.identity.outputs.login`, a step that lives in a DIFFERENT job) and
// silently meant "nothing ever merges" — a real regression that reached this
// far with no test catching it. This suite is a STRUCTURAL invariant, run
// over every workflow file: every `steps.<id>.` reference must name a step
// id declared in the SAME job, and every `needs.<job>.outputs.<x>` reference
// must name a job listed in the referencing job's own `needs:` AND a key
// that job actually declares in its own `outputs:` (or, for a local reusable
// workflow call, in the called file's own `on.workflow_call.outputs:`).
//
// Round-6 review fix (MINOR, code#4): the scan is scoped to real GitHub
// Actions EXPRESSION TEXT only — inside `${{ ... }}` delimiters everywhere,
// PLUS the raw text of `if:` fields (which GitHub allows to omit the `${{ }}`
// wrapper entirely). A bare, non-`${{ }}`-wrapped mention of `steps.foo.` or
// `needs.bar.outputs.baz` inside a `run:` shell script's own prose (a
// comment, an echo string) is never evaluated as an expression by GitHub at
// all, so scanning it was a false-positive source — exactly the class of bug
// this suite itself tripped on more than once this session (a step's own
// doc comment mentioning a flag it explicitly no longer uses).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

/**
 * Recursively collect EXPRESSION TEXT ONLY: the captured inner text of every
 * `${{ ... }}` delimiter in any string field, PLUS the raw text of any field
 * literally named `if` (job.if / step.if — GitHub does not require the
 * `${{ }}` wrapper there). Everything else in a plain string (a `run:`
 * script's shell code, a step `name:`, prose in a comment) is inert to
 * GitHub's expression evaluator and is never included.
 */
function collectExpressionText(node, out, isIfField) {
  if (typeof node === 'string') {
    if (isIfField) {
      out.push(node);
    } else {
      for (const m of node.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        out.push(m[1]);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectExpressionText(item, out, false);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectExpressionText(value, out, key === 'if');
    }
  }
}

function normalizeNeeds(needs) {
  if (needs == null) return [];
  return Array.isArray(needs) ? needs : [needs];
}

/**
 * Round-6 review fix (MINOR, code#5): resolve a job's declared outputs —
 * either its own `outputs:` block, or, for a LOCAL reusable-workflow call
 * (`uses: ./path/to/file.yml`), the called file's own
 * `on.workflow_call.outputs:`. A REMOTE call (`owner/repo/.../file.yml@ref`)
 * cannot be resolved without fetching an external repository at a specific
 * ref — documented as an explicit, deliberate skip (`resolvable: false`),
 * never silently treated as "declares nothing" (which would false-positive
 * on every legitimate remote-reusable-workflow output reference).
 */
function resolveJobOutputs(job, repoRoot) {
  if (job && job.outputs && typeof job.outputs === 'object') {
    return { outputs: job.outputs, resolvable: true };
  }
  if (job && typeof job.uses === 'string') {
    if (job.uses.startsWith('./')) {
      const calledPath = path.join(repoRoot, job.uses);
      try {
        const calledDoc = yaml.load(fs.readFileSync(calledPath, 'utf8'));
        const triggers = calledDoc && (calledDoc.on || calledDoc[true]);
        const wcOutputs = (triggers && triggers.workflow_call && triggers.workflow_call.outputs) || {};
        return { outputs: wcOutputs, resolvable: true };
      } catch {
        // The called file is missing or unparseable — fail CLOSED (an empty
        // declared-outputs set), never silently skipped: a genuinely broken
        // local reusable-workflow reference should surface as a violation.
        return { outputs: {}, resolvable: true };
      }
    }
    // Remote `owner/repo/path/file.yml@ref` — documented skip (see above).
    return { outputs: {}, resolvable: false };
  }
  return { outputs: {}, resolvable: true };
}

/**
 * Scan one workflow document for step-id / needs-output reference
 * violations. Returns an array of human-readable violation strings.
 */
function findViolations(file, doc, repoRoot = REPO_ROOT) {
  const violations = [];
  const jobs = doc.jobs || {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    const stepIds = new Set((job.steps || []).filter((s) => s && s.id).map((s) => s.id));
    const neededJobIds = new Set(normalizeNeeds(job.needs));

    const strings = [];
    collectExpressionText(job, strings, false);
    const allText = strings.join('\n');

    for (const m of allText.matchAll(/steps\.([A-Za-z0-9_-]+)\./g)) {
      const stepId = m[1];
      if (!stepIds.has(stepId)) {
        violations.push(
          `${file}: job "${jobId}" references steps.${stepId}. but no step with id "${stepId}" exists in that job `
            + `(known step ids: ${[...stepIds].join(', ') || '(none)'})`,
        );
      }
    }

    for (const m of allText.matchAll(/needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_.-]+)/g)) {
      const refJobId = m[1];
      const outputKey = m[2].split(/[^A-Za-z0-9_-]/)[0];
      if (!neededJobIds.has(refJobId)) {
        violations.push(
          `${file}: job "${jobId}" references needs.${refJobId}.outputs.${outputKey} but "${refJobId}" is not in `
            + `its own needs: (${[...neededJobIds].join(', ') || '(none)'})`,
        );
        continue;
      }
      const refJob = jobs[refJobId];
      if (!refJob) {
        violations.push(`${file}: job "${jobId}" needs "${refJobId}", which does not exist in this workflow`);
        continue;
      }
      const { outputs: refOutputs, resolvable } = resolveJobOutputs(refJob, repoRoot);
      if (!resolvable) continue; // remote reusable-workflow call — documented skip
      if (!Object.prototype.hasOwnProperty.call(refOutputs, outputKey)) {
        violations.push(
          `${file}: job "${jobId}" references needs.${refJobId}.outputs.${outputKey}, but job "${refJobId}" `
            + `declares no such output (declared outputs: ${Object.keys(refOutputs).join(', ') || '(none)'})`,
        );
      }
    }
  }
  return violations;
}

describe('workflow step-id and needs.outputs reference integrity (round-5 review fix, BLOCKER, code#1)', () => {
  const workflowFiles = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  // Round-6 review fix (MINOR, code#6): a workflow file that fails to parse
  // must FAIL this test, not be silently skipped — a real workflow-file
  // syntax error would otherwise pass this invariant vacuously.
  test('every steps.<id>. / needs.<job>.outputs.<x> reference resolves in every workflow file, and every file parses', () => {
    const violations = [];
    for (const file of workflowFiles) {
      let doc;
      try {
        doc = loadWorkflow(file);
      } catch (err) {
        violations.push(`${file}: FAILED TO PARSE as YAML — ${err.message}`);
        continue;
      }
      violations.push(...findViolations(file, doc));
    }
    assert.deepEqual(violations, [], `found workflow reference-integrity violations:\n${violations.join('\n')}`);
  });

  // Confirms the invariant actually FAILS on the exact shape that regressed
  // (backmerge-merge-when-green.yml's `evaluate` job referencing
  // `steps.identity.outputs.login`, a step from a different job) — proving
  // this test is not a vacuous always-pass.
  test('the checker itself catches a cross-job steps.<id>. reference (self-test, not vacuous)', () => {
    const doc = {
      jobs: {
        a: { steps: [{ id: 'resolve', run: 'echo hi' }] },
        b: { steps: [{ id: 'use', env: { X: '${{ steps.resolve.outputs.y }}' } }] },
      },
    };
    const violations = findViolations('fixture.yml', doc);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got:\n${violations.join('\n')}`);
    assert.match(violations[0], /job "b" references steps\.resolve\./);
  });

  // Round-6 review fix (BLOCKER, code#3): the original fixture here had job
  // `a` declare `outputs: { known: '${{ steps.x.outputs.y }}' }` — that
  // value is ITSELF scanned (as job `a`'s own expression text), and job `a`
  // has no step id "x", so it produced a SECOND, unintended violation
  // (expected 1, got 2 — the assertion was simply wrong, not the checker).
  // Fixed here by giving job `a` a literal (non-expression) output value, so
  // the ONLY violation in this fixture is the one under test.
  test('the checker itself catches a needs.<job>.outputs.<x> reference to an undeclared output (self-test, not vacuous)', () => {
    const doc = {
      jobs: {
        a: { steps: [], outputs: { known: 'literal-value' } },
        b: { needs: 'a', steps: [{ env: { X: '${{ needs.a.outputs.unknown }}' } }] },
      },
    };
    const violations = findViolations('fixture.yml', doc);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got:\n${violations.join('\n')}`);
    assert.match(violations[0], /declares no such output/);
  });

  test('the checker itself catches a needs.<job>.outputs reference to a job not listed in needs: (self-test, not vacuous)', () => {
    const doc = {
      jobs: {
        a: { steps: [], outputs: { known: '1' } },
        b: { steps: [{ env: { X: '${{ needs.a.outputs.known }}' } }] }, // no needs: at all
      },
    };
    const violations = findViolations('fixture.yml', doc);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got:\n${violations.join('\n')}`);
    assert.match(violations[0], /is not in its own needs:/);
  });

  // Round-6 review fix (MINOR, code#4): a run: body's own PROSE (comment or
  // echo string) mentioning `steps.foo.` WITHOUT the `${{ }}` wrapper is
  // inert to GitHub's expression evaluator — must not be flagged.
  test('a run: body containing literal (non-${{ }}) "steps.foo." text produces no violation', () => {
    const doc = {
      jobs: {
        a: {
          steps: [
            {
              id: 'only',
              run: '# this step used to reference steps.foo. outputs.bar — no longer does\necho "steps.foo. is just prose here"',
            },
          ],
        },
      },
    };
    const violations = findViolations('fixture.yml', doc);
    assert.deepEqual(violations, []);
  });

  // Round-6 review fix (MINOR, code#4, other half): `if:` fields may omit
  // `${{ }}` entirely — a bare `if: steps.foo.outputs.bar == 'x'` must still
  // be checked (this is a REAL expression, unlike run: prose above).
  test('a bare (non-${{ }}) if: condition referencing an unknown step id IS flagged', () => {
    const doc = {
      jobs: {
        a: {
          steps: [
            { id: 'known', run: 'echo hi' },
            { id: 'gated', if: "steps.unknown.outputs.x == 'y'", run: 'echo gated' },
          ],
        },
      },
    };
    const violations = findViolations('fixture.yml', doc);
    assert.equal(violations.length, 1, `expected exactly 1 violation, got:\n${violations.join('\n')}`);
    assert.match(violations[0], /steps\.unknown\./);
  });

  // Round-6 review fix (MINOR, code#5): needs.<job>.outputs.<x> where <job>
  // is a LOCAL reusable-workflow call resolves against the called file's own
  // on.workflow_call.outputs — not the calling job's (nonexistent) outputs:.
  describe('reusable workflow (uses:) output resolution', () => {
    function withTempRepoRoot(fn) {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ref-fixture-'));
      try {
        return fn(tmpRoot);
      } finally {
        cleanup(tmpRoot);
      }
    }

    test('a needs.<job>.outputs.<x> reference to a LOCAL reusable workflow\'s declared output is accepted', () => {
      withTempRepoRoot((tmpRoot) => {
        const calledRel = './.github/workflows/called.yml';
        const calledAbs = path.join(tmpRoot, '.github', 'workflows', 'called.yml');
        fs.mkdirSync(path.dirname(calledAbs), { recursive: true });
        fs.writeFileSync(
          calledAbs,
          [
            'on:',
            '  workflow_call:',
            '    outputs:',
            '      result:',
            "        value: ${{ jobs.build.outputs.result }}",
            'jobs:',
            '  build:',
            '    runs-on: ubuntu-latest',
            '    steps: []',
          ].join('\n'),
        );
        const doc = {
          jobs: {
            call: { uses: calledRel },
            consumer: { needs: 'call', steps: [{ env: { X: '${{ needs.call.outputs.result }}' } }] },
          },
        };
        const violations = findViolations('fixture.yml', doc, tmpRoot);
        assert.deepEqual(violations, []);
      });
    });

    test('a needs.<job>.outputs.<x> reference to an UNDECLARED output of a local reusable workflow IS flagged', () => {
      withTempRepoRoot((tmpRoot) => {
        const calledRel = './.github/workflows/called.yml';
        const calledAbs = path.join(tmpRoot, '.github', 'workflows', 'called.yml');
        fs.mkdirSync(path.dirname(calledAbs), { recursive: true });
        fs.writeFileSync(
          calledAbs,
          [
            'on:',
            '  workflow_call:',
            '    outputs:',
            '      result:',
            "        value: ${{ jobs.build.outputs.result }}",
            'jobs:',
            '  build:',
            '    runs-on: ubuntu-latest',
            '    steps: []',
          ].join('\n'),
        );
        const doc = {
          jobs: {
            call: { uses: calledRel },
            consumer: { needs: 'call', steps: [{ env: { X: '${{ needs.call.outputs.nonexistent }}' } }] },
          },
        };
        const violations = findViolations('fixture.yml', doc, tmpRoot);
        assert.equal(violations.length, 1, `expected exactly 1 violation, got:\n${violations.join('\n')}`);
        assert.match(violations[0], /declares no such output/);
      });
    });

    test('a needs.<job>.outputs.<x> reference to a REMOTE reusable workflow (owner/repo/...@ref) is skipped, not flagged', () => {
      const doc = {
        jobs: {
          call: { uses: 'some-org/some-repo/.github/workflows/shared.yml@v1' },
          consumer: { needs: 'call', steps: [{ env: { X: '${{ needs.call.outputs.whatever }}' } }] },
        },
      };
      const violations = findViolations('fixture.yml', doc);
      assert.deepEqual(violations, [], 'a remote reusable-workflow output reference cannot be resolved locally and must be skipped, not flagged');
    });
  });
});
