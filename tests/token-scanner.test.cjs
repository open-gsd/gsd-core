'use strict';

/**
 * Tests for `src/token-scanner.cts` — the tokenizer-first seam (#3212 Phase 3, #3414).
 *
 * Design:       .gsd/phase/chore-3414-tokenizer-first-seam/40-design.md
 * Test matrix:  .gsd/phase/chore-3414-tokenizer-first-seam/50-test-matrix.md
 * ADR:          docs/adr/3212-lexical-seam-consolidation.md §4, §6, §7
 *
 * TDD RED: `src/token-scanner.cts` does not exist yet — this file's
 * `require('../gsd-core/bin/lib/token-scanner.cjs')` throws MODULE_NOT_FOUND until
 * the implementing phase adds it (mirrors tests/pattern.test.cjs / tests/text-lines.test.cjs's
 * RED convention from Phases 1-2).
 *
 * Covers test-matrix rows 1-10: tokenizeShellLike (1-5), indentWidth (6-10); firstUnprovenMarker
 * (the conservative double-quote check of the gate evaluator) at the end of the file.
 * extractBranchArgument (rows 11-17) lives in git-cmd.js, tested in
 * tests/worktree-safety.test.cjs's folded bug-3129 block, not here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
// Seeded fast-check convention: require the shared setup helper (NOT
// 'fast-check' directly) so numRuns/seed are configured globally before any
// fc.assert() call — mirrors tests/pattern.test.cjs / tests/text-lines.test.cjs.
// seed: 42, overridable via GSD_FC_SEED. Required by TESTING-STANDARDS.md:169
// ("modules that implement parsing... must include at least one fast-check
// property test asserting a domain invariant") — a review finding this phase
// missed on first pass; both invariants below are added in response to it.
const fc = require('./helpers/fast-check-setup.cjs');

const { tokenizeShellLike, indentWidth, firstUnprovenMarker } = require('../gsd-core/bin/lib/token-scanner.cjs');
const { tokenize: gitCmdTokenize } = require(path.join(__dirname, '..', 'hooks', 'lib', 'git-cmd.js'));

// ─── tokenizeShellLike — rows 1-5 ──────────────────────────────────────────

describe('tokenizeShellLike', () => {
  test('row 1: bare git commit, double-quoted message', () => {
    assert.deepStrictEqual(
      tokenizeShellLike('git commit -m "msg"'),
      ['git', 'commit', '-m', 'msg'],
    );
  });

  test('row 2: single-quoted message', () => {
    assert.deepStrictEqual(
      tokenizeShellLike("git commit -m 'my message'"),
      ['git', 'commit', '-m', 'my message'],
    );
  });

  test('row 3: env-prefix assignment token preserved', () => {
    assert.deepStrictEqual(
      tokenizeShellLike('GIT_AUTHOR_NAME=x git commit'),
      ['GIT_AUTHOR_NAME=x', 'git', 'commit'],
    );
  });

  test('row 4: empty string yields no tokens', () => {
    assert.deepStrictEqual(tokenizeShellLike(''), []);
  });

  test('row 5: parity with git-cmd.js\'s current tokenize() on every existing #3129 fixture', () => {
    const fixtures = [
      'git commit -m "feat: add thing"',
      "git commit -m 'fix: typo'",
      'git commit --no-verify -m "wip"',
      'git -C /some/path commit -m "fix: x"',
      'GIT_AUTHOR_NAME=Alice git commit -m "fix"',
      '/usr/bin/git commit -m "feat: y"',
      'GIT_AUTHOR_NAME=A GIT_AUTHOR_EMAIL=b@c git commit -m "x"',
      'git --git-dir=.git commit -m "x"',
      'git --git-dir .git commit -m "x"',
      'git --no-pager commit -m "x"',
      '/usr/bin/git -C /proj commit -m "x"',
      'git -p commit -m "x"',
      'git push origin main',
      'git status',
      'git add .',
      'git log --oneline',
      'npm install',
      '',
      'git checkout main',
      'git -C /path push',
    ];
    for (const cmd of fixtures) {
      assert.deepStrictEqual(
        tokenizeShellLike(cmd),
        gitCmdTokenize(cmd),
        `tokenizeShellLike must match git-cmd.js's tokenize() for: ${JSON.stringify(cmd)}`,
      );
    }
  });
});

// ─── indentWidth — rows 6-10 ────────────────────────────────────────────────

describe('indentWidth', () => {
  test('row 6: no leading whitespace', () => {
    assert.strictEqual(indentWidth('- **D-01:** text'), 0);
  });

  test('row 7: counts leading spaces', () => {
    assert.strictEqual(indentWidth("  - **D-06's fix does not close this.** text"), 2);
  });

  test('row 8: a tab counts as one column, not expanded', () => {
    assert.strictEqual(indentWidth('\t- text'), 1);
  });

  test('row 9: empty string and no-leading-whitespace both return 0', () => {
    assert.strictEqual(indentWidth(''), 0);
    assert.strictEqual(indentWidth('no leading space'), 0);
  });

  test('row 10: all-whitespace line returns its full length', () => {
    assert.strictEqual(indentWidth('   '), 3);
  });
});

// ─── Property tests (TESTING-STANDARDS.md:169) ─────────────────────────────

describe('property: indentWidth counts exactly the generated leading-space run', () => {
  test('indentWidth(spaces + non-space content) === spaces.length', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/^[ \t]/.test(s)),
        (n, content) => {
          const line = ' '.repeat(n) + content;
          assert.strictEqual(indentWidth(line), n);
        },
      ),
    );
  });
});

describe('property: tokenizeShellLike is the inverse of joining whitespace-free words with single spaces', () => {
  test('tokenizeShellLike(words.join(" ")) deepStrictEqual words', () => {
    // A "word" here is any non-empty run with no whitespace and no quote
    // characters — the shape that round-trips through the tokenizer without
    // needing quoting to survive the join (quoting is exercised separately
    // by rows 1-2/5; this property covers the bijective unquoted case
    // TESTING-STANDARDS.md:169 asks for).
    const wordArb = fc
      .string({ minLength: 1, maxLength: 12 })
      .filter((s) => s.length > 0 && !/[\s'"]/.test(s));
    fc.assert(
      fc.property(fc.array(wordArb, { minLength: 0, maxLength: 10 }), (words) => {
        assert.deepStrictEqual(tokenizeShellLike(words.join(' ')), words);
      }),
    );
  });
});

// ─── firstUnprovenMarker — conservative double-quote check ─────────────────

describe('firstUnprovenMarker', () => {
  const MARKER = /\$\{?(GSD_MARK)\b/;
  const first = (template) => firstUnprovenMarker(template.replaceAll('@', '${GSD_MARK}'), MARKER);

  test('a marker in plain double quotes is proven, with any other quote or word around it', () => {
    for (const ok of ['echo "@"', 'echo "a@b" "@"', 'echo "it\'s" "@"', 'echo "a # b" "@"', 'echo \\" "@"', 'echo "${x:-@}"', 'echo "@" \'q\' "r"', 'echo "$GSD_MARK"', 'echo "@${x}"']) {
      assert.equal(first(ok), undefined, ok);
    }
  });
  test('a command without a marker is never refused, whatever it holds', () => {
    for (const none of ["echo '${GSD_MARKX}' '$GSD_MARK_X'", 'echo $(date) `date` <<EOF', "# it's\necho $'x' ${y:-'z'}", 'echo ${GSD_MARKX}', 'echo "a" \'b']) {
      assert.equal(first(none), undefined, none);
    }
  });
  test('a marker outside double quotes is refused: unquoted, single-quoted, bare', () => {
    for (const bad of ['echo @', "echo '@'", "echo 'a' @", 'echo "a"@', "echo '$GSD_MARK'", 'echo $GSD_MARK', "echo '\\' @", 'echo "a" \'@\'']) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a backslash before a marker makes it literal, and `$$` makes it the pid plus text', () => {
    for (const bad of ['echo \\@', 'echo "\\@"', 'echo "$$GSD_MARK"', 'echo "$${GSD_MARK}"']) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
    assert.equal(first('echo \\\\ "@"'), undefined);
  });
  test('a marker after $(, a backtick, <<, $\' or inside a quote in ${...} is refused', () => {
    for (const bad of ['echo "$(ls "@")"', 'echo "`ls "@"`"', 'echo "`echo \'@\'`"', 'cat <<EOF\n@\nEOF', 'cat <<<"@"', "echo $'a' \"@\"", 'echo "${x:-\'a\'}" "@"', 'echo "${x:-"a"}" "@"', "echo \"${GSD_MARK#'@'}\""]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a double-quoted marker in the text eval, trap or sh -c parses again is refused, in each spelling of the consumer', () => {
    for (const bad of [
      'eval "@"', 'eval "test -e \\"@\\""', 'eval echo "@"', 'echo ok; eval "@"', 'trap "rm @" EXIT',
      'sh -c "echo @"', 'bash -c "echo @"', 'dash -c "echo @"', '/bin/sh -c "echo @"', 'sh -ec "echo @"', 'sh -ce "echo @"',
      'sh -o pipefail -c "echo @"', 'sh -c -e "echo @"', 'sh -c -- "echo @"', 'sh -c "a" -c "@"', 'sh -c "a-@"',
      'printf x | xargs sh -c "echo @"', 'find . -exec sh -c "echo @" \\;', 'echo ok;sh -c "@"', '(sh -c "@")',
    ]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a double-quoted marker that no consumer parses again is proven, whatever the command', () => {
    const ok = [
      'echo -c x "@"', 'grep -c x "@"', 'test -d "@" -a -c "@"', 'sh script.sh "@"', 'sh -x "@"', 'echo "@"; echo eval',
      "sh -c 'echo \"$1\"' sh \"@\"", "sh -ec 'echo \"$1\"' sh \"@\"", "bash -c 'echo \"$1\"' bash \"@\" \"@\"",
      "find . -exec sh -c 'echo \"$1\"' sh \"@\" \\;", "printf x | xargs -0 sh -c 'echo \"$1\"' sh \"@\"", "d=\"@\"; eval 'echo \"$d\"'", "d=\"@\"; trap 'echo \"$d\"' EXIT",
    ];
    for (const text of ok) assert.equal(first(text), undefined, text);
  });
  test('a command that runs xargs without -0 or -d is refused for any marker, before or after it', () => {
    for (const bad of ['echo "@" | xargs ls', 'xargs ls < "@"', 'xargs -n1 echo "@"', 'echo "@" | xargs -I{} ls {}']) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
    for (const ok of ['echo "@" | xargs -0 ls', 'echo "@" | xargs -d x ls', 'echo "@" | xargs -dx ls', 'echo "@" | xargs --null ls', 'echo "@" | xargs --delimiter=x ls', 'echo "@"; find . -delete', 'echo "@" xargsx']) {
      assert.equal(first(ok), undefined, ok);
    }
  });
  test('a # that starts a word is refused; a # inside a word, in quotes or in ${...} is not', () => {
    for (const lead of ['', 'echo ok ', 'echo ok;', 'echo ok&', 'echo ok|', '(', 'echo ok)', 'echo >', 'echo <', 'echo ok\n']) {
      // The comment holds a lone `"`: read as code it would open a span that proves the later single-quoted marker.
      assert.equal(first(`${lead}# "\necho '@'`), 'GSD_MARK', JSON.stringify(lead));
    }
    assert.equal(first('echo a#b "@"'), undefined);
    assert.equal(first('echo $# "@"'), undefined);
    assert.equal(first('echo "a # b" "@"'), undefined);
    assert.equal(first('echo "${#x}" "@"'), undefined);
    // `sh` deletes the backslash-newline pair first, so this `#` sits inside the word `a#b`.
    assert.equal(first('echo a\\\n#b "@"'), undefined);
    assert.equal(first('echo a \\\n#b "@"'), 'GSD_MARK');
  });
  test('the refusal names the first marker after the construct, not an earlier proven one', () => {
    const marker = /\$\{?(A|B)\b/;
    assert.equal(firstUnprovenMarker('echo "${A}" $(echo "${B}")', marker), 'B');
    assert.equal(firstUnprovenMarker('echo "${A}" "${B}" \'${A}\'', marker), 'A');
    assert.equal(firstUnprovenMarker('echo "${A}" $(true)', marker), undefined);
    // Two markers after one unread construct: the first one is named.
    assert.equal(firstUnprovenMarker('echo $(echo "${A}" "${B}")', marker), 'A');
    assert.equal(firstUnprovenMarker('# ${A} ${B}', marker), 'A');
    assert.equal(firstUnprovenMarker("cat <<'EOF'\n${A} ${B}\nEOF", marker), 'A');
  });
  test('a ${...} closes at its brace: a quote after it opens a normal span', () => {
    assert.equal(first('echo "${x}" \'a\' "@"'), undefined);
    assert.equal(first('echo } ${x:-\'a\'} "@"'), 'GSD_MARK');
    assert.equal(first('echo ${x} \'@\''), 'GSD_MARK');
    assert.equal(first('echo "${x:-${y}}" "@" \'@\''), 'GSD_MARK');
  });

  describe('property: no marker that the real shell leaves literal is accepted', () => {
    // `@` is the marker. Each fragment prints it; a hand-written label would repeat the reasoning under test,
    // so the oracle is the real shell: a literal marker shows its name in stdout. The fragments use bash syntax
    // (`$'..'`, `<<<`), which dash rejects, so the oracle is `bash` and each fragment must run clean on its own:
    // a syntax error would print nothing and skip the assertion below.
    const FRAGMENTS = [
      'echo @', "echo '@'", "echo $'a\\'b @'", "cat <<'EOF'\n@\nEOF", 'cat <<"EOF"\n@\nEOF', 'cat <<\\EOF\n@\nEOF',
      "echo $(echo '@')", 'echo "it\'s @"', "# it's @", "cat <<EOF\nit's @\nEOF", "echo `echo \"it's @\"`", 'echo $((1<<2)) "@"',
      'echo "${x:-"it\'s"}" \'@\'', 'echo "${x:-"it\'s"}" "@"', 'echo "$(case $v in (a) echo "it\'s";; esac)" \'@\'',
      'echo "$(echo case) it\'s" "@"', 'echo $(( (1<<2) ))\necho \'@\'', 'echo "${x:-\'@\'}"', "cat <<-EOF\n\tit's @\n\tEOF",
      "cat << 'EOF'\n@\nEOF", "cat <<<'@'", 'cat <<<"@"',
      'echo it\\\'s "@"', 'echo "a\\"b @"', "echo a#b '@'", "echo x;# it's @", "cat <<'a\\b'\n@\na\\b", "cat <<'ab\n@'",
      "cat <<EOF\n\tEOF\nit's @\nEOF", "cat <<EOF # it's\nbody it's @\nEOF", "echo '\\' '@'", 'echo ${x:-\'@\'}', 'echo "${x%% #*}" \'@\'',
      "echo $(:)#'@'", "(:)# it's @", 'echo "$(echo $((1)))" \'@\'',
      'echo \\@', 'echo "\\@"', 'echo "$$@"', 'echo "${GSD_MARK#\'@\'}"', 'echo ">#@"', 'echo "a"\'@\'', 'echo "$(echo "@")"',
      'echo "$\\\n(echo \'@\')"', "cat <\\\n<'EOF'\n\"@\"\nEOF",
    ];
    const env = isolatedEnv({ home: os.tmpdir(), override: { GSD_MARK: 'SENT' } });
    const probe = (command) => runHook('-c', [command], { interpreter: 'bash', env, input: '', timeoutMs: PROBE_TIMEOUT_MS });
    test('each fragment runs clean in the oracle shell, so no combination is silenced by a syntax error', () => {
      const failed = FRAGMENTS.filter((text) => probe(text.replaceAll('@', '${GSD_MARK}')).exitCode !== 0);
      assert.deepStrictEqual(failed, []);
    });
    test('the oracle prints a literal marker by name and an expanded one by value', () => {
      assert.match(probe("echo '${GSD_MARK}'").stdout, /GSD_MARK/);
      assert.match(probe('echo "${GSD_MARK}"').stdout, /SENT/);
    });
    test('every combination with a literal marker is refused', () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 5 }), (picked) => {
          const command = picked.map((text) => text.replaceAll('@', '${GSD_MARK}')).join('\n');
          const { stdout, outcome } = probe(command);
          assert.equal(outcome, OUTCOME.EXITED, command);
          if (stdout.includes('GSD_MARK')) assert.notEqual(firstUnprovenMarker(command, MARKER), undefined, command);
        }),
        // One bash spawn per run: a small count, as the other process-spawning properties use.
        { numRuns: 30 },
      );
    });
  });

  describe('property: no marker that a consumer runs as code is accepted', () => {
    // The marker's value is `a$(echo RAN)`. A shell that only expands it prints that text; one that parses it
    // again runs the substitution and prints `aRAN`. The real shell is the oracle, as in the property above.
    const CONSUMERS = [
      'eval "echo @"', 'eval "echo \\"@\\""', 'sh -c "echo @"', 'bash -c "echo @"', 'sh -ec "echo @"', 'sh -o pipefail -c "echo @"',
      'trap "echo @" EXIT', 'echo x | xargs sh -c "echo @"', 'find . -prune -exec sh -c "echo @" \\;', 'echo x | xargs -0 sh -c "echo @"',
    ];
    const SAFE = ['echo "@"', "sh -c 'echo \"$1\"' sh \"@\"", 'd="@"; eval \'echo "$d"\'', 'd="@"; trap \'echo "$d"\' EXIT', 'echo "@" | xargs -0 echo', "find . -prune -exec sh -c 'echo \"$1\"' sh \"@\" \\;"];
    const env = isolatedEnv({ home: os.tmpdir(), override: { GSD_MARK: 'a$(echo RAN)' } });
    const probe = (command) => runHook('-c', [command], { interpreter: 'bash', env, input: '', timeoutMs: PROBE_TIMEOUT_MS });
    const spell = (text) => text.replaceAll('@', '${GSD_MARK}');

    test('the oracle runs the value from each consumer row and only expands it from each safe row', () => {
      for (const text of CONSUMERS) assert.match(probe(spell(text)).stdout, /aRAN/, text);
      for (const text of SAFE) assert.doesNotMatch(probe(spell(text)).stdout, /aRAN/, text);
    });
    test('each consumer row is refused and each safe row is accepted', () => {
      for (const text of CONSUMERS) assert.notEqual(firstUnprovenMarker(spell(text), MARKER), undefined, text);
      for (const text of SAFE) assert.equal(firstUnprovenMarker(spell(text), MARKER), undefined, text);
    });
    test('every combination whose run executes the value is refused', () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...CONSUMERS, ...SAFE), { minLength: 1, maxLength: 4 }), (picked) => {
          const command = picked.map(spell).join('\n');
          const { stdout, outcome } = probe(command);
          assert.equal(outcome, OUTCOME.EXITED, command);
          if (/aRAN/.test(stdout)) assert.notEqual(firstUnprovenMarker(command, MARKER), undefined, command);
        }),
        { numRuns: 30 },
      );
    });
  });
});
