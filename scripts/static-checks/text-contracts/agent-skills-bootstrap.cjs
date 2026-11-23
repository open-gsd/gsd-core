'use strict';

// The agent_skills self-load bootstrap (#1866, #5122): the reference gsd-core/references/agent-skills-bootstrap.md
// documents the dedup guard, the frontmatter-name query, the query command (--skills-only, a visible failure), the
// shared launcher and the per-runtime return contract; each of the 22 consumer agents @-includes it, and no other
// canonical agent does; every agent file that carries the pointer (canonical and .compact.md sibling) states its own
// agent type on the one pointer line, matching its frontmatter name. Was tests/agent-skills-bootstrap.test.cjs. The
// test's fast-check property restated the bijection over random subsets, so the per-file checks below carry it.

const BOOTSTRAP_REF = 'agent-skills-bootstrap.md';
const BOOTSTRAP = `gsd-core/references/${BOOTSTRAP_REF}`;
const RESOLVER = 'gsd-core/references/gsd-run-resolver.md';
const MIN_SELF_LOADING_FILES = 36; // the test's `22 * 2 - 8` (the tree has 22 canonical and 16 compact files carrying the pointer)
const NAME_LENGTH_LIMIT = 64;

const CONSUMER_AGENTS = [
  'gsd-advisor-researcher', 'gsd-assumptions-analyzer', 'gsd-code-fixer', 'gsd-code-reviewer', 'gsd-codebase-mapper',
  'gsd-debugger', 'gsd-doc-writer', 'gsd-eval-auditor', 'gsd-executor', 'gsd-integration-checker', 'gsd-nyquist-auditor',
  'gsd-phase-researcher', 'gsd-plan-checker', 'gsd-planner', 'gsd-project-researcher', 'gsd-research-synthesizer',
  'gsd-roadmapper', 'gsd-security-auditor', 'gsd-ui-auditor', 'gsd-ui-checker', 'gsd-ui-researcher', 'gsd-verifier',
];

// `before`, one or more whitespace characters, `after`, matched without case, by one walk (the regex used an
// unbounded `\s+`, which a bounded pattern would let a longer gap evade).
function hasWhitespaceGap(text, before, after) {
  const lower = text.toLowerCase();
  let at = lower.indexOf(before);
  while (at !== -1) {
    const from = at + before.length;
    let end = from;
    while (end < lower.length && /\s/.test(lower[end])) end += 1;
    if (end > from && lower.startsWith(after, end)) return true;
    at = lower.indexOf(before, at + 1);
  }
  return false;
}

// The name the old multiline pattern `^name:\s*"?([A-Za-z0-9-]{1,64})"?\s*$` captured, by one walk with that pattern's
// semantics: `name:` at a line start (after CR, LF, U+2028 or U+2029), any whitespace (line breaks included) before the
// value, an optional double quote either side of 1 to 64 letters, digits or hyphens, then whitespace up to a line end.
const LINE_ENDS = new Set(['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);
function frontmatterNameOf(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (!((i === 0 || LINE_ENDS.has(text[i - 1])) && text.startsWith('name:', i))) continue;
    let at = i + 'name:'.length;
    while (at < text.length && /\s/.test(text[at])) at += 1;
    if (text[at] === '"') at += 1;
    let end = at;
    while (end < text.length && /[A-Za-z0-9-]/.test(text[end])) end += 1;
    if (end - at < 1 || end - at > NAME_LENGTH_LIMIT) continue;
    for (const tail of text[end] === '"' ? [end + 1, end] : [end]) {
      let stop = tail;
      while (stop < text.length && /\s/.test(text[stop])) stop += 1;
      for (let q = tail; q <= stop; q += 1) if (q === text.length || LINE_ENDS.has(text[q])) return text.slice(at, end);
    }
  }
  return null;
}

const agentTypeOf = (rel) => rel.split('/').pop().replace(/\.compact\.md$/, '').replace(/\.md$/, '');

module.exports = {
  id: 'agent-skills-bootstrap',
  issue: '#1866',
  check(ctx) {
    ctx.doc(BOOTSTRAP)
      .has(/<agent_skills>/, 'the bootstrap must name the <agent_skills> block')
      .has(/skip/i, 'the bootstrap must document the dedup guard (skip when <agent_skills> is already present)')
      .has(/already/i, 'the bootstrap must document the dedup guard (skip when <agent_skills> is already present)')
      .has(/frontmatter/i, 'the bootstrap must instruct query agent-skills using the frontmatter name')
      .has(/query agent-skills/i, 'the bootstrap must instruct query agent-skills using the frontmatter name')
      .satisfies((text) => text.split('\n').some((line) => line.includes('gsd_run query agent-skills')), 'the bootstrap must carry the query command')
      .satisfies((text) => {
        const command = text.split('\n').find((line) => line.includes('gsd_run query agent-skills'));
        return command === undefined || command.includes('--skills-only') || 'the self-load must pass --skills-only';
      }, 'the self-load query must pass --skills-only')
      .satisfies((text) => {
        const command = text.split('\n').find((line) => line.includes('gsd_run query agent-skills'));
        return command === undefined || (!command.includes('2>/dev/null') && !command.includes('|| true'));
      }, 'stderr and the exit status must stay visible so a failure is not read as "nothing configured"')
      .has(/agent type/i, 'the bootstrap must tell the agent to use the type stated in its own file')
      .has('gsd-run-resolver.md', 'the bootstrap must point at the shared resolver reference')
      .lacks(/your own init already defines/i, 'gsd_run is not defined by every agent init')
      .has('--skills-only', 'the bootstrap must tell the agent to pass --skills-only')
      .has(/non-Claude/, 'the bootstrap must state that a non-Claude runtime returns the agent persona without --skills-only')
      .has(/persona/i, 'the bootstrap must state that a non-Claude runtime returns the agent persona without --skills-only')
      .satisfies((text) => !hasWhitespaceGap(text, 'exits 0 with an empty', 'block when nothing is configured for your type'),
        'the empty-block claim must be scoped to --skills-only')
      .satisfies((text) => !hasWhitespaceGap(text, 'the `name:` value in', 'your frontmatter'),
        'the bootstrap must not send the agent to the frontmatter it may not be able to see')
      .has(/Claude Code/, 'the bootstrap must explain why the type is not read from frontmatter')
      .has(/frontmatter/i, 'the bootstrap must explain why the type is not read from frontmatter');
    ctx.doc(RESOLVER).has('gsd_run() {', 'the referenced resolver must define gsd_run');

    // Every consumer agent carries the pointer; no other canonical agent does (the test's bijection).
    for (const name of CONSUMER_AGENTS) {
      ctx.doc(`agents/${name}.md`).has(BOOTSTRAP_REF, `${name} must @-include references/${BOOTSTRAP_REF} (self-load contract)`);
    }
    const agentFiles = ctx.list('agents', '.md', 'the agent files are what carries the self-load pointer').filter((rel) => rel.split('/').length === 2);
    const consumers = new Set(CONSUMER_AGENTS.map((name) => `agents/${name}.md`));
    const carrying = new Set();
    for (const rel of agentFiles) {
      const canonical = !rel.endsWith('.compact.md');
      ctx.doc(rel).satisfies((text) => {
        const carries = text.includes(BOOTSTRAP_REF);
        if (carries) carrying.add(rel);
        if (canonical && carries && !consumers.has(rel)) return `${rel} carries the bootstrap pointer but is not a consumer agent`;
        if (!carries) return true;
        const type = agentTypeOf(rel);
        const pointers = text.split('\n').filter((line) => line.includes(BOOTSTRAP_REF));
        if (pointers.length !== 1) return `${rel} must carry exactly one bootstrap pointer (found ${pointers.length})`;
        if (!pointers[0].includes(`(agent type: \`${type}\`)`)) return `${rel} pointer must state "(agent type: \`${type}\`)"`;
        const name = frontmatterNameOf(text);
        return name === null || name === type || `${rel} frontmatter name ${name} must match the stated type ${type}`;
      }, 'a self-loading agent must state its own type on the one bootstrap pointer line, and only consumer agents carry the pointer');
    }
    if (carrying.size < MIN_SELF_LOADING_FILES) {
      ctx.fail('agents', `only ${carrying.size} agent files carry the bootstrap pointer; the sweep expects at least ${MIN_SELF_LOADING_FILES} (canonical agents and compact siblings)`);
    }
  },
};
