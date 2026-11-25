'use strict';

// TDD_APPLICABLE is assigned, not only used (#4264, #4265, #4266, #4268): both executor dispatch backends (the harness
// path in execute-phase.md with its assignment in the tdd-applicability-resolution.md fragment, and the worktree path in
// executor-isolation-dispatch.md) assign TDD_APPLICABLE from a plan-scoped `gsd_run query phase.tdd-applicable` call,
// assign it before every `${TDD_APPLICABLE...}` use, describe the tdd.md embed line with the same three sources, and
// issue byte-identical query calls; the worktree backend fail-closes on an unresolved marker; the harness reaches the
// fragment before its Agent( call and the fragment states a MANDATORY HALT. Line scans replace the test's unbounded
// patterns. The test's RED-first case compared two in-memory strings, not repo text, and is dropped.
// Each file is read through one document, so a file that is gone is one finding. Was tests/tdd-backend-wiring.test.cjs.

const HARNESS = 'gsd-core/workflows/execute-phase.md';
const WORKTREE = 'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md';
const FRAGMENT = 'gsd-core/workflows/execute-phase/steps/tdd-applicability-resolution.md';
const BACKENDS = [
  ['execute-phase.md', HARNESS, FRAGMENT],
  ['executor-isolation-dispatch.md', WORKTREE, WORKTREE],
];
const QUERY = 'gsd_run query phase.tdd-applicable';

const isBlank = (char) => char !== undefined && /\s/.test(char);
const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);
const { asciiLower } = require('./lib/ascii-lower.cjs');

// The line after its leading blanks.
function trimmedStart(line) {
  let at = 0;
  while (isBlank(line[at])) at += 1;
  return line.slice(at);
}

const isAssignment = (line) => trimmedStart(line).startsWith('TDD_APPLICABLE=');
const isAgentCall = (line) => trimmedStart(line) === 'Agent(';

// Indices of the lines holding `${TDD_APPLICABLE` as a whole word.
function useLines(lines) {
  const found = [];
  lines.forEach((line, index) => {
    let at = line.indexOf('${TDD_APPLICABLE');
    while (at !== -1) {
      if (!isWordChar(line[at + '${TDD_APPLICABLE'.length])) {
        found.push(index);
        break;
      }
      at = line.indexOf('${TDD_APPLICABLE', at + 1);
    }
  });
  return found;
}

// The call from `gsd_run query phase.tdd-applicable` (which the line holds) to the end of the line, without a closing parenthesis.
function queryCall(line) {
  const call = line.slice(line.indexOf(QUERY));
  return call.endsWith(')') ? call.slice(0, -1) : call;
}

const lineOf = (text, predicate) => text.split('\n').find(predicate);

module.exports = {
  walkers: { useLines, isAssignment, queryCall },
  id: 'tdd-backend-wiring',
  issue: '#4266',
  check(ctx) {
    const docs = new Map();
    const docOf = (file) => {
      if (!docs.has(file)) docs.set(file, ctx.doc(file));
      return docs.get(file);
    };
    // A cause shared by several assertions (an assignment or a query call that is gone from a file) is reported once.
    const seen = new Set();
    const once = (key, message) => {
      if (seen.has(key)) return true;
      seen.add(key);
      return message;
    };
    const isQueryLine = (line) => line.includes('phase.tdd-applicable') && line.includes('gsd_run query');
    for (const [name, , assignmentFile] of BACKENDS) {
      docOf(assignmentFile)
        .satisfies((text) => {
          const lines = text.split('\n');
          const assign = lines.findIndex(isAssignment);
          if (assign === -1) return once(`no-assignment:${assignmentFile}`, 'it has no TDD_APPLICABLE assignment');
          if (lines.slice(Math.max(0, assign - 8), assign + 1).join('\n').includes('phase.tdd-applicable')) return true;
          const message = 'no phase.tdd-applicable call within eight lines above the assignment';
          return lines.some(isQueryLine) ? message : once(`no-call:${assignmentFile}`, message);
        }, `${name}: TDD_APPLICABLE must be assigned from a phase.tdd-applicable call within a few lines above it`)
        .satisfies((text) => {
          const call = lineOf(text, isQueryLine);
          if (call === undefined) return once(`no-call:${assignmentFile}`, 'it has no gsd_run query phase.tdd-applicable call');
          return (call.includes('{phase_dir}') && call.includes('{plan_file}')) || `the call is ${call.trim()}`;
        }, `${name}: the phase.tdd-applicable call must be plan-scoped ({phase_dir}/{plan_file}), not phase-scoped`);
    }

    docOf(WORKTREE).satisfies((text) => {
      const lines = text.split('\n');
      const assign = lines.findIndex(isAssignment);
      if (assign === -1) return once(`no-assignment:${WORKTREE}`, 'it has no TDD_APPLICABLE assignment');
      const uses = useLines(lines);
      if (uses.length === 0) return 'it has no ${TDD_APPLICABLE...} use to check ordering against';
      const early = uses.find((use) => !(assign < use));
      return early === undefined || `TDD_APPLICABLE is used at line ${early + 1} before it is assigned at line ${assign + 1}`;
    }, 'executor-isolation-dispatch.md must assign TDD_APPLICABLE before every ${TDD_APPLICABLE...} use');

    docOf(HARNESS)
      .satisfies((text) => {
        const lines = text.split('\n');
        const reference = lines.findIndex((line) => line.includes('tdd-applicability-resolution.md') && line.includes('TDD-applicability resolution'));
        if (reference === -1) return 'it has no one-line reference to tdd-applicability-resolution.md';
        const uses = useLines(lines);
        if (uses.length === 0) return 'it has no ${TDD_APPLICABLE...} use to check ordering against';
        const early = uses.find((use) => !(reference < use));
        return early === undefined || `TDD_APPLICABLE is used at line ${early + 1} before the reference to its resolution at line ${reference + 1}`;
      }, 'execute-phase.md must reference the TDD-applicability resolution before every ${TDD_APPLICABLE...} use')
      .satisfies((text) => {
        const lines = text.split('\n');
        const agent = lines.findIndex(isAgentCall);
        if (agent === -1) return 'it has no literal Agent( dispatch-call line';
        return lines.slice(0, agent).join('\n').includes('execute-phase/steps/tdd-applicability-resolution.md') || 'the fragment is not referenced before the Agent( call';
      }, 'execute-phase.md must reference the tdd-applicability-resolution.md step fragment before the Agent() call');

    docOf(FRAGMENT).satisfies((text) => {
      const at = text.indexOf('MANDATORY');
      if (at === -1) return 'it states no MANDATORY pre-dispatch check';
      const check = text.slice(at);
      const missing = ['TDD_APPLICABLE', 'CONTEXT_WINDOW', 'AGENT_SKILLS'].find((marker) => !check.includes(marker));
      if (missing !== undefined) return `the check does not name ${missing}`;
      return asciiLower(check).includes('halt') || 'the check does not instruct an explicit halt';
    }, 'the fragment must state a MANDATORY pre-dispatch check naming TDD_APPLICABLE, CONTEXT_WINDOW and AGENT_SKILLS and instructing a HALT');

    for (const [name, referenceFile] of BACKENDS) {
      docOf(referenceFile)
        .satisfies((text) => {
          const line = lineOf(text, (candidate) => candidate.includes('tdd.md') && candidate.includes('TDD_APPLICABLE ?'));
          // An entry that is not conditional is reported by the assertion below, a missing one only once.
          if (line === undefined) return lineOf(text, (candidate) => candidate.includes('tdd.md') && candidate.includes('TDD_APPLICABLE')) !== undefined ? true : once(`no-embed:${referenceFile}`, 'it lists no tdd.md conditional embed entry');
          if (!line.includes('type: tdd')) return `the comment lacks plan type: tdd: ${line.trim()}`;
          if (!line.includes('tdd="true"')) return `the comment lacks the tdd="true" task attribute: ${line.trim()}`;
          return line.includes('workflow.tdd_mode') || line.includes('config') || `the comment lacks the workflow.tdd_mode config default: ${line.trim()}`;
        }, `${name}: the tdd.md embed-line comment must describe the same three sources (#4265)`)
        .satisfies((text) => {
          const line = lineOf(text, (candidate) => candidate.includes('tdd.md') && candidate.includes('TDD_APPLICABLE'));
          if (line === undefined) return once(`no-embed:${referenceFile}`, 'it lists no tdd.md conditional embed entry');
          return line.includes('TDD_APPLICABLE ?') || `the entry is not conditional: ${line.trim()}`;
        }, `${name}: the tdd.md entry must stay conditional on TDD_APPLICABLE (#3990)`);
    }

    docOf(WORKTREE).satisfies((text) => {
      const lines = text.split('\n');
      if (!lines.some((line) => line.includes("grep -q '\\${AGENT_SKILLS}'"))) return 'it no longer carries the ${AGENT_SKILLS} fail-closed check';
      const check = lines.findIndex((line) => line.includes("grep -q '\\${TDD_APPLICABLE"));
      if (check === -1) return 'it carries no fail-closed grep check for an unresolved ${TDD_APPLICABLE marker';
      const block = lines.slice(check, check + 4).join('\n');
      if (!block.includes('FATAL:')) return 'the check emits no FATAL message';
      return block.includes('exit 1') || 'the check does not exit 1';
    }, 'the worktree backend must fail-close on an un-substituted ${TDD_APPLICABLE marker, like the ${AGENT_SKILLS} check');

    const callOf = (text) => lineOf(text, (line) => line.includes('=$(gsd_run query phase.tdd-applicable'));
    let harnessCall = null;
    docOf(FRAGMENT).satisfies((text) => {
      const line = callOf(text);
      if (line === undefined) return once(`no-call:${FRAGMENT}`, 'it carries no gsd_run query phase.tdd-applicable assignment call');
      harnessCall = queryCall(line);
      return true;
    }, 'the harness backend must carry a gsd_run query phase.tdd-applicable call');
    docOf(WORKTREE).satisfies((text) => {
      const line = callOf(text);
      if (line === undefined) return once(`no-call:${WORKTREE}`, 'it carries no gsd_run query phase.tdd-applicable assignment call');
      return harnessCall === null || harnessCall === queryCall(line) || `the harness call is ${harnessCall}, the worktree call is ${queryCall(line)}`;
    }, 'the harness and worktree backends must issue byte-identical phase.tdd-applicable command-substitution calls (#4268)');
  },
};
