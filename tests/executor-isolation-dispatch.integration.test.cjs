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
  // The prefix the step declares in its own text, so a rename there cannot leave these tests proving nothing.
  let PREFIX;
  let STEM;
  before(() => {
    content = readFileNormalized(DISPATCH_STEP_PATH);
    const declared = /^_PROMPT_PREFIX='([^']+)'/m.exec(content);
    assert.ok(declared, 'the step declares _PROMPT_PREFIX');
    PREFIX = declared[1];
    STEM = `${PREFIX}-${WAVE}-${PHASE}-${PLAN}`;
  });

  const PHASE = '7';
  const PLAN = '3';
  // The wave id the blocks take from $WAVE_WORKTREE_MANIFEST, so one wave's file is another wave's stranger.
  const WAVE = 'gsd-worktree-wave-aBc123';
  const BOM = String.fromCharCode(0xfeff);
  // Every halt #5531 adds exits 69 UNAVAILABLE (the exit-code registry doc), so the exit code does not tell them apart: each case below
  // is a separate input, and a stub mark or a payload check shows that its own guard fired. The older guards keep exit 1.
  const EXIT = { mkdir: 69, leftover: 69, mktemp: 69, symlink: 69, none: 69, two: 69, nul: 69, unreadable: 69, guard: 1 };
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

  test('#5531: any mix of shell-hostile pieces (quotes, $(...), backticks, an XML closing tag, CRLF, a BOM) round-trips byte for byte through the read-and-check block and runs no command', (t) => {
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

  test('#5531: block 1 halts with the unavailable code when the directory, a dangling .claude link, the leftover removal or mktemp fails', (t) => {
    const dir = tempDir(t);
    // The directory halt and the later mktemp halt share exit 69: a stubbed mktemp leaves a mark, so a halt before it shows the directory guard fired.
    const cases = {
      mkdir: [(root) => fs.writeFileSync(path.join(root, '.claude'), 'a file where the directory should be'), 'mktemp() { : > "$MARK"; return 1; }\n'],
      leftover: [() => {}, 'find() { return 1; }\n'],
      symlink: [(root) => fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, '.claude')), 'mktemp() { : > "$MARK"; return 1; }\n'],
      mktemp: [() => {}, 'mktemp() { return 1; }\n'],
    };
    for (const [name, [setup, stub]] of Object.entries(cases)) {
      const root = path.join(dir, name);
      const mark = path.join(dir, `${name}-mktemp-ran`);
      const prelude = stub.replace('"$MARK"', `"${mark}"`);
      fs.mkdirSync(root, { recursive: true });
      setup(root);
      const r = runBlock(root, `gsd_run() { echo false; }\n${prelude}${createBlock(content)}`);
      if (stub.includes('MARK')) assert.ok(!fs.existsSync(mark), `${name}: the directory guard halts before mktemp`);
      assert.equal(r.exitCode, EXIT[name], `${name} must halt with its code: ${r.stderr}`);
    }
  });

  test('#5531: the read-and-check block removes the matched file and halts for no match, two matches and a NUL byte (exit 69) and, with the shared exit 1, an empty file, a truncated or unmarked file and each unfinished-template marker', (t) => {
    const dir = tempDir(t);
    const put = (text) => (root) => [place(root, `${STEM}-aaaaaa`, text)];
    const cases = {
      none: [() => [], EXIT.none],
      two: [(root) => [place(root, `${STEM}-aaaaaa`, GUARDED), place(root, `${STEM}-bbbbbb`, GUARDED)], EXIT.two],
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
      // A stub leaves a mark when a later step runs: grep for the empty guard, cat for the no-match guard (without its guard the empty
      // path would fail inside cat and still exit 69).
      const mark = path.join(dir, `${name}-stub-ran`);
      const stub = { empty: 'grep', none: 'cat' }[name];
      const prelude = stub ? `${stub}() { : > "${mark}"; return 1; }\n` : '';
      const r = runBlock(root, `${prelude}${readBlock(content)}`, 'printf "%s" "$EXECUTOR_PROMPT"');
      assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
      assert.equal(r.exitCode, code, `${name} must halt with its code: ${r.stderr}`);
      assert.equal(r.stdout, '', `${name}: no prompt printed`);
      if (stub) assert.ok(!fs.existsSync(mark), `${name}: the guard itself halts, before the ${stub} step`);
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
    // Failing `wc` and `cat` stand in for a mode-000 file without mode bits, so the case also runs as root: the empty byte count skips the NUL check, and the block falls through to the cat FATAL, as it does for a file nobody can read.
    const r = runBlock(root, `wc() { return 1; }\ncat() { return 1; }\n${readBlock(content)}`, 'printf "%s" "$EXECUTOR_PROMPT"');
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, EXIT.unreadable, r.stderr);
    assert.ok(!fs.existsSync(file), 'the file is removed before the halt');
  });

  test('#5531: the name pattern keeps plan 3 apart from plan 30, plan 9 and the plan 3 of another wave for the lookup and for the leftover removal', (t) => {
    const root = path.join(tempDir(t), 'orch');
    const others = [place(root, `${PREFIX}-${WAVE}-${PHASE}-30-abcdef`, GUARDED), place(root, `${PREFIX}-${WAVE}-${PHASE}-9-abcdef`, GUARDED), place(root, `${PREFIX}-gsd-worktree-wave-zZ9876-${PHASE}-${PLAN}-abcdef`, GUARDED)];
    const r = readAndCheck(root);
    assert.equal(r.exitCode, EXIT.none, 'plan 3 finds no file when only other plans have one');
    for (const f of others) assert.ok(fs.existsSync(f), 'the halt removes only this plan\'s matches');
    const leftover = place(root, `${STEM}-abcdef`, 'old');
    const leftoverDir = path.join(root, '.claude', `${STEM}-ghijkl`);
    fs.mkdirSync(leftoverDir);
    const file = create(root);
    assert.ok(!fs.existsSync(leftover) && !fs.existsSync(leftoverDir), 'block 1 removes this plan\'s leftover file and directory');
    assert.ok(fs.existsSync(file) && others.every((f) => fs.existsSync(f)), 'block 1 creates its file and keeps the other plans\'');
  });

  test('#5531: a root path with a space, quotes, a newline, a non-ASCII character, $(...) and a backtick is data: compose and read-and-check run no command and keep the prompt', (t) => {
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
    const aged = (wave, seconds) => {
      const file = place(root, `${PREFIX}-${wave}-${PHASE}-${PLAN}-abcdef`, GUARDED);
      const when = new Date(Date.now() - seconds * 1000);
      fs.utimesSync(file, when, when);
      return file;
    };
    const minute = 60;
    const over = aged('gsd-worktree-wave-oLd111', 1441 * minute);
    // find -mmin +1440 counts the age in whole minutes rounded up, so a file 30 seconds short of the limit is the limit input
    // that stays; a file at exactly the limit is a little older by the time find runs and joins the swept side.
    const atLimit = aged('gsd-worktree-wave-oLd333', 1440 * minute - 30);
    const under = aged('gsd-worktree-wave-oLd222', 1439 * minute);
    const fresh = aged('gsd-worktree-wave-zZ9876', 0);
    create(root);
    assert.ok(!fs.existsSync(over), 'a file one minute over the limit is swept');
    assert.ok([atLimit, under, fresh].every((f) => fs.existsSync(f)), 'a file at the limit, one minute under it and a fresh one stay');
  });

  test('#5531: a none or two match halt removes the matches through a .claude that is a symlink', (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, 'orch');
    const target = path.join(dir, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(target, path.join(root, '.claude'));
    const two = ['aaaaaa', 'bbbbbb'].map((n) => {
      const file = path.join(target, `${STEM}-${n}`);
      fs.writeFileSync(file, GUARDED);
      return file;
    });
    const r = readAndCheck(root);
    assert.equal(r.exitCode, EXIT.two, r.stderr);
    assert.ok(two.every((f) => !fs.existsSync(f)), 'the halt removal reaches through the link');
  });

  test('#5531: a .claude that is a symlink to a directory is followed: the prompt file lands in the target', (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, 'orch');
    const target = path.join(dir, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(target, path.join(root, '.claude'));
    // A leftover of this wave and plan, and a crashed wave's two-day-old file, both sit in the target.
    const leftover = path.join(target, `${STEM}-abcdef`);
    fs.writeFileSync(leftover, 'old');
    const crashed = path.join(target, `${PREFIX}-gsd-worktree-wave-oLd111-${PHASE}-${PLAN}-abcdef`);
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
