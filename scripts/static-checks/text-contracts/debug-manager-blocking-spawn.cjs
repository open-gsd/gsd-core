'use strict';

// The debug session manager's debugger spawn blocks (#4395): Claude Code backgrounds subagents by default, so without
// run_in_background = false the manager's Step 3 has no return to inspect, emits CONTINUE_REQUIRED, and a second detached
// debugger races the first. Both shipped variants (full and compact) spawn gsd-debugger once with the flag false and
// agree; every subagent spawn under agents/ states run_in_background explicitly; the orchestrator hop keeps its blocking
// mandate (#2196); Step 2 is the sole spawn literal; the terminal markers survive; and the manager is told never to spawn
// the debugger through Bash (#5214). Was tests/debug-manager-blocking-spawn.test.cjs.

const MANAGER = 'agents/gsd-debug-session-manager.md';
const MANAGER_COMPACT = 'agents/gsd-debug-session-manager.compact.md';
const VARIANTS = [['full', MANAGER], ['compact', MANAGER_COMPACT]];
const DEBUG_WORKFLOW = 'gsd-core/workflows/debug.md';

const { agentCalls } = require('./model-routing-spawn-threading.cjs');

// The `Agent(...)` spawn blocks of a file: the multi-line form (a call whose open paren is followed only by whitespace
// that includes a newline, up to the first line that starts with `)`) and every call that opens and closes on one line,
// so a one-line spawn cannot evade the class guard. A call that opens on one line and closes at the end of a later line
// that does not start with `)` is claimed by neither form.
function agentSpawnBlocks(content) {
  const blocks = [];
  // Matches do not overlap: the scan resumes after a matched block, as a global regex scan does.
  let next = 0;
  for (let at = content.indexOf('Agent(', next); at !== -1; at = content.indexOf('Agent(', next)) {
    next = at + 1;
    const afterParen = at + 'Agent('.length;
    let runEnd = afterParen;
    while (runEnd < content.length && /\s/.test(content[runEnd])) runEnd += 1;
    // Multi-line: the last newline of the whitespace run, then the first newline-paren after it. An earlier newline of the
    // run could only close on a block that holds nothing but whitespace, which no check here can select, so it is not tried.
    const lastNewline = content.lastIndexOf('\n', runEnd - 1);
    if (lastNewline < afterParen) continue;
    const close = content.indexOf('\n)', lastNewline + 1);
    if (close !== -1) {
      blocks.push(content.slice(at, close + 2));
      next = close + 2;
    }
  }
  // Single-line: the paren-aware call scan shared with model-routing-spawn-threading, run on one line at a time so a
  // call never reads past its own line and an unmatched parenthesis cannot swallow a later one-line spawn.
  for (const line of content.split('\n')) {
    for (const call of agentCalls(line)) {
      if (call.endsWith(')')) blocks.push(call);
    }
  }
  return blocks;
}

// The values of every `run_in_background = true|false` in a block, in order.
function runInBackgroundFlags(block) {
  const key = 'run_in_background';
  const flags = [];
  for (let at = block.indexOf(key); at !== -1; at = block.indexOf(key, at + 1)) {
    let i = at + key.length;
    while (i < block.length && /\s/.test(block[i])) i += 1;
    if (block[i] !== '=') continue;
    i += 1;
    while (i < block.length && /\s/.test(block[i])) i += 1;
    if (block.startsWith('true', i)) flags.push('true');
    else if (block.startsWith('false', i)) flags.push('false');
  }
  return flags;
}

const debuggerSpawns = (content) => agentSpawnBlocks(content).filter((block) => block.includes('subagent_type="gsd-debugger"'));
const spawnLiterals = (content) => agentSpawnBlocks(content).filter((block) => block.includes('subagent_type='));

// Is there `run_in_background:` then whitespace, then "false`", whitespace, an em dash, whitespace, and the phrase?
function mandatesBlockingHop(text) {
  const key = 'run_in_background:';
  const phrase = 'Claude Code backgrounds subagents by default';
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    let i = at + key.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (!text.startsWith('false`', i)) continue;
    i += 'false`'.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '—') continue;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text.startsWith(phrase, i)) return true;
  }
  return false;
}

module.exports = {
  id: 'debug-manager-blocking-spawn',
  issue: '#4395',
  check(ctx) {
    for (const [label, rel] of VARIANTS) {
      ctx.doc(rel)
        .satisfies((text) => {
          const spawns = debuggerSpawns(text);
          return spawns.length === 1 || `found ${spawns.length}`;
        }, `${label} variant: expected exactly one gsd-debugger spawn block`)
        .satisfies((text) => {
          const spawns = debuggerSpawns(text);
          return spawns.length !== 1 || runInBackgroundFlags(spawns[0]).includes('false') || 'no flag is false';
        }, `${label} variant: the debugger spawn must be blocking (run_in_background = false), or the manager cannot see its result`)
        .satisfies((text) => {
          const spawns = spawnLiterals(text);
          return spawns.length === 1 || `found ${spawns.length}`;
        }, `${label} variant: exactly one Agent() spawn literal may exist: the continuation sites re-spawn by reference to it, so a second literal would not carry the flag`)
        .has(/Step 2 format/, `${label} variant: at least one continuation site must still name Step 2 as the format source`)
        .has('Never spawn the debugger through Bash', `${label} variant: the rule heading must stay`)
        .has('claude --agent gsd-debugger', `${label} variant: the rule must name the forbidden shape`)
        .has('do not improvise a shell spawn', `${label} variant: the rule must say what to do when Agent fails`);
    }

    // Both variants declare the flag and agree on it: two missing flags would be equal, so presence comes first.
    const flags = {};
    for (const [label, rel] of VARIANTS) {
      ctx.doc(rel).satisfies((text) => {
        const spawns = debuggerSpawns(text);
        flags[label] = spawns.length === 1 ? runInBackgroundFlags(spawns[0])[0] : undefined;
        return flags[label] !== undefined || 'no flag';
      }, `${label} variant must declare the run_in_background flag at all`);
    }
    ctx.doc(MANAGER_COMPACT).satisfies(
      () => flags.compact === undefined || flags.full === undefined || flags.compact === flags.full || `compact ${flags.compact}, full ${flags.full}`,
      'the compact sibling must not diverge from the canonical agent on spawn semantics',
    );

    ctx.doc(MANAGER)
      .has('## CONTINUE_REQUIRED', 'the non-terminal marker must remain')
      .has('## DEBUG SESSION COMPLETE', 'the terminal marker must remain')
      .has('ABANDONED', 'the abandoned disposition must remain');

    ctx.doc(DEBUG_WORKFLOW).satisfies((text) => mandatesBlockingHop(text) || 'phrase not found', 'debug.md must keep the #2196 mandate that the session-manager spawn blocks');

    // Every agent file directly under agents/: any spawn block naming a subagent states run_in_background explicitly.
    for (const rel of ctx.list('agents', '.md', 'the agents are what the class guard covers').filter((file) => file.split('/').length === 2)) {
      ctx.doc(rel).satisfies((text) => {
        const offenders = [];
        for (const block of agentSpawnBlocks(text)) {
          if (!block.includes('subagent_type=')) continue;
          if (runInBackgroundFlags(block).length === 0) offenders.push(block.split('\n').find((line) => line.includes('subagent_type=')).trim());
        }
        return offenders.length === 0 || offenders.join('; ');
      }, 'an agent that spawns a subagent must decide whether that spawn blocks: leaving run_in_background unstated inherits the host default, which backgrounds subagents (#4395)');
    }
  },
};
