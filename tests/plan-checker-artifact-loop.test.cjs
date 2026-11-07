'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, toPosixPath } = require('./helpers.cjs');
const { have, skipUnless } = require('./helpers/bash-probe.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { collectSection, scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-plan-checker.md');

function artifactBlock() {
  const agent = fs.readFileSync(AGENT_PATH, 'utf8');
  const step = collectSection(agent, (heading) => heading.text === 'Step 1: Load Context');
  assert.ok(step, 'plan-checker Step 1 must exist');
  const lines = step.body.replace(/\r\n/g, '\n').split('\n');
  const blocks = scanFencedBlocks(lines)
    .filter((block) => block.infoString === 'bash' && block.closeLineIdx !== -1)
    .map((block) => lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'))
    .filter((block) => /\bfor artifact in\b/.test(block));
  assert.equal(blocks.length, 1, 'Step 1 must contain one artifact-loop bash block');
  return blocks[0];
}

function runArtifactBlock(t, shell, files, variable = 'phase_dir') {
  const dir = createTempProject('plan-checker-artifacts-5178-');
  t.after(() => cleanup(dir));
  const phaseDir = path.join(dir, '.planning', 'phases', '01-fixture phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(phaseDir, file), '');

  // Only query execution is stubbed; query contracts are covered by agent-query-contract.test.cjs.
  const binding = variable === 'unset'
    ? 'unset phase_dir PHASE_DIR\nset -u'
    : `${variable}="$1"`;
  const script = ['gsd_run() { :; }', 'phase_number=01', binding, artifactBlock()].join('\n');
  const result = runHook('-c', [script, 'artifact-loop', toPosixPath(phaseDir)], {
    interpreter: shell,
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ZDOTDIR: dir },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(result.outcome, OUTCOME.EXITED, JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stderr);
  return { phaseDir, paths: result.stdout.split(/\r?\n/).filter(Boolean).sort() };
}

/** Run one plan-checker step's first bash fence against a real gsd-tools, on a one-plan phase. */
function runStructureStep(t, shell, heading, content, prelude, epilogue = []) {
  const dir = createTempProject('plan-checker-structure-5178-');
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), content);
  const section = collectSection(fs.readFileSync(AGENT_PATH, 'utf8'), (h) => h.text === heading);
  assert.ok(section, `plan-checker ${heading} must exist`);
  const lines = section.body.split(/\r?\n/);
  const block = scanFencedBlocks(lines).find((fence) => fence.infoString === 'bash');
  assert.ok(block, `${heading} must contain a bash block`);
  const script = [
    'PHASE_DIR="$1"; PHASE=01; NODE="$2"; TOOLS="$3"',
    ...prelude,
    lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'),
    ...epilogue,
  ].join('\n');
  const result = runHook('-c', [script, 'structure-step', dir, process.execPath, path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs')], {
    interpreter: shell,
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ZDOTDIR: dir, SystemRoot: process.env.SystemRoot },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(result.outcome, OUTCOME.EXITED, JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

// bash's echo leaves JSON escapes alone, so the zsh cases above are the only runtime
// witness, and they skip where zsh is absent. This check runs everywhere.
test('no plan-checker copy prints the structure JSON with echo (#5178)', () => {
  for (const file of [AGENT_PATH, path.join(__dirname, '..', 'pi', 'package-agents', 'gsd-plan-checker.md')]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\becho\s+"?\$\{?PLAN_STRUCTURE\b/, file);
  }
});

describe('plan-checker discovers research and summary artifacts (#5178)', {
  skip: skipUnless('bash'),
}, () => {
  // Run bash and zsh deliberately because sh would not expand the braces.
  for (const shell of ['bash', 'zsh']) {
    const skip = shell === 'zsh' && !have('zsh') ? 'zsh is not installed' : false;

    test(`${shell}: finds exactly bare and prefixed research and summary paths (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, [
        'RESEARCH.md', '01-RESEARCH.md', 'SUMMARY.md', '01-01-SUMMARY.md',
        '01-CONTEXT.md', '01-01-PLAN.md',
      ]);
      assert.deepEqual(result.paths, [
        'RESEARCH.md', '01-RESEARCH.md', 'SUMMARY.md', '01-01-SUMMARY.md',
      ].map((file) => toPosixPath(path.join(result.phaseDir, file))).sort());
    });

    test(`${shell}: unmatched globs exit zero and print only bare research (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, ['RESEARCH.md']);
      assert.deepEqual(result.paths, [toPosixPath(path.join(result.phaseDir, 'RESEARCH.md'))]);
    });

    test(`${shell}: absent phase variables skip both Step 1 loops safely (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, [], 'unset');
      assert.deepEqual(result.paths, []);
    });

    test(`${shell}: PHASE_DIR fallback discovers artifacts (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, ['RESEARCH.md'], 'PHASE_DIR');
      assert.deepEqual(result.paths, [toPosixPath(path.join(result.phaseDir, 'RESEARCH.md'))]);
    });

    for (const [label, content, exitCode, taskName] of [
      ['valid', '---\nphase: 1\nplan: 1\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: {}\n---\n# Plan\n', 0],
      ['invalid', '# Plan without frontmatter\n', 1],
      ['escaped JSON', '---\nphase: 1\nplan: 1\ntype: execute\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: {}\n---\n<tasks><task type="auto"><name>Line one\nLine two</name><files>x.js</files><action>Act</action><verify>node --test</verify><done>Done</done></task></tasks>\n', 0, 'Line one\nLine two'],
    ]) {
      test(`${shell}: Step 8 prints the ${label} structure verdict and its exit status (#5178)`, { skip }, (t) => {
        const stdout = runStructureStep(t, shell, 'Step 8: Assess Scope', content, [
          'gsd_run() { if [ "$2" = frontmatter.get ]; then printf "\\nFRONTMATTER\\n"; fi; "$NODE" "$TOOLS" "$@"; }',
        ]);
        const lines = stdout.split('\nFRONTMATTER\n')[0].split(/\r?\n/);
        const statusIdx = lines.findIndex((line) => line.startsWith('structure_exit='));
        assert.equal(lines[statusIdx], `structure_exit=${exitCode}`, stdout);
        const structure = JSON.parse(lines.slice(0, statusIdx).join('\n'));
        assert.equal(structure.valid, exitCode === 0);
        if (taskName) assert.equal(structure.tasks[0].name, taskName);
      });

      test(`${shell}: Step 2 prints the ${label} structure verdict intact (#5178)`, { skip }, (t) => {
        const stdout = runStructureStep(t, shell, 'Step 2: Load All Plans', content, [
          'gsd_run() { "$NODE" "$TOOLS" "$@"; }',
        ]);
        const lines = stdout.split(/\r?\n/);
        assert.match(lines[0], /^=== .*01-01-PLAN\.md ===$/, stdout);
        const statusIdx = lines.findIndex((line) => line.startsWith('structure_exit='));
        assert.equal(lines[statusIdx], `structure_exit=${exitCode}`, stdout);
        const structure = JSON.parse(lines.slice(1, statusIdx).join('\n'));
        assert.equal(structure.valid, exitCode === 0);
        if (taskName) assert.equal(structure.tasks[0].name, taskName);
      });
    }
  }
});
