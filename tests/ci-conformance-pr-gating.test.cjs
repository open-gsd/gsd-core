'use strict';

// #5604 — the Windows/macOS conformance lane may be skipped on pull_request
// runs behind an off-by-default repo variable, and never on any other event.
//
// The risk this suite guards is asymmetric:
//   - variable unset (today): the lane must behave exactly as before, or merging
//     the change alters CI for everyone.
//   - variable on, non-PR event (merge_group, push, workflow_dispatch): the lane
//     must still run, or Windows/macOS regressions are never caught anywhere.
//
// The job's `if:` is evaluated with a small interpreter for the subset of the
// GitHub expression grammar it uses, against a scenario table, so the suite
// asserts behaviour and not the spelling of the expression.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'test.yml');
const JOB = 'test-conformance';

// ---------------------------------------------------------------------------
// Expression interpreter: ||  &&  !  ==  !=  ( )  contains(a, b)  'str'  a.b.*.c
// ---------------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  const re = /\s*(&&|\|\||==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][\w.*-]*)/gy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (src.slice(pos).trim() === '') break;
      throw new Error(`cannot tokenize near: ${src.slice(pos, pos + 20)}`);
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

function lookup(ctx, dotted) {
  const parts = dotted.split('.');
  let cur = ctx;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur === undefined || cur === null) return '';
    if (parts[i] === '*') {
      const rest = parts.slice(i + 1);
      return (Array.isArray(cur) ? cur : []).map((item) => rest.reduce((v, k) => (v == null ? v : v[k]), item));
    }
    cur = cur[parts[i]];
  }
  return cur === undefined || cur === null ? '' : cur;
}

function evaluate(expr, ctx) {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => {
    if (t !== undefined && tokens[i] !== t) throw new Error(`expected ${t}, got ${tokens[i]}`);
    return tokens[i++];
  };

  function primary() {
    const t = peek();
    if (t === '(') {
      take('(');
      const v = orExpr();
      take(')');
      return v;
    }
    if (t === '!') {
      take('!');
      return !primary();
    }
    if (t.startsWith("'")) {
      take();
      return t.slice(1, -1).replace(/''/g, "'");
    }
    take();
    if (peek() === '(') {
      take('(');
      const args = [];
      if (peek() !== ')') {
        args.push(orExpr());
        while (peek() === ',') {
          take(',');
          args.push(orExpr());
        }
      }
      take(')');
      assert.equal(t, 'contains', `unsupported function ${t}`);
      const [hay, needle] = args;
      // GitHub's contains() ignores case, like its comparison operators.
      const lower = (v) => String(v).toLowerCase();
      return Array.isArray(hay) ? hay.map(lower).includes(lower(needle)) : lower(hay).includes(lower(needle));
    }
    return lookup(ctx, t);
  }

  function equality() {
    let left = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const right = primary();
      // GitHub compares strings case-insensitively; mirror that so the table
      // below reflects what the runner would decide.
      const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
      left = op === '==' ? norm(left) === norm(right) : norm(left) !== norm(right);
    }
    return left;
  }
  function andExpr() {
    let left = equality();
    while (peek() === '&&') {
      take('&&');
      const right = equality();
      left = left && right;
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek() === '||') {
      take('||');
      const right = andExpr();
      left = left || right;
    }
    return left;
  }

  const result = orExpr();
  assert.equal(i, tokens.length, `trailing tokens in: ${expr}`);
  return Boolean(result);
}

// ---------------------------------------------------------------------------

const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
const condition = doc.jobs[JOB].if;

function runs({ event, variable, labels = [], codeChanged = 'true', fullMatrix = 'true' }) {
  return evaluate(condition, {
    needs: { changes: { outputs: { code_changed: codeChanged, full_matrix: fullMatrix } } },
    github: { event_name: event, event: { pull_request: { labels: labels.map((name) => ({ name })) } } },
    vars: variable === undefined ? {} : { GSD_PR_LINUX_ONLY: variable },
  });
}

describe('#5604: interpreter sanity', () => {
  test('evaluates the grammar the job condition uses', () => {
    assert.equal(evaluate("a == 'x' && (b != 'y' || contains(l.*.name, 'k'))", { a: 'x', b: 'y', l: [{ name: 'k' }] }), true);
    assert.equal(evaluate("a == 'x' && (b != 'y' || contains(l.*.name, 'k'))", { a: 'x', b: 'y', l: [{ name: 'z' }] }), false);
    assert.equal(evaluate("a == 'x' || b == 'y'", { a: 'q', b: 'y' }), true);
  });
});

describe('#5604: variable unset keeps today\'s behaviour', () => {
  for (const event of ['pull_request', 'merge_group', 'push', 'workflow_dispatch']) {
    test(`${event}: runs when scope says full matrix`, () => {
      assert.equal(runs({ event }), true);
    });
    test(`${event}: skipped when the classifier does not ask for the full matrix`, () => {
      assert.equal(runs({ event, fullMatrix: 'false' }), false);
    });
    test(`${event}: skipped when no code changed`, () => {
      assert.equal(runs({ event, codeChanged: 'false' }), false);
    });
  }
});

describe('#5604: variable on', () => {
  test('pull_request without the label skips the lane', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true' }), false);
  });

  test('pull_request with the full-matrix label runs the lane', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true', labels: ['full-matrix'] }), true);
  });

  test('an unrelated label does not opt in', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true', labels: ['no-changelog'] }), false);
  });

  test('the label is matched case-insensitively', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true', labels: ['Full-Matrix'] }), true);
  });

  test('the label cannot force the lane when no code changed', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true', labels: ['full-matrix'], codeChanged: 'false' }), false);
  });

  test('the label cannot force the lane when the classifier asked for nothing', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'true', labels: ['full-matrix'], fullMatrix: 'false' }), false);
  });

  for (const event of ['merge_group', 'push', 'workflow_dispatch']) {
    test(`${event} still runs the lane`, () => {
      assert.equal(runs({ event, variable: 'true' }), true);
    });
  }

  test('any variable value other than true leaves PR behaviour unchanged', () => {
    for (const variable of ['', 'false', '1', 'yes']) {
      assert.equal(runs({ event: 'pull_request', variable }), true, `variable=${JSON.stringify(variable)}`);
    }
  });

  test('the comparison is case-insensitive, as in GitHub expressions', () => {
    assert.equal(runs({ event: 'pull_request', variable: 'TRUE' }), false);
  });
});

describe('#5604: the required gate tolerates a skipped lane', () => {
  const gate = doc.jobs['required-tests'];
  const script = gate.steps.find((step) => typeof step.run === 'string' && step.env).run;

  const greenEnv = {
    PREFLIGHT_RESULT: 'success',
    NEXT_HEALTH_RESULT: 'success',
    CODE_CHANGED: 'true',
    PRODUCT_CHANGED: 'true',
    CHANGES_RESULT: 'success',
    LINT_RESULT: 'success',
    TEST_RESULT: 'success',
    TEST_CONFORMANCE_RESULT: 'success',
    INERT_RESULT: 'skipped',
    COVERAGE_GATE_RESULT: 'success',
    QA_LOOP_WALK_RESULT: 'success',
  };

  function runGate(t, overrides) {
    const dir = createTempDir('gsd-5604-gate-');
    t.after(() => cleanup(dir));
    const file = path.join(dir, 'required-tests.sh');
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    return runHook(file, [], {
      interpreter: 'bash',
      cwd: dir,
      env: { PATH: process.env.PATH, ...greenEnv, ...overrides },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  test('required-tests depends on test-conformance and is not skipped with it', () => {
    assert.ok(gate.needs.includes(JOB));
    assert.equal(gate.if, 'always()');
  });

  test('a skipped conformance lane passes the real aggregation script', (t) => {
    const result = runGate(t, { TEST_CONFORMANCE_RESULT: 'skipped' });
    assert.equal(result.exitCode, 0, result.stderr);
  });

  test('a failed conformance lane still fails it', (t) => {
    for (const bad of ['failure', 'cancelled']) {
      const result = runGate(t, { TEST_CONFORMANCE_RESULT: bad });
      assert.equal(result.exitCode, 1, `TEST_CONFORMANCE_RESULT=${bad}`);
    }
  });
});
