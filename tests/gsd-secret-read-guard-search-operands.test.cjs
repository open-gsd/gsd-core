'use strict';

/**
 * gsd-secret-read-guard.js — pattern, exclusion and program operands (#5884)
 *
 * Seam: hooks/gsd-secret-read-guard.js, spawned with a PreToolUse JSON payload
 * on stdin. A search pattern, the value of an exclusion option and a jq program
 * are names or code, never files the command opens, so a secret-looking value
 * in one of those positions is allowed. Every operand the command does open is
 * still checked, and an option the guard does not know withdraws the carve-out
 * for the whole segment.
 *
 * Every assertion reads typed fields off the stdout JSON — never a regex over
 * the reason prose (CONTRIBUTING.md).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-secret-read-guard.js');

function runHook(payload) {
  const r = runHookSeam(HOOK_PATH, [], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout };
}

const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

const PROPERTY_RUNS = { seed: 5884, numRuns: 40 };

function assertAllowed(command) {
  const r = runHook(bash(command));
  assert.equal(r.status, 0, `${command}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${command}: an allow must emit nothing on stdout`);
}

function assertBlocked(command) {
  const r = runHook(bash(command));
  assert.equal(r.status, 2, `${command}: expected block (exit 2), got exit ${r.status}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', command);
  assert.equal(out.code, 'secret-read', `${command}: code`);
}

describe('gsd-secret-read-guard: pattern, exclusion and program operands (#5884)', () => {
  const allows = [
    // G4: the first positional of the grep family is the pattern.
    "grep -n 'packages/db/.env.local' src/setup.ts",
    "egrep -n 'a|.env.local' src/setup.ts",
    "fgrep -n '.env.local' src/setup.ts",
    'grep -n "packages/db/config.local" src/setup.ts',
    // A value-taking option before the pattern must be skipped, not mistaken for it.
    "grep -m 1 '.env.local' f",
    "grep -A 2 -n '.env.local' f",
    // G5: the value of an exclusion option is a name to skip.
    'grep -rn -i token . --exclude=.env',
    'grep -rn -i --exclude .env token .',
    'grep -rn token . --exclude-dir=.env --exclude=.env.local',
    // G6 (maintainer decision on #5884): the jq program is not a file.
    "jq '.env.DISABLE_AUTOUPDATER' settings.json",
    "jq '.env' file.json",
    "jq -r '.env' file.json",
    "jq -n '.env.X'",
    "jq -rc '.env' file.json",
    // ripgrep: a NEGATED --glob / -g / --iglob value and the pattern positional.
    "rg -g '!.env' token .",
    "rg --glob='!.env' token .",
    "rg --iglob '!.env.local' token .",
    "rg '.env.local' src",
  ];
  for (const cmd of allows) {
    test(`allows ${JSON.stringify(cmd)}`, () => assertAllowed(cmd));
  }

  const blocks = [
    // A real read remains in the segment.
    'grep -rn token . --exclude=.env .env.local',
    // A separate exclusion value after the first positional is a file under
    // POSIXLY_CORRECT, which the agent's environment may export (#6282).
    'grep -rn -i token . --exclude .env',
    'grep pat .env',
    "grep '.env.local' .env",
    'grep KEY .env.local',
    // A pattern file is read: these were deny rows before and stay deny rows.
    'grep -f .env x',
    'grep -f.env pat f',
    'grep -if.env pat f',
    'grep -nif.env pat f',
    'grep -2f.env pat f',
    'grep -2.env pat f',
    'grep --file=.env x',
    'grep --file .env x',
    'rg -f .env x',
    'egrep -f .env x',
    // -e / --regexp supplies the pattern, so the first positional is a file.
    'grep -e pat .env',
    'grep --regexp=pat .env',
    'rg -e pat .env',
    // rg's -r takes a replacement value, so the word after it is not the pattern.
    "rg -r '.env' src",
    // An unknown option withdraws the carve-out for the segment. `-C` is one:
    // BSD grep's optional number would make `.env` a file there.
    'grep -C 3 .env',
    'grep --context 3 .env',
    'grep --frob .env x',
    'grep -Y .env x',
    'rg --frob token .env',
    // A selector READS the file it names: `--include` and a non-negated glob
    // restrict the search to `.env`, so the value is an ordinary operand.
    "grep -rn '' . --include=.env",
    'grep -rn token --include .env.local .',
    'grep -rn token . --include-dir=.env',
    "rg -g .env '' .",
    "rg -g.env '' .",
    "rg --glob=.env '' .",
    "rg --glob .env '' .",
    'rg --iglob .env token .',
    // exclude-from reads the file.
    'grep --exclude-from=.env pat f',
    'grep --exclude-from .env pat f',
    // jq: file operands, program files and file-valued options stay checked.
    'jq . .env',
    'jq -f .env',
    'jq --from-file .env',
    "jq --slurpfile v .env '.'",
    "jq --rawfile v .env '.'",
    "jq -n --arg x .env '.'",
    "jq '.env' .env",
    // xargs keeps no carve-out (#6282): stdin words can change what a word is.
    'ls | xargs grep -n token --exclude=.env',
    'xargs grep token --exclude=.env .env.local',
    'xargs cp src .env',
  ];
  for (const cmd of blocks) {
    test(`still blocks ${JSON.stringify(cmd)}`, () => assertBlocked(cmd));
  }

  const NAME = fc.constantFrom('.env', '.env.local', '.secrets', 'config/.env.production');
  const EXCLUDE_OPT = fc.constantFrom('--exclude', '--exclude-dir');
  const FORM = fc.constantFrom('=', ' ');
  const SAFE_FLAGS = fc.constantFrom('', '-r ', '-n ', '-rn ', '-i ', '-m 1 ', '-A 2 ');

  test('property: an exclusion value is a name; a real read after it is still blocked', () => {
    fc.assert(fc.property(EXCLUDE_OPT, FORM, NAME, SAFE_FLAGS, (opt, form, name, flags) => {
      // A separate value after the first positional is a file under POSIXLY_CORRECT (#6282).
      if (form === '=') assertAllowed(`grep ${flags}token . ${opt}${form}${name}`);
      else assertBlocked(`grep ${flags}token . ${opt}${form}${name}`);
      assertAllowed(`grep ${flags}${opt}${form}${name} token .`);
      assertBlocked(`grep ${flags}token . ${opt}${form}${name} .env`);
      assertBlocked(`grep ${flags}token ${opt}${form}${name} ${name}`);
    }), PROPERTY_RUNS);
  });

  test('property: the pattern positional is exempt only while no option supplies the pattern', () => {
    fc.assert(fc.property(NAME, SAFE_FLAGS, fc.constantFrom('grep', 'egrep', 'fgrep', 'rg'), (name, flags, tool) => {
      // rg's `-r` takes a replacement VALUE (grep's means recursive), so the
      // quoted word after it is that value and stays checked.
      const safe = tool === 'rg' ? flags.replace(/-rn? /, '') : flags;
      assertAllowed(`${tool} ${safe}'${name}' src`);
      assertBlocked(`${tool} ${safe}'${name}' ${name}`);
      assertBlocked(`${tool} ${safe}-e pat ${name}`);
    }), PROPERTY_RUNS);
  });

  test('property: a jq program is exempt, every file operand is not', () => {
    fc.assert(fc.property(NAME, fc.constantFrom('', '-r ', '-n ', '-rc '), (name, flags) => {
      assertAllowed(`jq ${flags}'.env.X' file.json`);
      assertBlocked(`jq ${flags}'.x' ${name}`);
    }), PROPERTY_RUNS);
  });
});

// #6282: words xargs takes from stdin or an arg file can be options. `-e KEY` or
// `-f pats` makes the first positional a file, and a replace string can turn an
// exclusion value into an option's value (`-I--exclude=` gives `grep -f.env`).
// The guard cannot see those words, so a search tool run by xargs keeps no
// carve-out.
describe('gsd-secret-read-guard: a search tool run by xargs keeps no carve-out (#6282)', () => {
  function assertBlockedOn(command) {
    const r = runHook(bash(command));
    assert.equal(r.status, 2, `${command}: expected block (exit 2), got exit ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', command);
    assert.equal(out.code, 'secret-read', `${command}: code`);
    assert.equal(out.tool, 'Bash', `${command}: tool`);
    return out;
  }

  const blocks = [
    // The issue's rows: stdin or an arg file supplies the pattern.
    ["echo '-e KEY' | xargs grep .env", '.env'],
    ["echo '-f pats' | xargs grep .env", '.env'],
    ["echo '-e KEY' | xargs rg .env", '.env'],
    ['xargs -a list grep .env', '.env'],
    ['ls | xargs --arg-file list grep .env', '.env'],
    ['ls | xargs --arg-file=list grep .env', '.env'],
    ["echo '-e KEY' | xargs egrep .env", '.env'],
    ["echo '-e KEY' | xargs fgrep .env", '.env'],
    // A replace string puts stdin words anywhere, `--` included.
    ["echo '-eKEY' | xargs -I-- grep -- .env", '.env'],
    ["echo '-eKEY' | xargs -rI-- grep -- .env", '.env'],
    ["echo '-eKEY' | xargs --rep=-- grep -- .env", '.env'],
    ["echo '-eKEY' | xargs -J-- grep -- .env", '.env'],
    // ... and can turn an exclusion value into another option's value.
    ["echo '-f' | xargs -I--exclude= grep --exclude=.env KEY", '--exclude=.env'],
    ["echo '-f' | xargs -I--exclude grep --exclude .env KEY", '.env'],
    ["echo x | xargs egrep KEY --exclude=.env", '--exclude=.env'],
    ["echo x | xargs fgrep KEY --exclude=.env", '--exclude=.env'],
    ["echo x | xargs rg -g '!dir/.env' KEY", '!dir/.env'],
    ["echo x | xargs rg KEY . --glob '!dir/.env'", '!dir/.env'],
    ["echo x | xargs rg -- '.env'", '.env'],
    // jq: stdin can supply `-f`, which makes the program word a file.
    ["echo '-f' | xargs jq '.env'", '.env'],
    ["echo x | xargs jq -- '.env'", '.env'],
    // The replace string in each form xargs accepts fills the script with words the guard does not see: a
    // cluster, an abbreviation, BSD -J attached or not, the last of two, from an arg file too.
    ["cat list | xargs -tI{} sh -c 'grep .env {}'", '.env'],
    ["cat list | xargs -0 -I{} sh -c 'grep .env {}'", '.env'],
    ["cat list | xargs --rep sh -c 'grep .env {}'", '.env'],
    ["cat list | xargs --replace=@@ sh -c 'grep .env @@'", '.env'],
    ["cat list | xargs -i@@ sh -c 'grep .env @@'", '.env'],
    ["cat list | xargs -J % sh -c 'grep .env %'", '.env'],
    ["cat list | xargs -J% sh -c 'grep .env %'", '.env'],
    ["cat list | xargs -rJ % sh -c 'grep .env %'", '.env'],
    ["cat list | xargs -I{} -I@@ sh -c 'grep .env @@'", '.env'],
    ["xargs -a list -tI{} sh -c 'grep .env {}'", '.env'],
    // A launcher run by xargs gets the words xargs adds, or a replace string, in its script.
    ["echo '-e KEY' | xargs watch 'grep .env'", '.env'],
    ["cat list | xargs -I{} watch 'grep .env {}'", '.env'],
    // At the nesting limit xargs's sub-command is not rescanned, so xargs's own words are all that is checked.
    ['eval "eval \'eval \\"ls | xargs egrep .env\\"\'"', '.env'],
    ['eval "eval \'eval \\"ls | xargs fgrep .env\\"\'"', '.env'],
    ['eval "eval \'eval \\"xargs --arg-file list grep .env\\"\'"', '.env'],
    ['eval "eval \'eval \\"xargs --arg-file=list grep .env\\"\'"', '.env'],
    ['eval "eval \'eval \\"ls | xargs grep KEY --exclude=.env\\"\'"', '--exclude=.env'],
    ['eval "eval \'eval \\"ls | xargs rg .env\\"\'"', '.env'],
    ['eval "eval \'eval \\"ls | xargs rg -g !dir/.env KEY\\"\'"', '!dir/.env'],
    ['eval "eval \'eval \\"ls | xargs jq .env\\"\'"', '.env'],
  ];
  for (const [cmd, file] of blocks) {
    test(`blocks ${JSON.stringify(cmd)}`, () => assert.equal(assertBlockedOn(cmd).path, file, `${cmd}: path`));
  }

  test('allows a search tool run by xargs with no protected name in its words', () => {
    assertAllowed('echo x | xargs grep KEY');
    assertAllowed('git ls-files | xargs grep -l KEY');
    assertAllowed("find . -name '*.ts' | xargs rg -n token");
  });

  test('the carve-out outside xargs is unchanged (#5884)', () => {
    assertAllowed("grep -n '.env.local' src/setup.ts");
    assertAllowed('grep -rn token . --exclude=.env');
    assertAllowed("rg -g '!.env' token .");
    assertBlockedOn('grep .env -e KEY');
  });

  test('property: a protected name among the words of a search tool run by xargs is blocked, and no other name is', () => {
    const NAME = fc.constantFrom('.env', '.env.local', '.secrets', 'config/.env.production');
    // Each tool's own slots: jq has no exclusion option, and rg's is a negated glob, path-qualified so it names the
    // protected file (a bare `!.env` names `!.env`).
    const TOOL_SLOT = fc.constantFrom(
      ...['grep', 'egrep', 'fgrep', 'rg'].flatMap((tool) => ['pattern', 'exclusion', 'after --'].map((slot) => [tool, slot])),
      ['jq', 'pattern'], ['jq', 'after --'],
    );
    const XARGS_FLAGS = fc.constantFrom(
      '', '-r ', '-0 ', '-n 1 ', '-I{} ', '-I {} ', '-tI{} ', '-I-- ', '-IX ', '--rep ', '-i ', '-J % ', '-a list ',
      '--arg-file list ', '--arg-file=list ', '-d x ', '--delimiter x ', '-s 99 ', '-E END ', '-L 1 ', '-l ',
      '-P 2 ', '--max-args 1 ',
    );
    const STDIN = fc.constantFrom('echo x', "echo '-e K'", "printf '%s\\n' -f");
    // The word each slot puts the name in, and the word a block names: the exclusion option's whole word for grep.
    const wordsFor = (tool, slot, name) => {
      if (slot === 'after --') return { words: `-- '${name}'`, named: name };
      if (slot === 'pattern') return { words: `'${name}'`, named: name };
      if (tool === 'rg') return { words: `-g '!dir/${name}' KEY`, named: `!dir/${name}` };
      return { words: `--exclude=${name} KEY`, named: `--exclude=${name}` };
    };
    const BENIGN = fc.constantFrom('notes.txt', 'src/app.ts', '.env.example');
    fc.assert(fc.property(NAME, BENIGN, TOOL_SLOT, XARGS_FLAGS, STDIN, (name, benign, [tool, slot], xargsFlags, stdin) => {
      const secret = wordsFor(tool, slot, name);
      const out = assertBlockedOn(`${stdin} | xargs ${xargsFlags}${tool} ${secret.words}`);
      assert.equal(out.path, secret.named, `${stdin} | xargs ${xargsFlags}${tool} ${secret.words}: path`);
      // Allow-side oracle: the same command naming no protected file is allowed, except that an arg file is a
      // source of words the guard cannot read, which a search tool would read as files.
      const plain = `${stdin} | xargs ${xargsFlags}${tool} ${wordsFor(tool, slot, benign).words}`;
      if (!/-a |--arg-file/.test(xargsFlags)) return assertAllowed(plain);
      const r = runHook(bash(plain));
      assert.equal(r.status, 2, `${plain}: an arg file blocks`);
      assert.deepEqual([JSON.parse(r.stdout).code, JSON.parse(r.stdout).path], ['xargs-input-unseen', 'list'], plain);
    }), { ...PROPERTY_RUNS, numRuns: 300 });
  });
});

// #6282, Major 1 of the review: the carve-out also rests on seeing every word the tool gets. An expansion the guard
// does not perform (`"$@"`, `$1`, `$X`, `$( )`, backticks, zsh's `$=X`), a glob, brace or tilde the shell expands,
// or a variable that changes how the tool parses its words, can hand it `-e KEY` and turn the pattern into a file.
// Each row exits 0 on `next`.
describe('gsd-secret-read-guard: a search tool keeps no carve-out when a word may expand unseen (#6282)', () => {
  function assertBlockedOn(command, file) {
    const r = runHook(bash(command));
    assert.equal(r.status, 2, `${command}: expected block (exit 2), got exit ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', command);
    assert.equal(out.code, 'secret-read', `${command}: code`);
    assert.equal(out.tool, 'Bash', `${command}: tool`);
    assert.equal(out.path, file, `${command}: path`);
  }

  const blocks = [
    // The review's four forms: a nested script's positional parameters carry words xargs or the caller supplies.
    ["echo '-e KEY' | xargs sh -c 'grep .env \"$@\"' _", '.env'],
    ["sh -c 'grep .env \"$@\"' _ -e KEY", '.env'],
    ["bash -c 'grep .env \"$@\"' _ -e KEY", '.env'],
    ["sh -c 'grep .env $1 $2' _ -e KEY", '.env'],
    // The same words from a variable, a substitution, a function's arguments.
    ["X='-e K'; grep .env $X", '.env'],
    ['grep .env $(printf -- "-e KEY")', '.env'],
    ['grep .env `printf -- -e` KEY', '.env'],
    ['f() { grep .env "$@"; }; f -e KEY', '.env'],
    ['grep .env "x$*"', '.env'],
    // A line continuation the nested shell removes: `"$\<newline>@"` is `"$@"`.
    ["sh -c 'grep .env \"$\\\n@\"' _ -e KEY", '.env'],
    // zsh's word-splitting, glob and rc-expansion forms, and a NUL cut before one (zsh's reading).
    ['grep .env $=X', '.env'],
    ['grep .env $~X', '.env'],
    ['grep .env $^X', '.env'],
    ["grep .env $'x\\0'$=X", '.env'],
    // Every rescan inherits the withdrawal, two hops deep, and a body that lost its substitution keeps it.
    ['sh -c "grep .env $(printf -- -e) KEY"', '.env'],
    ['eval "grep .env $(printf -- -e) KEY"', '.env'],
    ['eval grep .env $(printf -- -e) KEY', '.env'],
    ['bash <<< "grep .env $(printf -- -e) KEY"', '.env'],
    ['watch "grep .env $(printf -- -e) KEY"', '.env'],
    ['echo "grep .env $(printf -- -e) KEY" | bash', '.env'],
    ['bash <(echo "grep .env $(printf -- -e) KEY")', '.env'],
    ['source <(echo "grep .env $(printf -- -e) KEY")', '.env'],
    ['git -c alias.x="!grep .env $(printf -- -e) KEY" x', '.env'],
    ['sh -c "eval \'grep .env $(printf -- -e) KEY\'"', '.env'],
    // A substitution before a redirect's digit leaves no word behind (`$( )0<` is fd 0).
    ["grep .env $(printf -- '-eKEY ')0</dev/null", '.env'],
    ["grep .env `printf -- '-eKEY '`0</dev/null", '.env'],
    // A variable that changes the tool's option parsing, however it is set.
    ["GREP_OPTIONS='-e KEY' grep .env", '.env'],
    ["env GREP_OPTIONS='-e KEY' grep .env", '.env'],
    ["export GREP_OPTIONS='-e KEY'; grep .env", '.env'],
    ["declare -x GREP_OPTIONS='-e KEY'; grep .env", '.env'],
    ['RIPGREP_CONFIG_PATH=cfg rg .env', '.env'],
    ['env RIPGREP_CONFIG_PATH=cfg rg .env', '.env'],
    ['export RIPGREP_CONFIG_PATH=cfg; rg .env', '.env'],
    ['declare -x RIPGREP_CONFIG_PATH=cfg; rg .env', '.env'],
    ['POSIXLY_CORRECT=1 grep -n KEY . --exclude=.env', '--exclude=.env'],
    ['env POSIXLY_CORRECT=1 grep -n KEY . --exclude=.env', '--exclude=.env'],
    ['export POSIXLY_CORRECT=1; grep -n KEY . --exclude=.env', '--exclude=.env'],
    ['declare -x POSIXLY_CORRECT=1; grep -n KEY . --exclude=.env', '--exclude=.env'],
    // ... spelled with quotes or backslashes inside the name, through eval too, built by braces, or decoded.
    ["env RIPGREP_CONFIG''_PATH=cfg rg .env", '.env'],
    ["export GREP_OPT\\IONS='-e KEY'; grep .env", '.env'],
    ['eval \'export GREP_OPT""IONS=-eKEY\'; grep .env', '.env'],
    ['export GREP_OPT{X,I}ONS=-eKEY; grep .env', '.env'],
    ['export GREP_OPT{H..J}ONS=-eKEY; grep .env', '.env'],
    ["export $'\\x47REP_OPTIONS=-eKEY'; grep .env", '.env'],
    ["eval $'export \\x47REP_OPTIONS=-eKEY'; grep .env", '.env'],
    // ... or by a glob, from a file named `GREP_OPTIONS=-eKEY` in the working directory, in a word that sets a
    // variable, also in a body eval or source runs, and in a word the shell splits off it.
    ['export GREP_O*; grep .env', '.env'],
    ['export GREP_O?TIONS=-eKEY; grep .env', '.env'],
    ['export GREP_[O]PTIONS=-eKEY; grep .env', '.env'],
    ['export RIPGREP_C*; rg .env', '.env'],
    ['export POSIXLY_C*; grep -n KEY . --exclude=.env', '--exclude=.env'],
    ['declare -x GREP_O*; grep .env', '.env'],
    ['export GREP_{O*,x}; grep .env', '.env'],
    ["eval 'export GREP_O*'; grep .env", '.env'],
    ['eval "export GREP_O?TIONS=-eKEY"; grep .env', '.env'],
    ["source <(echo 'export GREP_O*'); grep .env", '.env'],
    ["export 'a;' GREP_O*; grep .env", '.env'],
    // An alias can hand the tool words too, wherever the command defines it (`alias` is the trigger, #6282 Nit 1).
    ["alias grep='grep -eKEY'; grep .env", '.env'],
    ["grep .env; alias grep='grep -eKEY'", '.env'],
    ["al''ias grep='grep -eKEY'\ngrep .env", '.env'],
    // A leading glob, brace or tilde can become an option (a file named `-eKEY`, HOME=-eKEY) ...
    ['grep .env *', '.env'],
    ['grep .env {-e,KEY}', '.env'],
    ['HOME=-eKEY; grep .env ~', '.env'],
    ["grep .env ''*", '.env'],
    ['grep .env ""{-e,KEY}', '.env'],
    // ... and one at or before an exempt word can add or remove words ahead of it.
    ['grep --label .* .env', '.env'],
    ['grep --exclude .{,.} .env', '.env'],
    ["jq -R -L .{,.} '.env'", '.env'],
    ['rg -m 9{,.} .env', '.env'],
    // POSIXLY_CORRECT inherited from the environment: a separate exclusion value after the first positional is a file.
    ['POSIXLY_CORRECT=1 grep -n KEY . --exclude .env', '.env'],
    ['grep -n KEY . --exclude .env', '.env'],
    ["rg KEY . -g '!dir/.env'", '!dir/.env'],
    ["rg KEY . --glob '!dir/.env'", '!dir/.env'],
    // A replace string (xargs) or `{}` (find) fills a script with words the guard does not see, from a pipe, an
    // arg file or a redirect alike.
    ["cat list | xargs -I{} sh -c 'grep .env {}'", '.env'],
    ["cat list | xargs -I@@ sh -c 'grep .env @@'", '.env'],
    ["xargs -a list -I@@ sh -c 'grep .env @@'", '.env'],
    ["xargs --arg-file=list -I{} sh -c 'grep .env {}'", '.env'],
    ["xargs -I{} sh -c 'grep .env {}' < list", '.env'],
    ["cat list | xargs -I{} -- sh -c 'grep .env {}'", '.env'],
    ["find -- -eKEY -exec sh -c 'grep .env {}' \\;", '.env'],
    ["find . -execdir sh -c 'grep .env {}' \\;", '.env'],
    ["find . -exec watch 'grep .env {}' \\;", '.env'],
    // A `$` after the search tool keeps the withdrawal wherever words may run again or the quoting is not plain: a
    // function or alias the command defines later, a loop, `set --`, a `'` in a comment or heredoc body, `$( )`,
    // and a grouping brace, which does not end the tool's words.
    ['grep .env; grep() { command grep -eKEY "$@"; }', '.env'],
    ['for i in 1 2; do :; grep .env; export $V; done', '.env'],
    ['set -- -eKEY; grep .env; echo $1', '.env'],
    ['X=-eKEY; : "\'"; grep .env $X; : "\'"', '.env'],
    ["grep -rn x --exclude=.env . # it's\necho $X", '--exclude=.env'],
    ["grep -rn x --exclude=.env . <<EOF\nit's\nEOF\necho $X", '--exclude=.env'],
    ['grep -rn x --exclude=.env .; echo $(date)', '--exclude=.env'],
    // eval, source, `.` and a process substitution read their text again, so a quote here does not keep a `$` literal.
    ["grep -rn x --exclude=.env . ; eval '$X'", '--exclude=.env'],
    ["grep -rn '$HOME' --exclude=.env . ; source x", '--exclude=.env'],
    ["grep -rn '$HOME' --exclude=.env . ; . x", '--exclude=.env'],
    ["diff <(grep -rn '$X' --exclude=.env .) y", '--exclude=.env'],
    ['grep .env { $X', '.env'],
    // The rest of the cost the narrowing does not lift: an expansion in the tool's own words, a brace or tilde.
    ['grep -rn x --exclude=.env "$DIR"', '--exclude=.env'],
    ['grep -rn x{1..3} --exclude=.env .', '--exclude=.env'],
    ['grep -rn ~root --exclude=.env .', '--exclude=.env'],
    ['grep -rn ~+ --exclude=.env .', '--exclude=.env'],
  ];
  for (const [cmd, file] of blocks) {
    test(`blocks ${JSON.stringify(cmd)}`, () => assertBlockedOn(cmd, file));
  }

  // Quoted regexes, a glob after the pattern, attached exclusions and an exclusion before the pattern keep it.
  const allows = [
    'grep .env docs/*.md',
    'grep -rn "token$" --exclude=.env .',
    "grep -rn '[Tt]oken' --exclude=.env .",
    "grep -rn 'foo.*bar' --exclude=.env .",
    'grep -n KEY . --exclude=.env',
    'grep -rn --exclude .env KEY .',
    "grep -rn '{a,b}' --exclude=.env .",
    'grep -rn KEY_OPTIONS --exclude=.env .',
    "rg KEY . -g'!dir/.env'",
    "jq '.env.X' settings.json",
    'find . -exec grep -l foo {} +',
    // A `$` that single quotes keep literal, or one after the list separator that ends the search tool's words.
    "grep -rn '$HOME' --exclude=.env .",
    "grep -rEn '\\$HOME' --exclude=.env .",
    "grep -rn 'x' --exclude=.env . ; echo $?",
    // ... also when a pattern or operand spells a word that would run words again at a command's place.
    "grep -rn 'for' --exclude=.env . ; echo $?",
    "grep -rn 'eval' --exclude=.env . ; echo $?",
    "echo '()'; grep -rn x --exclude=.env . ; echo $?",
    // A glob that cannot spell one of the variables, or one the command does not set a variable with.
    "env LC_ALL=C grep 'a*' --exclude=.env .",
    'export FOO*; grep -rn KEY --exclude=.env .',
  ];
  for (const cmd of allows) {
    test(`allows ${JSON.stringify(cmd)}`, () => assertAllowed(cmd));
  }
});
