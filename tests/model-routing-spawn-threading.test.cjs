// allow-test-rule: source-text-is-the-product #2072
// Workflow .md files ARE the deployed orchestration contract the runtime executes;
// asserting that a spawn threads a resolved model= is asserting the deployed contract.

'use strict';

/**
 * #2072 — model_overrides / models.<phaseType> were silently inert for
 * gsd-assumptions-analyzer and gsd-code-reviewer on Claude: the resolver honored
 * them, but the workflows spawned the agents with NO model= param, so the resolved
 * value never reached the Agent tool and the agents inherited the session model.
 *
 * Fix contract: every spawn of these two catalog agents must thread a resolved
 * model=, and the workflow must obtain that model (inline `resolve-model` for the
 * single-agent workflows, or the `reviewer_model` field of the init.quick bundle).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', 'gsd-core', 'workflows');
const read = (rel) => fs.readFileSync(path.join(WF, rel), 'utf-8');

// Every .md under gsd-core/workflows (incl. nested steps/ and modes/).
function allWorkflowMd() {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name));
      else if (e.name.endsWith('.md')) out.push(path.join(rel, e.name));
    }
  })(WF, '');
  return out;
}

// Return the full text of every `Agent( … )` call in `content`, tracking string
// state (triple- and single-double-quoted) and paren depth so a prompt body's own
// parens/quotes don't end the call early. Order-independent: a call's params are
// captured whether subagent_type= appears before or after the prompt.
function agentCalls(content) {
  const calls = [];
  const re = /Agent\(/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let tq = false; // inside """ … """
    let sq = false; // inside " … "
    while (i < content.length && depth > 0) {
      if (tq) {
        if (content.startsWith('"""', i)) { tq = false; i += 3; continue; }
        i++; continue;
      }
      if (sq) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '"') { sq = false; }
        i++; continue;
      }
      if (content.startsWith('"""', i)) { tq = true; i += 3; continue; }
      if (content[i] === '"') { sq = true; i++; continue; }
      if (content[i] === '(') { depth++; }
      else if (content[i] === ')') { depth--; }
      i++;
    }
    calls.push(content.slice(m.index, i));
    re.lastIndex = i; // don't re-scan inside this call
  }
  return calls;
}

describe('#2072: routed-agent spawns thread the resolved model', () => {
  test('discuss-phase-assumptions.md resolves + threads gsd-assumptions-analyzer model', () => {
    const c = read('discuss-phase-assumptions.md');
    assert.match(c, /resolve-model gsd-assumptions-analyzer/, 'must resolve the routed model');
    assert.match(
      c,
      /subagent_type="gsd-assumptions-analyzer",\s*model="\{ANALYZER_MODEL\}"/,
      'spawn must thread the resolved model=',
    );
  });

  test('code-review.md resolves + threads gsd-code-reviewer model', () => {
    const c = read('code-review.md');
    assert.match(c, /resolve-model gsd-code-reviewer/);
    assert.match(c, /subagent_type="gsd-code-reviewer",\s*model="\{REVIEWER_MODEL\}"/);
  });

  test('code-review-fix.md re-review resolves + threads gsd-code-reviewer model', () => {
    const c = read('code-review-fix.md');
    assert.match(c, /resolve-model gsd-code-reviewer/);
    assert.match(c, /subagent_type="gsd-code-reviewer",\s*model="\{REVIEWER_MODEL\}"/);
  });

  test('quick.md review step threads gsd-code-reviewer own model (not executor_model)', () => {
    const c = read('quick.md');
    // reviewer_model comes from the init.quick bundle; the spawn must use it.
    assert.match(c, /subagent_type="gsd-code-reviewer",\s*\n\s*model="\{reviewer_model\}"/);
    assert.doesNotMatch(
      c,
      /subagent_type="gsd-code-reviewer",\s*\n\s*model="\{executor_model\}"/,
      'reviewer must not reuse the executor model (own model_overrides would be ignored)',
    );
  });

  test('code-review-fix.md threads gsd-code-fixer model at both fixer spawns', () => {
    const c = read('code-review-fix.md');
    assert.match(c, /resolve-model gsd-code-fixer/, 'must resolve the fixer model');
    const fixerSpawns = c.match(/subagent_type="gsd-code-fixer", model="\{FIXER_MODEL\}"/g) || [];
    assert.strictEqual(fixerSpawns.length, 2, 'both gsd-code-fixer spawns must thread FIXER_MODEL');
  });

  // Parity guard: EVERY spawn of the fixed routed agents across ALL workflows must
  // carry a model= in its Agent(...) call, so a new silently-inert spawn cannot
  // regress. Uses a quote/paren-aware scan of the WHOLE Agent(...) call, so it holds
  // for single-line and multi-line calls, multiple spawns per file, and either param
  // ordering (subagent_type= before OR after the prompt body).
  test('no spawn of the fixed routed agents is missing a model= (parity guard)', () => {
    const ROUTED = /subagent_type="(gsd-code-reviewer|gsd-assumptions-analyzer|gsd-code-fixer)"/;
    const offenders = [];
    for (const rel of allWorkflowMd()) {
      for (const call of agentCalls(read(rel))) {
        const routed = call.match(ROUTED);
        if (routed && !/\bmodel\s*=/.test(call)) {
          offenders.push(`${rel}: ${routed[1]} spawn missing model=`);
        }
      }
    }
    assert.deepEqual(offenders, [], `routed-agent spawn(s) missing model=:\n${offenders.join('\n')}`);
  });

  // The scanner itself must catch a prompt-first, un-threaded spawn (the exact blind
  // spot a naive "params before prompt=" heuristic misses) — otherwise the guard
  // above could pass vacuously.
  test('parity guard detects a prompt-first spawn that omits model=', () => {
    const synthetic = [
      'Agent(',
      '  prompt="""do the thing (with parens) and a " quote""",',
      '  subagent_type="gsd-code-reviewer"',
      ')',
    ].join('\n');
    const [call] = agentCalls(synthetic);
    assert.ok(/subagent_type="gsd-code-reviewer"/.test(call), 'scanner must capture the prompt-first subagent_type');
    assert.ok(!/\bmodel\s*=/.test(call), 'and correctly see that model= is absent');
    // A well-formed prompt-first spawn WITH model= must be accepted.
    const ok = agentCalls(synthetic.replace(')', '  model="{reviewer_model}"\n)'))[0];
    assert.ok(/\bmodel\s*=/.test(ok));
  });
});
