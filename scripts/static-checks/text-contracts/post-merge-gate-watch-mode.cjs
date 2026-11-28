'use strict';

// A GSD test gate must not hang on a watch-mode runner (#1857, #2350, #4784, #5346): the regression-run, post-merge and
// audit-fix gates normalize the command, bound it with the configured budget, and surface exit 124 with a watch/dev
// hint; the regression gate aborts; execute-phase includes the shared verification step that reads the regression-gate
// step; every build/test command config-get passes `--raw`; the Xcode arms pass -project and derive the destination from
// the available simulators, and the skip arms assign their command variable; the package-manager fallbacks resolve through
// one verb and keep a literal fallback. The simulator-extraction pipeline, run for real, stays in
// tests/test-gate-watch-mode.test.cjs. Pattern matches are linear scans here (the test's `\s+`, `[^\n]*` and `.*` were
// unbounded). Each file is read through one document, so a file that is gone is one finding. Was the text half of that test.

const STEPS = 'gsd-core/workflows/execute-phase/steps';
const REGRESSION_GATE = `${STEPS}/regression-gate.md`;
const REGRESSION_GATE_RUN = `${STEPS}/regression-gate-run.md`;
const POST_MERGE_GATE = `${STEPS}/post-merge-gate.md`;
const VERIFY_PHASE_GOAL = `${STEPS}/verify-phase-goal.md`;
const AUDIT_FIX = 'gsd-core/workflows/audit-fix.md';
const EXECUTE_PHASE = 'gsd-core/workflows/execute-phase.md';

const FULL_GATES = [
  ['regression gate', REGRESSION_GATE_RUN],
  ['post-merge gate', POST_MERGE_GATE],
  ['audit-fix gate', AUDIT_FIX],
];

const SITES = [
  ['post-merge-gate (build)', POST_MERGE_GATE, 'resolve-package-manager build', 'npm run build'],
  ['post-merge-gate (test)', POST_MERGE_GATE, 'resolve-package-manager test', 'npm test'],
  ['regression-gate-run', REGRESSION_GATE_RUN, 'resolve-package-manager test', 'npm test'],
  ['audit-fix', AUDIT_FIX, 'resolve-package-manager test', 'npm test'],
];

const LINE_TERMINATORS = /[\r\n\u2028\u2029]/;
const isBlank = (char) => char !== undefined && /\s/.test(char);
const { asciiLower } = require('./lib/ascii-lower.cjs');

// The index after one or more blanks starting at `at`, or -1.
function afterBlanks(text, at) {
  let end = at;
  while (isBlank(text[end])) end += 1;
  return end === at ? -1 : end;
}

// `config-get workflow.(build|test)_command --default ""` anywhere in the line.
function resolvesCommand(line) {
  let at = line.indexOf('config-get');
  while (at !== -1) {
    let next = afterBlanks(line, at + 'config-get'.length);
    if (next !== -1 && line.startsWith('workflow.', next)) {
      next += 'workflow.'.length;
      const kind = line.startsWith('build', next) ? 'build' : line.startsWith('test', next) ? 'test' : null;
      if (kind !== null && line.startsWith('_command', next + kind.length)) {
        next = afterBlanks(line, next + kind.length + '_command'.length);
        if (next !== -1 && line.startsWith('--default', next)) {
          next = afterBlanks(line, next + '--default'.length);
          if (next !== -1 && line.startsWith('""', next)) return true;
        }
      }
    }
    at = line.indexOf('config-get', at + 1);
  }
  return false;
}

// Each line's `xcodebuild build|test ... '` run: from the first such start to the last quote of the line.
function constructedCommands(text) {
  const found = [];
  for (const line of text.split('\n')) {
    const starts = ['xcodebuild build', 'xcodebuild test'].map((phrase) => ({ at: line.indexOf(phrase), length: phrase.length })).filter((entry) => entry.at !== -1);
    if (starts.length === 0) continue;
    const first = starts.reduce((a, b) => (a.at <= b.at ? a : b));
    const lastQuote = line.lastIndexOf("'");
    if (lastQuote >= first.at + first.length) found.push(line.slice(first.at, lastQuote + 1));
  }
  return found;
}

// The index of the first `\n    fi` (four spaces) at or after `from` that is not the start of a longer word, or -1.
function closingFi(text, from) {
  let end = text.indexOf('\n    fi', from);
  while (end !== -1 && /[A-Za-z0-9_]/.test(text[end + '\n    fi'.length] ?? '')) end = text.indexOf('\n    fi', end + 1);
  return end;
}

// The text of each `if [ -z "$XCODE_SIM" ]; then` ... first line `    fi` (four spaces, `fi` as a whole word) arm.
function skipArms(text) {
  const start = 'if [ -z "$XCODE_SIM" ]; then';
  const arms = [];
  let at = text.indexOf(start);
  while (at !== -1) {
    const end = closingFi(text, at + start.length);
    if (end === -1) break;
    arms.push(text.slice(at, end + '\n    fi'.length));
    at = text.indexOf(start, end + '\n    fi'.length);
  }
  return arms;
}

// A line holding `No available iOS Simulator` and later `needle`.
const skipEchoNames = (text, needle) => text.split('\n').some((line) => {
  const at = line.indexOf('No available iOS Simulator');
  return at !== -1 && line.indexOf(needle, at + 'No available iOS Simulator'.length) !== -1;
});

// `running this project's ... build ... script` on one line, ASCII case-insensitive.
const logsSniffedBuildScript = (text) => text.split(LINE_TERMINATORS).some((line) => {
  const lower = asciiLower(line);
  const opener = "running this project's ";
  const at = lower.indexOf(opener);
  if (at === -1) return false;
  const build = lower.indexOf('build', at + opener.length);
  return build !== -1 && lower.indexOf(' script', build + 'build'.length) !== -1;
});

module.exports = {
  walkers: { resolvesCommand, constructedCommands, skipArms, skipEchoNames, logsSniffedBuildScript },
  id: 'post-merge-gate-watch-mode',
  issue: '#1857',
  check(ctx) {
    const docs = new Map();
    const docOf = (file) => {
      if (!docs.has(file)) docs.set(file, ctx.doc(file));
      return docs.get(file);
    };
    for (const [label, file] of FULL_GATES) {
      docOf(file)
        .has('normalize-test-command', `${label} must call the shared normalize-test-command helper`)
        .has('workflow.test_gate_timeout', `${label} must read workflow.test_gate_timeout`)
        .has('run-with-timeout "$TEST_GATE_TIMEOUT"', `${label} must wrap the test command in run-with-timeout with the configured budget`)
        .has('-eq 124', `${label} must handle the timeout exit code (124)`)
        .has('watch/dev mode', `${label} must name watch/dev mode as the likely cause on timeout`)
        // A gate that never names the helper is already reported by the previous assertion.
        .satisfies((text) => !text.includes('normalize-test-command') || text.includes('gsd_run query normalize-test-command'), `${label} must invoke the shared normalizer by the same verb name`)
        .satisfies((text) => {
          const lines = text.split('\n').filter(resolvesCommand);
          if (lines.length === 0) return `${file} resolves no build/test command via config-get`;
          const offending = lines.filter((line) => !line.includes('--raw'));
          return offending.length === 0 || `offending: ${offending.join(' | ')}`;
        }, `${label}: every build/test_command config-get must pass --raw so an unset key is empty, not the literal ""`);
    }

    docOf(REGRESSION_GATE)
      .has('REGRESSION GATE ABORTED', 'the regression gate must abort (not continue) on a watch-mode timeout')
      .has('If this block exits non-zero, HALT', 'the regression gate must halt when its discovery block fails, not read the failure as no prior phases (#6813)');

    docOf(EXECUTE_PHASE).has('steps/verify-phase-goal.md', 'execute-phase.md must include the shared verification step');
    docOf(VERIFY_PHASE_GOAL).has('steps/regression-gate.md', 'the shared verification step must reference the extracted regression-gate step');

    docOf(POST_MERGE_GATE)
      .satisfies((text) => {
        const commands = constructedCommands(text);
        if (commands.length < 4) return `expected the four Xcode command constructions, got ${commands.length}`;
        const bare = commands.find((command) => !command.includes("-project '$XCODEPROJ'"));
        return bare === undefined || `no -project in: ${bare}`;
      }, "every constructed xcodebuild command must carry -project '$XCODEPROJ'")
      .has('simctl list devices available', 'the Xcode destination must resolve from simctl list devices available')
      .has('id=$XCODE_SIM', 'the destination must reference the resolved simulator id')
      .lacks('name=iPhone 16', 'the hardcoded simulator name must be gone')
      .satisfies((text) => skipEchoNames(text, 'workflow.build_command'), 'the build-arm skip must name workflow.build_command')
      .satisfies((text) => skipEchoNames(text, 'workflow.test_command'), 'the test-arm skip must name workflow.test_command')
      .satisfies((text) => {
        const arms = skipArms(text);
        if (arms.length < 2) return `expected both skip arms, got ${arms.length}`;
        const bare = arms.find((arm) => !arm.includes('BUILD_CMD=""') && !arm.includes('TEST_CMD=""'));
        return bare === undefined || 'a skip arm assigns no command variable';
      }, 'each skip arm must assign its command variable (a set -u agent shell must not abort on an unbound variable)')
      .has('-collect-test-diagnostics never', 'the gate must mention -collect-test-diagnostics never for Xcode suites')
      .has('workflow.build_command', 'the post-merge gate must recommend workflow.build_command')
      .satisfies(logsSniffedBuildScript, "a sniffed build script must be logged: running this project's ... build ... script");

    for (const [label, file, call, fallback] of SITES) {
      docOf(file)
        .has(call, `${label} must resolve through "${call}"`)
        .has(`"${fallback}"`, `${label} must keep the literal "${fallback}" fallback`);
    }
  },
};
