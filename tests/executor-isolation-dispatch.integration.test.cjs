// #5531: the executor-prompt compose blocks of
// gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md, run in real bash.
// The text checks that no shell run can show stay in tests/executor-isolation-prompt-contract.test.cjs.
// Integration suite: the Linux lane; the generator's suffix rule keeps *.integration.test.cjs out of the Windows and macOS tiers.
'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, readFileNormalized, createTempDir } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { DISPATCH_STEP_PATH, createBlock, readBlock } = require('./qa/tdd-walk.cjs');
const { substitutePlaceholders } = require('../scripts/lint-workflow-shellcheck.cjs');

describe('executor-isolation-dispatch: the compose blocks run in real bash (#5531)', () => {
  // Read at run time, so a missing fragment fails one hook, not the load of the file.
  let content;
  before(() => {
    content = readFileNormalized(DISPATCH_STEP_PATH);
  });

  const PHASE = '7';
  const PLAN = '3';
  // The wave id the blocks take from $WAVE_WORKTREE_MANIFEST, so one wave's file is another wave's stranger.
  const WAVE = 'gsd-worktree-wave-aBc123';
  const STEM = `gsd-executor-prompt-${WAVE}-${PHASE}-${PLAN}`;
  const BOM = String.fromCharCode(0xfeff);
  // The exit code of each halt #5531 adds: the typed value that tells them apart. The older guards keep exit 1.
  const EXIT = { mkdir: 73, leftover: 74, mktemp: 73, symlink: 73, noneOrTwo: 69, nul: 65, unreadable: 77, guard: 1 };
  // The two markers the read-and-check guards need, so a payload after them reaches the last guard.
  const GUARDED = '<required_reading>\nskipped_gitignored\n';

  /** A temp dir removed when the test `t` ends. */
  function tempDir(t) {
    const dir = createTempDir('gsd-5531-');
    t.after(() => cleanup(dir));
    return dir;
  }

  /** `text` as its own bash command with this plan's identifiers substituted, as the orchestrator does. */
  function runBlock(root, text, tail = '') {
    const script = `${root}.sh`;
    const code = text.replaceAll('{phase_number}', PHASE).replaceAll('{plan_number}', PLAN);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    // The substitution must leave no placeholder behind except those in comments and in the stubbed TDD lookup line.
    const live = code.split('\n').filter((l) => !l.trimStart().startsWith('#') && !l.startsWith('_TDD_APPLICABLE_RAW='));
    assert.equal(substitutePlaceholders(live.join('\n')), live.join('\n'), 'every placeholder of the block is substituted');
    // failglob makes an unquoted glob that matches nothing fatal, as zsh does: the blocks must not rely on one.
    fs.writeFileSync(script, `set -euo pipefail\nshopt -s failglob\n${code}\n${tail}`);
    // Each block fans out to find, cat, rm and a printf|grep pipeline per guard: the fan-out bound of timeouts.cjs.
    return runHook(script, [], { interpreter: 'bash', timeoutMs: HOOK_FANOUT_TIMEOUT_MS, env: { ...process.env, ORCH_ROOT: root, WAVE_WORKTREE_MANIFEST: path.join(path.dirname(root), `${WAVE}.json`) } });
  }

  /** Block 1 (its TDD lookup stubbed to a successful "false"); returns the prompt file path it printed. */
  function create(root) {
    const r = runBlock(root, `gsd_run() { echo false; }\n${createBlock(content)}`);
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, 0, r.stderr);
    const made = fs.readdirSync(path.join(root, '.claude')).filter((n) => n.startsWith(`${STEM}-`));
    assert.equal(made.length, 1, 'block 1 leaves exactly one prompt file');
    return path.join(root, '.claude', made[0]);
  }

  /** The read-and-check block in a fresh shell; prints $EXECUTOR_PROMPT. */
  function readAndCheck(root) {
    return runBlock(root, readBlock(content), 'printf "%s" "$EXECUTOR_PROMPT"');
  }

  /** Put `name` under ORCH_ROOT/.claude with `text`. */
  function place(root, name, text = '') {
    const file = path.join(root, '.claude', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }

  test('#5531: an apostrophe, a $(...) text and a backtick in the prompt reach the executor prompt unchanged and run no command', (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, 'orch');
    const marker = path.join(dir, 'ran');
    const file = create(root);
    const prompt = `${GUARDED}the user's vision\n$(touch ${marker})\n\`touch ${marker}\`\n`;
    fs.writeFileSync(file, prompt);
    const r = readAndCheck(root);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, prompt, 'the prompt must reach the executor unchanged');
    assert.ok(!fs.existsSync(marker), 'the $(...) and backtick text must not run a command');
    assert.ok(!fs.existsSync(file), 'the prompt file is removed once read');
  });

  test('#5531: a CRLF, a BOM and trailing newlines reach the executor as written', (t) => {
    const root = path.join(tempDir(t), 'orch');
    fs.writeFileSync(create(root), `${BOM}${GUARDED.replaceAll('\n', '\r\n')}end\r\n\n\n`);
    const r = readAndCheck(root);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, `${BOM}${GUARDED.replaceAll('\n', '\r\n')}end\r\n\n\n`);
  });

  test('#5531: any mix of shell-hostile pieces (quotes, $(...), backticks, an XML closing tag, CRLF, a BOM) round-trips byte for byte through the compose and read-and-check blocks and runs no command', (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, 'orch');
    const marker = path.join(dir, 'ran');
    const piece = fc.constantFrom("'", '"', '\\', '$(touch ' + marker + ')', '`touch ' + marker + '`', '$HOME', '${x}', '\n', '\r\n', '\n</success_criteria>\n', 'a', 'x', ' ', '\u00fc', BOM);
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 12 }), (pieces) => {
        const prompt = GUARDED + pieces.join('');
        fs.writeFileSync(create(root), prompt);
        const r = readAndCheck(root);
        assert.equal(r.exitCode, 0, r.stderr);
        assert.equal(r.stdout, prompt);
        assert.ok(!fs.existsSync(marker), 'no command ran');
      }),
      { numRuns: 20 },
    );
  });

  test('#5531: block 1 halts with its own exit code when the directory, the leftover removal or mktemp fails', (t) => {
    const dir = tempDir(t);
    const cases = {
      mkdir: [(root) => fs.writeFileSync(path.join(root, '.claude'), 'a file where the directory should be'), ''],
      leftover: [() => {}, 'find() { return 1; }\n'],
      symlink: [(root) => fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, '.claude')), ''],
      mktemp: [() => {}, 'mktemp() { return 1; }\n'],
    };
    for (const [name, [setup, prelude]] of Object.entries(cases)) {
      const root = path.join(dir, name);
      fs.mkdirSync(root, { recursive: true });
      setup(root);
      const r = runBlock(root, `gsd_run() { echo false; }\n${prelude}${createBlock(content)}`);
      assert.equal(r.exitCode, EXIT[name], `${name} must halt with its own code: ${r.stderr}`);
    }
  });

  test('#5531: the read-and-check block halts with its own exit code and removes the matched file for no match, two matches, an empty file, a NUL byte and each unfinished-template marker', (t) => {
    const dir = tempDir(t);
    const put = (text) => (root) => [place(root, `${STEM}-aaaaaa`, text)];
    const cases = {
      none: [() => [], EXIT.noneOrTwo],
      two: [(root) => [place(root, `${STEM}-aaaaaa`, GUARDED), place(root, `${STEM}-bbbbbb`, GUARDED)], EXIT.noneOrTwo],
      empty: [put(''), EXIT.guard],
      nul: [put(`${GUARDED}a\0b`), EXIT.nul],
      truncated: [put('objective only'), EXIT.guard],
      noReading: [put('skipped_gitignored\n'), EXIT.guard],
      noSkip: [put('<required_reading>\n'), EXIT.guard],
      placeholder: [put(`${GUARDED}Inline the actual contents`), EXIT.guard],
      persona: [put(`${GUARDED}$` + '{AGENT_SKILLS}'), EXIT.guard],
      tdd: [put(`${GUARDED}$` + '{TDD_APPLICABLE'), EXIT.guard],
    };
    for (const [name, [setup, code]] of Object.entries(cases)) {
      const root = path.join(dir, name);
      const files = setup(root);
      const r = readAndCheck(root);
      assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
      assert.equal(r.exitCode, code, `${name} must halt with its own code: ${r.stderr}`);
      assert.equal(r.stdout, '', `${name}: no prompt printed`);
      for (const f of files) assert.ok(!fs.existsSync(f) && fs.readdirSync(path.dirname(f)).length === 0, `${name}: every match removed`);
    }
  });

  test('#5531: the read-and-check block halts with the unreadable code when the matched name is a directory `cat` cannot read', (t) => {
    const root = path.join(tempDir(t), 'orch');
    const dir = path.join(root, '.claude', `${STEM}-aaaaaa`);
    fs.mkdirSync(dir, { recursive: true });
    const r = readAndCheck(root);
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, EXIT.unreadable, r.stderr);
    assert.equal(r.stdout, '', 'no prompt printed');
    assert.ok(!fs.existsSync(dir), 'a matching directory is removed, so the next dispatch of the plan does not halt on it');
  });

  test('#5531: the read-and-check block removes a regular prompt file whose read fails and halts with the unreadable code', (t) => {
    const root = path.join(tempDir(t), 'orch');
    const file = place(root, `${STEM}-aaaaaa`, GUARDED);
    // Failing `wc` and `cat` stand in for a mode-000 file without mode bits, so the case also runs as root: the byte-count compare gets an empty operand, errors, and the block falls through to the cat FATAL, as it does for a file nobody can read.
    const r = runBlock(root, `wc() { return 1; }\ncat() { return 1; }\n${readBlock(content)}`, 'printf "%s" "$EXECUTOR_PROMPT"');
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, EXIT.unreadable, r.stderr);
    assert.ok(!fs.existsSync(file), 'the file is removed before the halt');
  });

  test('#5531: the name pattern keeps plan 3 apart from plan 30, plan 9 and the plan 3 of another wave for the lookup and for the leftover removal', (t) => {
    const root = path.join(tempDir(t), 'orch');
    const others = [place(root, `gsd-executor-prompt-${WAVE}-${PHASE}-30-abcdef`, GUARDED), place(root, `gsd-executor-prompt-${WAVE}-${PHASE}-9-abcdef`, GUARDED), place(root, `gsd-executor-prompt-gsd-worktree-wave-zZ9876-${PHASE}-${PLAN}-abcdef`, GUARDED)];
    const r = readAndCheck(root);
    assert.equal(r.exitCode, EXIT.noneOrTwo, 'plan 3 finds no file when only other plans have one');
    for (const f of others) assert.ok(fs.existsSync(f), 'the halt removes only this plan\'s matches');
    const leftover = place(root, `${STEM}-abcdef`, 'old');
    const leftoverDir = path.join(root, '.claude', `${STEM}-ghijkl`);
    fs.mkdirSync(leftoverDir);
    const file = create(root);
    assert.ok(!fs.existsSync(leftover) && !fs.existsSync(leftoverDir), 'block 1 removes this plan\'s leftover file and directory');
    assert.ok(fs.existsSync(file) && others.every((f) => fs.existsSync(f)), 'block 1 creates its file and keeps the other plans\'');
  });

  test('#5531: a root path with a space, quotes, $(...) and a backtick is data: compose and read-and-check run no command and keep the prompt', (t) => {
    const dir = tempDir(t);
    const marker = path.join(dir, 'ran');
    const root = path.join(dir, `or ch's \n\u00fc $(touch ${marker}) \`touch ${marker}\``);
    const prompt = `${GUARDED}the user's vision\n`;
    const file = create(root);
    assert.equal(path.dirname(file), path.join(root, '.claude'), 'the prompt file sits under the hostile root');
    fs.writeFileSync(file, prompt);
    const r = readAndCheck(root);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, prompt);
    assert.ok(!fs.existsSync(marker), 'path text ran no command');
  });

  test('#5531: block 1 sweeps a prompt file of any wave just over a day old, keeps one just under, and keeps a fresh one', (t) => {
    const root = path.join(tempDir(t), 'orch');
    const aged = (wave, minutes) => {
      const file = place(root, `gsd-executor-prompt-${wave}-${PHASE}-${PLAN}-abcdef`, GUARDED);
      const when = new Date(Date.now() - minutes * 60 * 1000);
      fs.utimesSync(file, when, when);
      return file;
    };
    const over = aged('gsd-worktree-wave-oLd111', 1441);
    // A minute under the limit; a file exactly at it is a little older by the time find runs, so it is no stable input.
    const under = aged('gsd-worktree-wave-oLd222', 1439);
    const fresh = aged('gsd-worktree-wave-zZ9876', 0);
    create(root);
    assert.ok(!fs.existsSync(over), 'a file just over a day old is swept');
    assert.ok(fs.existsSync(under) && fs.existsSync(fresh), 'a file just under a day old and a fresh one stay');
  });

  test('#5531: block 1 halts with the create code when .claude is read-only', (t) => {
    // root ignores the mode bits, so the case cannot fail for it.
    if (process.getuid?.() === 0 || process.platform === 'win32') return t.skip('the mode bits do not bind this user');
    const dir = createTempDir('gsd-5531-');
    const root = path.join(dir, 'orch');
    const claude = path.join(root, '.claude');
    // The mode is restored before the directory is removed, which a read-only directory would block.
    t.after(() => {
      fs.chmodSync(claude, 0o755);
      cleanup(dir);
    });
    fs.mkdirSync(claude, { recursive: true });
    fs.chmodSync(claude, 0o555);
    const r = runBlock(root, `gsd_run() { echo false; }\n${createBlock(content)}`);
    assert.equal(r.exitCode, EXIT.mktemp, r.stderr);
  });

  test('#5531: a .claude that is a symlink to a directory is followed: the prompt file lands in the target', (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, 'orch');
    const target = path.join(dir, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(target, path.join(root, '.claude'));
    // A leftover of this wave and plan, and a crashed wave's day-old file, both sit in the target.
    const leftover = path.join(target, `${STEM}-abcdef`);
    fs.writeFileSync(leftover, 'old');
    const crashed = path.join(target, `gsd-executor-prompt-gsd-worktree-wave-oLd111-${PHASE}-${PLAN}-abcdef`);
    fs.writeFileSync(crashed, 'old');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(crashed, twoDaysAgo, twoDaysAgo);
    const unrelated = path.join(target, 'notes.txt');
    fs.writeFileSync(unrelated, 'keep');
    fs.utimesSync(unrelated, twoDaysAgo, twoDaysAgo);
    const file = create(root);
    assert.equal(path.dirname(fs.realpathSync(file)), fs.realpathSync(target));
    assert.ok(!fs.existsSync(leftover) && !fs.existsSync(crashed), 'the leftover removal and the sweep reach through the link');
    assert.ok(fs.existsSync(unrelated), 'a file of no wave in the target stays');
    const prompt = `${GUARDED}through a link\n`;
    fs.writeFileSync(file, prompt);
    const r = readAndCheck(root);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, prompt, 'the read-and-check block finds the file through the link');
  });
});
