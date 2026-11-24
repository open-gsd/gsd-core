'use strict';

// spec-phase.md probe reachability (#2733): the mandatory probe steps (any `## Step N` heading whose title names a probe)
// exist, no gate-passed jump or "proceed to Step N" skips one, at least one jump reaches the first probe, the max-rounds
// bypass is not redirected into a probe and still writes SPEC.md, and each probe keeps its own onward exit. The old
// regexes (`## Step N` heading, the six transition verbs, `proceed to Step N`) are linear scans here with the same
// reading: the verbs match case-insensitively for ASCII only, with no left word boundary; a heading title may not hold a
// line terminator. Line endings are normalised by the engine, so a CRLF file reads as LF. Was
// tests/spec-phase-probe-reachability.test.cjs.

const FILE = 'gsd-core/workflows/spec-phase.md';
const HEADING_PREFIX = '## Step ';
const VERBS = ['jump', 'proceed', 'continue', 'go', 'return', 'skip'];
const MAX_ROUNDS_MARKER = 'If max rounds reached';

const isDigit = (char) => char !== undefined && char >= '0' && char <= '9';
const isBlank = (char) => char !== undefined && /\s/.test(char);
const { asciiLower } = require('./lib/ascii-lower.cjs');

// `[0-9]+(?:\.[0-9]+)*` read from `at`: the id and the index after it, or null.
function readStepId(text, at) {
  let end = at;
  while (isDigit(text[end])) end += 1;
  if (end === at) return null;
  while (text[end] === '.' && isDigit(text[end + 1])) {
    end += 1;
    while (isDigit(text[end])) end += 1;
  }
  return { id: text.slice(at, end), end };
}

// The index after one or more blanks starting at `at`, or -1.
function afterBlanks(text, at) {
  let end = at;
  while (isBlank(text[end])) end += 1;
  return end === at ? -1 : end;
}

// `## Step 5.5: Title`: the id and the title, or null (a title may not hold a line terminator).
function parseStepHeading(line) {
  if (!line.startsWith(HEADING_PREFIX)) return null;
  const read = readStepId(line, HEADING_PREFIX.length);
  if (read === null) return null;
  let at = read.end;
  while (isBlank(line[at])) at += 1;
  if (line[at] === ':') at += 1;
  while (isBlank(line[at])) at += 1;
  let title = line.slice(at);
  if (title.endsWith('\r')) title = title.slice(0, -1);
  return /[\r\n\u2028\u2029]/.test(title) ? null : { id: read.id, title: title.trim() };
}

// The target of the first `jump|proceed|continue|go|return|skip to Step N` in a line, or null.
function transitionTarget(line) {
  const lower = asciiLower(line);
  for (let at = 0; at < lower.length; at += 1) {
    for (const verb of VERBS) {
      if (!lower.startsWith(verb, at)) continue;
      let next = afterBlanks(lower, at + verb.length);
      if (next === -1 || !lower.startsWith('to', next)) continue;
      next = afterBlanks(lower, next + 2);
      if (next === -1 || !lower.startsWith('step', next)) continue;
      next = afterBlanks(lower, next + 4);
      if (next === -1) continue;
      const target = readStepId(line, next);
      if (target !== null) return target.id;
    }
  }
  return null;
}

// `proceed to Step N` (a digit after it) anywhere in the text, ASCII case-insensitive.
function proceedsToStep(text) {
  const lower = asciiLower(text);
  let at = lower.indexOf('proceed to step ');
  while (at !== -1) {
    if (isDigit(lower[at + 'proceed to step '.length])) return true;
    at = lower.indexOf('proceed to step ', at + 1);
  }
  return false;
}

// Segment-wise comparison, so 5.10 sorts after 5.9.
function compareStepIds(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function analyse(text) {
  const lines = text.split('\n');
  const steps = [];
  const jumps = [];
  lines.forEach((line, index) => {
    const heading = parseStepHeading(line);
    if (heading) steps.push({ id: heading.id, title: heading.title, line: index + 1 });
    const target = transitionTarget(line);
    if (target !== null) jumps.push({ target, line: index + 1, text: line.trim() });
  });
  const probes = steps.filter((step) => asciiLower(step.title).includes('probe'));
  const start = lines.findIndex((line) => line.includes(MAX_ROUNDS_MARKER));
  let bypass = null;
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) {
        end = i;
        break;
      }
    }
    bypass = { start: start + 1, end };
  }
  return { lines, steps, jumps, probes, bypass };
}

module.exports = {
  walkers: { parseStepHeading, transitionTarget, proceedsToStep },
  id: 'spec-phase-probe-reachability',
  issue: '#2733',
  check(ctx) {
    ctx.doc(FILE)
      .satisfies((text) => {
        const { probes } = analyse(text);
        return probes.length >= 2 || `found ${probes.length}: ${probes.map((probe) => probe.id).join(', ')}`;
      }, 'spec-phase.md must define at least the edge-completeness and prohibition-completeness probe steps')
      .satisfies((text) => {
        const { jumps, probes, bypass } = analyse(text);
        if (jumps.length === 0) return 'it contains no jump instructions to assert on';
        const violations = [];
        for (const jump of jumps) {
          if (bypass && jump.line >= bypass.start && jump.line <= bypass.end) continue;
          for (const probe of probes) {
            if (jump.line < probe.line && compareStepIds(jump.target, probe.id) > 0) {
              violations.push(`line ${jump.line} jumps to Step ${jump.target}, skipping mandatory Step ${probe.id} (${probe.title})`);
            }
          }
        }
        return violations.length === 0 || `${violations.length} probe-skipping jump(s): ${violations.join('; ')}`;
      }, 'every gate-passed transition must route into the first mandatory probe, not past it')
      .satisfies((text) => {
        const { jumps, probes } = analyse(text);
        // No probe step at all is already reported by the minimum above.
        if (probes.length === 0 || jumps.length === 0) return true; // no jump line at all is reported by the assertion above
        const first = probes[0];
        return jumps.some((jump) => jump.target === first.id)
          || `Step ${first.id} (${first.title}) is defined but no jump reaches it; targets found: ${[...new Set(jumps.map((jump) => jump.target))].join(', ')}`;
      }, 'at least one jump must route into the first mandatory probe')
      .satisfies((text) => {
        const { lines, probes, bypass } = analyse(text);
        if (!bypass) return `no "${MAX_ROUNDS_MARKER}" block`;
        const probeIds = new Set(probes.map((probe) => probe.id));
        const block = lines.slice(bypass.start - 1, bypass.end);
        const redirected = block.map((line, i) => ({ line: bypass.start + i, target: transitionTarget(line) })).filter((entry) => entry.target !== null && probeIds.has(entry.target));
        return redirected.length === 0 || `line ${redirected[0].line} redirects into Step ${redirected[0].target}`;
      }, 'the max-rounds bypass must not be redirected into a probe: it never passed the ambiguity gate')
      .satisfies((text) => {
        const { lines, bypass } = analyse(text);
        // A missing max-rounds block is already reported by the redirect assertion above.
        if (!bypass) return true;
        return lines.slice(bypass.start - 1, bypass.end).some((line) => line.includes('Write SPEC.md')) || 'the block never writes SPEC.md';
      }, 'the max-rounds bypass must still route to SPEC generation')
      .satisfies((text) => {
        const { lines, steps, probes } = analyse(text);
        for (const probe of probes) {
          const next = steps.find((step) => step.line > probe.line);
          const block = lines.slice(probe.line - 1, next ? next.line - 1 : lines.length).join('\n');
          if (!proceedsToStep(block)) return `Step ${probe.id} (${probe.title}) has no "proceed to Step N" exit`;
        }
        return true;
      }, 'each probe step must keep its own onward exit to SPEC generation');
  },
};
