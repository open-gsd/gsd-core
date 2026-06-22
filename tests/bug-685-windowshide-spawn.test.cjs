// allow-test-rule: source-text-is-the-product
// These spawn/exec sites cannot be behaviourally tested for windowsHide
// off-Windows; the source text is the runtime contract (issue #685). Without
// windowsHide:true a detached or shell:true child allocates a visible console
// window on Windows (the "gsd-core" flash).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf-8');

// Slice the exact body of one spawn site so the assertion binds that site,
// not merely "windowsHide appears somewhere in the file".
function regionBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.notEqual(i, -1, `start anchor not found: ${startAnchor}`);
  const j = src.indexOf(endAnchor, i);
  assert.notEqual(j, -1, `end anchor not found after start: ${endAnchor}`);
  return src.slice(i, j);
}

describe('bug #685: Windows spawns must set windowsHide:true (no console-window flash)', () => {
  test('gsd-context-monitor record-session spawn sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-context-monitor.js'), "'record-session'", '.unref()');
    assert.match(region, /windowsHide:\s*true/, 'record-session spawn must set windowsHide: true');
  });

  const cts = () => read('src/shell-command-projection.cts');
  const helpers = [
    ['execGit', 'export function execGit', "_spawnResult(result, 'git')"],
    ['execNpm', 'export function execNpm', "_spawnResult(result, 'npm')"],
    ['execTool', 'export function execTool', '_spawnResult(result, program)'],
  ];
  for (const [name, start, end] of helpers) {
    test(`shell-command-projection ${name} spawnSync sets windowsHide`, () => {
      const region = regionBetween(cts(), start, end);
      assert.match(region, /windowsHide:\s*true/, `${name} spawnSync must set windowsHide: true`);
    });
  }

  test('gsd-worktree-path-guard SPAWNOPT sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-worktree-path-guard.js'), 'const SPAWNOPT', '};');
    assert.match(region, /windowsHide:\s*true/, 'gsd-worktree-path-guard SPAWNOPT must set windowsHide: true');
  });

  test('gsd-workflow-guard currentBranch spawnSync sets windowsHide', () => {
    const region = regionBetween(read('hooks/gsd-workflow-guard.js'), "spawnSync('git', ['branch'", '});');
    assert.match(region, /windowsHide:\s*true/, 'gsd-workflow-guard git-branch spawn must set windowsHide: true');
  });

  test('check-command-router recentCommitMessages execFileSync sets windowsHide', () => {
    const region = regionBetween(read('src/check-command-router.cts'), "execFileSync('git', ['log'", '});');
    assert.match(region, /windowsHide:\s*true/, 'check-command-router git-log execFileSync must set windowsHide: true');
  });

  test('roadmap-upgrade execSync git calls all set windowsHide', () => {
    const src = read('src/roadmap-upgrade.cts');
    const calls = src.match(/execSync\([^)]*\)/g) || [];
    // #1542 made rollback git-independent (surgical fs restore), so the only
    // remaining git execSync is the `git status --porcelain` precondition. The
    // durable guard is that EVERY git execSync still present sets windowsHide.
    assert.ok(calls.length >= 1, 'expected at least the roadmap-upgrade git status execSync call to be present');
    const missing = calls.filter((c) => !/windowsHide:\s*true/.test(c));
    assert.deepEqual(missing, [], `execSync without windowsHide:\n${missing.join('\n')}`);
  });

  test('gsd-check-update spawn retains windowsHide (precedent guard)', () => {
    assert.match(read('hooks/gsd-check-update.js'), /windowsHide:\s*true/,
      'gsd-check-update.js must keep windowsHide: true');
  });

  // Durable invariant: ANY external-binary process spawn in the runtime source
  // (hooks + src) must set windowsHide — catches future additions, not just the
  // sites known today. Handles the `{ ...CONST }` spread indirection.
  test('completeness: no external-binary spawn in runtime source omits windowsHide', () => {
    const listDir = (dir, re) =>
      fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`);
    const files = [...listDir('hooks', /\.js$/), ...listDir('src', /\.cts$/)];
    const callRe = /(?:execSync|execFileSync|spawnSync|spawn)\s*\(\s*(?:`|'|")?(?:git|npm|gh)\b|spawn\s*\(\s*process\.execPath/g;
    const offenders = [];
    for (const rel of files) {
      const src = read(rel);
      let m;
      while ((m = callRe.exec(src)) !== null) {
        const win = src.slice(m.index, m.index + 400);
        let ok = /windowsHide:\s*true/.test(win);
        if (!ok) {
          const spread = win.match(/\{\s*\.\.\.(\w+)/); // e.g. { ...SPAWNOPT, cwd }
          if (spread) {
            ok = new RegExp(`(?:const|let|var)\\s+${spread[1]}\\s*=\\s*\\{[^}]*windowsHide:\\s*true`).test(src);
          }
        }
        if (!ok) offenders.push(`${rel}: ...${src.slice(m.index, m.index + 48).replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(offenders, [], `external-binary spawns missing windowsHide:\n${offenders.join('\n')}`);
  });
});
