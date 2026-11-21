'use strict';

/**
 * Validate-without-executing tier for planner `<automated>` commands (#4586).
 *
 * #3172's `<fails_when>` cannot reveal that a command does not parse. #4586 has the
 * planner run a validate-only mode where one exists, and the checker flag a command that
 * was neither validated nor marked unvalidatable.
 *
 * The product is agent-loaded Markdown, so it is tested as a typed document: reference
 * tables are parsed header-keyed, wiring files must share one filename, and the sanctioned
 * forms are RUN through the process seam so their safety claims are observed. The notation
 * line is plain text inside `<verify>`; the #2401/#3172 probes must not change because of it.
 * Row ids map to `.gsd/phase/feat-4586-planner-validate-only-tier/50-test-matrix.md`.
 * A test needing `bash` or `python3` skips only when that interpreter is absent from the host.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempDir, createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { runNode, runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  extractAutomatedCommands,
  extractFailingDirections,
  resolveFailingDirection,
} = require('../gsd-core/bin/lib/verify-command-grounding.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const REFERENCE = 'gsd-core/references/planner-verify-command-validation.md';
const REFERENCE_NAME = 'planner-verify-command-validation.md';

/** The closed set of sanctioned forms. The reference table must list exactly these ids. */
const SANCTIONED_IDS = ['bash-n', 'node-check', 'python-ast', 'tsql-parseonly', 'cargo-metadata'];

/** Forms that execute project code, write files, or need init/network: never sanctioned. */
const FORBIDDEN_TOKENS = ['py_compile', 'cargo check', '--dry-run', 'terraform validate'];

/** The placeholder atoms the #3172 probe rejects (tests/failing-direction.test.cjs). */
const PLACEHOLDER_ATOMS = ['tbd', 'todo', 'n/a', 'na', 'none', 'unknown', 'tba', '?', '-'];

const NOTATIONS = [
  '[VALIDATED: bash -n exit 0]',
  '[VALIDATED: prior_verify_commands]',
  '[UNVALIDATABLE: no SQL Server session at plan time]',
];

// ─── Typed-document helpers ───────────────────────────────────────────────────

/** The text of the `## ` section whose heading matches `headingRe`. */
function section(md, headingRe) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && headingRe.test(l));
  assert.ok(start >= 0, `a section matching ${headingRe} must exist`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Parse the first Markdown table in `text` into `{ header, rows }`, rows keyed by header. */
function table(text) {
  const header = [];
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) {
      if (header.length > 0 && rows.length > 0) break;
      continue;
    }
    const cells = line.slice(1, line.lastIndexOf('|')).split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (header.length === 0) { header.push(...cells); continue; }
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return { header, rows };
}

const stripTicks = (s) => s.replace(/`/g, '');

// ─── Plan builders ────────────────────────────────────────────────────────────

/** One task: automated + fails_when, optionally followed by a notation line inside `<verify>`. */
function task(i, { notation = null, eol = '\n' } = {}) {
  const lines = [
    '<task type="auto">',
    `  <name>task-${i}</name>`,
    '  <action>do the thing</action>',
    '  <verify>',
    `    <automated>cmd-${i}</automated>`,
    `    <fails_when>non-zero exit from cmd-${i}</fails_when>`,
  ];
  if (notation !== null) lines.push(`    ${notation}`);
  lines.push('  </verify>', '  <done>committed</done>', '</task>');
  return lines.join(eol);
}

function plan(k, opts = {}) {
  const eol = opts.eol ?? '\n';
  const tasks = [];
  for (let i = 0; i < k; i += 1) tasks.push(task(i, opts));
  return ['# Plan', '', ...tasks].join(eol);
}

const probeView = (text) => JSON.stringify([extractAutomatedCommands(text), extractFailingDirections(text)]);

/** Interpreter availability, probed once per interpreter. */
const availability = new Map();
function available(interpreter) {
  if (!availability.has(interpreter)) {
    const r = runHook('--version', [], { interpreter, timeoutMs: PROBE_TIMEOUT_MS });
    availability.set(interpreter, r.outcome === OUTCOME.EXITED && r.exitCode === 0);
  }
  return availability.get(interpreter);
}

// ─── R: the reference as a typed document ─────────────────────────────────────

describe('the validation reference (#4586)', () => {
  test('R1 — the sanctioned table lists exactly the closed set of validate-only forms', () => {
    const md = read(REFERENCE);
    const { header, rows } = table(section(md, /Sanctioned/i));
    assert.deepEqual(header, ['Id', 'Body language', 'Sanctioned form', 'Needs']);
    assert.deepEqual(rows.map((r) => stripTicks(r.Id)).sort(), [...SANCTIONED_IDS].sort());
    const form = Object.fromEntries(rows.map((r) => [stripTicks(r.Id), r['Sanctioned form']]));
    assert.match(form['bash-n'], /bash -n/);
    assert.match(form['node-check'], /node --check/);
    assert.match(form['python-ast'], /ast\.parse/);
    assert.match(form['tsql-parseonly'], /SET PARSEONLY ON/);
    assert.match(form['cargo-metadata'], /cargo metadata --no-deps/);
  });

  test('R2 — forms that execute or write are named as forbidden, never sanctioned', () => {
    const md = read(REFERENCE);
    const sanctioned = table(section(md, /Sanctioned/i)).rows.map((r) => r['Sanctioned form']).join('\n');
    const never = table(section(md, /Never/i));
    assert.equal(never.header[0], 'Form');
    assert.equal(never.rows.length, FORBIDDEN_TOKENS.length);
    for (const tok of FORBIDDEN_TOKENS) {
      assert.ok(!sanctioned.includes(tok), `${tok} must not be a sanctioned form`);
      const row = never.rows.find((r) => r.Form.includes(tok));
      assert.ok(row, `${tok} must be listed as forbidden`);
      assert.ok(row[never.header[1]].length > 0, `${tok} must state why it is forbidden`);
    }
    for (const tok of ['cargo build', 'cargo test']) {
      assert.ok(!sanctioned.includes(tok), `${tok} must not be a sanctioned form`);
    }
  });

  test('R3 — the reference documents the closed notation grammar', () => {
    const notation = section(read(REFERENCE), /Notation/i);
    assert.ok(notation.includes('[VALIDATED: <validate-only command> exit 0]'));
    assert.ok(notation.includes('[VALIDATED: prior_verify_commands]'));
    assert.ok(notation.includes('[UNVALIDATABLE: <reason>]'));
  });

  test('R4 — placeholder atoms in the reference match the probe\'s atoms', () => {
    const notation = section(read(REFERENCE), /Notation/i);
    const line = notation.split('\n').find((l) => /Rejected as a reason/i.test(l));
    assert.ok(line, 'the Notation section must list the rejected placeholder reasons');
    const listed = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].toLowerCase());
    assert.deepEqual([...listed].sort(), [...PLACEHOLDER_ATOMS].sort());
    for (const atom of listed) {
      assert.equal(resolveFailingDirection('cmd', atom).status, 'placeholder', `${atom} is a probe placeholder`);
    }
  });

  test('R5 — the checker section states severities and exemptions', () => {
    const checker = section(read(REFERENCE), /Checker/i);
    for (const needle of ['WARNING', 'BLOCKER', 'sentinel', 'prior_verify_commands']) {
      assert.ok(checker.includes(needle), `the Checker section must mention ${needle}`);
    }
  });
});

// ─── V: the sanctioned forms, executed ────────────────────────────────────────

describe('the sanctioned forms validate without executing (external-tool agreement)', () => {
  /** Run one sanctioned form over `body`; returns the seam result and the fixture dir. */
  function validate(t, id, body) {
    const dir = createTempDir('gsd-4586-');
    t.after(() => cleanup(dir));
    if (id === 'bash-n') {
      const file = path.join(dir, 'body.sh');
      fs.writeFileSync(file, body);
      return { dir, r: runHook('-n', [file], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS }) };
    }
    if (id === 'node-check') {
      const file = path.join(dir, 'body.cjs');
      fs.writeFileSync(file, body);
      return { dir, r: runNode(['--check', file], { timeoutMs: PROBE_TIMEOUT_MS }) };
    }
    // python-ast: run the exact `-c` program the reference prints, with the body on stdin.
    const form = table(section(read(REFERENCE), /Sanctioned/i)).rows
      .find((r) => stripTicks(r.Id) === 'python-ast')['Sanctioned form'];
    const code = /-c '([^']+)'/.exec(form);
    assert.ok(code, 'the python-ast form must carry its -c program in single quotes');
    return {
      dir,
      r: runHook('-I', ['-c', code[1]], { interpreter: 'python3', input: body, cwd: dir, timeoutMs: PROBE_TIMEOUT_MS }),
    };
  }

  const marker = (dir) => path.join(dir, 'ran.marker').replace(/\\/g, '/');

  test('V1 — bash-n accepts a well-formed body', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const { r } = validate(t, 'bash-n', 'echo "ok"\nif true; then echo y; fi\n');
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, 0, r.stderr);
  });

  test('V2 — bash-n rejects an unterminated quote', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const { r } = validate(t, 'bash-n', 'echo "unterminated\n');
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.notEqual(r.exitCode, 0);
  });

  test('V3 — bash-n never executes the body', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const dir0 = createTempDir('gsd-4586-pre-');
    t.after(() => cleanup(dir0));
    const m = marker(dir0);
    const { r } = validate(t, 'bash-n', `touch "${m}"\n`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.existsSync(m), false, 'validation must not have run the body');
  });

  test('V4 — node-check validates without executing', (t) => {
    const dir0 = createTempDir('gsd-4586-pre-');
    t.after(() => cleanup(dir0));
    const m = marker(dir0);
    const ok = validate(t, 'node-check', `require('node:fs').writeFileSync(${JSON.stringify(m)}, 'x');\n`);
    assert.equal(ok.r.exitCode, 0, ok.r.stderr);
    assert.equal(fs.existsSync(m), false, 'validation must not have run the body');
    const bad = validate(t, 'node-check', 'let x = ;\n');
    assert.notEqual(bad.r.exitCode, 0);
  });

  test('V5 — python-ast validates without executing', (t) => {
    if (!available('python3')) return t.skip('python3 is not installed on this host');
    const dir0 = createTempDir('gsd-4586-pre-');
    t.after(() => cleanup(dir0));
    const m = marker(dir0);
    const ok = validate(t, 'python-ast', `open(${JSON.stringify(m)}, 'w').write('x')\n`);
    assert.equal(ok.r.exitCode, 0, ok.r.stderr);
    assert.equal(fs.existsSync(m), false, 'validation must not have run the body');
    const bad = validate(t, 'python-ast', 'x = (\n');
    assert.notEqual(bad.r.exitCode, 0);
  });

  test('V6 — python-ast writes nothing, py_compile does', (t) => {
    if (!available('python3')) return t.skip('python3 is not installed on this host');
    const { dir } = validate(t, 'python-ast', 'x = 1\n');
    assert.deepEqual(fs.readdirSync(dir), [], 'python-ast must leave the working directory untouched');
    const src = path.join(dir, 'a.py');
    fs.writeFileSync(src, 'x = 1\n');
    const compiled = runHook('-m', ['py_compile', src], { interpreter: 'python3', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(compiled.exitCode, 0, compiled.stderr);
    assert.ok(fs.existsSync(path.join(dir, '__pycache__')), 'py_compile writes a .pyc — the reason it is forbidden');
  });

  test('V7 — an outer-layer pass says nothing about the embedded payload', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const outer = validate(t, 'bash-n', `sh -c "node -e 'let x = ;'"\n`);
    assert.equal(outer.r.exitCode, 0, 'the shell layer is well-formed');
    const inner = validate(t, 'node-check', 'let x = ;\n');
    assert.notEqual(inner.r.exitCode, 0, 'the embedded layer is not');
  });

  test('V8 — hostile bodies are validated as data', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const dir0 = createTempDir('gsd-4586-pre-');
    t.after(() => cleanup(dir0));
    const m = marker(dir0);
    const body = [`echo $(touch "${m}") \`touch "${m}"\`; touch "${m}"`, `printf '%s' "a'b"`, ''].join('\n');
    const { r } = validate(t, 'bash-n', body);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.existsSync(m), false, 'command substitution must not have run');
  });

  test('V9 — an empty body is not a validation result', (t) => {
    if (!available('bash')) return t.skip('bash is not installed on this host');
    const { r } = validate(t, 'bash-n', '');
    assert.equal(r.exitCode, 0, 'an empty body parses — so exit 0 alone cannot signal "validated"');
    assert.ok(/empty or whitespace-only/.test(section(read(REFERENCE), /Notation/i)),
      'the reference must say an empty or whitespace-only body is not a validation result');
  });
});

// ─── W: wiring ────────────────────────────────────────────────────────────────

describe('the contract is wired to one reference file (#4586)', () => {
  const CONSUMERS = [
    'gsd-core/workflows/plan-phase.md',
    'gsd-core/references/planner-failing-direction.md',
    'agents/gsd-plan-checker.md',
  ];

  test('W1 — the planner spawn contract loads the validation reference', () => {
    const block = read('gsd-core/workflows/plan-phase.md')
      .split('<failing_direction_contract>')[1]
      ?.split('</failing_direction_contract>')[0];
    assert.ok(block, 'plan-phase.md must keep the <failing_direction_contract> block');
    assert.ok(block.includes(REFERENCE_NAME), 'the spawn contract must load the validation reference');
    assert.ok(fs.existsSync(path.join(ROOT, REFERENCE)), 'the referenced file must exist');
  });

  test('W2 — failing-direction cross-references without changing its contract', () => {
    const src = read('gsd-core/references/planner-failing-direction.md');
    assert.ok(src.includes(REFERENCE_NAME));
    assert.ok(src.includes('**Every runnable `<automated>` command needs a `<fails_when>` sibling naming what output'));
    assert.ok(src.includes('**The authoring test, applied to yourself:**'));
    assert.ok(src.includes('The `MISSING — Wave 0 must create …` sentinel is exempt.'));
  });

  test('W3 — the grounding reference is honest about being JS-shaped', () => {
    const head = read('gsd-core/references/planner-verify-command-grounding.md').split('\n').slice(0, 16).join('\n');
    assert.ok(/npm/.test(head), 'the opening must state the npm / package.json shape of the grounding rule');
    assert.ok(head.includes(REFERENCE_NAME), 'the opening must point other stacks at the validation reference');
  });

  test('W4 — the checker carries a pointer to the validation check', () => {
    const checker = read('agents/gsd-plan-checker.md');
    assert.ok(/Check 8g/.test(checker));
    assert.ok(checker.includes(REFERENCE_NAME));
  });

  test('W5 — every consumer names the same reference file', () => {
    for (const rel of CONSUMERS) {
      const names = new Set(read(rel).match(/planner-verify-command-validation[\w.-]*/g) ?? []);
      assert.deepEqual([...names], [REFERENCE_NAME], `${rel} must name exactly ${REFERENCE_NAME}`);
    }
  });

  test('W6 — the frozen planner agent is untouched', () => {
    const src = read('agents/gsd-planner.md');
    assert.ok(src.length < 49152, `gsd-planner.md is ${src.length} LF chars — must stay < 49152`);
    assert.ok(!src.includes('planner-verify-command-validation'));
  });
});

// ─── N: the existing probes are undisturbed ───────────────────────────────────

describe('a notation line does not disturb the #2401/#3172 probes (Hyrum)', () => {
  test('N1 — notation lines do not change what the probes extract', () => {
    const base = probeView(plan(3));
    for (const notation of NOTATIONS) {
      assert.equal(probeView(plan(3, { notation })), base, notation);
    }
  });

  test('N2 — verify plan-structure ignores notation lines', (t) => {
    const frontmatter = [
      '---', 'phase: 01-test', 'plan: 01', 'type: execute', 'wave: 1', 'depends_on: []',
      'files_modified: [src/a.js]', 'autonomous: true', 'must_haves:', '  truths: ["it works"]', '---', '',
    ].join('\n');
    const body = (notation) => `${frontmatter}<objective>Do it</objective>\n\n<tasks>\n${task(0, { notation })}\n</tasks>\n\n<output>Write the summary</output>\n`;
    const verdict = (notation) => {
      const tmp = createTempProject();
      t.after(() => cleanup(tmp));
      const dir = path.join(tmp, '.planning', 'phases', '01-test');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), body(notation));
      const res = runGsdTools('verify plan-structure .planning/phases/01-test/01-01-PLAN.md', tmp);
      assert.ok(res.exitCode === 0 || res.exitCode === 1, `a verdict was delivered: ${res.error}`);
      const out = JSON.parse(res.output);
      return JSON.stringify({ valid: out.valid, errors: out.errors, warnings: out.warnings });
    };
    const base = verdict(null);
    for (const notation of NOTATIONS) assert.equal(verdict(notation), base, notation);
  });

  test('N3 — P1: arbitrary notation text never changes probe output', () => {
    const base = probeView(plan(2));
    const text = fc.string().filter((s) => !/[<>]/.test(s));
    fc.assert(fc.property(text, fc.constantFrom(0, 1), (s, position) => {
      const line = `[VALIDATED: ${s}]`;
      const withLine = position === 0
        ? plan(2, { notation: line })
        : plan(2).replace('</verify>', `  ${line}\n  </verify>`);
      return probeView(withLine) === base;
    }));
  });

  test('N4 — P2: CRLF invariance with notation present', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.constantFrom(...NOTATIONS), (k, notation) => {
      return probeView(plan(k, { notation, eol: '\n' })) === probeView(plan(k, { notation, eol: '\r\n' }));
    }));
  });

  test('N5 — notation lines do not shift the probe walk bound', () => {
    // Find the bound by probing, not by hard-coding it: the smallest k at which extraction
    // returns fewer than k commands is limit + 1.
    const truncated = (k) => extractAutomatedCommands(plan(k)).length < k;
    let hi = 1;
    while (!truncated(hi)) hi *= 2;
    let lo = Math.floor(hi / 2);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (truncated(mid)) hi = mid; else lo = mid;
    }
    const limit = hi - 1;
    for (const k of [limit - 1, limit, limit + 1]) {
      const bare = extractAutomatedCommands(plan(k)).length;
      const marked = extractAutomatedCommands(plan(k, { notation: NOTATIONS[0] })).length;
      assert.equal(marked, bare, `count at ${k === limit ? 'limit' : k < limit ? 'limit-1' : 'limit+1'} (${k})`);
    }
  });

  test('N6 — a notation string outside verify is inert', () => {
    const base = probeView(plan(1));
    const prose = plan(1).replace('do the thing', 'record [VALIDATED: bash -n exit 0] in the notes');
    assert.equal(probeView(prose), base);
  });
});
