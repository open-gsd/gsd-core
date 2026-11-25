'use strict';

/**
 * #6333 (ADR-6315 item 15): the in-process CLI gives the result the spawned
 * binary gives.
 *
 * runGsdTools runs commands in this process, so every test that uses it
 * trusts that an in-process call and a real `node gsd-tools.cjs …` agree on
 * exit code, stdout and stderr. This file is where that is proved, command by
 * command. It is a process-contract test: it spawns the real binary once per
 * row, on purpose, so that the rest of the suite does not have to.
 *
 * The same loop is what first found two commands that overflowed the stack
 * in-process and one router (`capability`) that returns a promise without
 * being declared async.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createTempDir, createTempGitProject, cleanup, TOOLS_PATH, SPAWNED_MAX_BUFFER_BYTES,
} = require('./helpers.cjs');
const { runInProcessSync } = require('../gsd-core/bin/lib/in-process-cli.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  runCli, runCliSync, hostCommandNames, asyncHostCommandNames,
} = require('../gsd-core/bin/gsd-tools.cjs');
const { asyncRouters } = require('../gsd-core/bin/lib/profile-pipeline-command-router.cjs');
const { commandFamilies } = require('../gsd-core/bin/lib/capability-registry.cjs');
const { verbUniverse } = require('../gsd-core/bin/lib/cli-surface.cjs');

// Every top-level command: the host dispatch table and the capability
// registry. A command added to either gets its rows below without an edit.
const CAPABILITY_COMMANDS = Object.keys(commandFamilies);
const ALL_COMMANDS = [...new Set([...hostCommandNames(), ...CAPABILITY_COMMANDS])].sort();
// The ones that cannot be served synchronously: host routers that are (or
// may be) asynchronous, and capability routers their module declares so.
const ASYNC_COMMANDS = new Set([
  ...asyncHostCommandNames(),
  ...CAPABILITY_COMMANDS.filter((name) => commandFamilies[name].module === 'profile-pipeline-command-router.cjs'
    && asyncRouters.includes(commandFamilies[name].router)),
]);

/**
 * The directory as the CLI will print it. The CLI resolves paths with the
 * native realpath, which on Windows expands an 8.3 short name
 * (`C:\\Users\\RUNNER~1\\…` becomes `C:\\Users\\runneradmin\\…`); the plain
 * `fs.realpathSync` does not. A directory spelled the short way would not be
 * found in the output, and the two runs' random names would then differ.
 */
function canonical(dir) {
  return fs.realpathSync.native(dir);
}

/** A small project: enough for the read commands in SUCCESS_ROWS to answer. */
function seedProject(dir) {
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-setup'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({ model_profile: 'balanced' }));
  fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nstatus: executing\n---\n# State\n');
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: Setup** - first\n\n### Phase 1: Setup\n**Goal**: g\n',
  );
  fs.writeFileSync(path.join(planning, 'phases', '01-setup', '01-01-PLAN.md'), '---\nphase: 1\nplan: 1\n---\n# Plan\n');
}

/**
 * What must be equal: the three observable results, with the two things that
 * legitimately differ between two runs taken out. Each run gets its own
 * project directory (commands may write), and some commands print the time.
 *
 * Only the directory's own NAME is masked, never its whole path. Both runs'
 * directories have the same parent, so the name is all that differs, and a
 * name has one spelling where a path has several: the CLI prints the same
 * directory with backslashes, JSON-escaped backslashes and, from the commands
 * that emit POSIX paths, forward slashes (`C:/Users/…`). Masking the full path
 * in one spelling left the others unmasked on Windows, twice.
 */
function comparable(result, dir) {
  // The last segment under either separator, so the rule is the same on every platform.
  const name = dir.split(/[\\/]/).filter(Boolean).pop();
  const strip = (text) => String(text)
    .split(name).join('<DIR>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<TIME>')
    .replace(/\d{4}-\d\d-\d\d/g, '<DATE>');
  return { exitCode: result.exitCode, stdout: strip(result.stdout), stderr: strip(result.stderr) };
}

// The mask is what the whole file rests on, so it is checked on its own: every
// spelling of a directory that the CLI can print must come out the same.
test('the comparison masks a run directory however its path is spelled (#6333)', () => {
  const a = { win: 'C:\\Users\\me\\Temp\\gsd-parity-AAAAAA', posix: '/tmp/x/gsd-parity-AAAAAA' };
  const b = { win: 'C:\\Users\\me\\Temp\\gsd-parity-BBBBBB', posix: '/tmp/x/gsd-parity-BBBBBB' };
  const spellings = (dir) => [
    dir,
    JSON.stringify(dir).slice(1, -1),
    dir.split('\\').join('/'),
    `${dir}\\.planning\\STATE.md`,
    `${dir.split('\\').join('/')}/.planning/phases/01-setup`,
  ].join('\n');

  for (const kind of ['win', 'posix']) {
    const left = comparable({ exitCode: 0, stdout: spellings(a[kind]), stderr: spellings(a[kind]) }, a[kind]);
    const right = comparable({ exitCode: 0, stdout: spellings(b[kind]), stderr: spellings(b[kind]) }, b[kind]);
    assert.deepEqual(left, right, kind);
    assert.ok(!left.stdout.includes('AAAAAA') && left.stdout.includes('<DIR>'), kind);
  }
});

function harness(t) {
  const home = canonical(createTempDir('gsd-parity-home-'));
  t.after(() => cleanup(home));
  const env = isolatedEnv({ home, override: { GSD_HOME: path.join(home, '.gsd') } });

  const inFreshProject = (run) => {
    const dir = canonical(createTempDir('gsd-parity-'));
    try {
      seedProject(dir);
      return run(dir);
    } finally {
      cleanup(dir);
    }
  };

  return {
    spawned: (argv) => inFreshProject((dir) => comparable(
      runNode([TOOLS_PATH, ...argv], { cwd: dir, env, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS }),
      dir,
    )),
    sync: (argv) => inFreshProject((dir) => comparable(runCliSync({ argv, cwd: dir, env }), dir)),
    async: async (argv) => {
      const dir = canonical(createTempDir('gsd-parity-'));
      try {
        seedProject(dir);
        return comparable(await runCli({ argv, cwd: dir, env }), dir);
      } finally {
        cleanup(dir);
      }
    },
  };
}

// Three ways to call any command without knowing what it does: with nothing,
// asking for help, and with a subcommand it does not have.
const GENERIC_VARIANTS = (command) => [[command], [command, '--help'], [command, 'no-such-subcommand-zz']];

// Commands that answer from the seeded project and exit 0.
const SUCCESS_ROWS = [
  ['state', 'json'],
  ['state', 'load'],
  ['state-snapshot'],
  ['config-get', 'model_profile'],
  ['roadmap', 'analyze'],
  ['roadmap', 'get-phase', '1'],
  ['phases', 'list'],
  ['find-phase', '1'],
  ['phase-plan-index', '1'],
  ['init', 'progress'],
  ['init', 'plan-phase', '1'],
  ['progress', 'json'],
  ['validate', 'consistency'],
  ['frontmatter', 'get', '.planning/STATE.md'],
  ['verify-path-exists', '.planning'],
  ['resolve-model', 'gsd-planner'],
  ['list-todos'],
  ['history-digest'],
  ['generate-slug', 'Hello World'],
  ['current-timestamp'],
];

// The parity rows are generated from the dispatch tables. This is what makes
// "every command has rows" true: the tables name exactly the commands the
// declared CLI surface names, so a command cannot exist without being compared.
test('the commands compared are every top-level command of the CLI surface (#6333)', () => {
  const surfaceHeads = [...new Set([...verbUniverse()].map((verb) => String(verb).split(/[ .]/)[0]))].sort();

  assert.deepEqual(ALL_COMMANDS, surfaceHeads);
  assert.notEqual(ALL_COMMANDS.length, 0);
  assert.deepEqual([...ASYNC_COMMANDS].filter((name) => !ALL_COMMANDS.includes(name)), []);
});

test('a synchronous command gives the same result in-process as spawned (#6333)', (t) => {
  const run = harness(t);
  const differences = [];
  let compared = 0;

  for (const command of ALL_COMMANDS) {
    if (ASYNC_COMMANDS.has(command)) continue;
    for (const argv of GENERIC_VARIANTS(command)) {
      let inProcess;
      try {
        inProcess = run.sync(argv);
      } catch (err) {
        inProcess = { threw: err.code ?? String(err) };
      }
      const spawned = run.spawned(argv);
      compared += 1;
      try {
        assert.deepEqual(inProcess, spawned);
      } catch {
        differences.push({ argv: argv.join(' '), inProcess, spawned });
      }
    }
  }

  assert.equal(compared, (ALL_COMMANDS.length - ASYNC_COMMANDS.size) * 3);
  assert.deepEqual(differences, []);
});

test('an asynchronous command gives the same result through runCli as spawned (#6333)', async (t) => {
  const run = harness(t);
  const differences = [];
  let compared = 0;

  for (const command of ASYNC_COMMANDS) {
    for (const argv of GENERIC_VARIANTS(command)) {
      const spawned = run.spawned(argv);
      const inProcess = await run.async(argv);
      compared += 1;
      try {
        assert.deepEqual(inProcess, spawned);
      } catch {
        differences.push({ argv: argv.join(' '), inProcess, spawned });
      }
    }
  }

  assert.equal(compared, ASYNC_COMMANDS.size * 3);
  assert.deepEqual(differences, []);
});

test('commands that answer from a project give the same result all three ways (#6333)', async (t) => {
  const run = harness(t);
  const differences = [];

  for (const argv of SUCCESS_ROWS) {
    const spawned = run.spawned(argv);
    const sync = run.sync(argv);
    const asyncResult = await run.async(argv);
    if (spawned.exitCode !== 0) differences.push({ argv: argv.join(' '), why: 'the row is meant to succeed', spawned });
    for (const [name, inProcess] of [['sync', sync], ['async', asyncResult]]) {
      try {
        assert.deepEqual(inProcess, spawned);
      } catch {
        differences.push({ argv: argv.join(' '), entry: name, inProcess, spawned });
      }
    }
  }

  assert.deepEqual(differences, []);
});

// runGsdTools gives the in-process call the limit it believes a spawned child
// has. This is where that belief is checked against a real child.
test('output overflows at the same size in-process as spawned (#6333)', () => {
  const overflows = (bytes) => ({
    spawned: runNode(['-e', `process.stdout.write('x'.repeat(${bytes}))`], { timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS }).outcome
      === OUTCOME.BUFFER_OVERFLOW,
    inProcess: (() => {
      try {
        runInProcessSync(() => { fs.writeSync(1, 'x'.repeat(bytes)); }, { maxBufferBytes: SPAWNED_MAX_BUFFER_BYTES });
        return false;
      } catch (err) {
        if (err.code === 'in_process_output_overflow') return true;
        throw err;
      }
    })(),
  });

  assert.deepEqual(overflows(SPAWNED_MAX_BUFFER_BYTES - 1), { spawned: false, inProcess: false });
  assert.deepEqual(overflows(SPAWNED_MAX_BUFFER_BYTES), { spawned: false, inProcess: false });
  assert.deepEqual(overflows(SPAWNED_MAX_BUFFER_BYTES + 1), { spawned: true, inProcess: true });
});

// A command that reads git and writes a file. It finished asynchronously
// until #6333, and a synchronous call that was refused after the write and
// then spawned ran it twice: the second run found nothing left to restore.
test('uat.complete-session restores once, in-process as spawned (#6333)', (t) => {
  const committed = [
    '---', 'status: complete', 'phase: 01-foo', 'updated: 2026-01-01T00:00:00Z', '---', '',
    '## Current Test', '', '[testing complete]', '', '## Tests', '', '### 1. One', 'expected: it works', 'result: pass', '',
  ].join('\n');
  const reopened = committed.replace('status: complete', 'status: testing').replace('[testing complete]', 'number: 1');
  const argv = ['query', 'uat.complete-session', '.planning/phases/01-foo/01-UAT.md'];

  function run(call) {
    const dir = canonical(createTempGitProject());
    t.after(() => cleanup(dir));
    const file = path.join(dir, '.planning', 'phases', '01-foo', '01-UAT.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, committed);
    for (const args of [['add', '-A'], ['commit', '-q', '-m', 'seed']]) {
      assert.equal(runGit(args, { cwd: dir }).exitCode, 0);
    }
    fs.writeFileSync(file, reopened);
    const result = call(dir);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, file: fs.readFileSync(file, 'utf8') };
  }

  const spawned = run((dir) => runNode([TOOLS_PATH, ...argv], { cwd: dir, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS }));
  const inProcess = run((dir) => runCliSync({ argv, cwd: dir }));

  assert.deepEqual(inProcess, spawned);
  assert.deepEqual(JSON.parse(spawned.stdout), { changed: false, status: 'complete', restored: true });
  assert.equal(spawned.file, committed);
});

// Capability commands are dispatched through the capability registry, not the
// host table. Two of them finish asynchronously (their module says which).
test('capability commands that finish asynchronously (#6333)', async (t) => {
  const commands = CAPABILITY_COMMANDS.filter((name) => ASYNC_COMMANDS.has(name)).sort();

  function sessions(t2) {
    const dir = canonical(createTempDir('gsd-parity-sessions-'));
    t2.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'proj'));
    fs.writeFileSync(path.join(dir, 'proj', 's1.jsonl'), `${JSON.stringify({
      type: 'user',
      userType: 'external',
      message: { role: 'user', content: 'hello there friend' },
      timestamp: '2026-01-01T00:00:00Z',
    })}\n`);
    return dir;
  }

  await t.test('are the two session readers', () => {
    assert.deepEqual(commands, ['extract-messages', 'profile-sample']);
  });

  await t.test('are refused by name before they run', (t2) => {
    const dir = sessions(t2);
    for (const argv of [['extract-messages', 'proj', '--path', dir], ['profile-sample', '--path', dir]]) {
      assert.throws(() => runCliSync({ argv }), { code: 'in_process_async_command', command: argv[0] });
    }
  });

  await t.test('give the same result through runCli as spawned, with work to do', async (t2) => {
    const dir = sessions(t2);
    const tempRoot = path.join(dir, 'tmp');
    fs.mkdirSync(tempRoot);
    const env = { ...process.env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot };
    // The output file's directory has a random suffix in each run.
    const comparableRun = (result) => {
      const strip = (text) => String(text).replace(/gsd-(pipeline|profile)-[A-Za-z0-9_-]+/g, 'gsd-$1-<RANDOM>');
      return { exitCode: result.exitCode, stdout: strip(result.stdout), stderr: strip(result.stderr) };
    };
    for (const argv of [
      ['extract-messages', 'proj', '--path', dir],
      ['extract-messages', 'no-such-project', '--path', dir],
      ['profile-sample', '--path', dir],
    ]) {
      const spawned = comparableRun(runNode([TOOLS_PATH, ...argv], { env, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS }));
      const inProcess = comparableRun(await runCli({ argv, env }));
      assert.deepEqual(inProcess, spawned, argv.join(' '));
      assert.notEqual(`${spawned.stdout}${spawned.stderr}`, '', 'the row must produce output to compare');
    }
  });
});

test('the commands runCliSync cannot serve (#6333)', async (t) => {
  await t.test('are exactly the declared-async routers and capability', () => {
    assert.deepEqual(asyncHostCommandNames().sort(), [
      'capability',
      'classify-confidence',
      'detect-custom-files',
      'migrate-config',
      'package-legitimacy',
      'prompt-budget',
      'review-lane',
      'websearch',
    ]);
  });

  await t.test('are refused by name, before they run, and leave the next call working', () => {
    for (const command of [...asyncHostCommandNames(), 'run-with-timeout']) {
      assert.throws(
        () => runCliSync({ argv: [command] }),
        { code: 'in_process_async_command', command },
        `${command} must be refused`,
      );
    }
    assert.deepEqual(JSON.parse(runCliSync({ argv: ['generate-slug', 'Still Works'] }).stdout), { slug: 'still-works' });
  });
});
