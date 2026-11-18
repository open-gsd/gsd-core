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
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { oracleLines, runShellText } = require('./helpers/oracle-shell.cjs');
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
    for (const bad of ['echo "$(ls "@")"', 'echo "`ls "@"`"', 'echo "`echo \'@\'`"', 'cat <<EOF\n@\nEOF', 'cat <<<"@"', "cat <<'ab\n@'", "echo $'a' \"@\"", 'echo "${x:-\'a\'}" "@"', 'echo "${x:-"a"}" "@"', "echo \"${GSD_MARK#'@'}\""]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a double-quoted marker in the text eval, trap or sh -c parses again is refused, in each spelling of the consumer', () => {
    for (const bad of [
      'eval "@"', 'eval "test -e \\"@\\""', 'eval echo "@"', 'echo ok; eval "@"', 'trap "rm @" EXIT',
      'sh -c "echo @"', 'bash -c "echo @"', 'dash -c "echo @"', '/bin/sh -c "echo @"', 'sh -ec "echo @"', 'sh -ce "echo @"',
      'sh -o pipefail -c "echo @"', 'sh -c -e "echo @"', 'sh -c -- "echo @"', 'sh -c -o pipefail "echo @"', 'sh -c +e "echo @"', 'bash -ec +o errexit -O extglob "echo @"', 'sh -c "a-@"',
      // A group with an `o` or `O` takes one word per such letter (`-eo pipefail`, `-oe pipefail`, `-oo a b`); a long option (`--noprofile`) has none.
      'bash -eo pipefail -c "echo @"', 'bash -euo pipefail -c "echo @"', 'bash -xeuo pipefail -c "echo @"', 'bash -c -eo pipefail "echo @"', 'bash -oe pipefail -c "echo @"',
      'bash -oo pipefail errexit -c "echo @"', 'bash -ceo pipefail "echo @"', 'bash -Oe extglob -c "echo @"', 'bash --noprofile -c "echo @"', 'bash --noprofile -eo pipefail -c "echo @"',
      // The cluster has no length cap: 15, 16, 17 and 40 letters before the `c` are read alike.
      `sh -${'e'.repeat(15)}c "echo @"`, `sh -${'e'.repeat(16)}c "echo @"`, `sh -${'e'.repeat(17)}c "echo @"`, `sh -${'e'.repeat(40)}c "echo @"`, `sh -c${'e'.repeat(40)} "echo @"`,
      'printf x | xargs sh -c "echo @"', 'find . -exec sh -c "echo @" \\;', 'echo ok;sh -c "@"', '(sh -c "@")',
      // A quoted or escaped command name is still the command; `;` inside quotes does not end it.
      '"eval" "echo @"', "'eval' \"echo @\"", '\\eval "echo @"', '\\sh -c "echo @"', "'bash' -c \"echo @\"", '"sh" "-c" "echo @"', 'eval "a" "b;c" "@"',
      'echo ok\nsh -c "@"', 'FOO=1 eval "@"', 'sudo -n sh -c "@"',
      // The `&` of a redirection (`2>&1`, `>&2`, `&>`) does not end the command, so the consumer word still counts.
      'eval echo 2>&1 "@"', 'sh 2>&1 -c "test -e @"', 'trap 2>&1 "rm @" EXIT', 'eval echo >&2 "@"', 'eval echo &> /dev/null "@"', 'echo x >&2; eval "@"',
      // `>|`, `<(`, `>(` and `<&` are redirections too: the command goes on after them.
      'eval echo >| out "@"', 'eval echo <(true) "@"', 'eval echo >(cat) "@"', 'eval echo 0<&3 "@"', 'eval cat <&3 "@"',
      // The bounds of a letter in the cluster: `a`, `z`, `A` and `Z` are letters, so the `c` is read.
      'sh -ac "test -e @"', 'sh -zc "test -e @"', 'sh -Ac "test -e @"', 'sh -Zc "test -e @"', 'sh -Cc "test -e @"',
      // A redirection before `-c` is no option word and takes its target (`> out`, `2> file`, `< file`, `>| out`) as the next word.
      'sh > out -c "test -e @"', 'sh 2> /dev/null -c "test -e @"', 'sh < /dev/null -c "test -e @"', 'sh >| out -c "test -e @"',
      // Each shell prefix of SHELL_WORD (`ksh`, `zsh`, `ash`) is a consumer too.
      'ksh -c "echo @"', 'zsh -c "echo @"', 'ash -c "echo @"',
      // The command word follows `NAME=value` words (quoted value included) and the reserved words that start a command.
      'if true; then eval "@"; fi', '{ trap "@" EXIT; }', 'A="x y" eval "@"', 'A="" eval "@"', '! eval "@"', 'while true; do eval "@"; done', 'if eval "@"; then :; fi', 'time eval "@"',
      'if false; then :; elif eval "@"; then :; fi', 'if false; then :; else eval "@"; fi', 'until eval "@"; do :; done', 'while eval "@"; do :; done',
    ]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a cluster whose neighbour of a letter is `@` (the char before `A`) is no -c cluster', () => {
    // `@` is the placeholder of the other rows, so these two texts are written with the char code.
    const at = String.fromCharCode(64);
    for (const text of [`bash -c${at} "echo \${GSD_MARK}"`, `bash -${at}c "echo \${GSD_MARK}"`]) assert.equal(firstUnprovenMarker(text, MARKER), undefined, text);
  });
  test('a single-quoted marker is proven only as the script text of sh -c, eval or trap, and that text is checked on its own', () => {
    for (const ok of [
      "sh -c 'test -d \"@\"'", "bash -c 'test -d \"$GSD_MARK\"'", "sh -ec 'test -d \"@\"'", "eval 'test -d \"@\"'", "trap 'rm \"@\"' EXIT", "A=1 eval 'echo \"@\"'",
      "find . -exec sh -c 'test -d \"@\"' \\;", "printf x | xargs -0 sh -c 'test -d \"@\"'", "sh -c 'echo \"@\"; echo \"@\"'", "sh -c 'echo a' 'b'; sh -c 'echo \"@\"'",
    ]) {
      assert.equal(first(ok), undefined, ok);
    }
    for (const bad of [
      // The inner shell reads the text, so an unquoted or nested use in it is refused like one outside.
      "sh -c 'test -d @'", "eval 'test -d @'", "trap 'rm @' EXIT", "sh -c 'echo \"$(ls \"@\")\"'", "sh -c 'echo \"@\" | xargs ls'", "sh -c 'echo \"@\"' | xargs ls", "xargs sh -c 'test -d \"@\"'",
      // Not the script word, or not a consumer: the marker is dead text.
      "sh -c 'x' sh '@'", "sh script.sh '@'", "echo '@'", "eval true; echo '@'", "sh -c 'x'; echo '@'", "grep -q trap '@'",
      // Dead text is refused even when the quoted text itself double-quotes the marker.
      "echo '\"@\"'", "sh -c 'x' sh '\"@\"'", "sh script.sh '\"@\"'", "eval true; echo '\"@\"'",
    ]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
  });
  test('a double-quoted marker that no consumer parses again is proven, whatever the command', () => {
    const ok = [
      'echo -c x "@"', 'grep -c x "@"', 'test -d "@" -a -c "@"', 'sh script.sh "@"', 'sh -x "@"', 'echo eval; echo "@"', 'echo eval; test -d "@"',
      // The consumer ends at the command separator: a later command is read on its own.
      "trap 'rm -f tmp' EXIT; test -d \"@\"", 'sh build.sh && wc -c "@"', 'sh -c true; echo "@"', 'sh -c true\necho "@"', 'echo "@" | wc -c',
      // A `&` that is no redirection ends the command; a redirection before the separator leaves the next command on its own.
      'eval true && echo "@"', 'eval true & echo "@"', 'eval true 2>&1; echo "@"', 'echo x >&2; eval true; echo "@"', 'eval true <&3; echo "@"',
      // `eval` and `trap` are consumers only as the command word: as an argument they are plain words.
      'grep -q trap "@"', 'echo eval "@"', 'FOO=1 echo trap "@"', 'A="eval x" echo "@"', 'if true; then echo eval "@"; fi',
      // A `-c` after the script word belongs to the script; a neighbour of a letter in the cluster (`@`, `[`, backtick, `{`) is no letter, so no `-c` stands.
      'sh -c "a" -c "@"', 'bash scripts/check.sh -c "@"', 'bash -eo pipefail check.sh "@"', 'bash -oo pipefail errexit check.sh -c "@"', 'bash --noprofile -c "a" "@"', 'bash -c[ "echo @"', "bash '-c`' \"echo @\"", 'bash -c{ "echo @"', 'bash -[c "echo @"', "bash '-`c' \"echo @\"", 'bash -{c "echo @"',
      // `xargs` inside a word of a command that is no shell is no command word.
      'grep -q "xargs rm" "@"', 'sh -c; echo "@"',
      // An empty word is a word: the empty script of `sh -c "" "@"` makes the value `$0`, and `"" eval "@"` runs the command `""`, not `eval`.
      'sh -c "" "@"', '"" eval "@"', "sh -c '' \"@\"",
      // A value passed as a later argument is never parsed again.
      "sh -c 'echo \"$1\"' sh \"@\"", "sh -ec 'echo \"$1\"' sh \"@\"", "bash -c 'echo \"$1\"' bash \"@\" \"@\"",
      "find . -exec sh -c 'echo \"$1\"' sh \"@\" \\;", "printf x | xargs -0 sh -c 'echo \"$1\"' sh \"@\"", "d=\"@\"; eval 'echo \"$d\"'", "d=\"@\"; trap 'echo \"$d\"' EXIT",
    ];
    for (const text of ok) assert.equal(first(text), undefined, text);
  });
  test('a command that runs xargs without -0 or -d is refused for any marker, before or after it', () => {
    for (const bad of [
      'echo "@" | xargs ls', 'xargs ls < "@"', 'xargs -n1 echo "@"', 'echo "@" | xargs -I{} ls {}',
      // `-d` of `test` and `-0` of another command are no delimiter option of xargs.
      'test -d "@" && echo "@" | xargs ls', 'echo "@" | xargs ls -0', 'echo "@" | sort -d | xargs ls', '"xargs" ls "@"', 'echo "@" | xargs ls; echo "@" | xargs -0 ls',
      // A path spells the command word as it does for `sh -c`.
      'echo "@" | /usr/bin/xargs ls',
      // An option group without `0` or `d`, and the argument word of `-n`, `-P`, `-I`, `-L` or `-s`, is no delimiter.
      'echo "@" | xargs -r ls', 'echo "@" | xargs -n 10 ls', 'echo "@" | xargs -n10 ls', 'echo "@" | xargs -P 0 ls', 'echo "@" | xargs -s 0 ls', 'echo "@" | xargs -I d ls d', 'echo "@" | xargs --max-args 0 ls', 'echo "@" | xargs -rt ls',
      // `--replace` and `--eof` take their argument only after `=`, so the next word is the command, not an argument.
      // Every short and long option of the argument tables takes its argument: `-ed` is the EOF string `d`, not a delimiter.
      'echo "@" | xargs -ed ls', 'echo "@" | xargs -id ls', 'echo "@" | xargs -ld ls', 'echo "@" | xargs -L 1 ls', 'echo "@" | xargs -E x ls', 'echo "@" | xargs -a f ls',
      'echo "@" | xargs --max-procs 2 ls', 'echo "@" | xargs --max-lines 1 ls', 'echo "@" | xargs --max-chars 9 ls', 'echo "@" | xargs --arg-file f ls',
      // `--` ends the option words: the `-0` after it is the command, not a delimiter option.
      'echo "@" | xargs -- ls', 'echo "@" | xargs -- -0',
      'echo "@" | xargs --replace ls -0', 'echo "@" | xargs --eof ls -0', 'echo "@" | xargs --process-slot-var V ls -0',
      // `xargs` is the command word after a separator or a reserved word, and after `NAME=value` words.
      'echo a; xargs ls "@"', 'if true; then xargs ls "@"; fi', 'A="x y" xargs ls "@"', 'echo a | xargs ls "@"',
      // The script word of `sh -c` is text too: the value passed as `$1` reaches the `xargs` inside it.
      "sh -c 'echo \"$1\" | xargs ls' sh \"@\"", "bash -c 'echo \"$1\" | xargs -n 1 ls' bash \"@\"",
    ]) {
      assert.equal(first(bad), 'GSD_MARK', bad);
    }
    for (const ok of ['echo "@" | xargs -0 ls', 'echo "@" | xargs -d x ls', 'echo "@" | xargs -dx ls', 'echo "@" | xargs --null ls', 'echo "@" | xargs --delimiter=x ls', 'echo "@" | /usr/bin/xargs -0 ls', 'echo "@"; find . -delete', 'echo "@" xargsx',
      // `xargs` as an argument or inside a quoted word is no command word.
      'grep -q xargs "@"', 'echo "uses xargs" "@"', 'echo "@" | xargs -0 -- ls', "sh -c 'echo \"$1\" | xargs -0 ls' sh \"@\"",
      // A null or custom delimiter inside an option group, or after an option that takes an argument.
      'echo "@" | xargs -0r ls', 'echo "@" | xargs -r0 ls', 'echo "@" | xargs -n 1 -0 ls', 'echo "@" | xargs -s 100 -0 ls', 'echo "@" | xargs -n1 -0 ls', 'echo "@" | xargs -P 4 -I {} -0 ls', 'echo "@" | xargs -rd x ls', 'echo "@" | xargs -t --null ls', 'echo "@" | xargs --process-slot-var V -0 ls', 'echo "@" | xargs --max-args 1 --null ls',
      // The argument of each table option is skipped, so the `-0` after it is the delimiter.
      'echo "@" | xargs -L 1 -0 ls', 'echo "@" | xargs -E x -0 ls', 'echo "@" | xargs -a /dev/null -0 ls', 'echo "@" | xargs --max-procs 2 -0 ls', 'echo "@" | xargs --max-lines 1 -0 ls', 'echo "@" | xargs --max-chars 99999 -0 ls', 'echo "@" | xargs --arg-file /dev/null -0 ls']) {
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
  test('a backslash-newline pair is deleted after an odd run of backslashes only: the real shell and the scan agree', () => {
    // 0 to 3 backslashes before the newline, then one row where a deleted pair is followed by an even run.
    const ROWS = [
      ['a\n#b', ['a', ''], 'GSD_MARK'],
      ['a\\\n#b', ['a#b', ''], undefined],
      ['a\\\\\n#b', ['a\\', ''], 'GSD_MARK'],
      ['a\\\\\\\n#b', ['a\\#b', ''], undefined],
      ['a\\\n\\\\\n#b', ['a\\', ''], 'GSD_MARK'],
    ];
    const env = isolatedEnv({ home: os.tmpdir() });
    for (const [text, printed, refused] of ROWS) {
      assert.deepStrictEqual(oracleLines(`printf '%s\\n' ${text}`, { interpreter: 'bash', env }), printed, JSON.stringify(text));
      assert.equal(first(`echo ${text} "@"`), refused, JSON.stringify(text));
    }
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
      'echo it\\\'s "@"', 'echo "a\\"b @"', "echo a#b '@'", "echo x;# it's @", "cat <<'a\\b'\n@\na\\b",
      "cat <<EOF\n\tEOF\nit's @\nEOF", "cat <<EOF # it's\nbody it's @\nEOF", "echo '\\' '@'", 'echo ${x:-\'@\'}', 'echo "${x%% #*}" \'@\'',
      "echo $(:)#'@'", "(:)# it's @", 'echo "$(echo $((1)))" \'@\'',
      'echo \\@', 'echo "\\@"', 'echo "$$@"', 'echo "${GSD_MARK#\'@\'}"', 'echo ">#@"', 'echo "a"\'@\'', 'echo "$(echo "@")"',
      'echo "$\\\n(echo \'@\')"', "cat <\\\n<'EOF'\n\"@\"\nEOF",
    ];
    const env = isolatedEnv({ home: os.tmpdir(), override: { GSD_MARK: 'SENT' } });
    const probe = (command) => runShellText(command, { interpreter: 'bash', env });
    test('each fragment runs clean in the oracle shell, so no combination is silenced by a syntax error', () => {
      const failed = FRAGMENTS.filter((text) => probe(text.replaceAll('@', '${GSD_MARK}')).exitCode !== 0);
      assert.deepStrictEqual(failed, []);
    });
    test('each fragment also runs inside the oracle wrapper, so no draw of the property throws', () => {
      // A here-document that never ends would swallow the wrapper's closing brace; that is a failed oracle shell.
      const broken = FRAGMENTS.filter((text) => {
        try { oracleLines(text.replaceAll('@', '${GSD_MARK}'), { interpreter: 'bash', env }); return false; } catch { return true; }
      });
      assert.deepStrictEqual(broken, []);
    });
    test('a fragment that breaks the wrapper is a failed oracle shell, not a JSON error', () => {
      assert.throws(() => oracleLines("cat <<'ab\n${GSD_MARK}'", { interpreter: 'bash', env }), /oracle shell failed/);
      assert.throws(() => oracleLines('if', { interpreter: 'bash', env }), /oracle shell failed/);
    });
    test('a shell that cannot start is a failed oracle shell, not an empty answer', () => {
      assert.throws(() => oracleLines('echo x', { interpreter: 'gsd-no-such-shell', env }), /oracle shell failed/);
    });
    test('the oracle returns the output of a command that exits non-zero, and the text byte-exact', () => {
      assert.deepStrictEqual(oracleLines('echo a; false', { interpreter: 'bash', env }), ['a', '']);
      assert.deepStrictEqual(oracleLines("printf '%s\\n' a\\\\\n#b", { interpreter: 'bash', env }), ['a\\', '']);
    });
    test('the oracle prints a literal marker by name and an expanded one by value', () => {
      assert.deepStrictEqual(oracleLines("echo '${GSD_MARK}'", { interpreter: 'bash', env }), ['${GSD_MARK}', '']);
      assert.deepStrictEqual(oracleLines('echo "${GSD_MARK}"', { interpreter: 'bash', env }), ['SENT', '']);
    });
    test('every combination with a literal marker is refused', () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 5 }), (picked) => {
          const command = picked.map((text) => text.replaceAll('@', '${GSD_MARK}')).join('\n');
          // A marker that is only a plain expanded value prints what its value would: the same command with 'SENT' written out.
          const written = command.replaceAll('${GSD_MARK}', 'SENT');
          if (!isDeepStrictEqual(oracleLines(command, { interpreter: 'bash', env }), oracleLines(written, { interpreter: 'bash', env }))) assert.notEqual(firstUnprovenMarker(command, MARKER), undefined, command);
        }),
        // Two oracle shells per run (the command and its written-out form), each a bash process: a small count.
        { numRuns: 30 },
      );
    });
  });

  describe('property: no marker that a consumer runs as code is accepted', () => {
    // The marker's value is `a$(echo RAN)`. A shell that only expands it prints that text; one that parses it
    // again runs the substitution and prints `aRAN`. The real shell is the oracle, as in the property above.
    const CONSUMERS = [
      'eval "echo @"', 'eval "echo \\"@\\""', 'sh -c "echo @"', 'bash -c "echo @"', 'sh -ec "echo @"', 'sh -o pipefail -c "echo @"',
      'bash -eo pipefail -c "echo @"', 'bash -c -eo pipefail "echo @"', 'bash -oo pipefail errexit -c "echo @"',
      'trap "echo @" EXIT', 'echo x | xargs sh -c "echo @"', 'find . -prune -exec sh -c "echo @" \\;', 'echo x | xargs -0 sh -c "echo @"',
    ];
    const SAFE = ['echo "@"', "sh -c 'echo \"$1\"' sh \"@\"", 'd="@"; eval \'echo "$d"\'', 'd="@"; trap \'echo "$d"\' EXIT', 'echo "@" | xargs -0 echo', "find . -prune -exec sh -c 'echo \"$1\"' sh \"@\" \\;"];
    const env = isolatedEnv({ home: os.tmpdir(), override: { GSD_MARK: 'a$(echo RAN)' } });
    const spell = (text) => text.replaceAll('@', '${GSD_MARK}');

    test('the oracle runs the value from each consumer row and only expands it from each safe row', () => {
      const ran = (text) => oracleLines(spell(text), { interpreter: 'bash', env }).includes('aRAN');
      for (const text of CONSUMERS) assert.equal(ran(text), true, text);
      for (const text of SAFE) assert.equal(ran(text), false, text);
    });
    test('each consumer row is refused and each safe row is accepted', () => {
      for (const text of CONSUMERS) assert.notEqual(firstUnprovenMarker(spell(text), MARKER), undefined, text);
      for (const text of SAFE) assert.equal(firstUnprovenMarker(spell(text), MARKER), undefined, text);
    });
    test('every combination whose run executes the value is refused', () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...CONSUMERS, ...SAFE), { minLength: 1, maxLength: 4 }), (picked) => {
          const command = picked.map(spell).join('\n');
          if (oracleLines(command, { interpreter: 'bash', env }).includes('aRAN')) assert.notEqual(firstUnprovenMarker(command, MARKER), undefined, command);
        }),
        { numRuns: 30 },
      );
    });
  });
});
