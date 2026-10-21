/**
 * #5542: plan-id matching in the ROADMAP plan-checkbox writers must end at a
 * real id boundary. `47-1` is a different plan from `47-10`, and `01-01` from
 * `01-01.1`; a superseded plan's summary must tick nothing.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function roadmap(rows) {
  return `# Roadmap

## v1.0

- [ ] **Phase 47: Foo**

### Phase 47: Foo
**Goal:** x
**Plans:** 0/2
Plans:
${rows.join('\n')}
`;
}

describe('plan-id row boundary (#5542)', () => {
  let tmpDir;
  let phaseDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '47-foo');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.0\n---\n');
  });
  afterEach(() => { cleanup(tmpDir); });

  const plan = (id, extraFrontmatter = '') => fs.writeFileSync(
    path.join(phaseDir, `${id}-PLAN.md`),
    `---\nphase: foo\nplan: ${id}\nwave: 1\n${extraFrontmatter}---\n# Plan\n`);
  const summary = (id) => fs.writeFileSync(
    path.join(phaseDir, `${id}-SUMMARY.md`), `---\nphase: foo\nplan: ${id}\n---\n# Summary\n`);
  const write = (rows) => fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap(rows));
  const read = () => fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf8');
  const update = () => {
    const r = runGsdTools('roadmap update-plan-progress 47', tmpDir);
    assert.ok(r.success, `update-plan-progress failed: ${r.error}`);
  };

  test('update-plan-progress ticks only the row of its own plan when one id prefixes another', () => {
    plan('47-1'); plan('47-10'); summary('47-1');
    write(['- [ ] 47-10-PLAN.md', '- [ ] 47-1-PLAN.md']);
    update();
    const out = read();
    assert.match(out, /- \[ \] 47-10-PLAN\.md/);
    assert.match(out, /- \[x\] 47-1-PLAN\.md/);
  });

  test('listing order does not change which row ticks', () => {
    plan('47-1'); plan('47-10'); summary('47-1');
    write(['- [ ] 47-1-PLAN.md', '- [ ] 47-10-PLAN.md']);
    update();
    const out = read();
    assert.match(out, /- \[x\] 47-1-PLAN\.md/);
    assert.match(out, /- \[ \] 47-10-PLAN\.md/);
  });

  test('a superseded plan\'s summary ticks no live plan', () => {
    plan('47-1', 'status: superseded\n'); plan('47-10'); summary('47-1');
    write(['- [ ] 47-10-PLAN.md']);
    update();
    assert.match(read(), /- \[ \] 47-10-PLAN\.md/);
  });

  test('a dotted sub-id is a distinct plan', () => {
    plan('47-01'); plan('47-01.1'); summary('47-01');
    write(['- [ ] 47-01.1-PLAN.md', '- [ ] 47-01-PLAN.md']);
    update();
    const out = read();
    assert.match(out, /- \[ \] 47-01\.1-PLAN\.md/);
    assert.match(out, /- \[x\] 47-01-PLAN\.md/);
  });

  test('phase complete flips each plan\'s own row when one id prefixes another', () => {
    plan('47-1'); plan('47-10'); summary('47-1'); summary('47-10');
    const old = new Date('2000-01-01T00:00:00Z');
    for (const id of ['47-1', '47-10']) fs.utimesSync(path.join(phaseDir, `${id}-SUMMARY.md`), old, old);
    fs.writeFileSync(path.join(phaseDir, '47-VERIFICATION.md'), '---\nstatus: passed\n---\n# Verification\n');
    write(['- [ ] 47-10-PLAN.md', '- [ ] 47-1-PLAN.md']);
    const r = runGsdTools('phase complete 47', tmpDir);
    assert.ok(r.success, `phase complete failed: ${r.error}`);
    const out = read();
    assert.match(out, /- \[x\] 47-10-PLAN\.md/);
    assert.match(out, /- \[x\] 47-1-PLAN\.md/);
  });

  for (const [label, row, expected] of [
    ['suffix-less with a dash description', '- [ ] 47-1 — desc', '- [x] 47-1 — desc'],
    ['bold', '- [ ] **47-1**', '- [x] **47-1**'],
    ['colon', '- [ ] 47-1: desc', '- [x] 47-1: desc'],
    ['slugged plan filename', '- [ ] 47-1-scaffold-PLAN.md', '- [x] 47-1-scaffold-PLAN.md'],
  ]) {
    test(`existing row form still ticks: ${label}`, () => {
      if (label === 'slugged plan filename') {
        // plan carries a descriptive slug; its summary is named by the bare id
        fs.writeFileSync(path.join(phaseDir, '47-1-scaffold-PLAN.md'), '---\nphase: foo\nplan: 47-1\nwave: 1\n---\n# Plan\n');
        summary('47-1');
      } else {
        plan('47-1'); summary('47-1');
      }
      write([row]);
      update();
      assert.ok(read().includes(expected), `expected "${expected}" in:\n${read()}`);
    });
  }
});
