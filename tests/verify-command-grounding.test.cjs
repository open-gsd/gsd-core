'use strict';

/**
 * Verify-command grounding (#2401).
 *
 * Module: gsd-core/bin/lib/verify-command-grounding.cjs
 * Exported: extractAutomatedCommands, resolveVerifyCommandTarget,
 *           probePhaseVerifyCommands, harvestPriorVerifyCommands
 *
 * #2401: a planner authored `<automated>cd ../../frontend && npm run lint</automated>`
 * whose target does not resolve from the executor's cwd, and the plan-checker —
 * lacking a deterministic probe — hand-reasoned the filesystem and prescribed two
 * successively-wrong replacement paths.
 *
 * This module answers "can this command's target directory be grounded?" WITHOUT
 * executing the command. It is a RECOGNIZER, not a shell interpreter: exactly two
 * forms are grounded (`cd <literal>` and `npm --prefix <literal>`), and anything
 * carrying a variable, glob, substitution, or a LEADING `~` (home-expansion)
 * returns `unresolvable` — a warning, never a blocker. A `~` anywhere else in
 * the path (e.g. a Windows 8.3 short name like `RUNNER~1`) is an ordinary
 * literal character and must resolve normally (#2401 CI regression). Refusing
 * to guess is the whole point; guessing is the defect being fixed.
 *
 * Row numbers below map to `.gsd/phase/feat-2401-verify-command-grounding/50-test-matrix.md`.
 *
 * IO-failure rows monkeypatch the `fs` method and restore in `finally` — never
 * `chmod 0o000`, which root bypasses in Docker/CI so the test would pass with
 * zero coverage.
 *
 * The final `describe('property-based invariants', …)` block below carries the
 * fast-check property tests for this module. Properties covered:
 *   (a) resolveVerifyCommandTarget never throws and always returns a known
 *       status/severity/base shape, for arbitrary string input.
 *   (b) a 'blocker' severity is only ever reported for a grounded form: form
 *       is non-null and target is a non-empty string.
 *   (c) extractAutomatedCommands recovers every generated <automated> command,
 *       in order, from synthesized plan text.
 *   (d) CRLF invariance: the same plan rendered with \r\n line joins produces
 *       an identical command list.
 *   (e) extractAutomatedCommands never throws on arbitrary input, including
 *       non-string values, and returns [] for non-strings.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, runGsdTools } = require('./helpers.cjs');

const {
  extractAutomatedCommands,
  resolveVerifyCommandTarget,
  probePhaseVerifyCommands,
  harvestPriorVerifyCommands,
} = require('../gsd-core/bin/lib/verify-command-grounding.cjs');
const { extractTaggedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const KNOWN_STATUSES = new Set([
  'ok',
  'broken',
  'unresolvable',
  'not_applicable',
  'pending_creation',
]);

/** Root for every fixture built by this file; removed in `after`. */
let ROOT = '';

function fixtureRoot(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir, scripts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', scripts }), 'utf8');
}

/** Build a minimal PLAN.md body with one `<automated>` per supplied command. */
function planWith(commands, { taskFiles = [], artifacts = [], eol = '\n' } = {}) {
  const tasks = commands
    .map(
      (cmd, i) =>
        [
          '<task type="auto">',
          `  <name>task-${i}</name>`,
          `  <files>${taskFiles[i] ?? ''}</files>`,
          '  <action>do the thing</action>',
          `  <verify><automated>${cmd}</automated></verify>`,
          '  <acceptance_criteria>it works</acceptance_criteria>',
          '  <done>committed</done>',
          '</task>',
        ].join(eol),
    )
    .join(eol);
  const artifactSection = artifacts.length
    ? [eol, '## Artifacts this phase produces', ...artifacts.map((a) => `- ${a}`)].join(eol)
    : '';
  return ['# Plan', '', tasks, artifactSection].join(eol);
}

function writePhase(root, phaseName, plans) {
  const planningDir = path.join(root, '.planning');
  const phaseDir = path.join(planningDir, phaseName);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [file, body] of Object.entries(plans)) {
    fs.writeFileSync(path.join(phaseDir, file), body, 'utf8');
  }
  return phaseDir;
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2401-'));
});

after(() => {
  if (ROOT) cleanup(ROOT);
});

describe('extractAutomatedCommands', () => {
  test('row 29 — non-string plan text yields empty list', () => {
    for (const bad of [0, '', [], null, undefined, true, {}]) {
      assert.deepEqual(extractAutomatedCommands(bad), [], `input ${JSON.stringify(bad)}`);
    }
  });

  test('row 30 — empty automated block is skipped', () => {
    const out = extractAutomatedCommands(planWith(['', '   ', 'npm test']));
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
  });

  test('row 31 — attribute-bearing automated tag is extracted', () => {
    const md = '<task type="auto"><name>t</name><verify><automated tier="fast">npm test</automated></verify></task>';
    const out = extractAutomatedCommands(md);
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
  });

  test('row 32 — unclosed automated openers terminate', () => {
    const md = '<automated>'.repeat(200);
    const out = extractAutomatedCommands(md);
    assert.ok(Array.isArray(out));
  });

  test('row 27 — repeated command reports both occurrences', () => {
    const out = extractAutomatedCommands(planWith(['npm test', 'npm test']));
    assert.equal(out.length, 2);
  });

  test('carries the owning task name', () => {
    const out = extractAutomatedCommands(planWith(['npm test']));
    assert.equal(out[0].task, 'task-0');
  });

  test('row 25 — CRLF plan yields identical extraction to LF', () => {
    const lf = extractAutomatedCommands(planWith(['cd web && npm test', 'npm run build']));
    const crlf = extractAutomatedCommands(planWith(['cd web && npm test', 'npm run build'], { eol: '\r\n' }));
    assert.deepEqual(
      crlf.map((c) => c.command),
      lf.map((c) => c.command),
    );
  });
});

describe('task-grammar parity', () => {
  test('extractAutomatedCommands attributes the same task names as the canonical sectionizer', () => {
    const longAttr = 'x'.repeat(400);
    const fixture = [
      '<task><name>bare</name><verify><automated>echo bare</automated></verify></task>',
      '<task type="auto"><name>typed</name><verify><automated>echo typed</automated></verify></task>',
      `<task type="auto" data-note="${longAttr}"><name>longattr</name><verify><automated>echo longattr</automated></verify></task>`,
      '<task><name>adjacent-a</name><verify><automated>echo a</automated></verify></task>',
      '<task><name>adjacent-b</name><verify><automated>echo b</automated></verify></task>',
      '<task><name>lt</name><verify><automated>echo "a < b" && echo x < y</automated></verify></task>',
    ].join('\n');

    const attributed = new Set(extractAutomatedCommands(fixture).map((c) => c.task));
    const canonicalNames = new Set(
      extractTaggedBlocks(fixture, 'task', true).map((body) => {
        const m = /<name>([\s\S]*?)<\/name>/.exec(body);
        return m ? m[1].trim() : '';
      }),
    );

    assert.deepEqual(attributed, canonicalNames);
    assert.deepEqual(
      [...attributed].sort(),
      ['adjacent-a', 'adjacent-b', 'bare', 'longattr', 'lt', 'typed'],
    );
  });
});

describe('resolveVerifyCommandTarget — grounded forms', () => {
  test('row 1 — no cd or prefix is not applicable', () => {
    const root = fixtureRoot('row1');
    const r = resolveVerifyCommandTarget('npm test -- --filter=x', { projectRoot: root });
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.target, null);
    assert.equal(r.severity, 'none');
  });

  test('row 2 — resolves a cd target that exists', () => {
    const root = fixtureRoot('row2');
    writePackageJson(path.join(root, 'frontend'), { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.form, 'cd');
    assert.equal(r.target, path.join(root, 'frontend'));
    assert.equal(r.manifest, 'package.json');
    assert.equal(r.severity, 'none');
  });

  test('row 3 — flags the reported unresolvable cd target', () => {
    // Nested two levels deep so `cd ../../frontend` resolves to
    // `<row3-root>/frontend` — inside the suite's own temp root, which it
    // controls and does not create — rather than escaping into the shared OS
    // temp directory where a stray `frontend/` could silently flip the
    // assertion.
    const root = fixtureRoot('row3/a/b');
    const r = resolveVerifyCommandTarget('cd ../../frontend && npm run lint && npm run build', {
      projectRoot: root,
    });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'missing_dir');
    assert.equal(r.severity, 'blocker');
    // The probe reports what it resolved; it never prescribes a replacement.
    assert.equal(r.rawTarget, '../../frontend');
    assert.ok(!('suggestion' in r), 'probe must not prescribe a replacement path');
  });

  test('row 4 — dir without a manifest is broken for an npm command', () => {
    const root = fixtureRoot('row4');
    fs.mkdirSync(path.join(root, 'docs-only'), { recursive: true });
    const r = resolveVerifyCommandTarget('cd docs-only && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'no_manifest');
    assert.equal(r.severity, 'blocker');
  });

  test('row 5 — non-npm command needs no manifest', () => {
    const root = fixtureRoot('row5');
    fs.mkdirSync(path.join(root, 'docs-only'), { recursive: true });
    const r = resolveVerifyCommandTarget('cd docs-only && grep -q x README.md', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
  });

  test('row 6 — resolves npm --prefix', () => {
    const root = fixtureRoot('row6');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run build', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.form, 'prefix');
    assert.equal(r.target, path.join(root, 'web'));
  });

  test('row 7 — resolves trailing --prefix', () => {
    const root = fixtureRoot('row7');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run build --prefix ./web', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'web'));
  });

  test('row 8 — absolute prefix is not joined to root', () => {
    const root = fixtureRoot('row8');
    const abs = path.join(ROOT, 'row8-abs');
    writePackageJson(abs, { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget(`npm --prefix ${abs} run lint`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, abs);
  });

  test('row 9 — folds chained cd segments', () => {
    const root = fixtureRoot('row9');
    writePackageJson(path.join(root, 'a', 'b'), { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd a && cd b && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'a', 'b'));
  });

  test('row 22 — cd dot resolves to project root', () => {
    const root = fixtureRoot('row22');
    writePackageJson(root, { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd . && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, root);
  });

  test('row 20 — normalizes windows separators', () => {
    const root = fixtureRoot('row20');
    const back = resolveVerifyCommandTarget('cd ..\\..\\frontend && npm test', { projectRoot: root });
    const fwd = resolveVerifyCommandTarget('cd ../../frontend && npm test', { projectRoot: root });
    assert.equal(back.status, fwd.status);
    assert.equal(back.target, fwd.target);
  });

  test('row 35 — file at target path is not a directory', () => {
    const root = fixtureRoot('row35');
    fs.writeFileSync(path.join(root, 'frontend'), 'not a dir', 'utf8');
    const r = resolveVerifyCommandTarget('cd frontend && npm test', { projectRoot: root });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'missing_dir');
  });
});

describe('#4730 — entity-escaped chain operators decode to the same verdict as the literal form', () => {
  test('escaped && agrees with literal && when the cd target exists', () => {
    const root = fixtureRoot('4730-ok');
    writePackageJson(path.join(root, 'src'), { test: 'node --version' });
    const esc = resolveVerifyCommandTarget('cd src &amp;&amp; npm test', { projectRoot: root });
    const lit = resolveVerifyCommandTarget('cd src && npm test', { projectRoot: root });
    assert.equal(esc.status, 'ok');
    assert.equal(esc.status, lit.status);
    assert.equal(esc.reason, lit.reason);
    assert.equal(esc.severity, lit.severity);
    assert.equal(esc.form, lit.form);
    assert.equal(esc.target, lit.target);
    assert.equal(esc.rawTarget, lit.rawTarget);
    assert.equal(esc.manifest, lit.manifest);
  });

  test('escaped && on a missing dir keeps the literal form\u2019s missing_dir blocker', () => {
    const root = fixtureRoot('4730-missing');
    const esc = resolveVerifyCommandTarget('cd nope &amp;&amp; npm test', { projectRoot: root });
    const lit = resolveVerifyCommandTarget('cd nope && npm test', { projectRoot: root });
    assert.equal(esc.status, 'broken');
    assert.equal(esc.reason, 'missing_dir');
    assert.equal(esc.severity, 'blocker');
    assert.equal(esc.status, lit.status);
    assert.equal(esc.reason, lit.reason);
    assert.equal(esc.severity, lit.severity);
    assert.equal(esc.rawTarget, lit.rawTarget);
  });

  test('escaped && on a dir without a manifest keeps the literal form\u2019s no_manifest blocker', () => {
    const root = fixtureRoot('4730-nomanifest');
    fs.mkdirSync(path.join(root, 'docs-only'), { recursive: true });
    const esc = resolveVerifyCommandTarget('cd docs-only &amp;&amp; npm run lint', { projectRoot: root });
    const lit = resolveVerifyCommandTarget('cd docs-only && npm run lint', { projectRoot: root });
    assert.equal(esc.status, 'broken');
    assert.equal(esc.reason, 'no_manifest');
    assert.equal(esc.severity, 'blocker');
    assert.equal(esc.status, lit.status);
    assert.equal(esc.reason, lit.reason);
    assert.equal(esc.severity, lit.severity);
  });

  test('escaped && agrees with literal && for the --prefix form', () => {
    const root = fixtureRoot('4730-prefix');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const esc = resolveVerifyCommandTarget('npm --prefix ./web run build &amp;&amp; echo done', {
      projectRoot: root,
    });
    const lit = resolveVerifyCommandTarget('npm --prefix ./web run build && echo done', {
      projectRoot: root,
    });
    assert.equal(esc.status, 'ok');
    assert.equal(esc.status, lit.status);
    assert.equal(esc.form, lit.form);
    assert.equal(esc.target, lit.target);
  });

  test('a literal & inside a quoted dir name survives the decode intact', () => {
    const root = fixtureRoot('4730-litamp');
    writePackageJson(path.join(root, 'a&b'), { test: 'node --version' });
    const esc = resolveVerifyCommandTarget('cd "a&amp;b" &amp;&amp; npm test', { projectRoot: root });
    const lit = resolveVerifyCommandTarget('cd "a&b" && npm test', { projectRoot: root });
    assert.equal(esc.status, 'ok');
    assert.equal(esc.status, lit.status);
    assert.equal(esc.target, lit.target);
  });

  test('probe of a plan with an escaped <automated> block is ok and reports the command verbatim', () => {
    const root = fixtureRoot('4730-probe');
    writePackageJson(path.join(root, 'src'), { test: 'node --version' });
    const phaseDir = path.join(root, '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '<task>\n<name>demo</name>\n<verify>\n<automated>cd src &amp;&amp; npm test</automated>\n</verify>\n</task>\n',
      'utf8',
    );
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.counts.blocker, 0);
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'cd src &amp;&amp; npm test');
    assert.equal(r.commands[0].status, 'ok');
    assert.equal(r.commands[0].target, path.join(root, 'src'));
  });
});

describe('#2401 review Finding 1 — script check runs for --prefix form regardless of flag order', () => {
  test('npm --prefix ./web run <missing-script> is script_missing/warning', () => {
    const root = fixtureRoot('finding1-prefix-first-missing');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run nope', { projectRoot: root });
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
  });

  test('npm run <missing-script> --prefix ./web is script_missing/warning', () => {
    const root = fixtureRoot('finding1-prefix-trailing-missing');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run nope --prefix ./web', { projectRoot: root });
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
  });

  test('npm --prefix ./web run <existing-script> is reason:null/severity:none', () => {
    const root = fixtureRoot('finding1-prefix-first-present');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run build', { projectRoot: root });
    assert.equal(r.reason, null);
    assert.equal(r.severity, 'none');
  });

  test('npm run <existing-script> --prefix ./web is reason:null/severity:none', () => {
    const root = fixtureRoot('finding1-prefix-trailing-present');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run build --prefix ./web', { projectRoot: root });
    assert.equal(r.reason, null);
    assert.equal(r.severity, 'none');
  });
});

describe('#2401 review Finding 2 — quoted --prefix paths containing spaces', () => {
  for (const [label, quote] of [['double-quoted', '"'], ['single-quoted', "'"]]) {
    test(`npm --prefix ${quote}my dir${quote} run test resolves the ${label} directory`, () => {
      const root = fixtureRoot(`finding2-present-${label}`);
      writePackageJson(path.join(root, 'my dir'), { test: 'node --version' });
      const r = resolveVerifyCommandTarget(`npm --prefix ${quote}my dir${quote} run test`, { projectRoot: root });
      assert.equal(r.status, 'ok');
      assert.equal(r.severity, 'none');
      assert.equal(r.target, path.join(root, 'my dir'));
    });

    test(`npm --prefix ${quote}my dir${quote} run test is broken/missing_dir when the ${label} dir does not exist`, () => {
      const root = fixtureRoot(`finding2-absent-${label}`);
      const r = resolveVerifyCommandTarget(`npm --prefix ${quote}my dir${quote} run test`, { projectRoot: root });
      assert.equal(r.status, 'broken');
      assert.equal(r.reason, 'missing_dir');
    });
  }
});

describe('#2401 review Finding 3 — an absolute segment in a chained cd resets, not concatenates', () => {
  test('cd sub && cd <abs-existing-dir> && npm test resolves to the absolute dir', () => {
    const root = fixtureRoot('finding3-abs-reset');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    // The absolute target sits INSIDE the fixture root: this test's subject is
    // reset-not-concatenate, and an outside-root absolute target is now its own
    // finding (#4767, below) rather than a clean verdict.
    const abs = path.join(root, 'finding3-abs-target');
    writePackageJson(abs, { test: 'node --version' });
    const r = resolveVerifyCommandTarget(`cd sub && cd ${abs} && npm test`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
    assert.equal(r.target, abs);
    assert.equal(r.rawTarget, abs);
  });

  test('cd a && cd b && npm test (both relative) still resolves to <root>/a/b', () => {
    const root = fixtureRoot('finding3-relative-chain');
    writePackageJson(path.join(root, 'a', 'b'), { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd a && cd b && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'a', 'b'));
  });
});

describe('#4767 — an absolute target outside projectRoot is outside_root, like the bare climb', () => {
  // The motivating shape: a planner copied the orchestrator's absolute root
  // into <automated>; under worktree isolation projectRoot is the worktree and
  // the target is the MAIN checkout — which exists, so the pre-#4767 branch
  // returned ok/none and the command passed against the wrong tree.
  test('cd <abs-outside-root> (existing dir) is ok/warning/outside_root — existence is not evidence', () => {
    const root = fixtureRoot('abs-outside-single');
    const mainCheckout = path.join(ROOT, 'abs-outside-single-main', 'scripts', 'verify');
    fs.mkdirSync(mainCheckout, { recursive: true });
    const r = resolveVerifyCommandTarget(`cd ${mainCheckout} && python3 -m pytest -q`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
    assert.equal(r.target, mainCheckout);
  });

  test('cd sub && cd <abs-outside-root> (absolute reset) is outside_root too', () => {
    const root = fixtureRoot('abs-outside-chained');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const abs = path.join(ROOT, 'abs-outside-chained-target');
    writePackageJson(abs, { test: 'node --version' });
    const r = resolveVerifyCommandTarget(`cd sub && cd ${abs} && npm test`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
    assert.equal(r.target, abs, 'reset-not-concatenate semantics are preserved');
  });

  test('npm --prefix <abs-outside-root> is outside_root (both grounded forms share the check)', () => {
    const root = fixtureRoot('abs-outside-prefix');
    const abs = path.join(ROOT, 'abs-outside-prefix-target');
    writePackageJson(abs, { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget(`npm --prefix ${abs} run lint`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
  });

  test('a missing absolute target outside the root is still outside_root, not missing_dir — the filesystem is not consulted', () => {
    const root = fixtureRoot('abs-outside-missing');
    const abs = path.join(ROOT, 'abs-outside-missing-target', 'never-created');
    const r = resolveVerifyCommandTarget(`cd ${abs} && npm test`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
  });

  test('cd <abs-inside-root> stays clean', () => {
    const root = fixtureRoot('abs-inside');
    const abs = path.join(root, 'scripts', 'verify');
    fs.mkdirSync(abs, { recursive: true });
    const r = resolveVerifyCommandTarget(`cd ${abs} && python3 -m pytest -q`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
    assert.equal(r.reason, null);
    assert.equal(r.target, abs);
  });

  test('cd <projectRoot> itself is contained (target === root)', () => {
    const root = fixtureRoot('abs-is-root');
    const r = resolveVerifyCommandTarget(`cd ${root} && ls`, { projectRoot: root });
    assert.equal(r.severity, 'none');
    assert.equal(r.reason, null);
  });

  test('a sibling whose name merely extends the root is outside (boundary, not prefix)', () => {
    const root = fixtureRoot('abs-boundary');
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling, { recursive: true });
    const r = resolveVerifyCommandTarget(`cd ${sibling} && ls`, { projectRoot: root });
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
  });

  test('the relative bare climb is unchanged by the absolute branch', () => {
    const root = fixtureRoot('abs-climb-unchanged');
    const r = resolveVerifyCommandTarget('cd .. && ls', { projectRoot: root });
    assert.equal(r.severity, 'warning');
    assert.equal(r.reason, 'outside_root');
  });
});

describe('resolveVerifyCommandTarget — refusals and negative space', () => {
  const hostile = [
    ['row 10 — refuses a variable path', 'cd "$FRONTEND" && npm test'],
    ['row 11 — refuses a glob path', 'cd frontend-* && npm test'],
    ['row 12 — refuses command substitution', 'cd $(git rev-parse --show-toplevel)/web && npm test'],
    ['row 13 — refuses backtick substitution', 'cd `pwd`/web && npm test'],
    ['row 14 — refuses tilde expansion', 'cd ~/web && npm test'],
  ];

  for (const [name, command] of hostile) {
    test(name, () => {
      const root = fixtureRoot('hostile');
      const r = resolveVerifyCommandTarget(command, { projectRoot: root });
      assert.equal(r.status, 'unresolvable', command);
      assert.equal(r.reason, 'dynamic_path');
      assert.equal(r.severity, 'warning', 'an ungroundable path must never block');
    });
  }

  test('row 15 — Nyquist MISSING sentinel is not applicable', () => {
    const root = fixtureRoot('row15');
    const r = resolveVerifyCommandTarget('MISSING — Wave 0 must create tests/x.py first', {
      projectRoot: root,
    });
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.sentinel, true);
    assert.equal(r.severity, 'none');
  });

  test('row 16 — pseudo-shell assertion is not applicable', () => {
    const root = fixtureRoot('row16');
    const r = resolveVerifyCommandTarget("grep -c '?from=' src/x.tsx == 0", { projectRoot: root });
    assert.equal(r.status, 'not_applicable');
  });

  test('row 17 — dir created by an earlier task is pending, not broken', () => {
    const root = fixtureRoot('row17');
    const r = resolveVerifyCommandTarget('cd frontend && npm test', {
      projectRoot: root,
      declaredPaths: ['frontend/package.json'],
    });
    assert.equal(r.status, 'pending_creation');
    assert.notEqual(r.severity, 'blocker');
  });

  test('row 21 — target above project root warns', () => {
    const root = fixtureRoot('row21');
    const r = resolveVerifyCommandTarget('cd ../.. && npm test', { projectRoot: root });
    assert.equal(r.reason, 'outside_root');
    assert.equal(r.severity, 'warning');
    assert.equal(r.base, root, 'the resolved base must be reported');
  });

  test('row 19 — missing npm script warns, never blocks', () => {
    const root = fixtureRoot('row19');
    writePackageJson(path.join(root, 'frontend'), { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget('cd frontend && npm run nope', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
    assert.equal(r.script, 'nope');
  });

  test('row 33 — invalid manifest json degrades to warning', () => {
    const root = fixtureRoot('row33');
    const dir = path.join(root, 'frontend');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf8');
    const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.reason, 'manifest_unreadable');
    assert.equal(r.severity, 'warning');
  });

  test('row 34 — non-object manifest json does not crash', () => {
    for (const [i, body] of ['0', '"s"', '[]', 'null', 'true'].entries()) {
      const root = fixtureRoot(`row34-${i}`);
      const dir = path.join(root, 'frontend');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), body, 'utf8');
      const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
      assert.ok(KNOWN_STATUSES.has(r.status), `body ${body} → ${r.status}`);
      assert.notEqual(r.severity, 'blocker', `body ${body} must not block`);
    }
  });

  test('row 28 — bare call shape does not throw', () => {
    const r = resolveVerifyCommandTarget('cd frontend && npm test');
    assert.ok(KNOWN_STATUSES.has(r.status));
    assert.equal(typeof r.base, 'string');
  });

  test('row 46 — probe never executes the command', () => {
    const root = fixtureRoot('row46');
    const canary = path.join(root, 'pwned');
    resolveVerifyCommandTarget(`cd . && touch ${canary}`, { projectRoot: root });
    resolveVerifyCommandTarget(`npm --prefix . run x; touch ${canary}`, { projectRoot: root });
    assert.equal(fs.existsSync(canary), false, 'the probe must never execute command text');
  });
});

describe('#2401 CI regression — mid-string ~ (Windows 8.3 short names) is a literal, not home-expansion', () => {
  // Fixture dir literally named `RUNNER~1`, mirroring the 8.3 short-name shape
  // GitHub's Windows runners put in os.tmpdir() (e.g. `C:\Users\RUNNER~1\...`).
  // A `~` anywhere but the START of a path is an ordinary literal character;
  // only a LEADING `~` is shell home-expansion.
  function shortNameFixture(name) {
    const root = fixtureRoot(name);
    const app = path.join(root, 'RUNNER~1', 'app');
    writePackageJson(app, { lint: 'eslint .', test: 'node --version' });
    return { root, app };
  }

  test('mid-string ~ in an absolute --prefix path resolves', () => {
    const { app } = shortNameFixture('tilde-abs-prefix');
    const r = resolveVerifyCommandTarget(`npm --prefix ${app} run lint`, { projectRoot: app });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
    assert.equal(r.target, app);
  });

  test('mid-string ~ in a relative cd target resolves', () => {
    const { root } = shortNameFixture('tilde-relative-cd');
    const r = resolveVerifyCommandTarget('cd RUNNER~1/app && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
    assert.equal(r.target, path.join(root, 'RUNNER~1', 'app'));
  });

  test('leading ~ is still refused (row 14 must not be weakened)', () => {
    const root = fixtureRoot('tilde-leading-still-refused');
    const r = resolveVerifyCommandTarget('cd ~/web && npm test', { projectRoot: root });
    assert.equal(r.status, 'unresolvable');
    assert.equal(r.reason, 'dynamic_path');
    assert.equal(r.severity, 'warning');
  });

  test('quoted leading ~ is still refused', () => {
    const root = fixtureRoot('tilde-leading-quoted-refused');
    const r = resolveVerifyCommandTarget('cd "~/web" && npm test', { projectRoot: root });
    assert.equal(r.status, 'unresolvable');
    assert.equal(r.reason, 'dynamic_path');
    assert.equal(r.severity, 'warning');
  });
});

describe('probePhaseVerifyCommands', () => {
  test('row 23 — plan with no automated blocks is ok', () => {
    const root = fixtureRoot('row23');
    const phaseDir = writePhase(root, 'phase-1', { '01-PLAN.md': '# Plan\n\nno tasks here\n' });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.deepEqual(r.commands, []);
    assert.equal(r.status, 'ok');
  });

  test('row 26 — overall status is the worst present', () => {
    const root = fixtureRoot('row26');
    writePackageJson(path.join(root, 'good'), { test: 'node --version' });
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd good && npm test']),
      '02-PLAN.md': planWith(['cd nowhere && npm test']),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands.length, 2);
    assert.equal(r.status, 'broken');
    assert.equal(r.counts.blocker, 1);
  });

  test('row 18 — artifact-section path is pending, not broken', () => {
    const root = fixtureRoot('row18');
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd frontend && npm test'], { artifacts: ['frontend/package.json'] }),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands[0].status, 'pending_creation');
    assert.equal(r.counts.blocker, 0);
  });

  test('row 17b — a path declared in an earlier task <files> is pending', () => {
    const root = fixtureRoot('row17b');
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd frontend && npm test'], { taskFiles: ['frontend/package.json'] }),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands[0].status, 'pending_creation');
  });

  test('row 25b — CRLF plan yields identical verdicts', () => {
    const root = fixtureRoot('row25b');
    writePackageJson(path.join(root, 'web'), { test: 'node --version' });
    const lfDir = writePhase(root, 'phase-lf', {
      '01-PLAN.md': planWith(['cd web && npm test', 'cd nowhere && npm test']),
    });
    const crlfDir = writePhase(root, 'phase-crlf', {
      '01-PLAN.md': planWith(['cd web && npm test', 'cd nowhere && npm test'], { eol: '\r\n' }),
    });
    const lf = probePhaseVerifyCommands({ phaseDir: lfDir, projectRoot: root });
    const crlf = probePhaseVerifyCommands({ phaseDir: crlfDir, projectRoot: root });
    assert.deepEqual(
      crlf.commands.map((c) => [c.command, c.status, c.reason]),
      lf.commands.map((c) => [c.command, c.status, c.reason]),
    );
  });

  test('row 24 — unreadable phase degrades, never throws', () => {
    const root = fixtureRoot('row24');
    const phaseDir = writePhase(root, 'phase-1', { '01-PLAN.md': planWith(['npm test']) });
    const realReadFile = fs.readFileSync;
    try {
      fs.readFileSync = (p, ...rest) => {
        if (String(p).endsWith('01-PLAN.md')) {
          const err = new Error('EIO: simulated read failure');
          err.code = 'EIO';
          throw err;
        }
        return realReadFile.call(fs, p, ...rest);
      };
      const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
      assert.ok(r.readError, 'a read failure must surface as readError');
      assert.deepEqual(r.commands, []);
    } finally {
      fs.readFileSync = realReadFile;
    }
  });

  test('row 24b — absent phase dir degrades, never throws', () => {
    const root = fixtureRoot('row24b');
    const r = probePhaseVerifyCommands({
      phaseDir: path.join(root, 'no-such-phase'),
      projectRoot: root,
    });
    assert.ok(r.readError);
    assert.deepEqual(r.commands, []);
  });
});

describe('harvestPriorVerifyCommands', () => {
  function planningWithPhases(name, phases) {
    const root = fixtureRoot(name);
    for (const [phaseName, plans] of Object.entries(phases)) writePhase(root, phaseName, plans);
    return { root, planningDir: path.join(root, '.planning') };
  }

  test('row 36 — harvests prior phase commands', () => {
    const { planningDir } = planningWithPhases('row36', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      '02-beta': { '01-PLAN.md': planWith(['cd nowhere && npm test']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
    assert.equal(r.commands[0].phase, '01');
    assert.ok(r.commands[0].plan.endsWith('01-PLAN.md'));
  });

  test('row 37 — no prior phase harvests empty', () => {
    const { planningDir } = planningWithPhases('row37', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
    });
    assert.deepEqual(harvestPriorVerifyCommands({ planningDir, beforePhase: 1 }).commands, []);
  });

  test('row 38 — walks back to the nearest phase with commands', () => {
    const { planningDir } = planningWithPhases('row38', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run build']) },
      '02-beta': { '01-PLAN.md': '# Plan\n\nno automated blocks\n' },
      '03-gamma': { '01-PLAN.md': planWith(['cd x && npm test']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 3 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].phase, '01');
  });

  test('row 39 — walkback stops at three phases', () => {
    const { planningDir } = planningWithPhases('row39', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run build']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
      '03-gamma': { '01-PLAN.md': '# Plan\n' },
      '04-delta': { '01-PLAN.md': '# Plan\n' },
      '05-epsilon': { '01-PLAN.md': planWith(['cd x && npm test']) },
    });
    assert.deepEqual(harvestPriorVerifyCommands({ planningDir, beforePhase: 5 }).commands, []);
  });

  test('row 40 — harvest caps at twenty commands (19 / 20 / 21)', () => {
    for (const [n, expected] of [
      [19, 19],
      [20, 20],
      [21, 20],
    ]) {
      const cmds = Array.from({ length: n }, (_, i) => `npm --prefix ./p${i} run build`);
      const { planningDir } = planningWithPhases(`row40-${n}`, {
        '01-alpha': { '01-PLAN.md': planWith(cmds) },
        '02-beta': { '01-PLAN.md': '# Plan\n' },
      });
      const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
      assert.equal(r.commands.length, expected, `${n} distinct commands → ${expected}`);
    }
  });

  test('row 40b — duplicate commands are deduped before the cap', () => {
    const { planningDir } = planningWithPhases('row40b', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test', 'npm test', 'npm run lint']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.deepEqual(
      r.commands.map((c) => c.command),
      ['npm test', 'npm run lint'],
    );
  });

  test('row 41 — harvest degrades on unreadable planning dir', () => {
    const { planningDir } = planningWithPhases('row41', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
    });
    const realReaddir = fs.readdirSync;
    try {
      fs.readdirSync = () => {
        const err = new Error('EACCES: simulated');
        err.code = 'EACCES';
        throw err;
      };
      const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
      assert.deepEqual(r.commands, []);
      assert.ok(r.readError);
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  test('harvest never throws on a missing planning dir', () => {
    const root = fixtureRoot('harvest-missing');
    const r = harvestPriorVerifyCommands({
      planningDir: path.join(root, 'nope'),
      beforePhase: 3,
    });
    assert.deepEqual(r.commands, []);
  });

  // #2401 review fix: production phase directories are NOT named `phase-N-slug`
  // — they are `01-foundation`, `3-thing`, `2.1-thing`, `12A-thing`, and
  // optionally project-code-prefixed (`CK-01-name`). The bespoke
  // `/^phase-(\d+(?:\.\d+)?)/` regex this module previously used matched none
  // of these, so `harvestPriorVerifyCommands` always returned `[]` in
  // production. These rows pin every real directory-naming form via the
  // canonical `phase-id.cjs` grammar.

  test('#2401 — zero-padded phase dir (01-foundation)', () => {
    const { planningDir } = planningWithPhases('naming-zero-padded', {
      '01-foundation': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      '02-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
    assert.equal(r.commands[0].phase, '01');
  });

  test('#2401 — unpadded phase dir (3-thing)', () => {
    const { planningDir } = planningWithPhases('naming-unpadded', {
      '3-thing': { '01-PLAN.md': planWith(['npm test']) },
      '4-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 4 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
    assert.equal(r.commands[0].phase, '3');
  });

  test('#2401 — decimal sub-phase (2.1-thing) orders between 2-thing and 3-thing', () => {
    const { planningDir } = planningWithPhases('naming-decimal', {
      '2-thing': { '01-PLAN.md': planWith(['npm run build:base']) },
      '2.1-thing': { '01-PLAN.md': planWith(['npm run build:subphase']) },
      '3-thing': { '01-PLAN.md': '# Plan\n' },
    });
    // beforePhase 3 walks back descending: 3-thing (empty) → 2.1-thing (has
    // commands, stop) — 2.1 must sort BETWEEN 2 and 3, not after 3 or before 2.
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 3 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm run build:subphase');
    assert.equal(r.commands[0].phase, '2.1');
  });

  test('#2401 — variant-suffixed phase dir (12A-thing)', () => {
    const { planningDir } = planningWithPhases('naming-variant-suffix', {
      '12A-thing': { '01-PLAN.md': planWith(['npm test']) },
      '13-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 13 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
    assert.equal(r.commands[0].phase, '12A');
  });

  test('#2401 — project-code-prefixed phase dir (CK-01-name)', () => {
    const { planningDir } = planningWithPhases('naming-project-code', {
      'CK-01-name': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      'CK-02-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
  });

  test('#2401 — non-phase directories (notes, archive) are ignored, not thrown on', () => {
    const { planningDir } = planningWithPhases('naming-non-phase-dirs', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
      notes: { 'README.md': '# not a plan\n' },
      archive: { 'old-PLAN.md': planWith(['npm run stale']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
  });
});

describe('check verify-command-paths verb', () => {
  /** Fixture matching the real `.planning/phases/<dir>/` layout findPhaseInternal resolves against. */
  function writeCliPhase(root, dirName, planBody) {
    const phaseDir = path.join(root, '.planning', 'phases', dirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), planBody, 'utf8');
    return phaseDir;
  }

  test('row 44 — check verb emits documented json', () => {
    const root = fixtureRoot('row44');
    writeCliPhase(root, '01-test-phase', planWith(['npm test']));

    const result = runGsdTools(['check', 'verify-command-paths', '1', '--raw'], root);
    assert.ok(result.success, `check verify-command-paths should succeed. stderr: ${result.error}`);

    const payload = JSON.parse(result.output);
    assert.equal(typeof payload.status, 'string');
    assert.ok(Array.isArray(payload.commands));
    assert.equal(typeof payload.counts, 'object');
    assert.equal(typeof payload.counts.blocker, 'number');
    assert.equal(typeof payload.counts.warning, 'number');
    assert.equal(typeof payload.counts.total, 'number');
    assert.ok('readError' in payload);
  });

  test('#4767 — --dir probes a plan directory outside .planning/phases (quick mode)', () => {
    const root = fixtureRoot('dir-flag-quick');
    const quickDir = path.join(root, '.planning', 'quick', '260915-abc-some-task');
    fs.mkdirSync(quickDir, { recursive: true });
    const mainCheckout = path.join(ROOT, 'dir-flag-quick-main');
    fs.mkdirSync(mainCheckout, { recursive: true });
    fs.writeFileSync(
      path.join(quickDir, '260915-abc-PLAN.md'),
      planWith([`cd ${mainCheckout} && npm test`, 'npm test']),
      'utf8',
    );

    const result = runGsdTools(['check', 'verify-command-paths', '--dir', quickDir, '--raw'], root);
    assert.ok(result.success, `--dir form should succeed. stderr: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.readError, null);
    assert.equal(payload.commands.length, 2);
    const [absRow, plainRow] = payload.commands;
    assert.equal(absRow.reason, 'outside_root');
    assert.equal(absRow.severity, 'warning');
    assert.equal(plainRow.severity, 'none');
    assert.equal(payload.counts.warning, 1);
  });

  test('#4767 — the phase positional is found regardless of where --raw sits', () => {
    const root = fixtureRoot('phase-after-raw');
    writeCliPhase(root, '01-raw-first', planWith(['npm test']));
    const result = runGsdTools(['check', 'verify-command-paths', '--raw', '1'], root);
    assert.ok(result.success, `--raw before the phase should still resolve it. stderr: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.readError, null);
    assert.equal(payload.commands.length, 1);
  });

  test('#4767 — --dir accepts a project-relative directory', () => {
    const root = fixtureRoot('dir-flag-relative');
    const quickDir = path.join(root, '.planning', 'quick', '260915-def-task');
    fs.mkdirSync(quickDir, { recursive: true });
    fs.writeFileSync(path.join(quickDir, '260915-def-PLAN.md'), planWith(['npm test']), 'utf8');

    const result = runGsdTools(
      ['check', 'verify-command-paths', '--dir', '.planning/quick/260915-def-task', '--raw'],
      root,
    );
    assert.ok(result.success, `relative --dir should succeed. stderr: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.commands.length, 1);
  });

  test('#4767 — --dir on a missing directory degrades to readError, never throws', () => {
    const root = fixtureRoot('dir-flag-missing');
    const result = runGsdTools(['check', 'verify-command-paths', '--dir', path.join(root, 'nope'), '--raw'], root);
    const payload = JSON.parse(result.output);
    assert.deepEqual(payload.commands, []);
    assert.equal(typeof payload.readError, 'string');
    assert.ok(payload.readError.length > 0);
  });

  // ── #4785 review: `--dir` containment ────────────────────────────────────────────────────
  // The probe READS the directory it is handed (`readdirSync`, then `readFileSync` over every
  // `*-PLAN.md`), so an uncontained `--dir` is an arbitrary-directory read — the same escape
  // class this PR exists to close, on the entry point this PR itself added. Boundary cases
  // mirror the absolute-target set the probe fix already covers: exactly-at-root, one level
  // outside, several levels outside, and the symlink case a LEXICAL check cannot see.
  //
  // Every refusal assertion checks BOTH the degraded payload AND that the out-of-root plan's
  // sentinel never appears in the output. A containment test that reads only `status` passes
  // just as well against a probe that read the file and then discarded it.

  /** A plan dir OUTSIDE any fixture root, whose `<automated>` carries a sentinel token. */
  function outOfRootPlanDir(name, token) {
    const dir = path.join(ROOT, `escape-target-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-PLAN.md'), planWith([`cd /${token} && npm test`]), 'utf8');
    return dir;
  }

  // SENTINEL FIRST, THEN THE SHAPE. Ordering is the whole strength of this helper: with the status
  // assertion first, a pre-fix run fails there and the sentinel assertion is NEVER EXERCISED, so the
  // negative control says nothing about whether the sentinel check can fail at all. Driven by the
  // pre-push review of this round. Pre-fix the out-of-root plan IS read, so its command text carries
  // the token into the payload and this line is what fires.
  function assertRefusedAndUnread(result, token) {
    assert.ok(!result.output.includes(token), 'out-of-root plan content reached the payload');
    const payload = JSON.parse(result.output);
    assert.equal(payload.status, 'unresolvable', 'an out-of-root --dir must be unresolvable');
    assert.deepEqual(payload.commands, [], 'no command may be reported from outside the root');
    assert.equal(payload.counts.total, 0);
    assert.match(String(payload.readError), /outside the project root/);
  }

  test('#4785 — --dir with an ABSOLUTE target outside the project root is refused unread', () => {
    const root = fixtureRoot('dir-flag-escape-abs');
    const token = 'SENTINEL-ABS-4785';
    const outside = outOfRootPlanDir('abs', token);
    const result = runGsdTools(['check', 'verify-command-paths', '--dir', outside, '--raw'], root);
    assertRefusedAndUnread(result, token);
  });

  test('#4785 — --dir climbing ONE level out of the project root is refused unread', () => {
    const root = fixtureRoot('dir-flag-escape-rel1');
    const token = 'SENTINEL-REL1-4785';
    const outside = outOfRootPlanDir('rel1', token);
    const rel = path.join('..', path.basename(outside));
    const result = runGsdTools(['check', 'verify-command-paths', '--dir', rel, '--raw'], root);
    assertRefusedAndUnread(result, token);
  });

  test('#4785 — --dir climbing SEVERAL levels out of the project root is refused unread', () => {
    const root = fixtureRoot('dir-flag-escape-deep');
    const token = 'SENTINEL-DEEP-4785';
    const outside = outOfRootPlanDir('deep', token);
    const rel = path.join('..', '..', path.basename(ROOT), path.basename(outside));
    const result = runGsdTools(['check', 'verify-command-paths', '--dir', rel, '--raw'], root);
    assertRefusedAndUnread(result, token);
  });

  test('#4785 — --dir EXACTLY AT the project root is contained, not refused', () => {
    // `target === root` is contained by the canonical predicate, so the boundary is inclusive:
    // the fix must refuse the escape without also refusing the edge that touches it.
    const root = fixtureRoot('dir-flag-at-root');
    fs.writeFileSync(path.join(root, '01-PLAN.md'), planWith(['npm test']), 'utf8');
    const result = runGsdTools(['check', 'verify-command-paths', '--dir', '.', '--raw'], root);
    assert.ok(result.success, `--dir . should succeed. stderr: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.equal(payload.readError, null);
    assert.equal(payload.commands.length, 1);
  });

  test('#4785 — a SYMLINK inside the root pointing outside it is refused unread', (t) => {
    // The discriminator between the realpath predicate and the lexical one: this path is
    // lexically inside the root, so `tryWithinRootLexical` returns contained and the probe
    // then reads through the link. Only a resolved-target check refuses it.
    const root = fixtureRoot('dir-flag-escape-symlink');
    const token = 'SENTINEL-LINK-4785';
    const outside = outOfRootPlanDir('symlink', token);
    const link = path.join(root, '.planning', 'quick', 'looks-inside');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'ENOSYS') {
        t.skip('creating a directory symlink requires privilege on this host');
        return;
      }
      throw err;
    }
    const result = runGsdTools(
      ['check', 'verify-command-paths', '--dir', path.join('.planning', 'quick', 'looks-inside'), '--raw'],
      root,
    );
    assertRefusedAndUnread(result, token);
  });

  test('row 45 — check verb degrades on unknown phase', () => {
    const root = fixtureRoot('row45');
    fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });

    // Capture the result rather than asserting on exit code: an unknown phase
    // is a degraded-but-valid JSON payload, not necessarily a clean exit.
    const result = runGsdTools(['check', 'verify-command-paths', '999', '--raw'], root);
    const payload = JSON.parse(result.output);
    assert.deepEqual(payload.commands, []);
    assert.equal(typeof payload.readError, 'string');
    assert.ok(payload.readError.length > 0);
  });
});

describe('#4767 — quick mode runs the path probe as plan-phase does', () => {
  const REPO_ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

  test('quick/steps/plan-checker-loop.md runs check verify-command-paths --dir over ${QUICK_DIR} before spawning the checker', () => {
    const src = read('gsd-core/workflows/quick/steps/plan-checker-loop.md');
    const probeIdx = src.indexOf('gsd_run check verify-command-paths --dir "${QUICK_DIR}" --raw');
    const spawnIdx = src.indexOf('subagent_type="gsd-plan-checker"');
    assert.ok(probeIdx !== -1, 'quick plan-checker-loop does not run the verify-command-paths probe');
    assert.ok(spawnIdx !== -1, 'checker spawn not found');
    assert.ok(probeIdx < spawnIdx, 'the probe must run before the checker is spawned');
    assert.ok(src.includes('<verify_command_path_probe>') && src.includes('{VERIFY_PATHS}'),
      'the checker prompt must carry the probe JSON in a <verify_command_path_probe> block, as plan-phase.md does');
  });

  test('plan-phase.md and quick share the same probe block shape', () => {
    const planPhase = read('gsd-core/workflows/plan-phase.md');
    const quick = read('gsd-core/workflows/quick/steps/plan-checker-loop.md');
    const block = (s) => {
      const a = s.indexOf('<verify_command_path_probe>');
      const b = s.indexOf('</verify_command_path_probe>');
      return s.slice(a, b);
    };
    assert.equal(block(quick), block(planPhase), 'quick and plan-phase must hand the checker an identical probe block');
  });

  test('the root-relative path-form rule binds in both authoring surfaces', () => {
    // gsd-planner.md sits within a few hundred chars of its 49152 cap, so the rule's TEXT lives in
    // the reference the planner @-loads and the planner side asserts the pointer. Both halves are
    // required: a reference nothing loads is an orphaned rule, and a pointer to a reference that
    // does not state the rule is an empty one.
    // The pointer must be the `@~/.claude/...` form, not a repo-relative `@gsd-core/...` one. That
    // is the form the installer rewrites per install profile (runtime-artifact-conversion's agent
    // path rewrites key on `~/.claude/`), and the only form this repo's own reference-follower
    // recognises (check-contract-drift.cjs `referenceIncludes`). A repo-relative pointer resolves
    // against the consuming project's cwd once installed, where `gsd-core/references/` does not
    // exist -- so it would leave the rule unreachable while still reading like a citation.
    const planner = read('agents/gsd-planner.md');
    const reference = read('gsd-core/references/planner-verify-command-grounding.md');
    const quick = read('gsd-core/workflows/quick.md');
    assert.ok(
      /@~\/\.claude\/gsd-core\/references\/planner-verify-command-grounding\.md/.test(planner),
      'gsd-planner.md must @-reference planner-verify-command-grounding.md by its installed (~/.claude) path to load the #4767 path-form rule'
    );
    assert.ok(
      /Root-relative, never absolute \(#4767\)/.test(reference),
      'planner-verify-command-grounding.md lacks the #4767 path-form rule'
    );
    assert.ok(/PATH FORM \(#4767\)/.test(quick), "quick.md's planner <constraints> lack the #4767 path-form rule");
    assert.ok(/repo-root-relative/.test(reference) && /repo-root-relative/.test(quick));
  });
});

describe('property-based invariants', () => {
  const KNOWN_STATUSES_PROP = new Set([
    'ok',
    'broken',
    'unresolvable',
    'not_applicable',
    'pending_creation',
  ]);
  const KNOWN_SEVERITIES = new Set(['blocker', 'warning', 'none']);

  // Safe alphabet for synthesized <automated> command bodies: excludes '<', '>'
  // and '&' so the generated body cannot forge XML markup inside the rendered
  // plan text, and is non-empty after trimming.
  const commandArb = fc
    .stringMatching(/^[A-Za-z0-9_./ :=-]+$/)
    .filter(s => s.trim().length > 0);

  describe('#2401 resolveVerifyCommandTarget — grounding properties', () => {
    test('(a) never throws; always returns a known status/severity/base shape', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        });
        assert.ok(result && typeof result === 'object', 'must return an object');
        assert.ok(KNOWN_STATUSES_PROP.has(result.status), `unknown status ${result.status}`);
        assert.ok(KNOWN_SEVERITIES.has(result.severity), `unknown severity ${result.severity}`);
        assert.strictEqual(typeof result.base, 'string');
      }));
    });

    test('(a) never throws for full-unicode input; always returns a known status/severity/base shape', () => {
      fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        });
        assert.ok(result && typeof result === 'object', 'must return an object');
        assert.ok(KNOWN_STATUSES_PROP.has(result.status), `unknown status ${result.status}`);
        assert.ok(KNOWN_SEVERITIES.has(result.severity), `unknown severity ${result.severity}`);
        assert.strictEqual(typeof result.base, 'string');
      }));
    });

    test('(b) a blocker severity is only ever reported for a grounded form', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        const result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        if (result.severity === 'blocker') {
          assert.ok(result.form !== null && result.form !== undefined,
            `blocker for ${JSON.stringify(s)} must have a non-null form`);
          assert.strictEqual(typeof result.target, 'string',
            `blocker for ${JSON.stringify(s)} must have a string target`);
          assert.ok(result.target.length > 0,
            `blocker for ${JSON.stringify(s)} must have a non-empty target`);
        }
      }));
    });

    test('(b) a blocker severity is only ever reported for a grounded form (full-unicode)', () => {
      fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => {
        const result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        if (result.severity === 'blocker') {
          assert.ok(result.form !== null && result.form !== undefined,
            `blocker for ${JSON.stringify(s)} must have a non-null form`);
          assert.strictEqual(typeof result.target, 'string',
            `blocker for ${JSON.stringify(s)} must have a string target`);
          assert.ok(result.target.length > 0,
            `blocker for ${JSON.stringify(s)} must have a non-empty target`);
        }
      }));
    });
  });

  describe('#2401 extractAutomatedCommands — recovery properties', () => {
    test('(c) recovers every generated command, in order, from synthesized plan text', () => {
      fc.assert(fc.property(fc.array(commandArb, { minLength: 0, maxLength: 8 }), (commands) => {
        const planText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\n');

        const extracted = extractAutomatedCommands(planText);
        assert.deepStrictEqual(
          extracted.map(c => c.command),
          commands.map(c => c.trim()),
        );
        extracted.forEach((row, i) => {
          assert.strictEqual(row.task, `t${i}`);
        });
      }));
    });

    test('(d) CRLF invariance: \\r\\n-joined plan text yields an identical command list', () => {
      fc.assert(fc.property(fc.array(commandArb, { minLength: 0, maxLength: 8 }), (commands) => {
        const lfPlanText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\n');
        const crlfPlanText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\r\n');

        const lfExtracted = extractAutomatedCommands(lfPlanText);
        const crlfExtracted = extractAutomatedCommands(crlfPlanText);
        assert.deepStrictEqual(crlfExtracted, lfExtracted);
      }));
    });

    test('(e) never throws on arbitrary string input', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = extractAutomatedCommands(s);
        });
        assert.ok(Array.isArray(result), 'must return an array');
      }));
    });

    test('(e) never throws on non-string input and returns [] for each', () => {
      const nonStrings = [0, [], null, undefined, true, {}];
      for (const v of nonStrings) {
        let result;
        assert.doesNotThrow(() => {
          result = extractAutomatedCommands(v);
        }, `must not throw for ${JSON.stringify(v)}`);
        assert.deepStrictEqual(result, [], `must return [] for ${JSON.stringify(v)}`);
      }
    });
  });
});
